import { afterEach, describe, expect, it, vi } from "vitest"
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { writeMemoryOnIdle } from "../../src/memory/writer"
import { pruneOld } from "../../src/memory/writer"
import { readMemory, writeMemory } from "../../src/memory/store"
import { globalMemoryPath, projectMemoryPath } from "../../src/memory/paths"
import { emptyMemory, type LLMAuditMetadata } from "../../src/memory/schema"
import { atomicWrite } from "../../src/util/fs"
import {
  isPersistedRetainedExtractionSession,
  extractFactsLLM,
  LLM_REQUEST_TIMEOUT_MS,
} from "../../src/memory/extract-llm"
import { resetHostStructuredContractGate } from "../../src/memory/llm-adapter"
import { buildCanonicalInput, makeTranscriptEvidenceRef } from "../../src/memory/extract-prompt"
import { resetProjectQueues } from "../../src/memory/lock"
import { MEMORY_MAX_BYTES, memorySizeBytes } from "../../src/memory/memory-size"
import type { TranscriptMessage } from "../../src/types"

const directories: string[] = []

function messages(sessionID = "source"): TranscriptMessage[] {
  return [
    {
      info: { id: `${sessionID}-user`, role: "user" },
      parts: [{ type: "text", text: `Implement ${sessionID} extraction.` }],
    },
    {
      info: { id: `${sessionID}-assistant`, role: "assistant" },
      parts: [{ type: "text", text: "We will use a bounded queue for this project." }],
    },
  ]
}

async function worktree(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tokenmaxxer-p0-a-"))
  directories.push(directory)
  return directory
}

function clientFor(
  sessionMap: Record<string, TranscriptMessage[]>,
  create = vi.fn(async (args: { body: { title: string } }) => ({
    data: { id: `audit-${args.body.title.slice(-8)}` },
  })),
) {
  return {
    app: { log: vi.fn() },
    config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
    session: {
      messages: vi.fn(async ({ path }: { path: { id: string } }) => ({ data: sessionMap[path.id] })),
      create,
      prompt: vi.fn(async (args: unknown) => {
        const serialized = JSON.stringify(args)
        const sessionID = Object.keys(sessionMap).find((id) => (
          serialized.includes(`Implement ${id} extraction.`)
        )) ?? Object.keys(sessionMap)[0]!
        return {
          data: {
            info: {
              structured: {
                decisions: [{
                  topic: "queue",
                  decision: "Use a bounded queue",
                  evidence_refs: [makeTranscriptEvidenceRef(`${sessionID}-assistant`)],
                }],
              },
            },
          },
        }
      }),
    },
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetHostStructuredContractGate()
  resetProjectQueues()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("P0-A idle reliability", () => {
  it("rejects an oversized direct memory write with structured logging", async () => {
    const project = await worktree()
    const appLog = vi.fn()
    const warn = vi.spyOn(console, "warn")
    const error = vi.spyOn(console, "error")
    const oversized = {
      ...emptyMemory(project),
      next_steps: ["x".repeat(9_000)],
    }

    await expect(writeMemory({
      worktree: project,
      directory: project,
      client: { app: { log: appLog } },
    }, oversized)).resolves.toBe(false)

    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(appLog).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        level: "error",
        message: "tokenmaxxer: STATE.json write rejected: exceeds 8192-byte cap",
        extra: expect.objectContaining({
          bytes: expect.any(Number),
          max_bytes: MEMORY_MAX_BYTES,
        }),
      }),
    }))
    expect(await readMemory({ worktree: project, directory: project })).toBeNull()
  })

  it("uses UTF-8 bytes and accepts exactly the cap but rejects one byte over", async () => {
    const project = await worktree()
    const seed = { ...emptyMemory(project), next_steps: [""] }
    const exact = {
      ...emptyMemory(project),
      next_steps: ["x".repeat(MEMORY_MAX_BYTES - memorySizeBytes(seed))],
    }
    expect(memorySizeBytes(exact)).toBe(MEMORY_MAX_BYTES)
    expect(await writeMemory({ worktree: project, directory: project }, exact)).toBe(true)

    const crossing = {
      ...exact,
      next_steps: [`${exact.next_steps[0]}x`],
    }
    expect(memorySizeBytes(crossing)).toBe(MEMORY_MAX_BYTES + 1)
    expect(await writeMemory({ worktree: project, directory: project }, crossing)).toBe(false)
  })

  it("accounts for multibyte UTF-8 content rather than JavaScript characters", () => {
    const project = "/worktree"
    const ascii = { ...emptyMemory(project), next_steps: ["a".repeat(128)] }
    const multibyte = { ...emptyMemory(project), next_steps: ["é".repeat(128)] }

    expect(memorySizeBytes(multibyte) - memorySizeBytes(ascii)).toBe(128)
  })

  it("coalesces concurrent same-source writes into one audit and cache", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const project = await worktree()
    const client = clientFor({ source: messages() })
    const first = writeMemoryOnIdle({ client, worktree: project, directory: project, sessionId: "source" })
    const second = writeMemoryOnIdle({ client, worktree: project, directory: project, sessionId: "source" })

    await expect(Promise.all([first, second])).resolves.toEqual(["llm-success", "llm-success"])
    expect(client.session.create).toHaveBeenCalledTimes(1)
    expect(client.session.prompt).toHaveBeenCalledTimes(1)
    const memory = await readMemory({ worktree: project, directory: project })
    expect(memory?.llm_extraction_cache).toHaveLength(1)
    expect(memory?.llm_extraction_audits).toHaveLength(1)
    expect(memory?.llm_extraction_audits?.[0]?.terminal_outcome).toBe("success")
  })

  it("serializes different sources without clobbering either cache entry", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const project = await worktree()
    const client = clientFor({ first: messages("first"), second: messages("second") })

    await Promise.all([
      writeMemoryOnIdle({ client, worktree: project, directory: project, sessionId: "first" }),
      writeMemoryOnIdle({ client, worktree: project, directory: project, sessionId: "second" }),
    ])

    const memory = await readMemory({ worktree: project, directory: project })
    expect(new Set(memory?.llm_extraction_cache?.map((entry) => entry.source_session_id))).toEqual(
      new Set(["first", "second"]),
    )
    expect(client.session.prompt).toHaveBeenCalledTimes(2)
  })

  it("does not serialize unrelated projects", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const firstProject = await worktree()
    const secondProject = await worktree()
    let active = 0
    let maximum = 0
    const sharedMessages = vi.fn(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return { data: messages() }
    })
    const makeClient = () => ({
      session: { messages: sharedMessages },
    })

    await Promise.all([
      writeMemoryOnIdle({ client: makeClient(), worktree: firstProject, directory: firstProject, sessionId: "first" }),
      writeMemoryOnIdle({ client: makeClient(), worktree: secondProject, directory: secondProject, sessionId: "second" }),
    ])
    expect(maximum).toBe(2)
  })

  it("uses persisted audit metadata as the reload-safe idle guard", async () => {
    const project = await worktree()
    const memory = emptyMemory(project)
    memory.llm_extraction_audits = [{
      audit_session_id: "audit-reloaded",
      source_session_id: "source",
      cache_key: "source:sha256:provider/model",
      provider_id: "provider",
      model_id: "model",
      created_at: new Date().toISOString(),
      terminal_outcome: "pending",
    }]
    expect(await writeMemory({ worktree: project, directory: project }, memory)).toBe(true)
    expect(await isPersistedRetainedExtractionSession({
      sessionID: "audit-reloaded",
      worktree: project,
      directory: project,
    })).toBe(true)
  })

  it("caps pending audit guards at twenty and keeps STATE.json schema-valid", async () => {
    const project = await worktree()
    const audits: LLMAuditMetadata[] = Array.from({ length: 21 }, (_, index) => ({
      audit_session_id: `audit-pending-${index}`,
      source_session_id: `source-${index}`,
      cache_key: `cache-${index}`,
      provider_id: "provider",
      model_id: "model",
      created_at: new Date(2026, 0, index + 1).toISOString(),
      terminal_outcome: "pending" as const,
    }))
    const bounded = pruneOld({ ...emptyMemory(project), llm_extraction_audits: audits })

    expect(bounded.llm_extraction_audits).toHaveLength(20)
    expect(bounded.llm_extraction_audits?.map((audit) => audit.audit_session_id))
      .toEqual(audits.slice(1).map((audit) => audit.audit_session_id))
    expect(await writeMemory({ worktree: project, directory: project }, bounded)).toBe(true)
    const loaded = await readMemory({ worktree: project, directory: project })
    expect(loaded?.llm_extraction_audits).toHaveLength(20)
  })

  it("reclassifies stale pending audits before evicting disposable metadata", () => {
    const now = Date.parse("2026-08-09T00:00:00.000Z")
    const stale: LLMAuditMetadata = {
      audit_session_id: "audit-stale",
      source_session_id: "source-stale",
      cache_key: "x".repeat(256),
      provider_id: "p".repeat(256),
      model_id: "m".repeat(256),
      created_at: new Date(now - (2 * LLM_REQUEST_TIMEOUT_MS + 1)).toISOString(),
      terminal_outcome: "pending",
    }
    const active: LLMAuditMetadata = {
      ...stale,
      audit_session_id: "audit-active",
      source_session_id: "source-active",
      created_at: new Date(now - 2 * LLM_REQUEST_TIMEOUT_MS).toISOString(),
    }

    const result = pruneOld({
      ...emptyMemory("/worktree"),
      llm_extraction_audits: [stale, active],
      next_steps: ["x".repeat(10_000)],
    }, undefined, now)

    expect(result.llm_extraction_audits?.find((audit) => audit.audit_session_id === "audit-stale"))
      .toBeUndefined()
    expect(result.llm_extraction_audits?.find((audit) => audit.audit_session_id === "audit-active"))
      .toMatchObject({ terminal_outcome: "pending" })
  })

  it("drops cache and health metadata before valid durable decisions", () => {
    const memory = emptyMemory("/worktree")
    memory.current_task = "Keep this current task"
    memory.decisions = [{
      id: "durable-1",
      topic: "durable-topic",
      decision: "Keep this valid decision",
      timestamp: "2026-08-09T00:00:00.000Z",
      session_id: "source",
      still_valid: true,
      foundational: false,
    }]
    memory.llm_extraction_cache = Array.from({ length: 10 }, (_, index) => ({
      cache_key: `cache-${index}`,
      source_session_id: "source",
      canonical_input_sha256: "a".repeat(64),
      provider_id: "provider",
      model_id: "model",
      completed_at: new Date(2026, 0, index + 1).toISOString(),
      facts: {
        current_task: null,
        active_files: [],
        decisions: [],
        blockers: [],
        next_steps: [],
      },
    }))
    memory.model_health = Array.from({ length: 10 }, (_, index) => ({
      provider_id: `provider-${index}`,
      model_id: "model",
      last_outcome: "success" as const,
      failure_streak: 0,
      last_outcome_at: new Date(2026, 0, index + 1).toISOString(),
    }))
    memory.llm_extraction_cache_quarantine = { count: 10, reason: "test" }
    memory.next_steps = ["x".repeat(10_000)]

    const result = pruneOld(memory, undefined, Date.parse("2026-08-09T00:00:00.000Z"))

    expect(result.llm_extraction_cache).toHaveLength(0)
    expect(result.model_health).toHaveLength(0)
    expect(result.llm_extraction_cache_quarantine).toBeUndefined()
    expect(result.decisions).toHaveLength(1)
    expect(result.decisions[0]?.topic).toBe("durable-topic")
  })

  it("prunes oldest completed audit metadata before other state reductions", () => {
    const large = "x".repeat(256)
    const audits: LLMAuditMetadata[] = [
      {
        audit_session_id: "audit-pending-size",
        source_session_id: "source-pending-size",
        cache_key: large,
        provider_id: large,
        model_id: large,
        created_at: new Date(2026, 0, 30).toISOString(),
        terminal_outcome: "pending",
      },
      ...Array.from({ length: 19 }, (_, index) => ({
        audit_session_id: `audit-completed-size-${index}`,
        source_session_id: `source-completed-size-${index}`,
        cache_key: large,
        provider_id: large,
        model_id: large,
        created_at: new Date(2026, 0, index + 1).toISOString(),
        terminal_outcome: "success" as const,
      })),
    ]

    const pruned = pruneOld({ ...emptyMemory("/worktree"), llm_extraction_audits: audits })
    expect(pruned.llm_extraction_audits?.length).toBeLessThan(20)
    expect(pruned.llm_extraction_audits?.some((audit) => audit.audit_session_id === "audit-pending-size"))
      .toBe(true)
    expect(pruned.llm_extraction_audits?.some((audit) => audit.audit_session_id === "audit-completed-size-0"))
      .toBe(false)
  })

  it("excludes audit guards from the canonical cache fingerprint", () => {
    const base = emptyMemory("/worktree")
    const withAudit = {
      ...base,
      llm_extraction_audits: [{
        audit_session_id: "audit-canonical",
        source_session_id: "source",
        cache_key: "source:sha256:provider/model",
        provider_id: "provider",
        model_id: "model",
        created_at: new Date().toISOString(),
        terminal_outcome: "pending" as const,
      }],
    }

    const withoutAudit = buildCanonicalInput(messages(), base)
    const operationalAudit = buildCanonicalInput(messages(), withAudit)
    expect(operationalAudit.sha256).toBe(withoutAudit.sha256)
    expect(operationalAudit.priorStateJson).toBe(withoutAudit.priorStateJson)
  })

  it("does not prompt when audit registration fails, while prior heuristics remain readable", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const project = await worktree()
    const heuristic = emptyMemory(project)
    heuristic.current_task = "heuristic fallback"
    await writeMemory({ worktree: project, directory: project }, heuristic)

    const prompt = vi.fn()
    const input = buildCanonicalInput(messages(), heuristic)
    const result = await extractFactsLLM(
      input,
      "source",
      "project",
      { session: { create: vi.fn(async () => ({ data: { id: "audit-no-persist" } })), prompt } },
      { enabled: true, model: { providerID: "provider", modelID: "model" } },
      { directory: project, onAuditCreated: () => false },
    )

    expect(result).toEqual({ status: "guard-failed" })
    expect(prompt).not.toHaveBeenCalled()
    expect((await readMemory({ worktree: project, directory: project }))?.current_task)
      .toBe("heuristic fallback")
  })

  it("falls back to persisted heuristics before audit creation on an old host", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    resetHostStructuredContractGate()
    const project = await worktree()
    const base = clientFor({ source: messages() })
    const client = {
      ...base,
      global: {
        health: vi.fn(async () => ({
          data: { healthy: true, version: "1.17.99" },
        })),
      },
    }

    await expect(writeMemoryOnIdle({
      client,
      worktree: project,
      directory: project,
      sessionId: "source",
    })).resolves.toBe("heuristic-only")
    expect(client.global.health).toHaveBeenCalledTimes(1)
    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.session.prompt).not.toHaveBeenCalled()
    expect(JSON.stringify(client.app.log.mock.calls)).not.toContain("Implement source extraction")
    expect(client.app.log.mock.calls.some(([entry]) => (
      entry?.body?.message === "sdk_host_version_gate" &&
      entry.body.extra?.reason === "unsupported-version"
    ))).toBe(true)
  })

  it("does not destroy durable local memory when STATE is unreadable and no global exists", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()
    const statePath = projectMemoryPath(project)
    const seeded = emptyMemory(project)
    seeded.revision = 5
    seeded.decisions = [{
      id: "local-durable-1",
      topic: "local-durable-topic",
      decision: "Keep the local durable decision",
      timestamp: "2026-08-09T00:00:00.000Z",
      session_id: "source",
      still_valid: true,
      foundational: false,
      provenance: {
        extractor: "legacy",
        source_session_id: "legacy",
        confidence: "legacy",
        evidence: [],
      },
    }]
    await mkdir(join(project, ".opencode", "memory"), { recursive: true })
    await atomicWrite(statePath, JSON.stringify(seeded, null, 2))

    // Force EACCES with chmod 000 (non-root UID): readFile is genuinely
    // denied while the file's content stays intact on disk. The parent
    // directory remains writable, so any attempted atomic rename would
    // succeed — exactly the destructive case the writer must refuse.
    await chmod(statePath, 0o000)

    const client = clientFor({ source: messages() })
    const outcome = await writeMemoryOnIdle({
      client,
      worktree: project,
      directory: project,
      sessionId: "source",
    })

    // Fail closed: no mutation may proceed from an unknown base.
    expect(outcome).toBe("write-failed")

    // Durable memory must be untouched: restore readability and read the file
    // directly (bypassing the store cache) to prove the decision + revision
    // survived.
    await chmod(statePath, 0o644)
    const raw = await readFile(statePath, "utf-8")
    const onDisk = JSON.parse(raw) as { revision: number; decisions: Array<{ topic: string }> }
    expect(onDisk.revision).toBe(5)
    expect(onDisk.decisions.some((decision) => decision.topic === "local-durable-topic")).toBe(true)
  })

  it("preserves durable global memory when only the local STATE is unreadable", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()
    const localPath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)
    const globalMemory = emptyMemory(project)
    globalMemory.revision = 2
    globalMemory.decisions = [{
      id: "global-durable-1",
      topic: "global-durable-topic",
      decision: "Keep the global durable decision",
      timestamp: "2026-08-09T00:00:00.000Z",
      session_id: "source",
      still_valid: true,
      foundational: false,
      provenance: {
        extractor: "legacy",
        source_session_id: "legacy",
        confidence: "legacy",
        evidence: [],
      },
    }]
    await mkdir(dirname(globalPath), { recursive: true })
    await atomicWrite(globalPath, JSON.stringify(globalMemory, null, 2))

    // Local STATE becomes unreadable (directory surrogate); global remains the
    // parseable authoritative candidate, so the writer must build on it.
    await mkdir(join(project, ".opencode", "memory"), { recursive: true })
    await mkdir(localPath)

    const client = clientFor({ source: messages() })
    const outcome = await writeMemoryOnIdle({
      client,
      worktree: project,
      directory: project,
      sessionId: "source",
    })

    // Project write fails (a directory sits at the STATE path), so the write
    // lands on the global fallback — which must still carry the durable
    // decision. The heuristic write now runs through `mutateMemory` (Wave 3),
    // which advances revision exactly once from the authoritative base (2→3).
    expect(outcome).toBe("heuristic-only")

    const raw = await readFile(globalPath, "utf-8")
    const onDisk = JSON.parse(raw) as { revision: number; decisions: Array<{ topic: string }> }
    expect(onDisk.revision).toBe(3)
    expect(onDisk.decisions.some((decision) => decision.topic === "global-durable-topic")).toBe(true)
  })
})
