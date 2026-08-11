/**
 * PR 3 §10 decision-review mutation helper tests (implementation-plan §15
 * items A-G).
 *
 * These are Wave 1 failing regression fixtures. They target the planned
 * `src/memory/decision-review.ts` module, which does not exist yet on main.
 * The import below therefore fails to resolve until Wave 6 lands — that is the
 * intended Wave 1 outcome.
 */
import { describe, it, expect } from "vitest"
import {
  requestFoundationalReview,
  confirmFoundationalReview,
  supersedeHumanAuthority,
  type DecisionSelector,
  type DecisionReviewMutation,
} from "../../src/memory/decision-review"
import type { Decision } from "../../src/memory/schema"
import { emptyMemory } from "../../src/memory/schema"
import type { MemoryFile } from "../../src/memory/schema"

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
  evidence: [{ kind: "transcript" as const, ref: "tr-1", digest: "a".repeat(64) }],
}
const humanProv = {
  extractor: "human" as const,
  source_session_id: "s-human",
  confidence: "human-reviewed" as const,
  evidence: [] as never[],
}

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

function memWith(...decisions: Decision[]): MemoryFile {
  return { ...emptyMemory("/test"), decisions }
}

function humanAuthority(id: string, topic = "auth", decision = "Use JWT"): Decision {
  return mkDecision({
    id,
    topic,
    decision,
    foundational: true,
    foundational_requested: false,
    human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
    provenance: humanProv,
  })
}

// ─── A. requestFoundationalReview sets only foundational_requested ─────────

describe("requestFoundationalReview", () => {
  it("A. sets only foundational_requested=true and leaves trust fields unchanged", () => {
    const target = mkDecision({
      id: "llm-1",
      topic: "auth",
      decision: "Use JWT",
      foundational: false,
      foundational_requested: false,
      provenance: llmProv,
    })
    const mem = memWith(target)
    const mutation = requestFoundationalReview(mem, { decision_id: "llm-1" })
    expect(mutation.kind).toBe("requested")
    if (mutation.kind !== "requested") return
    const updated = mutation.memory.decisions.find((d) => d.id === "llm-1")!
    expect(updated.foundational_requested).toBe(true)
    expect(updated.foundational).toBe(false)
    expect(updated.provenance?.extractor).toBe("llm")
    expect(updated.provenance?.confidence).toBe("llm-corroborated")
    expect((updated as { human_review?: unknown }).human_review).toBeUndefined()
  })

  it("B. rejects by exact ID", () => {
    const target = mkDecision({ id: "llm-1", topic: "auth", decision: "Use JWT", provenance: llmProv })
    const mem = memWith(target)

    // nonexistent ID
    expect(requestFoundationalReview(mem, { decision_id: "nope" }).kind).toBe("not-found")

    // existing-but-non-authoritative ID (duplicate-valid row that is not the authority)
    const duplicate = mkDecision({ id: "dup-2", topic: "auth", decision: "Use JWT", timestamp: "2026-08-02T00:00:00Z", provenance: llmProv })
    const dupMem = memWith(target, duplicate)
    expect(requestFoundationalReview(dupMem, { decision_id: "dup-2" }).kind).toBe("not-authoritative")

    // ID inside unresolved human-foundational conflict
    const conflictMem = memWith(
      humanAuthority("human-a"),
      humanAuthority("human-b", "auth", "Use OAuth2"),
    )
    expect(requestFoundationalReview(conflictMem, { decision_id: "human-a" }).kind).toBe("conflict")

    // already trusted human foundational target
    expect(requestFoundationalReview(memWith(humanAuthority("human-1")), { decision_id: "human-1" }).kind).toBe("already-reviewed")
  })

  it("C. honors temporary topic compatibility", () => {
    const target = mkDecision({ id: "auth-1", topic: "auth", decision: "Use JWT", provenance: llmProv })
    // exactly one authority for the normalized topic → success
    expect(requestFoundationalReview(memWith(target), { topic: "auth" }).kind).toBe("requested")

    // multiple authorities → conflict/ambiguous
    const other = mkDecision({ id: "auth-2", topic: "auth", decision: "Use OAuth2", timestamp: "2026-08-02T00:00:00Z", provenance: llmProv })
    const multi = requestFoundationalReview(memWith(target, other), { topic: "auth" })
    expect(["conflict", "ambiguous"]).toContain(multi.kind)

    // substring matching NOT used: "auth" does not match "authentication"
    const authn = mkDecision({ id: "authn-1", topic: "authentication", decision: "Use OAuth2", provenance: llmProv })
    expect(requestFoundationalReview(memWith(authn), { topic: "auth" }).kind).toBe("not-found")
  })
})

// ─── D. confirmFoundationalReview ───────────────────────────────────────────

describe("confirmFoundationalReview", () => {
  it("D. sets human provenance and foundational, preserving source/audit/evidence", () => {
    const target = mkDecision({
      id: "llm-1",
      topic: "auth",
      decision: "Use JWT",
      foundational: false,
      foundational_requested: true,
      provenance: {
        extractor: "llm",
        source_session_id: "source-llm",
        source_audit_session_id: "audit-llm",
        confidence: "llm-corroborated",
        evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
      },
    })
    const mem = memWith(target)
    const reviewedAt = "2026-08-09T00:00:00.000Z"
    const mutation = confirmFoundationalReview(mem, "llm-1", reviewedAt)
    expect(mutation.kind).toBe("confirmed")
    if (mutation.kind !== "confirmed") return
    const updated = mutation.memory.decisions.find((d) => d.id === "llm-1")!
    expect(updated.foundational).toBe(true)
    expect(updated.foundational_requested).toBe(false)
    expect(updated.human_review).toEqual({ channel: "interactive-cli", reviewed_at: reviewedAt })
    expect(updated.provenance?.extractor).toBe("human")
    expect(updated.provenance?.confidence).toBe("human-reviewed")
    // Preserve source session, audit ID, and evidence references.
    expect(updated.provenance?.source_session_id).toBe("source-llm")
    expect(updated.provenance?.source_audit_session_id).toBe("audit-llm")
    expect(updated.provenance?.evidence).toEqual([{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }])
  })

  it("E. rejects a target that was not review-requested", () => {
    const target = mkDecision({ id: "llm-1", topic: "auth", decision: "Use JWT", foundational_requested: false, provenance: llmProv })
    const mutation = confirmFoundationalReview(memWith(target), "llm-1", "2026-08-09T00:00:00.000Z")
    expect(mutation.kind).toBe("not-requested")
  })
})

// ─── F. supersedeHumanAuthority ─────────────────────────────────────────────

describe("supersedeHumanAuthority", () => {
  it("F. creates new human authority, invalidates old, links candidate", () => {
    const authority = humanAuthority("authority-1")
    const candidate = mkDecision({
      id: "candidate-1",
      topic: "auth",
      decision: "Use OAuth2",
      still_valid: false,
      foundational: false,
      provenance: llmProv,
      conflicts_with: ["authority-1"],
    })
    const mem = memWith(authority, candidate)
    const reviewedAt = "2026-08-09T00:00:00.000Z"
    const mutation = supersedeHumanAuthority(mem, { authorityId: "authority-1", candidateId: "candidate-1", reviewedAt })
    expect(mutation.kind).toBe("superseded")
    if (mutation.kind !== "superseded") return
    const newId = mutation.newAuthorityId
    expect(newId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

    const newRow = mutation.memory.decisions.find((d) => d.id === newId)!
    expect(newRow.topic).toBe("auth")
    expect(newRow.decision).toBe("Use OAuth2")
    expect(newRow.foundational).toBe(true)
    expect(newRow.foundational_requested).toBe(false)
    expect(newRow.human_review).toEqual({ channel: "interactive-cli", reviewed_at: reviewedAt })
    expect(newRow.provenance?.extractor).toBe("human")
    expect(newRow.provenance?.confidence).toBe("human-reviewed")
    expect((newRow as { derived_from_decision_id?: string }).derived_from_decision_id).toBe("candidate-1")

    const oldRow = mutation.memory.decisions.find((d) => d.id === "authority-1")!
    expect(oldRow.still_valid).toBe(false)
    expect(oldRow.foundational).toBe(false)
    expect((oldRow as { superseded_by?: string }).superseded_by).toBe(newId)

    const candRow = mutation.memory.decisions.find((d) => d.id === "candidate-1")!
    expect((candRow as { superseded_by?: string }).superseded_by).toBe(newId)

    // exactly one authority for the topic
    const authorities = mutation.memory.decisions.filter((d) => d.topic === "auth" && d.still_valid)
    expect(authorities).toHaveLength(1)
    expect(authorities[0]!.id).toBe(newId)
  })

  it("F. rejects when authorityId is not a trusted human foundational row", () => {
    const nonHuman = mkDecision({ id: "llm-1", topic: "auth", decision: "Use JWT", provenance: llmProv })
    const candidate = mkDecision({ id: "candidate-1", topic: "auth", decision: "Use OAuth2", still_valid: false, provenance: llmProv, conflicts_with: ["llm-1"] })
    const mutation = supersedeHumanAuthority(memWith(nonHuman, candidate), { authorityId: "llm-1", candidateId: "candidate-1", reviewedAt: "2026-08-09T00:00:00.000Z" })
    expect(mutation.kind).toBe("not-authority")
  })

  it("F. rejects when candidate is unrelated topic or not linked", () => {
    const authority = humanAuthority("authority-1")
    const unrelated = mkDecision({ id: "candidate-1", topic: "other", decision: "Use OAuth2", still_valid: false, provenance: llmProv, conflicts_with: ["authority-1"] })
    expect(supersedeHumanAuthority(memWith(authority, unrelated), { authorityId: "authority-1", candidateId: "candidate-1", reviewedAt: "2026-08-09T00:00:00.000Z" }).kind).toBe("not-linked")

    const unlinked = mkDecision({ id: "candidate-2", topic: "auth", decision: "Use OAuth2", still_valid: false, provenance: llmProv })
    expect(supersedeHumanAuthority(memWith(authority, unlinked), { authorityId: "authority-1", candidateId: "candidate-2", reviewedAt: "2026-08-09T00:00:00.000Z" }).kind).toBe("not-linked")
  })
})

// ─── G. All helpers preserve IDs of unrelated rows ──────────────────────────

describe("helpers preserve unrelated IDs", () => {
  it("G. confirmFoundationalReview leaves other decisions' IDs unchanged", () => {
    const target = mkDecision({ id: "llm-1", topic: "auth", decision: "Use JWT", foundational_requested: true, provenance: llmProv })
    const unrelated = mkDecision({ id: "other-1", topic: "db", decision: "Use Postgres", provenance: heuristicProv })
    const mem = memWith(target, unrelated)
    const mutation = confirmFoundationalReview(mem, "llm-1", "2026-08-09T00:00:00.000Z")
    if (mutation.kind !== "confirmed") return
    const ids = mutation.memory.decisions.map((d) => d.id).sort()
    expect(ids).toEqual(["llm-1", "other-1"])
    const otherRow = mutation.memory.decisions.find((d) => d.id === "other-1")!
    expect(otherRow.decision).toBe("Use Postgres")
    expect(otherRow.provenance?.extractor).toBe("heuristic")
  })

  it("G. supersedeHumanAuthority leaves other topics' decisions unchanged", () => {
    const authority = humanAuthority("authority-1")
    const candidate = mkDecision({ id: "candidate-1", topic: "auth", decision: "Use OAuth2", still_valid: false, provenance: llmProv, conflicts_with: ["authority-1"] })
    const otherTopic = mkDecision({ id: "db-1", topic: "db", decision: "Use Postgres", provenance: heuristicProv })
    const mem = memWith(authority, candidate, otherTopic)
    const mutation = supersedeHumanAuthority(mem, { authorityId: "authority-1", candidateId: "candidate-1", reviewedAt: "2026-08-09T00:00:00.000Z" })
    if (mutation.kind !== "superseded") return
    const dbRow = mutation.memory.decisions.find((d) => d.id === "db-1")!
    expect(dbRow.decision).toBe("Use Postgres")
    expect(dbRow.still_valid).toBe(true)
    expect(dbRow.provenance?.extractor).toBe("heuristic")
  })
})
