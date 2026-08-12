/**
 * PR-9 Wave 1 Agent 1C — best-effort persistence warnings + required audit guard.
 *
 * Test-only freeze of implementation-plan §7 and §11 "Wave 1 Agent 1C" plus
 * the semantic release matrix §13 E (cases 59–68). These tests document the
 * contract that Wave 5 production work must satisfy. Several intentionally
 * fail against the pre-PR-9 baseline (Luna reconciles expected failures in
 * docs/CRIP/PR-9/blockers.md before starting production waves).
 *
 * Frozen contracts:
 *   59–62. audit terminal typed failures (lock-timeout / unavailable /
 *          commit-failed / budget-rejected) warn and return; they never throw
 *          and never fall back to a stale full-state write.
 *   63.    audit terminal unexpected throw warns and returns.
 *   64.    model-health typed failures warn and return.
 *   65.    model-health unexpected throw warns and returns.
 *   66.    arbitrary error text carried by best-effort warnings is bounded.
 *   67.    best-effort terminal/health persistence failure does not change
 *          the primary LLM success outcome.
 *   68.    the required audit guard remains fail-closed: no optional LLM
 *          prompt runs after a guard persistence failure, and the outcome is
 *          a typed write failure — never heuristic-only and never llm-success.
 *
 * No production source, package manifest, or documentation is modified.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  writeMemoryOnIdle,
  persistAuditGuard,
  persistAuditGuardResult,
  persistTerminalTransaction,
  persistModelHealth,
} from "../../src/memory/writer"
import * as storeModule from "../../src/memory/store"
import { emptyMemory } from "../../src/memory/schema"
import { resetProjectQueues } from "../../src/memory/lock"
import { resetHostStructuredContractGate } from "../../src/memory/llm-adapter"
import { makeTranscriptEvidenceRef } from "../../src/memory/extract-prompt"
import type { TranscriptMessage } from "../../src/types"

const directories: string[] = []

async function makeWorktree(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-pw-"))
  directories.push(directory)
  return directory
}

/** Best-effort persistence helpers must never write through writeMemory. */
function makeClient() {
  return { app: { log: vi.fn() } }
}

function auditRecord(overrides: Record<string, unknown> = {}) {
  return {
    audit_session_id: "audit-pr9",
    source_session_id: "source-pr9",
    cache_key: "cache-pr9",
    provider_id: "provider",
    model_id: "model",
    created_at: new Date().toISOString(),
    terminal_outcome: "pending",
    ...overrides,
  }
}

function healthReport(overrides: Record<string, unknown> = {}) {
  return {
    providerID: "provider",
    modelID: "model",
    outcome: "success",
    reason: "accepted-extraction",
    ...overrides,
  }
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

/** Collect every string value (recursively) from recorded app.log bodies. */
function collectStringValues(calls: unknown[][]): string[] {
  const out: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      out.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value && typeof value === "object") {
      for (const member of Object.values(value)) walk(member)
    }
  }
  for (const args of calls) {
    for (const arg of args) walk(arg)
  }
  return out
}

/** Only the warn-level log bodies recorded so far. */
function warnLogBodies(appLog: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return appLog.mock.calls
    .map(([args]) => args as { body?: { level?: string } })
    .filter((args) => args?.body?.level === "warn")
    .map((args) => args.body as Record<string, unknown>)
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetHostStructuredContractGate()
  resetProjectQueues()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("PR-9 best-effort persistence warnings (cases 59–66)", () => {
  describe("audit terminal typed failures warn and return (cases 59–62)", () => {
    it.each([
      ["lock-timeout", { status: "lock-timeout" }],
      ["unavailable", { status: "unavailable" }],
      ["commit-failed", { status: "commit-failed" }],
    ] as const)(
      "audit terminal %s warns and returns without escaping",
      async (_name, mutated) => {
        const worktree = await makeWorktree()
        const client = makeClient()
        const writeSpy = vi.spyOn(storeModule, "writeMemory")
        const mutateSpy = vi.spyOn(storeModule, "mutateMemory")
        mutateSpy.mockResolvedValue(mutated as never)

        await expect(
          persistTerminalTransaction(
            { client, worktree, directory: worktree },
            "audit-x",
            "success",
          ),
        ).resolves.toBeUndefined()

        expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
          body: expect.objectContaining({
            level: "warn",
            message: expect.stringContaining("audit terminal"),
          }),
        }))
        // Best-effort: no stale full-state fallback write.
        expect(writeSpy).not.toHaveBeenCalled()
      },
    )

    it("audit terminal budget-rejected warns and returns without escaping", async () => {
      const worktree = await makeWorktree()
      const client = makeClient()
      const writeSpy = vi.spyOn(storeModule, "writeMemory")
      const mutateSpy = vi.spyOn(storeModule, "mutateMemory")
      mutateSpy.mockResolvedValue({
        status: "budget-rejected",
        reason: "required-state-exceeds-budget",
        revision: 0,
        requiredBytes: 9_000,
        maxBytes: 8_192,
      } as never)

      await expect(
        persistTerminalTransaction(
          { client, worktree, directory: worktree },
          "audit-x",
          "success",
        ),
      ).resolves.toBeUndefined()

      expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          level: "warn",
          message: "audit terminal transaction budget-rejected",
        }),
      }))
      expect(writeSpy).not.toHaveBeenCalled()
    })
  })

  describe("model health typed failures warn and return (case 64)", () => {
    it.each([
      ["lock-timeout", { status: "lock-timeout" }],
      ["unavailable", { status: "unavailable" }],
      ["commit-failed", { status: "commit-failed" }],
    ] as const)(
      "model health %s warns and returns without escaping",
      async (_name, mutated) => {
        const worktree = await makeWorktree()
        const client = makeClient()
        const writeSpy = vi.spyOn(storeModule, "writeMemory")
        const mutateSpy = vi.spyOn(storeModule, "mutateMemory")
        mutateSpy.mockResolvedValue(mutated as never)

        await expect(
          persistModelHealth(
            { client, worktree, directory: worktree },
            healthReport() as never,
          ),
        ).resolves.toBeUndefined()

        expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
          body: expect.objectContaining({
            level: "warn",
            message: expect.stringContaining("model health"),
          }),
        }))
        expect(writeSpy).not.toHaveBeenCalled()
      },
    )

    it("model health budget-rejected warns and returns without escaping", async () => {
      const worktree = await makeWorktree()
      const client = makeClient()
      const writeSpy = vi.spyOn(storeModule, "writeMemory")
      const mutateSpy = vi.spyOn(storeModule, "mutateMemory")
      mutateSpy.mockResolvedValue({
        status: "budget-rejected",
        reason: "required-state-exceeds-budget",
        revision: 0,
        requiredBytes: 9_000,
        maxBytes: 8_192,
      } as never)

      await expect(
        persistModelHealth(
          { client, worktree, directory: worktree },
          healthReport() as never,
        ),
      ).resolves.toBeUndefined()

      expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          level: "warn",
          message: "model health transaction budget-rejected",
        }),
      }))
      expect(writeSpy).not.toHaveBeenCalled()
    })
  })

  describe("unexpected best-effort throws warn and return (cases 63, 65)", () => {
    it("audit terminal unexpected throw warns and returns without escaping", async () => {
      const worktree = await makeWorktree()
      const client = makeClient()
      const writeSpy = vi.spyOn(storeModule, "writeMemory")
      const mutateSpy = vi.spyOn(storeModule, "mutateMemory")
      mutateSpy.mockRejectedValue(new Error("boom"))

      await expect(
        persistTerminalTransaction(
          { client, worktree, directory: worktree },
          "audit-x",
          "success",
        ),
      ).resolves.toBeUndefined()

      expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("audit terminal"),
        }),
      }))
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it("model health unexpected throw warns and returns without escaping", async () => {
      const worktree = await makeWorktree()
      const client = makeClient()
      const writeSpy = vi.spyOn(storeModule, "writeMemory")
      const mutateSpy = vi.spyOn(storeModule, "mutateMemory")
      mutateSpy.mockRejectedValue(new Error("boom"))

      await expect(
        persistModelHealth(
          { client, worktree, directory: worktree },
          healthReport() as never,
        ),
      ).resolves.toBeUndefined()

      expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("model health"),
        }),
      }))
      expect(writeSpy).not.toHaveBeenCalled()
    })
  })

  describe("best-effort warning text is bounded (case 66)", () => {
    it("never leaks a raw arbitrary error message into warn logs", async () => {
      const worktree = await makeWorktree()
      const client = makeClient()
      const raw = "x".repeat(5_000)
      const error = new Error(raw)
      vi.spyOn(storeModule, "mutateMemory").mockRejectedValue(error)

      // persistAuditGuardResult already converts an unexpected throw into a
      // typed failure; the freeze here is that the emitted warning text is
      // bounded rather than echoing the full arbitrary message.
      const result = await persistAuditGuardResult(
        { client, worktree, directory: worktree },
        auditRecord() as never,
      )
      expect(result.status).toBe("failed")
      if (result.status !== "failed") return
      expect(result.reason).toBe("unexpected")

      const warnBodies = warnLogBodies(client.app.log)
      expect(warnBodies.length).toBeGreaterThan(0)
      for (const body of warnBodies) {
        const strings = collectStringValues([[body]])
        for (const value of strings) {
          // Per plan §7: boundedDiagnosticError default maxChars = 500.
          expect(value.length).toBeLessThanOrEqual(500)
          expect(value).not.toContain(raw)
        }
      }
    })
  })
})

describe("PR-9 required audit guard fails closed (case 68)", () => {
  it("returns typed failure statuses from persistAuditGuardResult", async () => {
    const worktree = await makeWorktree()
    const client = makeClient()
    const mutateSpy = vi.spyOn(storeModule, "mutateMemory")

    // Unexpected throw -> typed failed/unexpected, never an escape.
    mutateSpy.mockRejectedValueOnce(new Error("boom"))
    let result = await persistAuditGuardResult(
      { client, worktree, directory: worktree },
      auditRecord() as never,
    )
    expect(result).toEqual({ status: "failed", reason: "unexpected" })

    // Lock timeout -> typed failed/lock-timeout.
    mutateSpy.mockResolvedValueOnce({ status: "lock-timeout" } as never)
    result = await persistAuditGuardResult(
      { client, worktree, directory: worktree },
      auditRecord() as never,
    )
    expect(result).toEqual({ status: "failed", reason: "lock-timeout" })

    // Committed -> typed success; the boolean seam reflects it.
    mutateSpy.mockImplementationOnce(async () => ({
      status: "committed",
      value: null,
      revision: 1,
      memory: emptyMemory(worktree),
    }))
    result = await persistAuditGuardResult(
      { client, worktree, directory: worktree },
      auditRecord() as never,
    )
    expect(result).toEqual({ status: "committed" })
  })

  it("required audit guard failure prevents the optional LLM prompt", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const prompt = vi.fn()
    const client = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: sourceMessages() })),
        create: vi.fn(async () => ({ data: { id: "audit-guard-fail" } })),
        prompt,
      },
    }

    // The heuristic transaction (call 1) succeeds so the flow reaches the
    // required guard step; every later transaction fails. The guard failure
    // must fail closed: no prompt, no cache acceptance, typed write failure.
    const mutateSpy = vi.spyOn(storeModule, "mutateMemory")
    let callCount = 0
    mutateSpy.mockImplementation((async (_args, mutate) => {
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
    }) as never)

    const outcome = await writeMemoryOnIdle({
      client,
      worktree,
      directory: worktree,
      sessionId: "source-guard-fail",
    })

    expect(prompt).not.toHaveBeenCalled()
    // The guard is REQUIRED, so its failure is a typed failure outcome — not
    // a best-effort warning followed by heuristic-only/llm-success.
    expect(outcome).toBe("write-failed")
    expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("audit guard"),
      }),
    }))
  })

  it("persistAuditGuard boolean seam returns false on any guard failure", async () => {
    const worktree = await makeWorktree()
    const client = makeClient()
    const mutateSpy = vi.spyOn(storeModule, "mutateMemory")

    mutateSpy.mockResolvedValueOnce({ status: "unavailable" } as never)
    await expect(
      persistAuditGuard({ client, worktree, directory: worktree }, auditRecord() as never),
    ).resolves.toBe(false)

    mutateSpy.mockResolvedValueOnce({
      status: "committed",
      value: null,
      revision: 1,
      memory: emptyMemory(worktree),
    })
    await expect(
      persistAuditGuard({ client, worktree, directory: worktree }, auditRecord() as never),
    ).resolves.toBe(true)
  })
})

describe("PR-9 best-effort metadata does not change primary outcome (case 67)", () => {
  it("keeps llm-success when audit-terminal and model-health writes throw", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const worktree = await makeWorktree()
    const appLog = vi.fn()
    const prompt = vi.fn(async () => ({
      data: {
        info: {
          structured: {
            decisions: [{
              topic: "transport",
              decision: "Use SDK v2",
              evidence_refs: [makeTranscriptEvidenceRef("m2")],
            }],
          },
        },
      },
    }))
    const client = {
      app: { log: appLog },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: sourceMessages() })),
        create: vi.fn(async () => ({ data: { id: "audit-session" } })),
        prompt,
      },
    }

    // mutateMemory call sequence during a successful LLM run:
    //   1 heuristic transaction, 2 audit guard, 3 audit terminal,
    //   4 model health, 5 final LLM merge.
    // Calls 3 and 4 are best-effort metadata and throw; they must not change
    // the primary llm-success outcome.
    const mutateSpy = vi.spyOn(storeModule, "mutateMemory")
    let callCount = 0
    mutateSpy.mockImplementation((async (_args, mutate) => {
      callCount += 1
      if (callCount === 3 || callCount === 4) {
        throw new Error("disk full (best-effort metadata)")
      }
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
    }) as never)

    const outcome = await writeMemoryOnIdle({
      client,
      worktree,
      directory: worktree,
      sessionId: "source-best-effort",
    })

    expect(outcome).toBe("llm-success")
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(mutateSpy).toHaveBeenCalledTimes(5)
  })
})
