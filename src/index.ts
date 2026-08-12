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
import { registerStatusTools } from "./tools/status"
import { writeDiagnosticArtifact } from "./diagnostics/artifacts"
import {
  COMPACTION_PROMPT_ARTIFACT_MAX_BYTES,
  COMPACTION_RESULT_ARTIFACT_MAX_BYTES,
  buildCompactionPromptArtifact,
  buildCompactionResultDiagnostic,
} from "./diagnostics/compaction"
import type { CompactionResultSummary } from "./diagnostics/compaction"
import { log } from "./util/log"
import { atomicWrite, safeRead } from "./util/fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
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

  /**
   * Best-effort persistence of the successful `session.compacted` observation.
   *
   * The host emits `session.compacted` only after successful compaction
   * processing, so it is the authority for completion. We re-read the session
   * transcript through the verified PR-7 summary path to attach bounded
   * metadata (UTF-8 byte count + SHA-256 only; the summary body and
   * conversation are never persisted). A missing/unavailable summary still
   * records successful completion, and a diagnostic write failure never
   * throws from the event handler, never touches STATE, never advances a
   * revision, never alters IdleWriteOutcome, and never pulses TUI.
   */
  async function recordCompactionResultBestEffort(opts: {
    client: unknown
    project: string
    sessionID: string
  }): Promise<void> {
    try {
      const historyResult = await readPreviousCompactionSummary({
        client: opts.client,
        sessionID: opts.sessionID,
      })

      let summary: CompactionResultSummary
      if (historyResult.status === "found") {
        summary = {
          status: "found",
          bytes: Buffer.byteLength(historyResult.summary, "utf8"),
          sha256: createHash("sha256").update(historyResult.summary, "utf8").digest("hex"),
        }
      } else if (historyResult.status === "none") {
        summary = { status: "missing" }
      } else {
        summary = { status: "unavailable", reason: historyResult.reason }
      }

      const artifact = buildCompactionResultDiagnostic({
        completedAt: new Date().toISOString(),
        sessionID: opts.sessionID,
        summary,
      })

      const writeResult = await writeDiagnosticArtifact(
        "last_compaction_result.json",
        opts.project,
        artifact.json,
        COMPACTION_RESULT_ARTIFACT_MAX_BYTES,
      )
      if (!writeResult.ok) {
        // Bounded warning only — never log the summary body or session text.
        await log(opts.client, "warn", "compaction result artifact not persisted", {
          artifact: "last_compaction_result.json",
          project: opts.project,
          reason: writeResult.reason,
          sizeBytes: writeResult.sizeBytes,
          maxBytes: writeResult.maxBytes,
        })
      }
    } catch (e) {
      await log(opts.client, "warn", "compaction result diagnostic failed", {
        artifact: "last_compaction_result.json",
        project: opts.project,
        error: boundReason(e instanceof Error ? e.message : String(e), 500),
      })
    }
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

        // PR 7 B3: bound the fallback reason exactly once and reuse the same
        // value in both diagnostics — the structured app.log metadata
        // (extra.fallback_reason) and the file snapshot — so no unbounded host
        // error text reaches either path.
        const boundedFallbackReason = fallbackReason
          ? boundReason(fallbackReason, 500)
          : undefined

        // PR-9 Wave 3: the process-global last-compaction timestamp/setter
        // (`lastCompactionTimestamp` / `setLastCompaction`) is not used here;
        // the successful-completion observation is the persisted per-project
        // `last_compaction_result.json`, recorded only on `session.compacted`.

        await log(client, "info", "compaction hook fired", {
          session: input.sessionID,
          requested_mode: requestedMode,
          effective_mode: effectiveMode,
          durableLength: durable.length,
          ...(boundedFallbackReason ? { fallback_reason: boundedFallbackReason } : {}),
        })

        // last_compaction_prompt.log is intentionally a last-only snapshot, not a
        // history. The prompt artifact records the exact TokenMaxxer-supplied
        // payload for this hook invocation and is bounded to 96 KiB UTF-8 bytes
        // with UTF-8-safe truncation of the stored diagnostic copy only. A
        // persistence failure is a bounded warning and never changes the
        // compaction hook output.
        try {
          const artifact = buildCompactionPromptArtifact({
            sessionID: input.sessionID,
            requestedMode,
            effectiveMode,
            fallbackReason: boundedFallbackReason,
            payload: tokenMaxxerPayload,
          })
          const writeResult = await writeDiagnosticArtifact(
            "last_compaction_prompt.log",
            project,
            artifact.content,
            COMPACTION_PROMPT_ARTIFACT_MAX_BYTES,
          )
          if (!writeResult.ok) {
            // Bounded warning only — never log the prompt body.
            await log(client, "warn", "compaction prompt artifact not persisted", {
              artifact: "last_compaction_prompt.log",
              project,
              reason: writeResult.reason,
              sizeBytes: writeResult.sizeBytes,
              maxBytes: writeResult.maxBytes,
            })
          }
        } catch (e) {
          await log(client, "warn", "compaction prompt diagnostic failed", {
            artifact: "last_compaction_prompt.log",
            project,
            error: boundReason(e instanceof Error ? e.message : String(e), 500),
          })
        }
      } catch (e) {
        await log(client, "error", "compaction hook failed", { error: String(e) })
      }
    },

    // Layer 2: event handlers
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      try {
        if (event.type === "session.compacted") {
          const sessionId = event.properties?.sessionID as string | undefined
          if (!sessionId) {
            await log(client, "warn", "session.compacted missing sessionID")
            return
          }
          // The host event proves successful completion. The result artifact
          // is written only here, never from the pre-compaction hook. This
          // path must not call writeMemoryOnIdle, change STATE, advance a
          // revision, or pulse TUI.
          await recordCompactionResultBestEffort({ client, project, sessionID: sessionId })
          return
        }
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
