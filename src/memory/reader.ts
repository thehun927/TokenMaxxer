/**
 * Memory reader — thin query helpers used by recall tools.
 */
import type { MemoryFile, Decision, ActiveFile } from "./schema"

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
 * Query decisions from memory.
 * - If query is empty/undefined → return most recent N valid decisions sorted by timestamp desc.
 * - If query provided → filter valid decisions where topic includes query (case-insensitive),
 *   sorted by timestamp desc, limited to N.
 */
export function queryDecisions(
  mem: MemoryFile,
  query: string | undefined,
  limit: number,
): Decision[] {
  const valid = mem.decisions.filter((d) => d.still_valid)

  if (!query || query.trim().length === 0) {
    return [...valid]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit)
  }

  const q = query.toLowerCase().trim()
  return valid
    .filter((d) => d.topic.toLowerCase().includes(q))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit)
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
 */
export function getProjectState(mem: MemoryFile): string {
  const validDecisions = mem.decisions.filter((d) => d.still_valid)

  return [
    `Project: ${mem.project_path}`,
    `Last: ${mem.last_updated} (SHA ${mem.last_git_sha ?? "?"})`,
    `Task: ${mem.current_task ?? "—"}${mem.current_task_provenance
      ? ` (source=${mem.current_task_provenance.source_session_id} confidence=${mem.current_task_provenance.confidence} evidence=${mem.current_task_provenance.evidence?.length ?? 0})`
      : ""}`,
    `Active files: ${mem.active_files.map((f) => `${f.path} [${formatActiveFileProvenance(f)}]`).join(", ") || "none"}`,
    `Decisions: ${validDecisions.map((d) => `${d.topic} [${formatDecisionProvenance(d)}]`).join(", ") || "none"}`,
    `Blockers: ${mem.blockers.join("; ") || "none"}`,
    `Next: ${mem.next_steps.join("; ") || "none"}`,
  ].join("\n")
}
