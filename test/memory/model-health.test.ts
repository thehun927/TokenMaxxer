import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  getLLMConfig,
  makeExtractionCacheEntry,
  upsertModelHealth,
} from "../../src/memory/extract-llm"
import { buildCanonicalInput, buildTranscriptEvidenceCandidateMap, makeTranscriptEvidenceRef } from "../../src/memory/extract-prompt"
import { pruneOld, writeMemoryOnIdle } from "../../src/memory/writer"
import { emptyMemory } from "../../src/memory/schema"
import { readMemory, writeMemory } from "../../src/memory/store"
import type { MemoryFile } from "../../src/memory/schema"
import type { TranscriptMessage } from "../../src/types"

const directories: string[] = []

function messages(): TranscriptMessage[] {
  return [{
    info: { id: "health-message", role: "user" },
    parts: [{ type: "text", text: "Implement model health integration." }],
  }]
}

function healthMemory(worktree: string, streak = 1): MemoryFile {
  return {
    ...emptyMemory(worktree),
    model_health: [{
      provider_id: "provider",
      model_id: "model",
      last_outcome: "transport-auth-failure",
      failure_streak: streak,
      last_outcome_at: new Date().toISOString(),
      cooldown_until: new Date(Date.now() + 60_000).toISOString(),
      failure_reason: "request-error",
    }],
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("local model health circuit breaker", () => {
  it("persists a bounded failure streak, backs off, and success clears it", () => {
    const memory = emptyMemory("/project")
    const first = upsertModelHealth(memory, {
      providerID: "provider",
      modelID: "model",
      outcome: "transport-auth-failure",
      reason: "request-error",
    }, 1_000)
    const second = upsertModelHealth(first, {
      providerID: "provider",
      modelID: "model",
      outcome: "structured-shape-failure",
      reason: "response-shape-drift",
    }, 2_000)

    expect(second.model_health?.[0]).toMatchObject({ failure_streak: 2, last_outcome: "structured-shape-failure" })
    expect(Date.parse(second.model_health?.[0]?.cooldown_until ?? "")).toBeGreaterThan(2_000)

    const success = upsertModelHealth(second, {
      providerID: "provider",
      modelID: "model",
      outcome: "success",
      reason: "accepted-extraction",
    }, 3_000)
    expect(success.model_health?.[0]).toMatchObject({ failure_streak: 0, last_outcome: "success" })
    expect(success.model_health?.[0]?.cooldown_until).toBeUndefined()
  })

  it("reloads persisted health and prunes records to the schema cap", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "tokenmaxxer-health-"))
    directories.push(worktree)
    let memory = emptyMemory(worktree)
    for (let index = 0; index < 12; index++) {
      memory = upsertModelHealth(memory, {
        providerID: "provider",
        modelID: `model-${index}`,
        outcome: "validation-failure",
        reason: "evidence-rejection",
      }, index + 1)
    }
    await expect(writeMemory({ worktree, directory: worktree }, memory)).resolves.toBe(true)
    const reloaded = await readMemory({ worktree, directory: worktree })
    expect(reloaded?.model_health).toHaveLength(10)
    expect(pruneOld(memory).model_health).toHaveLength(10)
  })

  it("suppresses a prompt on cooldown without replacing an explicit model", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await mkdtemp(join(tmpdir(), "tokenmaxxer-health-gate-"))
    directories.push(worktree)
    await writeMemory({ worktree, directory: worktree }, healthMemory(worktree))
    const create = vi.fn()
    const prompt = vi.fn()
    const client = {
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: messages() })),
        create,
        prompt,
      },
    }

    await expect(writeMemoryOnIdle({
      client,
      worktree,
      directory: worktree,
      sessionId: "source-health-gate",
    })).resolves.toBe("heuristic-only")
    expect(create).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
  })

  it("keeps an unhealthy explicit model terminal even when another candidate exists", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const list = vi.fn(async () => ({ data: {
      all: [
        { id: "provider", models: { model: { tool_call: true, cost: { input: 0, output: 0 } } } },
        { id: "other", models: { fallback: { tool_call: true, cost: { input: 0, output: 0 } } } },
      ],
      connected: ["provider", "other"],
    } }))
    await expect(getLLMConfig({
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      provider: { list },
    }, "/project", { memory: healthMemory("/project") })).resolves.toEqual({
      enabled: false,
      reason: "configured model is on cooldown",
    })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it("uses an accepted cache hit even while the selected model is cooling down", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await mkdtemp(join(tmpdir(), "tokenmaxxer-health-cache-"))
    directories.push(worktree)
    const source = messages()
    const prior = healthMemory(worktree)
    const ref = makeTranscriptEvidenceRef("health-message")
    const candidate = buildTranscriptEvidenceCandidateMap(source)[ref]!
    const facts = {
      current_task: "Cached health result",
      active_files: [],
      decisions: [],
      blockers: [],
      next_steps: [],
    }
    prior.llm_extraction_cache = [makeExtractionCacheEntry({
      sourceSessionID: "source-health-cache",
      canonicalInput: buildCanonicalInput(source, prior),
      model: { providerID: "provider", modelID: "model" },
      facts,
      auditSessionID: "audit-health-cache",
      evidence: [{ kind: "transcript", ref, digest: candidate.digest }],
    })]
    await expect(writeMemory({ worktree, directory: worktree }, prior)).resolves.toBe(true)

    const create = vi.fn()
    const prompt = vi.fn()
    const client = {
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: { messages: vi.fn(async () => ({ data: source })), create, prompt },
    }
    await expect(writeMemoryOnIdle({
      client,
      worktree,
      directory: worktree,
      sessionId: "source-health-cache",
    })).resolves.toBe("cache-hit")
    expect(create).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
  })
})
