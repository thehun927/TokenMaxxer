/**
 * Memory writer — extracts facts from session transcripts and writes to STATE.json.
 * Triggered on session.idle. Full specification in docs/IMPLEMENTATION.md Appendix A.
 */
import type {
  MemoryFile,
  Decision,
  AuditTerminalOutcome,
  LLMAuditMetadata,
  Evidence,
  Provenance,
  ProcessedSource,
} from "./schema"
import { MAX_PROCESSED_SOURCES, ProcessedSourceSchema, MEMORY_CREATION_LIMITS } from "./schema"
import { findProcessedSource, upsertProcessedSource } from "./source-processing"
import type { ExtractedFacts, HeuristicFacts, TranscriptMessage } from "../types"
import type { LLMDecisionFacts } from "./extract-schema"
import {
  mergeHeuristicDecisions,
  mergeLLMDecisionFacts,
} from "./merge"
import { queryDecisions } from "./reader"
import { TOOL_LIMITS } from "../tools/bounds"
import { readMemoryState, emptyMemory, resolveProjectPath, mutateMemory } from "./store"
import type { MemoryMutationResult } from "./store"
import { enqueueProjectJob, setProjectQueueOutcome } from "./lock"
import type { ProjectLockOptions } from "./project-lock"
import { getCurrentGitSha } from "../util/git"
import { atomicWrite } from "../util/fs"
import { basename, join } from "node:path"
import {
  buildCanonicalInput,
  buildTranscriptEvidenceCandidateMap,
  buildExtractionSourceInput,
  stableJson,
  sha256Hex,
  makeSourceVersionKey,
  EXTRACTION_CONTRACT_VERSION,
} from "./extract-prompt"
import {
  extractFactsLLM,
  extractionCacheKey,
  getLLMConfig,
  makeExtractionCacheEntry,
  readExtractionCacheEntry,
  resolveEvidenceReferences,
  upsertExtractionCache,
  upsertModelHealth,
  MODEL_HEALTH_MAX_RECORDS,
  LLM_REQUEST_TIMEOUT_MS,
  type EvidenceCandidate,
  type EvidenceCandidateMap,
  type LLMExtractionDiagnostic,
  type AuditCreatedCallback,
  type LLMHealthOutcomeReport,
  type SmallModel,
} from "./extract-llm"
import { makeExtractionCacheKey } from "./extract-prompt"
import type { CanonicalExtractionInput } from "./extract-prompt"
import { log } from "../util/log"
import { MEMORY_MAX_BYTES, memorySizeBytes } from "./memory-size"
import type { MemoryBudgetProtection } from "./budget"
import * as writerModule from "./writer"

const TRANSCRIPT_WINDOW = 50
const MAX_DIAGNOSTIC_VALUE = 200

/**
 * Top-N-by-frequency quality selection for active-file observations. This is
 * the existing top-5 heuristic, which is stricter than the exported
 * `activeFilesMax` creation ceiling; the emitted count is still bounded by
 * that ceiling in `extractActiveFiles` so automatic content can never drift
 * above the creation contract (B4).
 */
const TOP_ACTIVE_FILES = 5

/**
 * Wave 6: Centralize final outcome publication.
 * Every public terminal path, including pre-queue no-messages/error/write-failed and queue rejection,
 * sets getProjectQueueStatus(project).lastOutcome to exactly the returned IdleWriteOutcome.
 * Generic lock.ts internal `failed` must never leak as the final public value.
 * A later success must replace an earlier failure.
 */
function finishIdleOutcome(project: string, outcome: IdleWriteOutcome): IdleWriteOutcome {
  setProjectQueueOutcome(project, outcome)
  return outcome
}

function boundedDiagnosticValue(value: string, maxChars = MAX_DIAGNOSTIC_VALUE): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars - 3)}...`
}

function boundedDiagnosticError(error: unknown, maxChars = 500): string {
  const text = (() => {
    try {
      return String(error)
    } catch {
      return "[unknown error]"
    }
  })()
  return boundedDiagnosticValue(text, maxChars)
}

/** Emit only bounded, non-secret extraction diagnostics through the v1 client. */
function logLLMDiagnostic(client: unknown, diagnostic: LLMExtractionDiagnostic): void {
  const level = diagnostic.kind === "structured-output-failed" || diagnostic.kind === "unavailable-client"
    ? "debug"
    : "warn"
  const extra: Record<string, unknown> = { kind: diagnostic.kind }
  if ("reason" in diagnostic) extra.reason = boundedDiagnosticValue(diagnostic.reason)
  if ("attempt" in diagnostic) extra.attempt = diagnostic.attempt
  if ("attempts" in diagnostic) extra.attempts = diagnostic.attempts
  if ("evidence_count" in diagnostic) extra.evidence_count = diagnostic.evidence_count
  if ("candidate_count" in diagnostic) extra.candidate_count = diagnostic.candidate_count
  if ("error" in diagnostic && diagnostic.error) extra.error = diagnostic.error

  // Logging must never delay or change extraction/memory behavior.
  void log(client, level, "llm extraction diagnostic", extra)
}

/**
 * Best-effort HEADER generation. A successful STATE write must remain
 * successful even if the derivative HEADER write fails, so failures here are
 * logged and swallowed rather than propagated to the caller.
 */
async function writeHeaderBestEffort(
  client: unknown,
  worktree: string,
  directory: string,
  mem: MemoryFile,
): Promise<void> {
  try {
    await writerModule.generateHeader(worktree, directory, mem)
  } catch (error) {
    void log(client, "warn", "header generation failed", { error: boundedDiagnosticError(error) })
  }
}

/** The ephemeral deterministic candidate used by provenance construction. */
export type HeuristicEvidenceCandidate = EvidenceCandidate

function heuristicCandidateRef(kind: string, value: unknown): string {
  return `hc-${sha256Hex(stableJson({ kind, value })).slice(0, 16)}`
}

function heuristicCandidate(
  kind: string,
  value: unknown,
): HeuristicEvidenceCandidate {
  const ref = heuristicCandidateRef(kind, value)
  return {
    kind: "heuristic-candidate",
    ref,
    digest: sha256Hex(stableJson({ kind, ref, value })),
  }
}

/**
 * Build bounded, deterministic heuristic candidates.  Candidate values are
 * kept only for this idle transaction and are never written to STATE.json.
 */
export function buildHeuristicEvidenceCandidateMap(
  facts: ExtractedFacts,
): EvidenceCandidateMap {
  const map: Record<string, EvidenceCandidate> = {}
  if (facts.current_task) {
    const candidate = heuristicCandidate("current-task", facts.current_task)
    map[candidate.ref] = candidate
  }
  for (const file of facts.active_files.slice(0, 5)) {
    const candidate = heuristicCandidate("active-file", file)
    map[candidate.ref] = candidate
  }
  for (const decision of facts.decisions.slice(0, 5)) {
    const candidate = heuristicCandidate("decision", {
      topic: decision.topic,
      decision: decision.decision,
    })
    map[candidate.ref] = candidate
  }
  return map
}

function transcriptCandidateMap(
  messages: TranscriptMessage[],
): EvidenceCandidateMap {
  const source = buildTranscriptEvidenceCandidateMap(messages)
  const map: Record<string, EvidenceCandidate> = {}
  for (const [ref, candidate] of Object.entries(source)) {
    map[ref] = {
      kind: "transcript",
      ref,
      digest: candidate.digest,
      text: candidate.text,
      role: candidate.role,
    }
  }
  return map
}

function mergeEvidenceCandidateMaps(
  ...maps: EvidenceCandidateMap[]
): EvidenceCandidateMap {
  const merged: Record<string, EvidenceCandidate> = {}
  for (const map of maps) {
    for (const [ref, candidate] of Object.entries(map)) {
      if (!merged[ref]) merged[ref] = candidate
    }
  }
  return merged
}

function evidenceDigestMap(
  candidates: EvidenceCandidateMap,
): Readonly<Record<string, string>> {
  const digests: Record<string, string> = {}
  for (const ref of Object.keys(candidates).sort()) {
    const digest = candidates[ref]?.digest
    if (digest) digests[ref] = digest
  }
  return digests
}

function candidateEvidence(
  refs: unknown,
  candidates: EvidenceCandidateMap,
): Evidence[] {
  return resolveEvidenceReferences(refs, {
    evidenceCandidateMap: candidates,
    evidenceDigestMap: evidenceDigestMap(candidates),
  }).evidence
}

// ─── writeMemoryOnIdle ───────────────────────────────────────────────────────

export type IdleWriteOutcome =
  | "no-messages"
  | "error"
  | "heuristic-only"
  | "cache-hit"
  | "llm-success"
  | "llm-failed"
  | "write-failed"
  | "queue-failed"

/** Result of preparing an idle source (before queue serialization). */
export type PreparedIdleSource =
  | {
      kind: "success"
      allMessages: TranscriptMessage[]
      windowMessages: TranscriptMessage[]
      canonicalInput: CanonicalExtractionInput
      sourceVersionKey: string
      promptInputSha256: string
      sourceInputSha256: string
      /** Source-transcript candidates/digests cross the LLM evidence boundary. */
      transcriptCandidates: EvidenceCandidateMap
      transcriptDigests: Readonly<Record<string, string>>
      /** Heuristic candidates/digests are owned by the heuristic provenance path. */
      heuristicCandidates: EvidenceCandidateMap
      heuristicDigests: Readonly<Record<string, string>>
    }
  | { kind: "no-messages" }
  | { kind: "error"; reason: string }
  | { kind: "write-failed"; reason: string }

type IdleWriteOptions = {
  client: unknown
  worktree: string
  directory: string
  sessionId: string
  /** Test-only: bound the heuristic transaction lock acquisition window. */
  lockOptions?: ProjectLockOptions
}

/**
 * Prepare source data for idle processing without mutating STATE.
 * Returns a prepared source object or a typed failure.
 * This runs BEFORE enqueueing to avoid holding locks across I/O.
 */
export async function prepareIdleSource(
  opts: IdleWriteOptions,
): Promise<PreparedIdleSource> {
  const { client, worktree, directory, sessionId } = opts
  const c = client as {
    session?: {
      messages: (args: { path: { id: string } }) => Promise<{ data?: TranscriptMessage[] }>
    }
  }
  if (!c.session?.messages) {
    // Missing session.messages endpoint → no-messages (Wave 1B test 39)
    return { kind: "no-messages" }
  }

  let result
  try {
    result = await c.session.messages({ path: { id: sessionId } })
  } catch {
    // session.messages throws → error (Wave 1B test 41)
    return { kind: "error", reason: "session.messages threw" }
  }
  const allMessages = result.data
  if (!allMessages || allMessages.length === 0) {
    return { kind: "no-messages" }
  }

  // Derive window messages for heuristic extraction (bounded window)
  const windowMessages = allMessages.slice(-TRANSCRIPT_WINDOW)

  // Build source identity fields using the contractually correct helper (§3.1-3.2)
  // Wave 5 B2: Use the same bounded window for both source identity and prompt construction.
  const sourceInput = buildExtractionSourceInput(windowMessages)
  const sourceInputSha256 = sourceInput.sourceInputSha256

  const sourceVersionKey = makeSourceVersionKey({
    sourceSessionID: sessionId,
    sourceInputSha256,
    extractionContractVersion: EXTRACTION_CONTRACT_VERSION,
  })

  // Build canonical input for the LLM prompt
  const existingState = await readMemoryState({ worktree, directory })
  if (existingState.status === "unavailable") {
    // Preparation-time readMemoryState unavailable → typed write-failed (not error)
    return { kind: "write-failed", reason: "memory read failed" }
  }
  const existing = existingState.memory ?? emptyMemory(worktree)
  const canonicalPrior = { ...existing, llm_extraction_audits: undefined, revision: 0 }
  const canonicalInput = buildCanonicalInput(windowMessages, canonicalPrior)

  // Wave 3: Split transcript and heuristic candidate maps. Only
  // transcriptCandidates/transcriptDigests cross the LLM evidence boundary;
  // heuristic candidates are owned by the heuristic provenance path.
  const transcriptCandidates = transcriptCandidateMap(windowMessages)
  const transcriptDigests = evidenceDigestMap(transcriptCandidates)
  const heuristicCandidates = buildHeuristicEvidenceCandidateMap(extractFactsHeuristic(windowMessages))
  const heuristicDigests = evidenceDigestMap(heuristicCandidates)

  return {
    kind: "success",
    allMessages,
    windowMessages,
    canonicalInput,
    sourceVersionKey,
    promptInputSha256: canonicalInput.promptInputSha256,
    sourceInputSha256,
    transcriptCandidates,
    transcriptDigests,
    heuristicCandidates,
    heuristicDigests,
  }
}

/**
 * Process a prepared idle source through the heuristic/optional-LLM lifecycle.
 * This runs INSIDE the queue serialization.
 */
async function processPreparedIdleSource(
  opts: IdleWriteOptions,
  prepared: Awaited<ReturnType<typeof prepareIdleSource>>,
): Promise<IdleWriteOutcome> {
  if (prepared.kind === "no-messages" || prepared.kind === "error" || prepared.kind === "write-failed") {
    return prepared.kind
  }

  const { client, worktree, directory, sessionId } = opts
  const project = resolveProjectPath(worktree, directory)
  const gitSha = await getCurrentGitSha(worktree)
  const {
    allMessages,
    windowMessages,
    canonicalInput,
    sourceVersionKey,
    transcriptCandidates,
    transcriptDigests,
    heuristicCandidates,
    heuristicDigests,
  } = prepared
  // Heuristic merge may use the merged candidate map (transcript + heuristic).
  const mergedCandidates = mergeEvidenceCandidateMaps(transcriptCandidates, heuristicCandidates)
  const mergedDigests = evidenceDigestMap(mergedCandidates)

  // Read authoritative state under lock for the heuristic transaction
  const existingState = await readMemoryState({ worktree, directory })
  if (existingState.status === "unavailable") {
    void log(client, "warn", "memory read failed; refusing to mutate", { project })
    return "write-failed"
  }
  const existing = existingState.memory ?? emptyMemory(project)

  // Wave 4: Check for completed source BEFORE heuristic mutation (§9.1)
  const completed = findProcessedSource(existing, sourceVersionKey)
  if (completed) {
    // Wave 4: Completed-source fast path
    // Source was already processed by another concurrent request.
    // Return "cache-hit" with no heuristic merge, no audit, no prompt, no cache re-merge,
    // no STATE commit, no revision bump.
    return "cache-hit"
  }

  // Heuristic transaction (PR 2 §11.A): one short lock-protected mutation.
  const extracted = extractFactsHeuristic(windowMessages)
  const heuristicResult = await mutateMemory<{ outcome: IdleWriteOutcome; memory: MemoryFile }>(
    { worktree, directory, client, lockOptions: opts.lockOptions },
    (base) => {
      const referenced = markReferencedDecisions(base, windowMessages, sessionId)
      const merged = mergeHeuristicMemory(referenced, extracted, {
        sessionId,
        gitSha,
        timestamp: new Date().toISOString(),
        evidenceCandidates: mergedCandidates,
      })
      const heuristicMemory = recordRecentSession(merged, sessionId)
      // Return unpruned candidate with budget protection
      const budgetProtection: MemoryBudgetProtection = {
        preserveProcessedSourceKeys: [],
      }
      return {
        kind: "commit",
        memory: heuristicMemory,
        value: { outcome: "heuristic-only", memory: heuristicMemory },
        budgetProtection,
      }
    },
  )

  // B3: exhaustive status handling for the heuristic transaction. Only the
  // committed branch carries a fitted `MemoryFile`; every other discriminant
  // is consumed before the committed state is used for HEADER generation.
  let heuristicMemory: MemoryFile | undefined
  if (heuristicResult.status === "lock-timeout") {
    void log(client, "warn", "heuristic transaction lock-timeout", { project })
    return "queue-failed"
  }
  if (heuristicResult.status === "unavailable") {
    void log(client, "warn", "heuristic transaction unavailable", { project })
    return "write-failed"
  }
  if (heuristicResult.status === "commit-failed") {
    void log(client, "warn", "heuristic transaction commit-failed", { project })
    return "write-failed"
  }
  if (heuristicResult.status === "budget-rejected") {
    // Budget rejection: route through existing failure behavior
    void log(client, "warn", "heuristic transaction budget-rejected", { project })
    return "write-failed"
  }
  if (heuristicResult.status === "noop") {
    // Defensive exhaustiveness: the heuristic callback always commits, so a
    // noop means no durable change was made and there is no fitted committed
    // memory to render. The completed-source re-check below observes the
    // unchanged authoritative state.
    void log(client, "debug", "heuristic transaction produced no durable change", { project })
  } else {
    // status === "committed".
    // B3: HEADER generation and the committed-state representation must use
    // the actual fitted memory exposed by the transaction
    // (`heuristicResult.memory`), never the callback-carried pre-fit candidate
    // in `value.memory` — the central fitter may change/remove current_task
    // under pressure before persistence.
    heuristicMemory = heuristicResult.memory
    await writeHeaderBestEffort(client, worktree, directory, heuristicMemory)
  }

  // Wave 4: Second completion check after heuristic transaction (§9.3)
  // Re-read authoritative state and check if source was already completed
  const afterHeuristicState = await readMemoryState({ worktree, directory })
  if (afterHeuristicState.status === "unavailable") {
    void log(client, "warn", "memory read failed after heuristic", { project })
    return "write-failed"
  }
  const afterHeuristic = afterHeuristicState.memory ?? heuristicMemory ?? emptyMemory(project)
  const completedAfterHeuristic = findProcessedSource(afterHeuristic, sourceVersionKey)
  if (completedAfterHeuristic) {
    // Wave 4: Completed-source fast path
    // Source was already processed by another concurrent request.
    // Return "cache-hit" with no heuristic merge, no audit, no prompt, no cache re-merge,
    // no STATE commit, no revision bump.
    return "cache-hit"
  }

  // Continue with optional LLM path...
  if (process.env.TOKENMAXXER_LLM_EXTRACT !== "1") {
    void log(client, "debug", "llm extraction skipped: TOKENMAXXER_LLM_EXTRACT is disabled", {
      reason: "TOKENMAXXER_LLM_EXTRACT is disabled",
    })
    return "heuristic-only"
  }

  // Wave 5 B3: Resolve the gated model BEFORE cache lookup to ensure consistent identity.
  // The gated model is the single authority for cache lookup/write identity, selectedModel,
  // finalLLMMerge, processed extraction_key, and audit/provider/model/variant metadata.
  const hasCompletedSource = findProcessedSource(afterHeuristic, sourceVersionKey) !== null
  const hasFailedAudit = (afterHeuristic.llm_extraction_audits ?? []).some(
    (a: { source_key?: string; terminal_outcome: string }) => a.source_key === sourceVersionKey && a.terminal_outcome !== "success"
  )
  const gatedConfig = await getLLMConfig(client, directory, {
    memory: afterHeuristic,
    bypassModelCooldown: !hasCompletedSource && hasFailedAudit,
  })
  if (!gatedConfig.model) {
    const hasConfigEndpoint = typeof (client as { config?: { get?: unknown } }).config?.get === "function"
    void log(
      client,
      "info",
      hasConfigEndpoint ? "llm extraction skipped: model unavailable" : "llm extraction skipped: gated model unavailable",
      {
      reason: boundedDiagnosticValue(gatedConfig.reason ?? "gated model resolution returned no model"),
      },
    )
    return "heuristic-only"
  }
  void log(client, "info", "llm extraction gated model resolved", {
    provider: boundedDiagnosticValue(gatedConfig.model.providerID),
    model: boundedDiagnosticValue(gatedConfig.model.modelID),
  })

  const selectedModel = gatedConfig.model
  const selectedCacheKey = makeExtractionCacheKey({
    sourceVersionKey,
    extractionContractVersion: EXTRACTION_CONTRACT_VERSION,
    model: selectedModel,
  })

  // Check cache before prompting with full identity validation.
  // Wave 3: LLM evidence boundary uses only transcript candidates.
  const cachedEntry = readExtractionCacheEntry(afterHeuristic, selectedCacheKey, {
    evidenceCandidateMap: transcriptCandidates,
    evidenceDigestMap: transcriptDigests,
    sourceVersionKey,
    sourceInputSha256: prepared.sourceInputSha256,
    promptInputSha256: prepared.promptInputSha256,
    extractionContractVersion: EXTRACTION_CONTRACT_VERSION,
    providerID: selectedModel.providerID,
    modelID: selectedModel.modelID,
    modelVariant: selectedModel.variant,
  })
  if (cachedEntry) {
    // A result-cache row is not completion proof.  Only the processed-source
    // ledger can authorize the durable no-op above; replaying this payload
    // would re-apply facts from a source that may never have committed its
    // completion marker.  Treat the row as a cache miss and continue through
    // the normal gated extraction path.
    void log(client, "debug", "llm extraction cache entry ignored without completion marker")
  }

  // Continue with LLM extraction...
  const projectName = basename(project) || project
  let extractionAuditSessionID: string | undefined
  const persistAudit: AuditCreatedCallback = async (audit) => {
    extractionAuditSessionID = audit.audit_session_id
    return persistAuditGuardResult({ client, worktree, directory }, audit)
  }
  const persistTerminal = async (
    auditSessionID: string,
    outcome: Exclude<AuditTerminalOutcome, "pending">,
  ): Promise<void> => {
    await persistTerminalTransaction({ client, worktree, directory }, auditSessionID, outcome)
  }

  void log(client, "debug", "llm extraction audit session requested")
  const llmResult = await extractFactsLLM(
    canonicalInput,
    sessionId,
    projectName,
    client,
    gatedConfig,
    {
      directory,
      projectKey: project,
      sourceVersionKey,
      sourceInputSha256: prepared.sourceInputSha256,
      promptInputSha256: prepared.promptInputSha256,
      extractionContractVersion: EXTRACTION_CONTRACT_VERSION,
      providerID: gatedConfig.model.providerID,
      modelID: gatedConfig.model.modelID,
      modelVariant: gatedConfig.model.variant,
      // Wave 3: LLM evidence boundary uses only transcript candidates.
      evidenceCandidateMap: transcriptCandidates,
      evidenceDigestMap: transcriptDigests,
      onDiagnostic: (diagnostic) => logLLMDiagnostic(client, diagnostic),
      onAuditCreated: persistAudit,
      onAuditTerminal: persistTerminal,
      onHealthOutcome: async (report) => {
        await persistModelHealth({ client, worktree, directory }, report)
      },
    },
  )

  // Wave 6: Map typed LLM run result to public outcome
  switch (llmResult.status) {
    case "success":
      // Fall through to final merge
      break
    case "unavailable":
      // Missing session endpoint -> heuristic-only (no model request attempted)
      void log(client, "info", "llm extraction skipped: missing session endpoint", {
        reason: llmResult.reason,
      })
      return "heuristic-only"
    case "guard-failed":
      // A required guard persistence lock timeout is a queue failure; other
      // typed persistence failures are write failures.
      void log(client, "warn", "llm extraction audit guard failed", { project })
      return llmResult.reason === "lock-timeout" ? "queue-failed" : "write-failed"
    case "failed":
      // Retained session-create/prompt/retry/validation/evidence failure -> llm-failed
      void log(client, "warn", "llm extraction failed", {
        reason: (llmResult as { reason: string }).reason,
        project,
      })
      return "llm-failed"
  }

  const llmFacts = llmResult.facts

  const finalResult = await finalLLMMerge(
    { client, worktree, directory },
    {
      sessionId,
      gitSha,
      canonicalInput,
      selectedModel,
      selectedCacheKey,
      sourceVersionKey,
      sourceInputSha256: prepared.sourceInputSha256,
      promptInputSha256: prepared.promptInputSha256,
      llmFacts,
      extractionAuditSessionID,
      // Wave 3: LLM evidence boundary uses only transcript candidates.
      candidates: transcriptCandidates,
      digests: transcriptDigests,
    },
  )

  // Wave 6: Map finalLLMMerge result to public outcome
  if (finalResult.status === "lock-timeout") {
    // Wave 6: Lock timeout -> queue-failed (not llm-failed)
    void log(client, "warn", "final llm transaction lock-timeout", { project })
    return finishIdleOutcome(project, "queue-failed")
  }
  if (finalResult.status === "unavailable") {
    // Wave 6: STATE unavailable -> write-failed (not llm-failed)
    void log(client, "warn", "final llm transaction unavailable", { project })
    return finishIdleOutcome(project, "write-failed")
  }
  if (finalResult.status === "commit-failed") {
    // Wave 6: Commit failed -> write-failed (not llm-failed)
    void log(client, "warn", "final llm transaction commit-failed", { project })
    return finishIdleOutcome(project, "write-failed")
  }
  if (finalResult.status === "budget-rejected") {
    // Budget rejection: route through existing failure behavior
    void log(client, "warn", "final llm transaction budget-rejected", { project })
    return finishIdleOutcome(project, "write-failed")
  }
  if (finalResult.status === "noop") {
    // Wave 6: Already completed by another actor -> cache-hit
    return finishIdleOutcome(project, "cache-hit")
  }
  // B3: HEADER generation must use the actual fitted committed state exposed
  // by the transaction (`finalResult.memory`), never the callback-carried
  // pre-fit candidate in `value.memory`.
  const finalMemory = finalResult.memory
  await writeHeaderBestEffort(client, worktree, directory, finalMemory)
  void log(client, "info", "llm extraction facts merged")
  return finishIdleOutcome(project, "llm-success")
}

/**
 * Main entry point called from session.idle.  The queue is deliberately at
 * this public boundary so direct callers cannot accidentally bypass the
 * project/source serialization contract.
 *
 * Wave 4: The queue key is the source-version key (idle:<sourceVersionKey>),
 * not just the session ID. This coalesces same-source requests while allowing
 * different sources from the same session to proceed independently.
 */
export async function writeMemoryOnIdle(opts: IdleWriteOptions): Promise<IdleWriteOutcome> {
  const project = resolveProjectPath(opts.worktree, opts.directory)

  // Wave 4: Prepare source BEFORE enqueueing to avoid holding locks across I/O
  // All terminal outcomes use finishIdleOutcome to set queue status
  let outcome: IdleWriteOutcome
  let prepared: PreparedIdleSource
  try {
    prepared = await prepareIdleSource(opts)
  } catch (error) {
    // Preparation is outside the queue.  An unexpected source/preparation
    // exception is an application error, not a queue rejection.
    void log(opts.client, "error", "idle source preparation failed", {
      error: String(error),
    })
    return finishIdleOutcome(project, "error")
  }

  if (prepared.kind === "no-messages") {
    outcome = finishIdleOutcome(project, "no-messages")
  } else if (prepared.kind === "error") {
    outcome = finishIdleOutcome(project, "error")
  } else if (prepared.kind === "write-failed") {
    outcome = finishIdleOutcome(project, "write-failed")
  } else {
    // Queue key is the source-version key, not just session ID
    const queueKey = `idle:${prepared.sourceVersionKey}`
    try {
      outcome = await enqueueProjectJob(
        project,
        queueKey,
        async () => {
          try {
            return await processPreparedIdleSource(opts, prepared)
          } catch (error) {
            // A queue job that reaches the writer but hits an unexpected
            // application exception is an error, not a heuristic fallback.
            void log(opts.client, "error", "idle memory pipeline failed", {
              error: String(error),
            })
            return finishIdleOutcome(project, "error")
          }
        },
      )
    } catch {
      // A rejection from the queue boundary itself is a queue failure.
      outcome = finishIdleOutcome(project, "queue-failed")
    }
    // Wave 6: enqueueProjectJob already sets lastOutcome internally, but we ensure it's set here too
    finishIdleOutcome(project, outcome)
  }
  return outcome
}

/**
 * Final LLM merge in one short transaction (PR 2 §11.E). The cache identity
 * check runs INSIDE the transaction against the authoritative lock-read base,
 * so a concurrent commit of the same cache identity is observed rather than a
 * pre-lock snapshot. Exported as a test seam for the Wave-4/6 cross-process
 * and no-lock-prompt-zone tests.
 *
 * Wave 5: Refactored to carry explicit identities and ensure processed-source
 * completion record is written atomically with accepted LLM facts.
 */
export async function finalLLMMerge(
  opts: { client: unknown; worktree: string; directory: string },
  args: {
    sessionId: string
    gitSha: string | null
    canonicalInput: CanonicalExtractionInput
    selectedModel: SmallModel
    selectedCacheKey: string
    sourceVersionKey: string
    sourceInputSha256: string
    promptInputSha256: string
    llmFacts: LLMDecisionFacts
    extractionAuditSessionID?: string
    candidates: EvidenceCandidateMap
    digests: Readonly<Record<string, string>>
  },
): Promise<MemoryMutationResult<{ outcome: "committed" | "noop"; memory: MemoryFile }>> {
  const { client, worktree, directory } = opts
  // Wave 5 §10.6: Protect the newly created processed-source key from eviction
  // The source key is required proof that the source was successfully processed.
  const budgetProtection: MemoryBudgetProtection = {
    preserveProcessedSourceKeys: [args.sourceVersionKey],
  }
  return mutateMemory<{ outcome: "committed" | "noop"; memory: MemoryFile }>(
    { worktree, directory, client },
    (base) => {
      // Wave 5 §10.1: Re-check processed_sources by sourceVersionKey (explicit identity)
      const completed = findProcessedSource(base, args.sourceVersionKey)
      if (completed) {
        // Wave 5 §10.2: Already completed - return noop without replaying cached facts
        return { kind: "noop", value: { outcome: "noop", memory: base } }
      }

      // Wave 5 §10.2b: Check for a matching cache entry committed by a concurrent
      // process. If found, use those facts — observed under the lock read baseline.
      // Wave 5 B1: Only use cache facts if the source is already complete.
      // If the source is not complete, always merge the current accepted args.llmFacts.
      // A concurrent cache row without its matching completion marker is diagnostic/disposable only.
      let effectiveFacts = args.llmFacts
      let effectiveAuditSessionID = args.extractionAuditSessionID
      const concurrentCacheEntry = readExtractionCacheEntry(
        base,
        args.selectedCacheKey,
        args.sourceVersionKey !== undefined
          ? {
              evidenceCandidateMap: args.candidates,
              evidenceDigestMap: args.digests,
              sourceVersionKey: args.sourceVersionKey,
              sourceInputSha256: args.sourceInputSha256,
              promptInputSha256: args.promptInputSha256,
              extractionContractVersion: EXTRACTION_CONTRACT_VERSION,
              providerID: args.selectedModel.providerID,
              modelID: args.selectedModel.modelID,
              modelVariant: args.selectedModel.variant,
            }
          : {
              evidenceCandidateMap: args.candidates,
              evidenceDigestMap: args.digests,
            },
      )
      if (concurrentCacheEntry) {
        // Wave 5 B1: Only substitute cache facts if the source is already complete.
        // If the source is not complete, preserve the current accepted llmFacts.
        const completed = findProcessedSource(base, args.sourceVersionKey)
        if (!completed) {
          // Source is not complete — preserve current accepted facts, do not replay stale cache payload
          effectiveFacts = args.llmFacts
          effectiveAuditSessionID = args.extractionAuditSessionID
        } else {
          // Source is complete — use cache facts (already validated by pre-prompt path)
          effectiveFacts = concurrentCacheEntry.facts as unknown as LLMDecisionFacts
          effectiveAuditSessionID = concurrentCacheEntry.provenance?.source_audit_session_id ?? args.extractionAuditSessionID
        }
      }

      // Wave 5 §10.3: Merge accepted LLM facts against newest base
      const timestamp = new Date().toISOString()
      const mergedLLM = mergeLLMDecisionFacts(base, effectiveFacts, {
        sessionId: args.sessionId,
        gitSha: args.gitSha,
        timestamp,
        origin: "llm",
        auditSessionID: effectiveAuditSessionID,
        evidenceCandidates: args.candidates,
      })

      // Wave 5 §10.4: Optionally store result-cache payload when safe
      // Wave 5: Cache stores only decisions, not full ExtractedFacts
      const decisionEvidence = [
        ...effectiveFacts.decisions.flatMap((decision) => candidateEvidence(
          (decision as { evidence_refs?: unknown }).evidence_refs,
          args.candidates,
        )),
      ].filter((evidence, index, all) => (
        all.findIndex((candidate) => candidate.ref === evidence.ref) === index
      ))
      const cacheEvidence = decisionEvidence
      const cacheCanRepresentAllEvidence = decisionEvidence.length <= 3
      const withCache = cacheCanRepresentAllEvidence && cacheEvidence.length > 0 && effectiveAuditSessionID
        ? upsertExtractionCache(
            recordRecentSession(mergedLLM, args.sessionId),
            makeExtractionCacheEntry({
              sourceSessionID: args.sessionId,
              canonicalInput: args.canonicalInput,
              model: args.selectedModel,
              // Wave 5: Store decisions-only facts in cache payload
              facts: { decisions: effectiveFacts.decisions },
              auditSessionID: effectiveAuditSessionID,
              evidence: cacheEvidence,
              completedAt: timestamp,
              sourceVersionKey: args.sourceVersionKey,
              sourceInputSha256: args.sourceInputSha256,
              promptInputSha256: args.promptInputSha256,
              extractionContractVersion: EXTRACTION_CONTRACT_VERSION,
              modelVariant: args.selectedModel.variant,
            }),
          )
        : recordRecentSession(mergedLLM, args.sessionId)

      // Wave 5 §10.5: ALWAYS store compact processed-source completion record
      // Use current v2e key (not an arbitrary stale selectedCacheKey)
      const processedSourceRecord: ProcessedSource = {
        source_key: args.sourceVersionKey,
        extraction_key: args.selectedCacheKey,
        extraction_contract_version: EXTRACTION_CONTRACT_VERSION,
        completed_at: timestamp,
      }
      const withProcessedSource = upsertProcessedSource(withCache, processedSourceRecord)

      // Wave 5 §10.6: Return unpruned candidate with budget protection
      // The callback memory should be the unpruned withProcessedSource candidate.
      // Action value may carry that pre-fit memory only for compatibility.
      // Callers use result.memory (which is the fitted version from central fitMemoryToBudget).
      // Budget protection belongs on MutationAction.commit, not on the callback.
      return { kind: "commit", memory: withProcessedSource, value: { outcome: "committed", memory: withProcessedSource }, budgetProtection }
    },
  )
}

function upsertAuditMetadata(mem: MemoryFile, audit: LLMAuditMetadata): MemoryFile {
  const audits = (mem.llm_extraction_audits ?? [])
    .filter((candidate) => candidate.audit_session_id !== audit.audit_session_id)
  return {
    ...mem,
    llm_extraction_audits: boundedAuditMetadata([...audits, audit]),
  }
}

/**
 * Persist the audit guard in one short transaction (PR 2 §11.B). Returns
 * `false` on any lock/read/commit failure so prompting does not continue
 * without a durable guard (PR 2 §13). Exported as a test seam so the
 * Wave-4/6 cross-process and failure-injection tests can drive it directly.
 */
export type AuditGuardPersistenceResult =
  | { status: "committed" }
  | {
      status: "failed"
      reason: "lock-timeout" | "unavailable" | "commit-failed" | "unexpected" | "budget-rejected"
    }

export async function persistAuditGuardResult(
  opts: { client: unknown; worktree: string; directory: string },
  audit: LLMAuditMetadata,
): Promise<AuditGuardPersistenceResult> {
  const project = resolveProjectPath(opts.worktree, opts.directory)
  let result: MemoryMutationResult<{ outcome: "committed" | "noop" }>
  try {
    result = await mutateMemory<{ outcome: "committed" | "noop" }>(
      { worktree: opts.worktree, directory: opts.directory, client: opts.client },
      (base) => {
        const guarded = upsertAuditMetadata(base, audit)
        // Return unpruned guarded candidate with budget protection
        const budgetProtection: MemoryBudgetProtection = {
          preserveAuditSessionIDs: [audit.audit_session_id],
        }
        return { kind: "commit", memory: guarded, value: { outcome: "committed" }, budgetProtection }
      },
    )
  } catch (error) {
    void log(opts.client, "warn", "audit guard transaction threw", {
      project,
      error: boundedDiagnosticError(error),
    })
    return { status: "failed", reason: "unexpected" }
  }
  if (result.status === "lock-timeout") {
    void log(opts.client, "warn", "audit guard transaction lock-timeout", { project })
    return { status: "failed", reason: "lock-timeout" }
  }
  if (result.status === "unavailable") {
    void log(opts.client, "warn", "audit guard transaction unavailable", { project })
    return { status: "failed", reason: "unavailable" }
  }
  if (result.status === "commit-failed") {
    void log(opts.client, "warn", "audit guard transaction commit-failed", { project })
    return { status: "failed", reason: "commit-failed" }
  }
  if (result.status === "budget-rejected") {
    // Budget rejection: bounded warning and non-success behavior
    void log(opts.client, "warn", "audit guard transaction budget-rejected", {
      project,
      reason: result.reason,
      requiredBytes: result.requiredBytes,
      maxBytes: result.maxBytes,
    })
    return { status: "failed", reason: "budget-rejected" as const }
  }
  return { status: "committed" }
}

/**
 * Compatibility boolean seam for callers that only need persistence success.
 * Returns false on budget rejection.
 */
export async function persistAuditGuard(
  opts: { client: unknown; worktree: string; directory: string },
  audit: LLMAuditMetadata,
): Promise<boolean> {
  const result = await persistAuditGuardResult(opts, audit)
  return result.status === "committed"
}

/**
 * Persist the terminal audit outcome in one short transaction (PR 2 §11.C).
 * Returns `noop` (no revision bump) when the audit row no longer exists in the
 * locked read base. Best-effort: failures log a bounded warning and continue
 * without a stale fallback write. Exported as a test seam.
 */
export async function persistTerminalTransaction(
  opts: { client: unknown; worktree: string; directory: string },
  auditSessionID: string,
  outcome: Exclude<AuditTerminalOutcome, "pending">,
): Promise<void> {
  const project = resolveProjectPath(opts.worktree, opts.directory)
  let result: MemoryMutationResult<{ outcome: "committed" | "noop" }>
  try {
    result = await mutateMemory<{ outcome: "committed" | "noop" }>(
      { worktree: opts.worktree, directory: opts.directory, client: opts.client },
      (base) => {
        const audits = base.llm_extraction_audits ?? []
        if (!audits.some((a) => a.audit_session_id === auditSessionID)) {
          // Audit row no longer exists; return noop rather than bumping revision.
          return { kind: "noop", value: { outcome: "noop" } }
        }
        const updated = setAuditTerminalOutcome(base, auditSessionID, outcome)
        // Return unpruned updated candidate with same audit ID protection
        const budgetProtection: MemoryBudgetProtection = {
          preserveAuditSessionIDs: [auditSessionID],
        }
        return { kind: "commit", memory: updated, value: { outcome: "committed" }, budgetProtection }
      },
    )
  } catch (error) {
    void log(opts.client, "warn", "audit terminal transaction threw", {
      project,
      error: boundedDiagnosticError(error),
    })
    return
  }
  if (result.status === "noop") return
  if (result.status === "lock-timeout") {
    void log(opts.client, "warn", "audit terminal transaction lock-timeout", { project })
    return
  }
  if (result.status === "unavailable") {
    void log(opts.client, "warn", "audit terminal transaction unavailable", { project })
    return
  }
  if (result.status === "commit-failed") {
    void log(opts.client, "warn", "audit terminal transaction commit-failed", { project })
    return
  }
  if (result.status === "budget-rejected") {
    // Budget rejection: bounded warning and non-success behavior
    void log(opts.client, "warn", "audit terminal transaction budget-rejected", {
      project,
      reason: result.reason,
      requiredBytes: result.requiredBytes,
      maxBytes: result.maxBytes,
    })
    return
  }
}

/**
 * Persist one model-health outcome in a short transaction (PR 2 §11.D).
 * Best-effort: on transaction failure log a bounded warning and return without
 * retry; never fall back to a stale full-state write. Exported as a test seam.
 */
export async function persistModelHealth(
  opts: { client: unknown; worktree: string; directory: string },
  report: LLMHealthOutcomeReport,
): Promise<void> {
  const project = resolveProjectPath(opts.worktree, opts.directory)
  let result: MemoryMutationResult<{ outcome: "committed" | "noop" }>
  try {
    result = await mutateMemory<{ outcome: "committed" | "noop" }>(
      { worktree: opts.worktree, directory: opts.directory, client: opts.client },
      (base) => {
        const updated = upsertModelHealth(base, report)
        // Model health may remain best-effort and unprotected; no pruneOld call
        return { kind: "commit", memory: updated, value: { outcome: "committed" } }
      },
    )
  } catch (error) {
    void log(opts.client, "warn", "model health transaction threw", {
      project,
      error: boundedDiagnosticError(error),
    })
    return
  }
  if (result.status === "lock-timeout") {
    void log(opts.client, "warn", "model health transaction lock-timeout", { project })
    return
  }
  if (result.status === "unavailable") {
    void log(opts.client, "warn", "model health transaction unavailable", { project })
    return
  }
  if (result.status === "commit-failed") {
    void log(opts.client, "warn", "model health transaction commit-failed", { project })
    return
  }
  if (result.status === "budget-rejected") {
    // Budget rejection: bounded warning and non-success behavior
    void log(opts.client, "warn", "model health transaction budget-rejected", {
      project,
      reason: result.reason,
      requiredBytes: result.requiredBytes,
      maxBytes: result.maxBytes,
    })
    return
  }
}

export function boundedAuditMetadata(audits: LLMAuditMetadata[]): LLMAuditMetadata[] {
  const active = audits.filter((audit) => audit.terminal_outcome === "pending")
  const completed = audits.filter((audit) => audit.terminal_outcome !== "pending")
  // Keep the newest pending guards first, then use whatever capacity remains
  // for the newest completed audit history. Restore original order after the
  // timestamp selection so serialized metadata stays deterministic.
  const retainedActive = mostRecentAuditRecords(active, 20)
  const completedSlots = Math.max(0, 20 - retainedActive.length)
  // Pending guards are retained ahead of pruning completed history so a
  // reload cannot re-enter an active audit session.
  return [...mostRecentAuditRecords(completed, completedSlots), ...retainedActive]
}

function mostRecentAuditRecords(
  audits: LLMAuditMetadata[],
  limit: number,
): LLMAuditMetadata[] {
  if (limit >= audits.length) return audits
  return audits
    .map((audit, index) => ({ audit, index }))
    .sort((left, right) => (
      left.audit.created_at.localeCompare(right.audit.created_at) || left.index - right.index
    ))
    .slice(-limit)
    .sort((left, right) => left.index - right.index)
    .map(({ audit }) => audit)
}

function setAuditTerminalOutcome(
  mem: MemoryFile,
  auditSessionID: string,
  outcome: Exclude<AuditTerminalOutcome, "pending">,
): MemoryFile {
  return {
    ...mem,
    llm_extraction_audits: (mem.llm_extraction_audits ?? []).map((audit) => (
      audit.audit_session_id === auditSessionID
        ? { ...audit, terminal_outcome: outcome }
        : audit
    )),
  }
}

// ─── extractFactsHeuristic ───────────────────────────────────────────────────

/** Decision keyword regex — must be sentence-initial or after a clause boundary */
const DECISION_KEYWORD_RE =
  /(?:^|[,;]\s+|\.+\s+)(?:decision|decided|let's|we'll|we will|chose|picked|going with|go with|settle on|settled on)\s+(?!not|never|against|avoid|skip|reject)\b/i

/** Negation words to check in the 3 words before AND after a keyword */
const NEGATION_WORDS_RE = /(?:not|never|don't|won't|avoid|skip|reject|against)/i

/** Foundational auto-detection patterns */
const FOUNDATIONAL_RE =
  /we (will|'ll) (always|never)|architect(?:ure)? decision|breaking change|migrat(?:e|ion|ing) to|this (?:changes|breaks) the (?:public )?api/i

/** Extracted decision (internal, before adding to facts) */
interface RawDecision {
  topic: string
  decision: string
  rationale?: string
  foundational: boolean
}

/**
 * Extract structured facts from a session transcript using heuristics.
 * No LLM cost. Full algorithm in docs/IMPLEMENTATION.md Appendix A.1.
 */
export function extractFactsHeuristic(
  messages: TranscriptMessage[],
): ExtractedFacts {
  // current_task: first user message text, truncate to 200 chars
  const current_task = extractCurrentTask(messages)

  // active_files: parse tool parts for files, count frequency, top 5
  const active_files = extractActiveFiles(messages)

  // decisions: scan first user message + assistant text + completed tool outputs
  const decisions = extractDecisions(messages)

  // blockers: scan last assistant message
  const blockers = extractBlockers(messages)

  // next_steps: scan last assistant message
  const next_steps = extractNextSteps(messages)

  return { current_task, active_files, decisions, blockers, next_steps }
}

function extractCurrentTask(messages: TranscriptMessage[]): string | null {
  // Find the first user message that contains natural language (not XML/task results)
  for (const msg of messages) {
    if (msg.info.role !== "user") continue
    const text = getMessageText(msg)
    if (!text) continue

    // Skip messages that are XML/task results (start with <task, <summary, etc.)
    if (/^\s*<task|^\s*<summary|^\s*<task_result/.test(text)) continue

    // Skip messages that are mostly JSON
    if (/^\s*[{[]/.test(text)) continue

    // Strip code blocks and take the first natural language line
    const cleaned = stripCodeBlocks(text)
    const firstLine = cleaned.split("\n").find((l) => l.trim().length > 10)
    if (firstLine) {
      return firstLine.trim().slice(0, MEMORY_CREATION_LIMITS.currentTaskChars)
    }
  }
  return null
}

function extractActiveFiles(
  messages: TranscriptMessage[],
): { path: string; reason: string }[] {
  const fileCounts = new Map<string, number>()

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue

      const toolName = part.tool
      const input = ((part as { state?: { input?: Record<string, unknown> } }).state?.input || {}) as Record<string, unknown>

      if (
        toolName === "read" ||
        toolName === "edit" ||
        toolName === "write" ||
        toolName === "glob" ||
        toolName === "grep" ||
        toolName === "bash"
      ) {
        const paths = extractPaths(toolName, input)
        for (const p of paths) {
          const normalized = normalizePath(p)
          if (normalized) {
            fileCounts.set(normalized, (fileCounts.get(normalized) ?? 0) + 1)
          }
        }
      }
    }
  }

  // Sort by frequency desc, then select the most frequent observations. The
  // quality rank is the existing top-5 selection bounded by the exported
  // activeFilesMax creation ceiling so the emitted count can never exceed the
  // automatic creation contract (B4).
  const sorted = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.min(TOP_ACTIVE_FILES, MEMORY_CREATION_LIMITS.activeFilesMax))

  return sorted.map(([path, count]) => {
    const reason = count > 1 ? `edited ${count} times` : "read once"
    return {
      path,
      // Cap the automatic reason at the creation bound (B4).
      reason: reason.slice(0, MEMORY_CREATION_LIMITS.activeFileReasonChars),
    }
  })
}

/**
 * Normalize and validate a file path.
 * Returns null if the path is not a plausible source file.
 */
function normalizePath(p: string): string | null {
  // Strip leading ./
  let path = p.replace(/^\.\//, "")

  // Reject URLs and URL fragments
  if (path.includes("://")) return null
  if (path.includes("github.com/")) return null
  if (path.includes("raw.githubusercontent")) return null

  // Reject system paths
  if (path.startsWith("/dev/") || path.startsWith("/usr/") || path.startsWith("/bin/")) return null
  if (path.startsWith("/lib/") || path.startsWith("/etc/") || path.startsWith("/proc/")) return null
  if (path.startsWith("/sys/") || path.startsWith("/tmp/opencode")) return null

  // Reject opencode internal paths
  if (path.includes("opencode.db") || path.includes("opencode/log/")) return null
  if (path.includes(".local/share/opencode")) return null

  // Reject node_modules
  if (path.startsWith("node_modules")) return null

  // Reject paths that don't have a file extension (directories, not files)
  // unless they're clearly source paths (src/, test/, docs/, lib/)
  if (!/\.\w+$/.test(path)) {
    const sourcePrefixes = ["src/", "test/", "docs/", "lib/", "scripts/"]
    if (!sourcePrefixes.some((prefix) => path.startsWith(prefix))) {
      return null
    }
  }

  // Reject paths that are just fragments (no directory separator)
  if (!path.includes("/") && !path.startsWith("/")) return null

  // Reject if path looks like a command name (single word, no extension)
  if (!path.includes("/") && !path.includes(".")) return null

  // B4: reject paths that exceed the automatic creation bound rather than
  // emitting a truncated fragment of a real path into durable state. The
  // persistence ceiling is broader (4,096), so only new automatic paths are
  // gated here; previously persisted human-reviewed paths are untouched.
  if (path.length > MEMORY_CREATION_LIMITS.activeFilePathChars) return null

  return path
}

/** Extract file paths from tool input. */
function extractPaths(tool: string, input: Record<string, unknown>): string[] {
  const paths: string[] = []

  // Direct path fields (filePath is the real opencode field name)
  for (const key of ["filePath", "path", "file"]) {
    const val = input[key]
    if (typeof val === "string" && val.length > 0) {
      paths.push(val)
    }
  }

  // Array fields
  for (const key of ["paths", "query"]) {
    const val = input[key]
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string" && item.length > 0) {
          paths.push(item)
        }
      }
    }
  }

  // Pattern fields (glob/grep patterns may be file-like)
  const pattern = input["pattern"]
  if (typeof pattern === "string" && pattern.length > 0) {
    // Only include if it looks file-like (has a path separator or extension)
    if (pattern.includes("/") || pattern.includes(".")) {
      paths.push(pattern)
    }
  }

  // Bash command: extract file-like paths from command string
  if (tool === "bash") {
    const command = input["command"]
    if (typeof command === "string") {
      // Match paths that look like real source files: must have a path separator
      // and a file extension, or start with a known source directory
      const pathMatches = command.matchAll(
        /(?:\.?\/)?(?:[\w-]+\/)+[\w.-]+\.\w+/g,
      )
      for (const m of pathMatches) {
        const p = m[0]
        // Filter out non-file paths
        if (
          p.includes("://") || // URLs
          p.startsWith("node_modules") ||
          p === "/dev/null" ||
          p === "/dev/stdin" ||
          p === "/dev/stdout" ||
          p === "/dev/stderr" ||
          p.startsWith("/usr/") || // system paths
          p.startsWith("/bin/") ||
          p.startsWith("/lib/") ||
          p.startsWith("/etc/") ||
          p.startsWith("/proc/") ||
          p.startsWith("/sys/") ||
          p.startsWith("/tmp/opencode") // opencode temp paths
        ) {
          continue
        }
        paths.push(p)
      }
    }
  }

  return paths
}

function extractDecisions(messages: TranscriptMessage[]): {
  topic: string
  decision: string
  rationale?: string
  foundational?: boolean
}[] {
  const allDecisions: RawDecision[] = []

  // Source 1: first user message (strip code blocks)
  const firstUser = messages.find((m) => m.info.role === "user")
  if (firstUser) {
    allDecisions.push(...scanTextForDecisions(stripCodeBlocks(getMessageText(firstUser))))
  }

  // Source 2: all assistant messages (strip code blocks first)
  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      const text = stripCodeBlocks(getMessageText(msg))
      allDecisions.push(...scanTextForDecisions(text))
    }
  }

  // Source 3: REMOVED — tool outputs contain file contents, JSON, and logs
  // that produce false positives (e.g. "Let's set up the schema" inside a JSON
  // fixture). Decisions should only come from natural language conversation.

  // Dedupe by exact normalized topic (NOT substring)
  const seen = new Set<string>()
  const deduped: {
    topic: string
    decision: string
    rationale?: string
    foundational?: boolean
  }[] = []

  for (const d of allDecisions) {
    const normalized = d.topic.toLowerCase().trim().replace(/\s+/g, " ")
    if (!seen.has(normalized)) {
      seen.add(normalized)
      deduped.push({
        topic: d.topic.slice(0, MEMORY_CREATION_LIMITS.decisionTopicChars),
        decision: d.decision,
        rationale: d.rationale
          ? d.rationale.slice(0, MEMORY_CREATION_LIMITS.decisionRationaleChars)
          : undefined,
        foundational: d.foundational,
      })
    }
  }

  return deduped
}

/**
 * Scan text for decision sentences with negation detection.
 * Returns array of extracted decisions.
 * Keywords must be sentence-initial or after a clause boundary (comma/semicolon/newline)
 * to avoid matching "The decision regex has a gap" (noun, not verb).
 */
function scanTextForDecisions(text: string): RawDecision[] {
  if (!text || text.length === 0) return []

  const decisions: RawDecision[] = []
  const seenSentences = new Set<string>()

  // Split into sentences for context. Also split on newlines so each line
  // is treated as its own "sentence" for clause boundary detection.
  const sentences = text.split(/(?<=[.!?])\s+|\n+/)

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim()
    if (!trimmedSentence) continue

    // Skip sentences that are inside code blocks, quotes, or backticks
    // (these are descriptions of decisions, not actual decisions)
    if (trimmedSentence.startsWith("`") || trimmedSentence.startsWith(">") || trimmedSentence.startsWith("*") || trimmedSentence.startsWith("-")) {
      // Allow bullet points that start with "Let's" etc, but skip code/quotes
      if (!/^(let's|we'll|we will|decision|decided|chose|picked|going with|go with|settle on|settled on)\b/i.test(trimmedSentence)) {
        continue
      }
    }

    // Skip sentences containing "regex" or "pattern" — these are almost always
    // descriptions of the extraction logic, not actual decisions
    if (/\b(?:regex|pattern|heuristic|extraction|negation|keyword)\b/i.test(trimmedSentence)) {
      continue
    }

    // Use matchAll to find ALL decision keywords in the sentence
    const allMatches = [...trimmedSentence.matchAll(
      new RegExp(DECISION_KEYWORD_RE.source, DECISION_KEYWORD_RE.flags.replace("i", "") + "gi"),
    )]

    for (const match of allMatches) {
      const keywordIndex = match.index!
      const keywordText = match[0]
      const keywordEnd = keywordIndex + keywordText.length

      // Negation detection: check 3 words BEFORE the keyword
      const beforeText = trimmedSentence.slice(0, keywordIndex).trim()
      const beforeWords = beforeText.split(/\s+/)
      const lastThreeBefore = beforeWords.slice(-3).join(" ")

      if (NEGATION_WORDS_RE.test(lastThreeBefore)) {
        continue // Skip negated decisions
      }

      // Also check the keyword itself for inline negation
      if (/not|never|don't|won't|avoid|skip|reject|against/i.test(keywordText)) {
        continue
      }

      // Post-keyword negation: check 3 words AFTER the keyword
      // This catches "decided to not use Postgres" and "let's not use X"
      const afterText = trimmedSentence.slice(keywordEnd).trim()
      const afterWords = afterText.split(/\s+/)
      const firstThreeAfter = afterWords.slice(0, 3).join(" ")

      if (NEGATION_WORDS_RE.test(firstThreeAfter)) {
        continue // Skip post-keyword negated decisions
      }

      // Topic extraction: first noun phrase after keyword
      const topic = extractTopicPhrase(afterText)
      if (!topic) continue

      // Quality filter: reject low-confidence topics
      if (!isPlausibleTopic(topic.normalized)) continue

      // Auto-detect foundational
      const foundational = FOUNDATIONAL_RE.test(trimmedSentence)

      // Decision text: the full sentence, trimmed
      const decision = trimmedSentence

      // Quality filter: reject decisions containing JSON/code artifacts
      if (!isPlausibleDecision(decision)) continue

      // Dedup by sentence — if the same sentence produced multiple matches,
      // keep only the first (prevents "let's go with" matching both "let's" and "go with")
      const sentenceKey = decision.slice(0, 100)
      if (seenSentences.has(sentenceKey)) continue
      seenSentences.add(sentenceKey)

      decisions.push({
        topic: topic.normalized.slice(0, MEMORY_CREATION_LIMITS.decisionTopicChars),
        decision: decision.slice(0, MEMORY_CREATION_LIMITS.decisionTextChars),
        foundational,
      })
    }
  }

  return decisions
}

/**
 * Check if a topic is plausible as a real decision topic.
 * Rejects: common English words, code fragments, JSON artifacts, too-short topics.
 */
function isPlausibleTopic(topic: string): boolean {
  // Must be at least 3 chars
  if (topic.length < 3) return false

  // Reject if contains non-alphanumeric chars (code fragments like know", schema." })
  if (!/^[a-z0-9\s-]+$/i.test(topic)) return false

  // Reject common English words that are not decision topics
  const COMMON_WORDS = new Set([
    "know", "go", "schema", "topics", "keywords", "regex", "pattern",
    "heuristic", "extraction", "negation", "keyword", "decision",
    "the", "this", "that", "what", "which", "how", "why", "when",
    "use", "using", "used", "set", "get", "put", "run", "try",
    "fix", "test", "code", "file", "data", "type", "name", "path",
    "line", "word", "text", "part", "step", "next", "last", "first",
    "new", "old", "add", "del", "mod", "put", "see", "say",
    "one", "two", "all", "any", "some", "each", "both",
  ])
  if (COMMON_WORDS.has(topic.toLowerCase())) return false

  return true
}

/**
 * Check if a decision text is plausible as a real decision.
 * Rejects: JSON artifacts, escaped quotes, code fragments.
 */
function isPlausibleDecision(decision: string): boolean {
  // Reject if contains escaped quotes (JSON artifact)
  if (decision.includes('\\"') || decision.includes("\\\\")) return false

  // Reject if contains JSON key-value patterns like "topic": " or "decision": "
  if (/"\w+":\s*"/.test(decision)) return false

  // Reject if starts with a quote (likely code/JSON)
  if (decision.startsWith('"') || decision.startsWith("'")) return false

  return true
}

/**
 * Extract the first noun phrase after a decision keyword.
 * Normalizes: lowercase, strips leading articles (the, a, an, our),
 * collapses whitespace.
 */
function extractTopicPhrase(afterKeyword: string): { raw: string; normalized: string } | null {
  let words = afterKeyword.trim().split(/\s+/)
  if (words.length === 0) return null

  // Skip leading grammatical/filler words that commonly follow decision keywords:
  // "decided to use Postgres" → skip "to", "use"
  // "chose the simpler approach" → skip "the"
  // "decision that MongoDB" → skip "that"
  // "let's go with Postgres" → skip "go", "with"
  // "let's build a REST API" → skip "build", "a"
  // "let's set up the schema" → skip "set", "up", "the"
  while (words.length > 0) {
    const first = words[0]!.toLowerCase()
    if (
      first === "to" ||
      first === "the" ||
      first === "a" ||
      first === "an" ||
      first === "that" ||
      first === "use" ||
      first === "using" ||
      first === "go" ||
      first === "with" ||
      first === "build" ||
      first === "set" ||
      first === "up" ||
      first === "start" ||
      first === "create" ||
      first === "implement" ||
      first === "for" ||
      first === "on" ||
      first === "in" ||
      first === "our"
    ) {
      words = words.slice(1)
    } else {
      break
    }
  }

  if (words.length === 0) return null

  // Take words until punctuation or a verb-like word
  const stopWords = new Set([
    "is", "are", "was", "were", "be", "being", "been",
    "has", "have", "had", "do", "does", "did",
    "will", "would", "shall", "should", "can", "could",
    "may", "might", "must",
    "to", "for", "with", "from", "by", "on", "in", "at",
    "that", "which", "who", "whom", "whose",
    "and", "or", "but", "nor", "so", "yet",
    "because", "since", "although", "though", "while",
    "if", "unless", "until", "when", "where",
    "as",
  ])

  const topicWords: string[] = []
  for (const word of words) {
    // Stop at punctuation
    if (/[.!?;:]$/.test(word)) {
      const clean = word.replace(/[.!?;:]+$/, "")
      if (clean.length > 0 && !stopWords.has(clean.toLowerCase())) {
        topicWords.push(clean)
      }
      break
    }
    // Stop at stop words (verbs, prepositions, conjunctions)
    if (stopWords.has(word.toLowerCase())) {
      break
    }
    topicWords.push(word)
  }

  if (topicWords.length === 0) return null

  const raw = topicWords.join(" ")
  // Normalize: lowercase, strip leading articles
  let normalized = raw
    .toLowerCase()
    .replace(/^(the|a|an|our)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()

  // B4: cap the normalized topic at the automatic creation bound so a long
  // noun phrase can never create an over-limit durable heuristic topic.
  if (normalized.length > MEMORY_CREATION_LIMITS.decisionTopicChars) {
    normalized = normalized.slice(0, MEMORY_CREATION_LIMITS.decisionTopicChars)
  }

  return { raw: raw, normalized }
}

function extractBlockers(messages: TranscriptMessage[]): string[] {
  // Scan last assistant message for blocker-like lines
  const lastAssistant = [...messages].reverse().find((m) => m.info.role === "assistant")
  if (!lastAssistant) return []

  const text = getMessageText(lastAssistant)
  if (!text) return []

  const blockers: string[] = []
  const lines = text.split(/\n+/)

  for (const line of lines) {
    if (/blocked|can't|cannot|fails?|error|stuck|waiting on|depends on/i.test(line)) {
      blockers.push(line.trim().slice(0, MEMORY_CREATION_LIMITS.blockerChars))
    }
  }

  // B4: cap the emitted blocker count at the automatic creation bound.
  return blockers.slice(0, MEMORY_CREATION_LIMITS.blockersMax)
}

function extractNextSteps(messages: TranscriptMessage[]): string[] {
  // Scan last assistant message for numbered lists, "next:", "then:", "TODO", "step"
  const lastAssistant = [...messages].reverse().find((m) => m.info.role === "assistant")
  if (!lastAssistant) return []

  const text = getMessageText(lastAssistant)
  if (!text) return []

  const steps: string[] = []
  const lines = text.split(/\n+/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Numbered list
    if (/^\d+\.\s/.test(trimmed)) {
      steps.push(trimmed.slice(0, MEMORY_CREATION_LIMITS.nextStepChars))
      continue
    }

    // Keyword lines
    if (/^(next|then|step|todo)[\s:]/i.test(trimmed)) {
      steps.push(trimmed.slice(0, MEMORY_CREATION_LIMITS.nextStepChars))
      continue
    }
  }

  // B4: cap the emitted step count at the automatic creation bound.
  return steps.slice(0, MEMORY_CREATION_LIMITS.nextStepsMax)
}

/** Get all text from text parts of a message. */
function getMessageText(msg: TranscriptMessage): string {
  return msg.parts
    .filter((p): p is { type: "text"; text: string } & typeof p => p.type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => (p as unknown as { text: string }).text)
    .join("\n")
}

/**
 * Strip code blocks and inline code from text before decision scanning.
 * Code blocks contain file contents, JSON, logs — not natural language decisions.
 * Matches: ```...```, `...`, and lines that look like JSON (start with { or ").
 */
function stripCodeBlocks(text: string): string {
  // Remove fenced code blocks (```...```)
  let stripped = text.replace(/```[\s\S]*?```/g, "")
  // Remove inline code (`...`)
  stripped = stripped.replace(/`[^`]+`/g, "")
  // Remove lines that look like JSON (start with { " or } )
  stripped = stripped
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      if (
        trimmed.startsWith("{") ||
        trimmed.startsWith("}") ||
        trimmed.startsWith('"') ||
        trimmed.startsWith("[") ||
        trimmed.startsWith("]")
      ) {
        return false
      }
      return true
    })
    .join("\n")
  return stripped
}

// ─── markReferencedDecisions ─────────────────────────────────────────────────

/**
 * Scan transcript for recall_decision tool calls and mark all valid decisions
 * as used in this session.
 *
 * Pure: returns a NEW memory with the references marked and never mutates the
 * input. This lets the heuristic transaction call it inside the `mutateMemory`
 * callback on the authoritative lock-protected base (PR 2 §11.A).
 */
export function markReferencedDecisions(
  mem: MemoryFile,
  messages: TranscriptMessage[],
  sessionId: string,
): MemoryFile {
  // Collect IDs of decisions referenced by valid recall_decision tool calls.
  const referencedIds = new Set<string>()

  // Helper to validate and extract query/limit.
  const parseToolInput = (input: Record<string, unknown>) => {
    // Apply bounds from tools/bounds
    const rawQuery = input["query"] as unknown
    const rawLimit = input["limit"] as unknown
    // Validate query if provided
    let query: string | undefined
    if (rawQuery !== undefined) {
      if (typeof rawQuery !== "string" || rawQuery.length > TOOL_LIMITS.recallQueryChars) {
        return null // malformed query -> ignore this tool call
      }
      query = rawQuery
    }
    // Validate limit
    let limit: number | undefined
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > TOOL_LIMITS.recallLimitMax) {
        return null // malformed limit -> ignore
      }
      limit = rawLimit
    }
    // Apply defaults: limit defaults to 10 per schema, query optional.
    if (limit === undefined) limit = 10
    return { query, limit }
  }

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (
        part.type === "tool" &&
        part.tool === "recall_decision" &&
        (part as any).state?.status === "completed"
      ) {
        const input = (part as any).state?.input as unknown
        // Wave 5 B4: Require state.input to be a plain non-null, non-array object.
        // Missing/null/string/array/malformed inputs must contribute no marks.
        if (
          input === undefined ||
          input === null ||
          Array.isArray(input) ||
          typeof input !== "object" ||
          Object.getPrototypeOf(input) !== Object.prototype
        ) {
          // malformed input – ignore this call
          continue
        }
        const parsed = parseToolInput(input as Record<string, unknown>)
        if (!parsed) {
          // malformed input – ignore this call
          continue
        }
        const { query, limit } = parsed
        // Use the authoritative query helper to get decisions.
        const hits = queryDecisions(mem, query, limit)
        for (const d of hits) {
          if (d.id) referencedIds.add(d.id)
        }
      }
    }
  }

  if (referencedIds.size === 0) return mem

  return {
    ...mem,
    decisions: mem.decisions.map((d) =>
      d.still_valid && referencedIds.has(d.id)
        ? { ...d, last_used_in_session: sessionId }
        : d,
    ),
  }
}

// ─── mergeMemory ─────────────────────────────────────────────────────────────

type MergeMeta = {
  sessionId: string
  gitSha: string | null
  timestamp: string
  evidenceCandidates?: EvidenceCandidateMap
}

function normalizedFact(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ")
}

function makeProvenance(
  meta: MergeMeta,
  evidence: Evidence[],
): Provenance {
  return {
    extractor: "heuristic",
    source_session_id: meta.sessionId,
    confidence: "heuristic",
    evidence: evidence.slice(0, 3),
  }
}

function heuristicEvidenceFor(
  value: { topic?: string; decision?: string; path?: string; reason?: string },
  candidates: EvidenceCandidateMap | undefined,
): Evidence[] {
  if (!candidates) return []
  const needle = normalizedFact(value.decision ?? value.path ?? value.topic ?? "")
  const transcript = Object.values(candidates).find((candidate) => (
    candidate.kind === "transcript" &&
    typeof candidate.text === "string" &&
    normalizedFact(candidate.text).includes(needle)
  ))
  if (transcript) {
    return [{ kind: transcript.kind, ref: transcript.ref, digest: transcript.digest }]
  }

  const kind = value.topic !== undefined
    ? "decision"
    : value.path !== undefined
      ? "active-file"
      : "current-task"
  const ref = heuristicCandidateRef(kind, value.topic !== undefined
    ? { topic: value.topic, decision: value.decision }
    : value.path !== undefined
      ? { path: value.path, reason: value.reason }
      : value.decision)
  const candidate = candidates[ref]
  return candidate
    ? [{ kind: candidate.kind, ref: candidate.ref, digest: candidate.digest }]
    : []
}

/** Merge full heuristic facts into existing memory. */
export function mergeHeuristicMemory(
  existing: MemoryFile,
  extracted: HeuristicFacts,
  meta: MergeMeta,
): MemoryFile {
  let current_task = existing.current_task
  let current_task_provenance = existing.current_task_provenance
  if (extracted.current_task !== null) {
    current_task = extracted.current_task
    current_task_provenance = makeProvenance(
      meta,
      heuristicEvidenceFor({ decision: extracted.current_task }, meta.evidenceCandidates),
    )
  }

  const oldFileMap = new Map(existing.active_files.map((f) => [f.path, f]))
  const incomingFiles = extracted.active_files.map((f) => {
    const old = oldFileMap.get(f.path)
    const oldReason = old?.reason
    const isGeneric = f.reason === "read once" || f.reason.startsWith("edited ")
    return {
      path: f.path,
      reason: oldReason && isGeneric ? oldReason : f.reason,
      last_touched: meta.timestamp,
      provenance: makeProvenance(
        meta,
        heuristicEvidenceFor(f, meta.evidenceCandidates),
      ),
    }
  })
  const active_files = incomingFiles

  const decisions = mergeHeuristicDecisions(existing.decisions, extracted.decisions, meta)

  return {
    ...existing,
    version: 3,
    project_path: existing.project_path,
    last_updated: meta.timestamp,
    last_git_sha: meta.gitSha ?? existing.last_git_sha,
    last_session_id: meta.sessionId,
    current_task,
    current_task_provenance,
    active_files,
    decisions,
    blockers: extracted.blockers,
    next_steps: extracted.next_steps,
    recent_sessions: existing.recent_sessions ?? [],
  }
}

/** Heuristic-only merge entry point for pre-Wave4 callers. */
export function mergeMemory(
  existing: MemoryFile,
  extracted: ExtractedFacts,
  meta: MergeMeta,
): MemoryFile {
  return mergeHeuristicMemory(existing, extracted, meta)
}

/**
 * Record a source session in oldest-to-newest order without duplicates.
 * The returned memory is a new object so callers can safely retain the
 * pre-write snapshot.
 */
export function recordRecentSession(mem: MemoryFile, sessionId: string): MemoryFile {
  const recentSessions = [...new Set(mem.recent_sessions ?? [])]
  if (!recentSessions.includes(sessionId)) {
    recentSessions.push(sessionId)
  }

  return {
    ...mem,
    recent_sessions: recentSessions.slice(-10),
  }
}

// ─── pruneOld ────────────────────────────────────────────────────────────────

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const STALE_PENDING_AUDIT_AGE_MS = 2 * LLM_REQUEST_TIMEOUT_MS

function removeOldestCompletedAudit(mem: MemoryFile): boolean {
  const audits = mem.llm_extraction_audits
  if (!audits?.length) return false

  let oldestIndex = -1
  for (let index = 0; index < audits.length; index++) {
    const audit = audits[index]
    if (!audit || audit.terminal_outcome === "pending") continue
    if (oldestIndex === -1) {
      oldestIndex = index
      continue
    }

    const oldest = audits[oldestIndex]
    if (oldest && audit.created_at.localeCompare(oldest.created_at) < 0) {
      oldestIndex = index
    }
  }

  if (oldestIndex === -1) return false
  audits.splice(oldestIndex, 1)
  return true
}

function removeOldestCacheEntry(mem: MemoryFile): boolean {
  const entries = mem.llm_extraction_cache
  if (!entries?.length) return false

  let oldestIndex = 0
  for (let index = 1; index < entries.length; index++) {
    const current = entries[index]
    const oldest = entries[oldestIndex]
    if (current && oldest && (
      current.completed_at.localeCompare(oldest.completed_at) < 0
      || (current.completed_at === oldest.completed_at && index < oldestIndex)
    )) {
      oldestIndex = index
    }
  }

  entries.splice(oldestIndex, 1)
  return true
}

function removeOldestModelHealth(mem: MemoryFile): boolean {
  const records = mem.model_health
  if (!records?.length) return false

  let oldestIndex = 0
  for (let index = 1; index < records.length; index++) {
    const current = records[index]
    const oldest = records[oldestIndex]
    if (current && oldest && (
      (current.last_outcome_at ?? "").localeCompare(oldest.last_outcome_at ?? "") < 0
      || (
        (current.last_outcome_at ?? "") === (oldest.last_outcome_at ?? "")
        && index < oldestIndex
      )
    )) {
      oldestIndex = index
    }
  }

  records.splice(oldestIndex, 1)
  return true
}

function removeOldestRecentSession(mem: MemoryFile): boolean {
  if (!mem.recent_sessions?.length) return false
  mem.recent_sessions.shift()
  return true
}

function removeOldestProcessedSource(mem: MemoryFile): boolean {
  const sources = mem.processed_sources
  if (!sources?.length) return false

  // Sort by completed_at ascending (oldest first), preserving original order for ties
  const indexed = sources.map((s, i) => ({ s, originalIndex: i }))
  indexed.sort((a, b) => {
    const timeCompare = a.s.completed_at.localeCompare(b.s.completed_at)
    if (timeCompare !== 0) return timeCompare
    return a.originalIndex - b.originalIndex
  })

  // Remove the oldest entry
  const oldest = indexed[0]
  if (!oldest) return false

  const remaining = indexed.slice(1).map(({ s }) => s)
  mem.processed_sources = remaining
  return true
}

function reclassifyStalePendingAudits(
  audits: LLMAuditMetadata[],
  now: number,
): LLMAuditMetadata[] {
  return audits.map((audit) => {
    const createdAt = new Date(audit.created_at).getTime()
    const stale = audit.terminal_outcome === "pending"
      && Number.isFinite(createdAt)
      && now - createdAt > STALE_PENDING_AUDIT_AGE_MS
    return stale ? { ...audit, terminal_outcome: "failed" } : audit
  })
}

function removeDisposableMetadata(mem: MemoryFile, preserveProcessedSourceKey?: string): boolean {
  if (removeOldestCompletedAudit(mem)) return true
  if (removeOldestCacheEntry(mem)) return true
  if (removeOldestModelHealth(mem)) return true

  // PR 5 Wave 3: remove processed sources, but protect the specified key
  if (mem.processed_sources && mem.processed_sources.length > 0) {
    if (preserveProcessedSourceKey) {
      // Only remove if there's a source other than the protected one
      const otherSources = mem.processed_sources.filter(s => s.source_key !== preserveProcessedSourceKey)
      if (otherSources.length > 0) {
        // Sort by completed_at ascending (oldest first), preserving original order for ties
        const indexed = otherSources.map((s, i) => ({ s, originalIndex: i }))
        indexed.sort((a, b) => {
          const timeCompare = a.s.completed_at.localeCompare(b.s.completed_at)
          if (timeCompare !== 0) return timeCompare
          return a.originalIndex - b.originalIndex
        })
        // Remove the oldest among the non-protected sources
        const oldest = indexed[0]
        mem.processed_sources = mem.processed_sources.filter(s => s.source_key !== oldest.s.source_key)
        return true
      }
      // Cannot remove any processed source without losing the protected one
    } else {
      removeOldestProcessedSource(mem)
      return true
    }
  }

  if (mem.llm_extraction_cache_quarantine) {
    delete mem.llm_extraction_cache_quarantine
    return true
  }

  return removeOldestRecentSession(mem)
}

function boundedModelHealth(memories: NonNullable<MemoryFile["model_health"]>): NonNullable<MemoryFile["model_health"]> {
  if (memories.length <= MODEL_HEALTH_MAX_RECORDS) return memories
  return memories
    .map((health, index) => ({ health, index }))
    .sort((left, right) => (
      (left.health.last_outcome_at ?? "").localeCompare(right.health.last_outcome_at ?? "")
      || left.index - right.index
    ))
    .slice(-MODEL_HEALTH_MAX_RECORDS)
    .sort((left, right) => left.index - right.index)
    .map(({ health }) => health)
}

/**
 * PR 3 §13 — foundational retention predicate.
 *
 * Post-repair `foundational` is a meaningful retention signal: the Wave 2
 * compatibility repair removes unverified pre-PR3 `foundational=true`
 * promotion claims on load, so a surviving `foundational === true` row is a
 * confirmed retention intent. Only these rows are protected from ordinary
 * pruning.
 */
function retentionProtected(decision: Decision): boolean {
  return decision.foundational === true
}

/**
 * Deterministic protected-first decision selection for the count-pressure
 * stages (PR 3 §13.3).
 *
 * Every foundational decision is always retained. The numeric stage target
 * (10 in stage 6, 5 in stage 7) is a target for DISPOSABLE (non-foundational)
 * rows, NOT permission to delete protected state: up to `target` newest
 * non-foundational rows fill the remainder. If foundational rows alone exceed
 * the target, all of them are still kept and the function may intentionally
 * over-cap — the commitMemoryExact size guard catches any unrepresentable
 * state (PR 3 §13.4).
 */
function protectedFirstNewest(candidates: Decision[], target: number): Decision[] {
  const foundationals = candidates.filter(retentionProtected)
  const disposables = candidates
    .filter((d) => !retentionProtected(d))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  const disposablesToKeep = disposables.slice(0, Math.max(0, target))
  return [...foundationals, ...disposablesToKeep]
}

/**
 * Options for pruneOld.
 */
export type PruneOptions = {
  /** If provided, the processed_source with this source_key is protected from eviction. */
  preserveProcessedSourceKey?: string
}

/**
 * Prune a MemoryFile toward the 8KB cap.
 * Returns a NEW object (deep clone) — does not mutate input.
 * Full algorithm in docs/IMPLEMENTATION.md Appendix A.3.
 *
 * @param mem - The memory file to prune
 * @param client - Optional client for logging
 * @param now - Current timestamp in ms
 * @param options - Optional pruning options
 * @returns The pruned memory file, or the original if no pruning needed
 */
export function pruneOld(
  mem: MemoryFile,
  client?: unknown,
  now = Date.now(),
  options?: PruneOptions,
): MemoryFile {
  // Deep clone (don't mutate input)
  const cloned: MemoryFile = {
    version: mem.version,
    // revision is the monotonic freshness signal: it MUST survive every
    // reconstruction, otherwise a nonzero revision would silently reset to 0
    // and the resolver could resurrect stale global state.
    revision: mem.revision,
    project_path: mem.project_path,
    last_updated: mem.last_updated,
    last_git_sha: mem.last_git_sha,
    last_session_id: mem.last_session_id,
    current_task: mem.current_task,
    current_task_provenance: mem.current_task_provenance
      ? {
          ...mem.current_task_provenance,
          evidence: [...(mem.current_task_provenance.evidence ?? [])],
        }
      : undefined,
    active_files: mem.active_files.map((f) => ({ ...f })),
    decisions: mem.decisions.map((d) => ({ ...d })),
    blockers: [...mem.blockers],
    next_steps: [...mem.next_steps],
    recent_sessions: [...(mem.recent_sessions ?? [])],
    llm_extraction_cache: mem.llm_extraction_cache?.map((entry) => ({
      ...entry,
      facts: {
        decisions: entry.facts.decisions.map((decision) => ({ ...decision })),
      },
    })),
    llm_extraction_audits: mem.llm_extraction_audits
      ? boundedAuditMetadata(reclassifyStalePendingAudits(
          mem.llm_extraction_audits.map((audit) => ({ ...audit })),
          now,
        ))
      : undefined,
    model_health: mem.model_health
      ? boundedModelHealth(mem.model_health.map((health) => ({ ...health })))
      : undefined,
    llm_extraction_cache_quarantine: mem.llm_extraction_cache_quarantine
      ? { ...mem.llm_extraction_cache_quarantine }
      : undefined,
    processed_sources: mem.processed_sources?.map((s) => ({ ...s })) ?? [],
  }

  // Operational metadata is disposable before durable facts. Stale pending
  // audits were reclassified above, so they are eligible for this same audit
  // eviction pass while genuinely active guards remain protected.
  while (jsonSize(cloned) > MEMORY_MAX_BYTES && removeDisposableMetadata(cloned, options?.preserveProcessedSourceKey)) {
    // Re-check after each deterministic removal.
  }

  // 1. Check if within cap
  if (jsonSize(cloned) <= MEMORY_MAX_BYTES) return cloned

  // 2. Remove all decisions where still_valid === false, UNLESS the row is a
  //    protected foundational conflict record. Explicit human supersession
  //    clears `foundational` on the old authority (supersedeHumanAuthority,
  //    Wave 6), so deliberately superseded history becomes normally prunable
  //    again here.
  cloned.decisions = cloned.decisions.filter((d) => {
    if (d.still_valid) return true
    if (retentionProtected(d)) return true
    return false
  })
  if (jsonSize(cloned) <= MEMORY_MAX_BYTES) return cloned

  // 3. Cap active_files at 8 entries (sort by last_touched desc, keep top 8)
  cloned.active_files = [...cloned.active_files]
    .sort((a, b) => b.last_touched.localeCompare(a.last_touched))
    .slice(0, 8)
  if (jsonSize(cloned) <= MEMORY_MAX_BYTES) return cloned

  // 4. Remove decisions older than 30 days — never age-prune a foundational
  //    decision (PR 3 §13.2).
  cloned.decisions = cloned.decisions.filter((d) => {
    if (retentionProtected(d)) return true
    const ts = new Date(d.timestamp).getTime()
    return now - ts < THIRTY_DAYS_MS
  })
  if (jsonSize(cloned) <= MEMORY_MAX_BYTES) return cloned

  // 5. Truncate current_task to 200 chars, reason to 100 chars
  if (cloned.current_task && cloned.current_task.length > 200) {
    cloned.current_task = cloned.current_task.slice(0, 200)
  }
  cloned.active_files = cloned.active_files.map((f) => ({
    ...f,
    reason: f.reason.length > 100 ? f.reason.slice(0, 100) : f.reason,
  }))
  if (jsonSize(cloned) <= MEMORY_MAX_BYTES) return cloned

  // 6. Keep 10 most recent decisions via protected-first selection: every
  //    foundational decision survives; the numeric stage is a target for
  //    disposable rows, not permission to delete protected state (PR 3 §13.3).
  cloned.decisions = protectedFirstNewest(cloned.decisions, 10)
  if (jsonSize(cloned) <= MEMORY_MAX_BYTES) {
    void log(client, "warn", "tokenmaxxer: pruned decisions to 10 most recent to fit 8KB cap")
    return cloned
  }

  // 7. Last resort: keep only current_task + 5 most recent decisions, still
  //    with foundational rows protected. If protected state alone exceeds the
  //    cap, this intentionally returns an irreducible over-cap state rather
  //    than silently deleting a confirmed foundational decision (PR 3 §13.4);
  //    commitMemoryExact's size guard rejects the commit and prior STATE
  //    remains intact.
  cloned.decisions = protectedFirstNewest(cloned.decisions, 5)
  cloned.active_files = []
  cloned.blockers = []
  cloned.next_steps = []

  if (jsonSize(cloned) > MEMORY_MAX_BYTES) {
    void log(client, "error", "tokenmaxxer: STILL over 8KB after all pruning — truncating to current_task + 5 decisions")
  }

  return cloned
}

/**
 * Prune a MemoryFile for the final LLM commit with processed-source protection.
 * This is a wrapper around pruneOld that ensures the newly created processed-source
 * key is protected from eviction during the pruning process.
 *
 * If the state cannot fit even after pruning all allowed disposables while
 * preserving the newly created completion marker, the transaction must fail
 * rather than return llm-success without its completion proof.
 *
 * @param mem - The memory file to prune
 * @param client - Optional client for logging
 * @param now - Current timestamp in ms
 * @param preserveProcessedSourceKey - The source_key to protect from eviction
 * @returns The pruned memory file, or the original if size cannot be reduced
 */
export function pruneOldForCommit(
  mem: MemoryFile,
  client: unknown,
  now: number,
  preserveProcessedSourceKey: string,
): MemoryFile {
  // First, try pruning with the processed-source key protected
  const result = pruneOld(mem, client, now, { preserveProcessedSourceKey })

  // If the result is still over cap, we cannot commit
  // The caller should fail the transaction rather than silently losing the marker
  return result
}

/** Measure serialized JSON size in bytes. */
function jsonSize(mem: MemoryFile): number {
  return memorySizeBytes(mem)
}

// ─── generateHeader ──────────────────────────────────────────────────────────

/**
 * Generate HEADER.md in the worktree's memory directory.
 * Content per docs/IMPLEMENTATION.md §6.2.
 */
export async function generateHeader(
  worktree: string,
  directory: string,
  mem: MemoryFile,
): Promise<void> {
  const project = resolveProjectPath(worktree, directory)
  const headerPath = join(project, ".opencode", "memory", "HEADER.md")
  const content = `<!-- tokenmaxxer project memory header — auto-generated, do not edit -->
# Project: ${mem.project_path}
Last session: ${mem.last_updated} (git SHA ${mem.last_git_sha ?? "unknown"})
Current task: ${mem.current_task ?? "—"}
This project has accumulated memory. Call the \`get_project_state\` tool to load prior decisions, active files, and next steps before assuming continuity.
`
  await atomicWrite(headerPath, content)
}
