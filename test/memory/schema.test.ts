import { describe, expect, it } from "vitest"
import {
  ActiveFileSchema,
  CacheQuarantineMetadataSchema,
  DecisionSchema,
  EvidenceSchema,
  MemoryFileSchema,
  ModelHealthSchema,
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
})
