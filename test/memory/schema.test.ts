import { describe, expect, it } from "vitest"
import {
  ActiveFileSchema,
  CacheQuarantineMetadataSchema,
  DecisionSchema,
  EvidenceSchema,
  HumanReviewSchema,
  MemoryFileSchema,
  ModelHealthSchema,
  MAX_IDENTIFIER,
  ProvenanceSchema,
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
