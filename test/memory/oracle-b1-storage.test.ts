import { describe, expect, it } from "vitest"
import { emptyMemory, type LLMAuditMetadata, type MemoryFile } from "../../src/memory/schema"
import { fitMemoryToBudget } from "../../src/memory/budget"
import { memorySizeBytes } from "../../src/memory/memory-size"

const NOW = Date.parse("2026-08-12T00:00:00.000Z")

const heuristicProvenance = {
  extractor: "heuristic" as const,
  source_session_id: "oracle-b1",
  confidence: "heuristic" as const,
  evidence: [],
}

function decision(id = "semantic-decision") {
  return {
    id,
    topic: "durable topic",
    decision: "retain this semantic decision",
    timestamp: new Date(NOW).toISOString(),
    session_id: "oracle-b1",
    still_valid: true,
    foundational: false,
    provenance: heuristicProvenance,
  }
}

function audit(id: string, outcome: LLMAuditMetadata["terminal_outcome"], index: number): LLMAuditMetadata {
  return {
    audit_session_id: id,
    source_session_id: `source-${index}`,
    cache_key: `cache-${index}-${"x".repeat(240)}`,
    provider_id: `provider-${index}`,
    model_id: `model-${index}`,
    created_at: new Date(NOW - index * 60_000).toISOString(),
    terminal_outcome: outcome,
  }
}

function cacheEntry(index: number) {
  return {
    cache_key: `cache-${index}`,
    source_session_id: `source-${index}`,
    canonical_input_sha256: "a".repeat(64),
    provider_id: `provider-${index}`,
    model_id: "model",
    completed_at: new Date(NOW - index * 60_000).toISOString(),
    provenance: {
      extractor: "llm" as const,
      source_session_id: `source-${index}`,
      source_audit_session_id: `audit-${index}`,
      confidence: "llm-corroborated" as const,
      evidence: [{ kind: "transcript" as const, ref: `evidence-${index}`, digest: "b".repeat(64) }],
    },
    facts: {
      decisions: Array.from({ length: 10 }, (_, decisionIndex) => ({
        topic: `cached topic ${index}-${decisionIndex}`,
        decision: "cached decision",
        rationale: "r".repeat(500),
        evidence_refs: [`evidence-${index}`],
      })),
    },
  }
}

function base(): MemoryFile {
  return {
    ...emptyMemory("/oracle/b1"),
    last_updated: new Date(NOW).toISOString(),
    decisions: [decision()],
  }
}

function fit(memory: MemoryFile) {
  const result = fitMemoryToBudget(memory, { now: NOW })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`unexpected budget refusal: ${result.reason}`)
  expect(result.bytes).toBeLessThanOrEqual(8192)
  expect(memorySizeBytes(result.memory)).toBeLessThanOrEqual(8192)
  return result.memory
}

describe("Oracle B1 — schema-valid disposable metadata pressure", () => {
  it("drops one large optional cache row before the semantic decision", () => {
    const memory = base()
    memory.llm_extraction_cache = [cacheEntry(0)]
    const result = fit(memory)
    expect(result.decisions.map((item) => item.id)).toContain("semantic-decision")
    expect(result.llm_extraction_cache).toBeUndefined()
  })

  it("evicts completed audit history before semantic decisions", () => {
    const memory = base()
    memory.llm_extraction_audits = Array.from({ length: 20 }, (_, index) => audit(`completed-${index}`, "success", index))
    const result = fit(memory)
    expect(result.decisions.map((item) => item.id)).toContain("semantic-decision")
    expect((result.llm_extraction_audits?.length ?? 0)).toBeLessThan(20)
  })

  it("evicts model-health rows before semantic decisions", () => {
    const memory = base()
    memory.model_health = Array.from({ length: 10 }, (_, index) => ({
      provider_id: `p`.repeat(256),
      model_id: "m".repeat(256),
      last_outcome: "success" as const,
      failure_streak: 0,
      last_outcome_at: new Date(NOW - index * 60_000).toISOString(),
      failure_reason: "h".repeat(128),
    }))
    memory.llm_extraction_cache_quarantine = { count: 10, reason: "q".repeat(128) }
    const result = fit(memory)
    expect(result.decisions.map((item) => item.id)).toContain("semantic-decision")
    expect(result.model_health?.length ?? 0).toBeLessThan(10)
  })

  it("preserves every non-stale pending audit guard, not only the current one", () => {
    const memory = base()
    memory.llm_extraction_audits = [
      audit("pending-current", "pending", 0),
      audit("pending-other", "pending", 1),
    ]
    memory.llm_extraction_cache = [cacheEntry(2)]
    const result = fitMemoryToBudget(memory, {
      now: NOW,
      protection: { preserveAuditSessionIDs: ["pending-current"] },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.memory.llm_extraction_audits?.map((item) => item.audit_session_id)).toEqual([
      "pending-current",
      "pending-other",
    ])
  })

  it("evicts oldest active-file observations before recent semantic decisions", () => {
    const memory = base()
    memory.active_files = Array.from({ length: 16 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      reason: "f".repeat(512),
      last_touched: new Date(NOW - index * 60_000).toISOString(),
      provenance: heuristicProvenance,
    }))
    const result = fit(memory)
    expect(result.decisions.map((item) => item.id)).toContain("semantic-decision")
    expect(result.active_files.some((file) => file.path === "src/file-15.ts")).toBe(false)
    expect(result.active_files.some((file) => file.path === "src/file-0.ts")).toBe(true)
  })
})
