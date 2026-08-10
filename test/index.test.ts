import { beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"

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

beforeEach(() => {
  vi.clearAllMocks()
})

describe("plugin initialization", () => {
  it("does not call config or another endpoint during initialization", async () => {
    const configGet = vi.fn()
    const ctx = {
      client: { app: { log: vi.fn(), info: vi.fn() }, config: { get: configGet } },
      directory: "/workspace/project",
      worktree: "/workspace/project",
      serverUrl: new URL("http://127.0.0.1:4096"),
      project: {},
      experimental_workspace: { register: vi.fn() },
      $: {},
    }

    await TokenmaxxerPlugin(ctx as never)

    expect(configGet).not.toHaveBeenCalled()
    expect(ctx.client.app.info).not.toHaveBeenCalled()
    expect(ctx.client.app.log).not.toHaveBeenCalled()
  })

  it("replaces the compaction log with only the newest snapshot", async () => {
    const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-compaction-"))
    buildDurableBlock
      .mockResolvedValueOnce("first durable snapshot")
      .mockResolvedValueOnce("newest durable snapshot")

    try {
      const ctx = {
        client: { app: { log: vi.fn(), info: vi.fn() } },
        directory: project,
        worktree: project,
        serverUrl: new URL("http://127.0.0.1:4096"),
        project: {},
        experimental_workspace: { register: vi.fn() },
        $: {},
      }
      const hooks = await TokenmaxxerPlugin(ctx as never)
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
      const snapshot = await readFile(join(memoryDir, "last_compaction.log"), "utf-8")
      expect(snapshot).toContain("session=newest-session")
      expect(snapshot).toContain("newest durable snapshot")
      expect(snapshot).not.toContain("first-session")
      expect(snapshot).not.toContain("first durable snapshot")
      expect(await readdir(memoryDir)).toEqual(["HEADER.md", "last_compaction.log"])
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it("does not expose a system transform hook or inject composer text", async () => {
    const ctx = {
      client: { app: { log: vi.fn(), info: vi.fn() } },
      directory: "/workspace/project",
      worktree: "/workspace/project",
      serverUrl: new URL("http://127.0.0.1:4096"),
      project: {},
      experimental_workspace: { register: vi.fn() },
      $: {},
    }

    const hooks = await TokenmaxxerPlugin(ctx as never)

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

    const ctx = {
      client: { app: { log: vi.fn(), info: vi.fn() } },
      directory: "/workspace/project",
      worktree: "/workspace/project",
      serverUrl: new URL("http://127.0.0.1:4096"),
      project: {},
      experimental_workspace: { register: vi.fn() },
      $: {},
    }
    const hooks = await TokenmaxxerPlugin(ctx as never)

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

// ─── PR 4 §12 F — minimum package / compile contract (Waves 2/6/7) ──────────
// The plugin must inject `PluginInput.client` into efficiency registration and
// never rely on a client invented on `ToolContext`. These fixtures fail today
// because `registerEfficiencyTools()` takes no client and the wrappers read
// `(context as any).client`.
describe("PR 4 §12 F — client injection into efficiency registration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("45. plugin initialization passes the legitimate client into efficiency registration", async () => {
    const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-client-inject-"))
    try {
      const fileRead = vi.fn(async () => ({ data: { content: "line1\nline2\nline3" } }))
      const client = {
        file: { read: fileRead },
        app: { log: vi.fn() },
      }
      // v1.18.15 minimum PluginInput shape: client, project, directory,
      // worktree, experimental_workspace, serverUrl, $.
      const input = {
        client: client as unknown as PluginInput["client"],
        project: { id: "p1", worktree: project, time: { created: Date.now() } },
        directory: project,
        worktree: project,
        experimental_workspace: { register: vi.fn() },
        serverUrl: new URL("http://127.0.0.1:4096"),
        $: {} as PluginInput["$"],
      } satisfies PluginInput

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
    const registrationClient = { file: { read: registrationRead } }
    // Planned Wave 2 signature: registerEfficiencyTools(client: HostClient).
    // The cast documents the boundary for the current zero-argument signature.
    const registerWithClient = registerEfficiencyTools as (
      client: unknown,
    ) => ReturnType<typeof registerEfficiencyTools>
    const registered = registerWithClient(registrationClient)
    const sneaky = {
      ...toolContext,
      // A model-controlled context must NOT be able to smuggle a client in.
      client: { file: { read: vi.fn(async () => ({ data: { content: "from-context" } })) } },
    } as unknown as ToolContext

    const result = await registered.tool.head_files.execute(
      { paths: ["a.ts"], lines: 5 },
      sneaky,
    )

    expect(registrationRead).toHaveBeenCalled()
    expect(result).toContain("from-registration")
    expect(result).not.toContain("from-context")
  })
})
