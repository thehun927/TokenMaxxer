import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  extractFactsLLM,
  getLLMConfig,
  isRetainedExtractionSession,
  makeExtractionCacheEntry,
  parseSmallModel,
  readExtractionCache,
  upsertExtractionCache,
} from "../../src/memory/extract-llm"
import { buildCanonicalInput } from "../../src/memory/extract-prompt"
import { emptyMemory } from "../../src/memory/schema"
import type { MemoryFile } from "../../src/memory/schema"
import type { TranscriptMessage } from "../../src/types"

const facts = {
  current_task: "Ship the SDK integration",
  active_files: [{ path: "src/memory/writer.ts", reason: "edited" }],
  decisions: [{ topic: "transport", decision: "Use SDK v2" }],
  blockers: [],
  next_steps: ["Run tests"],
}

function canonical() {
  const messages: TranscriptMessage[] = [{
    info: { id: "message-1", role: "user" },
    parts: [{ type: "text", text: "Use SDK v2 for structured extraction." }],
  }]
  return buildCanonicalInput(messages, emptyMemory("/worktree"))
}

describe("SDK-v2 structured extraction", () => {
  beforeEach(() => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
  })

  it("parses the first provider/model separator", () => {
    expect(parseSmallModel("anthropic/claude/haiku")).toEqual({
      providerID: "anthropic",
      modelID: "claude/haiku",
    })
    expect(parseSmallModel("invalid")).toBeUndefined()
    expect(parseSmallModel(undefined)).toBeUndefined()
  })

  it("uses flattened v2 calls and retains one visible audit session", async () => {
    const create = vi.fn(async (parameters: unknown) => ({ data: { id: "audit-1" }, parameters }))
    const prompt = vi.fn(async () => ({ data: { info: { structured: facts } } }))
    const client = { session: { create, prompt } }
    expect(isRetainedExtractionSession("audit-1")).toBe(false)

    await expect(extractFactsLLM(
      canonical(),
      "source-12345678",
      "project",
      client,
      { enabled: true, model: { providerID: "anthropic", modelID: "haiku" } },
      { directory: "/worktree" },
    )).resolves.toEqual(facts)
    expect(isRetainedExtractionSession("audit-1")).toBe(true)

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      directory: "/worktree",
      title: "tokenmaxxer extract · project · 12345678",
      metadata: { tokenmaxxer: { kind: "llm-extraction", sourceSessionID: "source-12345678" } },
    }))
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: "audit-1",
      directory: "/worktree",
      model: { providerID: "anthropic", modelID: "haiku" },
      format: expect.objectContaining({ type: "json_schema" }),
      parts: [{ type: "text", text: expect.any(String) }],
    }))
  })

  it("does not create a session for a validated cache hit", async () => {
    const client = {
      session: {
        create: vi.fn(),
        prompt: vi.fn(),
      },
    }
    const input = canonical()
    const model = { providerID: "anthropic", modelID: "haiku" }
    const entry = makeExtractionCacheEntry({
      sourceSessionID: "source",
      canonicalInput: input,
      model,
      facts,
    })
    const memory = { ...emptyMemory("/worktree"), llm_extraction_cache: [entry] }

    const cached = readExtractionCache(memory, entry.cache_key)
    await expect(extractFactsLLM(
      input,
      "source",
      "project",
      client,
      { enabled: true, model },
      { directory: "/worktree", cachedFacts: cached },
    )).resolves.toEqual(facts)
    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.session.prompt).not.toHaveBeenCalled()
  })

  it("retries exactly once for invalid structured output and request errors", async () => {
    const invalidThenError = vi.fn()
      .mockResolvedValueOnce({ data: { info: { structured: { nope: true } } } })
      .mockRejectedValueOnce(new Error("request failed"))
    const client = {
      session: {
        create: vi.fn(async () => ({ data: { id: "audit-2" } })),
        prompt: invalidThenError,
      },
    }

    await expect(extractFactsLLM(
      canonical(),
      "source",
      "project",
      client,
      { enabled: true, model: { providerID: "p", modelID: "m" } },
      { directory: "/worktree" },
    )).resolves.toBeNull()
    expect(invalidThenError).toHaveBeenCalledTimes(2)
  })

  it("keeps cache entries capped at ten and upserts by identity", () => {
    let memory: MemoryFile = emptyMemory("/worktree")
    const model = { providerID: "p", modelID: "m" }
    for (let index = 0; index < 11; index++) {
      memory = upsertExtractionCache(memory, makeExtractionCacheEntry({
        sourceSessionID: `source-${index}`,
        canonicalInput: { ...canonical(), sha256: String(index).padStart(64, "0") },
        model,
        facts,
      }))
    }
    expect(memory.llm_extraction_cache).toHaveLength(10)
    expect(memory.llm_extraction_cache?.[0]?.source_session_id).toBe("source-1")
  })

  it("does not call config when extraction is disabled", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const get = vi.fn()
    await expect(getLLMConfig({ config: { get } }, "/worktree")).resolves.toEqual({ enabled: false })
    expect(get).not.toHaveBeenCalled()
  })
})
