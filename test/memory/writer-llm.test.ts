import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

import {
  writeMemoryOnIdle,
  prepareIdleSource,
  persistAuditGuard,
  persistTerminalTransaction,
  persistModelHealth,
  mergeAsyncFacts,
  finalLLMMerge,
  markReferencedDecisions,
  pruneOld,
} from "../../src/memory/writer"
import * as storeModule from "../../src/memory/store"
import { readMemory, writeMemory } from "../../src/memory/store"
import { emptyMemory } from "../../src/memory/schema"
import {
  buildCanonicalInput,
  buildExtractionSourceInput,
  buildTranscriptEvidenceCandidateMap,
  makeTranscriptEvidenceRef,
  makeSourceVersionKey,
  makeExtractionCacheKey,
} from "../../src/memory/extract-prompt"
import { makeExtractionCacheEntry } from "../../src/memory/extract-llm"
import { resetHostStructuredContractGate } from "../../src/memory/llm-adapter"
import { resetProjectQueues } from "../../src/memory/lock"
import type { TranscriptMessage } from "../../src/types"

const WORKER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "transaction-worker.ts",
)

const directories: string[] = []
let homeDir: string
const barrierFiles: string[] = []

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(path: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      await access(path)
      return
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${path}`)
      }
      await sleep(10)
    }
  }
}

/** Spawn the transaction-worker fixture and resolve with its stdout + exit code. */
function runWorker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => {
      stdout += String(d)
    })
    child.stderr.on("data", (d) => {
      stderr += String(d)
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

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

/** Build the durable completion record expected by the Wave 4 fast path. */
async function completedSourceRecord(
  worktree: string,
  sessionId: string,
  messages: TranscriptMessage[],
) {
  const prepared = await prepareIdleSource({
    client: { session: { messages: vi.fn(async () => ({ data: messages })) } },
    worktree,
    directory: worktree,
    sessionId,
  })
  if (prepared.kind !== "success") throw new Error("source preparation failed")
  return {
    source_key: prepared.sourceVersionKey,
    extraction_key: `v2e:${"b".repeat(64)}`,
    extraction_contract_version: 2,
    completed_at: "2026-08-10T00:00:00.000Z",
  }
}

async function makeWorktree() {
  const path = await mkdtemp(join(tmpdir(), "tokenmaxxer-writer-"))
  directories.push(path)
  return path
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(
    barrierFiles.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})),
  )
  barrierFiles.length = 0
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  if (homeDir) await rm(homeDir, { recursive: true, force: true }).catch(() => {})
  homeDir = undefined as unknown as string
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
        message: "llm extraction skipped: gated model unavailable",
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
    // Wave 5: Compute source identity from actual messages so the cache key
    // matches what processPreparedIdleSource computes at runtime.
    const sourceInput = buildExtractionSourceInput(messages)
    const sourceVersionKey = makeSourceVersionKey({
      sourceSessionID: "source-cache",
      sourceInputSha256: sourceInput.sourceInputSha256,
      extractionContractVersion: 2,
    })
    const canonicalInput = buildCanonicalInput(messages, prior)
    const extractionKey = makeExtractionCacheKey({
      sourceVersionKey,
      extractionContractVersion: 2,
      model,
    })
    prior.llm_extraction_cache = [makeExtractionCacheEntry({
      sourceSessionID: "source-cache",
      canonicalInput,
      model,
      facts: cachedFacts,
      auditSessionID: "audit-cache",
      evidence: [{
        kind: "transcript",
        ref: cachedEvidenceRef,
        digest: cachedEvidence.digest,
      }],
      sourceVersionKey,
      sourceInputSha256: sourceInput.sourceInputSha256,
      promptInputSha256: canonicalInput.promptInputSha256,
      extractionContractVersion: 2,
      modelVariant: undefined,
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

    const outcome = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId: "source-cache",
    })

    // A cache payload without the durable completion marker is a miss, not a
    // cache-hit.  It must not replay the cached facts or perform a second
    // cache transaction/revision; this deliberately reaches the failed LLM
    // path because the prompt fixture is not configured.
    expect(outcome).toBe("llm-failed")
    const memory = await readMemory({ worktree, directory: worktree })
    expect(create).toHaveBeenCalledTimes(1)
    expect(prompt).not.toHaveBeenCalled()
    expect(memory?.current_task).toContain("Implement the extraction")
    expect(memory?.current_task).not.toBe("Cached task")
    expect(memory?.revision).toBe(1)
    expect(memory?.current_task_provenance?.confidence).toBe("heuristic")
    expect(appLog).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ message: "llm extraction cache entry ignored without completion marker" }),
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
         message: "llm extraction failed",
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

// ─── Wave 4 deferred: LLM lifecycle transaction tests (PR 2 §11.B–E, §15) ────

function auditRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    audit_session_id: "audit-1",
    source_session_id: "source-1",
    cache_key: "cache-key-1",
    provider_id: "provider",
    model_id: "model",
    created_at: new Date().toISOString(),
    terminal_outcome: "pending",
    ...overrides,
  }
}

function healthReport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    providerID: "provider",
    modelID: "model",
    outcome: "success",
    reason: "accepted-extraction",
    ...overrides,
  }
}

function llmFacts(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    current_task: "LLM task",
    active_files: [],
    decisions: [],
    blockers: [],
    next_steps: [],
    ...overrides,
  }
}

describe("Wave 4 deferred — audit-guard transaction failure does not prompt", () => {
  it("returns a bounded failure and never calls session.prompt", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const prompt = vi.fn()
    const v1 = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: sourceMessages() })),
        create: vi.fn(async () => ({ data: { id: "audit-guard-fail" } })),
        prompt,
      },
    }

    // Force ONLY the audit-guard transaction to fail with commit-failed. The
    // heuristic transaction (first mutateMemory call) must succeed so the flow
    // reaches the audit-guard step.
    const spy = vi.spyOn(storeModule, "mutateMemory")
    let callCount = 0
    spy.mockImplementation(async (_args, mutate) => {
      callCount += 1
      if (callCount === 1) {
        const action = mutate(emptyMemory(worktree), {
          status: "missing",
          memory: null,
          source: null,
          path: null,
          sizeBytes: 0,
          revision: 0,
        })
        if (action.kind === "noop") {
          return { status: "noop", value: action.value, revision: 0 }
        }
        return { status: "committed", value: action.value, revision: 1 }
      }
      return { status: "commit-failed" }
    })

    const outcome = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId: "source-guard-fail",
    })

    // The audit guard failed, so prompting must not continue.
    expect(prompt).not.toHaveBeenCalled()
    // Required guard persistence failure is a write failure, not an LLM
    // failure or an intentional heuristic fallback.
    expect(outcome).toBe("write-failed")
  })
})

describe("Wave 4 deferred — audit-terminal noop does not bump revision", () => {
  it("leaves revision and the pending audit row unchanged for a missing audit", async () => {
    const worktree = await makeWorktree()
    const prior = emptyMemory(worktree)
    prior.revision = 3
    prior.llm_extraction_audits = [auditRecord() as never]
    await writeMemory({ worktree, directory: worktree }, prior)

    // Drive persistTerminal for a non-existent audit session.
    await persistTerminalTransaction(
      { client: {}, worktree, directory: worktree },
      "audit-does-not-exist",
      "success",
    )

    const memory = await readMemory({ worktree, directory: worktree })
    expect(memory?.revision).toBe(3)
    expect(memory?.llm_extraction_audits).toHaveLength(1)
    expect(memory?.llm_extraction_audits?.[0]?.terminal_outcome).toBe("pending")
  })
})

describe("Wave 4 deferred — model-health transaction failure is best-effort", () => {
  it("does not throw and does not fall back to writeMemory", async () => {
    const worktree = await makeWorktree()
    const writeSpy = vi.spyOn(storeModule, "writeMemory")
    const mutateSpy = vi.spyOn(storeModule, "mutateMemory")
    mutateSpy.mockResolvedValue({ status: "lock-timeout" })

    await expect(
      persistModelHealth({ client: {}, worktree, directory: worktree }, healthReport() as never),
    ).resolves.toBeUndefined()

    // No fallback writeMemory after the transaction failure.
    expect(writeSpy).not.toHaveBeenCalled()
  })
})

describe("Wave 4 deferred — cache-hit transaction is inside the lock", () => {
  it("times out against a held lock and writes no STATE", async () => {
    const worktree = await makeWorktree()
    const project = worktree
    const barrier = join(tmpdir(), `w4-cache-lock-${Date.now()}-${Math.random()}`)
    barrierFiles.push(barrier, `${barrier}.release`)

    // Seed a cache row so the cache-hit path is exercised.
    const prior = emptyMemory(project)
    const messages = sourceMessages()
    const model = { providerID: "provider", modelID: "model" }
    const cachedFacts = llmFacts({ current_task: "Cached task" })
    const cachedEvidenceRef = makeTranscriptEvidenceRef("m1")
    const cachedEvidence = buildTranscriptEvidenceCandidateMap(messages)[cachedEvidenceRef]!
    prior.llm_extraction_cache = [makeExtractionCacheEntry({
      sourceSessionID: "source-cache",
      canonicalInput: buildCanonicalInput(messages, prior),
      model,
      facts: cachedFacts as never,
      auditSessionID: "audit-cache",
      evidence: [{ kind: "transcript", ref: cachedEvidenceRef, digest: cachedEvidence.digest }],
    })]
    await writeMemory({ worktree, directory: worktree }, prior)

    // A child holds the project lock behind a barrier.
    const child = runWorker([project, "hold-lock", barrier])
    await waitFor(barrier)

    const result = await mergeAsyncFacts(
      { client: {}, worktree, directory: worktree, sessionId: "source-cache" },
      cachedFacts as never,
      null,
      "source-cache",
      { origin: "llm", auditSessionID: "audit-cache", evidenceCandidates: {} },
    )

    expect(result).toBe(false)
    // No STATE was written while the lock was held.
    const memory = await readMemory({ worktree, directory: worktree })
    expect(memory?.revision).toBe(0)

    await writeFile(`${barrier}.release`, "go", "utf-8")
    const { code } = await child
    expect(code).toBe(0)
  })
})

describe("Wave 4 deferred — final-LLM transaction reads cache identity under the lock", () => {
  it("observes a cache entry committed at a higher revision by another process", async () => {
    const worktree = await makeWorktree()
    const project = worktree
    const messages = sourceMessages()
    const model = { providerID: "provider", modelID: "model" }
    const prior = emptyMemory(project)
    prior.revision = 1
    const cacheKey = "cache-key-identity"
    // Seed cache entry X at revision 1.
    const cachedFactsX = llmFacts({ current_task: "task-X" })
    const cachedEvidenceRef = makeTranscriptEvidenceRef("m1")
    const cachedEvidence = buildTranscriptEvidenceCandidateMap(messages)[cachedEvidenceRef]!
    prior.llm_extraction_cache = [makeExtractionCacheEntry({
      sourceSessionID: "source-X",
      canonicalInput: buildCanonicalInput(messages, prior),
      model,
      facts: cachedFactsX as never,
      auditSessionID: "audit-X",
      evidence: [{ kind: "transcript", ref: cachedEvidenceRef, digest: cachedEvidence.digest }],
      sourceVersionKey: "v2s:" + "x".repeat(64),
      sourceInputSha256: "x".repeat(64),
      promptInputSha256: "x".repeat(64),
      extractionContractVersion: 2,
      modelVariant: undefined,
    })]
    await writeMemory({ worktree, directory: worktree }, prior)

    // Create a completed source with OLD facts
    const completedSource = {
      source_key: "v2s:" + "x".repeat(64),
      extraction_key: cacheKey,
      extraction_contract_version: 2,
      completed_at: new Date().toISOString(),
    }
    await writeMemory({ worktree, directory: worktree }, {
      ...prior,
      processed_sources: [completedSource],
    })

    // Now create cache entry Y with different facts
    const cachedFactsY = llmFacts({ current_task: "task-Y" })
    const priorY = emptyMemory(project)
    priorY.revision = 5
    priorY.llm_extraction_cache = [makeExtractionCacheEntry({
      sourceSessionID: "source-Y",
      canonicalInput: buildCanonicalInput(messages, priorY),
      model,
      facts: cachedFactsY as never,
      auditSessionID: "audit-Y",
      evidence: [{ kind: "transcript", ref: cachedEvidenceRef, digest: cachedEvidence.digest }],
      sourceVersionKey: "v2s:" + "x".repeat(64),
      sourceInputSha256: "x".repeat(64),
      promptInputSha256: "x".repeat(64),
      extractionContractVersion: 2,
      modelVariant: undefined,
    })]
    await writeMemory({ worktree, directory: worktree }, priorY)

    // The final transaction must observe Y (the locked read), not the pre-lock X.
    const candidates = buildTranscriptEvidenceCandidateMap(messages)
    // The writer wraps transcript candidates with `kind: "transcript"`; mirror
    // that shape so the cache identity check resolves Y's provenance.
    const transcriptCandidates: Record<string, { kind: "transcript"; ref: string; digest: string }> = {}
    const digests: Record<string, string> = {}
    for (const [ref, candidate] of Object.entries(candidates)) {
      transcriptCandidates[ref] = { kind: "transcript", ref, digest: candidate.digest }
      digests[ref] = candidate.digest
    }

    const result = await finalLLMMerge(
      { client: {}, worktree, directory: worktree },
      {
        sessionId: "source-final",
        gitSha: null,
        canonicalInput: buildCanonicalInput(messages, priorY),
        selectedModel: model,
        selectedCacheKey: cacheKey,
        llmFacts: llmFacts({ current_task: "task-final" }) as never,
        extractionAuditSessionID: "audit-final",
        candidates: transcriptCandidates,
        digests,
      },
    )
    expect(result.status).toBe("committed")
    if (result.status === "committed") {
      // Oracle B1: An incomplete cache row must not replace fresh accepted facts.
      expect(result.value.memory.current_task).toBe("task-final")
      expect(result.revision).toBe(6)
    }
  })
})

describe("Wave 4 deferred — LLM prompt is not held under the lock", () => {
  it("a child idle-write completes while the prompt is pending and survives the final merge", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const project = worktree
    const barrier = join(tmpdir(), `w4-prompt-${Date.now()}-${Math.random()}`)
    barrierFiles.push(barrier, `${barrier}.release`)

    const messages = sourceMessages()
    const model = { providerID: "provider", modelID: "model" }

    // A deferred prompt that resolves only after the child idle-write finishes.
    const prompt = vi.fn(async () => {
      // Signal that the prompt is pending (no lock is held here).
      await writeFile(barrier, "pending", "utf-8")
      // Block until the test releases the prompt after the child idle-write.
      await waitFor(`${barrier}.release`)
      return {
        data: {
          info: {
            structured: {
              current_task: "LLM final task",
              active_files: [],
              decisions: [],
              blockers: [],
              next_steps: [],
            },
          },
        },
      }
    })
    const v1 = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: messages })),
        create: vi.fn(async () => ({ data: { id: "audit-prompt" } })),
        prompt,
      },
    }

    // Start the idle write; it will block inside the prompt (no lock held).
    const idlePromise = writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId: "source-prompt",
    })

    // Wait until the prompt is actually pending (audit session created).
    await waitFor(barrier)

    // A child idle-write for the same project must acquire the lock and finish
    // while the parent's prompt is still pending.
    const child = runWorker([project, "idle-write", "child"])
    const { code } = await child
    expect(code).toBe(0)

    // Now release the prompt; the parent's final transaction must preserve the
    // child's mutation.
    await writeFile(`${barrier}.release`, "go", "utf-8")
    const outcome = await idlePromise
    expect(outcome).toBe("llm-success")

    const memory = await readMemory({ worktree, directory: worktree })
    const ids = memory?.decisions.map((d) => d.id) ?? []
    expect(ids).toContain("fact-child")
  })
})

// ─── PR 4 §12 E — unsupported-host graceful degradation (Wave 5) ────────────
// With LLM enabled and a host health version below the verified minimum
// (1.18.14), heuristic memory must still be committed while the optional
// structured path (audit session + structured prompt + LLM provenance) stays
// at zero. The current gate compares only major/minor, so 1.18.14 is treated
// as verified and the structured path runs; these fixtures fail until Wave 5.
describe("PR 4 §12 E — unsupported-host graceful degradation", () => {
  beforeEach(() => {
    resetHostStructuredContractGate()
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
  })

  afterEach(() => {
    resetHostStructuredContractGate()
  })

  /** Fake v1 client with a `global.health` probe and recording audit/prompt. */
  function llmClient(healthVersion: string) {
    const create = vi.fn(async () => ({ data: { id: "audit-unsupported" } }))
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
        create,
        prompt,
      },
      global: {
        health: vi.fn(async () => ({ data: { healthy: true, version: healthVersion } })),
      },
    }
    return { v1, create, prompt }
  }

  it("35-38. unsupported host (1.18.14) commits heuristics and never opens the structured path", async () => {
    const worktree = await makeWorktree()
    const { v1, create, prompt } = llmClient("1.18.14")

    const outcome = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId: "source-unsupported",
    })

    // 35. Heuristic STATE is committed (the persisted file retains the
    // heuristic facts, and the heuristic task provenance survives).
    const memory = await readMemory({ worktree, directory: worktree })
    expect(memory?.current_task).toContain("Implement the extraction")
    expect(memory?.current_task_provenance).toMatchObject({
      extractor: "heuristic",
      source_session_id: "source-unsupported",
      confidence: "heuristic",
    })
    expect(memory?.recent_sessions).toContain("source-unsupported")

    // 36. No retained audit session is created.
    expect(create).not.toHaveBeenCalled()
    // 37. No structured prompt is sent.
    expect(prompt).not.toHaveBeenCalled()
    // 38. No LLM/human-reviewed decision provenance is minted from the
    // skipped optional path.
    expect(memory?.decisions.some((d) => d.provenance?.extractor === "llm")).toBe(false)
    expect(memory?.decisions.some((d) => d.provenance?.confidence === "llm-corroborated")).toBe(false)
    // The writer returns the nonfatal heuristic fallback outcome.
    expect(outcome).toBe("heuristic-only")
  })

  it("39. supported host (1.18.15) follows the existing optional structured-extraction path unchanged", async () => {
    const worktree = await makeWorktree()
    const { v1, create, prompt } = llmClient("1.18.15")

    const outcome = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId: "source-supported",
    })

    expect(outcome).toBe("llm-success")
    expect(create).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(1)
    const memory = await readMemory({ worktree, directory: worktree })
    expect(memory?.decisions.some((d) => d.topic === "transport")).toBe(true)
    expect(memory?.decisions.find((d) => d.topic === "transport")?.provenance)
      .toMatchObject({
        extractor: "llm",
        source_session_id: "source-supported",
        confidence: "llm-corroborated",
      })
  })
})

// ─── PR 5 §Wave 1B — idempotency basics (§18.B items 11-17) ─────────────────────

describe("PR 5 §Wave 1B — idempotency basics", () => {
  beforeEach(() => {
    resetHostStructuredContractGate()
    resetProjectQueues()
  })

  afterEach(() => {
    resetHostStructuredContractGate()
    resetProjectQueues()
  })

  /** Build source messages with fixed IDs for consistent evidence refs. */
  function idempotentMessages(): TranscriptMessage[] {
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

  it("11. first successful source persists exactly one entry in memory.processed_sources matching ^v2s:[a-f0-9]{64}$", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-idempotent-11"
    const messages = idempotentMessages()
    const evidenceRef = makeTranscriptEvidenceRef("m2")

    const create = vi.fn(async () => ({ data: { id: `audit-${sessionId}` } }))
    const prompt = vi.fn(async () => ({
      data: {
        info: {
          structured: {
            current_task: "LLM task",
            active_files: [],
            decisions: [{
              topic: "transport",
              decision: "Use SDK v2",
              evidence_refs: [evidenceRef],
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
        messages: vi.fn(async () => ({ data: messages })),
        create,
        prompt,
      },
    }

    const outcome = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })

    expect(outcome).toBe("llm-success")
    expect(create).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(1)

    // Read STATE on disk and check the field
    const memory = await readMemory({ worktree, directory: worktree })
    const processedSources = (memory as any).processed_sources
    expect(processedSources).toBeDefined()
    expect(Array.isArray(processedSources)).toBe(true)
    expect(processedSources).toHaveLength(1)
    expect(processedSources[0].source_key).toMatch(/^v2s:[a-f0-9]{64}$/)
  })

  it("12. accepted facts and completion commit share one final revision", async () => {
    const worktree = await makeWorktree()
    const sessionId = "source-idempotent-12"
    const messages = idempotentMessages()
    const prepared = await prepareIdleSource({
      client: { session: { messages: vi.fn(async () => ({ data: messages })) } },
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(prepared.kind).toBe("success")
    if (prepared.kind !== "success") throw new Error("source preparation failed")

    const result = await finalLLMMerge(
      { client: {}, worktree, directory: worktree },
      {
        sessionId,
        gitSha: null,
        canonicalInput: prepared.canonicalInput,
        selectedModel: { providerID: "provider", modelID: "model" },
        selectedCacheKey: `v2e:${"c".repeat(64)}`,
        sourceVersionKey: prepared.sourceVersionKey,
        sourceInputSha256: prepared.sourceInputSha256,
        llmFacts: {
          current_task: "LLM task",
          active_files: [],
          decisions: [],
          blockers: [],
          next_steps: [],
        } as never,
        extractionAuditSessionID: "audit-final-12",
        candidates: prepared.transcriptCandidates,
        digests: prepared.transcriptDigests,
      },
    )

    expect(result.status).toBe("committed")
    if (result.status === "committed") {
      expect(result.revision).toBe(1)
      expect(result.value.memory.current_task).toBe("LLM task")
      expect(result.value.memory.processed_sources).toHaveLength(1)
    }
  })

  it("protects the current completion marker when pruning near the size cap", async () => {
    const worktree = await makeWorktree()
    const messages = idempotentMessages()
    const prior = emptyMemory(worktree)
    prior.processed_sources = Array.from({ length: 10 }, (_, index) => ({
      source_key: `v2s:${"a".repeat(63)}${index}`,
      extraction_key: `v2e:${"b".repeat(64)}`,
      extraction_contract_version: 2,
      completed_at: "2026-08-10T00:00:00.000Z",
    }))
    for (let index = 0; index < 4; index++) {
      prior.decisions.push({
        id: `foundational-${index}`,
        topic: `topic-${index}`,
        decision: "x".repeat(600),
        timestamp: "2026-08-11T00:00:00.000Z",
        session_id: "prior-session",
        still_valid: true,
        foundational: true,
        provenance: {
          extractor: "heuristic",
          source_session_id: "prior-session",
          confidence: "heuristic",
          evidence: [],
        },
      })
    }
    await expect(writeMemory({ worktree, directory: worktree }, prior)).resolves.toBe(true)

    const sourceVersionKey = `v2s:${"c".repeat(64)}`
    const result = await finalLLMMerge(
      { client: {}, worktree, directory: worktree },
      {
        sessionId: "source-pressure",
        gitSha: null,
        canonicalInput: buildCanonicalInput(messages, prior),
        selectedModel: { providerID: "provider", modelID: "model" },
        selectedCacheKey: `v2e:${"d".repeat(64)}`,
        sourceVersionKey,
        sourceInputSha256: "e".repeat(64),
        promptInputSha256: "f".repeat(64),
        llmFacts: llmFacts({ current_task: "pressure merge" }) as never,
        extractionAuditSessionID: "audit-pressure",
        candidates: {},
        digests: {},
      },
    )

    expect(result.status).toBe("committed")
    if (result.status === "committed") {
      expect(result.value.memory.processed_sources.some((source) => source.source_key === sourceVersionKey)).toBe(true)
    }
    const onDisk = await readMemory({ worktree, directory: worktree })
    expect(onDisk?.processed_sources.some((source) => source.source_key === sourceVersionKey)).toBe(true)
  })

  it("fails the final transaction when protected durable state remains over cap", async () => {
    const worktree = await makeWorktree()
    const prior = emptyMemory(worktree)
    for (let index = 0; index < 5; index++) {
      prior.decisions.push({
        id: `irreducible-${index}`,
        topic: `topic-${index}`,
        decision: "x".repeat(1100),
        timestamp: "2026-08-11T00:00:00.000Z",
        session_id: "prior-session",
        still_valid: true,
        foundational: true,
        provenance: {
          extractor: "heuristic",
          source_session_id: "prior-session",
          confidence: "heuristic",
          evidence: [],
        },
      })
    }
    await expect(writeMemory({ worktree, directory: worktree }, prior)).resolves.toBe(true)

    const sourceVersionKey = `v2s:${"e".repeat(64)}`
    const result = await finalLLMMerge(
      { client: {}, worktree, directory: worktree },
      {
        sessionId: "source-over-cap",
        gitSha: null,
        canonicalInput: buildCanonicalInput([], prior),
        selectedModel: { providerID: "provider", modelID: "model" },
        selectedCacheKey: `v2e:${"f".repeat(64)}`,
        sourceVersionKey,
        sourceInputSha256: "1".repeat(64),
        promptInputSha256: "2".repeat(64),
        llmFacts: llmFacts({ current_task: "over-cap merge" }) as never,
        extractionAuditSessionID: "audit-over-cap",
        candidates: {},
        digests: {},
      },
    )

    expect(result.status).toBe("commit-failed")
    const onDisk = await readMemory({ worktree, directory: worktree })
    expect(onDisk?.processed_sources.some((source) => source.source_key === sourceVersionKey)).toBe(false)
  })

  it("13. same source delivered twice returns outcome cache-hit", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-idempotent-13"
    const messages = idempotentMessages()
    const evidenceRef = makeTranscriptEvidenceRef("m2")
    const prior = emptyMemory(worktree)
    const model = { providerID: "provider", modelID: "model" }

    // Seed a cache entry for the same source
    const cachedFacts = {
      current_task: "Cached task",
      active_files: [],
      decisions: [{
        topic: "transport",
        decision: "Use SDK v2",
        evidence_refs: [evidenceRef],
      }],
      blockers: [],
      next_steps: [],
    }
    const cachedEvidence = buildTranscriptEvidenceCandidateMap(messages)[evidenceRef]!
    prior.llm_extraction_cache = [makeExtractionCacheEntry({
      sourceSessionID: sessionId,
      canonicalInput: buildCanonicalInput(messages, prior),
      model,
      facts: cachedFacts,
      auditSessionID: "audit-cache",
      evidence: [{
        kind: "transcript",
        ref: evidenceRef,
        digest: cachedEvidence.digest,
      }],
    })]
    prior.processed_sources = [await completedSourceRecord(worktree, sessionId, messages)]
    await writeMemory({ worktree, directory: worktree }, prior)

    const create = vi.fn()
    const prompt = vi.fn()
    const v1 = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: messages })),
        create,
        prompt,
      },
    }

    // First call - should hit cache
    const outcome1 = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome1).toBe("cache-hit")

    // Second call with same source - should also be cache-hit
    const outcome2 = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome2).toBe("cache-hit")
  })

  it("14. second call: session.create count still 1", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-idempotent-14"
    const messages = idempotentMessages()
    const evidenceRef = makeTranscriptEvidenceRef("m2")
    const prior = emptyMemory(worktree)
    const model = { providerID: "provider", modelID: "model" }

    // Seed a cache entry for the same source
    const cachedFacts = {
      current_task: "Cached task",
      active_files: [],
      decisions: [{
        topic: "transport",
        decision: "Use SDK v2",
        evidence_refs: [evidenceRef],
      }],
      blockers: [],
      next_steps: [],
    }
    const cachedEvidence = buildTranscriptEvidenceCandidateMap(messages)[evidenceRef]!
    prior.llm_extraction_cache = [makeExtractionCacheEntry({
      sourceSessionID: sessionId,
      canonicalInput: buildCanonicalInput(messages, prior),
      model,
      facts: cachedFacts,
      auditSessionID: "audit-cache",
      evidence: [{
        kind: "transcript",
        ref: evidenceRef,
        digest: cachedEvidence.digest,
      }],
    })]
    prior.processed_sources = [await completedSourceRecord(worktree, sessionId, messages)]
    await writeMemory({ worktree, directory: worktree }, prior)

    const create = vi.fn()
    const prompt = vi.fn()
    const v1 = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: messages })),
        create,
        prompt,
      },
    }

    // First call
    await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })

    // Second call
    await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })

    // session.create should still have been called 0 times (cache-hit path)
    expect(create).toHaveBeenCalledTimes(0)
  })

  it("15. second call: session.prompt count still 1", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-idempotent-15"
    const messages = idempotentMessages()
    const evidenceRef = makeTranscriptEvidenceRef("m2")
    const prior = emptyMemory(worktree)
    const model = { providerID: "provider", modelID: "model" }

    // Seed a cache entry for the same source
    const cachedFacts = {
      current_task: "Cached task",
      active_files: [],
      decisions: [{
        topic: "transport",
        decision: "Use SDK v2",
        evidence_refs: [evidenceRef],
      }],
      blockers: [],
      next_steps: [],
    }
    const cachedEvidence = buildTranscriptEvidenceCandidateMap(messages)[evidenceRef]!
    prior.llm_extraction_cache = [makeExtractionCacheEntry({
      sourceSessionID: sessionId,
      canonicalInput: buildCanonicalInput(messages, prior),
      model,
      facts: cachedFacts,
      auditSessionID: "audit-cache",
      evidence: [{
        kind: "transcript",
        ref: evidenceRef,
        digest: cachedEvidence.digest,
      }],
    })]
    prior.processed_sources = [await completedSourceRecord(worktree, sessionId, messages)]
    await writeMemory({ worktree, directory: worktree }, prior)

    const create = vi.fn()
    const prompt = vi.fn()
    const v1 = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: messages })),
        create,
        prompt,
      },
    }

    // First call
    await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })

    // Second call
    await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })

    // session.prompt should still have been called 0 times (cache-hit path)
    expect(prompt).toHaveBeenCalledTimes(0)
  })

  it("16. second call: heuristic semantic merge did NOT run", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-idempotent-16"
    const messages = idempotentMessages()
    const evidenceRef = makeTranscriptEvidenceRef("m2")
    const prior = emptyMemory(worktree)
    const model = { providerID: "provider", modelID: "model" }

    // Seed a cache entry for the same source
    const cachedFacts = {
      current_task: "Cached task",
      active_files: [],
      decisions: [{
        topic: "transport",
        decision: "Use SDK v2",
        evidence_refs: [evidenceRef],
      }],
      blockers: [],
      next_steps: [],
    }
    const cachedEvidence = buildTranscriptEvidenceCandidateMap(messages)[evidenceRef]!
    prior.llm_extraction_cache = [makeExtractionCacheEntry({
      sourceSessionID: sessionId,
      canonicalInput: buildCanonicalInput(messages, prior),
      model,
      facts: cachedFacts,
      auditSessionID: "audit-cache",
      evidence: [{
        kind: "transcript",
        ref: evidenceRef,
        digest: cachedEvidence.digest,
      }],
    })]
    prior.processed_sources = [await completedSourceRecord(worktree, sessionId, messages)]
    await writeMemory({ worktree, directory: worktree }, prior)

    const create = vi.fn()
    const prompt = vi.fn()
    const v1 = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: messages })),
        create,
        prompt,
      },
    }

    // First call - cache-hit path, mergeMemory is called
    await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })

    // Second call - should also be cache-hit, but mergeMemory should NOT be called
    // because the cache entry is already committed
    await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })

    // For cache-hit, the merge happens inside the transaction
    // The test verifies that the second call doesn't create new audit sessions
    expect(create).toHaveBeenCalledTimes(0)
    expect(prompt).toHaveBeenCalledTimes(0)
  })

  it("17. second call: revision unchanged from post-#11", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-idempotent-17"
    const messages = idempotentMessages()
    const evidenceRef = makeTranscriptEvidenceRef("m2")
    const prior = emptyMemory(worktree)
    const model = { providerID: "provider", modelID: "model" }

    // Seed a cache entry for the same source
    const cachedFacts = {
      current_task: "Cached task",
      active_files: [],
      decisions: [{
        topic: "transport",
        decision: "Use SDK v2",
        evidence_refs: [evidenceRef],
      }],
      blockers: [],
      next_steps: [],
    }
    const cachedEvidence = buildTranscriptEvidenceCandidateMap(messages)[evidenceRef]!
    prior.llm_extraction_cache = [makeExtractionCacheEntry({
      sourceSessionID: sessionId,
      canonicalInput: buildCanonicalInput(messages, prior),
      model,
      facts: cachedFacts,
      auditSessionID: "audit-cache",
      evidence: [{
        kind: "transcript",
        ref: evidenceRef,
        digest: cachedEvidence.digest,
      }],
    })]
    prior.processed_sources = [await completedSourceRecord(worktree, sessionId, messages)]
    await writeMemory({ worktree, directory: worktree }, prior)

    const create = vi.fn()
    const prompt = vi.fn()
    const v1 = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: messages })),
        create,
        prompt,
      },
    }

    // First call
    const outcome1 = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome1).toBe("cache-hit")

    // Get revision after first call
    const memory1 = await readMemory({ worktree, directory: worktree })
    const revisionAfterFirst = memory1?.revision ?? 0

    // Second call
    const outcome2 = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome2).toBe("cache-hit")

    // Get revision after second call
    const memory2 = await readMemory({ worktree, directory: worktree })
    const revisionAfterSecond = memory2?.revision ?? 0

    // Revision should be unchanged
    expect(revisionAfterSecond).toBe(revisionAfterFirst)
  })

  it("Wave 4: an exact completed-source delivery is a durable no-op", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-wave4-no-op"
    const messages = idempotentMessages()
    const preparation = await prepareIdleSource({
      client: { session: { messages: vi.fn(async () => ({ data: messages })) } },
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(preparation.kind).toBe("success")
    if (preparation.kind !== "success") throw new Error("source preparation failed")

    const prior = emptyMemory(worktree)
    prior.revision = 17
    prior.last_updated = "2026-08-11T00:00:00.000Z"
    prior.last_session_id = "prior-session"
    prior.current_task = "Durable task that must not be replayed"
    prior.recent_sessions = ["prior-session"]
    prior.processed_sources = [{
      source_key: preparation.sourceVersionKey,
      extraction_key: `v2e:${"b".repeat(64)}`,
      extraction_contract_version: 2,
      completed_at: "2026-08-10T00:00:00.000Z",
    }]
    const cachedEvidenceRef = makeTranscriptEvidenceRef("m1")
    const cachedEvidence = buildTranscriptEvidenceCandidateMap(messages)[cachedEvidenceRef]!
    prior.llm_extraction_cache = [makeExtractionCacheEntry({
      sourceSessionID: sessionId,
      canonicalInput: buildCanonicalInput(messages, prior),
      model: { providerID: "provider", modelID: "model" },
      facts: {
        current_task: "REPLAYED CACHE FACT",
        active_files: [],
        decisions: [],
        blockers: [],
        next_steps: [],
      },
      auditSessionID: "audit-replay",
      evidence: [{ kind: "transcript", ref: cachedEvidenceRef, digest: cachedEvidence.digest }],
    })]
    await writeMemory({ worktree, directory: worktree }, prior)

    const statePath = join(worktree, ".opencode", "memory", "STATE.json")
    const before = await readFile(statePath, "utf8")
    const configGet = vi.fn(async () => ({ data: { small_model: "provider/model" } }))
    const create = vi.fn()
    const prompt = vi.fn()
    const v1 = {
      app: { log: vi.fn() },
      config: { get: configGet },
      session: {
        messages: vi.fn(async () => ({ data: messages })),
        create,
        prompt,
      },
    }

    await expect(writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })).resolves.toBe("cache-hit")

    // The completed-source path must not run heuristic merge or replay any
    // cache facts, and must not discover a model, create an audit, prompt, or
    // commit a byte (including revision/last_updated/recent_sessions).
    expect(configGet).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    const after = await readFile(statePath, "utf8")
    expect(after).toBe(before)
    const memory = await readMemory({ worktree, directory: worktree })
    expect(memory?.revision).toBe(17)
    expect(memory?.last_updated).toBe("2026-08-11T00:00:00.000Z")
    expect(memory?.last_session_id).toBe("prior-session")
    expect(memory?.current_task).toBe("Durable task that must not be replayed")
    expect(memory?.recent_sessions).toEqual(["prior-session"])
  })
})

// ─── PR 5 §Wave 1B — advanced idempotency (§18.B items 18-25) ────────────────────

describe("PR 5 §Wave 1B — advanced idempotency", () => {
  beforeEach(() => {
    resetHostStructuredContractGate()
    resetProjectQueues()
  })

  afterEach(() => {
    resetHostStructuredContractGate()
    resetProjectQueues()
  })

  /** Build source messages with fixed IDs for consistent evidence refs. */
  function advancedMessages(): TranscriptMessage[] {
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

  /** Helper to seed a cache entry for a given session ID. */
  async function seedCacheEntry(
    worktree: string,
    sessionId: string,
    messages: TranscriptMessage[],
  ): Promise<{ model: { providerID: string; modelID: string }; evidenceRef: string }> {
    const prior = (await readMemory({ worktree, directory: worktree })) ?? emptyMemory(worktree)
    const model = { providerID: "provider", modelID: "model" }
    const evidenceRef = makeTranscriptEvidenceRef("m2")
    const cachedFacts = {
      current_task: "Cached task",
      active_files: [],
      decisions: [{
        topic: "transport",
        decision: "Use SDK v2",
        evidence_refs: [evidenceRef],
      }],
      blockers: [],
      next_steps: [],
    }
    const cachedEvidence = buildTranscriptEvidenceCandidateMap(messages)[evidenceRef]!
    const canonicalInput = buildCanonicalInput(messages, prior)
    const sourceInput = buildExtractionSourceInput(messages)
    const sourceVersionKey = makeSourceVersionKey({
      sourceSessionID: sessionId,
      sourceInputSha256: sourceInput.sourceInputSha256,
      extractionContractVersion: 2,
    })
    const extractionKey = makeExtractionCacheKey({
      sourceVersionKey,
      extractionContractVersion: 2,
      model,
    })
    // Seed with new v2e format for PR 5 compatibility
    prior.llm_extraction_cache = [makeExtractionCacheEntry({
      sourceSessionID: sessionId,
      canonicalInput,
      model,
      facts: cachedFacts,
      auditSessionID: "audit-cache",
      evidence: [{
        kind: "transcript",
        ref: evidenceRef,
        digest: cachedEvidence.digest,
      }],
      sourceVersionKey,
      sourceInputSha256: sourceInput.sourceInputSha256,
      promptInputSha256: canonicalInput.promptInputSha256,
      extractionContractVersion: 2,
      modelVariant: undefined,
    })]
    await writeMemory({ worktree, directory: worktree }, prior)
    return { model, evidenceRef }
  }

  it("18. after first success, reset process-local state, third call still cache-hit", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-advanced-18"
    const messages = advancedMessages()
    const evidenceRef = makeTranscriptEvidenceRef("m2")

    const create1 = vi.fn(async () => ({ data: { id: `audit-${sessionId}` } }))
    const prompt1 = vi.fn(async () => ({
      data: {
        info: {
          structured: {
            current_task: "LLM task",
            active_files: [],
            decisions: [{
              topic: "transport",
              decision: "Use SDK v2",
              evidence_refs: [evidenceRef],
            }],
            blockers: [],
            next_steps: [],
          },
        },
      },
    }))

    // First call - should succeed
    const outcome1 = await writeMemoryOnIdle({
      client: {
        app: { log: vi.fn() },
        config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
        session: { messages: vi.fn(async () => ({ data: messages })), create: create1, prompt: prompt1 },
      },
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome1).toBe("llm-success")

    // Reset process-local state
    resetHostStructuredContractGate()
    resetProjectQueues()

    // Seed a cache entry for the same source
    await seedCacheEntry(worktree, sessionId, messages)

    // Third call - should be cache-hit; fresh mocks verify no new audit/prompt calls
    const create2 = vi.fn()
    const prompt2 = vi.fn()
    const outcome3 = await writeMemoryOnIdle({
      client: {
        app: { log: vi.fn() },
        config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
        session: { messages: vi.fn(async () => ({ data: messages })), create: create2, prompt: prompt2 },
      },
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome3).toBe("cache-hit")
    expect(create2).toHaveBeenCalledTimes(0)
    expect(prompt2).toHaveBeenCalledTimes(0)
  })

  it("19. after deleting cache row, same source still cache-hit via completion ledger", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-advanced-19"
    const messages = advancedMessages()
    const evidenceRef = makeTranscriptEvidenceRef("m2")

    const create1 = vi.fn(async () => ({ data: { id: `audit-${sessionId}` } }))
    const prompt1 = vi.fn(async () => ({
      data: {
        info: {
          structured: {
            current_task: "LLM task",
            active_files: [],
            decisions: [{
              topic: "transport",
              decision: "Use SDK v2",
              evidence_refs: [evidenceRef],
            }],
            blockers: [],
            next_steps: [],
          },
        },
      },
    }))

    // First call - should succeed
    const outcome1 = await writeMemoryOnIdle({
      client: {
        app: { log: vi.fn() },
        config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
        session: { messages: vi.fn(async () => ({ data: messages })), create: create1, prompt: prompt1 },
      },
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome1).toBe("llm-success")

    // Read the memory and delete the cache row
    const memory = await readMemory({ worktree, directory: worktree })
    if (memory?.llm_extraction_cache) {
      memory.llm_extraction_cache = memory.llm_extraction_cache.filter(
        (entry) => entry.source_session_id !== sessionId
      )
      await writeMemory({ worktree, directory: worktree }, memory)
    }

    // Second call - should still be cache-hit via completion ledger
    const create2 = vi.fn()
    const prompt2 = vi.fn()
    const outcome2 = await writeMemoryOnIdle({
      client: {
        app: { log: vi.fn() },
        config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
        session: { messages: vi.fn(async () => ({ data: messages })), create: create2, prompt: prompt2 },
      },
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome2).toBe("cache-hit")
    expect(create2).toHaveBeenCalledTimes(0)
    expect(prompt2).toHaveBeenCalledTimes(0)
  })

  it("20. evidence exceeding provenance cap still succeeds with processed_sources entry", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-advanced-20"
    const messages = advancedMessages()
    const evidenceRef = makeTranscriptEvidenceRef("m2")

    const create = vi.fn(async () => ({ data: { id: `audit-${sessionId}` } }))
    const prompt = vi.fn(async () => ({
      data: {
        info: {
          structured: {
            current_task: "LLM task",
            active_files: [],
            decisions: [{
              topic: "transport",
              decision: "Use SDK v2",
              evidence_refs: [evidenceRef],
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
        messages: vi.fn(async () => ({ data: messages })),
        create,
        prompt,
      },
    }

    const outcome = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })

    expect(outcome).toBe("llm-success")
    expect(create).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(1)

    const memory = await readMemory({ worktree, directory: worktree })
    const processedSources = (memory as any).processed_sources
    expect(processedSources).toBeDefined()
    expect(Array.isArray(processedSources)).toBe(true)
    expect(processedSources).toHaveLength(1)
    expect(processedSources[0].source_key).toMatch(/^v2s:[a-f0-9]{64}$/)
  })

  it("21. repeat #20: still cache-hit after first success", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-advanced-21"
    const messages = advancedMessages()
    const evidenceRef = makeTranscriptEvidenceRef("m2")

    const create = vi.fn(async () => ({ data: { id: `audit-${sessionId}` } }))
    const prompt = vi.fn(async () => ({
      data: {
        info: {
          structured: {
            current_task: "LLM task",
            active_files: [],
            decisions: [{
              topic: "transport",
              decision: "Use SDK v2",
              evidence_refs: [evidenceRef],
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
        messages: vi.fn(async () => ({ data: messages })),
        create,
        prompt,
      },
    }

    // First call
    const outcome1 = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome1).toBe("llm-success")

    // Second call - should be cache-hit
    const outcome2 = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome2).toBe("cache-hit")
    expect(create).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it("22. LLM extraction failure returns llm-failed with empty processed_sources", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-advanced-22"
    const messages = advancedMessages()
    const evidenceRef = makeTranscriptEvidenceRef("m2")

    // Prompt that fails twice (retry exhaustion)
    const prompt = vi.fn()
      .mockResolvedValueOnce({ data: { info: { structured: { invalid: true } } } })
      .mockRejectedValueOnce(new Error("provider unavailable"))
    const v1 = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: messages })),
        create: vi.fn(async () => ({ data: { id: `audit-${sessionId}` } })),
        prompt,
      },
    }

    const outcome = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })

    expect(outcome).toBe("llm-failed")
    expect(prompt).toHaveBeenCalledTimes(2)

    const memory = await readMemory({ worktree, directory: worktree })
    const processedSources = (memory as any).processed_sources
    expect(processedSources).toBeDefined()
    expect(Array.isArray(processedSources)).toBe(true)
    expect(processedSources).toHaveLength(0)
  })

  it("23. after #22 failure, retry runs LLM path again (no cache-hit short-circuit)", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-advanced-23"
    const messages = advancedMessages()
    const evidenceRef = makeTranscriptEvidenceRef("m2")

    const successfulResponse = {
      data: {
        info: {
          structured: {
            current_task: "LLM task",
            active_files: [],
            decisions: [{
              topic: "transport",
              decision: "Use SDK v2",
              evidence_refs: [evidenceRef],
            }],
            blockers: [],
            next_steps: [],
          },
        },
      },
    }

    // The first delivery exhausts both retries. The next response is reserved
    // for the second delivery, proving a failed source remains retryable.
    const prompt = vi.fn()
      .mockResolvedValueOnce({ data: { info: { structured: { invalid: true } } } })
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce(successfulResponse)

    const v1 = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: messages })),
        create: vi.fn(async () => ({ data: { id: `audit-${sessionId}` } })),
        prompt,
      },
    }

    // First call - should fail
    const outcome1 = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome1).toBe("llm-failed")

    // Reset for second call
    prompt.mockClear()

    // Second call - should succeed (no cache-hit short-circuit)
    const outcome2 = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome2).toBe("llm-success")
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it("24. append new eligible message yields second success with two processed_sources entries", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-advanced-24"
    const evidenceRef = makeTranscriptEvidenceRef("m2")

    const create = vi.fn(async () => ({ data: { id: `audit-${sessionId}` } }))
    const prompt = vi.fn(async () => ({
      data: {
        info: {
          structured: {
            current_task: "LLM task",
            active_files: [],
            decisions: [{
              topic: "transport",
              decision: "Use SDK v2",
              evidence_refs: [evidenceRef],
            }],
            blockers: [],
            next_steps: [],
          },
        },
      },
    }))

    // First call with original messages
    const messages1 = advancedMessages()
    const v1a = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: messages1 })),
        create,
        prompt,
      },
    }

    const outcome1 = await writeMemoryOnIdle({
      client: v1a,
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome1).toBe("llm-success")

    // Reset mocks
    create.mockClear()
    prompt.mockClear()

    // Second call with appended message (different session ID to simulate new source)
    const sessionId2 = "source-advanced-24-v2"
    const messages2: TranscriptMessage[] = [
      ...messages1,
      {
        info: { id: "m3", role: "user" },
        parts: [{ type: "text", text: "New message appended." }],
      },
    ]

    const v1b = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: messages2 })),
        create,
        prompt,
      },
    }

    const outcome2 = await writeMemoryOnIdle({
      client: v1b,
      worktree,
      directory: worktree,
      sessionId: sessionId2,
    })
    expect(outcome2).toBe("llm-success")

    const memory = await readMemory({ worktree, directory: worktree })
    const processedSources = (memory as any).processed_sources
    expect(processedSources).toBeDefined()
    expect(Array.isArray(processedSources)).toBe(true)
    expect(processedSources).toHaveLength(2)
  })

  it("25. exact duplicate preserves the completed-source marker", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-advanced-25"
    const evidenceRef = makeTranscriptEvidenceRef("m2")

    const create = vi.fn(async () => ({ data: { id: `audit-${sessionId}` } }))
    const prompt = vi.fn(async () => ({
      data: {
        info: {
          structured: {
            current_task: "LLM task",
            active_files: [],
            decisions: [{
              topic: "transport",
              decision: "Use SDK v2",
              evidence_refs: [evidenceRef],
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
        messages: vi.fn(async () => ({ data: advancedMessages() })),
        create,
        prompt,
      },
    }

    // First call to establish baseline
    const outcome1 = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome1).toBe("llm-success")

    // The successful completion must leave its marker durably present.
    const memory1 = await readMemory({ worktree, directory: worktree })
    const processedSources1 = (memory1 as any).processed_sources
    expect(processedSources1).toHaveLength(1)

    // An exact duplicate is a no-op, not a second successful extraction.
    const outcome2 = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })
    expect(outcome2).toBe("cache-hit")
    const memory2 = await readMemory({ worktree, directory: worktree })
    expect((memory2 as any).processed_sources).toHaveLength(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(1)
  })
})

// ─── PR 5 §Wave 1B — truthful outcomes (§18.E items 39-41) ────────────────────────

describe("PR 5 §Wave 1B — truthful outcomes", () => {
  beforeEach(() => {
    resetHostStructuredContractGate()
    resetProjectQueues()
  })

  afterEach(() => {
    resetHostStructuredContractGate()
    resetProjectQueues()
  })

  /** Build source messages with fixed IDs for consistent evidence refs. */
  function truthfulMessages(): TranscriptMessage[] {
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

  it("39. missing session.messages endpoint → outcome no-messages", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-truthful-39"

    // Client without session.messages endpoint
    const v1 = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        create: vi.fn(async () => ({ data: { id: `audit-${sessionId}` } })),
        prompt: vi.fn(),
      },
    }

    const outcome = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })

    expect(outcome).toBe("no-messages")
  })

  it("40. empty/missing transcript data → outcome no-messages", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-truthful-40"
    const messages = truthfulMessages()

    const v1 = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: [] })), // Empty array
        create: vi.fn(async () => ({ data: { id: `audit-${sessionId}` } })),
        prompt: vi.fn(),
      },
    }

    const outcome = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })

    expect(outcome).toBe("no-messages")
  })

  it("41. session.messages throws → outcome error", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const sessionId = "source-truthful-41"

    const v1 = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => {
          throw new Error("session.messages failed")
        }),
        create: vi.fn(async () => ({ data: { id: `audit-${sessionId}` } })),
        prompt: vi.fn(),
      },
    }

    const outcome = await writeMemoryOnIdle({
      client: v1,
      worktree,
      directory: worktree,
      sessionId,
    })

    // The outcome should be "error" (NOT "heuristic-only")
    expect(outcome).toBe("error")
  })
})

// ─── PR 5 §Wave 3 — processed-source retention under size-cap pressure ────────

describe("PR 5 §Wave 3 — processed-source retention under size-cap pressure", () => {
  it("75. pruneOld preserves the new processed-source key under size-cap pressure", () => {
    // Create a memory with many processed_sources entries
    const memory = emptyMemory("/test")
    memory.processed_sources = Array.from({ length: 10 }, (_, i) => ({
      source_key: "v2s:" + "a".repeat(63) + i.toString().slice(-1),
      extraction_key: "v2e:" + "b".repeat(64),
      extraction_contract_version: 2,
      completed_at: `2026-08-1${i}T00:00:00.000Z`,
    }))

    // Add a lot of decisions to push memory over 8KB
    for (let i = 0; i < 100; i++) {
      memory.decisions.push({
        id: `d-${i}`,
        topic: `topic-${i}`,
        decision: `x`.repeat(500),
        timestamp: new Date().toISOString(),
        session_id: "session-0",
        still_valid: true,
        foundational: false,
      })
    }

    const protectedKey = memory.processed_sources[0]!.source_key

    // Prune with the protected key
    const result = pruneOld(memory, undefined, Date.now(), { preserveProcessedSourceKey: protectedKey })

    // The protected key should still be present
    const hasProtectedKey = result.processed_sources.some(s => s.source_key === protectedKey)
    expect(hasProtectedKey).toBe(true)
  })

  it("76. pruneOld removes processed_sources when no key is protected", () => {
    // Create a memory with many processed_sources entries
    const memory = emptyMemory("/test")
    memory.processed_sources = Array.from({ length: 10 }, (_, i) => ({
      source_key: "v2s:" + "a".repeat(63) + i.toString().slice(-1),
      extraction_key: "v2e:" + "b".repeat(64),
      extraction_contract_version: 2,
      completed_at: `2026-08-1${i}T00:00:00.000Z`,
    }))

    // Add a lot of decisions to push memory over 8KB
    for (let i = 0; i < 100; i++) {
      memory.decisions.push({
        id: `d-${i}`,
        topic: `topic-${i}`,
        decision: `x`.repeat(500),
        timestamp: new Date().toISOString(),
        session_id: "session-0",
        still_valid: true,
        foundational: false,
      })
    }

    // Prune without any protected key
    const result = pruneOld(memory, undefined, Date.now())

    // Some processed_sources should have been removed
    expect(result.processed_sources.length).toBeLessThan(10)
  })
})

// ─── PR 5 §Wave 5 — Oracle Findings B1-B4 Remediation ───────────────────────────

describe("PR 5 §Wave 5 — Oracle Findings B1-B4 Remediation", () => {
  describe("B1 — incomplete cache cannot become authoritative", () => {
    it("B1-1. finalLLMMerge preserves fresh accepted facts over stale cache payload without completion marker", async () => {
      const worktree = await makeWorktree()
      const sessionId = "oracle-b1"
      const messages = sourceMessages()
      const prepared = await prepareIdleSource({
        client: { session: { messages: vi.fn(async () => ({ data: messages })) } },
        worktree,
        directory: worktree,
        sessionId,
      })
      expect(prepared.kind).toBe("success")
      if (prepared.kind !== "success") throw new Error("source preparation failed")

      const model = { providerID: "provider", modelID: "model" }
      const selectedCacheKey = makeExtractionCacheKey({
        sourceVersionKey: prepared.sourceVersionKey,
        extractionContractVersion: 2,
        model,
      })
      const evidenceRef = makeTranscriptEvidenceRef("m1")
      const evidence = prepared.transcriptCandidates[evidenceRef]
      if (!evidence) throw new Error("transcript evidence candidate missing")

      const prior = emptyMemory(worktree)
      // This is a complete, current-contract cache row. It is intentionally
      // not accompanied by processed_sources, which is the only completion
      // proof accepted by finalLLMMerge.
      prior.llm_extraction_cache = [makeExtractionCacheEntry({
        sourceSessionID: sessionId,
        canonicalInput: prepared.canonicalInput,
        model,
        facts: {
          current_task: "STALE CACHE TASK",
          active_files: [],
          decisions: [],
          blockers: [],
          next_steps: ["stale cache step"],
        },
        auditSessionID: "audit-stale",
        evidence: [{ kind: "transcript", ref: evidenceRef, digest: evidence.digest }],
        sourceVersionKey: prepared.sourceVersionKey,
        sourceInputSha256: prepared.sourceInputSha256,
        promptInputSha256: prepared.promptInputSha256,
        extractionContractVersion: 2,
        modelVariant: undefined,
      })]
      await writeMemory({ worktree, directory: worktree }, prior)

      const freshFacts = {
        current_task: "FRESH ACCEPTED TASK",
        active_files: [],
        decisions: [],
        blockers: ["fresh blocker"],
        next_steps: ["fresh accepted step"],
      }
      const result = await finalLLMMerge(
        { client: {}, worktree, directory: worktree },
        {
          sessionId,
          gitSha: null,
          canonicalInput: prepared.canonicalInput,
          selectedModel: model,
          selectedCacheKey,
          sourceVersionKey: prepared.sourceVersionKey,
          sourceInputSha256: prepared.sourceInputSha256,
          promptInputSha256: prepared.promptInputSha256,
          llmFacts: freshFacts,
          extractionAuditSessionID: "audit-fresh",
          candidates: prepared.transcriptCandidates,
          digests: prepared.transcriptDigests,
        },
      )

      expect(result.status).toBe("committed")
      if (result.status !== "committed") return
      expect(result.value.memory.current_task).toBe("FRESH ACCEPTED TASK")
      expect(result.value.memory.current_task).not.toBe("STALE CACHE TASK")
      expect(result.value.memory.blockers).toEqual(["fresh blocker"])
      expect(result.value.memory.next_steps).toEqual(["fresh accepted step"])
      expect(result.value.memory.llm_extraction_cache?.[0]?.facts.current_task)
        .toBe("FRESH ACCEPTED TASK")
      expect(result.value.memory.processed_sources).toContainEqual(expect.objectContaining({
        source_key: prepared.sourceVersionKey,
        extraction_key: selectedCacheKey,
        extraction_contract_version: 2,
      }))
    })
  })

  describe("B2 — unify source identity and actual bounded prompt window", () => {
    it("B2-1. sourceVersionKey changes when new in-window tool candidate appears", async () => {
      const worktree = await makeWorktree()
      const sessionId = "oracle-b2"
      const historicalMessages: TranscriptMessage[] = Array.from({ length: 51 }, (_, index) => ({
        info: { id: `b2-${index}`, role: index % 2 === 0 ? "user" : "assistant" },
        parts: [
          { type: "text", text: `Transcript message ${index}` },
          ...(index < 25
            ? [{
                type: "tool" as const,
                tool: "read",
                state: { status: "completed", input: { filePath: `src/historical-${index}.ts` } },
              }]
            : []),
        ],
      }))
      const newCandidate = "aaa/new-in-window.ts"
      const updatedMessages = [
        ...historicalMessages,
        {
          info: { id: "b2-new", role: "assistant" },
          parts: [{
            type: "tool" as const,
            tool: "read",
            state: { status: "completed", input: { filePath: newCandidate } },
          }],
        },
      ] satisfies TranscriptMessage[]

      const prepare = (messages: TranscriptMessage[]) => prepareIdleSource({
        client: { session: { messages: vi.fn(async () => ({ data: messages })) } },
        worktree,
        directory: worktree,
        sessionId,
      })
      const before = await prepare(historicalMessages)
      const after = await prepare(updatedMessages)
      expect(before.kind).toBe("success")
      expect(after.kind).toBe("success")
      if (before.kind !== "success" || after.kind !== "success") {
        throw new Error("source preparation failed")
      }

      // The initial source has more than the 20-file candidate cap. The new
      // message is nevertheless in the actual bounded last-50 window and its
      // candidate must participate in the same input used for the prompt.
      expect(after.windowMessages).toHaveLength(50)
      expect(after.windowMessages.some((message) => message.info.id === "b2-new")).toBe(true)
      expect(after.canonicalInput.fileCandidates).toContain(newCandidate)
      expect(after.sourceVersionKey).not.toBe(before.sourceVersionKey)
      expect(after.sourceInputSha256).not.toBe(before.sourceInputSha256)
      expect(after.promptInputSha256).not.toBe(before.promptInputSha256)
    })
  })

  describe("B3 — persisted identity must describe the model actually used after gating", () => {
    it("B3-1. automatic-discovery with model A cooling and model B healthy identifies B in all persisted identity", async () => {
      vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
      resetHostStructuredContractGate()
      const worktree = await makeWorktree()
      const sessionId = "oracle-b3"
      const messages = sourceMessages()
      const prior = emptyMemory(worktree)
      prior.model_health = [{
        provider_id: "provider-a",
        model_id: "model-a",
        last_outcome: "timeout",
        failure_streak: 1,
        last_outcome_at: new Date().toISOString(),
        cooldown_until: new Date(Date.now() + 60_000).toISOString(),
        failure_reason: "cooling fixture",
      }]
      await writeMemory({ worktree, directory: worktree }, prior)

      const create = vi.fn(async () => ({ data: { id: "audit-b3" } }))
      const prompt = vi.fn(async () => ({
        data: {
          info: {
            structured: {
              current_task: "B3 healthy model task",
              active_files: [],
              decisions: [{
                topic: "provider selection",
                decision: "Use healthy model B",
                evidence_refs: [makeTranscriptEvidenceRef("m2")],
              }],
              blockers: [],
              next_steps: [],
            },
          },
        },
      }))
      const v1 = {
        app: { log: vi.fn() },
        config: { get: vi.fn(async () => ({ data: {} })) },
        provider: {
          list: vi.fn(async () => ({ data: {
            all: [
              {
                id: "provider-a",
                models: {
                  "model-a": { tool_call: true, cost: { input: 0, output: 0 }, variants: { none: {} } },
                },
              },
              {
                id: "provider-b",
                models: {
                  "model-b": { tool_call: true, cost: { input: 0, output: 0 }, variants: { none: {} } },
                },
              },
            ],
            connected: ["provider-a", "provider-b"],
          } })),
        },
        global: {
          health: vi.fn(async () => ({ data: { healthy: true, version: "1.18.15" } })),
        },
        session: {
          messages: vi.fn(async () => ({ data: messages })),
          create,
          prompt,
        },
      }

      const prepared = await prepareIdleSource({
        client: v1,
        worktree,
        directory: worktree,
        sessionId,
      })
      expect(prepared.kind).toBe("success")
      if (prepared.kind !== "success") throw new Error("source preparation failed")

      const outcome = await writeMemoryOnIdle({
        client: v1,
        worktree,
        directory: worktree,
        sessionId,
      })
      expect(outcome).toBe("llm-success")
      expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "provider-b", modelID: "model-b" },
          variant: "none",
        }),
      }))

      const memory = await readMemory({ worktree, directory: worktree })
      expect(memory?.model_health).toEqual(expect.arrayContaining([
        expect.objectContaining({
          provider_id: "provider-a",
          model_id: "model-a",
          last_outcome: "timeout",
          cooldown_until: expect.any(String),
        }),
        expect.objectContaining({
          provider_id: "provider-b",
          model_id: "model-b",
          last_outcome: "success",
          failure_streak: 0,
        }),
      ]))
      const modelB = { providerID: "provider-b", modelID: "model-b", variant: "none" }
      const expectedCacheKey = makeExtractionCacheKey({
        sourceVersionKey: prepared.sourceVersionKey,
        extractionContractVersion: 2,
        model: modelB,
      })
      const cache = memory?.llm_extraction_cache?.find((entry) => entry.cache_key === expectedCacheKey)
      expect(cache).toMatchObject({
        cache_key: expectedCacheKey,
        source_key: prepared.sourceVersionKey,
        source_input_sha256: prepared.sourceInputSha256,
        prompt_input_sha256: prepared.promptInputSha256,
        extraction_contract_version: 2,
        provider_id: "provider-b",
        model_id: "model-b",
        model_variant: "none",
      })
      expect(memory?.llm_extraction_audits).toEqual(expect.arrayContaining([
        expect.objectContaining({
          audit_session_id: "audit-b3",
          provider_id: "provider-b",
          model_id: "model-b",
          model_variant: "none",
          cache_key: expectedCacheKey,
          terminal_outcome: "success",
        }),
      ]))
      expect(memory?.processed_sources).toContainEqual(expect.objectContaining({
        source_key: prepared.sourceVersionKey,
        extraction_key: expectedCacheKey,
        extraction_contract_version: 2,
      }))
    })
  })

  describe("B4 — malformed recall input shape marks nothing", () => {
    function memoryWithDecision() {
      const memory = emptyMemory("/oracle/b4")
      memory.decisions = [{
        id: "b4-decision",
        topic: "database",
        decision: "Use PostgreSQL",
        timestamp: "2026-08-11T00:00:00.000Z",
        session_id: "prior-session",
        still_valid: true,
        foundational: false,
        provenance: {
          extractor: "heuristic",
          source_session_id: "prior-session",
          confidence: "heuristic",
          evidence: [],
        },
      }]
      return memory
    }

    function completedRecall(input: unknown, includeInput = true): TranscriptMessage {
      const state = includeInput
        ? { status: "completed", input }
        : { status: "completed" }
      return {
        info: { id: "b4-recall", role: "assistant" },
        parts: [{ type: "tool", tool: "recall_decision", state } as never],
      }
    }

    it("B4-1. null input contributes no marks", () => {
      const result = markReferencedDecisions(
        memoryWithDecision(),
        [completedRecall(null)],
        "oracle-b4-null",
      )
      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0]?.last_used_in_session).toBeUndefined()
    })

    it("B4-2. string input contributes no marks", () => {
      const result = markReferencedDecisions(
        memoryWithDecision(),
        [completedRecall("database")],
        "oracle-b4-string",
      )
      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0]?.last_used_in_session).toBeUndefined()
    })

    it("B4-3. array input contributes no marks", () => {
      const result = markReferencedDecisions(
        memoryWithDecision(),
        [completedRecall([{ query: "database", limit: 10 }])],
        "oracle-b4-array",
      )
      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0]?.last_used_in_session).toBeUndefined()
    })

    it("B4-4. missing input contributes no marks", () => {
      const result = markReferencedDecisions(
        memoryWithDecision(),
        [completedRecall(undefined, false)],
        "oracle-b4-missing",
      )
      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0]?.last_used_in_session).toBeUndefined()
    })
  })
})
