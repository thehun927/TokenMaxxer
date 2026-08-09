import { beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
