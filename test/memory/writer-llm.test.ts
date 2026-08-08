import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { writeMemoryOnIdle } from "../../src/memory/writer"
import { readMemory, writeMemory } from "../../src/memory/store"
import { emptyMemory } from "../../src/memory/schema"
import { buildCanonicalInput } from "../../src/memory/extract-prompt"
import { makeExtractionCacheEntry } from "../../src/memory/extract-llm"
import type { TranscriptMessage } from "../../src/types"

const directories: string[] = []

function sourceMessages(): TranscriptMessage[] {
  return [
    {
      info: { id: "m1", role: "user" },
      parts: [{ type: "text", text: "Implement the extraction integration." }],
    },
    {
      info: { id: "m2", role: "assistant" },
      parts: [{ type: "text", text: "We will use SDK v2 for structured output." }],
    },
  ]
}

async function makeWorktree() {
  const path = await mkdtemp(join(tmpdir(), "tokenmaxxer-writer-"))
  directories.push(path)
  return path
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("writeMemoryOnIdle SDK-v2 dispatch", () => {
  it("writes heuristic facts and makes no config call when disabled", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const worktree = await makeWorktree()
    const get = vi.fn()
    const appLog = vi.fn()
    const v1 = {
      app: { log: appLog },
      session: { messages: vi.fn(async () => ({ data: sourceMessages() })) },
    }

    await writeMemoryOnIdle({
      client: v1,
      v2Client: { config: { get } },
      worktree,
      directory: worktree,
      sessionId: "source-disabled",
    })

    const memory = await readMemory({ worktree, directory: worktree })
    expect(memory?.recent_sessions).toEqual(["source-disabled"])
    expect(memory?.current_task).toContain("Implement the extraction")
    expect(get).not.toHaveBeenCalled()
    expect(appLog).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        level: "debug",
        message: "llm extraction skipped: TOKENMAXXER_LLM_EXTRACT is disabled",
      }),
    }))
  })

  it("logs when the heuristic path has no v2 client", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const appLog = vi.fn()
    const v1 = {
      app: { log: appLog },
      session: { messages: vi.fn(async () => ({ data: sourceMessages() })) },
    }

    await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId: "source-no-v2",
    })

    expect(appLog).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        level: "debug",
        message: "llm extraction skipped: v2 client unavailable",
      }),
    }))
  })

  it("logs the model-resolution fallback reason", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const appLog = vi.fn()
    const v1 = {
      app: { log: appLog },
      session: { messages: vi.fn(async () => ({ data: sourceMessages() })) },
    }

    await writeMemoryOnIdle({
      client: v1,
      v2Client: { config: { get: vi.fn(async () => ({ data: {} })) } },
      worktree,
      directory: worktree,
      sessionId: "source-no-model",
    })

    expect(appLog).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        level: "info",
        message: "llm extraction skipped: model unavailable",
        extra: { reason: "model inventory is unavailable" },
      }),
    }))
  })

  it("persists heuristic state first, then stores validated v2 facts and cache", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const create = vi.fn(async () => ({ data: { id: "audit-session" } }))
    const prompt = vi.fn(async () => ({
      data: {
        info: {
          structured: {
            current_task: "SDK extraction",
            active_files: [],
            decisions: [{ topic: "transport", decision: "Use SDK v2" }],
            blockers: [],
            next_steps: ["Run tests"],
          },
        },
      },
    }))
    const v2ConfigGet = vi.fn(async () => ({ data: { small_model: "root-provider/root-model" } }))
    const v2 = {
      config: { get: v2ConfigGet },
      session: { create, prompt },
    }
    const appLog = vi.fn()
    const v1ConfigGet = vi.fn(async () => ({ data: { small_model: "provider/model" } }))
    const v1 = {
      app: { log: appLog },
      config: { get: v1ConfigGet },
      session: { messages: vi.fn(async () => ({ data: sourceMessages() })) },
    }

    await writeMemoryOnIdle({
      client: v1,
      v2Client: v2,
      worktree,
      directory: worktree,
      sessionId: "source-success",
    })

    const memory = await readMemory({ worktree, directory: worktree })
    expect(create).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(v1ConfigGet).toHaveBeenCalledWith({ query: { directory: worktree } })
    expect(v2ConfigGet).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      directory: worktree,
      sessionID: "audit-session",
      model: { providerID: "provider", modelID: "model" },
      format: { type: "json_schema", schema: expect.any(Object) },
    }))
    expect(memory?.recent_sessions).toEqual(["source-success"])
    expect(memory?.decisions.some((decision) => decision.topic === "transport")).toBe(true)
    expect(memory?.llm_extraction_cache).toHaveLength(1)
    const messages = appLog.mock.calls.map(([call]) => call.body.message)
    expect(messages).toEqual(expect.arrayContaining([
      "llm extraction model resolved",
      "llm extraction audit session requested",
      "llm extraction facts merged",
    ]))
    expect(appLog.mock.calls.find(([call]) => call.body.message === "llm extraction model resolved")?.[0].body.extra)
      .toEqual({ provider: "provider", model: "model" })
  })

  it("uses a valid cache entry without creating or prompting an audit session", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const messages = sourceMessages()
    const prior = emptyMemory(worktree)
    const model = { providerID: "provider", modelID: "model" }
    const cachedFacts = {
      current_task: "Cached task",
      active_files: [],
      decisions: [],
      blockers: [],
      next_steps: ["Cached next step"],
    }
    prior.llm_extraction_cache = [makeExtractionCacheEntry({
      sourceSessionID: "source-cache",
      canonicalInput: buildCanonicalInput(messages, prior),
      model,
      facts: cachedFacts,
    })]
    await writeMemory({ worktree, directory: worktree }, prior)

    const create = vi.fn()
    const prompt = vi.fn()
    const v2 = {
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: { create, prompt },
    }
    const appLog = vi.fn()
    const v1 = {
      app: { log: appLog },
      session: { messages: vi.fn(async () => ({ data: messages })) },
    }

    await writeMemoryOnIdle({
      client: v1,
      v2Client: v2,
      worktree,
      directory: worktree,
      sessionId: "source-cache",
    })

    const memory = await readMemory({ worktree, directory: worktree })
    expect(create).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    expect(memory?.current_task).toBe("Cached task")
    expect(appLog).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ message: "llm extraction cache hit" }),
    }))
  })

  it("retries exactly once and leaves the durable heuristic write on failure", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const prompt = vi.fn()
      .mockResolvedValueOnce({ data: { info: { structured: { invalid: true } } } })
      .mockRejectedValueOnce(new Error("provider unavailable"))
    const v2 = {
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        create: vi.fn(async () => ({ data: { id: "audit-failure" } })),
        prompt,
      },
    }
    const appLog = vi.fn()
    const v1 = {
      app: { log: appLog },
      session: { messages: vi.fn(async () => ({ data: sourceMessages() })) },
    }

    await writeMemoryOnIdle({
      client: v1,
      v2Client: v2,
      worktree,
      directory: worktree,
      sessionId: "source-failure",
    })

    const memory = await readMemory({ worktree, directory: worktree })
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(memory?.current_task).toContain("Implement the extraction")
    expect(memory?.llm_extraction_cache).toBeUndefined()
    expect(appLog).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        level: "warn",
        message: "llm extraction returned no facts",
      }),
    }))
    expect(appLog.mock.calls.some(([call]) => call.body.message === "llm extraction diagnostic")).toBe(true)
  })
})
