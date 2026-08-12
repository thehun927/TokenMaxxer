/**
 * Builds the durable-state block injected into the compaction prompt.
 *
 * Reads from the per-project memory file via the authoritative
 * `readMemoryState` API so the hook can distinguish missing, unavailable,
 * and valid states.  PR-8 Wave 6 imposes the independent 4,096-byte UTF-8
 * injection ceiling (plan §9): delimiters, `DATA ` prefixes, newlines, tags,
 * and the closing delimiter all count toward the budget.
 *
 *  - Deterministic render candidates with the §9.3 semantic priority order;
 *  - strict prefix rule (§9.4): reserve the closing delimiter before every
 *    candidate, stop all lower-priority insertion once a candidate no longer
 *    fits (no skip-and-fill);
 *  - `[llm:eN]` tags use the actual retained evidence pointer count (1..3),
 *    not a render ordinal (§9.5);
 *  - unchanged PR-7 data-only sanitization, delimiters, sentinels, compact
 *    provenance, git-freshness labels, honest observed-file wording, and
 *    per-field render-only character caps;
 *  - rendering never mutates STATE and durable retention is independent from
 *    automatic injection (§10): an omitted decision stays pull-recallable.
 */

import type { Decision } from "../memory/schema"
import { readMemoryState } from "../memory/store"
import { log } from "../util/log"
import { getCurrentGitSha } from "../util/git"
import { sanitizeDurableValue } from "./sanitize"
import { truncateUtf8 } from "../memory/budget"

// ---------------------------------------------------------------------------
// PR-8 Wave 6 — independent automatic-injection ceiling (§3.2 / §9.1).
// This is NOT the 8,192-byte STATE storage cap and must not be reused for
// storage pruning.
// ---------------------------------------------------------------------------

export const DURABLE_BLOCK_MAX_BYTES = 4096

// ---------------------------------------------------------------------------
// Delimiters
// ---------------------------------------------------------------------------

const DELIM_OPEN = "<<<TOKENMAXXER_DURABLE_CONTEXT_DATA>>>"
const DELIM_CLOSE = "<<<END_TOKENMAXXER_DURABLE_CONTEXT_DATA>>>"

// ---------------------------------------------------------------------------
// Per-field render-only character caps (§10.4).  These are NOT a PR-8 total
// byte budget.  Truncation is applied via sanitizeDurableValue and changes
// only the automatic representation, never STATE.
// ---------------------------------------------------------------------------

const CAP_PROJECT_PATH = 1024
const CAP_CURRENT_TASK = 600
const CAP_FILE_REASON = 400
const CAP_DECISION_TOPIC = 256
const CAP_DECISION_TEXT = 600
const CAP_BLOCKER = 600
const CAP_NEXT_STEP = 600

// ---------------------------------------------------------------------------
// Bounded render groups (M5 policy, preserved under PR-8).
// ---------------------------------------------------------------------------

const MAX_OBSERVED_FILES = 8
const MAX_OLDER_DECISIONS = 5

// ---------------------------------------------------------------------------
// Render candidates (§9.2)
// ---------------------------------------------------------------------------

type DurableRenderCandidate = {
  /** §9.3 semantic priority — lower number wins. */
  priority: number
  /** Deterministic intra-group order when priorities tie. */
  seq: number
  /** Stable identity for deterministic tie-breaking. */
  stableKey: string
  line: string
}

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

    // Build sanitized candidates in deterministic semantic priority (§9.3).
    const candidates: DurableRenderCandidate[] = []
    let seq = 0
    const candidate = (priority: number, stableKey: string, line: string): void => {
      candidates.push({ priority, seq: seq++, stableKey, line })
    }

    // --- Priority 1: project identity + memory-level freshness metadata ---
    // The project identity is sanitized with the PR-7 character cap first.
    // Its byte budget is enforced below alongside every other byte of framing
    // (see the §9.1/§9.4 mandatory-prefix budget), so a 1,024-code-point
    // four-byte path can never push the block past the injection ceiling.
    const projectValue = sanitizeDurableValue(mem.project_path, CAP_PROJECT_PATH)
    const memFreshness = gitFreshness(mem.last_git_sha ?? null, currentHead)
    const freshnessLine = dataLine(`Memory freshness: ${memFreshness}`)

    // --- Priority 2: current task ---
    if (mem.current_task) {
      const taskTag = provenanceTagCompact(mem.current_task_provenance)
      candidate(
        2,
        "current-task",
        dataLine(
          `Current task ${taskTag}: ${sanitizeDurableValue(mem.current_task, CAP_CURRENT_TASK)}`,
        ),
      )
    }

    // --- Priority 3: blockers ---
    for (const [index, blocker] of (mem.blockers ?? []).entries()) {
      candidate(
        3,
        `blocker-${index}`,
        dataLine(`Blocker: ${sanitizeDurableValue(blocker, CAP_BLOCKER)}`),
      )
    }

    // --- Priority 4: immediate next steps ---
    for (const [index, nextStep] of (mem.next_steps ?? []).entries()) {
      candidate(
        4,
        `next-${index}`,
        dataLine(`Next: ${sanitizeDurableValue(nextStep, CAP_NEXT_STEP)}`),
      )
    }

    // --- Decision grouping (valid decisions only; M5 bounded policy) ---
    const valid = (mem.decisions ?? []).filter((d) => d.still_valid)
    const foundational = valid.filter((d) => d.foundational)
    const recentSessions = mem.recent_sessions ?? [
      ...new Set(
        valid.map((d) => d.last_used_in_session).filter((id): id is string => Boolean(id)),
      ),
    ]
    const recent = valid.filter(
      (d) => !d.foundational && isRecentSession(d, recentSessions),
    )
    const older = sortDecisions(
      valid.filter((d) => !d.foundational && !isRecentSession(d, recentSessions)),
    ).slice(0, MAX_OLDER_DECISIONS)

    // --- Priority 5: human-reviewed foundational decisions ---
    for (const d of sortDecisions(foundational)) {
      candidate(5, `foundational-${d.id}`, dataLine(formatDecision(d, currentHead)))
    }

    // --- Priority 6: most-recently-touched durable file observations ---
    const observedFiles = [...(mem.active_files ?? [])]
      .sort((a, b) => b.last_touched.localeCompare(a.last_touched))
      .slice(0, MAX_OBSERVED_FILES)
    for (const f of observedFiles) {
      candidate(
        6,
        `file-${f.path}`,
        dataLine(
          `Observed file ${provenanceTagCompact(f.provenance)}: ` +
            `${sanitizeDurableValue(f.path, CAP_PROJECT_PATH)} — ` +
            `${sanitizeDurableValue(f.reason, CAP_FILE_REASON)}`,
        ),
      )
    }

    // --- Priority 7: recently recalled/referenced valid decisions ---
    for (const d of sortDecisions(recent)) {
      candidate(7, `recent-${d.id}`, dataLine(formatDecision(d, currentHead)))
    }

    // --- Priority 8: remaining valid non-foundational decisions, newest first ---
    // Bounded to the newest MAX_OLDER_DECISIONS rows, preserving the M5
    // policy; lower-priority tail decisions are not injected.
    for (const d of older) {
      candidate(8, `older-${d.id}`, dataLine(formatDecision(d, currentHead)))
    }

    // §9.3(9) — lower-priority observed files / older decisions are bounded out
    // by the render caps above (top-8 observed files, top-5 older decisions);
    // the strict prefix rule below guarantees no lower-priority content can be
    // opportunistically injected after an oversized higher-priority candidate.

    // --- Strict prefix selection (§9.4) ---
    candidates.sort((a, b) => a.priority - b.priority || a.seq - b.seq)

    const lines: string[] = [DELIM_OPEN]
    let usedBytes = Buffer.byteLength(DELIM_OPEN, "utf8")
    const closingBytes = Buffer.byteLength(DELIM_CLOSE, "utf8")

    // §9.1/§9.4 — the mandatory header (opening delimiter, project identity,
    // memory freshness, closing delimiter) is budgeted exactly like every
    // optional candidate.  Only the project identity is variable — freshness is
    // a short fixed vocabulary — so reserve every fixed framing byte and hand
    // the remainder to UTF-8-safe byte truncation.  `truncateUtf8` guarantees
    // `utf8Bytes(result) <= budget`, which makes the full mandatory prefix
    // <= DURABLE_BLOCK_MAX_BYTES by construction.  The strict prefix rule
    // below is therefore unchanged: candidates still reserve the closing
    // delimiter before every push and stop on the first candidate that no
    // longer fits.
    const freshnessBytes = Buffer.byteLength(freshnessLine, "utf8")
    const projectBudget =
      DURABLE_BLOCK_MAX_BYTES -
      usedBytes -                          // opening delimiter
      1 -                                  // newline before the project line
      Buffer.byteLength("DATA Project: ", "utf8") -
      1 -                                  // newline before the freshness line
      freshnessBytes -
      1 -                                  // newline before the closing delimiter
      closingBytes
    const projectLine = dataLine(
      `Project: ${truncateUtf8(projectValue, Math.max(0, projectBudget))}`,
    )

    const pushLine = (content: string): void => {
      lines.push(content)
      usedBytes += 1 + Buffer.byteLength(content, "utf8")
    }

    pushLine(projectLine)
    pushLine(freshnessLine)

    for (const c of candidates) {
      // Reserve the candidate's own preceding newline, the newline before the
      // closing delimiter, and the closing delimiter itself.
      const projected =
        usedBytes + 1 + Buffer.byteLength(c.line, "utf8") + 1 + closingBytes
      if (projected > DURABLE_BLOCK_MAX_BYTES) break
      pushLine(c.line)
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

/** Deterministic sort: timestamp descending, then stable ID lexically. */
function sortDecisions(decisions: Decision[]): Decision[] {
  return [...decisions].sort((a, b) => {
    const byTimestamp = b.timestamp.localeCompare(a.timestamp)
    if (byTimestamp !== 0) return byTimestamp
    return a.id.localeCompare(b.id)
  })
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
    case "human":    return "[human]"
    case "heuristic": return "[heuristic]"
    case "legacy":   return "[legacy]"
    case "llm":      return placeholderLlmTag() // resolved by formatDecision with the real evidence count
    default:         return "[unknown]"
  }
}

/** Return a placeholder for LLM evidence — replaced with the real eN count. */
function placeholderLlmTag(): string {
  return "[llm:__E__]"
}

/**
 * The actual retained evidence pointer count (1..3) for an LLM decision
 * (§9.5).  Schema-valid LLM provenance always carries 1-3 transcript
 * evidence entries; clamp defensively for robustness.
 */
function llmEvidenceCount(d: Decision): number {
  const count = d.provenance?.evidence?.length ?? 0
  return Math.max(1, Math.min(count, 3))
}

/**
 * Format a single decision line with compact provenance, git freshness,
 * and per-field truncation.  `[llm:eN]` reports the actual retained evidence
 * count for that decision, not its render ordinal.
 */
function formatDecision(d: Decision, currentHead: string | null): string {
  const tagRaw = provenanceTagCompact(d.provenance as { extractor?: string } | undefined)
  const tag = tagRaw === "[llm:__E__]"
    ? `[llm:e${llmEvidenceCount(d)}]`
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
