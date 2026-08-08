/**
 * Builds the durable-state block injected into the compaction prompt.
 *
 * Reads from the per-project memory file (Layer 2). On first session
 * or when memory is unavailable, returns a placeholder string.
 * Applies the M5 bounded policy so the most important memory remains in the
 * compaction prompt while older decisions remain available through recall.
 */

import type { Decision } from "../memory/schema"
import { readMemory } from "../memory/store"
import { log } from "../util/log"

export async function buildDurableBlock(opts: {
  worktree: string
  directory: string
  client: unknown
}): Promise<string> {
  try {
    const mem = await readMemory({ worktree: opts.worktree, directory: opts.directory })
    if (!mem) return "(no prior project memory)"

    const lines: string[] = []
    lines.push(`Project: ${mem.project_path}`)
    lines.push(`Last updated: ${mem.last_updated}  git SHA: ${mem.last_git_sha ?? "unknown"}`)

    if (mem.current_task) {
      lines.push(`Current task: ${mem.current_task}`)
    }

    const activeFiles = [...mem.active_files]
      .sort((a, b) => b.last_touched.localeCompare(a.last_touched))
      .slice(0, 8)

    if (activeFiles.length) {
      lines.push("Active files:")
      for (const f of activeFiles) {
        lines.push(`  - ${f.path} — ${f.reason}`)
      }
    }

    const valid = mem.decisions.filter((d) => d.still_valid)
    const foundational = valid.filter((d) => d.foundational)
    // A v2 memory always has recent_sessions. The fallback keeps direct v1
    // test fixtures and callers from throwing before they are migrated.
    const recentSessions = mem.recent_sessions ?? [
      ...new Set(valid.map((d) => d.last_used_in_session).filter((id): id is string => Boolean(id))),
    ]
    const recent = valid.filter(
      (d) => !d.foundational && isRecentSession(d, recentSessions),
    )
    const older = valid
      .filter(
        (d) => !d.foundational && !isRecentSession(d, recentSessions),
      )
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 5)

    if (foundational.length || recent.length) {
      lines.push("Valid decisions:")
      for (const d of [...foundational, ...recent]) {
        lines.push(
          `  - ${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${d.timestamp})`,
        )
      }
    }

    if (older.length) {
      lines.push("Older decisions:")
      for (const d of older) {
        const date = d.timestamp.slice(0, 10)
        lines.push(`  - ${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${date})`)
      }
    }

    if (mem.blockers.length) {
      lines.push(`Blockers: ${mem.blockers.join("; ")}`)
    }

    if (mem.next_steps.length) {
      lines.push(`Next: ${mem.next_steps.join("; ")}`)
    }

    return lines.join("\n")
  } catch (e) {
    await log(opts.client, "warn", "buildDurableBlock failed", { error: String(e) })
    return "(memory unavailable)"
  }
}

/**
 * A decision is recent when it was used in one of the last three recorded
 * source sessions.
 */
function isRecentSession(d: Decision, recentSessions: string[]): boolean {
  if (!d.last_used_in_session) return false
  return recentSessions.slice(-3).includes(d.last_used_in_session)
}
