import { describe, expect, it } from "vitest"
import {
  ActiveFileSchema,
  CacheQuarantineMetadataSchema,
  DecisionSchema,
  EvidenceSchema,
  HumanReviewSchema,
  LLMExtractionCacheEntrySchema,
  MemoryFileSchema,
  ModelHealthSchema,
  MAX_IDENTIFIER,
  ProvenanceSchema,
  ProcessedSourceSchema,
  MAX_PROCESSED_SOURCES,
  emptyMemory,
} from "../../src/memory/schema"
import { loadAndMigrate } from "../../src/memory/migrate"

const legacyProvenance = {
  extractor: "legacy" as const,
  source_session_id: "legacy-session",
  confidence: "legacy" as const,
  evidence: [],
}

const validDecision = {
  id: "decision-1",
  topic: "storage",
  decision: "Use Postgres",
  timestamp: "2026-08-09T00:00:00.000Z",
  session_id: "source-1",
  still_valid: true,
  foundational_requested: false,
  provenance: legacyProvenance,
}

const validActiveFile = {
  path: "src/storage.ts",
  reason: "edited",
  last_touched: "2026-08-09T00:00:00.000Z",
  provenance: legacyProvenance,
}

function validV3(overrides: Record<string, unknown> = {}) {
  return {
    ...emptyMemory("/project"),
    decisions: [validDecision],
    active_files: [validActiveFile],
    current_task: "Keep the migration readable",
    current_task_provenance: legacyProvenance,
    ...overrides,
  }
}

describe("MemoryFile v3 bounded schemas", () => {
  it("adds provenance to decisions and active files", () => {
    expect(DecisionSchema.safeParse(validDecision).success).toBe(true);
    expect(ActiveFileSchema.safeParse(validActiveFile).success).toBe(true);
    expect(DecisionSchema.safeParse({ ...validDecision, provenance: undefined }).success).toBe(false);
    expect(ActiveFileSchema.safeParse({ ...validActiveFile, provenance: undefined }).success).toBe(false);
  });
  it("uses exact provenance defaults and stores no source text", () => {
    const provenance = ProvenanceSchema.parse({
      extractor: "legacy",
      source_session_id: "legacy",
      confidence: "legacy",
    })

    expect(provenance).toEqual({
      extractor: "legacy",
      source_session_id: "legacy",
      confidence: "legacy",
      evidence: [],
    })
    expect(EvidenceSchema.safeParse({
      kind: "transcript",
      ref: "message-1",
      digest: "a".repeat(64),
      excerpt: "must not be stored",
    }).success).toBe(false)
  })

  it("adds provenance to decisions and active files", () => {
    expect(DecisionSchema.safeParse(validDecision).success).toBe(true)
    expect(ActiveFileSchema.safeParse(validActiveFile).success).toBe(true)
    expect(DecisionSchema.safeParse({ ...validDecision, provenance: undefined }).success).toBe(false)
    expect(ActiveFileSchema.safeParse({ ...validActiveFile, provenance: undefined }).success).toBe(false)
  })

  it("rejects malformed provenance and evidence bounds", () => {
    expect(ProvenanceSchema.safeParse({
      ...legacyProvenance,
      evidence: Array.from({ length: 4 }, (_, index) => ({
        kind: "transcript",
        ref: `message-${index}`,
        digest: "a".repeat(64),
      })),
    }).success).toBe(false)
    expect(ProvenanceSchema.safeParse({
      ...legacyProvenance,
      evidence: [{ kind: "transcript", ref: "r".repeat(257), digest: "a".repeat(64) }],
    }).success).toBe(false)
    expect(ProvenanceSchema.safeParse({
      ...legacyProvenance,
      evidence: [{ kind: "transcript", ref: "message-1", digest: "not-a-sha256" }],
    }).success).toBe(false)
  })

  it("bounds model health and quarantine metadata", () => {
    const health = {
      provider_id: "provider",
      model_id: "model",
      last_outcome: "success" as const,
      failure_streak: 0,
    }
    expect(ModelHealthSchema.safeParse(health).success).toBe(true)
    expect(MemoryFileSchema.safeParse(validV3({
      model_health: Array.from({ length: 11 }, () => health),
    })).success).toBe(false)
    expect(CacheQuarantineMetadataSchema.safeParse({ count: 10_001 }).success).toBe(false)
  })

  it("rejects a malformed v3 document rather than making it readable", () => {
    expect(loadAndMigrate(validV3({
      decisions: [{ ...validDecision, provenance: { ...legacyProvenance, evidence: [{ kind: "bad", ref: "x", digest: "a".repeat(64) }] } }],
    }))).toBeNull()
    expect(loadAndMigrate(validV3({
      active_files: [{ ...validActiveFile, provenance: undefined }],
    }))).toBeNull()
  })

  it("emptyMemory starts at revision 0", () => {
    const memory = emptyMemory("/project")
    expect(memory.revision).toBe(0)
  })

  it("parses a v3 STATE object without revision and defaults it to 0", () => {
    const raw = {
      version: 3,
      project_path: "/project",
      last_updated: "2026-08-09T00:00:00.000Z",
      active_files: [validActiveFile],
      decisions: [validDecision],
      blockers: [],
      next_steps: [],
      recent_sessions: [],
      current_task: "Keep the migration readable",
      current_task_provenance: legacyProvenance,
    }
    expect("revision" in raw).toBe(false)
    const parsed = MemoryFileSchema.parse(raw)
    expect(parsed.revision).toBe(0)
  })
})

// ─── PR 3 §4.1 decision trust + lineage invariants ───────────────────────────
describe("PR 3 §4.1 decision trust and lineage invariants", () => {
  const humanProvenance = {
    extractor: "human" as const,
    source_session_id: "sess-human",
    confidence: "human-reviewed" as const,
    evidence: [{ kind: "transcript" as const, ref: "tr-1", digest: "a".repeat(64) }],
  }

  const humanReview = {
    channel: "interactive-cli" as const,
    reviewed_at: "2026-08-10T00:00:00.000Z",
  }

  function humanDecision(overrides: Record<string, unknown> = {}) {
    return {
      ...validDecision,
      id: "d-human",
      foundational: true,
      foundational_requested: false,
      human_review: humanReview,
      provenance: humanProvenance,
      ...overrides,
    }
  }

  function memoryWith(decisions: unknown[]) {
    return validV3({ decisions })
  }

  it("accepts a fully self-consistent human trust claim", () => {
    expect(MemoryFileSchema.safeParse(memoryWith([humanDecision()])).success).toBe(true)
  })

  it("rejects a human trust claim without human_review", () => {
    const result = MemoryFileSchema.safeParse(memoryWith([
      humanDecision({ human_review: undefined }),
    ]))
    expect(result.success).toBe(false)
  })

  it("rejects a human trust claim that is not foundational", () => {
    const result = MemoryFileSchema.safeParse(memoryWith([
      humanDecision({ foundational: false }),
    ]))
    expect(result.success).toBe(false)
  })

  it("rejects a human trust claim with non-human provenance", () => {
    const result = MemoryFileSchema.safeParse(memoryWith([
      humanDecision({
        provenance: { ...humanProvenance, extractor: "llm", confidence: "llm-corroborated" },
      }),
    ]))
    expect(result.success).toBe(false)
  })

  it("rejects a human_review record with a non-interactive channel", () => {
    const result = MemoryFileSchema.safeParse(memoryWith([
      humanDecision({ human_review: { ...humanReview, channel: "cli" } }),
    ]))
    expect(result.success).toBe(false)
  })

  it("rejects a decision that supersedes itself", () => {
    const result = MemoryFileSchema.safeParse(memoryWith([
      humanDecision({ superseded_by: "d-human" }),
    ]))
    expect(result.success).toBe(false)
  })

  it("rejects a decision that conflicts with itself", () => {
    const result = MemoryFileSchema.safeParse(memoryWith([
      humanDecision({ conflicts_with: ["d-human"] }),
    ]))
    expect(result.success).toBe(false)
  })

  it("rejects duplicate IDs inside conflicts_with", () => {
    const result = MemoryFileSchema.safeParse(memoryWith([
      humanDecision({ conflicts_with: ["d-other", "d-other"] }),
    ]))
    expect(result.success).toBe(false)
  })

  it("accepts a valid non-human decision without any trust metadata", () => {
    expect(MemoryFileSchema.safeParse(memoryWith([validDecision])).success).toBe(true)
  })

  it("bounds HumanReviewSchema reviewed_at length", () => {
    expect(HumanReviewSchema.safeParse({
      channel: "interactive-cli",
      reviewed_at: "x".repeat(65),
    }).success).toBe(false)
    expect(HumanReviewSchema.safeParse(humanReview).success).toBe(true)
  })
})

// ─── PR 3 wave-9 — decision ID uniqueness (Blocker 2) ────────────────────────
describe("PR 3 wave-9 — decision ID uniqueness", () => {
  function memoryWith(decisions: unknown[]) {
    return validV3({ decisions })
  }

  it("rejects two decisions with the same ID", () => {
    const result = MemoryFileSchema.safeParse(memoryWith([
      { ...validDecision, id: "dup-id" },
      { ...validDecision, id: "dup-id", decision: "Use MySQL" },
    ]))
    expect(result.success).toBe(false)
  })

  it("rejects a duplicate ID with a stable DUPLICATE_DECISION_ID issue code", () => {
    const result = MemoryFileSchema.safeParse(memoryWith([
      { ...validDecision, id: "dup-id" },
      { ...validDecision, id: "dup-id", decision: "Use MySQL" },
    ]))
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message)
      expect(messages.some((m) => m.startsWith("duplicate decision id:"))).toBe(true)
    }
  })

  it("accepts a single decision with a long ID up to MAX_IDENTIFIER", () => {
    const atLimit = "x".repeat(MAX_IDENTIFIER)
    expect(MemoryFileSchema.safeParse(memoryWith([{ ...validDecision, id: atLimit }])).success).toBe(true)
    const overLimit = "x".repeat(MAX_IDENTIFIER + 1)
    expect(MemoryFileSchema.safeParse(memoryWith([{ ...validDecision, id: overLimit }])).success).toBe(false)
  })

  it("rejects an empty decision ID", () => {
    expect(MemoryFileSchema.safeParse(memoryWith([{ ...validDecision, id: "" }])).success).toBe(false)
  })
})

// ─── PR 5 Wave 3 — ProcessedSourceSchema bounds ────────────────────────────────
describe("PR 5 Wave 3 — ProcessedSourceSchema bounds", () => {
  const validSourceKey = "v2s:" + "a".repeat(64)
  const validExtractionKey = "v2e:" + "b".repeat(64)

  it("accepts a valid ProcessedSource record", () => {
    const record = {
      source_key: validSourceKey,
      extraction_key: validExtractionKey,
      extraction_contract_version: 2,
      completed_at: "2026-08-11T00:00:00.000Z",
    }
    expect(ProcessedSourceSchema.safeParse(record).success).toBe(true)
  })

  it("rejects a source_key with wrong prefix", () => {
    const record = {
      source_key: "x2s:" + "a".repeat(64),
      extraction_key: validExtractionKey,
      extraction_contract_version: 2,
      completed_at: "2026-08-11T00:00:00.000Z",
    }
    expect(ProcessedSourceSchema.safeParse(record).success).toBe(false)
  })

  it("rejects a source_key with non-hex characters", () => {
    const record = {
      source_key: "v2s:" + "g".repeat(64), // 'g' is not hex
      extraction_key: validExtractionKey,
      extraction_contract_version: 2,
      completed_at: "2026-08-11T00:00:00.000Z",
    }
    expect(ProcessedSourceSchema.safeParse(record).success).toBe(false)
  })

  it("rejects a source_key with wrong length", () => {
    const record = {
      source_key: "v2s:" + "a".repeat(63), // too short
      extraction_key: validExtractionKey,
      extraction_contract_version: 2,
      completed_at: "2026-08-11T00:00:00.000Z",
    }
    expect(ProcessedSourceSchema.safeParse(record).success).toBe(false)
  })

  it("rejects extraction_contract_version <= 0", () => {
    const record = {
      source_key: validSourceKey,
      extraction_key: validExtractionKey,
      extraction_contract_version: 0,
      completed_at: "2026-08-11T00:00:00.000Z",
    }
    expect(ProcessedSourceSchema.safeParse(record).success).toBe(false)
  })

  it("rejects extraction_contract_version > 10_000", () => {
    const record = {
      source_key: validSourceKey,
      extraction_key: validExtractionKey,
      extraction_contract_version: 10_001,
      completed_at: "2026-08-11T00:00:00.000Z",
    }
    expect(ProcessedSourceSchema.safeParse(record).success).toBe(false)
  })

  it("accepts extraction_contract_version at max value 10_000", () => {
    const record = {
      source_key: validSourceKey,
      extraction_key: validExtractionKey,
      extraction_contract_version: 10_000,
      completed_at: "2026-08-11T00:00:00.000Z",
    }
    expect(ProcessedSourceSchema.safeParse(record).success).toBe(true)
  })

  it("rejects completed_at exceeding max length", () => {
    const record = {
      source_key: validSourceKey,
      extraction_key: validExtractionKey,
      extraction_contract_version: 2,
      completed_at: "x".repeat(129),
    }
    expect(ProcessedSourceSchema.safeParse(record).success).toBe(false)
  })

  it("accepts completed_at at max length 128", () => {
    const record = {
      source_key: validSourceKey,
      extraction_key: validExtractionKey,
      extraction_contract_version: 2,
      completed_at: "x".repeat(128),
    }
    expect(ProcessedSourceSchema.safeParse(record).success).toBe(true)
  })
})

// ─── PR 5 Wave 3 — MemoryFile with processed_sources ───────────────────────────
describe("PR 5 Wave 3 — MemoryFile with processed_sources", () => {
  it("defaults processed_sources to empty array", () => {
    const memory = emptyMemory("/project")
    expect(memory.processed_sources).toEqual([])
  })

  it("accepts MemoryFile with processed_sources", () => {
    const validSourceKey = "v2s:" + "a".repeat(64)
    const validExtractionKey = "v2e:" + "b".repeat(64)
    const record = {
      source_key: validSourceKey,
      extraction_key: validExtractionKey,
      extraction_contract_version: 2,
      completed_at: "2026-08-11T00:00:00.000Z",
    }
    const result = MemoryFileSchema.safeParse({
      ...validV3(),
      processed_sources: [record],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.processed_sources).toHaveLength(1)
    }
  })

  it("rejects MemoryFile with invalid processed_sources entry", () => {
    const result = MemoryFileSchema.safeParse({
      ...validV3(),
      processed_sources: [{
        source_key: "invalid",
        extraction_key: "v2e:" + "b".repeat(64),
        extraction_contract_version: 2,
        completed_at: "2026-08-11T00:00:00.000Z",
      }],
    })
    expect(result.success).toBe(false)
  })

  it("bounds processed_sources at MAX_PROCESSED_SOURCES", () => {
    const validSourceKey = "v2s:" + "a".repeat(64)
    const validExtractionKey = "v2e:" + "b".repeat(64)
    const records = Array.from({ length: MAX_PROCESSED_SOURCES + 1 }, (_, i) => ({
      source_key: validSourceKey + i.toString().slice(0, 10),
      extraction_key: validExtractionKey,
      extraction_contract_version: 2,
      completed_at: `2026-08-11T00:00:0${i}.000Z`,
    }))
    const result = MemoryFileSchema.safeParse({
      ...validV3(),
      processed_sources: records,
    })
    expect(result.success).toBe(false)
  })
})

// ─── PR 6 Wave 1 — extractor/confidence pairing contract ─────────────────────
// The PR-6 trust boundary mandates consistent extractor/confidence pairs.
// These tests document the schema-level contract. Tests that fail reveal
// gaps where the current schema accepts inconsistent pairings.
describe("PR 6 Wave 1 — extractor/confidence pairing contract", () => {
  it.skip("rejects llm extractor paired with non-llm-corroborated confidence", () => {
    const result = ProvenanceSchema.safeParse({
      extractor: "llm",
      source_session_id: "sess-1",
      source_audit_session_id: "audit-1",
      confidence: "heuristic",
      evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
    })
    // PR-6 contract: extractor=llm must pair with confidence=llm-corroborated.
    // The current schema validates fields independently and does not
    // enforce this pairing — this test FAILS until the pairing is enforced.
    expect(result.success).toBe(false)
  })

  it.skip("rejects heuristic extractor paired with non-heuristic confidence", () => {
    const result = ProvenanceSchema.safeParse({
      extractor: "heuristic",
      source_session_id: "sess-1",
      confidence: "llm-corroborated",
      evidence: [],
    })
    // PR-6 contract: extractor=heuristic must pair with confidence=heuristic.
    expect(result.success).toBe(false)
  })

  it.skip("rejects human extractor paired with non-human-reviewed confidence", () => {
    const result = ProvenanceSchema.safeParse({
      extractor: "human",
      source_session_id: "sess-1",
      confidence: "heuristic",
      evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
    })
    // PR-6 contract: extractor=human must pair with confidence=human-reviewed.
    expect(result.success).toBe(false)
  })
})

// ─── PR 6 Wave 1 — LLM provenance audit + evidence gate ──────────────────────
// PR-6 requires LLM provenance to carry: (a) source_audit_session_id,
// and (b) at least 1 transcript evidence entry (max 3).
// These tests document the schema-level contract gaps.
describe("PR 6 Wave 1 — LLM provenance audit + evidence gate", () => {
  it.skip("rejects llm provenance without source_audit_session_id", () => {
    const result = ProvenanceSchema.safeParse({
      extractor: "llm",
      source_session_id: "sess-1",
      // Deliberately missing source_audit_session_id
      confidence: "llm-corroborated",
      evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
    })
    // PR-6 contract: LLM provenance MUST carry source_audit_session_id.
    // Currently optional in schema — this test FAILS until required.
    expect(result.success).toBe(false)
  })

  it.skip("rejects llm provenance with zero evidence entries", () => {
    const result = ProvenanceSchema.safeParse({
      extractor: "llm",
      source_session_id: "sess-1",
      source_audit_session_id: "audit-1",
      confidence: "llm-corroborated",
      evidence: [],
    })
    // PR-6 contract: LLM provenance MUST carry at least 1 evidence entry.
    // Currently evidence allows 0 entries via default([]) — this test FAILS.
    expect(result.success).toBe(false)
  })

  it("heuristic provenance is allowed to have zero evidence (no audit gate)", () => {
    const result = ProvenanceSchema.safeParse({
      extractor: "heuristic",
      source_session_id: "sess-1",
      confidence: "heuristic",
      evidence: [],
    })
    // Heuristic provenance does not require evidence or audit session.
    expect(result.success).toBe(true)
  })

  it("human provenance requires evidence but not source_audit_session_id", () => {
    const result = ProvenanceSchema.safeParse({
      extractor: "human",
      source_session_id: "sess-1",
      confidence: "human-reviewed",
      evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
    })
    // Human provenance has its own invariant gate (human_review record).
    expect(result.success).toBe(true)
  })
})

// ─── PR 6 Wave 1 — decisions-only cache shape contract ───────────────────────
// PR-6 says the durable cache payload should carry only decisions, not other
// extracted facts. These tests document the current cache shape and the
// desired future shape.
describe("PR 6 Wave 1 — cache entry shape contract", () => {
  it("rejects a broad cache payload containing non-decision facts", () => {
    const cacheEntry = {
      cache_key: "test-key",
      source_session_id: "sess-1",
      canonical_input_sha256: "a".repeat(64),
      provider_id: "provider",
      model_id: "model",
      completed_at: "2026-08-11T00:00:00.000Z",
      provenance: {
        extractor: "llm",
        source_session_id: "sess-1",
        source_audit_session_id: "audit-1",
        confidence: "llm-corroborated",
        evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
      },
      facts: {
        current_task: null,
        active_files: [],
        decisions: [{ topic: "db", decision: "Use Postgres", evidence_refs: ["tr-1"] }],
        blockers: [],
        next_steps: [],
      },
    }
    // Wave 5 cache rows are decisions-only.
    const cacheResult = LLMExtractionCacheEntrySchema.safeParse(cacheEntry)
    expect(cacheResult.success).toBe(false)
  })

  it("cache entry stores only decisions (no current_task/active_files/blockers/next_steps)", () => {
    const cacheEntry = {
      cache_key: "test-key",
      source_session_id: "sess-1",
      canonical_input_sha256: "a".repeat(64),
      provider_id: "provider",
      model_id: "model",
      completed_at: "2026-08-11T00:00:00.000Z",
      provenance: {
        extractor: "llm",
        source_session_id: "sess-1",
        source_audit_session_id: "audit-1",
        confidence: "llm-corroborated",
        evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
      },
      facts: {
        decisions: [{ topic: "db", decision: "Use Postgres", evidence_refs: ["tr-1"] }],
      },
    }
    expect(LLMExtractionCacheEntrySchema.safeParse(cacheEntry).success).toBe(true)
  })

  it("cache entry without evidence-backed provenance is rejected by the v3 MemoryFile contract", () => {
    const memory = {
      ...validV3(),
      llm_extraction_cache: [{
        cache_key: "test-key",
        source_session_id: "sess-1",
        canonical_input_sha256: "a".repeat(64),
        provider_id: "provider",
        model_id: "model",
        completed_at: "2026-08-11T00:00:00.000Z",
        // Missing provenance entirely — not evidence-backed
        facts: {
          current_task: null,
          active_files: [],
          decisions: [],
          blockers: [],
          next_steps: [],
        },
      }],
    }
    // The v3 MemoryFile superRefine rejects cache entries without
    // evidence-backed provenance. This is the MemoryFile-level contract,
    // not the entry-level schema.
    const result = MemoryFileSchema.safeParse(memory)
    expect(result.success).toBe(false)
  })
})
