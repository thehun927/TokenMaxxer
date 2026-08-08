/**
 * Memory writer — extracts facts from session transcripts and writes to STATE.json.
 * Triggered on session.idle. Full specification in docs/IMPLEMENTATION.md Appendix A.
 */
import type { MemoryFile, Decision } from "./schema"
import type { ExtractedFacts, TranscriptMessage, TranscriptPart } from "../types"
import { readMemory, writeMemory, emptyMemory, resolveProjectPath } from "./store"
import { getCurrentGitSha } from "../util/git"
import { atomicWrite } from "../util/fs"
import { join } from "node:path"

const TRANSCRIPT_WINDOW = 50

// ─── writeMemoryOnIdle ───────────────────────────────────────────────────────

/**
 * Main entry point called from session.idle event handler.
 * Pulls transcript, extracts facts, merges, prunes, writes, generates header.
 * Never throws — try/catch around everything.
 */
export async function writeMemoryOnIdle(opts: {
  client: unknown
  worktree: string
  directory: string
  sessionId: string
}): Promise<void> {
  try {
    const { client, worktree, directory, sessionId } = opts

    // Fetch session messages
    const c = client as {
      session?: {
        messages: (args: { path: { id: string } }) => Promise<{ data?: TranscriptMessage[] }>
      }
    }
    if (!c.session?.messages) return

    const result = await c.session.messages({ path: { id: sessionId } })
    const allMessages = result.data
    if (!allMessages || allMessages.length === 0) return

    // Cap to last TRANSCRIPT_WINDOW messages
    const messages = allMessages.slice(-TRANSCRIPT_WINDOW)

    // Get git SHA
    const gitSha = await getCurrentGitSha(worktree)

    // Read existing memory or start fresh
    const existing = (await readMemory({ worktree, directory })) ?? emptyMemory(worktree)

    // Extract facts from transcript
    const extracted = extractFactsHeuristic(messages)

    // Mark referenced decisions (scan for recall_decision tool calls)
    markReferencedDecisions(existing, allMessages, sessionId)

    // Merge extracted facts into existing memory
    const merged = mergeMemory(existing, extracted, {
      sessionId,
      gitSha,
      timestamp: new Date().toISOString(),
    })

    // Prune to 8KB cap
    const pruned = pruneOld(merged)

    // Write to disk
    await writeMemory({ worktree, directory }, pruned)

    // Generate HEADER.md
    await generateHeader(worktree, directory, pruned)
  } catch {
    // Never throw from event handler
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
  const firstUser = messages.find((m) => m.info.role === "user")
  if (!firstUser) return null

  const text = getMessageText(firstUser)
  return text.slice(0, 200) || null
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
          fileCounts.set(p, (fileCounts.get(p) ?? 0) + 1)
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

  // Source 1: first user message
  const firstUser = messages.find((m) => m.info.role === "user")
  if (firstUser) {
    allDecisions.push(...scanTextForDecisions(getMessageText(firstUser)))
  }

  // Source 2: all assistant messages
  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      allDecisions.push(...scanTextForDecisions(getMessageText(msg)))
    }
  }

  // Source 3: tool outputs with completed status
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool") {
        const state = (part as { state?: { status?: string } }).state
        if (state && state.status === "completed") {
          const outputText = extractToolOutputText(part)
          if (outputText) {
            allDecisions.push(...scanTextForDecisions(outputText))
          }
        }
      }
    }
  }

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

      // Auto-detect foundational
      const foundational = FOUNDATIONAL_RE.test(trimmedSentence)

      // Decision text: the full sentence, trimmed
      const decision = trimmedSentence

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
    version: 1,
    project_path: existing.project_path,
    last_updated: meta.timestamp,
    last_git_sha: meta.gitSha ?? existing.last_git_sha,
    last_session_id: meta.sessionId,
    current_task,
    active_files,
    decisions: existingDecisions,
    blockers: extracted.blockers,
    next_steps: extracted.next_steps,
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
