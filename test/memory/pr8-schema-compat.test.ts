/**
 * PR 8 Wave 1 (Agent B) — schema/migration compatibility contract tests.
 *
 * These tests freeze the PR-8 schema/migration contracts from
 * docs/CRIP/PR-8/implementation-plan.md §8 ("Add field and construction bounds
 * without breaking existing v3 STATE"):
 *
 *   - an exported tight `MEMORY_CREATION_LIMITS` object for new automatic
 *     content (current task 512, active-file path 2048 / reason 512, decision
 *     topic 256 / text 500 / rationale 500, blocker 512, next step 512,
 *     blockers max 8, next steps max 8, active files max 16);
 *   - broad persistence compatibility ceilings so a previously valid PR-7
 *     `version:3` file stays readable (project_path 4096, current_task 2048,
 *     active-file path 4096 / reason 2048, blocker/next-step 2048, decision
 *     topic/text/rationale 8192, non-authoritative arrays <= 128);
 *   - deterministic pure repair of oversized non-authoritative arrays before
 *     final validation, without inventing provenance/evidence;
 *   - human-reviewed foundational topic/decision text is never truncated to
 *     the automatic creation limits;
 *   - malformed current-format data beyond the broad ceiling fails closed;
 *   - the decisions-only LLM contract remains 256/500/500 with 1-3 evidence
 *     refs.
 *
 * On current main these tests intentionally FAIL for the missing PR-8
 * behavior (no `MEMORY_CREATION_LIMITS` export, unbounded semantic strings,
 * no array repair). Wave 3 implements the production behavior and this suite
 * goes green. No production file is modified by this test.
 */
import { describe, expect, it } from "vitest"
import {
  MemoryFileSchema,
  emptyMemory,
} from "../../src/memory/schema"
import * as schemaModule from "../../src/memory/schema"
import { loadAndMigrate } from "../../src/memory/migrate"
import {
  LLMDecisionFactsJsonSchema,
  validateLLMDecisionResult,
} from "../../src/memory/extract-schema"

// ─── Shared current-v3 fixtures (fixed IDs, no random values) ───────────────

const legacyProvenance = {
  extractor: "legacy" as const,
  source_session_id: "legacy-session",
  confidence: "legacy" as const,
  evidence: [],
}

const heuristicProvenance = {
  extractor: "heuristic" as const,
  source_session_id: "heuristic-session",
  confidence: "heuristic" as const,
  evidence: [],
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

const validDecision = {
  id: "decision-1",
  topic: "storage",
  decision: "Use Postgres",
  timestamp: "2026-08-12T00:00:00.000Z",
  session_id: "source-1",
  still_valid: true,
  foundational_requested: false,
  provenance: legacyProvenance,
}

/** A trusted human foundational row whose text exceeds the automatic creation limits. */
function humanFoundationalDecision(overrides: Record<string, unknown> = {}) {
  return {
    id: "d-human-foundational",
    topic: "t".repeat(300), // > decisionTopicChars (256), within the 8192 persistence ceiling
    decision: "d".repeat(600), // > decisionTextChars (500), within the 8192 persistence ceiling
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

function activeFile(path: string, reason = "edited") {
  return {
    path,
    reason,
    last_touched: "2026-08-12T00:00:00.000Z",
    provenance: heuristicProvenance,
  }
}

/** A realistic current-version `version:3` STATE shape. */
function currentV3(overrides: Record<string, unknown> = {}) {
  return {
    ...emptyMemory("/test/project"),
    last_updated: "2026-08-12T00:00:00.000Z",
    last_git_sha: "abc123",
    last_session_id: "session-v3",
    current_task: "Keep the migration readable",
    current_task_provenance: heuristicProvenance,
    ...overrides,
  }
}

// ─── PR 8 §8.1 — MEMORY_CREATION_LIMITS for new automatic content ───────────
// The plan centralizes tight creation limits in `src/memory/schema.ts`. The
// export does not exist on current main, so these tests fail until Wave 3.
describe("PR 8 §8.1 — MEMORY_CREATION_LIMITS contract", () => {
  const schema = schemaModule as typeof schemaModule & {
    MEMORY_CREATION_LIMITS: {
      currentTaskChars: number
      activeFilePathChars: number
      activeFileReasonChars: number
      decisionTopicChars: number
      decisionTextChars: number
      decisionRationaleChars: number
      blockerChars: number
      nextStepChars: number
      blockersMax: number
      nextStepsMax: number
      activeFilesMax: number
    }
  }

  it("exports tight creation limits for new automatic content", () => {
    expect(schema.MEMORY_CREATION_LIMITS).toBeDefined()
    const L = schema.MEMORY_CREATION_LIMITS
    expect(L.currentTaskChars).toBe(512)
    expect(L.activeFilePathChars).toBe(2_048)
    expect(L.activeFileReasonChars).toBe(512)
    expect(L.decisionTopicChars).toBe(256)
    expect(L.decisionTextChars).toBe(500)
    expect(L.decisionRationaleChars).toBe(500)
    expect(L.blockerChars).toBe(512)
    expect(L.nextStepChars).toBe(512)
    expect(L.blockersMax).toBe(8)
    expect(L.nextStepsMax).toBe(8)
    expect(L.activeFilesMax).toBe(16)
  })

  it("creation limits are tighter than or equal to the persistence ceilings", () => {
    const L = schema.MEMORY_CREATION_LIMITS
    expect(L).toBeDefined()
    if (!L) return
    expect(L.currentTaskChars).toBeLessThanOrEqual(2_048)
    expect(L.activeFilePathChars).toBeLessThanOrEqual(4_096)
    expect(L.activeFileReasonChars).toBeLessThanOrEqual(2_048)
    expect(L.decisionTopicChars).toBeLessThanOrEqual(8_192)
    expect(L.decisionTextChars).toBeLessThanOrEqual(8_192)
    expect(L.decisionRationaleChars).toBeLessThanOrEqual(8_192)
    expect(L.blockerChars).toBeLessThanOrEqual(2_048)
    expect(L.nextStepChars).toBeLessThanOrEqual(2_048)
    expect(L.blockersMax).toBeLessThanOrEqual(128)
    expect(L.nextStepsMax).toBeLessThanOrEqual(128)
    expect(L.activeFilesMax).toBeLessThanOrEqual(128)
  })

  it("schema accepts new automatic content at the creation limits", () => {
    const L = schema.MEMORY_CREATION_LIMITS
    expect(L).toBeDefined()
    if (!L) return
    const memory = currentV3({
      current_task: "x".repeat(L.currentTaskChars),
      active_files: Array.from({ length: L.activeFilesMax }, (_, index) => ({
        path: `src/file-${index}.ts`,
        reason: "r".repeat(L.activeFileReasonChars),
        last_touched: "2026-08-12T00:00:00.000Z",
        provenance: heuristicProvenance,
      })),
      decisions: [{
        ...validDecision,
        topic: "t".repeat(L.decisionTopicChars),
        decision: "d".repeat(L.decisionTextChars),
        rationale: "r".repeat(L.decisionRationaleChars),
      }],
      blockers: Array.from({ length: L.blockersMax }, (_, index) => `blocker-${index}`),
      next_steps: Array.from({ length: L.nextStepsMax }, (_, index) => `step-${index}`),
    })
    expect(MemoryFileSchema.safeParse(memory).success).toBe(true)
  })
})

// ─── PR 8 §8.2 — persistence compatibility ceilings ───────────────────────────
// A previously valid PR-7 `version:3` file must stay readable under the new
// broad ceilings, while data beyond the ceiling fails closed. On current main
// the semantic strings are unbounded, so the rejection assertions fail.
describe("PR 8 §8.2 — persistence compatibility ceilings", () => {
  it("bounds current_task at 2048 chars", () => {
    expect(MemoryFileSchema.safeParse(currentV3({ current_task: "x".repeat(2_048) })).success).toBe(true)
    expect(MemoryFileSchema.safeParse(currentV3({ current_task: "x".repeat(2_049) })).success).toBe(false)
  })

  it("bounds active-file path at 4096 chars and reason at 2048 chars", () => {
    expect(MemoryFileSchema.safeParse(currentV3({
      active_files: [activeFile("x".repeat(4_096))],
    })).success).toBe(true)
    expect(MemoryFileSchema.safeParse(currentV3({
      active_files: [activeFile("x".repeat(4_097))],
    })).success).toBe(false)
    expect(MemoryFileSchema.safeParse(currentV3({
      active_files: [activeFile("src/main.ts", "x".repeat(2_048))],
    })).success).toBe(true)
    expect(MemoryFileSchema.safeParse(currentV3({
      active_files: [activeFile("src/main.ts", "x".repeat(2_049))],
    })).success).toBe(false)
  })

  it("bounds blocker and next-step strings at 2048 chars", () => {
    expect(MemoryFileSchema.safeParse(currentV3({ blockers: ["x".repeat(2_048)] })).success).toBe(true)
    expect(MemoryFileSchema.safeParse(currentV3({ blockers: ["x".repeat(2_049)] })).success).toBe(false)
    expect(MemoryFileSchema.safeParse(currentV3({ next_steps: ["x".repeat(2_048)] })).success).toBe(true)
    expect(MemoryFileSchema.safeParse(currentV3({ next_steps: ["x".repeat(2_049)] })).success).toBe(false)
  })

  it("bounds decision topic, text, and rationale at 8192 chars each", () => {
    expect(MemoryFileSchema.safeParse(currentV3({
      decisions: [{ ...validDecision, topic: "x".repeat(8_192) }],
    })).success).toBe(true)
    expect(MemoryFileSchema.safeParse(currentV3({
      decisions: [{ ...validDecision, topic: "x".repeat(8_193) }],
    })).success).toBe(false)
    expect(MemoryFileSchema.safeParse(currentV3({
      decisions: [{ ...validDecision, decision: "x".repeat(8_192) }],
    })).success).toBe(true)
    expect(MemoryFileSchema.safeParse(currentV3({
      decisions: [{ ...validDecision, decision: "x".repeat(8_193) }],
    })).success).toBe(false)
    expect(MemoryFileSchema.safeParse(currentV3({
      decisions: [{ ...validDecision, rationale: "x".repeat(8_192) }],
    })).success).toBe(true)
    expect(MemoryFileSchema.safeParse(currentV3({
      decisions: [{ ...validDecision, rationale: "x".repeat(8_193) }],
    })).success).toBe(false)
  })

  it("bounds project_path at 4096 chars", () => {
    expect(MemoryFileSchema.safeParse(currentV3({ project_path: "x".repeat(4_096) })).success).toBe(true)
    expect(MemoryFileSchema.safeParse(currentV3({ project_path: "x".repeat(4_097) })).success).toBe(false)
  })

  it("bounds non-authoritative arrays at 128 entries", () => {
    const blockers128 = Array.from({ length: 128 }, (_, index) => `blocker-${index}`)
    const blockers129 = Array.from({ length: 129 }, (_, index) => `blocker-${index}`)
    expect(MemoryFileSchema.safeParse(currentV3({ blockers: blockers128 })).success).toBe(true)
    expect(MemoryFileSchema.safeParse(currentV3({ blockers: blockers129 })).success).toBe(false)

    const steps128 = Array.from({ length: 128 }, (_, index) => `step-${index}`)
    const steps129 = Array.from({ length: 129 }, (_, index) => `step-${index}`)
    expect(MemoryFileSchema.safeParse(currentV3({ next_steps: steps128 })).success).toBe(true)
    expect(MemoryFileSchema.safeParse(currentV3({ next_steps: steps129 })).success).toBe(false)

    const files128 = Array.from({ length: 128 }, (_, index) => activeFile(`src/file-${index}.ts`))
    const files129 = Array.from({ length: 129 }, (_, index) => activeFile(`src/file-${index}.ts`))
    expect(MemoryFileSchema.safeParse(currentV3({ active_files: files128 })).success).toBe(true)
    expect(MemoryFileSchema.safeParse(currentV3({ active_files: files129 })).success).toBe(false)
  })
})

// ─── PR 8 §8.3 — current-v3 compatibility repair ─────────────────────────────
// Before final validation, `loadAndMigrate` must deterministically cap
// grossly excessive non-authoritative arrays without inventing provenance or
// evidence, and must never truncate human-reviewed foundational text. On
// current main no array repair exists, so the capping assertions fail.
describe("PR 8 §8.3 — current-v3 compatibility repair", () => {
  it("loads an actual current-v3 fixture compatibly without truncating human-reviewed foundational text", () => {
    const fixture = currentV3({
      revision: 7,
      current_task: "Ship the storage budget workstream",
      active_files: [
        activeFile("src/memory/schema.ts", "adding persistence ceilings"),
        activeFile("src/memory/migrate.ts", "adding compatibility repair"),
      ],
      decisions: [
        humanFoundationalDecision(),
        { ...validDecision, id: "decision-2", topic: "auth", decision: "Use JWT" },
      ],
      blockers: ["await oracle review"],
      next_steps: ["run release gate"],
      recent_sessions: ["session-v3"],
      processed_sources: [{
        source_key: "v2s:" + "a".repeat(64),
        extraction_key: "v2e:" + "b".repeat(64),
        extraction_contract_version: 3,
        completed_at: "2026-08-12T12:00:00.000Z",
      }],
    })

    const result = loadAndMigrate(fixture)
    expect(result).not.toBeNull()
    // Semantic state is preserved.
    expect(result!.current_task).toBe("Ship the storage budget workstream")
    expect(result!.active_files).toHaveLength(2)
    expect(result!.blockers).toEqual(["await oracle review"])
    expect(result!.next_steps).toEqual(["run release gate"])
    expect(result!.processed_sources).toHaveLength(1)
    expect(result!.revision).toBe(7)
    // Human-reviewed foundational topic/decision text is preserved exactly —
    // never truncated to the automatic creation limits (256/500).
    const human = result!.decisions.find((d) => d.id === "d-human-foundational")!
    expect(human.topic).toBe("t".repeat(300))
    expect(human.decision).toBe("d".repeat(600))
    expect(human.topic.length).toBe(300)
    expect(human.decision.length).toBe(600)
  })

  it("caps grossly excessive non-authoritative arrays deterministically before validation", () => {
    const originalBlockers = Array.from({ length: 200 }, (_, index) => `blocker-${index}`)
    const originalSteps = Array.from({ length: 200 }, (_, index) => `step-${index}`)
    const originalFiles = Array.from({ length: 200 }, (_, index) => activeFile(`src/file-${index}.ts`))
    const raw = currentV3({
      blockers: originalBlockers,
      next_steps: originalSteps,
      active_files: originalFiles,
    })

    const result = loadAndMigrate(raw)
    expect(result).not.toBeNull()
    expect(result!.blockers.length).toBeLessThanOrEqual(128)
    expect(result!.next_steps.length).toBeLessThanOrEqual(128)
    expect(result!.active_files.length).toBeLessThanOrEqual(128)
    // The repair never invents entries: every retained entry is a subset of
    // the original input.
    expect(result!.blockers.every((b) => originalBlockers.includes(b))).toBe(true)
    expect(result!.next_steps.every((s) => originalSteps.includes(s))).toBe(true)
    expect(result!.active_files.every((f) => originalFiles.some((o) => o.path === f.path))).toBe(true)
  })

  it("repair never invents provenance or evidence to make a size problem go away", () => {
    const evidence = [
      { kind: "transcript" as const, ref: "tr-1", digest: "a".repeat(64) },
      { kind: "transcript" as const, ref: "tr-2", digest: "b".repeat(64) },
    ]
    const decisionWithEvidence = {
      ...validDecision,
      id: "d-evidence",
      provenance: {
        extractor: "llm" as const,
        source_session_id: "sess-llm",
        source_audit_session_id: "audit-1",
        confidence: "llm-corroborated" as const,
        evidence,
      },
    }
    const raw = currentV3({
      decisions: [decisionWithEvidence],
      blockers: Array.from({ length: 200 }, (_, index) => `blocker-${index}`),
    })

    const result = loadAndMigrate(raw)
    expect(result).not.toBeNull()
    expect(result!.blockers.length).toBeLessThanOrEqual(128)
    // The decision's provenance and evidence are preserved exactly.
    expect(result!.decisions).toHaveLength(1)
    expect(result!.decisions[0]!.provenance).toEqual(decisionWithEvidence.provenance)
    expect(result!.decisions[0]!.provenance?.evidence).toEqual(evidence)
  })

  it("repeated load of the same repaired v3 bytes returns deterministic semantic state", () => {
    const raw = currentV3({
      blockers: Array.from({ length: 200 }, (_, index) => `blocker-${index}`),
      next_steps: Array.from({ length: 200 }, (_, index) => `step-${index}`),
    })

    const first = loadAndMigrate(JSON.parse(JSON.stringify(raw)))!
    const second = loadAndMigrate(JSON.parse(JSON.stringify(raw)))!
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first.blockers).toEqual(second.blockers)
    expect(first.next_steps).toEqual(second.next_steps)
    expect(first.blockers.length).toBeLessThanOrEqual(128)
    expect(first.next_steps.length).toBeLessThanOrEqual(128)
  })

  it("malformed current-format data beyond the broad persistence ceiling fails closed", () => {
    expect(loadAndMigrate(currentV3({ current_task: "x".repeat(2_049) }))).toBeNull()
    expect(loadAndMigrate(currentV3({ project_path: "x".repeat(4_097) }))).toBeNull()
    expect(loadAndMigrate(currentV3({ blockers: ["x".repeat(2_049)] }))).toBeNull()
    expect(loadAndMigrate(currentV3({ next_steps: ["x".repeat(2_049)] }))).toBeNull()
    expect(loadAndMigrate(currentV3({
      active_files: [activeFile("x".repeat(4_097))],
    }))).toBeNull()
    expect(loadAndMigrate(currentV3({
      decisions: [{ ...validDecision, topic: "x".repeat(8_193) }],
    }))).toBeNull()
  })
})

// ─── PR 8 §8.1 — decisions-only LLM contract remains 256/500/500 ─────────────
// The LLM decisions-only contract is unchanged by PR 8. These tests guard the
// existing 256/500/500 field limits and the 1-3 evidence-ref gate.
describe("PR 8 §8.1 — decisions-only LLM contract remains 256/500/500 with 1-3 evidence refs", () => {
  const validDecision = {
    topic: "database",
    decision: "Use Postgres",
    rationale: "The transcript explicitly selected it.",
    evidence_refs: ["tr-evidence"],
  }

  it("accepts topic/decision/rationale at the 256/500/500 limits with 1-3 evidence refs", () => {
    expect(validateLLMDecisionResult({
      decisions: [{
        topic: "t".repeat(256),
        decision: "d".repeat(500),
        rationale: "r".repeat(500),
        evidence_refs: ["tr-1", "tr-2", "tr-3"],
      }],
    })).not.toBeNull()
    expect(validateLLMDecisionResult({ decisions: [validDecision] })).not.toBeNull()
  })

  it("rejects topic beyond 256, decision beyond 500, and rationale beyond 500", () => {
    expect(validateLLMDecisionResult({
      decisions: [{ ...validDecision, topic: "t".repeat(257) }],
    })).toBeNull()
    expect(validateLLMDecisionResult({
      decisions: [{ ...validDecision, decision: "d".repeat(501) }],
    })).toBeNull()
    expect(validateLLMDecisionResult({
      decisions: [{ ...validDecision, rationale: "r".repeat(501) }],
    })).toBeNull()
  })

  it("rejects evidence_refs outside 1-3 and duplicate refs", () => {
    expect(validateLLMDecisionResult({
      decisions: [{ ...validDecision, evidence_refs: [] }],
    })).toBeNull()
    expect(validateLLMDecisionResult({
      decisions: [{ ...validDecision, evidence_refs: ["tr-1", "tr-2", "tr-3", "tr-4"] }],
    })).toBeNull()
    expect(validateLLMDecisionResult({
      decisions: [{ ...validDecision, evidence_refs: ["tr-1", "tr-1"] }],
    })).toBeNull()
  })

  it("publishes the 256/500/500 and 1-3 evidence-ref contract in the JSON schema", () => {
    const item = LLMDecisionFactsJsonSchema.properties.decisions.items
    expect(item.properties.topic.maxLength).toBe(256)
    expect(item.properties.decision.maxLength).toBe(500)
    expect(item.properties.rationale.maxLength).toBe(500)
    expect(item.properties.evidence_refs.minItems).toBe(1)
    expect(item.properties.evidence_refs.maxItems).toBe(3)
  })

  it("caps the decisions array at 10", () => {
    const decisions = Array.from({ length: 11 }, (_, index) => ({
      ...validDecision,
      topic: `topic-${index}`,
      evidence_refs: [`tr-${index}`],
    }))
    expect(validateLLMDecisionResult({ decisions })).toBeNull()
  })
})
