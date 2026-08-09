/**
 * Memory writer — extracts facts from session transcripts and writes to STATE.json.
 * Triggered on session.idle. Full specification in docs/IMPLEMENTATION.md Appendix A.
 */
import type { MemoryFile, Decision, AuditTerminalOutcome, LLMAuditMetadata } from "./schema"
import type { ExtractedFacts, TranscriptMessage, TranscriptPart } from "../types"
import { readMemory, writeMemory, emptyMemory, resolveProjectPath } from "./store"
import { enqueueProjectJob, setProjectQueueOutcome } from "./lock"
import { getCurrentGitSha } from "../util/git"
import { atomicWrite } from "../util/fs"
import { basename, join } from "node:path"
import {
  buildCanonicalInput,
} from "./extract-prompt"
import {
  extractFactsLLM,
  extractionCacheKey,
  getLLMConfig,
  makeExtractionCacheEntry,
  readExtractionCache,
  upsertExtractionCache,
  type LLMExtractionDiagnostic,
  type AuditCreatedCallback,
} from "./extract-llm"
import { log } from "../util/log"

const TRANSCRIPT_WINDOW = 50
const MAX_DIAGNOSTIC_VALUE = 200

function boundedDiagnosticValue(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_VALUE
    ? value
    : `${value.slice(0, MAX_DIAGNOSTIC_VALUE - 3)}...`
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
  if ("error" in diagnostic && diagnostic.error) extra.error = diagnostic.error

  // Logging must never delay or change extraction/memory behavior.
  void log(client, level, "llm extraction diagnostic", extra)
}

// ─── writeMemoryOnIdle ───────────────────────────────────────────────────────

export type IdleWriteOutcome =
  | "no-messages"
  | "heuristic-only"
  | "cache-hit"
  | "llm-success"
  | "llm-failed"
  | "queue-failed"

type IdleWriteOptions = {
  client: unknown
  worktree: string
  directory: string
  sessionId: string
}

/**
 * Main entry point called from session.idle.  The queue is deliberately at
 * this public boundary so direct callers cannot accidentally bypass the
 * project/source serialization contract.
 */
export async function writeMemoryOnIdle(opts: IdleWriteOptions): Promise<IdleWriteOutcome> {
  const project = resolveProjectPath(opts.worktree, opts.directory)
  try {
    const outcome = await enqueueProjectJob(
      project,
      opts.sessionId,
      () => writeMemoryOnIdleSerialized(opts),
    )
    setProjectQueueOutcome(project, outcome)
    return outcome
  } catch {
    setProjectQueueOutcome(project, "queue-failed")
    return "queue-failed"
  }
}

/** The serialized transaction; heuristic persistence always precedes LLM work. */
async function writeMemoryOnIdleSerialized(opts: IdleWriteOptions): Promise<IdleWriteOutcome> {
  try {
    const { client, worktree, directory, sessionId } = opts

    const c = client as {
      session?: {
        messages: (args: { path: { id: string } }) => Promise<{ data?: TranscriptMessage[] }>
      }
    }
    if (!c.session?.messages) return "no-messages"

    const result = await c.session.messages({ path: { id: sessionId } })
    const allMessages = result.data
    if (!allMessages || allMessages.length === 0) return "no-messages"

    const messages = allMessages.slice(-TRANSCRIPT_WINDOW)
    const existing = (await readMemory({ worktree, directory })) ?? emptyMemory(worktree)
    // Operational audit guards, like the result cache itself, must not change
    // the identity of the same source transcript on a later idle/reload.
    const canonicalPrior = { ...existing, llm_extraction_audits: undefined }
    const canonicalInput = buildCanonicalInput(messages, canonicalPrior)
    const gitSha = await getCurrentGitSha(worktree)
    const extracted = extractFactsHeuristic(messages)

    markReferencedDecisions(existing, allMessages, sessionId)
    const merged = mergeMemory(existing, extracted, {
      sessionId,
      gitSha,
      timestamp: new Date().toISOString(),
    })
    const pruned = pruneOld(recordRecentSession(merged, sessionId))

    // Durable heuristic fallback. A failed state write cannot justify an
    // un-serialized prompt, so stop before model discovery in that case.
    const heuristicPersisted = await writeMemory({ worktree, directory }, pruned)
    if (heuristicPersisted === false) return "heuristic-only"
    await generateHeader(worktree, directory, pruned)

    if (process.env.TOKENMAXXER_LLM_EXTRACT !== "1") {
      void log(client, "debug", "llm extraction skipped: TOKENMAXXER_LLM_EXTRACT is disabled", {
        reason: "TOKENMAXXER_LLM_EXTRACT is disabled",
      })
      return "heuristic-only"
    }

    const llmConfig = await getLLMConfig(client, directory)
    if (!llmConfig.enabled || !llmConfig.model) {
      void log(client, "info", "llm extraction skipped: model unavailable", {
        reason: boundedDiagnosticValue(llmConfig.reason ?? "model resolution returned no model"),
      })
      return "heuristic-only"
    }
    void log(client, "info", "llm extraction model resolved", {
      provider: boundedDiagnosticValue(llmConfig.model.providerID),
      model: boundedDiagnosticValue(llmConfig.model.modelID),
    })

    // This is the first cache check under the project queue, immediately
    // before any retained audit session or prompt can be created.
    const cacheKey = extractionCacheKey(sessionId, canonicalInput, llmConfig.model)
    const afterHeuristic = (await readMemory({ worktree, directory })) ?? pruned
    const cachedFacts = readExtractionCache(afterHeuristic, cacheKey)
    if (cachedFacts) {
      void log(client, "debug", "llm extraction cache hit")
      await mergeAsyncFacts(opts, cachedFacts, gitSha, sessionId)
      void log(client, "info", "llm extraction facts merged")
      return "cache-hit"
    }

    const project = resolveProjectPath(worktree, directory)
    const projectName = basename(project) || project
    const persistAudit: AuditCreatedCallback = async (audit) => {
      const latest = (await readMemory({ worktree, directory })) ?? afterHeuristic
      const guarded = upsertAuditMetadata(latest, audit)
      return writeMemory({ worktree, directory }, pruneOld(guarded))
    }
    const persistTerminal = async (
      auditSessionID: string,
      outcome: Exclude<AuditTerminalOutcome, "pending">,
    ): Promise<void> => {
      const latest = await readMemory({ worktree, directory })
      if (!latest) return
      const updated = setAuditTerminalOutcome(latest, auditSessionID, outcome)
      await writeMemory({ worktree, directory }, pruneOld(updated))
    }

    void log(client, "debug", "llm extraction audit session requested")
    const llmFacts = await extractFactsLLM(
      canonicalInput,
      sessionId,
      projectName,
      client,
      llmConfig,
      {
        directory,
        projectKey: project,
        onDiagnostic: (diagnostic) => logLLMDiagnostic(client, diagnostic),
        onAuditCreated: persistAudit,
        onAuditTerminal: persistTerminal,
      },
    )
    if (!llmFacts) {
      void log(client, "warn", "llm extraction returned no facts")
      return "llm-failed"
    }

    // Re-read under the same project transaction immediately before the final
    // merge/upsert. A duplicate completion therefore replaces, rather than
    // appends, the same cache identity.
    const latest = (await readMemory({ worktree, directory })) ?? pruned
    const cacheAlreadyCommitted = readExtractionCache(latest, cacheKey)
    if (cacheAlreadyCommitted) {
      await mergeAsyncFacts(opts, cacheAlreadyCommitted, gitSha, sessionId)
      return "cache-hit"
    }

    const timestamp = new Date().toISOString()
    const mergedLLM = mergeMemory(latest, llmFacts, {
      sessionId,
      gitSha,
      timestamp,
    })
    const withCache = upsertExtractionCache(
      recordRecentSession(mergedLLM, sessionId),
      makeExtractionCacheEntry({
        sourceSessionID: sessionId,
        canonicalInput,
        model: llmConfig.model,
        facts: llmFacts,
        completedAt: timestamp,
      }),
    )
    const finalMemory = pruneOld(withCache)
    const committed = await writeMemory({ worktree, directory }, finalMemory)
    if (committed === false) return "llm-failed"
    await generateHeader(worktree, directory, finalMemory)
    void log(client, "info", "llm extraction facts merged")
    return "llm-success"
  } catch {
    // Never throw from event handler or poison later queued source sessions.
    return "heuristic-only"
  }
}

function upsertAuditMetadata(mem: MemoryFile, audit: LLMAuditMetadata): MemoryFile {
  const audits = (mem.llm_extraction_audits ?? [])
    .filter((candidate) => candidate.audit_session_id !== audit.audit_session_id)
  return {
    ...mem,
    llm_extraction_audits: boundedAuditMetadata([...audits, audit]),
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

/** Merge cache/LLM facts against the state that exists at merge time. */
async function mergeAsyncFacts(
  opts: { client: unknown; worktree: string; directory: string; sessionId: string },
  facts: ExtractedFacts,
  gitSha: string | null,
  sessionId: string,
): Promise<void> {
  const latest = (await readMemory({ worktree: opts.worktree, directory: opts.directory }))
    ?? emptyMemory(opts.worktree)
  const merged = mergeMemory(latest, facts, {
    sessionId,
    gitSha,
    timestamp: new Date().toISOString(),
  })
  const finalMemory = pruneOld(recordRecentSession(merged, sessionId))
  await writeMemory({ worktree: opts.worktree, directory: opts.directory }, finalMemory)
  await generateHeader(opts.worktree, opts.directory, finalMemory)
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
      return firstLine.trim().slice(0, 200)
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

  // Sort by frequency desc, take top 5
  const sorted = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)

  return sorted.map(([path, count]) => ({
    path,
    reason: count > 1 ? `edited ${count} times` : "read once",
  }))
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
        topic: d.topic,
        decision: d.decision,
        rationale: d.rationale,
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
        topic: topic.normalized,
        decision: decision.slice(0, 500), // cap decision text length
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
      blockers.push(line.trim().slice(0, 200))
    }
  }

  return blockers
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
      steps.push(trimmed.slice(0, 200))
      continue
    }

    // Keyword lines
    if (/^(next|then|step|todo)[\s:]/i.test(trimmed)) {
      steps.push(trimmed.slice(0, 200))
      continue
    }
  }

  // Cap at 5
  return steps.slice(0, 5)
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

/** Extract text from a tool part's output for decision scanning. */
function extractToolOutputText(part: TranscriptPart): string | null {
  if (part.type !== "tool") return null
  const state = (part as { state?: { output?: string; error?: string } }).state
  if (!state) return null

  // The output field is a string in the real transcript
  if (typeof state.output === "string") return state.output
  if (typeof state.error === "string") return state.error

  return null
}

// ─── markReferencedDecisions ─────────────────────────────────────────────────

/**
 * Scan transcript for recall_decision tool calls and mark all valid decisions
 * as used in this session.
 */
export function markReferencedDecisions(
  mem: MemoryFile,
  messages: TranscriptMessage[],
  sessionId: string,
): void {
  let recalled = false

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "recall_decision") {
        recalled = true
        break
      }
    }
    if (recalled) break
  }

  if (recalled) {
    for (const d of mem.decisions) {
      if (d.still_valid) {
        d.last_used_in_session = sessionId
      }
    }
  }
}

// ─── mergeMemory ─────────────────────────────────────────────────────────────

/**
 * Merge extracted facts into existing memory.
 * Full rules in docs/IMPLEMENTATION.md Appendix A.2.
 */
export function mergeMemory(
  existing: MemoryFile,
  extracted: ExtractedFacts,
  meta: { sessionId: string; gitSha: string | null; timestamp: string },
): MemoryFile {
  // current_task: overwrite if extracted has one, else keep
  const current_task =
    extracted.current_task !== null ? extracted.current_task : existing.current_task

  // active_files: replace list, preserve old reason for files in both if new is generic
  const oldFileMap = new Map(existing.active_files.map((f) => [f.path, f.reason]))
  const active_files = extracted.active_files.map((f) => {
    const oldReason = oldFileMap.get(f.path)
    const isGeneric = f.reason === "read once" || f.reason.startsWith("edited ")
    return {
      path: f.path,
      reason: oldReason && isGeneric ? oldReason : f.reason,
      last_touched: meta.timestamp,
    }
  })

  // decisions: merge with exact topic match (NOT substring)
  const existingDecisions = existing.decisions.map((d) => ({ ...d })) // shallow clone
  const existingTopicMap = new Map<string, number>() // topic → index

  for (let i = 0; i < existingDecisions.length; i++) {
    const normalized = existingDecisions[i].topic.toLowerCase().trim().replace(/\s+/g, " ")
    existingTopicMap.set(normalized, i)
  }

  for (const newDec of extracted.decisions) {
    const normalizedTopic = newDec.topic.toLowerCase().trim().replace(/\s+/g, " ")
    const existingIdx = existingTopicMap.get(normalizedTopic)

    const decision: Decision = {
      id: cryptoRandomUUID(),
      topic: newDec.topic,
      decision: newDec.decision,
      rationale: newDec.rationale,
      timestamp: meta.timestamp,
      git_sha: meta.gitSha ?? undefined,
      session_id: meta.sessionId,
      still_valid: true,
      foundational: newDec.foundational ?? false,
    }

    if (existingIdx !== undefined) {
      // Exact topic match → mark old as invalid, append new
      if (typeof existingDecisions[existingIdx]?.id === "string") {
        existingDecisions[existingIdx]!.still_valid = false
      }
      existingDecisions.push(decision)
    } else {
      // No match → append new
      existingDecisions.push(decision)
    }
  }

  return {
    version: 2,
    project_path: existing.project_path,
    last_updated: meta.timestamp,
    last_git_sha: meta.gitSha ?? existing.last_git_sha,
    last_session_id: meta.sessionId,
    current_task,
    active_files,
    decisions: existingDecisions,
    blockers: extracted.blockers,
    next_steps: extracted.next_steps,
    recent_sessions: existing.recent_sessions ?? [],
    llm_extraction_cache: existing.llm_extraction_cache,
    llm_extraction_audits: existing.llm_extraction_audits,
  }
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

/** Generate a random UUID v4 (crypto-safe). */
function cryptoRandomUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// ─── pruneOld ────────────────────────────────────────────────────────────────

const MAX_BYTES = 8192
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

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

/**
 * Prune a MemoryFile to fit within the 8KB cap.
 * Returns a NEW object (deep clone) — does not mutate input.
 * Full algorithm in docs/IMPLEMENTATION.md Appendix A.3.
 */
export function pruneOld(mem: MemoryFile): MemoryFile {
  // Deep clone (don't mutate input)
  const cloned: MemoryFile = {
    version: mem.version,
    project_path: mem.project_path,
    last_updated: mem.last_updated,
    last_git_sha: mem.last_git_sha,
    last_session_id: mem.last_session_id,
    current_task: mem.current_task,
    active_files: mem.active_files.map((f) => ({ ...f })),
    decisions: mem.decisions.map((d) => ({ ...d })),
    blockers: [...mem.blockers],
    next_steps: [...mem.next_steps],
    recent_sessions: [...(mem.recent_sessions ?? [])],
    llm_extraction_cache: mem.llm_extraction_cache?.map((entry) => ({
      ...entry,
      facts: {
        ...entry.facts,
        active_files: entry.facts.active_files.map((file) => ({ ...file })),
        decisions: entry.facts.decisions.map((decision) => ({ ...decision })),
        blockers: [...entry.facts.blockers],
        next_steps: [...entry.facts.next_steps],
      },
    })),
    llm_extraction_audits: mem.llm_extraction_audits
      ? boundedAuditMetadata(mem.llm_extraction_audits.map((audit) => ({ ...audit })))
      : undefined,
  }

  // Audit metadata is more important than disposable completed history. Drop
  // oldest completed records while the state is oversized, but never discard
  // pending guards before the later state reductions have run.
  while (jsonSize(cloned) > MAX_BYTES && removeOldestCompletedAudit(cloned)) {
    // Re-check after each bounded removal.
  }

  // 1. Check if within cap
  if (jsonSize(cloned) <= MAX_BYTES) return cloned

  // 2. Remove all decisions where still_valid === false
  cloned.decisions = cloned.decisions.filter((d) => d.still_valid)
  if (jsonSize(cloned) <= MAX_BYTES) return cloned

  // 3. Cap active_files at 8 entries (sort by last_touched desc, keep top 8)
  cloned.active_files = [...cloned.active_files]
    .sort((a, b) => b.last_touched.localeCompare(a.last_touched))
    .slice(0, 8)
  if (jsonSize(cloned) <= MAX_BYTES) return cloned

  // 4. Remove decisions older than 30 days
  const now = Date.now()
  cloned.decisions = cloned.decisions.filter((d) => {
    const ts = new Date(d.timestamp).getTime()
    return now - ts < THIRTY_DAYS_MS
  })
  if (jsonSize(cloned) <= MAX_BYTES) return cloned

  // 5. Truncate current_task to 200 chars, reason to 100 chars
  if (cloned.current_task && cloned.current_task.length > 200) {
    cloned.current_task = cloned.current_task.slice(0, 200)
  }
  cloned.active_files = cloned.active_files.map((f) => ({
    ...f,
    reason: f.reason.length > 100 ? f.reason.slice(0, 100) : f.reason,
  }))
  if (jsonSize(cloned) <= MAX_BYTES) return cloned

  // 6. Keep only 10 most recent decisions
  cloned.decisions = [...cloned.decisions]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 10)
  if (jsonSize(cloned) <= MAX_BYTES) {
    console.warn("tokenmaxxer: pruned decisions to 10 most recent to fit 8KB cap")
    return cloned
  }

  // Cache entries are disposable acceleration metadata. Remove the oldest
  // entries before the final durable-state reductions so the existing 8KB
  // invariant also applies after successful LLM extraction.
  while (cloned.llm_extraction_cache?.length && jsonSize(cloned) > MAX_BYTES) {
    cloned.llm_extraction_cache.shift()
  }
  if (jsonSize(cloned) <= MAX_BYTES) return cloned

  // 7. Last resort: keep only current_task + 5 most recent decisions
  cloned.decisions = [...cloned.decisions]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 5)
  cloned.active_files = []
  cloned.blockers = []
  cloned.next_steps = []

  if (jsonSize(cloned) > MAX_BYTES) {
    console.error("tokenmaxxer: STILL over 8KB after all pruning — truncating to current_task + 5 decisions")
  }

  return cloned
}

/** Measure serialized JSON size in bytes. */
function jsonSize(mem: MemoryFile): number {
  return JSON.stringify(mem).length
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
