/**
 * Status tool — plugin health check.
 *
 * Implements §7.2 from docs/IMPLEMENTATION.md.
 * Also exports `lastCompactionTimestamp` and `setLastCompaction` so
 * index.ts can update the timestamp when the compaction hook fires.
 */
import { tool } from "@opencode-ai/plugin"
import { readMemory, resolveProjectPath } from "../memory/store"
import { safeRead } from "../util/fs"
import { join } from "node:path"

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
    const mem = await readMemory({
      worktree: context.worktree,
      directory: context.directory,
    })
    const project = resolveProjectPath(context.worktree, context.directory)
    const path = join(project, ".opencode", "memory", "STATE.json")
    const content = await safeRead(path)
    const size = content?.length ?? 0

    return [
      `Project: ${mem?.project_path ?? "none"}`,
      `Memory file: ${path} (${size} bytes)`,
      `Decisions: ${mem?.decisions.length ?? 0} (${mem?.decisions.filter((d) => d.still_valid).length ?? 0} valid)`,
      `Active files: ${mem?.active_files.length ?? 0}`,
      `Last updated: ${mem?.last_updated ?? "never"}`,
      `Last git SHA: ${mem?.last_git_sha ?? "unknown"}`,
      `Last compaction: ${lastCompactionTimestamp ?? "none"}`,
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
