/**
 * PR 3 §6 decision-authority tests (implementation-plan §15 items 1-10).
 *
 * These are Wave 1 failing regression fixtures. They target the planned
 * `src/memory/decision-authority.ts` module, which does not exist yet on main.
 * The import below therefore fails to resolve until Wave 3 lands — that is the
 * intended Wave 1 outcome. Tests 9 and 10 additionally reference schema fields
 * (`human_review`, the human-trust consistency invariant) that ship in Wave 2.
 */
import { describe, it, expect } from "vitest"
import {
  normalizeDecisionTopic,
  normalizeDecisionText,
  isTrustedHumanFoundational,
  resolveDecisionAuthorities,
  type DecisionAuthorityConflict,
  type DecisionAuthorityResolution,
} from "../../src/memory/decision-authority"
import type { Decision } from "../../src/memory/schema"
import { emptyMemory, MemoryFileSchema } from "../../src/memory/schema"
import { loadAndMigrate } from "../../src/memory/migrate"
import {
  requestFoundationalReview,
  confirmFoundationalReview,
  supersedeHumanAuthority,
} from "../../src/memory/decision-review"

// ─── helpers ────────────────────────────────────────────────────────────────

const heuristicProv = {
  extractor: "heuristic" as const,
  source_session_id: "s-h",
  confidence: "heuristic" as const,
  evidence: [] as never[],
}
const llmProv = {
  extractor: "llm" as const,
  source_session_id: "s-l",
  source_audit_session_id: "audit-l",
  confidence: "llm-corroborated" as const,
  evidence: [] as never[],
}
const legacyProv = {
  extractor: "legacy" as const,
  source_session_id: "s-legacy",
  confidence: "legacy" as const,
  evidence: [] as never[],
}
const humanProv = {
  extractor: "human" as const,
  source_session_id: "s-human",
  confidence: "human-reviewed" as const,
  evidence: [] as never[],
}

/**
 * Build a Decision literal. `overrides` may carry the not-yet-shipped PR 3
 * fields (`human_review`, `superseded_by`, `conflicts_with`,
 * `derived_from_decision_id`); the cast keeps TypeScript from rejecting them
 * before Wave 2 adds them to the schema.
 */
function mkDecision(overrides: Record<string, unknown> & Partial<Decision> = {}): Decision {
  return {
    id: "d1",
    topic: "auth",
    decision: "Use JWT",
    timestamp: "2026-08-01T00:00:00Z",
    session_id: "session-0",
    still_valid: true,
    foundational: false,
    foundational_requested: false,
    ...overrides,
  } as Decision
}

function lineageOf(d: Decision | undefined): { superseded_by?: string; conflicts_with?: string[] } {
  return (d ?? {}) as { superseded_by?: string; conflicts_with?: string[] }
}

// ─── §15 items 1-10 ─────────────────────────────────────────────────────────

describe("PR 3 §6 decision authority", () => {
  it("1. topic normalization is exact and locale-independent", () => {
    expect(normalizeDecisionTopic("Auth")).toBe("auth")
    expect(normalizeDecisionTopic("auth")).toBe("auth")
    expect(normalizeDecisionTopic("  AUTH  ")).toBe("auth")
    // Exact normalized equality, never substring equality.
    expect(normalizeDecisionTopic("auth")).not.toBe(normalizeDecisionTopic("authentication"))
    // NFKC normalization folds full-width forms.
    expect(normalizeDecisionTopic("ＡＵＴＨ")).toBe("auth")
  })

  it("2. equivalent valid heuristic rows resolve to one authority", () => {
    const older = mkDecision({ id: "b", topic: "auth", decision: "Use JWT", timestamp: "2026-08-01T00:00:00Z", provenance: heuristicProv })
    const newer = mkDecision({ id: "a", topic: "auth", decision: "Use JWT", timestamp: "2026-08-02T00:00:00Z", provenance: heuristicProv })
    const res = resolveDecisionAuthorities([older, newer])
    expect(res.authorities).toHaveLength(1)
    // Oldest timestamp asc, then lexical ID.
    expect(res.authorities[0]!.id).toBe("b")
  })

  it("3. heuristic X + agreeing LLM X resolves to one authority; read view preserves the winner's original provenance", () => {
    const heuristic = mkDecision({ id: "h1", topic: "auth", decision: "Use JWT", timestamp: "2026-08-01T00:00:00Z", provenance: heuristicProv })
    const llm = mkDecision({ id: "l1", topic: "auth", decision: "Use JWT", timestamp: "2026-08-02T00:00:00Z", provenance: llmProv })
    const res = resolveDecisionAuthorities([heuristic, llm])
    expect(res.authorities).toHaveLength(1)
    // Original heuristic ID is preserved.
    expect(res.authorities[0]!.id).toBe("h1")
    // Wave-9 (Concern A): the read view is an authority/lineage view only. The
    // winner keeps its OWN persisted provenance; strongest-provenance
    // enrichment is a WRITE-path action in mergeDecisions, never a read-time
    // upgrade. The LLM row is marked historical.
    expect(res.authorities[0]!.provenance?.extractor).toBe("heuristic")
    expect(res.authorities[0]!.provenance?.confidence).toBe("heuristic")
    const llmRow = res.decisions.find((d) => d.id === "l1")
    expect(llmRow?.still_valid).toBe(false)
    expect(lineageOf(llmRow).superseded_by).toBe("h1")
  })

  it("4. later heuristic Y after agreeing heuristic+LLM X leaves only Y authoritative", () => {
    const hx = mkDecision({ id: "hx", topic: "auth", decision: "Use JWT", timestamp: "2026-08-01T00:00:00Z", provenance: heuristicProv })
    const lx = mkDecision({ id: "lx", topic: "auth", decision: "Use JWT", timestamp: "2026-08-02T00:00:00Z", provenance: llmProv })
    const y = mkDecision({ id: "y", topic: "auth", decision: "Use OAuth2", timestamp: "2026-08-03T00:00:00Z", provenance: heuristicProv })
    const res = resolveDecisionAuthorities([hx, lx, y])
    expect(res.authorities).toHaveLength(1)
    expect(res.authorities[0]!.id).toBe("y")
    const hxRow = res.decisions.find((d) => d.id === "hx")
    const lxRow = res.decisions.find((d) => d.id === "lx")
    expect(hxRow?.still_valid).toBe(false)
    expect(lineageOf(hxRow).superseded_by).toBe("y")
    expect(lxRow?.still_valid).toBe(false)
    expect(lineageOf(lxRow).superseded_by).toBe("y")
  })

  it("5. three duplicate-valid legacy rows normalize deterministically", () => {
    const rows = [
      mkDecision({ id: "c", topic: "auth", decision: "Use JWT", timestamp: "2026-08-03T00:00:00Z", provenance: legacyProv }),
      mkDecision({ id: "a", topic: "auth", decision: "Use JWT", timestamp: "2026-08-01T00:00:00Z", provenance: legacyProv }),
      mkDecision({ id: "b", topic: "auth", decision: "Use JWT", timestamp: "2026-08-02T00:00:00Z", provenance: legacyProv }),
    ]
    const res = resolveDecisionAuthorities(rows)
    expect(res.authorities).toHaveLength(1)
    const winner = res.authorities[0]!.id
    expect(winner).toBe("a") // oldest timestamp asc
    for (const r of res.decisions) {
      if (r.id !== winner) {
        expect(r.still_valid).toBe(false)
        expect(lineageOf(r).superseded_by).toBe(winner)
      }
    }
  })

  it("6. conflicting non-human legacy rows select newest authority deterministically", () => {
    const older = mkDecision({ id: "old", topic: "auth", decision: "Use JWT", timestamp: "2026-08-01T00:00:00Z", provenance: heuristicProv })
    const newer = mkDecision({ id: "new", topic: "auth", decision: "Use OAuth2", timestamp: "2026-08-02T00:00:00Z", provenance: heuristicProv })
    const res = resolveDecisionAuthorities([older, newer])
    expect(res.authorities).toHaveLength(1)
    expect(res.authorities[0]!.id).toBe("new")
    const oldRow = res.decisions.find((d) => d.id === "old")
    expect(oldRow?.still_valid).toBe(false)
    expect(lineageOf(oldRow).superseded_by).toBe("new")
  })

  it("7. trusted human foundational row wins over conflicting automated rows", () => {
    const human = mkDecision({
      id: "human-1", topic: "auth", decision: "Use JWT", timestamp: "2026-08-01T00:00:00Z",
      foundational: true,
      human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
      provenance: humanProv,
    })
    const llm = mkDecision({ id: "llm-1", topic: "auth", decision: "Use OAuth2", timestamp: "2026-08-02T00:00:00Z", provenance: llmProv })
    const heuristic = mkDecision({ id: "h-1", topic: "auth", decision: "Use SAML", timestamp: "2026-08-03T00:00:00Z", provenance: heuristicProv })
    const res = resolveDecisionAuthorities([human, llm, heuristic])
    expect(res.authorities).toHaveLength(1)
    expect(res.authorities[0]!.id).toBe("human-1")
    const llmRow = res.decisions.find((d) => d.id === "llm-1")
    const hRow = res.decisions.find((d) => d.id === "h-1")
    expect(llmRow?.still_valid).toBe(false)
    expect(lineageOf(llmRow).conflicts_with).toEqual(["human-1"])
    expect(hRow?.still_valid).toBe(false)
    expect(lineageOf(hRow).conflicts_with).toEqual(["human-1"])
  })

  it("8. multiple conflicting trusted human foundational rows produce no automatic authority and explicit conflict", () => {
    const humanA = mkDecision({
      id: "human-a", topic: "auth", decision: "Use JWT", timestamp: "2026-08-01T00:00:00Z",
      foundational: true,
      human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
      provenance: humanProv,
    })
    const humanB = mkDecision({
      id: "human-b", topic: "auth", decision: "Use OAuth2", timestamp: "2026-08-02T00:00:00Z",
      foundational: true,
      human_review: { channel: "interactive-cli", reviewed_at: "2026-08-02T00:00:00Z" },
      provenance: humanProv,
    })
    const res = resolveDecisionAuthorities([humanA, humanB])
    expect(res.authorities).toHaveLength(0)
    const aRow = res.decisions.find((d) => d.id === "human-a")
    const bRow = res.decisions.find((d) => d.id === "human-b")
    expect(aRow?.still_valid).toBe(false)
    expect(bRow?.still_valid).toBe(false)
    expect(lineageOf(aRow).conflicts_with).toEqual(["human-b"])
    expect(lineageOf(bRow).conflicts_with).toEqual(["human-a"])
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0]!.kind).toBe("conflicting-human-foundational")
    expect(res.conflicts[0]!.normalized_topic).toBe("auth")
  })

  it("9. pre-PR3 human-reviewed row without human_review reclassified on load", () => {
    // exercised by Wave 2 migrate.ts via loadAndMigrate
    const raw = {
      version: 3,
      project_path: "/test",
      last_updated: "2026-08-08T12:00:00.000Z",
      active_files: [],
      decisions: [{
        id: "d-human",
        topic: "auth",
        decision: "Use JWT",
        timestamp: "2026-08-01T00:00:00.000Z",
        session_id: "sess-human",
        still_valid: true,
        foundational: true,
        foundational_requested: false,
        provenance: {
          extractor: "human",
          source_session_id: "sess-human",
          confidence: "human-reviewed",
          evidence: [],
        },
      }],
      blockers: [],
      next_steps: [],
      recent_sessions: [],
    }
    const result = loadAndMigrate(raw)
    expect(result).not.toBeNull()
    const d = result!.decisions[0]!
    expect(d.foundational).toBe(false)
    expect(d.foundational_requested).toBe(true)
    expect(d.provenance?.extractor).toBe("legacy")
    expect(d.provenance?.confidence).toBe("legacy")
    expect(d.id).toBe("d-human")
    expect(d.topic).toBe("auth")
    expect(d.decision).toBe("Use JWT")
  })

  it("10. newly constructed human-reviewed row without human_review fails schema validation", () => {
    const mem = {
      ...emptyMemory("/test"),
      decisions: [mkDecision({
        id: "d-human",
        topic: "auth",
        decision: "Use JWT",
        foundational: true,
        provenance: humanProv,
      })],
    }
    // Wave 2 adds the human-trust consistency invariant to MemoryFileSchema;
    // until then this row passes validation and the assertion fails.
    expect(MemoryFileSchema.safeParse(mem).success).toBe(false)
  })
})

// ─── resolveDecisionAuthorities shape ───────────────────────────────────────

describe("resolveDecisionAuthorities shape", () => {
  it("returns { decisions, authorities, conflicts }", () => {
    const res = resolveDecisionAuthorities([mkDecision({ provenance: heuristicProv })])
    expect(res).toHaveProperty("decisions")
    expect(res).toHaveProperty("authorities")
    expect(res).toHaveProperty("conflicts")
  })

  it("authorities never includes invalid rows", () => {
    const res = resolveDecisionAuthorities([
      mkDecision({ id: "valid", still_valid: true, provenance: heuristicProv }),
      mkDecision({ id: "invalid", still_valid: false, provenance: heuristicProv }),
    ])
    expect(res.authorities.map((a) => a.id)).not.toContain("invalid")
  })

  it("is a pure function: same input → same output, no mutation", () => {
    const input = [
      mkDecision({ id: "a", topic: "auth", decision: "Use JWT", timestamp: "2026-08-01T00:00:00Z", provenance: heuristicProv }),
      mkDecision({ id: "b", topic: "auth", decision: "Use JWT", timestamp: "2026-08-02T00:00:00Z", provenance: heuristicProv }),
    ]
    const snapshot = JSON.stringify(input)
    const first = resolveDecisionAuthorities(input)
    const second = resolveDecisionAuthorities(input)
    expect(JSON.stringify(input)).toBe(snapshot)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})

// ─── PR 3 wave-9 — durable human conflict quarantine (Blocker 1) ─────────────
describe("PR 3 wave-9 — durable human conflict quarantine", () => {
  function humanRow(id: string, decision: string, timestamp: string, overrides: Record<string, unknown> = {}): Decision {
    return mkDecision({
      id,
      topic: "auth",
      decision,
      timestamp,
      foundational: true,
      foundational_requested: false,
      human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
      provenance: humanProv,
      ...overrides,
    })
  }

  it("two conflicting trusted humans with the durable flag set emit one conflict record and both rows stay quarantined", () => {
    const humanA = humanRow("human-a", "Use JWT", "2026-08-01T00:00:00Z", {
      still_valid: false,
      human_conflict_quarantined: true,
      conflicts_with: ["human-b"],
    })
    const humanB = humanRow("human-b", "Use OAuth2", "2026-08-02T00:00:00Z", {
      still_valid: false,
      human_conflict_quarantined: true,
      conflicts_with: ["human-a"],
    })
    const res = resolveDecisionAuthorities([humanA, humanB])
    expect(res.authorities).toHaveLength(0)
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0]!.kind).toBe("conflicting-human-foundational")
    expect([...res.conflicts[0]!.decision_ids].sort()).toEqual(["human-a", "human-b"])
    const aRow = res.decisions.find((d) => d.id === "human-a")
    const bRow = res.decisions.find((d) => d.id === "human-b")
    expect(aRow?.still_valid).toBe(false)
    expect(aRow?.human_conflict_quarantined).toBe(true)
    expect(bRow?.still_valid).toBe(false)
    expect(bRow?.human_conflict_quarantined).toBe(true)
  })

  it("resolver reconstructs the conflict from persisted non-authoritative rows without the flag (conflicts_with link + durable representation)", () => {
    // Persisted post-reconciliation state: both human rows are still_valid=false
    // and carry reciprocal conflicts_with, but the flag is absent (e.g. a file
    // written by an earlier release).
    const humanA = humanRow("human-a", "Use JWT", "2026-08-01T00:00:00Z", {
      still_valid: false,
      conflicts_with: ["human-b"],
    })
    const humanB = humanRow("human-b", "Use OAuth2", "2026-08-02T00:00:00Z", {
      still_valid: false,
      conflicts_with: ["human-a"],
    })
    const res = resolveDecisionAuthorities([humanA, humanB])
    expect(res.authorities).toHaveLength(0)
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0]!.kind).toBe("conflicting-human-foundational")
    expect([...res.conflicts[0]!.decision_ids].sort()).toEqual(["human-a", "human-b"])
    // The read view sets the durable flag so the next write persists it.
    const aRow = res.decisions.find((d) => d.id === "human-a")
    expect(aRow?.human_conflict_quarantined).toBe(true)
    expect(aRow?.still_valid).toBe(false)
    expect([...(aRow?.conflicts_with ?? [])].sort()).toEqual(["human-b"])
  })

  it("a duplicate-ID input still emits the correct authority view (winner is the oldest by timestamp)", () => {
    const older = mkDecision({ id: "dup", topic: "auth", decision: "Use JWT", timestamp: "2026-08-01T00:00:00Z", provenance: heuristicProv })
    const newer = mkDecision({ id: "dup", topic: "auth", decision: "Use JWT", timestamp: "2026-08-02T00:00:00Z", provenance: heuristicProv })
    const res = resolveDecisionAuthorities([older, newer])
    expect(res.authorities).toHaveLength(1)
    // Equivalent duplicate observations: oldest timestamp asc wins.
    expect(res.authorities[0]!.id).toBe("dup")
    const newerRow = res.decisions.find((d) => d.timestamp === "2026-08-02T00:00:00Z")
    expect(newerRow?.still_valid).toBe(false)
    expect(lineageOf(newerRow).superseded_by).toBe("dup")
  })
})

// ─── PR 3 wave-9 — defensive exact-ID duplicate refusal (Blocker 2) ──────────
// The oracle Block verdict's second blocker: mutation helpers used `.map()` /
// `.find()` semantics that could mint trust onto a different row sharing an ID.
// The shared decision-review helpers must refuse a duplicate-ID state outright.
// (decision-review.test.ts is outside the wave-9 touch scope, so these pin the
// helper contract here.)
describe("PR 3 wave-9 — decision-review duplicate-ID refusal", () => {
  function memWith(...decisions: Decision[]) {
    return { ...emptyMemory("/test"), decisions }
  }

  it("requestFoundationalReview refuses a duplicate-ID state", () => {
    const t1 = mkDecision({ id: "dup", topic: "auth", decision: "Use JWT", provenance: llmProv })
    const t2 = mkDecision({ id: "dup", topic: "auth", decision: "Use OAuth2", timestamp: "2026-08-02T00:00:00Z", provenance: llmProv })
    const mutation = requestFoundationalReview(memWith(t1, t2), { decision_id: "dup" })
    expect(mutation.kind).toBe("duplicate-id")
  })

  it("confirmFoundationalReview refuses a duplicate-ID state (no trust minted)", () => {
    const t1 = mkDecision({ id: "dup", topic: "auth", decision: "Use JWT", foundational_requested: true, provenance: llmProv })
    const t2 = mkDecision({ id: "dup", topic: "auth", decision: "Use OAuth2", foundational_requested: true, timestamp: "2026-08-02T00:00:00Z", provenance: llmProv })
    const mutation = confirmFoundationalReview(memWith(t1, t2), "dup", "2026-08-09T00:00:00.000Z")
    expect(mutation.kind).toBe("duplicate-id")
    // No human trust was minted onto any row.
    for (const d of mutation.kind === "duplicate-id" ? [t1, t2] : []) {
      expect(d.foundational).toBe(false)
      expect((d as { human_review?: unknown }).human_review).toBeUndefined()
    }
  })

  it("supersedeHumanAuthority rejects duplicate authority and candidate IDs", () => {
    const authority = mkDecision({
      id: "authority-1", topic: "auth", decision: "Use JWT",
      foundational: true,
      human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
      provenance: humanProv,
    })
    const authorityDup = mkDecision({
      id: "authority-1", topic: "auth", decision: "Use JWT",
      foundational: true,
      human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
      provenance: humanProv,
    })
    const candidate = mkDecision({ id: "candidate-1", topic: "auth", decision: "Use OAuth2", still_valid: false, conflicts_with: ["authority-1"], provenance: llmProv })

    const dupAuthority = supersedeHumanAuthority(memWith(authority, authorityDup, candidate), {
      authorityId: "authority-1", candidateId: "candidate-1", reviewedAt: "2026-08-09T00:00:00.000Z",
    })
    expect(dupAuthority.kind).toBe("duplicate-id")

    const candidateDup = mkDecision({ id: "candidate-1", topic: "auth", decision: "Use OAuth2", still_valid: false, conflicts_with: ["authority-1"], provenance: llmProv })
    const dupCandidate = supersedeHumanAuthority(memWith(authority, candidate, candidateDup), {
      authorityId: "authority-1", candidateId: "candidate-1", reviewedAt: "2026-08-09T00:00:00.000Z",
    })
    expect(dupCandidate.kind).toBe("duplicate-id")
  })

  it("supersedeHumanAuthority refuses a same-topic, linked but STILL-VALID candidate (Concern C)", () => {
    const authority = mkDecision({
      id: "authority-1", topic: "auth", decision: "Use JWT",
      foundational: true,
      human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
      provenance: humanProv,
    })
    const candidate = mkDecision({
      id: "candidate-1", topic: "auth", decision: "Use OAuth2",
      still_valid: true, conflicts_with: ["authority-1"], provenance: llmProv,
    })
    const mutation = supersedeHumanAuthority(memWith(authority, candidate), {
      authorityId: "authority-1", candidateId: "candidate-1", reviewedAt: "2026-08-09T00:00:00.000Z",
    })
    // The plan requires the candidate to be still_valid === false; a valid
    // linked row is not a supersession candidate.
    expect(mutation.kind).toBe("not-linked")
  })
})
