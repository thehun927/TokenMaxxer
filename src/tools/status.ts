/**
 * Status tool — plugin health check.
 *
 * Implements §7.2 from docs/IMPLEMENTATION.md.
 * Also exports `lastCompactionTimestamp` and `setLastCompaction` so
 * index.ts can update the timestamp when the compaction hook fires.
 */
import { tool } from "@opencode-ai/plugin"
import { readMemoryState, resolveProjectPath } from "../memory/store"
import { getProjectQueueStatus } from "../memory/lock"
import {
  getLLMEvidenceStats,
  getLastLLMModelResolution,
} from "../memory/extract-llm"

// --- Module-level state (updated by index.ts) ---

export let lastCompactionTimestamp: string | null = null

export function setLastCompaction(ts: string) {
  lastCompactionTimestamp = ts
}

// --- Inner function (exported for testability) ---

export async function _tokenmaxxerStatus(
  _args: Record<string, never>,
  context: { worktree: string; directory: string },
): Promise<string> {
  try {
    const result = await readMemoryState({
      worktree: context.worktree,
      directory: context.directory,
    })
    const mem = result.memory
    const project = resolveProjectPath(context.worktree, context.directory)
    const queue = getProjectQueueStatus(project)
    const evidenceStats = getLLMEvidenceStats()
    const decisions = mem?.decisions ?? []
    const legacyFacts = decisions.filter((d) => d.provenance?.confidence === "legacy").length
      + (mem?.active_files.filter((f) => f.provenance?.confidence === "legacy").length ?? 0)
      + (mem?.current_task_provenance?.confidence === "legacy" ? 1 : 0)
    const quarantined = mem?.llm_extraction_cache_quarantine?.count ?? 0
    const resolution = getLastLLMModelResolution()
    // Health rows are appended/reloaded in recency order by the durable
    // writer. Do not use the process-global model resolution to identify this
    // project's selected model or health.
    const selectedHealth = [...(mem?.model_health ?? [])].reverse()[0]
    const selectedModel = selectedHealth
      ? `${selectedHealth.provider_id}/${selectedHealth.model_id}`
      : "none"
    const provenanceSummary = mem
      ? [
          mem.current_task_provenance
            ? `task source=${mem.current_task_provenance.source_session_id} confidence=${mem.current_task_provenance.confidence} evidence=${mem.current_task_provenance.evidence?.length ?? 0}`
            : "task source=unknown confidence=unknown evidence=0",
          ...mem.active_files.slice(0, 3).map((file) => (
            `file:${file.path} source=${file.provenance?.source_session_id ?? "unknown"} confidence=${file.provenance?.confidence ?? "unknown"} evidence=${file.provenance?.evidence?.length ?? 0}`
          )),
          ...mem.decisions.slice(0, 3).map((decision) => (
            `decision:${decision.topic} source=${decision.provenance?.source_session_id ?? "unknown"}${decision.provenance?.source_audit_session_id
              ? ` audit=${decision.provenance.source_audit_session_id}`
              : ""} confidence=${decision.provenance?.confidence ?? "unknown"} evidence=${decision.provenance?.evidence?.length ?? 0}`
          )),
        ].join("; ")
      : "none"

    return [
      `Project: ${mem?.project_path ?? "none"}`,
      `Memory file: ${result.path ?? "none"} (${result.sizeBytes} bytes)`,
      `Memory source: ${result.source ?? "none"}`,
      `Memory revision: ${result.revision}`,
      `Decisions: ${mem?.decisions.length ?? 0} (${mem?.decisions.filter((d) => d.still_valid).length ?? 0} valid)`,
      `Active files: ${mem?.active_files.length ?? 0}`,
      `Last updated: ${mem?.last_updated ?? "never"}`,
      `Last git SHA: ${mem?.last_git_sha ?? "unknown"}`,
      `Last compaction: ${lastCompactionTimestamp ?? "none"}`,
      `Queue depth: ${queue.queueDepth}`,
      `In-flight: ${queue.inFlight}`,
      `Last idle outcome: ${queue.lastOutcome ?? "none"}`,
      `LLM evidence (process-wide): ${evidenceStats.accepted} accepted, ${evidenceStats.rejected} rejected`,
      `Legacy facts: ${legacyFacts}`,
      `Quarantined cache rows: ${quarantined}`,
      `LLM candidates (process-wide): ${resolution.candidate_count}`,
      `LLM selected: ${selectedModel} (${selectedHealth ? "durable-health" : "none"})`,
      `LLM variant (process-wide): ${resolution.variant ?? "none"}`,
      `LLM health: ${selectedHealth?.last_outcome ?? "none"} cooldown=${selectedHealth?.cooldown_until ?? "none"} reason=${selectedHealth?.failure_reason ?? "none"}`,
      `Provenance: ${provenanceSummary}`,
    ].join("\n")
  } catch (e) {
    return `Error checking status: ${String(e)}`
  }
}

// --- Tool registration ---

export function registerStatusTools(): {
  tool: Record<string, ReturnType<typeof tool>>
} {
  return {
    tool: {
      tokenmaxxer_status: tool({
        description:
          "Check tokenmaxxer plugin health: memory file path, size, decision count, last write, last compaction.",
        args: {},
        async execute(_args, context) {
          return _tokenmaxxerStatus(_args as Record<string, never>, context)
        },
      }),
    },
  }
}
