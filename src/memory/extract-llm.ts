/**
 * Structured extraction through the client supplied to the plugin.
 *
 * The client is deliberately used lazily: config discovery and all session
 * requests are made only from the session.idle path.
 */
import type { ExtractedFacts } from "../types"
import {
  ExtractedFactsJsonSchema,
  validateStructuredResult,
} from "./extract-schema"
import {
  LLMExtractionCacheEntrySchema,
  type AuditTerminalOutcome,
  type LLMAuditMetadata,
  type LLMExtractionCacheEntry,
  type MemoryFile,
  MAX_MODEL_HEALTH_RECORDS,
} from "./schema"
import type { EvidenceKind, Evidence } from "./schema"
import type { CanonicalExtractionInput } from "./extract-prompt"
import { buildExtractionPrompt, makeExtractionCacheKey } from "./extract-prompt"
import { readMemory } from "./store"
import {
  createAuditSession,
  getHostStructuredContractGate,
  requestStructuredOutput,
  type LLMAdapterError,
} from "./llm-adapter"
import {
  hasVariant,
  isEligibleAutomaticModel,
  normalizeProviderInventory,
  type NormalizedProviderInventory,
  type NormalizedProviderModel,
} from "./provider-inventory"
import type { ModelHealthOutcome, MemoryFile as HealthMemoryFile } from "./schema"
import { log } from "../util/log"

export interface SmallModel {
  providerID: string
  modelID: string
  variant?: string
}

export interface LLMExtractionConfig {
  enabled: boolean
  model?: SmallModel
  /** A bounded, non-secret explanation when extraction is disabled. */
  reason?: string
}

export type LLMModelSelection = "explicit" | "automatic"

export type LLMModelResolutionStatus = {
  candidate_count: number
  selected_provider?: string
  selected_model?: string
  selection: LLMModelSelection | "none"
  variant?: string
  reason?: string
}

export type LLMHealthOutcomeReport = {
  providerID: string
  modelID: string
  outcome: ModelHealthOutcome
  reason: string
}

export const MODEL_HEALTH_MAX_RECORDS = MAX_MODEL_HEALTH_RECORDS
export const MODEL_HEALTH_BASE_COOLDOWN_MS = 30_000
export const MODEL_HEALTH_MAX_COOLDOWN_MS = 15 * 60_000

/** Return the local health row for one exact provider/model identity. */
export function getModelHealth(
  memory: Pick<HealthMemoryFile, "model_health"> | null | undefined,
  model: { providerID: string; modelID: string },
) {
  const providerID = model.providerID.slice(0, 256)
  const modelID = model.modelID.slice(0, 256)
  return memory?.model_health?.find((health) => (
    health.provider_id === providerID && health.model_id === modelID
  ))
}

/**
 * Upsert one bounded outcome.  This is called only after a retained audit has
 * made a real prompt attempt; cache hits intentionally do not touch health.
 */
export function upsertModelHealth(
  memory: HealthMemoryFile,
  report: LLMHealthOutcomeReport,
  now = Date.now(),
): HealthMemoryFile {
  const providerID = report.providerID.slice(0, 256)
  const modelID = report.modelID.slice(0, 256)
  const current = getModelHealth(memory, { providerID, modelID })
  const success = report.outcome === "success"
  const failureStreak = success
    ? 0
    : Math.min(32, (current?.failure_streak ?? 0) + 1)
  const cooldownUntil = success
    ? undefined
    : new Date(now + Math.min(
        MODEL_HEALTH_MAX_COOLDOWN_MS,
        MODEL_HEALTH_BASE_COOLDOWN_MS * (2 ** Math.max(0, failureStreak - 1)),
      )).toISOString()
  const next = {
    provider_id: providerID,
    model_id: modelID,
    last_outcome: report.outcome,
    failure_streak: failureStreak,
    last_outcome_at: new Date(now).toISOString(),
    ...(cooldownUntil ? { cooldown_until: cooldownUntil } : {}),
    ...(!success && report.reason ? { failure_reason: report.reason.slice(0, 128) } : {}),
  }
  const records = (memory.model_health ?? [])
    .filter((health) => !(health.provider_id === providerID && health.model_id === modelID))
  return {
    ...memory,
    model_health: [...records, next].slice(-MODEL_HEALTH_MAX_RECORDS),
  }
}

export interface SanitizedError {
  name: string
  message: string
}

const MAX_DIAGNOSTIC_TEXT = 200

/** Prompt requests are bounded so a detached idle event cannot hang forever. */
export const LLM_REQUEST_TIMEOUT_MS = 120_000

let lastModelResolution: LLMModelResolutionStatus = {
  candidate_count: 0,
  selection: "none",
}

export function getLastLLMModelResolution(): LLMModelResolutionStatus {
  return { ...lastModelResolution }
}

/** Keep diagnostics bounded and limited to an error's name and message. */
export function sanitizeError(error: unknown): SanitizedError {
  const bounded = (value: unknown, fallback: string): string => {
    if (typeof value !== "string" || value.length === 0) return fallback
    return value.slice(0, MAX_DIAGNOSTIC_TEXT)
  }

  if (error instanceof Error) {
    return {
      name: bounded(error.name, "Error"),
      message: bounded(error.message, "Unknown error"),
    }
  }

  if (typeof error === "string") {
    return { name: "Error", message: bounded(error, "Unknown error") }
  }

  if (isRecord(error)) {
    return {
      name: bounded(error.name, "Error"),
      message: bounded(error.message, "Unknown error"),
    }
  }

  return { name: "Error", message: "Unknown error" }
}

// Retained extraction sessions emit their own session.idle event. Keep their
// IDs for the lifetime of this plugin process so the event handler can ignore
// those audit sessions instead of recursively extracting them.
const retainedExtractionSessionIDs = new Set<string>()
export const MAX_RETAINED_EXTRACTION_SESSION_IDS = 256

function retainExtractionSession(sessionID: string): void {
  retainedExtractionSessionIDs.add(sessionID)
  while (retainedExtractionSessionIDs.size > MAX_RETAINED_EXTRACTION_SESSION_IDS) {
    const oldest = retainedExtractionSessionIDs.values().next()
    if (oldest.done) break
    retainedExtractionSessionIDs.delete(oldest.value)
  }
}

/** Test/process lifecycle reset; durable audit metadata is unaffected. */
export function resetRetainedExtractionSessionIDs(): void {
  retainedExtractionSessionIDs.clear()
}

/** One extraction transaction per project/source, including direct callers. */
const extractionInFlight = new Map<string, Promise<ExtractedFacts | null>>()

let evidenceAcceptedCount = 0
let evidenceRejectedCount = 0

/** Whether an idle event belongs to a session created for LLM extraction. */
export function isRetainedExtractionSession(sessionID: string): boolean {
  return retainedExtractionSessionIDs.has(sessionID)
}

/** Check the durable v2 audit guard used after a plugin/module reload. */
export async function isPersistedRetainedExtractionSession(args: {
  sessionID: string
  worktree: string
  directory: string
}): Promise<boolean> {
  try {
    const memory = await readMemory({ worktree: args.worktree, directory: args.directory })
    return (memory?.llm_extraction_audits ?? []).some(
      (audit) => audit.audit_session_id === args.sessionID,
    )
  } catch {
    return false
  }
}

/** Bounded process-local evidence counters for the status tool. */
export function getLLMEvidenceStats(): {
  accepted: number
  rejected: number
} {
  return {
    accepted: evidenceAcceptedCount,
    rejected: evidenceRejectedCount,
  }
}

/** The small model is provider/model, with the first slash as separator. */
export function parseSmallModel(smallModel: string | undefined): SmallModel | undefined {
  if (typeof smallModel !== "string") return undefined

  const value = smallModel.trim()
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return undefined

  const providerID = value.slice(0, separator).trim()
  const modelID = value.slice(separator + 1).trim()
  if (!providerID || !modelID || /\s/.test(providerID) || /\s/.test(modelID)) return undefined
  return { providerID, modelID }
}

type V1ClientLike = {
  config?: {
    get: (parameters: { query: { directory: string } }) => Promise<unknown>
  }
  provider?: {
    list: (parameters: { query: { directory: string } }) => Promise<unknown>
  }
  session?: {
    create: (parameters: unknown) => Promise<unknown>
    prompt: (parameters: unknown) => Promise<unknown>
  }
}

type ConfiguredModelResolution = {
  model?: SmallModel
  reason?: string
}

type ModelDiscoveryResult = {
  model?: SmallModel
  reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isModelCoolingDown(
  memory: HealthMemoryFile | null | undefined,
  model: SmallModel | NormalizedProviderModel | undefined,
  now = Date.now(),
): boolean {
  if (!memory || !model) return false
  const providerID = ("providerID" in model ? model.providerID : model.provider).slice(0, 256)
  const modelID = ("modelID" in model ? model.modelID : model.model).slice(0, 256)
  const health = memory.model_health?.find((candidate) => (
    candidate.provider_id === providerID && candidate.model_id === modelID
  ))
  if (!health?.cooldown_until) return false
  const until = Date.parse(health.cooldown_until)
  return Number.isFinite(until) && until > now
}

function reportInventoryDiagnostics(
  client: unknown,
  inventory: NormalizedProviderInventory,
): void {
  if (!inventory?.diagnostics.length) return
  void log(client, "debug", "provider_inventory_shape_drift", {
    adapter: "v1-provider-inventory",
    diagnostics: inventory.diagnostics.slice(0, 16),
  })
}

function readConfiguredModel(result: unknown): SmallModel | undefined {
  if (!isRecord(result) || result.error != null || !isRecord(result.data)) return undefined

  const smallModel = result.data.small_model
  return parseSmallModel(typeof smallModel === "string" ? smallModel : undefined)
}

async function resolveConfiguredModelVariant(
  client: V1ClientLike,
  directory: string,
  model: SmallModel,
  allowUnavailable = false,
): Promise<ConfiguredModelResolution> {
  if (!client.provider?.list) return { model }

  try {
    const inventory = normalizeProviderInventory(
      await client.provider.list({ query: { directory } }),
    )
    reportInventoryDiagnostics(client, inventory)
    if (inventory.providers.length === 0) {
      return allowUnavailable
        ? { model }
        : { reason: "model inventory response is malformed" }
    }

    const provider = inventory.providers.find((candidate) => candidate.provider === model.providerID)
    if (!provider) return allowUnavailable ? { model } : { reason: "provider is not available" }
    if (!provider.connected) {
      return allowUnavailable ? { model } : { reason: "provider is not connected" }
    }

    const inventoryModel = provider.models.find((candidate) => candidate.model === model.modelID)
    if (!inventoryModel) return allowUnavailable ? { model } : { reason: "model is not available" }
    return {
      model: hasVariant(inventoryModel, "none") ? { ...model, variant: "none" } : model,
    }
  } catch {
    // An explicit model remains valid when optional inventory lookup fails.
    return { model }
  }
}

/**
 * Find the first eligible model in provider order, then model object order.
 * No local ranking or paid-model fallback is applied.
 */
async function discoverFreeSmallModel(
  client: V1ClientLike,
  directory: string,
  memory?: HealthMemoryFile | null,
): Promise<ModelDiscoveryResult> {
  if (!client.provider?.list) return { reason: "model inventory is unavailable" }

  try {
    const inventory = normalizeProviderInventory(
      await client.provider.list({ query: { directory } }),
    )
    reportInventoryDiagnostics(client, inventory)
    if (inventory.providers.length === 0) {
      return { reason: "model inventory response is malformed" }
    }

    let firstEligible: SmallModel | undefined
    const eligible = inventory.models.filter(isEligibleAutomaticModel)
    const healthyEligible = eligible.filter((candidate) => !isModelCoolingDown(memory, candidate))
    lastModelResolution = {
      candidate_count: eligible.length,
      selection: "none",
    }
    for (const candidate of healthyEligible) {
      const selected = {
        providerID: candidate.provider,
        modelID: candidate.model,
        ...(hasVariant(candidate, "none") ? { variant: "none" } : {}),
      }
      if (selected.variant === "none") {
        return { model: selected, reason: "eligible model discovered" }
      }
      firstEligible ??= selected
    }

    if (firstEligible) {
      return { model: firstEligible, reason: "eligible model discovered" }
    }
    if (eligible.length > 0 && healthyEligible.length === 0) {
      const cooled = eligible[0]
      if (cooled) {
        lastModelResolution = {
          candidate_count: eligible.length,
          selected_provider: cooled.provider,
          selected_model: cooled.model,
          selection: "automatic",
          ...(hasVariant(cooled, "none") ? { variant: "none" } : {}),
          reason: "all eligible models are on cooldown",
        }
      }
      return { reason: "all eligible models are on cooldown" }
    }
    return {
      reason: inventory.connected_provider_ids !== undefined
        ? "no connected provider has a suitable free tool model"
        : "no eligible free model found",
    }
  } catch {
    // Discovery is optional. A failed request leaves heuristic persistence as
    // the only fallback.
    return { reason: "model inventory request failed" }
  }
}

/** Resolve the opt-in model. This function is only called by session.idle. */
export async function getLLMConfig(
  clientValue: unknown,
  directory = "",
  options?: {
    /** Used by the writer to gate a model after a real failed extraction. */
    memory?: HealthMemoryFile | null
    /** Resolve a model for an already accepted cache lookup. */
    ignoreHealth?: boolean
  },
): Promise<LLMExtractionConfig> {
  if (process.env.TOKENMAXXER_LLM_EXTRACT !== "1") {
    return { enabled: false, reason: "TOKENMAXXER_LLM_EXTRACT is disabled" }
  }

  if (!options?.ignoreHealth) {
    const hostGate = await getHostStructuredContractGate(clientValue)
    if (!hostGate.allowed) {
      return {
        enabled: false,
        reason: `host structured contract gate: ${hostGate.reason}`,
      }
    }
  }

  const client = (clientValue ?? {}) as V1ClientLike
  let configuredModel: SmallModel | undefined

  if (client.config?.get) {
    try {
      configuredModel = readConfiguredModel(
        await client.config.get({ query: { directory } }),
      )
    } catch {
      // A config read failure is equivalent to an absent/malformed override;
      // try discovery before falling back to heuristics.
    }
  }

  // A syntactically valid explicit override is authoritative for model choice;
  // a valid connected-provider list may still reject an unavailable provider.
  if (configuredModel) {
    const resolved = await resolveConfiguredModelVariant(
      client,
      directory,
      configuredModel,
      options?.ignoreHealth,
    )
    lastModelResolution = {
      candidate_count: 1,
      selected_provider: configuredModel.providerID,
      selected_model: configuredModel.modelID,
      selection: "explicit",
      ...(resolved.model?.variant ? { variant: resolved.model.variant } : {}),
      ...(resolved.reason ? { reason: resolved.reason } : {}),
    }
    if (resolved.reason) return { enabled: false, reason: resolved.reason }
    if (!options?.ignoreHealth && isModelCoolingDown(options?.memory, resolved.model)) {
      lastModelResolution = {
        ...lastModelResolution,
        reason: "configured model is on cooldown",
      }
      return { enabled: false, reason: "configured model is on cooldown" }
    }
    return {
      enabled: true,
      model: resolved.model,
    }
  }

  const discovered = await discoverFreeSmallModel(
    client,
    directory,
    options?.ignoreHealth ? null : options?.memory,
  )
  if (discovered.model) {
    lastModelResolution = {
      ...lastModelResolution,
      selected_provider: discovered.model.providerID,
      selected_model: discovered.model.modelID,
      selection: "automatic",
      ...(discovered.model.variant ? { variant: discovered.model.variant } : {}),
    }
  } else {
    lastModelResolution = {
      ...lastModelResolution,
      selection: "none",
      reason: discovered.reason,
    }
  }
  return discovered.model
    ? { enabled: true, model: discovered.model }
    : { enabled: false, reason: discovered.reason }
}

export type LLMExtractionDiagnostic =
  | {
      kind: "unavailable-client"
      reason: "missing-session-endpoint"
    }
  | {
      kind: "session-create-failed"
      reason: "request-error" | "error-response" | "malformed-response"
      error?: SanitizedError
    }
  | {
      kind: "structured-output-failed"
      attempt: number
      reason:
        | "request-error"
        | "error-response"
        | "malformed-response"
        | "response-shape-drift"
        | "invalid-structured-output"
      error?: SanitizedError
    }
  | {
      kind: "retries-exhausted"
      attempts: number
    }
  | {
      kind: "audit-registration-failed"
    }
  | {
      kind: "evidence-rejected"
      reason:
        | "missing-evidence"
        | "unknown-reference"
        | "digest-mismatch"
        | "invalid-candidate"
      evidence_count: number
      candidate_count: number
    }

export type EvidenceRejectionReason =
  | "missing-evidence"
  | "unknown-reference"
  | "digest-mismatch"
  | "invalid-candidate"

export type LLMExtractionDiagnosticCallback = (
  diagnostic: LLMExtractionDiagnostic,
) => void | Promise<void>

function adapterFailureReason(
  error: LLMAdapterError,
  stage: "session-create" | "structured-prompt",
): "request-error" | "error-response" | "malformed-response" | "response-shape-drift" {
  if (error.code === "request-error") return "request-error"
  if (error.code === "error-response") return "error-response"
  if (stage === "structured-prompt") {
    return "response-shape-drift"
  }
  return "malformed-response"
}

function adapterFailureError(error: LLMAdapterError): SanitizedError | undefined {
  return error.errorMetadata
}

export type AuditCreatedCallback = (
  audit: LLMAuditMetadata,
) => boolean | void | Promise<boolean | void>

export type AuditTerminalCallback = (
  auditSessionID: string,
  outcome: Exclude<AuditTerminalOutcome, "pending">,
) => void | Promise<void>

export interface ExtractFactsLLMOptions {
  /** Project directory required by every v1 request. */
  directory?: string
  /** Stable resolved project key for process-local in-flight coalescing. */
  projectKey?: string
  /** A validated cache result, checked before creating an audit session. */
  cachedFacts?: ExtractedFacts | null
  /**
   * Ephemeral deterministic evidence candidates.  Candidate text is accepted
   * here only so the caller can corroborate the current transcript; it is
   * never returned, logged, or persisted by this module.
   */
  evidenceCandidateMap?: EvidenceCandidateMap
  /** Digest-only view of the same candidate map, used to detect drift. */
  evidenceDigestMap?: Readonly<Record<string, string>>
  /** Compatibility aliases for callers that use the shorter names. */
  evidenceCandidates?: EvidenceCandidateMap
  evidenceDigests?: Readonly<Record<string, string>>
  /** Optional best-effort callback for bounded extraction diagnostics. */
  onDiagnostic?: LLMExtractionDiagnosticCallback
  /** Persist the guard before the first audit prompt. Returning false aborts. */
  onAuditCreated?: AuditCreatedCallback
  /** Persist the terminal state after structured extraction completes. */
  onAuditTerminal?: AuditTerminalCallback
  /** Persist one outcome for the retained provider/model attempt. */
  onHealthOutcome?: (report: LLMHealthOutcomeReport) => void | Promise<void>
  /** Test-only/lifecycle override; production remains bounded at two minutes. */
  requestTimeoutMs?: number
}

/** A bounded candidate at the LLM corroboration boundary. */
export type EvidenceCandidate = {
  kind: EvidenceKind
  ref: string
  digest: string
  /** Optional source material is ephemeral and is not used for persistence. */
  text?: string
  role?: string
}

export type EvidenceCandidateMap = Readonly<Record<string, EvidenceCandidate>>

/** Diagnostics must never change extraction behavior, even if a callback fails. */
function emitDiagnostic(
  callback: LLMExtractionDiagnosticCallback | undefined,
  diagnostic: LLMExtractionDiagnostic,
): void {
  if (!callback) return

  try {
    Promise.resolve(callback(diagnostic)).catch(() => {
      // Diagnostics are best effort.
    })
  } catch {
    // Diagnostics are best effort.
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
}

function candidateContext(options: ExtractFactsLLMOptions | undefined): {
  candidates: EvidenceCandidateMap
  digests: Readonly<Record<string, string>>
} {
  const candidates = options?.evidenceCandidateMap ?? options?.evidenceCandidates ?? {}
  const digests = options?.evidenceDigestMap ?? options?.evidenceDigests ?? {}
  return { candidates, digests }
}

/**
 * Resolve structured evidence references to the exact ephemeral candidates
 * supplied for this source transcript.  Only the reference and digest leave
 * this boundary.
 */
export function resolveEvidenceReferences(
  refs: unknown,
  options?: Pick<ExtractFactsLLMOptions, "evidenceCandidateMap" | "evidenceDigestMap" | "evidenceCandidates" | "evidenceDigests">,
): { evidence: Evidence[]; reason?: EvidenceRejectionReason } {
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 3) {
    return { evidence: [], reason: "missing-evidence" }
  }
  if (!refs.every((ref): ref is string => typeof ref === "string" && ref.length > 0 && ref.length <= 128)) {
    return { evidence: [], reason: "unknown-reference" }
  }
  if (new Set(refs).size !== refs.length) {
    return { evidence: [], reason: "invalid-candidate" }
  }

  const { candidates, digests } = candidateContext(options)
  const evidence: Evidence[] = []
  for (const ref of refs) {
    const candidate = candidates[ref]
    if (!candidate || candidate.ref !== ref) {
      return { evidence: [], reason: "unknown-reference" }
    }
    if (
      (candidate.kind !== "transcript" && candidate.kind !== "heuristic-candidate") ||
      !isSha256(candidate.digest)
    ) {
      return { evidence: [], reason: "invalid-candidate" }
    }
    const expectedDigest = digests[ref]
    if (expectedDigest !== undefined && expectedDigest !== candidate.digest) {
      return { evidence: [], reason: "digest-mismatch" }
    }
    evidence.push({
      kind: candidate.kind,
      ref,
      digest: candidate.digest,
    })
  }
  return { evidence }
}

/**
 * Validate every LLM decision and drop only decisions that fail evidence
 * corroboration.  A result containing decisions but no accepted decisions is
 * rejected as a whole, so it cannot create a cache row without proof.
 */
export function corroborateLLMFacts(
  facts: ExtractedFacts,
  options?: Pick<ExtractFactsLLMOptions, "evidenceCandidateMap" | "evidenceDigestMap" | "evidenceCandidates" | "evidenceDigests" | "onDiagnostic">,
): ExtractedFacts | null {
  const decisions = facts.decisions as Array<{ evidence_refs?: unknown } & Record<string, unknown>>
  if (decisions.length === 0) return facts

  const accepted: typeof decisions = []
  for (const decision of decisions) {
    const resolved = resolveEvidenceReferences(decision.evidence_refs, options)
    if (resolved.reason) {
      evidenceRejectedCount = Math.min(Number.MAX_SAFE_INTEGER, evidenceRejectedCount + 1)
      emitDiagnostic(options?.onDiagnostic, {
        kind: "evidence-rejected",
        reason: resolved.reason,
        evidence_count: Array.isArray(decision.evidence_refs)
          ? Math.min(decision.evidence_refs.length, 3)
          : 0,
        candidate_count: Math.min(
          Object.keys(candidateContext(options).candidates).length,
          128,
        ),
      })
      continue
    }
    evidenceAcceptedCount = Math.min(Number.MAX_SAFE_INTEGER, evidenceAcceptedCount + 1)
    accepted.push(decision)
  }

  if (accepted.length === 0) return null
  return {
    ...facts,
    decisions: accepted as ExtractedFacts["decisions"],
  }
}

/** Surface the evidence-specific reason when the outer structured shape fails. */
function reportUnvalidatedEvidenceFailures(
  structured: unknown,
  options?: Pick<ExtractFactsLLMOptions, "evidenceCandidateMap" | "evidenceDigestMap" | "evidenceCandidates" | "evidenceDigests" | "onDiagnostic">,
): void {
  if (!isRecord(structured) || !Array.isArray(structured.decisions)) return
  for (const decision of structured.decisions) {
    if (!isRecord(decision)) continue
    const resolved = resolveEvidenceReferences(decision.evidence_refs, options)
    if (!resolved.reason) continue
    evidenceRejectedCount = Math.min(Number.MAX_SAFE_INTEGER, evidenceRejectedCount + 1)
    emitDiagnostic(options?.onDiagnostic, {
      kind: "evidence-rejected",
      reason: resolved.reason,
      evidence_count: Array.isArray(decision.evidence_refs)
        ? Math.min(decision.evidence_refs.length, 3)
        : 0,
      candidate_count: Math.min(
        Object.keys(candidateContext(options).candidates).length,
        128,
      ),
    })
  }
}

function isTimeoutError(error: unknown): boolean {
  if (isRecord(error) && (error.name === "TimeoutError" || error.code === "ETIMEDOUT")) return true
  return error instanceof Error && /timed? ?out|timeout/i.test(error.message)
}

function adapterHealthOutcome(error: LLMAdapterError): ModelHealthOutcome {
  if (error.errorMetadata && isTimeoutError(error.errorMetadata)) return "timeout"
  if (error.code === "response-shape-drift" || error.code === "structured-output-drift") {
    return "structured-shape-failure"
  }
  return "transport-auth-failure"
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("structured request timed out")
          error.name = "TimeoutError"
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function notifyHealthOutcome(
  callback: ExtractFactsLLMOptions["onHealthOutcome"],
  report: LLMHealthOutcomeReport,
): Promise<void> {
  if (!callback) return
  try {
    await callback(report)
  } catch {
    // Health persistence is diagnostic metadata and must not change fallback.
  }
}

/**
 * Extract facts through one retained audit session. Prompt errors and invalid
 * structured values share exactly one retry budget.
 */
export async function extractFactsLLM(
  canonicalInput: CanonicalExtractionInput,
  sourceSessionID: string,
  projectName: string,
  clientValue: unknown,
  config: LLMExtractionConfig,
  options?: ExtractFactsLLMOptions,
): Promise<ExtractedFacts | null> {
  if (!config.enabled || !config.model) return null
  if (options?.cachedFacts) return options.cachedFacts

  const projectKey = options?.projectKey ?? options?.directory ?? projectName
  const inFlightKey = `${projectKey}\u0000${sourceSessionID}`
  const existing = extractionInFlight.get(inFlightKey)
  if (existing) return existing

  let promise!: Promise<ExtractedFacts | null>
  promise = (async () => {
    try {
      return await extractFactsLLMOnce(
        canonicalInput,
        sourceSessionID,
        projectName,
        clientValue,
        config,
        options,
      )
    } finally {
      if (extractionInFlight.get(inFlightKey) === promise) {
        extractionInFlight.delete(inFlightKey)
      }
    }
  })()
  extractionInFlight.set(inFlightKey, promise)
  return promise
}

async function extractFactsLLMOnce(
  canonicalInput: CanonicalExtractionInput,
  sourceSessionID: string,
  projectName: string,
  clientValue: unknown,
  config: LLMExtractionConfig,
  options?: ExtractFactsLLMOptions,
): Promise<ExtractedFacts | null> {

  if (!config.enabled || !config.model) return null

  const client = (clientValue ?? {}) as V1ClientLike
  if (!client.session?.create || !client.session.prompt) {
    emitDiagnostic(options?.onDiagnostic, {
      kind: "unavailable-client",
      reason: "missing-session-endpoint",
    })
    return null
  }

  let extractionSessionID: string | undefined
  try {
    const created = await withTimeout(
      createAuditSession(client, {
        directory: options?.directory ?? "",
        title: `tokenmaxxer extract · ${projectName} · ${sourceSessionID.slice(-8)}`,
        sourceSessionID,
      }),
      options?.requestTimeoutMs ?? LLM_REQUEST_TIMEOUT_MS,
    )
    if (!created.ok) {
      const reason = adapterFailureReason(created.error, "session-create")
      emitDiagnostic(options?.onDiagnostic, {
        kind: "session-create-failed",
        reason: reason === "response-shape-drift" ? "malformed-response" : reason,
        ...(adapterFailureError(created.error)
          ? { error: adapterFailureError(created.error) }
          : {}),
      })
      return null
    }
    extractionSessionID = created.value
    // Register before the first prompt so the audit session's idle event can
    // never re-enter extraction.
    retainExtractionSession(extractionSessionID)

    const audit: LLMAuditMetadata = {
      audit_session_id: extractionSessionID,
      source_session_id: sourceSessionID,
      cache_key: makeExtractionCacheKey(
        sourceSessionID,
        canonicalInput.sha256,
        config.model,
      ),
      provider_id: config.model.providerID,
      model_id: config.model.modelID,
      created_at: new Date().toISOString(),
      terminal_outcome: "pending",
    }

    if (options?.onAuditCreated) {
      try {
        const persisted = await options.onAuditCreated(audit)
        if (persisted === false) {
          emitDiagnostic(options.onDiagnostic, { kind: "audit-registration-failed" })
          return null
        }
      } catch {
        emitDiagnostic(options.onDiagnostic, { kind: "audit-registration-failed" })
        return null
      }
    }
  } catch (error) {
    emitDiagnostic(options?.onDiagnostic, {
      kind: "session-create-failed",
      reason: "request-error",
      error: sanitizeError(error),
    })
    return null
  }

  let terminalOutcome: ModelHealthOutcome = "transport-auth-failure"
  let terminalReason = "request-error"
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await withTimeout(
        requestStructuredOutput(client, {
          sessionID: extractionSessionID,
          directory: options?.directory ?? "",
          model: {
            providerID: config.model.providerID,
            modelID: config.model.modelID,
          },
          prompt: buildExtractionPrompt(canonicalInput),
          schema: ExtractedFactsJsonSchema,
          ...(config.model.variant !== undefined ? { variant: config.model.variant } : {}),
        }),
        options?.requestTimeoutMs ?? LLM_REQUEST_TIMEOUT_MS,
      )

      if (!result.ok) {
        terminalOutcome = adapterHealthOutcome(result.error)
        terminalReason = terminalOutcome === "timeout" ? "timeout" : result.error.code
        emitDiagnostic(options?.onDiagnostic, {
          kind: "structured-output-failed",
          attempt: attempt + 1,
          reason: adapterFailureReason(result.error, "structured-prompt"),
          ...(adapterFailureError(result.error)
            ? { error: adapterFailureError(result.error) }
            : {}),
        })
        continue
      }

      // Structured output is the only response value that is inspected. In
      // particular, assistant text and free-form JSON are never fallbacks.
      const structured = result.value
      const facts = validateStructuredResult(structured)
      if (facts) {
        const corroborated = corroborateLLMFacts(facts, options)
        if (corroborated) {
          await notifyAuditTerminal(options?.onAuditTerminal, extractionSessionID, "success")
          await notifyHealthOutcome(options?.onHealthOutcome, {
            providerID: config.model.providerID,
            modelID: config.model.modelID,
            outcome: "success",
            reason: "accepted-extraction",
          })
          return corroborated
        }
        terminalOutcome = "validation-failure"
        terminalReason = "evidence-rejection"
        emitDiagnostic(options?.onDiagnostic, {
          kind: "structured-output-failed",
          attempt: attempt + 1,
          reason: "invalid-structured-output",
        })
        continue
      }
      reportUnvalidatedEvidenceFailures(structured, options)
      terminalOutcome = "validation-failure"
      terminalReason = "structured-validation-failure"
      emitDiagnostic(options?.onDiagnostic, {
        kind: "structured-output-failed",
        attempt: attempt + 1,
        reason: structured === undefined
          ? "malformed-response"
          : "invalid-structured-output",
      })
    } catch (error) {
      terminalOutcome = isTimeoutError(error) ? "timeout" : "transport-auth-failure"
      terminalReason = isTimeoutError(error) ? "timeout" : "request-error"
      emitDiagnostic(options?.onDiagnostic, {
        kind: "structured-output-failed",
        attempt: attempt + 1,
        reason: "request-error",
        error: sanitizeError(error),
      })
      // Thrown request errors, including StructuredOutputError, use the same
      // one-retry budget as an SDK error field or invalid structured output.
    }
  }

  emitDiagnostic(options?.onDiagnostic, { kind: "retries-exhausted", attempts: 2 })
  await notifyAuditTerminal(options?.onAuditTerminal, extractionSessionID, "failed")
  await notifyHealthOutcome(options?.onHealthOutcome, {
    providerID: config.model.providerID,
    modelID: config.model.modelID,
    outcome: terminalOutcome,
    reason: terminalReason,
  })
  return null
}

async function notifyAuditTerminal(
  callback: AuditTerminalCallback | undefined,
  auditSessionID: string,
  outcome: Exclude<AuditTerminalOutcome, "pending">,
): Promise<void> {
  if (!callback) return
  try {
    await callback(auditSessionID, outcome)
  } catch {
    // Terminal persistence is best effort and must not alter extraction.
  }
}

type CacheEvidenceOptions = Pick<ExtractFactsLLMOptions, "evidenceCandidateMap" | "evidenceDigestMap" | "evidenceCandidates" | "evidenceDigests">

function hasEvidenceBackedProvenance(
  entry: LLMExtractionCacheEntry,
  options?: CacheEvidenceOptions,
): boolean {
  const provenance = entry.provenance
  if (
    !provenance ||
    provenance.extractor !== "llm" ||
    provenance.confidence !== "llm-corroborated" ||
    !provenance.source_audit_session_id ||
    provenance.evidence.length === 0
  ) return false

  const evidenceByRef = new Map(provenance.evidence.map((evidence) => [evidence.ref, evidence]))
  for (const decision of entry.facts.decisions as Array<{ evidence_refs?: unknown }>) {
    if (!Array.isArray(decision.evidence_refs) || decision.evidence_refs.length < 1) return false
    for (const ref of decision.evidence_refs) {
      const evidence = evidenceByRef.get(ref)
      if (!evidence) return false
    }
  }

  if (!options) return true
  const { candidates, digests } = candidateContext(options)
  return provenance.evidence.every((evidence) => {
    const candidate = candidates[evidence.ref]
    return Boolean(
      candidate &&
        candidate.ref === evidence.ref &&
        candidate.kind === evidence.kind &&
        candidate.digest === evidence.digest &&
        (digests[evidence.ref] === undefined || digests[evidence.ref] === evidence.digest),
    )
  })
}

/** Return a validated cache entry for a key, or null for a stale/malformed row. */
export function readExtractionCacheEntry(
  memory: Pick<MemoryFile, "llm_extraction_cache"> | null | undefined,
  cacheKey: string,
  options?: CacheEvidenceOptions,
): LLMExtractionCacheEntry | null {
  for (const candidate of [...(memory?.llm_extraction_cache ?? [])].reverse()) {
    const parsed = LLMExtractionCacheEntrySchema.safeParse(candidate)
    if (
      parsed.success &&
      parsed.data.cache_key === cacheKey &&
      hasEvidenceBackedProvenance(parsed.data, options)
    ) return parsed.data
  }
  return null
}

/** Return validated facts for a cache key, or null for a stale/malformed entry. */
export function readExtractionCache(
  memory: Pick<MemoryFile, "llm_extraction_cache"> | null | undefined,
  cacheKey: string,
  options?: CacheEvidenceOptions,
): ExtractedFacts | null {
  return readExtractionCacheEntry(memory, cacheKey, options)?.facts ?? null
}

/** Build a validated cache entry for a successful extraction. */
export function makeExtractionCacheEntry(args: {
  sourceSessionID: string
  canonicalInput: CanonicalExtractionInput
  model: SmallModel
  facts: ExtractedFacts
  auditSessionID?: string
  evidence?: Evidence[]
  provenance?: LLMExtractionCacheEntry["provenance"]
  completedAt?: string
}): LLMExtractionCacheEntry {
  const provenance = args.provenance ?? (
    args.auditSessionID && args.evidence && args.evidence.length > 0
      ? {
          extractor: "llm" as const,
          source_session_id: args.sourceSessionID,
          source_audit_session_id: args.auditSessionID,
          confidence: "llm-corroborated" as const,
          evidence: args.evidence.slice(0, 3),
        }
      : undefined
  )
  return {
    cache_key: makeExtractionCacheKey(
      args.sourceSessionID,
      args.canonicalInput.sha256,
      args.model,
    ),
    source_session_id: args.sourceSessionID,
    canonical_input_sha256: args.canonicalInput.sha256,
    provider_id: args.model.providerID,
    model_id: args.model.modelID,
    completed_at: args.completedAt ?? new Date().toISOString(),
    ...(provenance ? { provenance } : {}),
    facts: args.facts,
  }
}

/** Upsert a successful entry while preserving newest-first cache recency. */
export function upsertExtractionCache(
  memory: MemoryFile,
  entry: LLMExtractionCacheEntry,
): MemoryFile {
  const parsed = LLMExtractionCacheEntrySchema.safeParse(entry)
  if (!parsed.success || !hasEvidenceBackedProvenance(parsed.data)) return memory

  const entries = (memory.llm_extraction_cache ?? [])
    .map((candidate) => LLMExtractionCacheEntrySchema.safeParse(candidate))
    .filter((candidate): candidate is { success: true; data: LLMExtractionCacheEntry } => candidate.success)
    .map((candidate) => candidate.data)
    .filter((candidate) => candidate.cache_key !== parsed.data.cache_key)

  return {
    ...memory,
    llm_extraction_cache: [...entries, parsed.data].slice(-10),
  }
}

export function extractionCacheKey(
  sourceSessionID: string,
  canonicalInput: CanonicalExtractionInput,
  model: SmallModel,
): string {
  return makeExtractionCacheKey(sourceSessionID, canonicalInput.sha256, model)
}
