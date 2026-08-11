import { beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import type { TranscriptMessage } from "../../src/types"

const { writeMemoryOnIdle, buildDurableBlock } = vi.hoisted(() => {
  return {
    writeMemoryOnIdle: vi.fn(),
    buildDurableBlock: vi.fn(),
  }
})

vi.mock("../src/memory/writer", () => ({ writeMemoryOnIdle }))
vi.mock("../src/compaction/durable", () => ({ buildDurableBlock }))

import { TokenmaxxerPlugin } from "../src/index"
import { extractFactsLLM } from "../src/memory/extract-llm"
import { buildCanonicalInput } from "../src/memory/extract-prompt"
import { emptyMemory } from "../src/memory/schema"
import { registerEfficiencyTools } from "../src/tools/efficiency"

/**
 * The v1.18.15 minimum-contract `ToolContext` shape (PR 4 §10.1): the tool
 * runtime never carries a client — the SDK client is injected by closure.
 */
const toolContext: ToolContext = {
  sessionID: "session-1",
  messageID: "message-1",
  agent: "build",
  directory: "/workspace/project",
  worktree: "/workspace/project",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
}

/**
 * Narrow, type-checked SDK client stub (PR 4 §10.2). Constructing the entire
 * generated `OpencodeClient` is impractical, so the stub carries only the real
 * v1.18.15 endpoints this plugin uses (`file.read`, `app.log`, `config.get`).
 * The single cast is localized here and targets the exact SDK type; tests never
 * invent members (`app.info` is NOT a real endpoint) and never escape through
 * `as never` at the host boundary.
 */
type FileReadStub = (
  options: { query: { path: string; directory?: string } },
) => Promise<{ data?: { content?: string } }>

type ClientOverride = {
  file?: Partial<{ read: FileReadStub }>
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

/**
 * A real `PluginInput`-shaped fixture (PR 4 §10.2). Only the members each test
 * needs are supplied; the whole object is checked against the actual SDK type
 * via `satisfies PluginInput`. `$` is a narrowed stub typed to the real
 * `BunShell` surface (constructing a real BunShell is impractical).
 */
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

beforeEach(() => {
  vi.clearAllMocks()
})

describe("plugin initialization", () => {
  it("does not call config or another endpoint during initialization", async () => {
    const configGet = vi.fn()
    const input = makePluginInput({ client: makeClient({ config: { get: configGet } }) })

    await TokenmaxxerPlugin(input)

    expect(configGet).not.toHaveBeenCalled()
    expect(input.client.app.log).not.toHaveBeenCalled()
  })

  it("replaces the compaction prompt log with only the newest snapshot", async () => {
    const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-compaction-"))
    buildDurableBlock
      .mockResolvedValueOnce("first durable snapshot")
      .mockResolvedValueOnce("newest durable snapshot")

    try {
      const hooks = await TokenmaxxerPlugin(makePluginInput({
        directory: project,
        worktree: project,
      }))
      const firstOutput = { context: [] as string[] }
      const secondOutput = { context: [] as string[] }

      await hooks["experimental.session.compacting"]?.(
        { sessionID: "first-session" },
        firstOutput,
      )
      await hooks["experimental.session.compacting"]?.(
        { sessionID: "newest-session" },
        secondOutput,
      )

      const memoryDir = join(project, ".opencode", "memory")
      const snapshot = await readFile(join(memoryDir, "last_compaction_prompt.log"), "utf-8")
      expect(snapshot).toContain("session=newest-session")
      expect(snapshot).toContain("newest durable snapshot")
      expect(snapshot).not.toContain("first-session")
      expect(snapshot).not.toContain("first durable snapshot")
      expect(await readdir(memoryDir)).toEqual(["HEADER.md", "last_compaction_prompt.log"])
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it("does not expose a system transform hook or inject composer text", async () => {
    const hooks = await TokenmaxxerPlugin(makePluginInput())

    expect(hooks).not.toHaveProperty("experimental.chat.system.transform")
    expect(JSON.stringify(hooks)).not.toContain("tokenmaxxer: This project has cross-session memory")
    expect(JSON.stringify(hooks)).not.toContain("current_task")
  })

  it("skips registered extraction sessions but keeps normal idle events unchanged", async () => {
    const extractionSessionID = "registered-extraction-session"
    const input = buildCanonicalInput([], emptyMemory("/workspace/project"))
    await extractFactsLLM(
      input,
      "source-session",
      "project",
      {
        session: {
          create: vi.fn(async () => ({ data: { id: extractionSessionID } })),
          prompt: vi.fn(async () => ({
            data: {
              info: {
                structured: {
                  current_task: null,
                  active_files: [],
                  decisions: [],
                  blockers: [],
                  next_steps: [],
                },
              },
            },
          })),
        },
      },
      { enabled: true, model: { providerID: "provider", modelID: "model" } },
      { directory: "/workspace/project" },
    )

    const hooks = await TokenmaxxerPlugin(makePluginInput())

    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: extractionSessionID } },
    })
    expect(writeMemoryOnIdle).not.toHaveBeenCalled()

    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID: "normal-session" } },
    })
    expect(writeMemoryOnIdle).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "normal-session",
    }))
  })
})

// ─── PR 7 Wave 1 — Mode assertions for hook behavior ─────────────────────────────
describe("PR 7 Wave 1 — compaction mode assertions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Clear all env vars before each test
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith("TOKENMAXXER_")) {
        delete process.env[key]
      }
    })
  })

  describe("§14.A.8 — Augment mode appends context and leaves output.prompt unset", () => {
    it("augment mode should not set output.prompt", async () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "augment"
      const hooks = await TokenmaxxerPlugin(makePluginInput())

      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]?.(
        { sessionID: "test-session" },
        output,
      )

      // Augment mode should append context but NOT set prompt
      expect(output.context).toBeDefined()
      expect(output.prompt).toBeUndefined()
    })

    it("augment mode should preserve pre-existing context entries", async () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "augment"
      const hooks = await TokenmaxxerPlugin(makePluginInput())

      const output = { context: ["existing-plugin-context"] as string[] }
      await hooks["experimental.session.compacting"]?.(
        { sessionID: "test-session" },
        output,
      )

      // Augment mode should preserve existing context
      expect(output.context).toContain("existing-plugin-context")
    })
  })

  describe("§14.A.10 — Replace mode sets output.prompt without erasing unrelated context", () => {
    it("replace mode should set output.prompt", async () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "replace"
      const hooks = await TokenmaxxerPlugin(makePluginInput())

      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]?.(
        { sessionID: "test-session" },
        output,
      )

      // Replace mode should set prompt but NOT erase unrelated context
      expect(output.prompt).toBeDefined()
      expect(output.prompt).not.toBe("")
      expect(output.context).toBeDefined()
    })

    it("replace mode should preserve unrelated context entries", async () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "replace"
      const hooks = await TokenmaxxerPlugin(makePluginInput())

      const output = { context: ["existing-plugin-context"] as string[] }
      await hooks["experimental.session.compacting"]?.(
        { sessionID: "test-session" },
        output,
      )

      // Replace mode should preserve unrelated context
      expect(output.context).toContain("existing-plugin-context")
    })
  })

  describe("PR 7 Wave 5 — Previous-summary recovery", () => {
    beforeEach(() => {
      vi.clearAllMocks()
      // Clear all env vars before each test
      Object.keys(process.env).forEach((key) => {
        if (key.startsWith("TOKENMAXXER_")) {
          delete process.env[key]
        }
      })
    })

    it("replace mode with no prior summary proceeds without anchor", async () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "replace"
      const mockClient = {
        session: {
          messages: vi.fn(async () => ({ data: [] })),
        },
      }
      const hooks = await TokenmaxxerPlugin({
        ...makePluginInput(),
        client: mockClient as unknown as PluginInput["client"],
      })

      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]?.(
        { sessionID: "first-compaction" },
        output,
      )

      // Should set prompt (no anchor needed for first compaction)
      expect(output.prompt).toBeDefined()
      expect(output.prompt).not.toBe("")
      // Should preserve context
      expect(output.context).toBeDefined()
    })

    it("replace mode with prior summary includes anchor", async () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "replace"
      const mockMessages: TranscriptMessage[] = [
        {
          info: { id: "msg-1", role: "user", parentID: undefined },
          parts: [{ type: "compaction", text: "Compaction request" }],
        },
        {
          info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: true },
          parts: [{ type: "text", text: "Prior summary content" }],
        },
      ]

      const mockClient = {
        session: {
          messages: vi.fn(async () => ({ data: mockMessages })),
        },
      }
      const hooks = await TokenmaxxerPlugin({
        ...makePluginInput(),
        client: mockClient as unknown as PluginInput["client"],
      })

      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]?.(
        { sessionID: "second-compaction" },
        output,
      )

      // Should set prompt with anchor
      expect(output.prompt).toBeDefined()
      expect(output.prompt).toContain("PREVIOUS SUMMARY ANCHOR")
      expect(output.prompt).toContain("Prior summary content")
      // Should preserve context
      expect(output.context).toBeDefined()
    })

    it("replace mode with unavailable history falls back to augment", async () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "replace"
      const mockClient = {} as unknown
      const hooks = await TokenmaxxerPlugin({
        ...makePluginInput(),
        client: mockClient,
      })

      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]?.(
        { sessionID: "test-session" },
        output,
      )

      // Should fall back to augment: append context, leave prompt unset
      expect(output.context).toBeDefined()
      expect(output.prompt).toBeUndefined()
    })

    it("augment mode does not fetch history", async () => {
      const mockClient = {
        session: {
          messages: vi.fn(async () => {
            throw new Error("Should not be called in augment mode")
          }),
        },
      }
      const hooks = await TokenmaxxerPlugin({
        ...makePluginInput(),
        client: mockClient as unknown as PluginInput["client"],
      })

      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]?.(
        { sessionID: "test-session" },
        output,
      )

      // Should not call session.messages in augment mode
      expect(mockClient.session.messages).not.toHaveBeenCalled()
      // Should append context
      expect(output.context).toBeDefined()
      // Should leave prompt unset
      expect(output.prompt).toBeUndefined()
    })
  })

  describe("§14.A.12 — Compaction customization failure remains non-fatal to host hook", () => {
    it("should not throw when compaction customization fails", async () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "invalid-mode"
      const hooks = await TokenmaxxerPlugin(makePluginInput())

      const output = { context: [] as string[] }

      // Should not throw; should fall back to augment behavior
      await expect(
        hooks["experimental.session.compacting"]?.(
          { sessionID: "test-session" },
          output,
        )
      ).resolves.not.toThrow()
    })
  })
})

// ─── PR 4 §12 F — minimum package / compile contract (Waves 2/6/7) ──────────
// The plugin must inject `PluginInput.client` into efficiency registration and
// never rely on a client invented on `ToolContext`.
describe("PR 4 §12 F — client injection into efficiency registration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("45. plugin initialization passes the legitimate client into efficiency registration", async () => {
    const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-client-inject-"))
    try {
      const fileRead = vi.fn(async () => ({ data: { content: "line1\nline2\nline3" } }))
      // v1.18.15 minimum PluginInput shape, checked with satisfies PluginInput.
      const input = makePluginInput({
        directory: project,
        worktree: project,
        client: makeClient({ file: { read: fileRead } }),
      })

      const hooks = await TokenmaxxerPlugin(input)
      const invocationContext = { ...toolContext, directory: project, worktree: project }
      const result = await hooks.tool!.head_files!.execute(
        { paths: ["a.ts"], lines: 5 },
        invocationContext,
      )

      // The legitimate initializer client, not a context-invented one, serves
      // the read — and it carries the invocation directory.
      expect(fileRead).toHaveBeenCalled()
      expect(fileRead).toHaveBeenCalledWith({ query: { path: "a.ts", directory: project } })
      expect(result).toContain("line1")
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it("registerEfficiencyTools requires the initializer client (ToolContext.client is not a legitimate source)", async () => {
    const registrationRead = vi.fn(async () => ({ data: { content: "from-registration" } }))
    const registrationClient = makeClient({ file: { read: registrationRead } })
    const registered = registerEfficiencyTools(registrationClient)
    // A model-controlled context must NOT be able to smuggle a client in. The
    // intersection is the adversarial shape: `ToolContext` plus an invented
    // `client` — exactly what a hostile context object would look like. The
    // supported `ToolContext` type itself still has no client member.
    const sneaky: ToolContext & {
      client: { file: { read: FileReadStub } }
    } = {
      ...toolContext,
      client: { file: { read: vi.fn(async () => ({ data: { content: "from-context" } })) } },
    }

    const result = await registered.tool.head_files.execute(
      { paths: ["a.ts"], lines: 5 },
      sneaky,
    )

    expect(registrationRead).toHaveBeenCalled()
    expect(result).toContain("from-registration")
    expect(result).not.toContain("from-context")
  })
})
