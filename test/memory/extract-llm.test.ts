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

function inventoryResponse(data: unknown[]) {
  return { data: { location: { directory: "/worktree" }, data } }
}

function inventoryModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "small-free",
    providerID: "free-provider",
    enabled: true,
    status: "active",
    capabilities: { tools: true },
    cost: [{ input: 0, output: 0 }],
    ...overrides,
  }
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
    expect(parseSmallModel("pro vider/model")).toBeUndefined()
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

  it("reports bounded diagnostics for unavailable clients and session failures", async () => {
    const diagnostics: unknown[] = []
    await expect(extractFactsLLM(
      canonical(),
      "source",
      "project",
      undefined,
      { enabled: true, model: { providerID: "p", modelID: "m" } },
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
    )).resolves.toBeNull()
    expect(diagnostics).toEqual([{
      kind: "unavailable-client",
      reason: "missing-session-endpoint",
    }])

    diagnostics.length = 0
    await expect(extractFactsLLM(
      canonical(),
      "source",
      "project",
      {
        session: {
          create: vi.fn(async () => ({
            error: { name: "RequestError", message: "bridge unavailable" },
            secret: "must not be copied",
          })),
          prompt: vi.fn(),
        },
      },
      { enabled: true, model: { providerID: "p", modelID: "m" } },
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
    )).resolves.toBeNull()
    expect(diagnostics).toEqual([{
      kind: "session-create-failed",
      reason: "error-response",
      error: { name: "RequestError", message: "bridge unavailable" },
    }])
    expect(JSON.stringify(diagnostics)).not.toContain("must not be copied")

    diagnostics.length = 0
    await expect(extractFactsLLM(
      canonical(),
      "source",
      "project",
      {
        session: {
          create: vi.fn(async () => ({ data: {} })),
          prompt: vi.fn(),
        },
      },
      { enabled: true, model: { providerID: "p", modelID: "m" } },
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
    )).resolves.toBeNull()
    expect(diagnostics).toEqual([{
      kind: "session-create-failed",
      reason: "malformed-response",
    }])
  })

  it("reports every failed output attempt and retry exhaustion", async () => {
    const diagnostics: unknown[] = []
    const prompt = vi.fn()
      .mockResolvedValueOnce({ data: { info: { structured: { invalid: true } } } })
      .mockRejectedValueOnce(new Error("provider unavailable"))

    await expect(extractFactsLLM(
      canonical(),
      "source",
      "project",
      {
        session: {
          create: vi.fn(async () => ({ data: { id: "audit-diagnostics" } })),
          prompt,
        },
      },
      { enabled: true, model: { providerID: "p", modelID: "m" } },
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
    )).resolves.toBeNull()

    expect(diagnostics).toEqual([
      {
        kind: "structured-output-failed",
        attempt: 1,
        reason: "invalid-structured-output",
      },
      {
        kind: "structured-output-failed",
        attempt: 2,
        reason: "request-error",
        error: { name: "Error", message: "provider unavailable" },
      },
      { kind: "retries-exhausted", attempts: 2 },
    ])
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
    const listModels = vi.fn()
    const listProviders = vi.fn()
    await expect(getLLMConfig({
      config: { get },
      v2: { model: { list: listModels }, provider: { list: listProviders } },
    }, "/worktree")).resolves.toEqual({
      enabled: false,
      reason: "TOKENMAXXER_LLM_EXTRACT is disabled",
    })
    expect(get).not.toHaveBeenCalled()
    expect(listModels).not.toHaveBeenCalled()
    expect(listProviders).not.toHaveBeenCalled()
  })

  it("uses a valid configured provider/model override without discovery", async () => {
    const listModels = vi.fn()
    const listProviders = vi.fn()
    await expect(getLLMConfig({
      config: { get: vi.fn(async () => ({ data: { small_model: "configured/model" } })) },
      v2: { model: { list: listModels }, provider: { list: listProviders } },
    }, "/worktree")).resolves.toEqual({
      enabled: true,
      model: { providerID: "configured", modelID: "model" },
    })
    expect(listModels).not.toHaveBeenCalled()
    expect(listProviders).not.toHaveBeenCalled()
  })

  it("prefers the valid v1 config override and uses the nested query shape", async () => {
    const v1Get = vi.fn(async () => ({ data: { small_model: "v1-provider/v1-model" } }))
    const v2Get = vi.fn(async () => ({ data: { small_model: "v2-provider/v2-model" } }))
    const listModels = vi.fn()
    const listProviders = vi.fn()

    await expect(getLLMConfig({
      config: { get: v2Get },
      v2: { model: { list: listModels }, provider: { list: listProviders } },
    }, "/worktree", {
      config: { get: v1Get },
    })).resolves.toEqual({
      enabled: true,
      model: { providerID: "v1-provider", modelID: "v1-model" },
    })

    expect(v1Get).toHaveBeenCalledWith({ query: { directory: "/worktree" } })
    expect(v2Get).not.toHaveBeenCalled()
    expect(listModels).not.toHaveBeenCalled()
    expect(listProviders).not.toHaveBeenCalled()
  })

  it("falls through from a failed v1 config request to v2 config and inventory", async () => {
    const v1Get = vi.fn(async () => { throw new Error("v1 config unavailable") })
    const v2Get = vi.fn(async () => ({ data: {} }))
    const listModels = vi.fn(async () => inventoryResponse([
      inventoryModel({ id: "fallback-model", providerID: "fallback-provider" }),
    ]))
    const listProviders = vi.fn(async () => inventoryResponse([
      { id: "fallback-provider" },
    ]))

    await expect(getLLMConfig({
      config: { get: v2Get },
      v2: { model: { list: listModels }, provider: { list: listProviders } },
    }, "/worktree", {
      config: { get: v1Get },
    })).resolves.toEqual({
      enabled: true,
      model: { providerID: "fallback-provider", modelID: "fallback-model" },
    })

    expect(v1Get).toHaveBeenCalledWith({ query: { directory: "/worktree" } })
    expect(v2Get).toHaveBeenCalledWith({ directory: "/worktree" })
    expect(listModels).toHaveBeenCalledTimes(1)
    expect(listProviders).toHaveBeenCalledTimes(1)
  })

  it("discovers the first eligible zero-cost model in API order", async () => {
    const listModels = vi.fn(async (parameters: unknown) => {
      expect(parameters).toEqual({ location: { directory: "/worktree" } })
      return inventoryResponse([
        inventoryModel({ id: "released-first", providerID: "provider-a" }),
        inventoryModel({ id: "released-second", providerID: "provider-b" }),
      ])
    })
    const listProviders = vi.fn(async (parameters: unknown) => {
      expect(parameters).toEqual({ location: { directory: "/worktree" } })
      return inventoryResponse([
        { id: "provider-a" },
        { id: "provider-b" },
      ])
    })

    await expect(getLLMConfig({
      config: { get: vi.fn(async () => ({ data: {} })) },
      v2: { model: { list: listModels }, provider: { list: listProviders } },
    }, "/worktree")).resolves.toEqual({
      enabled: true,
      model: { providerID: "provider-a", modelID: "released-first" },
    })
    expect(listModels).toHaveBeenCalledTimes(1)
    expect(listProviders).toHaveBeenCalledTimes(1)
  })

  it("discovers inventory from the nested v2 namespace", async () => {
    const listModels = vi.fn(async () => inventoryResponse([
      inventoryModel({ id: "nested-model", providerID: "nested-provider" }),
    ]))
    const listProviders = vi.fn(async () => inventoryResponse([
      { id: "nested-provider" },
    ]))

    await expect(getLLMConfig({
      config: { get: vi.fn(async () => ({ data: {} })) },
      v2: { model: { list: listModels }, provider: { list: listProviders } },
    }, "/worktree")).resolves.toEqual({
      enabled: true,
      model: { providerID: "nested-provider", modelID: "nested-model" },
    })
    expect(listModels).toHaveBeenCalledWith({ location: { directory: "/worktree" } })
    expect(listProviders).toHaveBeenCalledWith({ location: { directory: "/worktree" } })
  })

  it("filters paid, disabled, non-tool, and inactive models", async () => {
    const listModels = vi.fn(async () => inventoryResponse([
      inventoryModel({ id: "paid", providerID: "paid-provider", cost: [{ input: 0.1, output: 0 }] }),
      inventoryModel({ id: "disabled", providerID: "disabled-provider" }),
      inventoryModel({ id: "no-tools", providerID: "no-tools-provider", capabilities: { tools: false } }),
      inventoryModel({ id: "inactive", providerID: "inactive-provider", status: "beta" }),
      inventoryModel({ id: "eligible", providerID: "eligible-provider" }),
    ]))
    const listProviders = vi.fn(async () => inventoryResponse([
      { id: "paid-provider" },
      { id: "disabled-provider", disabled: true },
      { id: "no-tools-provider" },
      { id: "inactive-provider" },
      { id: "eligible-provider" },
    ]))

    await expect(getLLMConfig({
      config: { get: vi.fn(async () => ({ data: { small_model: "not valid" } })) },
      v2: { model: { list: listModels }, provider: { list: listProviders } },
    }, "/worktree")).resolves.toEqual({
      enabled: true,
      model: { providerID: "eligible-provider", modelID: "eligible" },
    })
  })

  it("returns the heuristic fallback when no model qualifies", async () => {
    const listModels = vi.fn(async () => inventoryResponse([
      inventoryModel({ cost: [{ input: 1, output: 1 }] }),
    ]))
    const listProviders = vi.fn(async () => inventoryResponse([{ id: "free-provider" }]))

    await expect(getLLMConfig({
      config: { get: vi.fn(async () => ({ data: {} })) },
      v2: { model: { list: listModels }, provider: { list: listProviders } },
    }, "/worktree")).resolves.toEqual({
      enabled: false,
      reason: "no eligible free model found",
    })
  })

  it("returns the heuristic fallback when inventory discovery errors", async () => {
    const listModels = vi.fn(async () => { throw new Error("inventory unavailable") })
    const listProviders = vi.fn(async () => inventoryResponse([{ id: "free-provider" }]))

    await expect(getLLMConfig({
      config: { get: vi.fn(async () => ({ data: {} })) },
      v2: { model: { list: listModels }, provider: { list: listProviders } },
    }, "/worktree")).resolves.toEqual({
      enabled: false,
      reason: "model inventory request failed",
    })
  })
})
