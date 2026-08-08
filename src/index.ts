/**
 * tokenmaxxer — opencode plugin for session longevity & cross-session memory.
 *
 * Two layers:
 * 1. Compaction-quality hook — injects durable state + schema-constrained prompt.
 * 2. Per-project durable memory — written on session.idle, read by recall_* tools.
 *
 * See docs/PLAN.md and docs/IMPLEMENTATION.md for full design.
 */
import type { Plugin } from "@opencode-ai/plugin"

import { loadOptions } from "./config"
import { buildCompactionPrompt } from "./compaction/prompt"
import { buildDurableBlock } from "./compaction/durable"
import { writeMemoryOnIdle, generateHeader } from "./memory/writer"
import { readMemory } from "./memory/store"
import { registerTools } from "./tools/recall"
import { registerEfficiencyTools } from "./tools/efficiency"
import { registerStatusTools, setLastCompaction } from "./tools/status"
import { log } from "./util/log"
import { atomicWrite, safeRead } from "./util/fs"
import { resolveProjectPath } from "./memory/store"
import { join } from "node:path"
import type { CompactionInput, CompactionOutput } from "./types"

export const TokenmaxxerPlugin: Plugin = async (ctx) => {
  const { client, directory, worktree } = ctx
  const options = loadOptions(ctx)

  // --- Diagnostic: confirm plugin loaded + show resolved paths ---
  const project = resolveProjectPath(worktree, directory)
  await log(client, "info", "tokenmaxxer plugin loaded", {
    worktree, directory, resolved: project,
  })

  // --- Version check (warn, don't fail) ---
  try {
    const c = client as { app?: { info?: () => Promise<{ data?: { version?: string } }> } }
    const info = await c.app?.info?.()
    const version = info?.data?.version
    if (version) {
      const major = parseInt(version.split(".")[0] ?? "0", 10)
      if (major < 1) {
        await log(client, "warn", `opencode ${version} may be unsupported (requires >=1.0.0)`)
      }
    }
  } catch {
    // app.info may not exist — non-fatal
  }

  // --- First-session HEADER.md placeholder ---
  // `instructions` in opencode.json may reference .opencode/memory/HEADER.md,
  // which doesn't exist until the first session.idle. Create a placeholder so
  // the instruction glob doesn't reference a missing file on the first session.
  try {
    const project = resolveProjectPath(worktree, directory)
    const headerPath = join(project, ".opencode", "memory", "HEADER.md")
    if ((await safeRead(headerPath)) === null) {
      await atomicWrite(
        headerPath,
        "<!-- tokenmaxxer: no prior memory yet. This file will be populated after your first session. -->\n",
      )
    }
  } catch {
    // Non-fatal — best effort
  }

  // --- Hooks map ---
  return {
    // Layer 1: compaction-quality hook
    "experimental.session.compacting": async (input: CompactionInput, output: CompactionOutput) => {
      try {
        const durable = await buildDurableBlock({ worktree, directory, client })

        if (options.compactionPrompt) {
          // Kill switch ON (default): replace the compaction prompt entirely.
          // When output.prompt is set, output.context is ignored — so the durable
          // block is folded INTO the prompt string by buildCompactionPrompt.
          output.prompt = buildCompactionPrompt(durable)
        } else {
          // Kill switch OFF (TOKENMAXXER_NO_PROMPT=1): inject durable block via
          // context, keep opencode's default compaction prompt.
          output.context.push(durable)
        }

        // Record compaction timestamp for the status tool
        setLastCompaction(new Date().toISOString())

        // Dump the injected prompt for debugging (best effort)
        try {
          const project = resolveProjectPath(worktree, directory)
          const logPath = join(project, ".opencode", "memory", "last_compaction.log")
          const entry = `[${new Date().toISOString()}] session=${input.sessionID}\n${output.prompt ?? "(durable via context)"}\n---\n`
          await atomicWrite(logPath, entry)
        } catch {
          // Non-fatal
        }
      } catch (e) {
        await log(client, "error", "compaction hook failed", { error: String(e) })
        // On failure, do nothing — let opencode use its default compaction
      }
    },

    // Layer 2: event handlers
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      try {
        if (event.type === "session.idle") {
          // EventSessionIdle.properties = { sessionID: string } (flat — verified)
          const sessionId = event.properties?.sessionID as string | undefined
          if (!sessionId) {
            await log(client, "warn", "session.idle missing sessionID")
            return
          }
          await writeMemoryOnIdle({ client, worktree, directory, sessionId })
        } else if (event.type === "session.created") {
          // EventSessionCreated.properties = { info: Session } — sessionID on info.id
          // No action needed for v1 — HEADER.md (in instructions) handles session-start.
          // The system.transform alternative path is wired below if enabled.
        }
      } catch (e) {
        await log(client, "error", "event handler failed", { type: event.type, error: String(e) })
      }
    },

    // Layer 2: custom tools (recall + efficiency + status)
    ...registerTools(ctx),
    ...registerEfficiencyTools(),
    ...registerStatusTools(),

    // Alternative header-injection path (experimental, undocumented).
    // Only active when options.headerInjection === "system_transform".
    // Falls back to the documented `instructions` + HEADER.md path otherwise.
    ...(options.headerInjection === "system_transform"
      ? {
          "experimental.chat.system.transform": async (
            _input: unknown,
            output: { system: string[] },
          ) => {
            try {
              const mem = await readMemory({ worktree, directory })
              if (!mem) return
              output.system.push(
                `Project: ${mem.project_path} | Last: ${mem.last_updated} (SHA ${mem.last_git_sha ?? "?"}) | Task: ${mem.current_task ?? "—"} | Call get_project_state for details.`,
              )
            } catch (e) {
              await log(client, "error", "system.transform failed", { error: String(e) })
            }
          },
        }
      : {}),
  }
}

export default TokenmaxxerPlugin