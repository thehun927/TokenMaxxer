/**
 * Oracle B4 — tight automatic creation limits are mechanically enforced.
 *
 * This suite proves that automatic producers (merge.ts for heuristic decisions
 * and extract-schema.ts for structured facts) obey MEMORY_CREATION_LIMITS,
 * while broad persistence compatibility ceilings (8192) still allow existing
 * human-reviewed v3 state to load.
 *
 * Coverage:
 *  - heuristic topic/decision/rationale caps in mergeDecisions
 *  - rejection of blank heuristic decisions
 *  - preservation of long human-reviewed persisted rows
 *  - LLM decisions-only 256/500/500 contract unchanged
 *  - extracted active-file path/reason, current_task, blocker/next_step
 *    strings and counts reflect creation limits via Zod and JSON schema
 *  - valid at-limit facts pass, over-limit facts are rejected
 *  - mirrored constants stay in sync with src/memory/schema.ts
 */
import { describe, it, expect } from "vitest"
import { mergeDecisions } from "../../src/memory/merge"
import {
  ExtractedFactsSchema,
  ExtractedFactsJsonSchema,
  LLMDecisionFactsJsonSchema,
  validateLLMDecisionResult,
  validateStructuredResult,
} from "../../src/memory/extract-schema"
import { MEMORY_CREATION_LIMITS, MemoryFileSchema, emptyMemory } from "../../src/memory/schema"

const meta = {
  sessionId: "sess-b4",
  gitSha: "abc123",
  timestamp: new Date("2026-08-12T00:00:00.000Z").toISOString(),
}

const heuristicProvenance = {
  extractor: "heuristic" as const,
  source_session_id: "heuristic-session",
  confidence: "heuristic" as const,
  evidence: [] as never[],
}

const humanProvenance = {
  extractor: "human" as const,
  source_session_id: "sess-human",
  confidence: "human-reviewed" as const,
  evidence: [{ kind: "transcript" as const, ref: "tr-human", digest: "a".repeat(64) }],
}

const humanReview = {
  channel: "interactive-cli" as const,
  reviewed_at: "2026-08-12T00:00:00.000Z",
}

function humanDecision(overrides: Record<string, unknown> = {}) {
  return {
    id: "human-long",
    topic: "t".repeat(300),
    decision: "d".repeat(600),
    rationale: "r".repeat(700),
    timestamp: "2026-08-12T00:00:00.000Z",
    session_id: "sess-human",
    still_valid: true,
    foundational: true,
    foundational_requested: false,
    human_review: humanReview,
    provenance: humanProvenance,
    ...overrides,
  }
}

describe("Oracle B4 — creation limits are authoritative", () => {
  it("mirrored creation limits match the authoritative export", () => {
    expect(MEMORY_CREATION_LIMITS.currentTaskChars).toBe(512)
    expect(MEMORY_CREATION_LIMITS.activeFilePathChars).toBe(2_048)
    expect(MEMORY_CREATION_LIMITS.activeFileReasonChars).toBe(512)
    expect(MEMORY_CREATION_LIMITS.decisionTopicChars).toBe(256)
    expect(MEMORY_CREATION_LIMITS.decisionTextChars).toBe(500)
    expect(MEMORY_CREATION_LIMITS.decisionRationaleChars).toBe(500)
    expect(MEMORY_CREATION_LIMITS.blockerChars).toBe(512)
    expect(MEMORY_CREATION_LIMITS.nextStepChars).toBe(512)
    expect(MEMORY_CREATION_LIMITS.blockersMax).toBe(8)
    expect(MEMORY_CREATION_LIMITS.nextStepsMax).toBe(8)
    expect(MEMORY_CREATION_LIMITS.activeFilesMax).toBe(16)
  })

  // ── merge.ts heuristic decision caps ──────────────────────────────────

  describe("mergeDecisions heuristic caps", () => {
    it("caps over-limit heuristic topic to 256 chars", () => {
      const longTopic = "t".repeat(300)
      const result = mergeDecisions([], [{ topic: longTopic, decision: "Use Postgres" }], meta)
      expect(result).toHaveLength(1)
      expect(result[0]!.topic.length).toBeLessThanOrEqual(MEMORY_CREATION_LIMITS.decisionTopicChars)
      expect(result[0]!.topic.length).toBe(256)
    })

    it("caps over-limit heuristic decision text to 500 chars", () => {
      const longDecision = "d".repeat(800)
      const result = mergeDecisions([], [{ topic: "database", decision: longDecision }], meta)
      expect(result).toHaveLength(1)
      expect(result[0]!.decision.length).toBeLessThanOrEqual(500)
      expect(result[0]!.decision.length).toBe(500)
    })

    it("caps over-limit heuristic rationale to 500 chars", () => {
      const longRationale = "r".repeat(900)
      const result = mergeDecisions(
        [],
        [{ topic: "database", decision: "Use Postgres", rationale: longRationale }],
        meta,
      )
      expect(result).toHaveLength(1)
      expect(result[0]!.rationale!.length).toBeLessThanOrEqual(500)
      expect(result[0]!.rationale!.length).toBe(500)
    })

    it("rejects heuristic decision with blank topic or decision", () => {
      const emptyTopic = mergeDecisions([], [{ topic: "   ", decision: "Use Postgres" }], meta)
      expect(emptyTopic).toHaveLength(0)
      const emptyDecision = mergeDecisions([], [{ topic: "database", decision: "   " }], meta)
      expect(emptyDecision).toHaveLength(0)
    })

    it("preserves existing human-reviewed long rows while capping new heuristic topics", () => {
      const existing = [humanDecision() as never]
      // Human row has topic 300 (>256) and decision 600 (>500) but is persisted
      expect(existing[0].topic.length).toBe(300)
      expect(existing[0].decision.length).toBe(600)
      // New heuristic topic over limit should be capped, human row untouched
      const longTopic = "x".repeat(400)
      const result = mergeDecisions(existing as any, [{ topic: longTopic, decision: "Use MySQL" }], meta)
      const human = result.find((d) => d.id === "human-long")!
      expect(human.topic).toBe("t".repeat(300))
      expect(human.decision).toBe("d".repeat(600))
      const created = result.find((d) => d.id !== "human-long")!
      expect(created.topic.length).toBeLessThanOrEqual(256)
    })

    it("does not change trust semantics when capping (foundational stays false)", () => {
      const result = mergeDecisions(
        [],
        [{ topic: "t".repeat(300), decision: "d".repeat(600), foundational: true as never }],
        meta,
      )
      expect(result).toHaveLength(1)
      expect(result[0]!.foundational).toBe(false)
      expect(result[0]!.foundational_requested).toBe(true)
      expect(result[0]!.provenance?.extractor).toBe("heuristic")
    })

    it("normalizes topic (lowercase, trim, collapse) before capping", () => {
      const messy = "  DATABASE   TOPIC  WITH   SPACES  " + "x".repeat(300)
      const result = mergeDecisions([], [{ topic: messy, decision: "Use Postgres" }], meta)
      expect(result).toHaveLength(1)
      expect(result[0]!.topic).toBe(result[0]!.topic.toLowerCase())
      expect(result[0]!.topic.includes("  ")).toBe(false)
      expect(result[0]!.topic.length).toBeLessThanOrEqual(256)
    })

    it("LLM decisions are not capped by heuristic path (they have separate 256/500/500 validation)", () => {
      // LLM path should not truncate via heuristic cap; LLM validation is separate.
      // We drive mergeDecisions directly with llm origin and evidence.
      const llmMeta = {
        ...meta,
        origin: "llm" as const,
        auditSessionID: "audit-b4",
        evidenceCandidates: {
          "tr-1": { kind: "transcript" as const, ref: "tr-1", digest: "b".repeat(64) },
        },
      }
      const result = mergeDecisions(
        [],
        [{ topic: "t".repeat(256), decision: "d".repeat(500), evidence_refs: ["tr-1"] } as never],
        llmMeta,
      )
      expect(result).toHaveLength(1)
      expect(result[0]!.topic.length).toBe(256)
      expect(result[0]!.decision.length).toBe(500)
    })
  })

  // ── extract-schema creation limits ────────────────────────────────────

  describe("ExtractedFactsSchema reflects creation limits", () => {
    const validFacts = {
      current_task: "Build the API",
      active_files: [{ path: "src/api.ts", reason: "edited" }],
      decisions: [{ topic: "database", decision: "Use Postgres", evidence_refs: ["tr-1"] }],
      blockers: [],
      next_steps: ["Add tests"],
    }

    it("accepts at-limit facts and publishes correct JSON schema maxima", () => {
      const atLimit = {
        current_task: "x".repeat(MEMORY_CREATION_LIMITS.currentTaskChars),
        active_files: Array.from({ length: MEMORY_CREATION_LIMITS.activeFilesMax }, (_, i) => ({
          path: `src/file-${i}.ts`,
          reason: "r".repeat(MEMORY_CREATION_LIMITS.activeFileReasonChars),
        })),
        decisions: [
          {
            topic: "t".repeat(MEMORY_CREATION_LIMITS.decisionTopicChars),
            decision: "d".repeat(MEMORY_CREATION_LIMITS.decisionTextChars),
            rationale: "r".repeat(MEMORY_CREATION_LIMITS.decisionRationaleChars),
            evidence_refs: ["tr-1"],
          },
        ],
        blockers: Array.from({ length: MEMORY_CREATION_LIMITS.blockersMax }, (_, i) => `b-${i}`),
        next_steps: Array.from({ length: MEMORY_CREATION_LIMITS.nextStepsMax }, (_, i) => `s-${i}`),
      }
      expect(ExtractedFactsSchema.safeParse(atLimit).success).toBe(true)
      expect(validateStructuredResult(atLimit)).not.toBeNull()
      expect(ExtractedFactsJsonSchema.properties.current_task.maxLength).toBe(512)
      expect(ExtractedFactsJsonSchema.properties.active_files.maxItems).toBe(16)
      expect(ExtractedFactsJsonSchema.properties.active_files.items.properties.path.maxLength).toBe(2_048)
      expect(ExtractedFactsJsonSchema.properties.active_files.items.properties.reason.maxLength).toBe(512)
      expect(ExtractedFactsJsonSchema.properties.decisions.items.properties.topic.maxLength).toBe(256)
      expect(ExtractedFactsJsonSchema.properties.decisions.items.properties.decision.maxLength).toBe(500)
      expect(ExtractedFactsJsonSchema.properties.decisions.items.properties.rationale.maxLength).toBe(500)
      expect(ExtractedFactsJsonSchema.properties.blockers.maxItems).toBe(8)
      expect(ExtractedFactsJsonSchema.properties.blockers.items.maxLength).toBe(512)
      expect(ExtractedFactsJsonSchema.properties.next_steps.maxItems).toBe(8)
      expect(ExtractedFactsJsonSchema.properties.next_steps.items.maxLength).toBe(512)
    })

    it("rejects over-limit active-file path and reason", () => {
      expect(
        ExtractedFactsSchema.safeParse({
          ...validFacts,
          active_files: [{ path: "x".repeat(2_049), reason: "edited" }],
        }).success,
      ).toBe(false)
      expect(
        ExtractedFactsSchema.safeParse({
          ...validFacts,
          active_files: [{ path: "src/api.ts", reason: "x".repeat(513) }],
        }).success,
      ).toBe(false)
      expect(validateStructuredResult({ ...validFacts, active_files: [{ path: "x".repeat(2_049), reason: "r" }] })).toBeNull()
    })

    it("rejects over-limit current_task, blocker and next_step strings", () => {
      expect(ExtractedFactsSchema.safeParse({ ...validFacts, current_task: "x".repeat(513) }).success).toBe(false)
      expect(ExtractedFactsSchema.safeParse({ ...validFacts, blockers: ["x".repeat(513)] }).success).toBe(false)
      expect(ExtractedFactsSchema.safeParse({ ...validFacts, next_steps: ["x".repeat(513)] }).success).toBe(false)
      expect(validateStructuredResult({ ...validFacts, current_task: "x".repeat(513) })).toBeNull()
    })

    it("rejects over-limit counts for active_files, blockers, next_steps", () => {
      const manyFiles = Array.from({ length: 17 }, (_, i) => ({ path: `src/f-${i}.ts`, reason: "r" }))
      expect(ExtractedFactsSchema.safeParse({ ...validFacts, active_files: manyFiles }).success).toBe(false)
      const manyBlockers = Array.from({ length: 9 }, (_, i) => `b-${i}`)
      expect(ExtractedFactsSchema.safeParse({ ...validFacts, blockers: manyBlockers }).success).toBe(false)
      const manySteps = Array.from({ length: 9 }, (_, i) => `s-${i}`)
      expect(ExtractedFactsSchema.safeParse({ ...validFacts, next_steps: manySteps }).success).toBe(false)
      expect(validateStructuredResult({ ...validFacts, blockers: manyBlockers })).toBeNull()
    })

    it("rejects over-limit decision topic/text/rationale", () => {
      expect(
        ExtractedFactsSchema.safeParse({
          ...validFacts,
          decisions: [{ topic: "t".repeat(257), decision: "Use Postgres", evidence_refs: ["tr-1"] }],
        }).success,
      ).toBe(false)
      expect(
        ExtractedFactsSchema.safeParse({
          ...validFacts,
          decisions: [{ topic: "database", decision: "d".repeat(501), evidence_refs: ["tr-1"] }],
        }).success,
      ).toBe(false)
      expect(
        ExtractedFactsSchema.safeParse({
          ...validFacts,
          decisions: [{ topic: "database", decision: "Use Postgres", rationale: "r".repeat(501), evidence_refs: ["tr-1"] }],
        }).success,
      ).toBe(false)
      expect(
        validateStructuredResult({
          ...validFacts,
          decisions: [{ topic: "t".repeat(257), decision: "d", evidence_refs: ["tr-1"] }],
        }),
      ).toBeNull()
    })

    it("LLM decisions-only contract remains 256/500/500 with 1-3 evidence refs", () => {
      expect(LLMDecisionFactsJsonSchema.properties.decisions.items.properties.topic.maxLength).toBe(256)
      expect(LLMDecisionFactsJsonSchema.properties.decisions.items.properties.decision.maxLength).toBe(500)
      expect(LLMDecisionFactsJsonSchema.properties.decisions.items.properties.rationale.maxLength).toBe(500)
      expect(validateLLMDecisionResult({ decisions: [{ topic: "t".repeat(256), decision: "d".repeat(500), evidence_refs: ["tr-1"] }] })).not.toBeNull()
      expect(validateLLMDecisionResult({ decisions: [{ topic: "t".repeat(257), decision: "d", evidence_refs: ["tr-1"] }] })).toBeNull()
      expect(validateLLMDecisionResult({ decisions: [{ topic: "t", decision: "d".repeat(501), evidence_refs: ["tr-1"] }] })).toBeNull()
    })

    it("persistence ceiling still allows human-reviewed long row via MemoryFileSchema", () => {
      const mem = {
        ...emptyMemory("/test/project"),
        decisions: [humanDecision()],
      }
      expect(MemoryFileSchema.safeParse(mem).success).toBe(true)
      // Same long topic would be rejected by automatic creation schema
      expect(
        ExtractedFactsSchema.safeParse({
          current_task: null,
          active_files: [],
          decisions: [{ topic: "t".repeat(300), decision: "d".repeat(600), evidence_refs: ["tr-1"] }],
          blockers: [],
          next_steps: [],
        }).success,
      ).toBe(false)
    })
  })
})
