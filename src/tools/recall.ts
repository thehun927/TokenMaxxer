/**
 * Recall tools — pull-based memory access for the model.
 *
 * Implements §6.1 from docs/IMPLEMENTATION.md.
 * Each tool's execute body is extracted into an inner function (exported)
 * for direct testability without invoking the opencode tool runtime.
 *
 * PR 3 §8/§9: recall output exposes stable decision IDs, project state
 * surfaces unresolved human authority conflicts, and `recall_promote` is a
 * review-request tool that can never mint human trust.
 */
import { tool } from "@opencode-ai/plugin"
import { readMemory, mutateMemory, resolveProjectPath } from "../memory/store"
import type { MemoryMutationResult, MutationAction } from "../memory/store"
import {
  queryDecisions,
  getActiveFiles,
  getProjectState,
} from "../memory/reader"
import { requestFoundationalReview } from "../memory/decision-review"
import type { DecisionReviewMutation } from "../memory/decision-review"
import { enqueueProjectJob } from "../memory/lock"
import {
  recallQuerySchema,
  recallLimitSchema,
  decisionIdSchema,
  decisionTopicSchema,
} from "./bounds"

function decisionProvenanceLabel(value: { provenance?: {
  source_session_id: string
  source_audit_session_id?: string
  confidence: string
  evidence?: unknown[]
} }): string {
  const provenance = value.provenance
  if (!provenance) return ""
  return `source=${provenance.source_session_id}${provenance.source_audit_session_id
    ? ` audit=${provenance.source_audit_session_id}`
    : ""} confidence=${provenance.confidence} evidence=${provenance.evidence?.length ?? 0}`
}

// --- Inner functions (exported for testability) ---

export async function _recallDecision(
  args: { query?: string; limit: number },
  context: { worktree: string; directory: string },
): Promise<string> {
  try {
    const mem = await readMemory({ worktree: context.worktree, directory: context.directory })
    if (!mem) return "No project memory yet."
    const hits = queryDecisions(mem, args.query, args.limit)
    const prefix = `Project: ${mem.project_path}\n`
    if (!hits.length) return `${prefix}No valid decisions matching "${args.query}".`
    return prefix + hits
      .map((d) => {
        // PR 3 §8.1: the stable decision ID is unambiguous and copyable.
        const marker = ` [id=${d.id} confidence=${d.provenance?.confidence ?? "unknown"} foundational=${d.foundational === true} requested=${d.foundational_requested === true}]`
        const provenance = d.provenance ? ` ${decisionProvenanceLabel(d)}` : ""
        return `${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${d.timestamp})${marker}${provenance}`
      })
      .join("\n")
  } catch (e) {
    return `Error recalling decisions: ${String(e)}`
  }
}

export async function _getActiveFiles(
  _args: Record<string, never>,
  context: { worktree: string; directory: string },
): Promise<string> {
  try {
    const mem = await readMemory({ worktree: context.worktree, directory: context.directory })
    if (!mem) return "No active files recorded."
    const active = getActiveFiles(mem)
    if (!active.length) return "No active files recorded."
    return `Project: ${mem.project_path}\n` + active
      .map((f) => `${f.path} — ${f.reason}${f.provenance ? ` [${decisionProvenanceLabel(f)}]` : ""}`)
      .join("\n")
  } catch (e) {
    return `Error getting active files: ${String(e)}`
  }
}

export async function _getProjectState(
  _args: Record<string, never>,
  context: { worktree: string; directory: string },
): Promise<string> {
  try {
    const mem = await readMemory({ worktree: context.worktree, directory: context.directory })
    if (!mem) return "No project memory. This looks like a fresh start."
    return getProjectState(mem)
  } catch (e) {
    return `Error getting project state: ${String(e)}`
  }
}

/**
 * PR 3 §9 — `recall_promote` review-request arguments.
 * Exactly one selector is required at runtime.
 */
export type RecallPromoteArgs = {
  decision_id?: string
  /** One-release compatibility path only. */
  topic?: string
}

/**
 * Typed callback outcome of a review request (plan §9.3).
 */
export type RecallPromoteOutcome =
  | { outcome: "requested"; id: string }
  | { outcome: "already-reviewed"; id: string }
  | { outcome: "not-found"; id?: string; topic?: string }
  | { outcome: "not-authoritative"; id: string }
  | { outcome: "conflict"; id?: string; topic?: string }
  | { outcome: "ambiguous"; topic: string }
  | { outcome: "duplicate-id"; id: string }

function formatRecallPromoteResult(result: MemoryMutationResult<RecallPromoteOutcome>): string {
  if (result.status === "unavailable") {
    return "No project memory."
  }
  if (result.status === "lock-timeout" || result.status === "commit-failed") {
    return "promotion-write-failed"
  }
  if (result.status === "budget-rejected") {
    // Budget rejection: route through existing failure behavior
    return "promotion-write-failed"
  }
  switch (result.value.outcome) {
    case "requested":
      return `Foundational review requested for ${result.value.id}. Human confirmation required: tokenmaxxer promote ${result.value.id}`
    case "already-reviewed":
      return `${result.value.id} is already trusted human foundational.`
    case "not-found":
      return result.value.topic !== undefined
        ? `No decision for topic '${result.value.topic}'.`
        : `No decision with id "${result.value.id}".`
    case "not-authoritative":
      return `Decision ${result.value.id} is not-authoritative: it is not the current authority for its topic. Specify the decision_id from recall_decision.`
    case "conflict":
      return result.value.id !== undefined
        ? `Decision ${result.value.id} is inside an unresolved human-foundational conflict.`
        : `Topic '${result.value.topic}' has an unresolved human-foundational conflict. Specify --decision-id from recall_decision.`
    case "ambiguous":
      return `Ambiguous topic '${result.value.topic}': multiple authorities exist. Specify --decision-id from recall_decision.`
    case "duplicate-id":
      return `Decision ${result.value.id} is ambiguous: multiple rows share this ID. Refusing review request; no state was changed.`
  }
}

/**
 * Wave-9 (Concern D) — map the shared `requestFoundationalReview` eligibility
 * result onto the typed `RecallPromoteOutcome` and the `mutateMemory` action.
 * The model tool and the human CLI now share one eligibility definition, so
 * conflict/ID/topic policy cannot drift between the two callers.
 */
function reviewMutationToAction(
  mutation: DecisionReviewMutation,
  isTopic: boolean,
): MutationAction<RecallPromoteOutcome> {
  switch (mutation.kind) {
    case "requested":
      return {
        kind: "commit",
        memory: mutation.memory,
        value: { outcome: "requested", id: mutation.targetId },
      }
    case "already-reviewed":
      return { kind: "noop", value: { outcome: "already-reviewed", id: mutation.targetId } }
    case "not-found":
      return isTopic
        ? { kind: "noop", value: { outcome: "not-found", topic: mutation.targetId } }
        : { kind: "noop", value: { outcome: "not-found", id: mutation.targetId } }
    case "not-authoritative":
      return { kind: "noop", value: { outcome: "not-authoritative", id: mutation.targetId } }
    case "conflict":
      return isTopic
        ? { kind: "noop", value: { outcome: "conflict", topic: mutation.targetId } }
        : { kind: "noop", value: { outcome: "conflict", id: mutation.targetId } }
    case "ambiguous":
      return { kind: "noop", value: { outcome: "ambiguous", topic: mutation.topic } }
    case "duplicate-id":
      return { kind: "noop", value: { outcome: "duplicate-id", id: mutation.targetId } }
    default:
      // Safety: any future helper kind is a refusal, never a promotion.
      return { kind: "noop", value: { outcome: "not-found", id: mutation.targetId } }
  }
}

export async function _recallPromote(
  args: RecallPromoteArgs,
  context: { worktree: string; directory: string; sessionID?: string; sessionId?: string },
): Promise<string> {
  try {
    // PR 3 §9: exactly one selector is required.
    const hasId = args.decision_id !== undefined && args.decision_id.trim().length > 0
    const hasTopic = args.topic !== undefined && args.topic.trim().length > 0
    if (hasId === hasTopic) {
      return "Provide exactly one selector: decision_id (preferred) or topic (one-release compatibility)."
    }

    // Keep promotion on the same effective project key as memory reads/writes.
    // The fallback is only for narrow test doubles that predate the shared
    // resolver export; production always uses resolveProjectPath.
    const project = typeof resolveProjectPath === "function"
      ? resolveProjectPath(context.worktree, context.directory)
      : (context.worktree && context.worktree !== "/" ? context.worktree : context.directory)

    const operationKey = hasId
      ? `recall-promote:${args.decision_id!.trim().slice(0, 256)}`
      : `recall-promote:${args.topic!.trim().toLowerCase().slice(0, 256)}`

    // PR 3 §9.3: one `mutateMemory` transaction carries the authority check and
    // the mutation. No separate pre-read decides eligibility. The process-local
    // queue is only an outer coalescing layer; the PR 2 filesystem transaction
    // is authoritative. `mutateMemory` acquires the project lock; the read-only
    // recall tools never do.
    return await enqueueProjectJob(project, operationKey, async () => {
      const result = await mutateMemory<RecallPromoteOutcome>(
        { worktree: context.worktree, directory: context.directory },
        (base) => {
          // Wave-9 (Concern D): delegate to the shared eligibility helper. It
          // performs the exact-ID/topic resolution, refuses unresolved human
          // conflicts and duplicate-ID states, and is the ONLY code that may
          // decide a row may be requested. The ONLY mutation it performs is
          // `foundational_requested = true`.
          const mutation = hasId
            ? requestFoundationalReview(base, { decision_id: args.decision_id!.trim() })
            : requestFoundationalReview(base, { topic: args.topic!.trim() })
          return reviewMutationToAction(mutation, hasTopic)
        },
      )
      return formatRecallPromoteResult(result)
    })
  } catch (e) {
    return `Error promoting decision: ${String(e)}`
  }
}

// --- Tool registration ---

export function registerTools(_ctx: {
  worktree: string
  directory: string
}): { tool: Record<string, ReturnType<typeof tool>> } {
  return {
    tool: {
      recall_decision: tool({
        description:
          "Recall a prior decision for this project. CALL THIS before assuming continuity with a previous session. Returns the stable decision ID plus date/git-SHA so you can judge staleness.",
        args: {
          query: recallQuerySchema
            .describe("topic or keyword. Omit to get most recent decisions."),
          limit: recallLimitSchema.describe("max results"),
        },
        async execute(args, context) {
          return _recallDecision(args, context)
        },
      }),

      get_active_files: tool({
        description:
          "List files actively being worked on in this project, with why each matters. Use to avoid re-discovering them.",
        args: {},
        async execute(args, context) {
          return _getActiveFiles(args as Record<string, never>, context)
        },
      }),

      get_project_state: tool({
        description:
          "Full project memory header: current task, active files, valid decisions, blockers, next steps. Call once at session start if resuming work.",
        args: {},
        async execute(args, context) {
          return _getProjectState(args as Record<string, never>, context)
        },
      }),

      recall_promote: tool({
        description:
          "Request human foundational review for a decision by stable ID (preferred) or exact topic (one-release compatibility). This only requests review; it never mints human trust. The human CLI `tokenmaxxer promote <id>` must confirm.",
        args: {
          decision_id: decisionIdSchema
            .describe("stable decision ID from recall_decision"),
          topic: decisionTopicSchema
            .describe("exact normalized topic (compatibility only; refused when ambiguous)"),
        },
        async execute(args, context) {
          return _recallPromote(args, context)
        },
      }),
    },
  }
}
