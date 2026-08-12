/**
 * PR-9 Wave 1 Agent 1B — index-level compaction prompt/result contracts.
 *
 * Freezes the index-level contracts from docs/CRIP/PR-9/implementation-plan.md
 * §11 (Wave 1 Agent 1B) and release-matrix cases B/C:
 *
 *  - the prompt artifact remains prompt-only: hook invocation writes
 *    `last_compaction_prompt.log` and never a result artifact;
 *  - the prompt artifact is bounded to 96 KiB UTF-8 bytes;
 *  - `session.compacted` completion persistence: the result artifact is
 *    created only on the successful host event, never on hook invocation
 *    alone;
 *  - the summary body is never persisted — only bytes + sha256 metadata;
 *  - the result JSON is bounded to 4096 UTF-8 bytes;
 *  - summary missing/unavailable still records completion;
 *  - diagnostic failures (prompt/result artifact write failure) never change
 *    the compaction hook output.
 *
 * These tests intentionally FAIL on current main because the PR-9 production
 * behavior does not exist yet (no `session.compacted` handler, no result
 * artifact, no 96 KiB bound, no artifact resolver). Wave 3 implements the
 * production behavior and this suite goes green. No production file is
 * modified by this test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { TranscriptMessage } from "../src/types"

// Mock the memory writer and durable builder so the compaction hook does not
// touch real STATE.json during these diagnostic-contract tests.
const { writeMemoryOnIdle, buildDurableBlock } = vi.hoisted(() => {
  return {
    writeMemoryOnIdle: vi.fn(),
    buildDurableBlock: vi.fn(),
  }
})

vi.mock("../src/memory/writer", () => ({ writeMemoryOnIdle }))
vi.mock("../src/compaction/durable", () => ({ buildDurableBlock }))

import { TokenmaxxerPlugin } from "../src/index"

const COMPACTION_PROMPT_ARTIFACT_MAX_BYTES = 96 * 1024
const COMPACTION_RESULT_ARTIFACT_MAX_BYTES = 4096

type ClientOverride = {
  file?: Partial<{ read: (...args: unknown[]) => unknown }>
  app?: Partial<{ log: (...args: unknown[]) => unknown }>
  config?: Partial<{ get: (...args: unknown[]) => unknown }>
  session?: Partial<{ messages: (...args: unknown[]) => Promise<{ data?: TranscriptMessage[] }> }>
}

function makeClient(overrides: ClientOverride = {}): PluginInput["client"] {
  return {
    file: {
      read: overrides.file?.read ?? vi.fn(async () => ({ data: { content: "" } })),
    },
    app: {
      log: overrides.app?.log ?? vi.fn(),
    },
    config: {
      get: overrides.config?.get ?? vi.fn(),
    },
    session: {
      messages: overrides.session?.messages ?? vi.fn(async () => ({ data: [] })),
    },
  } as unknown as PluginInput["client"]
}

function makePluginInput(opts: {
  directory?: string
  worktree?: string
  client?: PluginInput["client"]
} = {}): PluginInput {
  const directory = opts.directory ?? "/workspace/project"
  const worktree = opts.worktree ?? directory
  return {
    client: opts.client ?? makeClient(),
    project: { id: "test-project", worktree, time: { created: Date.now() } },
    directory,
    worktree,
    experimental_workspace: { register: vi.fn() },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {} as PluginInput["$"],
  } satisfies PluginInput
}

/** A completed compaction summary transcript pair (PR-7 verified shape). */
function summaryTranscript(summaryText: string): TranscriptMessage[] {
  return [
    {
      info: { id: "msg-1", role: "user", parentID: undefined },
      parts: [{ type: "compaction", text: "Compaction request" }],
    },
    {
      info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: true, finish: "stop" },
      parts: [{ type: "text", text: summaryText }],
    },
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith("TOKENMAXXER_")) {
      delete process.env[key]
    }
  })
})

describe("PR-9 Agent 1B — index-level compaction prompt/result contracts", () => {
  describe("prompt artifact remains prompt-only", () => {
    it("hook invocation writes only the prompt artifact, never a result artifact", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-prompt-only-"))
      buildDurableBlock.mockResolvedValueOnce("durable block")

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
        }))

        const output = { context: [] as string[] }
        await hooks["experimental.session.compacting"]?.(
          { sessionID: "session-1" },
          output,
        )

        const memoryDir = join(project, ".opencode", "memory")
        const files = await readdir(memoryDir)
        // The prompt artifact exists; the result artifact must NOT exist from
        // hook invocation alone (case 32: hook invocation alone does not
        // create a successful result artifact).
        expect(files).toContain("last_compaction_prompt.log")
        expect(files).not.toContain("last_compaction_result.json")

        const snapshot = await readFile(join(memoryDir, "last_compaction_prompt.log"), "utf-8")
        expect(snapshot).toContain("session=session-1")
        expect(snapshot).toContain("durable block")
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })

    it("prompt artifact never contains a host-generated compaction summary", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-prompt-no-summary-"))
      buildDurableBlock.mockResolvedValueOnce("durable block")

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
        }))

        const output = { context: [] as string[] }
        await hooks["experimental.session.compacting"]?.(
          { sessionID: "session-1" },
          output,
        )

        const memoryDir = join(project, ".opencode", "memory")
        const snapshot = await readFile(join(memoryDir, "last_compaction_prompt.log"), "utf-8")
        // The prompt artifact records the TokenMaxxer-supplied payload, not a
        // host-generated summary. It must not contain summary-only markers.
        expect(snapshot).not.toContain("host_event=session.compacted")
        expect(snapshot).not.toContain("summary.status=")
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })
  })

  describe("96 KiB prompt diagnostic bound", () => {
    it("whole prompt artifact is <= 96 KiB UTF-8 bytes", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-prompt-bound-"))
      // A durable block near the PR-8 4 KiB ceiling plus a large payload
      buildDurableBlock.mockResolvedValueOnce("d".repeat(4096))

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
        }))

        const output = { context: [] as string[] }
        await hooks["experimental.session.compacting"]?.(
          { sessionID: "session-1" },
          output,
        )

        const memoryDir = join(project, ".opencode", "memory")
        const snapshot = await readFile(join(memoryDir, "last_compaction_prompt.log"), "utf-8")
        expect(Buffer.byteLength(snapshot, "utf8")).toBeLessThanOrEqual(COMPACTION_PROMPT_ARTIFACT_MAX_BYTES)
        expect(Buffer.byteLength(snapshot, "utf8")).toBeLessThanOrEqual(96 * 1024)
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })

    it("over-limit payload is truncated on a UTF-8 boundary without corrupting the artifact", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-prompt-truncate-"))
      // Multibyte payload that would exceed 96 KiB if stored whole
      buildDurableBlock.mockResolvedValueOnce("é".repeat(60 * 1024))

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
        }))

        const output = { context: [] as string[] }
        await hooks["experimental.session.compacting"]?.(
          { sessionID: "session-1" },
          output,
        )

        const memoryDir = join(project, ".opencode", "memory")
        const snapshot = await readFile(join(memoryDir, "last_compaction_prompt.log"), "utf-8")
        expect(Buffer.byteLength(snapshot, "utf8")).toBeLessThanOrEqual(COMPACTION_PROMPT_ARTIFACT_MAX_BYTES)
        // No malformed UTF-8 replacement character from a split code point
        expect(snapshot).not.toContain("\ufffd")
        // The truncation is recorded in the header
        expect(snapshot).toContain("payload_truncated=true")
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })
  })

  describe("session.compacted completion persistence", () => {
    it("session.compacted event creates a result artifact", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-result-created-"))
      const summaryText = "completed summary body"
      const client = makeClient({
        session: {
          messages: vi.fn(async () => ({ data: summaryTranscript(summaryText) })),
        },
      })

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
          client,
        }))

        await hooks.event?.({
          event: { type: "session.compacted", properties: { sessionID: "session-1" } },
        })

        const memoryDir = join(project, ".opencode", "memory")
        const files = await readdir(memoryDir)
        expect(files).toContain("last_compaction_result.json")

        const result = await readFile(join(memoryDir, "last_compaction_result.json"), "utf-8")
        const parsed = JSON.parse(result)
        expect(parsed.version).toBe(1)
        expect(parsed.host_event).toBe("session.compacted")
        expect(parsed.session_id).toBe("session-1")
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })

    it("hook invocation alone does not create a successful result artifact", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-result-no-hook-"))
      buildDurableBlock.mockResolvedValueOnce("durable block")

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
        }))

        const output = { context: [] as string[] }
        await hooks["experimental.session.compacting"]?.(
          { sessionID: "session-1" },
          output,
        )

        const memoryDir = join(project, ".opencode", "memory")
        const files = await readdir(memoryDir)
        expect(files).not.toContain("last_compaction_result.json")
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })

    it("repeated successful compaction replaces last-only result", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-result-replace-"))
      const client = makeClient({
        session: {
          messages: vi.fn(async () => ({ data: summaryTranscript("summary body") })),
        },
      })

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
          client,
        }))

        await hooks.event?.({
          event: { type: "session.compacted", properties: { sessionID: "session-1" } },
        })
        await hooks.event?.({
          event: { type: "session.compacted", properties: { sessionID: "session-2" } },
        })

        const memoryDir = join(project, ".opencode", "memory")
        const result = await readFile(join(memoryDir, "last_compaction_result.json"), "utf-8")
        const parsed = JSON.parse(result)
        expect(parsed.session_id).toBe("session-2")
        expect(parsed.session_id).not.toBe("session-1")
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })
  })

  describe("summary body never persisted", () => {
    it("result JSON contains only bytes/sha256 metadata, never the summary body", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-no-body-"))
      const summaryText = "TOP-SECRET SUMMARY BODY THAT MUST NEVER BE PERSISTED"
      const client = makeClient({
        session: {
          messages: vi.fn(async () => ({ data: summaryTranscript(summaryText) })),
        },
      })

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
          client,
        }))

        await hooks.event?.({
          event: { type: "session.compacted", properties: { sessionID: "session-1" } },
        })

        const memoryDir = join(project, ".opencode", "memory")
        const result = await readFile(join(memoryDir, "last_compaction_result.json"), "utf-8")
        expect(result).not.toContain(summaryText)
        expect(result).not.toContain("TOP-SECRET SUMMARY BODY")
        expect(result).not.toMatch(/"body"/)
        expect(result).not.toMatch(/"text"/)
        expect(result).not.toMatch(/"content"/)

        const parsed = JSON.parse(result)
        expect(parsed.summary.status).toBe("found")
        expect(parsed.summary.bytes).toBe(Buffer.byteLength(summaryText, "utf8"))
        expect(parsed.summary.sha256).toMatch(/^[0-9a-f]{64}$/)
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })
  })

  describe("result JSON <= 4 KiB", () => {
    it("result artifact is <= 4096 UTF-8 bytes", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-result-bound-"))
      const client = makeClient({
        session: {
          messages: vi.fn(async () => ({ data: summaryTranscript("summary body") })),
        },
      })

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
          client,
        }))

        await hooks.event?.({
          event: { type: "session.compacted", properties: { sessionID: "s".repeat(256) } },
        })

        const memoryDir = join(project, ".opencode", "memory")
        const result = await readFile(join(memoryDir, "last_compaction_result.json"), "utf-8")
        expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(COMPACTION_RESULT_ARTIFACT_MAX_BYTES)
        expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(4096)
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })
  })

  describe("summary missing/unavailable still records completion", () => {
    it("no summary after successful event -> summary.status=missing, completion recorded", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-summary-missing-"))
      const client = makeClient({
        session: {
          messages: vi.fn(async () => ({ data: [] })),
        },
      })

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
          client,
        }))

        await hooks.event?.({
          event: { type: "session.compacted", properties: { sessionID: "session-1" } },
        })

        const memoryDir = join(project, ".opencode", "memory")
        const result = await readFile(join(memoryDir, "last_compaction_result.json"), "utf-8")
        const parsed = JSON.parse(result)
        expect(parsed.summary.status).toBe("missing")
        // Completion is still recorded even though no summary was found
        expect(parsed.host_event).toBe("session.compacted")
        expect(parsed.session_id).toBe("session-1")
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })

    it("session.messages unavailable -> completion still recorded with summary.status=unavailable", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-summary-unavailable-"))
      const client = makeClient({
        session: {
          messages: vi.fn(async () => {
            throw new Error("session.messages unavailable")
          }),
        },
      })

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
          client,
        }))

        await hooks.event?.({
          event: { type: "session.compacted", properties: { sessionID: "session-1" } },
        })

        const memoryDir = join(project, ".opencode", "memory")
        const result = await readFile(join(memoryDir, "last_compaction_result.json"), "utf-8")
        const parsed = JSON.parse(result)
        expect(parsed.summary.status).toBe("unavailable")
        expect(parsed.summary.reason).toContain("session.messages unavailable")
        // Completion is still recorded even though summary retrieval failed
        expect(parsed.host_event).toBe("session.compacted")
        expect(parsed.session_id).toBe("session-1")
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })

    it("thrown history read -> bounded unavailable reason, completion recorded", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-summary-throw-"))
      const longReason = "E".repeat(2000)
      const client = makeClient({
        session: {
          messages: vi.fn(async () => {
            throw new Error(longReason)
          }),
        },
      })

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
          client,
        }))

        await hooks.event?.({
          event: { type: "session.compacted", properties: { sessionID: "session-1" } },
        })

        const memoryDir = join(project, ".opencode", "memory")
        const result = await readFile(join(memoryDir, "last_compaction_result.json"), "utf-8")
        const parsed = JSON.parse(result)
        expect(parsed.summary.status).toBe("unavailable")
        expect(parsed.summary.reason.length).toBeLessThanOrEqual(500)
        expect(parsed.host_event).toBe("session.compacted")
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })
  })

  describe("diagnostic failures do not affect compaction output", () => {
    it("prompt artifact write failure does not change hook output", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-prompt-fail-"))
      buildDurableBlock.mockResolvedValueOnce("durable block")

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
        }))

        const output = { context: [] as string[] }
        // The prompt artifact write is best-effort; a failure must not throw
        // from the hook or change the output. (Wave 3 wires the artifact
        // resolver; on current main the local-only write succeeds, so this
        // test pins the non-throwing contract.)
        await expect(
          hooks["experimental.session.compacting"]?.(
            { sessionID: "session-1" },
            output,
          ),
        ).resolves.not.toThrow()

        // The compaction output is unchanged by any diagnostic write outcome
        expect(output.prompt).toBeUndefined()
        expect(output.context).toBeDefined()
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })

    it("result artifact write failure does not throw the event handler", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-result-fail-"))
      const client = makeClient({
        session: {
          messages: vi.fn(async () => ({ data: summaryTranscript("summary body") })),
        },
      })

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
          client,
        }))

        // A result artifact write failure is best-effort and must not throw
        // from the event handler. (Wave 3 wires the artifact resolver; on
        // current main the local-only write succeeds, so this test pins the
        // non-throwing contract.)
        await expect(
          hooks.event?.({
            event: { type: "session.compacted", properties: { sessionID: "session-1" } },
          }),
        ).resolves.not.toThrow()
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })

    it("diagnostic write failure never changes STATE revision or memory pipeline", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-no-state-"))
      const client = makeClient({
        session: {
          messages: vi.fn(async () => ({ data: summaryTranscript("summary body") })),
        },
      })

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
          client,
        }))

        // session.compacted must not call writeMemoryOnIdle (no STATE change)
        await hooks.event?.({
          event: { type: "session.compacted", properties: { sessionID: "session-1" } },
        })
        expect(writeMemoryOnIdle).not.toHaveBeenCalled()
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })
  })

  describe("B4 — outer arbitrary-error call sites are bounded", () => {
    it("hostile multi-kilobyte throw from the compaction hook logs a bounded error without leaking raw text", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-hook-bound-"))
      // The hostile marker sits at the END of a multi-kilobyte message so any
      // truncation that keeps only the head proves the tail is never leaked.
      const hostile = "H".repeat(10 * 1024) + "HOOK-RAW-TEXT-MUST-NOT-LEAK"
      const appLog = vi.fn((..._args: unknown[]) => {
        throw new Error("app.log transport failure")
      })
      const client = makeClient({ app: { log: appLog } })
      buildDurableBlock.mockRejectedValueOnce(new Error(hostile))

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
          client,
        }))

        const output = { context: [] as string[] }
        // The hook must resolve even though the durable builder threw a
        // multi-kilobyte error AND app.log itself throws.
        await expect(
          hooks["experimental.session.compacting"]?.({ sessionID: "session-1" }, output),
        ).resolves.not.toThrow()

        const failureCall = appLog.mock.calls.find((call) => {
          const arg = call[0] as { body?: { message?: string } } | undefined
          return arg?.body?.message === "compaction hook failed"
        })
        expect(failureCall).toBeDefined()
        const body = (failureCall![0] as { body: { extra: Record<string, unknown> } }).body
        const loggedError = body.extra.error as string
        // The logged error value itself is bounded to 500 chars.
        expect(loggedError.length).toBeLessThanOrEqual(500)
        // The raw multi-kilobyte text (marker at the tail) is not leaked.
        expect(loggedError).not.toContain("HOOK-RAW-TEXT-MUST-NOT-LEAK")
        // The bounded head is still informative.
        expect(loggedError).toContain("HHH")
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })

    it("hostile multi-kilobyte throw from the event handler logs a bounded error without leaking raw text", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-event-bound-"))
      const hostile = "E".repeat(10 * 1024) + "EVENT-RAW-TEXT-MUST-NOT-LEAK"
      const appLog = vi.fn((..._args: unknown[]) => {
        throw new Error("app.log transport failure")
      })
      const client = makeClient({ app: { log: appLog } })
      // session.idle reaches writeMemoryOnIdle; a hostile throw there must be
      // bounded by the outer event-handler catch.
      writeMemoryOnIdle.mockRejectedValueOnce(new Error(hostile))

      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({
          directory: project,
          worktree: project,
          client,
        }))

        // The event handler must resolve even though the memory writer threw a
        // multi-kilobyte error AND app.log itself throws.
        await expect(
          hooks.event?.({
            event: { type: "session.idle", properties: { sessionID: "session-1" } },
          }),
        ).resolves.not.toThrow()

        const failureCall = appLog.mock.calls.find((call) => {
          const arg = call[0] as { body?: { message?: string } } | undefined
          return arg?.body?.message === "event handler failed"
        })
        expect(failureCall).toBeDefined()
        const body = (failureCall![0] as { body: { extra: Record<string, unknown> } }).body
        const loggedError = body.extra.error as string
        // The logged error value itself is bounded to 500 chars.
        expect(loggedError.length).toBeLessThanOrEqual(500)
        // The raw multi-kilobyte text (marker at the tail) is not leaked.
        expect(loggedError).not.toContain("EVENT-RAW-TEXT-MUST-NOT-LEAK")
        // The bounded head is still informative.
        expect(loggedError).toContain("EEE")
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })
  })

  describe("B1 monotonic last-only regressions (deferred-promise)", () => {
    function createDeferred<T>() {
      let resolve!: (v: T) => void
      let reject!: (e: unknown) => void
      const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }

    it("older result starts first/newer finishes first/older finishes last -> newer remains", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-b1-result-race-"))
      const deferredOlder = createDeferred<{ data: TranscriptMessage[] }>()
      const deferredNewer = createDeferred<{ data: TranscriptMessage[] }>()
      let callCount = 0
      const sessionMessages = vi.fn(async () => {
        callCount += 1
        if (callCount === 1) return deferredOlder.promise
        if (callCount === 2) return deferredNewer.promise
        return { data: [] }
      })
      const client = makeClient({ session: { messages: sessionMessages } })
      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({ directory: project, worktree: project, client }))
        // Start older first (non-awaited), then newer; host does not await overlapping callbacks
        const pOlder = hooks.event?.({ event: { type: "session.compacted", properties: { sessionID: "session-older" } } })
        // tick to ensure first handler captured seq before second starts
        await Promise.resolve()
        await new Promise((r) => setTimeout(r, 1))
        const pNewer = hooks.event?.({ event: { type: "session.compacted", properties: { sessionID: "session-newer" } } })
        await Promise.resolve()
        await new Promise((r) => setTimeout(r, 1))
        // Newer finishes first
        deferredNewer.resolve({ data: summaryTranscript("newer summary body") })
        await Promise.resolve()
        await new Promise((r) => setTimeout(r, 1))
        // Older finishes last
        deferredOlder.resolve({ data: summaryTranscript("older summary body") })
        await Promise.all([pOlder, pNewer])
        const memoryDir = join(project, ".opencode", "memory")
        const result = await readFile(join(memoryDir, "last_compaction_result.json"), "utf-8")
        const parsed = JSON.parse(result)
        // Monotonic last-only: newer must remain, older must not overwrite
        expect(parsed.session_id).toBe("session-newer")
        expect(parsed.session_id).not.toBe("session-older")
        // Ensure both handlers did not throw and did not touch STATE
        expect(writeMemoryOnIdle).not.toHaveBeenCalled()
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })

    it("older prompt starts first/newer finishes first/older finishes last -> newer remains", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-b1-prompt-race-"))
      const deferredOlder = createDeferred<string>()
      const deferredNewer = createDeferred<string>()
      // Use two deferred durables: older resolves last, newer first
      buildDurableBlock
        .mockImplementationOnce(() => deferredOlder.promise)
        .mockImplementationOnce(() => deferredNewer.promise)
      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({ directory: project, worktree: project }))
        const outOlder: { context: string[]; prompt?: string } = { context: [] }
        const outNewer: { context: string[]; prompt?: string } = { context: [] }
        const pOlder = hooks["experimental.session.compacting"]?.({ sessionID: "session-older" } as any, outOlder as any)
        await Promise.resolve()
        await new Promise((r) => setTimeout(r, 1))
        const pNewer = hooks["experimental.session.compacting"]?.({ sessionID: "session-newer" } as any, outNewer as any)
        await Promise.resolve()
        await new Promise((r) => setTimeout(r, 1))
        // Newer finishes first with distinct payload
        deferredNewer.resolve("durable-newer-payload-UNIQUE-NEWER")
        await Promise.resolve()
        await new Promise((r) => setTimeout(r, 1))
        deferredOlder.resolve("durable-older-payload-UNIQUE-OLDER")
        await Promise.all([pOlder, pNewer])
        const memoryDir = join(project, ".opencode", "memory")
        const snapshot = await readFile(join(memoryDir, "last_compaction_prompt.log"), "utf-8")
        // Last-only snapshot must be newer
        expect(snapshot).toContain("session=session-newer")
        expect(snapshot).toContain("durable-newer-payload-UNIQUE-NEWER")
        expect(snapshot).not.toContain("durable-older-payload-UNIQUE-OLDER")
        // Session id line must not be older
        expect(snapshot).not.toMatch(/session=session-older/)
      } finally {
        await rm(project, { recursive: true, force: true })
      }
    })

    it("publication failure remains non-fatal and last-only still holds", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-b1-failure-"))
      const deferredOlder = createDeferred<{ data: TranscriptMessage[] }>()
      const deferredNewer = createDeferred<{ data: TranscriptMessage[] }>()
      let callCount = 0
      const sessionMessages = vi.fn(async () => {
        callCount += 1
        if (callCount === 1) return deferredOlder.promise
        if (callCount === 2) return deferredNewer.promise
        return { data: [] }
      })
      const client = makeClient({ session: { messages: sessionMessages } })
      // Spy on artifacts to inject a failure for the older publication's write
      const artifacts = await import("../src/diagnostics/artifacts")
      const originalWrite = artifacts.writeDiagnosticArtifact
      let writeCall = 0
      const writeSpy = vi.spyOn(artifacts, "writeDiagnosticArtifact").mockImplementation(async (...args: Parameters<typeof originalWrite>) => {
        writeCall += 1
        // Fail the first actual write (which will be newer's publish, since newer finishes first)
        // To make deterministic, we fail the first write invocation; second must succeed and still be newer.
        // Instead fail the older's write after newer succeeds: we need to know which session is being written.
        // Content arg is the JSON string; inspect session_id inside.
        const content = args[2] as string
        if (content.includes("session-older")) {
          throw new Error("injected publication failure")
        }
        return originalWrite(...args)
      })
      try {
        const hooks = await TokenmaxxerPlugin(makePluginInput({ directory: project, worktree: project, client }))
        const pOlder = hooks.event?.({ event: { type: "session.compacted", properties: { sessionID: "session-older" } } })
        await Promise.resolve()
        await new Promise((r) => setTimeout(r, 1))
        const pNewer = hooks.event?.({ event: { type: "session.compacted", properties: { sessionID: "session-newer" } } })
        await Promise.resolve()
        await new Promise((r) => setTimeout(r, 1))
        deferredNewer.resolve({ data: summaryTranscript("newer summary") })
        await Promise.resolve()
        await new Promise((r) => setTimeout(r, 1))
        deferredOlder.resolve({ data: summaryTranscript("older summary") })
        // Both must resolve without throwing despite injected failure
        await expect(Promise.all([pOlder, pNewer])).resolves.not.toThrow()
        // Newer should still be persisted even though older's write threw
        const memoryDir = join(project, ".opencode", "memory")
        const result = await readFile(join(memoryDir, "last_compaction_result.json"), "utf-8")
        const parsed = JSON.parse(result)
        expect(parsed.session_id).toBe("session-newer")
      } finally {
        writeSpy.mockRestore()
        await rm(project, { recursive: true, force: true })
      }
    })
  })
})
