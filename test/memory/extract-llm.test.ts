import { beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  MAX_RETAINED_EXTRACTION_SESSION_IDS,
  corroborateLLMFacts,
  extractFactsLLM,
  getLLMConfig,
  isPersistedRetainedExtractionSession,
  isRetainedExtractionSession,
  makeExtractionCacheEntry,
  parseSmallModel,
  readExtractionCache,
  resetRetainedExtractionSessionIDs,
  resolveEvidenceReferences,
  upsertExtractionCache,
} from "../../src/memory/extract-llm"
import { buildCanonicalInput } from "../../src/memory/extract-prompt"
import * as prompt from "../../src/memory/extract-prompt"
import { emptyMemory } from "../../src/memory/schema"
import { writeMemory } from "../../src/memory/store"
import type { MemoryFile } from "../../src/memory/schema"
import type { TranscriptMessage } from "../../src/types"

const facts = {
  decisions: [{
    topic: "transport",
    decision: "Use SDK v2",
    rationale: "The source transcript selected the SDK transport.",
    evidence_refs: ["tr-source-evidence"],
  }],
}

const decisionsOnlyFacts = { decisions: facts.decisions }

const evidenceCandidateMap = {
  "tr-source-evidence": {
    kind: "transcript" as const,
    ref: "tr-source-evidence",
    digest: "a".repeat(64),
  },
}
const evidenceOptions = {
  evidenceCandidateMap,
  evidenceDigestMap: { "tr-source-evidence": "a".repeat(64) },
}

function canonical() {
  const messages: TranscriptMessage[] = [{
    info: { id: "message-1", role: "user" },
    parts: [{ type: "text", text: "Use SDK v2 for structured extraction." }],
  }]
  return buildCanonicalInput(messages, emptyMemory("/worktree"))
}

function providerResponse(all: unknown[], connected?: unknown) {
  return {
    data: {
      all,
      ...(connected !== undefined ? { connected } : {}),
    },
  }
}

function inventoryModel(overrides: Record<string, unknown> = {}) {
  return {
    name: "Small Free",
    tool_call: true,
    cost: { input: 0, output: 0 },
    ...overrides,
  }
}

function liveInventoryModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "live-model",
    name: "Live Small Free",
    capabilities: { toolcall: true },
    cost: { input: 0, output: 0 },
    ...overrides,
  }
}

describe("v1 structured extraction", () => {
  beforeEach(() => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    resetRetainedExtractionSessionIDs()
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

  it("accepts only decisions whose bounded evidence resolves and matches digests", () => {
    const diagnostics: unknown[] = []
    expect(corroborateLLMFacts(facts, {
      ...evidenceOptions,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })).toEqual(facts)

    expect(corroborateLLMFacts({
      ...facts,
      decisions: [{ topic: "transport", decision: "Use SDK v2" }],
    }, {
      ...evidenceOptions,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })).toBeNull()

    expect(corroborateLLMFacts(facts, {
      evidenceCandidateMap: {},
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })).toBeNull()

    expect(corroborateLLMFacts(facts, {
      evidenceCandidateMap,
      evidenceDigestMap: { "tr-source-evidence": "b".repeat(64) },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })).toBeNull()

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "evidence-rejected", reason: "unknown-reference" }),
      expect.objectContaining({ kind: "evidence-rejected", reason: "digest-mismatch" }),
    ]))
  })

  it("uses nested v1 calls and retains one visible audit session", async () => {
    const create = vi.fn(async (parameters: unknown) => ({ data: { id: "audit-1" }, parameters }))
    const prompt = vi.fn(async () => ({ data: { info: { structured: decisionsOnlyFacts } } }))
    const client = { session: { create, prompt } }
    expect(isRetainedExtractionSession("audit-1")).toBe(false)

    await expect(extractFactsLLM(
      canonical(),
      "source-12345678",
      "project",
      client,
      { enabled: true, model: { providerID: "anthropic", modelID: "haiku" } },
      { directory: "/worktree", ...evidenceOptions },
    )).resolves.toEqual({ status: "success", facts: decisionsOnlyFacts })
    expect(isRetainedExtractionSession("audit-1")).toBe(true)
    resetRetainedExtractionSessionIDs()
    expect(isRetainedExtractionSession("audit-1")).toBe(false)

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        title: "tokenmaxxer extract · project · 12345678",
        metadata: { tokenmaxxer: { kind: "llm-extraction", sourceSessionID: "source-12345678" } },
      },
      query: { directory: "/worktree" },
    }))
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      path: { id: "audit-1" },
      query: { directory: "/worktree" },
      body: {
        model: { providerID: "anthropic", modelID: "haiku" },
        format: expect.objectContaining({ type: "json_schema" }),
        parts: [{ type: "text", text: expect.any(String) }],
      },
    }))
  })

  it("bounds retained sessions and falls back to the durable audit after eviction", async () => {
    const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-retained-sessions-"))
    try {
      let nextAudit = 0
      const create = vi.fn(async () => ({ data: { id: `audit-${nextAudit++}` } }))
      const client = {
        session: {
          create,
          prompt: vi.fn(async () => ({ data: { info: { structured: decisionsOnlyFacts } } })),
        },
      }

      for (let index = 0; index <= MAX_RETAINED_EXTRACTION_SESSION_IDS; index++) {
        await expect(extractFactsLLM(
          canonical(),
           `source-${index}`,
           "project",
           client,
           { enabled: true, model: { providerID: "provider", modelID: "model" } },
           {
             directory: project,
             projectKey: project,
             ...evidenceOptions,
             onAuditCreated: async (audit) => {
               if (audit.audit_session_id === "audit-0") {
                 await writeMemory(
                   { worktree: project, directory: project },
                   { ...emptyMemory(project), llm_extraction_audits: [audit] },
                 )
               }
               return true
             },
           },
         )).resolves.toEqual({ status: "success", facts })
      }

      expect(create).toHaveBeenCalledTimes(MAX_RETAINED_EXTRACTION_SESSION_IDS + 1)
      expect(isRetainedExtractionSession("audit-0")).toBe(false)
      expect(isRetainedExtractionSession("audit-1")).toBe(true)
      expect(isRetainedExtractionSession("audit-256")).toBe(true)
      expect(await isPersistedRetainedExtractionSession({
        sessionID: "audit-0",
        worktree: project,
        directory: project,
      })).toBe(true)
    } finally {
      resetRetainedExtractionSessionIDs()
      await rm(project, { recursive: true, force: true })
    }
  })

  it("binds the host session receiver for create and prompt", async () => {
    const session = {
      create: vi.fn(function (this: unknown) {
        expect(this).toBe(session)
        return Promise.resolve({ data: { id: "audit-bound" } })
      }),
      prompt: vi.fn(function (this: unknown) {
        expect(this).toBe(session)
        return Promise.resolve({ data: { info: { structured: decisionsOnlyFacts } } })
      }),
    }

    await expect(extractFactsLLM(
      canonical(),
       "source-bound",
       "project",
       { session },
       { enabled: true, model: { providerID: "provider", modelID: "model" } },
       { directory: "/worktree", ...evidenceOptions },
     )).resolves.toEqual({ status: "success", facts })
     expect(session.create).toHaveBeenCalledTimes(1)
     expect(session.prompt).toHaveBeenCalledTimes(1)
   })

   it("sends a selected variant as a top-level prompt body field", async () => {
     const prompt = vi.fn(async () => ({ data: { info: { structured: facts } } }))
     const client = {
       session: {
         create: vi.fn(async () => ({ data: { id: "audit-variant" } })),
         prompt,
       },
     }

     await expect(extractFactsLLM(
       canonical(),
       "source-variant",
       "project",
       client,
       { enabled: true, model: { providerID: "provider", modelID: "model", variant: "none" } },
       { directory: "/worktree", ...evidenceOptions },
     )).resolves.toEqual({ status: "success", facts })

    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        model: { providerID: "provider", modelID: "model" },
        variant: "none",
      }),
    }))
  })

  it("does not short-circuit on caller cache lookups — always creates/prompts audit sessions", async () => {
    // Wave 7: The extractFactsLLM function no longer accepts a cachedFacts shortcut.
    // Cache decisions are governed by the caller's processed-source ledger.
    const client = {
      session: {
        create: vi.fn(async () => ({ data: { id: "audit-cache" } })),
        prompt: vi.fn(async () => ({
          data: { info: { structured: { decisions: [{ topic: "t", decision: "d", evidence_refs: ["tr-source-evidence"] }] } } },
        })),
      },
    }
    const input = canonical()
    const model = { providerID: "anthropic", modelID: "haiku" }
    await extractFactsLLM(
      input,
      "source",
      "project",
      client,
      { enabled: true, model },
      { directory: "/worktree", ...evidenceOptions },
    )
    // Wave 7: Always creates an audit session and prompts (no cachedFacts shortcut).
    expect(client.session.create).toHaveBeenCalled()
    expect(client.session.prompt).toHaveBeenCalled()
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
       { directory: "/worktree", ...evidenceOptions },
     )).resolves.toEqual({ status: "failed", reason: "structured-request" })
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
     )).resolves.toEqual({ status: "unavailable", reason: "missing-session-endpoint" })
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
     )).resolves.toEqual({ status: "failed", reason: "session-create" })
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
     )).resolves.toEqual({ status: "failed", reason: "session-create" })
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
     )).resolves.toEqual({ status: "failed", reason: "structured-request" })

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
        auditSessionID: `audit-${index}`,
        evidence: [{ kind: "transcript", ref: "tr-source-evidence", digest: "a".repeat(64) }],
      }))
    }
    expect(memory.llm_extraction_cache).toHaveLength(10)
    expect(memory.llm_extraction_cache?.[0]?.source_session_id).toBe("source-1")
  })

  it("does not call config when extraction is disabled", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const get = vi.fn()
    const list = vi.fn()
    await expect(getLLMConfig({
      config: { get },
      provider: { list },
    }, "/worktree")).resolves.toEqual({
      enabled: false,
      reason: "TOKENMAXXER_LLM_EXTRACT is disabled",
    })
    expect(get).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })

  it("uses a valid configured provider/model override without discovery", async () => {
    const list = vi.fn(async () => providerResponse([
      { id: "configured", models: { model: inventoryModel() } },
    ]))
    const get = vi.fn(async () => ({ data: { small_model: "configured/model" } }))
    await expect(getLLMConfig({
      config: { get },
      provider: { list },
    }, "/worktree")).resolves.toEqual({
      enabled: true,
      model: { providerID: "configured", modelID: "model" },
    })
    expect(get).toHaveBeenCalledWith({ query: { directory: "/worktree" } })
    expect(list).toHaveBeenCalledWith({ query: { directory: "/worktree" } })
  })

  it("rejects an explicit model from a provider that is not connected", async () => {
    const list = vi.fn(async () => providerResponse([
      { id: "unconnected", models: { model: inventoryModel() } },
      { id: "connected", models: { other: inventoryModel() } },
    ], ["connected"]))

    await expect(getLLMConfig({
      config: { get: vi.fn(async () => ({ data: { small_model: "unconnected/model" } })) },
      provider: { list },
    }, "/worktree")).resolves.toEqual({
      enabled: false,
      reason: "provider is not connected",
    })
  })

  it("attaches an explicit none variant when provider metadata exposes it", async () => {
    const list = vi.fn(async () => providerResponse([
      {
        id: "configured",
        models: {
          model: liveInventoryModel({ id: "model", variants: { none: {} } }),
        },
      },
    ]))

    await expect(getLLMConfig({
      config: { get: vi.fn(async () => ({ data: { small_model: "configured/model" } })) },
      provider: { list },
    }, "/worktree")).resolves.toEqual({
      enabled: true,
      model: { providerID: "configured", modelID: "model", variant: "none" },
    })
  })

  it("discovers the first eligible free model in provider and model order", async () => {
    const get = vi.fn(async () => ({ data: {} }))
    const list = vi.fn(async (parameters: unknown) => {
      expect(parameters).toEqual({ query: { directory: "/worktree" } })
      return providerResponse([
        {
          id: "providerA",
          models: {
            paid: inventoryModel({ cost: { input: 0.1, output: 0 } }),
            inactive: inventoryModel({ status: "beta" }),
            freeA: inventoryModel(),
          },
        },
        {
          id: "providerB",
          models: { freeB: inventoryModel() },
        },
      ])
    })

    await expect(getLLMConfig({ config: { get }, provider: { list } }, "/worktree"))
      .resolves.toEqual({
        enabled: true,
        model: { providerID: "providerA", modelID: "freeA" },
      })
  })

  it("accepts omitted status and rejects non-tool or explicitly non-active models", async () => {
    const list = vi.fn(async () => providerResponse([
      { id: "paid", models: { paid: inventoryModel({ cost: { input: 1, output: 0 } }) } },
      { id: "tools", models: { noTools: inventoryModel({ tool_call: false }) } },
      { id: "inactive", models: { inactive: inventoryModel({ status: "beta" }) } },
      { id: "eligible", models: { omittedStatus: inventoryModel() } },
    ]))

    await expect(getLLMConfig({
      config: { get: vi.fn(async () => ({ data: {} })) },
      provider: { list },
    }, "/worktree")).resolves.toEqual({
      enabled: true,
      model: { providerID: "eligible", modelID: "omittedStatus" },
    })
  })

  it("prefers a live model with a none variant over earlier eligible models", async () => {
    const list = vi.fn(async () => providerResponse([
      {
        id: "providerA",
        models: {
          ordinary: liveInventoryModel({ id: "ordinary", status: "active" }),
        },
      },
      {
        id: "providerB",
        models: {
          thinking: liveInventoryModel({
            id: "thinking",
            status: "active",
            variants: { thinking: {} },
          }),
          none: liveInventoryModel({
            id: "none",
            status: "active",
            variants: { none: {} },
          }),
        },
      },
    ]))

    await expect(getLLMConfig({
      config: { get: vi.fn(async () => ({ data: {} })) },
      provider: { list },
    }, "/worktree")).resolves.toEqual({
      enabled: true,
      model: { providerID: "providerB", modelID: "none", variant: "none" },
    })
  })

  it("filters automatic discovery to connected providers", async () => {
    const list = vi.fn(async () => providerResponse([
      { id: "unconnected", models: { free: inventoryModel() } },
      { id: "connected", models: { free: inventoryModel() } },
    ], ["connected"]))

    await expect(getLLMConfig({
      config: { get: vi.fn(async () => ({ data: {} })) },
      provider: { list },
    }, "/worktree")).resolves.toEqual({
      enabled: true,
      model: { providerID: "connected", modelID: "free" },
    })
  })

  it("reports when connected providers have no suitable free model", async () => {
    const list = vi.fn(async () => providerResponse([
      { id: "connected", models: { paid: inventoryModel({ cost: { input: 1, output: 0 } }) } },
      { id: "unconnected", models: { free: inventoryModel() } },
    ], ["connected"]))

    await expect(getLLMConfig({
      config: { get: vi.fn(async () => ({ data: {} })) },
      provider: { list },
    }, "/worktree")).resolves.toEqual({
      enabled: false,
      reason: "no connected provider has a suitable free tool model",
    })
  })

  it("returns the heuristic fallback when provider discovery errors", async () => {
    const list = vi.fn(async () => { throw new Error("inventory unavailable") })

    await expect(getLLMConfig({
      config: { get: vi.fn(async () => ({ data: {} })) },
      provider: { list },
    }, "/worktree")).resolves.toEqual({
      enabled: false,
      reason: "model inventory request failed",
    })
  })
})

// ---------------------------------------------------------------------------
// PR 6 §Wave 1 — contract-freeze tests at the LLM/evidence seam
// ---------------------------------------------------------------------------
describe("PR 6 §Wave 1 — decisions-only LLM extraction", () => {
  const decisionsOnly = {
    decisions: [{
      topic: "transport",
      decision: "Use SDK v2",
      rationale: "The source transcript selected the SDK transport.",
      evidence_refs: ["tr-source-evidence"],
    }],
  }

  it("uses extraction contract version 3", () => {
    expect(prompt.EXTRACTION_CONTRACT_VERSION).toBe(3)
  })

  it("accepts one decisions-only result when its evidence is a transcript candidate", () => {
    expect(corroborateLLMFacts(
      decisionsOnly as unknown as Parameters<typeof corroborateLLMFacts>[0],
      evidenceOptions,
    )).toEqual(decisionsOnly)
    expect(resolveEvidenceReferences(["tr-source-evidence"], evidenceOptions)).toEqual({
      evidence: [{
        kind: "transcript",
        ref: "tr-source-evidence",
        digest: "a".repeat(64),
      }],
    })
  })

  it("rejects a heuristic-candidate as LLM evidence", () => {
    const heuristic = {
      "heuristic-candidate": {
        kind: "heuristic-candidate" as const,
        ref: "heuristic-candidate",
        digest: "b".repeat(64),
      },
    }
    expect(resolveEvidenceReferences(["heuristic-candidate"], {
      evidenceCandidateMap: heuristic,
      evidenceDigestMap: { "heuristic-candidate": "b".repeat(64) },
    })).toEqual({ evidence: [], reason: "invalid-candidate" })
    expect(corroborateLLMFacts({
      decisions: [{ ...decisionsOnly.decisions[0], evidence_refs: ["heuristic-candidate"] }],
    } as unknown as Parameters<typeof corroborateLLMFacts>[0], {
      evidenceCandidateMap: heuristic,
      evidenceDigestMap: { "heuristic-candidate": "b".repeat(64) },
    })).toBeNull()
  })

  it("passes decisions-only structured output through the extraction request", async () => {
    const promptRequest = vi.fn(async () => ({ data: { info: { structured: decisionsOnly } } }))
    const client = {
      session: {
        create: vi.fn(async () => ({ data: { id: "audit-v3" } })),
        prompt: promptRequest,
      },
    }

    await expect(extractFactsLLM(
      canonical(),
      "source-v3",
      "project",
      client,
      { enabled: true, model: { providerID: "provider", modelID: "model" } },
      { directory: "/worktree", ...evidenceOptions },
    )).resolves.toEqual({ status: "success", facts: decisionsOnly })
  })
})
