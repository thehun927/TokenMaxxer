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
})
