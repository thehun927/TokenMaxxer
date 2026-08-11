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
import { buildCompactionAugmentation, buildCompactionPrompt } from "./compaction/prompt"
import { buildDurableBlock } from "./compaction/durable"
import { readPreviousCompactionSummary } from "./compaction/history"
import { writeMemoryOnIdle } from "./memory/writer"
import {
  isPersistedRetainedExtractionSession,
  isRetainedExtractionSession,
} from "./memory/extract-llm"
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

  /**
   * Bound arbitrary fallback/error text to a deterministic character cap.
   * Preserves the first `maxLen` characters and adds a truncation suffix when
   * the original exceeds the cap so diagnostics never consume unbounded
   * storage from an arbitrary host error message.
   */
  function boundReason(reason: string, maxLen: number): string {
    if (reason.length <= maxLen) return reason
    return reason.slice(0, maxLen) + `... [truncated ${reason.length - maxLen} chars]`
  }

  // --- Hooks map ---
  return {
    // Layer 1: compaction-quality hook
    "experimental.session.compacting": async (input: CompactionInput, output: CompactionOutput) => {
      try {
        const durable = (await buildDurableBlock({ worktree, directory, client })) ?? ""
        const requestedMode = process.env.TOKENMAXXER_COMPACTION_MODE
          ?? (process.env.TOKENMAXXER_NO_PROMPT === "1"
            ? "augment"
            : process.env.TOKENMAXXER_NO_PROMPT === "0"
              ? "replace"
              : "unset")

        // PR 7: route through the explicit compaction mode.
        let effectiveMode = options.compactionMode
        let fallbackReason: string | undefined

        // Capture the exact TokenMaxxer-supplied payload for diagnostics.
        // In replace mode this is buildCompactionPrompt(...); in augment/fallback
        // it is buildCompactionAugmentation(durable). Never use raw durable.
        let tokenMaxxerPayload: string

        if (options.compactionMode === "replace") {
          // Replace mode: attempt to recover previous summary
          const historyResult = await readPreviousCompactionSummary({
            client,
            sessionID: input.sessionID,
          })

          if (historyResult.status === "found") {
            // Sanitize recovered summary before interpolation
            const { sanitizePreviousSummary } = await import("./compaction/sanitize")
            const sanitizedSummary = sanitizePreviousSummary(historyResult.summary)

            // Build replacement prompt with previous-summary anchor
            output.prompt = buildCompactionPrompt({
              durableContext: durable,
              previousSummary: sanitizedSummary,
            })
            tokenMaxxerPayload = output.prompt!
          } else if (historyResult.status === "none") {
            // First compaction: no prior summary, proceed without anchor
            output.prompt = buildCompactionPrompt({
              durableContext: durable,
            })
            tokenMaxxerPayload = output.prompt!
          } else {
            // historyResult.status === "unavailable": fallback to augment
            effectiveMode = "augment"
            fallbackReason = historyResult.reason

            // Fallback to augment: append context, leave prompt unset
            const augmentation = buildCompactionAugmentation(durable)
            output.context.push(augmentation)
            tokenMaxxerPayload = augmentation
            // output.prompt remains undefined (native augmentation)
          }

          // Preserve pre-existing context entries (do not erase)
          // output.context already contains any pre-existing entries
        } else {
          // Augment mode (default): append context, leave prompt unset
          // Preserve pre-existing context entries
          const augmentation = buildCompactionAugmentation(durable)
          output.context.push(augmentation)
          tokenMaxxerPayload = augmentation
          // output.prompt remains undefined (native augmentation)
        }

        setLastCompaction(new Date().toISOString())

        await log(client, "info", "compaction hook fired", {
          session: input.sessionID,
          requested_mode: requestedMode,
          effective_mode: effectiveMode,
          durableLength: durable.length,
          ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
        })

        // last_compaction_prompt.log is intentionally a last-only snapshot, not a
        // history. Atomic replacement ensures successive hooks leave only the
        // newest compaction payload visible to diagnostics.
        try {
          const logPath = join(project, ".opencode", "memory", "last_compaction_prompt.log")
          const snapshotLines = [
            `timestamp=${new Date().toISOString()}`,
            `session=${input.sessionID}`,
            `requested_mode=${requestedMode}`,
            `effective_mode=${effectiveMode}`,
            `kind=${effectiveMode === "replace" ? "replacement-prompt" : "context-augmentation"}`,
            ...(fallbackReason ? [`fallback_reason=${boundReason(fallbackReason, 500)}`] : []),
            tokenMaxxerPayload,
            "---",
            "",
          ]
          const snapshot = snapshotLines.join("\n")
          await atomicWrite(logPath, snapshot)
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
          // The process-local guard is fast, but the durable v2 guard is what
          // prevents a retained audit from re-entering after plugin reload.
          if (await isPersistedRetainedExtractionSession({
            sessionID: sessionId,
            worktree,
            directory,
          })) return
          await writeMemoryOnIdle({ client, worktree, directory, sessionId })
        }
      } catch (e) {
        await log(client, "error", "event handler failed", { type: event.type, error: String(e) })
      }
    },

    // Layer 2: custom tools (recall + efficiency + status). Every register*
    // helper returns a `{ tool: {...} }` wrapper, so the maps are merged into
    // the single Hooks `tool` map. Spreading the wrappers into the top-level
    // return instead would let the last `tool` key clobber the earlier ones
    // (only `tokenmaxxer_status` would survive).
    tool: {
      ...registerTools(ctx).tool,
      // PR 4 §6: the legitimate `PluginInput["client"]` is injected into the
      // efficiency tools by closure. A `ToolContext` never carries a client.
      ...registerEfficiencyTools(client).tool,
      ...registerStatusTools().tool,
    },

  }
}

export default TokenmaxxerPlugin
