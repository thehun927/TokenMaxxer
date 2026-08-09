/**
 * tokenmaxxer — opencode plugin for session longevity & cross-session memory.
 *
 * Two layers, zero per-project config required:
 * 1. Compaction-quality hook — injects durable state + schema-constrained prompt.
 * 2. Per-project durable memory — written on session.idle and available via
 *    the registered memory tools.
 *
 * See docs/PLAN.md and docs/IMPLEMENTATION.md for full design.
 */
import type { Plugin } from "@opencode-ai/plugin"

import { loadOptions } from "./config"
import { buildCompactionPrompt } from "./compaction/prompt"
import { buildDurableBlock } from "./compaction/durable"
import { writeMemoryOnIdle } from "./memory/writer"
import { isRetainedExtractionSession } from "./memory/extract-llm"
import { resolveProjectPath } from "./memory/store"
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

  const project = resolveProjectPath(worktree, directory)
  // Plugin initialization is intentionally local-only. Diagnostics and
  // version checks belong to event/hook paths; neither config nor a network
  // endpoint is touched before the first session.idle event.

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
          if (isRetainedExtractionSession(sessionId)) return
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

  }
}

export default TokenmaxxerPlugin
