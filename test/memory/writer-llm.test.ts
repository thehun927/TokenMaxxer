import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { writeMemoryOnIdle } from "../../src/memory/writer"
import { readMemory, writeMemory } from "../../src/memory/store"
import { emptyMemory } from "../../src/memory/schema"
import {
  buildCanonicalInput,
  buildTranscriptEvidenceCandidateMap,
  makeTranscriptEvidenceRef,
} from "../../src/memory/extract-prompt"
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

describe("writeMemoryOnIdle v1 dispatch", () => {
  it("writes heuristic facts and makes no config call when disabled", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const worktree = await makeWorktree()
    const get = vi.fn()
    const appLog = vi.fn()
    const v1 = {
      app: { log: appLog },
      config: { get },
      session: { messages: vi.fn(async () => ({ data: sourceMessages() })) },
    }

    await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId: "source-disabled",
    })

    const memory = await readMemory({ worktree, directory: worktree })
    expect(memory?.recent_sessions).toEqual(["source-disabled"])
    expect(memory?.current_task).toContain("Implement the extraction")
    expect(memory?.current_task_provenance).toMatchObject({
      extractor: "heuristic",
      source_session_id: "source-disabled",
      confidence: "heuristic",
    })
    expect(get).not.toHaveBeenCalled()
    expect(appLog).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        level: "debug",
        message: "llm extraction skipped: TOKENMAXXER_LLM_EXTRACT is disabled",
      }),
    }))
  })

  it("logs the heuristic fallback when provider discovery is unavailable", async () => {
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
        level: "info",
        message: "llm extraction skipped: model unavailable",
        extra: { reason: "model inventory is unavailable" },
      }),
    }))
  })

  it("logs the model-resolution fallback reason", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const appLog = vi.fn()
    const v1 = {
      app: { log: appLog },
      config: { get: vi.fn(async () => ({ data: {} })) },
      session: { messages: vi.fn(async () => ({ data: sourceMessages() })) },
    }

    await writeMemoryOnIdle({
      client: v1,
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

  it("persists heuristic state first, then stores validated v1 facts and cache", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const create = vi.fn(async () => ({ data: { id: "audit-session" } }))
    const prompt = vi.fn(async () => ({
      data: {
        info: {
          structured: {
            current_task: "SDK extraction",
            active_files: [],
            decisions: [{
              topic: "transport",
              decision: "Use SDK v2",
              evidence_refs: [makeTranscriptEvidenceRef("m2")],
            }],
            blockers: [],
            next_steps: ["Run tests"],
          },
        },
      },
    }))
    const appLog = vi.fn()
    const v1ConfigGet = vi.fn(async () => ({ data: { small_model: "provider/model" } }))
    const v1 = {
      app: { log: appLog },
      config: { get: v1ConfigGet },
      session: { messages: vi.fn(async () => ({ data: sourceMessages() })), create, prompt },
    }

    await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId: "source-success",
    })

    const memory = await readMemory({ worktree, directory: worktree })
    expect(create).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(v1ConfigGet).toHaveBeenCalledWith({ query: { directory: worktree } })
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      path: { id: "audit-session" },
      query: { directory: worktree },
      body: expect.objectContaining({
        model: { providerID: "provider", modelID: "model" },
        format: expect.objectContaining({ type: "json_schema", schema: expect.any(Object) }),
      }),
    }))
    expect(memory?.recent_sessions).toEqual(["source-success"])
    expect(memory?.decisions.some((decision) => decision.topic === "transport")).toBe(true)
    expect(memory?.llm_extraction_cache).toHaveLength(1)
    const accepted = memory?.decisions.find((decision) => decision.topic === "transport")
    expect(accepted?.provenance).toMatchObject({
      extractor: "llm",
      source_session_id: "source-success",
      source_audit_session_id: "audit-session",
      confidence: "llm-corroborated",
    })
    expect(accepted?.provenance?.evidence).toHaveLength(1)
    expect(memory?.llm_extraction_cache?.[0]?.provenance).toMatchObject({
      extractor: "llm",
      source_audit_session_id: "audit-session",
      confidence: "llm-corroborated",
    })
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
    const cachedEvidenceRef = makeTranscriptEvidenceRef("m1")
    const cachedEvidence = buildTranscriptEvidenceCandidateMap(messages)[cachedEvidenceRef]!
    prior.llm_extraction_cache = [makeExtractionCacheEntry({
      sourceSessionID: "source-cache",
      canonicalInput: buildCanonicalInput(messages, prior),
      model,
      facts: cachedFacts,
      auditSessionID: "audit-cache",
      evidence: [{
        kind: "transcript",
        ref: cachedEvidenceRef,
        digest: cachedEvidence.digest,
      }],
    })]
    await writeMemory({ worktree, directory: worktree }, prior)

    const create = vi.fn()
    const prompt = vi.fn()
    const appLog = vi.fn()
    const v1 = {
      app: { log: appLog },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: { messages: vi.fn(async () => ({ data: messages })), create, prompt },
    }

    await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId: "source-cache",
    })

    const memory = await readMemory({ worktree, directory: worktree })
    expect(create).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    expect(memory?.current_task).toContain("Implement the extraction")
    expect(memory?.current_task_provenance?.confidence).toBe("heuristic")
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
    const appLog = vi.fn()
    const v1 = {
      app: { log: appLog },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: sourceMessages() })),
        create: vi.fn(async () => ({ data: { id: "audit-failure" } })),
        prompt,
      },
    }

    await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId: "source-failure",
    })

    const memory = await readMemory({ worktree, directory: worktree })
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(memory?.current_task).toContain("Implement the extraction")
    expect(memory?.llm_extraction_cache).toBeUndefined()
    expect(memory?.llm_extraction_audits).toHaveLength(1)
    expect(memory?.llm_extraction_audits?.[0]?.terminal_outcome).toBe("failed")
    expect(appLog).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        level: "warn",
        message: "llm extraction returned no facts",
      }),
    }))
    expect(appLog.mock.calls.some(([call]) => call.body.message === "llm extraction diagnostic")).toBe(true)
  })

  it("rejects unknown evidence without merging or caching the LLM decision", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const prompt = vi.fn(async () => ({
      data: {
        info: {
          structured: {
            current_task: "SDK extraction",
            active_files: [],
            decisions: [{
              topic: "transport",
              decision: "Use SDK v2",
              evidence_refs: ["tr-does-not-exist"],
            }],
            blockers: [],
            next_steps: [],
          },
        },
      },
    }))
    const appLog = vi.fn()
    const v1 = {
      app: { log: appLog },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: sourceMessages() })),
        create: vi.fn(async () => ({ data: { id: "audit-rejected" } })),
        prompt,
      },
    }

    const outcome = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId: "source-rejected",
    })

    expect(outcome).toBe("llm-failed")
    const memory = await readMemory({ worktree, directory: worktree })
    expect(memory?.llm_extraction_cache).toBeUndefined()
    expect(memory?.decisions.some((decision) => decision.provenance?.extractor === "llm")).toBe(false)
    expect(memory?.decisions.some((decision) => decision.provenance?.extractor === "heuristic")).toBe(true)
    expect(appLog.mock.calls.some(([call]) => (
      call.body.message === "llm extraction diagnostic" &&
      call.body.extra.kind === "evidence-rejected" &&
      call.body.extra.reason === "unknown-reference"
    ))).toBe(true)
  })

  it("records an LLM foundational request without auto-promoting it", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const ref = makeTranscriptEvidenceRef("m2")
    const prompt = vi.fn(async () => ({
      data: {
        info: {
          structured: {
            current_task: null,
            active_files: [],
            decisions: [{
              topic: "transport-policy",
              decision: "Use SDK v2",
              foundational: true,
              evidence_refs: [ref],
            }],
            blockers: [],
            next_steps: [],
          },
        },
      },
    }))
    const v1 = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: sourceMessages() })),
        create: vi.fn(async () => ({ data: { id: "audit-foundational" } })),
        prompt,
      },
    }

    await expect(writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId: "source-foundational",
    })).resolves.toBe("llm-success")

    const memory = await readMemory({ worktree, directory: worktree })
    const decision = memory?.decisions.find((candidate) => candidate.topic === "transport-policy")
    expect(decision).toMatchObject({ foundational: false, foundational_requested: true })
    expect(decision?.provenance?.confidence).toBe("llm-corroborated")
  })
})
