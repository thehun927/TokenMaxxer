/**
 * Memory reader — thin query helpers used by recall tools.
 *
 * PR 3 §8: readers are authority-aware. `queryDecisions` and the project-state
 * view operate on `resolveDecisionAuthorities(...).authorities`, never on raw
 * `still_valid` filtering, so legacy duplicate-valid files cannot leak two
 * authorities for one normalized topic.
 */
import type { MemoryFile, Decision, ActiveFile } from "./schema"
import { resolveDecisionAuthorities } from "./decision-authority"
import type { DecisionAuthorityConflict } from "./decision-authority"

function provenanceLabel(value: { provenance?: Decision["provenance"] }): string {
  const provenance = value.provenance
  if (!provenance) return "source=unknown confidence=unknown evidence=0"
  return [
    `source=${provenance.source_session_id}`,
    ...(provenance.source_audit_session_id
      ? [`audit=${provenance.source_audit_session_id}`]
      : []),
    `confidence=${provenance.confidence}`,
    `evidence=${provenance.evidence?.length ?? 0}`,
  ].join(" ")
}

export function formatDecisionProvenance(decision: Decision): string {
  return provenanceLabel(decision)
}

export function formatActiveFileProvenance(file: ActiveFile): string {
  return provenanceLabel(file)
}

/**
 * Query decisions from memory — authority-aware.
 * - The source set is `resolveDecisionAuthorities(mem.decisions).authorities`,
 *   the post-reconciliation authoritative view (plan §6.3 / §8), never raw
 *   `still_valid` filtering.
 * - If query is empty/undefined → return most recent N authorities sorted by
 *   timestamp desc.
 * - If query provided → filter authorities where topic includes query
 *   (case-insensitive), sorted by timestamp desc, limited to N.
 */
export function queryDecisions(
  mem: MemoryFile,
  query: string | undefined,
  limit: number,
): Decision[] {
  const authorities = resolveDecisionAuthorities(mem.decisions).authorities

  if (!query || query.trim().length === 0) {
    return [...authorities]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit)
  }

  const q = query.toLowerCase().trim()
  return authorities
    .filter((d) => d.topic.toLowerCase().includes(q))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit)
}

/**
 * Look up a decision by its exact stable `decision.id`.
 *
 * Returns the decision regardless of `still_valid`; callers check the
 * authority view / `still_valid` themselves (plan §8).
 */
export function getDecisionById(mem: MemoryFile, decisionId: string): Decision | undefined {
  return mem.decisions.find((d) => d.id === decisionId)
}

/**
 * Unresolved human-foundational conflicts for the current read view
 * (`conflicting-human-foundational` records, plan §6.2 / §8).
 */
export function getDecisionAuthorityConflicts(mem: MemoryFile): DecisionAuthorityConflict[] {
  return resolveDecisionAuthorities(mem.decisions).conflicts
}

/**
 * Get active files from memory.
 */
export function getActiveFiles(mem: MemoryFile): ActiveFile[] {
  return mem.active_files
}

/**
 * Get formatted project state string.
 * Per docs/IMPLEMENTATION.md §6.1: Project, Last, Task, Active files, Decisions, Blockers, Next.
 *
 * Authority-aware (plan §8.2): the Decisions line shows the authoritative set,
 * and unresolved human-foundational conflicts get one bounded line each. No
 * historical invalid rows are dumped into normal project state.
 */
export function getProjectState(mem: MemoryFile): string {
  const authorities = resolveDecisionAuthorities(mem.decisions).authorities
  const conflicts = getDecisionAuthorityConflicts(mem)

  const conflictLines = conflicts.map(
    (c) =>
      `Decision conflicts: ${c.normalized_topic} (human-foundational conflict: ${c.decision_ids.join(", ")})`,
  )

  return [
    `Project: ${mem.project_path}`,
    `Last: ${mem.last_updated} (SHA ${mem.last_git_sha ?? "?"})`,
    `Task: ${mem.current_task ?? "—"}${mem.current_task_provenance
      ? ` (source=${mem.current_task_provenance.source_session_id} confidence=${mem.current_task_provenance.confidence} evidence=${mem.current_task_provenance.evidence?.length ?? 0})`
      : ""}`,
    `Active files: ${mem.active_files.map((f) => `${f.path} [${formatActiveFileProvenance(f)}]`).join(", ") || "none"}`,
    `Decisions: ${authorities.map((d) => `${d.topic} [${formatDecisionProvenance(d)}]`).join(", ") || "none"}`,
    `Blockers: ${mem.blockers.join("; ") || "none"}`,
    `Next: ${mem.next_steps.join("; ") || "none"}`,
    ...conflictLines,
  ].join("\n")
}
