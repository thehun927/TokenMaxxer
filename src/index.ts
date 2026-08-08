/**
 * tokenmaxxer — opencode plugin for session longevity & cross-session memory.
 *
 * Two layers, zero per-project config required:
 * 1. Compaction-quality hook — injects durable state + schema-constrained prompt.
 * 2. Per-project durable memory — written on session.idle, injected via
 *    experimental.chat.system.transform (no `instructions` config needed).
 *
 * See docs/PLAN.md and docs/IMPLEMENTATION.md for full design.
 */
import type { Plugin } from "@opencode-ai/plugin"

import { loadOptions } from "./config"
import { buildCompactionPrompt } from "./compaction/prompt"
import { buildDurableBlock } from "./compaction/durable"
import { writeMemoryOnIdle } from "./memory/writer"
import { readMemory, resolveProjectPath } from "./memory/store"
import { registerTools } from "./tools/recall"
import { registerEfficiencyTools } from "./tools/efficiency"
import { registerStatusTools, setLastCompaction } from "./tools/status"
import { log } from "./util/log"
import { atomicWrite, safeRead } from "./util/fs"
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

  // --- Config check: recommend prune + watcher.ignore (best effort) ---
  try {
    const c = client as { config?: { get?: () => Promise<{ data?: { compaction?: { prune?: boolean }; watcher?: { ignore?: string[] } } }> } }
    const config = await c.config?.get?.()
    const cfg = config?.data
    if (cfg?.compaction && !cfg.compaction.prune) {
      await log(client, "warn", "compaction.prune is not enabled — recommend setting it to true for better token efficiency")
    }
  } catch {
    // config.get may not exist — non-fatal
  }

  // --- First-session HEADER.md placeholder ---
  // Create the memory directory + placeholder HEADER.md on plugin init.
  // This ensures the directory exists for STATE.json writes later.
  try {
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
          output.prompt = buildCompactionPrompt(durable)
        } else {
          // Kill switch: inject durable block via context, keep default prompt
          output.context.push(durable)
        }

        setLastCompaction(new Date().toISOString())

        await log(client, "info", "compaction hook fired", {
          session: input.sessionID,
          promptReplaced: options.compactionPrompt,
          durableLength: durable.length,
        })

        // Dump the injected prompt for debugging (best effort)
        try {
          const logPath = join(project, ".opencode", "memory", "last_compaction.log")
          const entry = `[${new Date().toISOString()}] session=${input.sessionID}\n${output.prompt ?? "(durable via context)"}\n---\n`
          await atomicWrite(logPath, entry)
        } catch {
          // Non-fatal
        }
      } catch (e) {
        await log(client, "error", "compaction hook failed", { error: String(e) })
      }
    },

    // Layer 2: event handlers
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      try {
        if (event.type === "session.idle") {
          const sessionId = event.properties?.sessionID as string | undefined
          if (!sessionId) {
            await log(client, "warn", "session.idle missing sessionID")
            return
          }
          await writeMemoryOnIdle({ client, worktree, directory, sessionId })
        }
      } catch (e) {
        await log(client, "error", "event handler failed", { type: event.type, error: String(e) })
      }
    },

    // Layer 2: custom tools (recall + efficiency + status)
    ...registerTools(ctx),
    ...registerEfficiencyTools(),
    ...registerStatusTools(),

    // Layer 2: system prompt injection (zero-config — no `instructions` needed)
    // This experimental hook fires when the system prompt is built (every session,
    // every step). It pushes a brief instruction + project memory header into the
    // system prompt, so the model always knows about the tools and sees prior
    // project state. If the hook doesn't exist in the opencode version, it's
    // silently ignored — the tools still work, the model just won't get the hint.
    "experimental.chat.system.transform": async (
      _input: unknown,
      output: { system: string[] },
    ) => {
      try {
        // Always push a tool-usage hint so the model knows to call get_project_state
        output.system.push(
          "tokenmaxxer: This project has cross-session memory. Call get_project_state at session start to load prior decisions, active files, and next steps.",
        )

        // If memory exists, push the project header too
        const mem = await readMemory({ worktree, directory })
        if (mem) {
          output.system.push(
            `Project: ${mem.project_path} | Last: ${mem.last_updated} (SHA ${mem.last_git_sha ?? "?"}) | Task: ${mem.current_task ?? "—"} | Decisions: ${mem.decisions.filter((d) => d.still_valid).length} valid | Call get_project_state for details.`,
          )
        }
      } catch (e) {
        await log(client, "error", "system.transform failed", { error: String(e) })
      }
    },
  }
}

export default TokenmaxxerPlugin