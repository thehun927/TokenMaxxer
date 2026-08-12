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
import { readDiagnosticArtifact, writeDiagnosticArtifact } from "./diagnostics/artifacts"
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

// ─── B1 monotonic last-only publication (module-global for same-process cross-instance ordering) ───
// Captures ordering at hook/event receipt before async history/diagnostic work; history
// retrieval stays outside any filesystem lock; only short per-project/artifact publication
// (mtime/metadata check + atomic write) is serialized. Older observations never replace newer.
let _b1MonotonicSeq = 0
const _b1LastPublishedSeqByKey = new Map<string, number>()
const _b1PublicationQueueByKey = new Map<string, Promise<void>>()
function _b1NextSeq(): number {
  _b1MonotonicSeq += 1
  return _b1MonotonicSeq
}

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

  // B1: per-project/artifact monotonic serialization. History retrieval stays
  // outside; only short publication (mtime/metadata check + atomic write) is
  // serialized per project/artifact. Older observations never replace newer.
  // Fix for stale global guard / timestamp precision: same-process ordering is
  // authoritative via seq+queue; disk mtime/metadata is consulted only when
  // we have no in-memory ordering for this project (last==0) to allow a
  // newer sequential observation in a new plugin instance to win even if
  // filesystem mtime appears slightly newer due to coarse precision or mocked
  // Date.now. This preserves overlapping monotonic while not suppressing
  // normal sequential updates.
  async function b1MonotonicPublish(
    artifactName: "last_compaction_prompt.log" | "last_compaction_result.json",
    seq: number,
    observedAtMs: number,
    publish: () => Promise<void>,
  ): Promise<void> {
    const key = `${project}:${artifactName}`
    const prev = _b1PublicationQueueByKey.get(key) ?? Promise.resolve()
    const next = prev.then(async () => {
      const last = _b1LastPublishedSeqByKey.get(key) ?? 0
      if (seq <= last) return
      // If we already have an in-memory ordering for this project, seq is
      // authoritative — skip disk time checks to avoid false suppression from
      // coarse mtime/observed_at precision or mocked clocks. Disk check is
      // only for the first observation per project in this process (last==0)
      // to provide best-effort cross-process protection.
      if (last !== 0) {
        _b1LastPublishedSeqByKey.set(key, seq)
        try {
          await publish()
        } catch {
          // publication failure remains non-fatal
        }
        return
      }
      try {
        const existing = await readDiagnosticArtifact(artifactName, project)
        if (existing.kind === "ok") {
          if (typeof existing.mtime === "number" && existing.mtime > observedAtMs) {
            _b1LastPublishedSeqByKey.set(key, Math.max(last, seq))
            return
          }
          try {
            let existingTs: number | null = null
            if (artifactName === "last_compaction_result.json") {
              const parsed = JSON.parse(existing.content) as { completed_at?: string }
              if (typeof parsed.completed_at === "string") {
                const t = Date.parse(parsed.completed_at)
                if (!Number.isNaN(t)) existingTs = t
              }
            } else {
              const m = existing.content.match(/^observed_at=(.+)$/m)
              if (m) {
                const t = Date.parse(m[1].trim())
                if (!Number.isNaN(t)) existingTs = t
              }
            }
            if (existingTs !== null && existingTs > observedAtMs) {
              _b1LastPublishedSeqByKey.set(key, Math.max(last, seq))
              return
            }
          } catch {
            // ignore parse errors
          }
        }
      } catch {
        // read failure is non-fatal; proceed with seq ordering
      }
      _b1LastPublishedSeqByKey.set(key, seq)
      try {
        await publish()
      } catch {
        // publication failure remains non-fatal
      }
    }).catch(() => {})
    _b1PublicationQueueByKey.set(key, next)
    await next
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
   * Safely stringify an arbitrary thrown value and bound the TOTAL value to a
   * deterministic character cap. Never throws: a hostile value whose
   * `toString()` throws is replaced with a fixed placeholder so the outer
   * catch seams can never escape through the logging path. Unlike `boundReason`
   * (which appends a truncation suffix on top of the cap), the returned value
   * itself never exceeds `maxLen` characters.
   */
  function boundErrorText(error: unknown, maxLen: number): string {
    let text: string
    try {
      text = error instanceof Error ? error.message : String(error)
    } catch {
      text = "[unknown error]"
    }
    if (text.length <= maxLen) return text
    return `${text.slice(0, maxLen - 3)}...`
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
      // B1: capture ordering at receipt before any async history/diagnostic work
      const promptSeq = _b1NextSeq()
      const promptObservedAtMs = Date.now()
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
          // Replace mode: attempt to recover previous summary (outside lock)
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

        // PR-9 Wave 3: successful completion is represented by the persisted
        // per-project `last_compaction_result.json`, recorded only on
        // `session.compacted`.

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
        // Build artifact outside lock; serialize only short publication.
        let promptArtifactContent: string
        try {
          const artifact = buildCompactionPromptArtifact({
            sessionID: input.sessionID,
            requestedMode,
            effectiveMode,
            fallbackReason: boundedFallbackReason,
            payload: tokenMaxxerPayload,
          })
          promptArtifactContent = artifact.content
        } catch (e) {
          await log(client, "warn", "compaction prompt diagnostic failed", {
            artifact: "last_compaction_prompt.log",
            project,
            error: boundReason(e instanceof Error ? e.message : String(e), 500),
          })
          return
        }

        await b1MonotonicPublish(
          "last_compaction_prompt.log",
          promptSeq,
          promptObservedAtMs,
          async () => {
            try {
              const writeResult = await writeDiagnosticArtifact(
                "last_compaction_prompt.log",
                project,
                promptArtifactContent,
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
          },
        )
      } catch (e) {
        await log(client, "error", "compaction hook failed", {
          error: boundErrorText(e, 500),
        })
      }
    },

    // Layer 2: event handlers
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      try {
        if (event.type === "session.compacted") {
          // B1: capture ordering at event receipt before async history/diagnostic work
          const resultSeq = _b1NextSeq()
          const resultObservedAtMs = Date.now()
          const resultObservedAtIso = new Date(resultObservedAtMs).toISOString()
          const sessionId = event.properties?.sessionID as string | undefined
          if (!sessionId) {
            await log(client, "warn", "session.compacted missing sessionID")
            return
          }
          // History retrieval stays outside any filesystem/STATE lock.
          let summary: CompactionResultSummary
          let historyOk = true
          try {
            const historyResult = await readPreviousCompactionSummary({
              client,
              sessionID: sessionId,
            })
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
          } catch (e) {
            // Keep non-fatal but still record completion with unavailable
            summary = {
              status: "unavailable",
              reason: boundReason(e instanceof Error ? e.message : String(e), 500),
            }
            historyOk = false
            void historyOk
          }
          // Build diagnostic outside lock; completed_at uses observation time for monotonic metadata.
          let resultJson: string
          try {
            const artifact = buildCompactionResultDiagnostic({
              completedAt: resultObservedAtIso,
              sessionID: sessionId,
              summary: summary!,
            })
            resultJson = artifact.json
          } catch (e) {
            await log(client, "warn", "compaction result diagnostic failed", {
              artifact: "last_compaction_result.json",
              project,
              error: boundReason(e instanceof Error ? e.message : String(e), 500),
            })
            return
          }
          // Serialize only short publication (mtime/metadata check + atomic write).
          // Older observations must never replace newer persisted observations;
          // publication failure remains non-fatal and never mutates STATE/revision/IdleWriteOutcome/.commit-pulse.
          await b1MonotonicPublish(
            "last_compaction_result.json",
            resultSeq,
            resultObservedAtMs,
            async () => {
              try {
                const writeResult = await writeDiagnosticArtifact(
                  "last_compaction_result.json",
                  project,
                  resultJson,
                  COMPACTION_RESULT_ARTIFACT_MAX_BYTES,
                )
                if (!writeResult.ok) {
                  await log(client, "warn", "compaction result artifact not persisted", {
                    artifact: "last_compaction_result.json",
                    project,
                    reason: writeResult.reason,
                    sizeBytes: writeResult.sizeBytes,
                    maxBytes: writeResult.maxBytes,
                  })
                }
              } catch (e) {
                await log(client, "warn", "compaction result diagnostic failed", {
                  artifact: "last_compaction_result.json",
                  project,
                  error: boundReason(e instanceof Error ? e.message : String(e), 500),
                })
              }
            },
          )
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
        await log(client, "error", "event handler failed", {
          type: event.type,
          error: boundErrorText(e, 500),
        })
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
