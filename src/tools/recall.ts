/**
 * Recall tools — pull-based memory access for the model.
 *
 * Implements §6.1 from docs/IMPLEMENTATION.md.
 * Each tool's execute body is extracted into an inner function (exported)
 * for direct testability without invoking the opencode tool runtime.
 */
import { tool } from "@opencode-ai/plugin"
import { readMemory, writeMemory } from "../memory/store"
import {
  queryDecisions,
  getActiveFiles,
  getProjectState,
} from "../memory/reader"

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
      .map((d) => `${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${d.timestamp})${d.provenance ? ` [${decisionProvenanceLabel(d)}]` : ""}`)
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

export async function _recallPromote(
  args: { topic: string },
  context: { worktree: string; directory: string; sessionID?: string; sessionId?: string },
): Promise<string> {
  try {
    const mem = await readMemory({ worktree: context.worktree, directory: context.directory })
    if (!mem) return "No project memory."
    const d = mem.decisions.find(
      (d) => d.topic.toLowerCase() === args.topic.toLowerCase(),
    )
    if (!d) return `No decision with topic "${args.topic}".`
    d.foundational = true
    d.foundational_requested = false
    const reviewSession = context.sessionID ?? context.sessionId ?? d.session_id ?? "human-review"
    d.provenance = {
      ...(d.provenance ?? {
        extractor: "legacy" as const,
        source_session_id: d.session_id || "legacy",
        confidence: "legacy" as const,
        evidence: [],
      }),
      extractor: "human",
      source_session_id: reviewSession,
      confidence: "human-reviewed",
    }
    await writeMemory({ worktree: context.worktree, directory: context.directory }, mem)
    return `Promoted: ${d.topic}: ${d.decision}${d.provenance ? ` [${decisionProvenanceLabel(d)}]` : ""}`
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
          "Recall a prior decision for this project. CALL THIS before assuming continuity with a previous session. Returns the decision and its date/git-SHA so you can judge staleness.",
        args: {
          query: tool.schema
            .string()
            .optional()
            .describe("topic or keyword. Omit to get most recent decisions."),
          limit: tool.schema.number().default(10).describe("max results"),
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
          "Mark a decision as foundational — it will always be included in compaction context. Use for architecture-level decisions that should never be forgotten.",
        args: {
          topic: tool.schema.string().describe("exact topic of the decision to promote"),
        },
        async execute(args, context) {
          return _recallPromote(args, context)
        },
      }),
    },
  }
}
