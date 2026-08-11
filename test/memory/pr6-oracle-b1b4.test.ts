import { describe, it, expect } from "vitest"
import { loadAndMigrate } from "../../src/memory/migrate"
import { MemoryFileSchema, ProvenanceSchema } from "../../src/memory/schema"
import { readExtractionCacheEntry, readExtractionCache } from "../../src/memory/extract-llm"

function baseV3(overrides: Record<string, unknown> = {}) {
  return {
    version: 3,
    project_path: "/test/project",
    last_updated: "2026-08-08T12:00:00.000Z",
    last_git_sha: "abc123",
    last_session_id: "session-v3",
    current_task: "Valid task",
    current_task_provenance: {
      extractor: "heuristic",
      source_session_id: "sess-heu",
      confidence: "heuristic",
      evidence: [],
    },
    active_files: [],
    decisions: [],
    blockers: [],
    next_steps: [],
    recent_sessions: [],
    processed_sources: [],
    ...overrides,
  }
}

// ─── B1 ───
describe("B1 current-v3 PR5 cache upgrade", () => {
  function broadCacheRow(contract: number | undefined, withProvenance = false) {
    const row: Record<string, unknown> = {
      cache_key: "k",
      source_session_id: "sess",
      canonical_input_sha256: "a".repeat(64),
      provider_id: "p",
      model_id: "m",
      completed_at: "2026-08-08T12:00:00.000Z",
      facts: {
        current_task: "broad task",
        active_files: [{ path: "src/broad.ts", reason: "edited" }],
        decisions: [{ topic: "t", decision: "d" }],
        blockers: ["b"],
        next_steps: ["n"],
      },
    }
    if (contract !== undefined) (row as any).extraction_contract_version = contract
    if (withProvenance) {
      (row as any).provenance = {
        extractor: "llm",
        source_session_id: "sess",
        source_audit_session_id: "audit-1",
        confidence: "llm-corroborated",
        evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
      }
    }
    return row
  }

  it("B1-1 PR5 v3 broad cache row with contract 2 is quarantined and STATE loads", () => {
    const raw = baseV3({
      current_task: "Keep task",
      active_files: [{ path: "src/real.ts", reason: "edited", last_touched: "2026-08-08T12:00:00.000Z", provenance: { extractor: "heuristic", source_session_id: "s", confidence: "heuristic", evidence: [] } }],
      decisions: [{ id: "d1", topic: "storage", decision: "Use Postgres", timestamp: "2026-08-08T12:00:00.000Z", session_id: "s", provenance: { extractor: "legacy", source_session_id: "s", confidence: "legacy", evidence: [] } }],
      blockers: ["real-blocker"],
      next_steps: ["real-step"],
      llm_extraction_cache: [broadCacheRow(2)],
    })
    const result = loadAndMigrate(raw)
    expect(result).not.toBeNull()
    expect(result!.current_task).toBe("Keep task")
    expect(result!.decisions[0]!.topic).toBe("storage")
    expect(result!.blockers).toEqual(["real-blocker"])
    expect(result!.llm_extraction_cache).toBeUndefined()
    expect(result!.llm_extraction_cache_quarantine).toEqual({ count: 1, reason: "pre-pr6-cache-contract" })
  })

  it("B1-2 same with version field absent is quarantined", () => {
    const raw = baseV3({
      llm_extraction_cache: [broadCacheRow(undefined)],
    })
    const result = loadAndMigrate(raw)
    expect(result).not.toBeNull()
    expect(result!.llm_extraction_cache).toBeUndefined()
    expect(result!.llm_extraction_cache_quarantine?.reason).toBe("pre-pr6-cache-contract")
  })

  it("B1-3 evidence-backed PR5 provenance broad row contract 2 is still quarantined (do not parse broad facts first)", () => {
    const raw = baseV3({
      llm_extraction_cache: [broadCacheRow(2, true)],
    })
    const result = loadAndMigrate(raw)
    expect(result).not.toBeNull()
    expect(result!.llm_extraction_cache).toBeUndefined()
    expect(result!.llm_extraction_cache_quarantine?.count).toBe(1)
  })

  it("B1-4 existing contract-2 processed_sources survives unchanged", () => {
    const ps = {
      source_key: "v2s:" + "a".repeat(64),
      extraction_key: "v2e:" + "b".repeat(64),
      extraction_contract_version: 2,
      completed_at: "2026-08-08T12:00:00.000Z",
    }
    const raw = baseV3({
      processed_sources: [ps],
      llm_extraction_cache: [broadCacheRow(2)],
    })
    const result = loadAndMigrate(raw)
    expect(result).not.toBeNull()
    expect(result!.processed_sources).toHaveLength(1)
    expect(result!.processed_sources[0]!.extraction_contract_version).toBe(2)
    expect(result!.processed_sources[0]!.source_key).toBe(ps.source_key)
  })

  it("B1-5 malformed row claiming contract 3 still fails closed", () => {
    const malformed = {
      cache_key: "k",
      source_session_id: "sess",
      canonical_input_sha256: "a".repeat(64),
      provider_id: "p",
      model_id: "m",
      completed_at: "2026-08-08T12:00:00.000Z",
      extraction_contract_version: 3,
      provenance: {
        extractor: "llm",
        source_session_id: "sess",
        source_audit_session_id: "audit-1",
        confidence: "llm-corroborated",
        evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
      },
      facts: {
        // broad payload invalid for contract 3 decisions-only schema
        current_task: "invalid broad",
        active_files: [],
        decisions: [],
        blockers: [],
        next_steps: [],
      },
    }
    const raw = baseV3({ llm_extraction_cache: [malformed] })
    const result = loadAndMigrate(raw)
    expect(result).toBeNull()
  })
})

// ─── B2 ───
describe("B2 exhaustive extractor/confidence pairing", () => {
  it("rejects legacy+heuristic", () => {
    expect(ProvenanceSchema.safeParse({ extractor: "legacy", source_session_id: "s", confidence: "heuristic", evidence: [] }).success).toBe(false)
  })
  it("rejects legacy+llm-corroborated", () => {
    expect(ProvenanceSchema.safeParse({ extractor: "legacy", source_session_id: "s", confidence: "llm-corroborated", evidence: [{ kind: "transcript", ref: "tr", digest: "a".repeat(64) }], source_audit_session_id: "audit" }).success).toBe(false)
  })
  it("rejects legacy+human-reviewed", () => {
    expect(ProvenanceSchema.safeParse({ extractor: "legacy", source_session_id: "s", confidence: "human-reviewed", evidence: [] }).success).toBe(false)
  })
  it("accepts legacy+legacy", () => {
    expect(ProvenanceSchema.safeParse({ extractor: "legacy", source_session_id: "s", confidence: "legacy", evidence: [] }).success).toBe(true)
  })
})

// ─── B3 ───
describe("B3 non-decision LLM provenance persistence", () => {
  function v3WithNonDecisionLLM(overrides: Record<string, unknown> = {}) {
    return baseV3({
      current_task: "task value",
      current_task_provenance: {
        extractor: "llm",
        source_session_id: "sess-llm",
        source_audit_session_id: "audit-1",
        confidence: "llm-corroborated",
        evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
      },
      active_files: [{
        path: "src/file.ts",
        reason: "edited",
        last_touched: "2026-08-08T12:00:00.000Z",
        provenance: {
          extractor: "llm",
          source_session_id: "sess-llm",
          source_audit_session_id: "audit-1",
          confidence: "llm-corroborated",
          evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
        },
      }],
      ...overrides,
    })
  }

  it("complete old LLM current_task provenance is downgraded to legacy preserving value and evidence", () => {
    const result = loadAndMigrate(v3WithNonDecisionLLM())
    expect(result).not.toBeNull()
    expect(result!.current_task).toBe("task value")
    expect(result!.current_task_provenance?.extractor).toBe("legacy")
    expect(result!.current_task_provenance?.confidence).toBe("legacy")
    expect(result!.current_task_provenance?.evidence[0]?.ref).toBe("tr-1")
  })

  it("complete old LLM active-file provenance is downgraded", () => {
    const result = loadAndMigrate(v3WithNonDecisionLLM())
    expect(result).not.toBeNull()
    expect(result!.active_files[0]!.provenance.extractor).toBe("legacy")
    expect(result!.active_files[0]!.provenance.confidence).toBe("legacy")
    expect(result!.active_files[0]!.path).toBe("src/file.ts")
    expect(result!.active_files[0]!.reason).toBe("edited")
  })

  it("incomplete variants still downgrade", () => {
    const raw = baseV3({
      current_task: "task",
      current_task_provenance: {
        extractor: "llm",
        source_session_id: "sess",
        confidence: "llm-corroborated",
        evidence: [],
      },
      active_files: [{
        path: "src/a.ts",
        reason: "r",
        last_touched: "2026-08-08T12:00:00.000Z",
        provenance: {
          extractor: "llm",
          source_session_id: "sess",
          confidence: "llm-corroborated",
          evidence: [],
        },
      }],
    })
    const result = loadAndMigrate(raw)
    expect(result).not.toBeNull()
    expect(result!.current_task_provenance?.extractor).toBe("legacy")
    expect(result!.active_files[0]!.provenance.extractor).toBe("legacy")
  })

  it("semantic task/path/reason and bounded evidence pointers are preserved", () => {
    const result = loadAndMigrate(v3WithNonDecisionLLM())
    expect(result!.current_task).toBe("task value")
    expect(result!.active_files[0]!.provenance.evidence).toEqual([{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }])
  })

  it("current v3 attempting LLM provenance on current_task is rejected after migration", () => {
    const raw = baseV3({
      current_task: "task",
      current_task_provenance: {
        extractor: "llm",
        source_session_id: "sess",
        source_audit_session_id: "audit",
        confidence: "llm-corroborated",
        evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
      },
    })
    // loadAndMigrate downgrades old data, so to test rejection of *future* writes,
    // we validate directly against MemoryFileSchema (no migration downgrade).
    // However B3 says after compatibility has already run, a newly constructed v3
    // attempting LLM should be rejected. Simulate by verifying that loadAndMigrate
    // does downgrade, but direct schema rejects.
    const downgraded = loadAndMigrate(raw)
    expect(downgraded!.current_task_provenance?.extractor).toBe("legacy")
    // Direct schema should reject LLM on current_task
    expect(MemoryFileSchema.safeParse(raw).success).toBe(false)
  })

  it("same for active_files", () => {
    const raw = baseV3({
      active_files: [{
        path: "src/b.ts",
        reason: "r",
        last_touched: "2026-08-08T12:00:00.000Z",
        provenance: {
          extractor: "llm",
          source_session_id: "sess",
          source_audit_session_id: "audit",
          confidence: "llm-corroborated",
          evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
        },
      }],
    })
    expect(MemoryFileSchema.safeParse(raw).success).toBe(false)
    const downgraded = loadAndMigrate(raw)
    expect(downgraded!.active_files[0]!.provenance.extractor).toBe("legacy")
  })
})

// ─── B4 ───
describe("B4 transcript-only durable LLM provenance", () => {
  it("ProvenanceSchema rejects LLM provenance containing heuristic-candidate evidence", () => {
    const res = ProvenanceSchema.safeParse({
      extractor: "llm",
      source_session_id: "s",
      source_audit_session_id: "audit",
      confidence: "llm-corroborated",
      evidence: [{ kind: "heuristic-candidate", ref: "hc-1", digest: "a".repeat(64) }],
    })
    expect(res.success).toBe(false)
  })

  it("old v3 decision with audit + heuristic-candidate downgrades to legacy", () => {
    const raw = baseV3({
      decisions: [{
        id: "d1",
        topic: "t",
        decision: "d",
        timestamp: "2026-08-08T12:00:00.000Z",
        session_id: "s",
        provenance: {
          extractor: "llm",
          source_session_id: "s",
          source_audit_session_id: "audit",
          confidence: "llm-corroborated",
          evidence: [{ kind: "heuristic-candidate", ref: "hc-1", digest: "a".repeat(64) }],
        },
      }],
    })
    const result = loadAndMigrate(raw)
    expect(result).not.toBeNull()
    expect(result!.decisions[0]!.provenance.extractor).toBe("legacy")
    expect(result!.decisions[0]!.provenance.confidence).toBe("legacy")
    expect(result!.decisions[0]!.id).toBe("d1")
  })

  it("mixed transcript/heuristic evidence also downgrades", () => {
    const raw = baseV3({
      decisions: [{
        id: "d2",
        topic: "t",
        decision: "d",
        timestamp: "2026-08-08T12:00:00.000Z",
        session_id: "s",
        provenance: {
          extractor: "llm",
          source_session_id: "s",
          source_audit_session_id: "audit",
          confidence: "llm-corroborated",
          evidence: [
            { kind: "transcript", ref: "tr-1", digest: "a".repeat(64) },
            { kind: "heuristic-candidate", ref: "hc-1", digest: "b".repeat(64) },
          ],
        },
      }],
    })
    const result = loadAndMigrate(raw)
    expect(result!.decisions[0]!.provenance.extractor).toBe("legacy")
  })

  it("complete transcript-only LLM decision remains llm-corroborated", () => {
    const raw = baseV3({
      decisions: [{
        id: "d3",
        topic: "t",
        decision: "d",
        timestamp: "2026-08-08T12:00:00.000Z",
        session_id: "s",
        provenance: {
          extractor: "llm",
          source_session_id: "s",
          source_audit_session_id: "audit",
          confidence: "llm-corroborated",
          evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
        },
      }],
    })
    const result = loadAndMigrate(raw)
    expect(result!.decisions[0]!.provenance.extractor).toBe("llm")
    expect(result!.decisions[0]!.provenance.confidence).toBe("llm-corroborated")
  })

  it("contract-3 cache provenance with non-transcript LLM evidence cannot become valid current cache row", () => {
    const entry = {
      cache_key: "k",
      source_session_id: "sess",
      canonical_input_sha256: "a".repeat(64),
      provider_id: "p",
      model_id: "m",
      completed_at: "2026-08-08T12:00:00.000Z",
      extraction_contract_version: 3,
      provenance: {
        extractor: "llm",
        source_session_id: "sess",
        source_audit_session_id: "audit",
        confidence: "llm-corroborated",
        evidence: [{ kind: "heuristic-candidate", ref: "hc-1", digest: "a".repeat(64) }],
      },
      facts: { decisions: [{ topic: "t", decision: "d", evidence_refs: ["hc-1"] }] },
    }
    const raw = baseV3({ llm_extraction_cache: [entry] })
    // loadAndMigrate should fail closed (schema rejects non-transcript LLM provenance)
    expect(loadAndMigrate(raw)).toBeNull()
    // Also cache read should be safe miss
    const mem: any = { llm_extraction_cache: [entry] }
    expect(readExtractionCacheEntry(mem, "k")).toBeNull()
    expect(readExtractionCache(mem, "k")).toBeNull()
  })
})
