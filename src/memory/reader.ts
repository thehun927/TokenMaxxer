/**
 * Memory reader — thin query helpers used by recall tools.
 */
import type { MemoryFile, Decision, ActiveFile } from "./schema"

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
    `Task: ${mem.current_task ?? "—"}`,
    `Active files: ${mem.active_files.map((f) => f.path).join(", ") || "none"}`,
    `Decisions: ${validDecisions.map((d) => d.topic).join(", ") || "none"}`,
    `Blockers: ${mem.blockers.join("; ") || "none"}`,
    `Next: ${mem.next_steps.join("; ") || "none"}`,
  ].join("\n")
}
