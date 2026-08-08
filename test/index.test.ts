import { beforeEach, describe, expect, it, vi } from "vitest"

const { createV2Client, configGet, writeMemoryOnIdle } = vi.hoisted(() => {
  const configGet = vi.fn()
  return {
    configGet,
    createV2Client: vi.fn(() => ({ config: { get: configGet } })),
    writeMemoryOnIdle: vi.fn(),
  }
})

vi.mock("../src/opencode/v2", () => ({ createV2Client }))
vi.mock("../src/memory/writer", () => ({ writeMemoryOnIdle }))

import { TokenmaxxerPlugin } from "../src/index"
import { extractFactsLLM } from "../src/memory/extract-llm"
import { buildCanonicalInput } from "../src/memory/extract-prompt"
import { emptyMemory } from "../src/memory/schema"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("plugin initialization", () => {
  it("constructs the v2 client without calling config or another endpoint", async () => {
    const ctx = {
      client: { app: { log: vi.fn(), info: vi.fn() } },
      directory: "/workspace/project",
      worktree: "/workspace/project",
      serverUrl: new URL("http://127.0.0.1:4096"),
      project: {},
      experimental_workspace: { register: vi.fn() },
      $: {},
    }

    await TokenmaxxerPlugin(ctx as never)

    expect(createV2Client).toHaveBeenCalledWith(ctx.serverUrl, ctx.directory)
    expect(configGet).not.toHaveBeenCalled()
    expect(ctx.client.app.info).not.toHaveBeenCalled()
    expect(ctx.client.app.log).not.toHaveBeenCalled()
  })

  it("warns with a sanitized error when v2 client construction fails", async () => {
    createV2Client.mockImplementationOnce(() => {
      const error = new TypeError("bridge setup failed")
      Object.assign(error, { secret: "must not be logged", stack: "sensitive stack" })
      throw error
    })
    const appLog = vi.fn()
    const ctx = {
      client: { app: { log: appLog, info: vi.fn() } },
      directory: "/workspace/project",
      worktree: "/workspace/project",
      serverUrl: new URL("http://127.0.0.1:4096"),
      project: {},
      experimental_workspace: { register: vi.fn() },
      $: {},
    }

    await TokenmaxxerPlugin(ctx as never)

    expect(appLog).toHaveBeenCalledWith({
      body: {
        service: "tokenmaxxer",
        level: "warn",
        message: "v2 client initialization failed",
        extra: { error: { name: "TypeError", message: "bridge setup failed" } },
      },
    })
    expect(JSON.stringify(appLog.mock.calls)).not.toContain("sensitive stack")
    expect(JSON.stringify(appLog.mock.calls)).not.toContain("must not be logged")
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
