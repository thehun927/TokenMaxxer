import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { writeMemoryOnIdle } from "../../src/memory/writer"
import { pruneOld } from "../../src/memory/writer"
import { readMemory, writeMemory } from "../../src/memory/store"
import { emptyMemory, type LLMAuditMetadata } from "../../src/memory/schema"
import { isPersistedRetainedExtractionSession, extractFactsLLM } from "../../src/memory/extract-llm"
import { resetHostStructuredContractGate } from "../../src/memory/llm-adapter"
import { buildCanonicalInput } from "../../src/memory/extract-prompt"
import { resetProjectQueues } from "../../src/memory/lock"
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
  it("uses structured logging for an oversized direct memory write", async () => {
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
    }, oversized)).resolves.toBe(true)

    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(appLog).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("STATE.json still"),
      }),
    }))
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

    expect(result).toBeNull()
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
})
