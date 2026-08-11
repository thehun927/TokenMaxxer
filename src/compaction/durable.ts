/**
 * Builds the durable-state block injected into the compaction prompt.
 *
 * Reads from the per-project memory file via the authoritative
 * `readMemoryState` API so the hook can distinguish missing, unavailable,
 * and valid states.  Applies the M5 bounded policy, compact provenance,
 * git-freshness labels, honest observed-file wording, and per-field
 * render-only character caps.  No total byte budget — PR 8 owns that.
 */

import type { Decision } from "../memory/schema"
import { readMemoryState } from "../memory/store"
import { log } from "../util/log"
import { getCurrentGitSha } from "../util/git"
import { sanitizeDurableValue } from "./sanitize"

// ---------------------------------------------------------------------------
// Delimiters
// ---------------------------------------------------------------------------

const DELIM_OPEN = "<<<TOKENMAXXER_DURABLE_CONTEXT_DATA>>>"
const DELIM_CLOSE = "<<<END_TOKENMAXXER_DURABLE_CONTEXT_DATA>>>"

// ---------------------------------------------------------------------------
// Per-field render-only character caps (§10.4).  These are NOT a PR-8
// total byte budget.  Truncation is applied via sanitizeDurableValue.
// ---------------------------------------------------------------------------

const CAP_PROJECT_PATH = 1024
const CAP_CURRENT_TASK = 600
const CAP_FILE_REASON = 400
const CAP_DECISION_TOPIC = 256
const CAP_DECISION_TEXT = 600
const CAP_BLOCKER = 600
const CAP_NEXT_STEP = 600

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildDurableBlock(opts: {
  worktree: string
  directory: string
  client: unknown
}): Promise<string> {
  try {
    const state = await readMemoryState({
      worktree: opts.worktree,
      directory: opts.directory,
    })

    // Handle non-ok states
    if (state.status === "missing") return "(no prior project memory)"
    if (state.status === "unavailable") return "(memory unavailable)"

    // state.status === "ok"
    const mem = state.memory

    // Resolve current git HEAD best-effort for freshness labels
    const currentHead = await getCurrentGitSha(opts.worktree)

    const lines: string[] = []
    lines.push(DELIM_OPEN)

    // --- Project identity ---
    lines.push(dataLine(`Project: ${sanitizeDurableValue(mem.project_path, CAP_PROJECT_PATH)}`))

    // --- Memory-level freshness ---
    const memFreshness = gitFreshness(mem.last_git_sha ?? null, currentHead)
    lines.push(dataLine(`Memory freshness: ${memFreshness}`))

    // --- Current task ---
    if (mem.current_task) {
      const taskTag = provenanceTagCompact(mem.current_task_provenance)
      lines.push(dataLine(
        `Current task ${taskTag}: ${sanitizeDurableValue(mem.current_task, CAP_CURRENT_TASK)}`,
      ))
    }

    // --- Observed files (bounded to 8 most recently touched) ---
    const activeFiles = [...mem.active_files]
      .sort((a, b) => b.last_touched.localeCompare(a.last_touched))
      .slice(0, 8)

    for (const f of activeFiles) {
      const fileTag = provenanceTagCompact(f.provenance)
      lines.push(dataLine(
        `Observed file ${fileTag}: ${sanitizeDurableValue(f.path, CAP_PROJECT_PATH)} — ${sanitizeDurableValue(f.reason, CAP_FILE_REASON)}`,
      ))
    }

    // --- Decisions (same bounded selection/count policy) ---
    const valid = mem.decisions.filter((d) => d.still_valid)
    const foundational = valid.filter((d) => d.foundational)
    const recentSessions = mem.recent_sessions ?? [
      ...new Set(valid.map((d) => d.last_used_in_session).filter((id): id is string => Boolean(id))),
    ]
    const recent = valid.filter(
      (d) => !d.foundational && isRecentSession(d, recentSessions),
    )
    const older = valid
      .filter((d) => !d.foundational && !isRecentSession(d, recentSessions))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 5)

    // LLM evidence counter — sequential e1, e2, e3 across all rendered LLM decisions
    let llmEvidenceCounter = 0

    // Foundational + recent decisions
    for (const d of [...foundational, ...recent]) {
      lines.push(dataLine(formatDecision(d, currentHead, () => ++llmEvidenceCounter)))
    }

    // Older decisions
    for (const d of older) {
      lines.push(dataLine(formatDecision(d, currentHead, () => ++llmEvidenceCounter)))
    }

    // --- Blockers ---
    for (const b of mem.blockers) {
      lines.push(dataLine(`Blocker: ${sanitizeDurableValue(b, CAP_BLOCKER)}`))
    }

    // --- Next steps ---
    for (const ns of mem.next_steps) {
      lines.push(dataLine(`Next: ${sanitizeDurableValue(ns, CAP_NEXT_STEP)}`))
    }

    lines.push(DELIM_CLOSE)
    return lines.join("\n")
  } catch (e) {
    await log(opts.client, "warn", "buildDurableBlock failed", { error: String(e) })
    return "(memory unavailable)"
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap a single content line with the DATA prefix. */
function dataLine(content: string): string {
  return `DATA ${content}`
}

/**
 * A decision is recent when it was used in one of the last three recorded
 * source sessions.
 */
function isRecentSession(d: Decision, recentSessions: string[]): boolean {
  if (!d.last_used_in_session) return false
  return recentSessions.slice(-3).includes(d.last_used_in_session)
}

// ---------------------------------------------------------------------------
// Compact provenance tags (§10.5)
// ---------------------------------------------------------------------------

/**
 * Return the compact provenance tag for a provenance-like object.
 * Never renders raw source_session_id, audit_session_id, confidence, or
 * evidence counts.
 */
function provenanceTagCompact(provenance?: {
  extractor?: string
}): string {
  if (!provenance) return "[unknown]"
  switch (provenance.extractor) {
    case "human":   return "[human]"
    case "heuristic": return "[heuristic]"
    case "legacy":  return "[legacy]"
    case "llm":     return placeholderLlmTag() // filled in by caller via evidence counter
    default:        return "[unknown]"
  }
}

/** Return a placeholder for LLM evidence — caller replaces with real eN. */
function placeholderLlmTag(): string {
  return "[llm:__E__]"
}

/**
 * Format a single decision line with compact provenance, git freshness,
 * and per-field truncation.
 */
function formatDecision(
  d: Decision,
  currentHead: string | null,
  nextLlmEvidence: () => number,
): string {
  const tagRaw = provenanceTagCompact(d.provenance as { extractor?: string } | undefined)
  // Replace the LLM placeholder with the real sequential evidence number
  const tag = tagRaw === "[llm:__E__]"
    ? `[llm:e${nextLlmEvidence()}]`
    : tagRaw

  const freshness = decisionFreshness(d.git_sha ?? null, currentHead)

  const topic = sanitizeDurableValue(d.topic, CAP_DECISION_TOPIC)
  const decision = sanitizeDurableValue(d.decision, CAP_DECISION_TEXT)

  return `Decision ${tag} freshness=${freshness}: ${topic} => ${decision}`
}

// ---------------------------------------------------------------------------
// Git freshness (§10.6)
// ---------------------------------------------------------------------------

type Freshness = "current-git" | "different-git" | "unknown"

function gitFreshness(storedSha: string | null, currentHead: string | null): Freshness {
  if (currentHead === null || storedSha === null) return "unknown"
  if (storedSha === currentHead) return "current-git"
  return "different-git"
}

function decisionFreshness(storedSha: string | null, currentHead: string | null): Freshness {
  return gitFreshness(storedSha, currentHead)
}
