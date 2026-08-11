import { beforeEach, describe, expect, it, vi } from "vitest"

import successEnvelope from "../fixtures/llm/structured-success.json"
import missingEnvelope from "../fixtures/llm/structured-missing-envelope.json"
import driftEnvelope from "../fixtures/llm/structured-drift-old-field.json"
import {
  createAuditSession,
  getHostStructuredContractGate,
  requestStructuredOutput,
  resetHostStructuredContractGate,
} from "../../src/memory/llm-adapter"
import { extractFactsLLM } from "../../src/memory/extract-llm"
import { buildCanonicalInput } from "../../src/memory/extract-prompt"
import { emptyMemory } from "../../src/memory/schema"
import type { TranscriptMessage } from "../../src/types"

const request = {
  sessionID: "audit-sanitized-001",
  directory: "/worktree",
  model: { providerID: "provider", modelID: "model" },
  prompt: "sanitized prompt text",
  schema: { type: "object" },
}

describe("host v1 structured-output adapter", () => {
  beforeEach(() => resetHostStructuredContractGate())

  it("builds the v1 request and returns only info.structured", async () => {
    const prompt = vi.fn(async () => successEnvelope)
    const result = await requestStructuredOutput({ session: { prompt } }, request)

    expect(result).toEqual({
      ok: true,
      value: successEnvelope.data.info.structured,
    })
    expect(prompt).toHaveBeenCalledWith({
      path: { id: request.sessionID },
      query: { directory: request.directory },
      body: {
        model: request.model,
        parts: [{ type: "text", text: request.prompt }],
        format: { type: "json_schema", schema: request.schema },
      },
    })
  })

  it("validates the audit data.id envelope", async () => {
    const result = await createAuditSession(
      { session: { create: vi.fn(async () => successEnvelope) } },
      { directory: "/worktree", title: "audit", sourceSessionID: "source" },
    )
    expect(result).toEqual({ ok: true, value: "audit-sanitized-001" })
  })

  it("returns typed drift errors for missing and stale structured fields", async () => {
    const missing = await requestStructuredOutput(
      { session: { prompt: vi.fn(async () => missingEnvelope) } },
      request,
    )
    const stale = await requestStructuredOutput(
      { session: { prompt: vi.fn(async () => driftEnvelope) } },
      request,
    )

    expect(missing).toMatchObject({ ok: false, error: { code: "structured-output-drift" } })
    expect(stale).toMatchObject({ ok: false, error: { code: "structured-output-drift" } })
    expect(JSON.stringify(stale)).not.toContain("must not be accepted")
  })

  it("falls back after malformed output without exposing response or prompt text", async () => {
    const diagnostics: unknown[] = []
    const messages: TranscriptMessage[] = [{
      info: { id: "source-message", role: "user" },
      parts: [{ type: "text", text: "SECRET_PROMPT_DO_NOT_LOG" }],
    }]
    const prompt = vi.fn(async () => ({
      ...missingEnvelope,
      raw_response_secret: "RAW_RESPONSE_DO_NOT_LOG",
    }))
    const result = await extractFactsLLM(
      buildCanonicalInput(messages, emptyMemory("/worktree")),
      "source-adapter-fallback",
      "project",
      {
        session: {
          create: vi.fn(async () => ({ data: { id: "audit-adapter-fallback" } })),
          prompt,
        },
      },
      { enabled: true, model: { providerID: "provider", modelID: "model" } },
      { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
    )

    expect(result).toEqual({ status: "failed", reason: "structured-request" })
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "structured-output-failed", reason: "response-shape-drift" }),
    ]))
    expect(JSON.stringify(diagnostics)).not.toContain("SECRET_PROMPT_DO_NOT_LOG")
    expect(JSON.stringify(diagnostics)).not.toContain("RAW_RESPONSE_DO_NOT_LOG")
  })

  it("allows the verified host range and caches the health result per process", async () => {
    const health = vi.fn(async () => ({ data: { healthy: true, version: "1.18.15" } }))
    const first = await getHostStructuredContractGate({ global: { health } })
    const second = await getHostStructuredContractGate({
      global: { health: vi.fn(async () => ({ data: { healthy: true, version: "1.19.0" } })) },
    })

    expect(first).toMatchObject({ allowed: true, hostVersion: "1.18.15", reason: "verified" })
    expect(second).toEqual(first)
    expect(health).toHaveBeenCalledTimes(1)
  })

  it("rejects too-old and malformed health responses, while pinned clients degrade safely", async () => {
    await expect(getHostStructuredContractGate({
      global: { health: vi.fn(async () => ({ data: { healthy: true, version: "1.17.99" } })) },
    })).resolves.toMatchObject({ allowed: false, reason: "unsupported-version" })

    resetHostStructuredContractGate()
    await expect(getHostStructuredContractGate({
      global: { health: vi.fn(async () => ({ data: { version: "1.18.15" } })) },
    })).resolves.toMatchObject({ allowed: false, reason: "malformed-health" })

    resetHostStructuredContractGate()
    await expect(getHostStructuredContractGate({})).resolves.toEqual({
      allowed: true,
      source: "pinned-compatibility",
      reason: "health-surface-unavailable",
    })
  })
})

// ─── PR 4 §12 D — host version / structured gate (Wave 4) ───────────────────
// The current adapter compares only major/minor (`MINIMUM_HOST_CONTRACT =
// "1.18"`), so `1.18.14` and prerelease versions wrongly pass the gate. Wave 4
// compares the full stable tuple against the shared `src/host/contract.ts`
// policy; these fixtures then go green.
describe("PR 4 §12 D — full-version structured host gate", () => {
  beforeEach(() => resetHostStructuredContractGate())

  function gateFor(version: string) {
    return getHostStructuredContractGate({
      global: { health: vi.fn(async () => ({ data: { healthy: true, version } })) },
    })
  }

  it("24. health reports 1.18.14 -> rejected as unsupported-version", async () => {
    await expect(gateFor("1.18.14")).resolves.toMatchObject({
      allowed: false,
      source: "health",
      reason: "unsupported-version",
      hostVersion: "1.18.14",
    })
  })

  it("25. health reports 1.18.15 -> accepted", async () => {
    await expect(gateFor("1.18.15")).resolves.toMatchObject({
      allowed: true,
      source: "health",
      reason: "verified",
      hostVersion: "1.18.15",
    })
  })

  it("26. health reports a later stable 1.x -> accepted", async () => {
    await expect(gateFor("1.999.0")).resolves.toMatchObject({
      allowed: true,
      source: "health",
      reason: "verified",
      hostVersion: "1.999.0",
    })
  })

  it("27. health reports 2.0.0 -> rejected", async () => {
    await expect(gateFor("2.0.0")).resolves.toMatchObject({
      allowed: false,
      source: "health",
      reason: "unsupported-version",
      hostVersion: "2.0.0",
    })
  })

  it("28. malformed version -> rejected", async () => {
    for (const version of ["", "abc", "v1.18.15"]) {
      resetHostStructuredContractGate()
      await expect(gateFor(version)).resolves.toMatchObject({
        allowed: false,
        reason: "unsupported-version",
      })
    }
  })

  it("29. prerelease version -> rejected under the initial policy", async () => {
    await expect(gateFor("1.18.15-rc.1")).resolves.toMatchObject({
      allowed: false,
      reason: "unsupported-version",
    })
  })

  it("30. healthy !== true -> rejected", async () => {
    resetHostStructuredContractGate()
    await expect(getHostStructuredContractGate({
      global: { health: vi.fn(async () => ({ data: { healthy: false, version: "1.18.15" } })) },
    })).resolves.toMatchObject({ allowed: false, reason: "unhealthy" })
  })

  it("31. malformed health envelope -> rejected", async () => {
    resetHostStructuredContractGate()
    await expect(getHostStructuredContractGate({
      global: { health: vi.fn(async () => ({ data: { version: "1.18.15" } })) },
    })).resolves.toMatchObject({ allowed: false, reason: "malformed-health" })
  })

  it("32. health request throws -> rejected", async () => {
    resetHostStructuredContractGate()
    await expect(getHostStructuredContractGate({
      global: { health: vi.fn(async () => { throw new Error("health probe failed") }) },
    })).resolves.toMatchObject({ allowed: false, reason: "health-request-failed" })
  })

  it("33. health surface absent -> accepted as pinned-compatibility", async () => {
    resetHostStructuredContractGate()
    await expect(getHostStructuredContractGate({})).resolves.toEqual({
      allowed: true,
      source: "pinned-compatibility",
      reason: "health-surface-unavailable",
    })
  })

  it("34. gate result is process-cached", async () => {
    const health = vi.fn(async () => ({ data: { healthy: true, version: "1.18.15" } }))
    const first = await getHostStructuredContractGate({ global: { health } })
    const second = await getHostStructuredContractGate({ global: { health } })
    expect(first).toEqual(second)
    expect(health).toHaveBeenCalledTimes(1)
  })
})
