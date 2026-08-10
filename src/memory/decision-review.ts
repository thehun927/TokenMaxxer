/**
 * PR 3 §10 — shared decision-review mutation helpers.
 *
 * Pure synchronous helpers: no I/O. Callers wrap them in `mutateMemory()` so
 * the PR 2 invariant holds — no network or interactive work under the
 * filesystem lock. Each helper returns a `DecisionReviewMutation` with a
 * `.kind` discriminant so callers (the human CLI and the model tool) use one
 * eligibility definition.
 *
 * The `DecisionReviewMutation` union is a superset of the plan's draft kinds.
 * The Wave 1A test spec (`test/memory/decision-review.test.ts`) is
 * authoritative for the confirmation/supersession discriminants (`confirmed`,
 * `not-requested`, `superseded`, `not-authority`, `not-linked`), which the
 * tests require to branch on; the plan's `requested`/`not-authoritative`/
 * `conflict` kinds are retained for the request path.
 */
import { randomUUID } from "node:crypto"
import type { MemoryFile, Decision, Provenance } from "./schema"
import { getExactDecisionById } from "./reader"
import {
  resolveDecisionAuthorities,
  isTrustedHumanFoundational,
  normalizeDecisionTopic,
} from "./decision-authority"

/**
 * Human-reviewed provenance preserving the underlying source session, audit
 * ID, and evidence references (PR 3 §11.2). The source fallback is bounded and
 * only reachable when a target decision somehow lacks provenance entirely.
 */
function toHumanReviewedProvenance(provenance: Provenance | undefined): Provenance {
  return {
    extractor: "human",
    source_session_id: provenance?.source_session_id ?? "human-review",
    ...(provenance?.source_audit_session_id !== undefined
      ? { source_audit_session_id: provenance.source_audit_session_id }
      : {}),
    confidence: "human-reviewed",
    evidence: [...(provenance?.evidence ?? [])],
  }
}

/**
 * Legacy downgrade applied when a trusted human authority is superseded: the
 * row keeps its source/audit/evidence references but no longer carries a human
 * trust claim (schema §4.1 rejects a human claim without foundational=true).
 */
function toLegacyProvenance(provenance: Provenance | undefined): Provenance {
  return {
    extractor: "legacy",
    source_session_id: provenance?.source_session_id ?? "legacy",
    ...(provenance?.source_audit_session_id !== undefined
      ? { source_audit_session_id: provenance.source_audit_session_id }
      : {}),
    confidence: "legacy",
    evidence: [...(provenance?.evidence ?? [])],
  }
}

export type DecisionSelector =
  | { decision_id: string }
  | { topic: string }

export type DecisionReviewMutation =
  | { kind: "requested"; memory: MemoryFile; targetId: string }
  | { kind: "already-reviewed"; memory: MemoryFile; targetId: string }
  | { kind: "not-found"; targetId: string }
  | {
      kind: "not-authoritative"
      targetId: string
      reason: "duplicate-history" | "not-current-authority"
    }
  | { kind: "conflict"; targetId: string; conflictingIds: string[] }
  | { kind: "ambiguous"; topic: string; candidateIds: string[] }
  | { kind: "duplicate-id"; targetId: string; ids: string[] }
  // Wave 1A test-spec discriminants (test/memory/decision-review.test.ts).
  | { kind: "confirmed"; memory: MemoryFile; targetId: string }
  | { kind: "not-requested"; targetId: string }
  | { kind: "superseded"; memory: MemoryFile; targetId: string; newAuthorityId: string }
  | { kind: "not-authority"; targetId: string }
  | { kind: "not-linked"; targetId: string }

/**
 * Request foundational review for a decision by exact stable ID (preferred) or
 * exact normalized topic (one-release compatibility). The ONLY mutation is
 * `foundational_requested = true`; it never touches `foundational`, provenance,
 * or `human_review` (PR 3 §9.1).
 */
export function requestFoundationalReview(
  memory: MemoryFile,
  selector: DecisionSelector,
): DecisionReviewMutation {
  if ("decision_id" in selector) {
    return requestByExactId(memory, selector.decision_id)
  }
  return requestByTopic(memory, selector.topic)
}

function requestByExactId(memory: MemoryFile, targetId: string): DecisionReviewMutation {
  const lookup = getExactDecisionById(memory, targetId)
  if (lookup.kind === "missing") return { kind: "not-found", targetId }
  if (lookup.kind === "duplicate") {
    return { kind: "duplicate-id", targetId, ids: lookup.ids }
  }
  const raw = lookup.decision

  const resolved = resolveDecisionAuthorities(memory.decisions)
  const resolvedTarget = resolved.decisions.find((d) => d.id === targetId)
  if (!resolvedTarget) return { kind: "not-found", targetId }

  const normalizedTopic = normalizeDecisionTopic(raw.topic)

  // Conflict quarantine takes precedence: in a conflicting-human-foundational
  // topic no row is a valid authority (the resolved view marks them all
  // still_valid=false), so the target is inside the conflict and must not be
  // reported as already-reviewed or eligible for request.
  const topicConflict = resolved.conflicts.find(
    (c) => c.normalized_topic === normalizedTopic,
  )
  if (topicConflict) {
    return {
      kind: "conflict",
      targetId,
      conflictingIds: topicConflict.decision_ids,
    }
  }

  if (isTrustedHumanFoundational(resolvedTarget)) {
    return { kind: "already-reviewed", memory, targetId }
  }

  const isAuthority = resolved.authorities.some((a) => a.id === targetId)
  if (!isAuthority) {
    const reason = resolvedTarget.superseded_by !== undefined
      ? "duplicate-history"
      : "not-current-authority"
    return { kind: "not-authoritative", targetId, reason }
  }

  // PR 3 §9.1: the ONLY mutation is foundational_requested = true.
  const decisions = memory.decisions.map((d) =>
    d.id === targetId ? { ...d, foundational_requested: true } : d,
  )
  return { kind: "requested", memory: { ...memory, decisions }, targetId }
}

function requestByTopic(memory: MemoryFile, topic: string): DecisionReviewMutation {
  const normalizedTopic = normalizeDecisionTopic(topic)
  const resolved = resolveDecisionAuthorities(memory.decisions)

  // An unresolved human-foundational conflict is ambiguous even when no
  // automatic authority is selected for the topic.
  const topicConflict = resolved.conflicts.find(
    (c) => c.normalized_topic === normalizedTopic,
  )
  if (topicConflict) {
    return { kind: "ambiguous", topic, candidateIds: validRawIds(memory, normalizedTopic) }
  }

  // PR 3 §9.2 compatibility path: succeeds only for ONE unambiguous exact
  // normalized authority. Count RAW still_valid rows, not the resolved
  // authority view, so two conflicting raw-valid rows are refused as ambiguous
  // even though resolution picks one authority (matches Wave 5 recall.ts).
  const rawValid = memory.decisions.filter(
    (d) => d.still_valid === true && normalizeDecisionTopic(d.topic) === normalizedTopic,
  )
  if (rawValid.length === 0) {
    return { kind: "not-found", targetId: topic }
  }
  if (rawValid.length > 1) {
    return { kind: "ambiguous", topic, candidateIds: rawValid.map((d) => d.id) }
  }

  const target = rawValid[0]!
  const authority = resolved.authorities.find((a) => a.id === target.id)
  if (!authority) {
    return {
      kind: "not-authoritative",
      targetId: target.id,
      reason: "not-current-authority",
    }
  }

  // Exactly one unambiguous authority: delegate to the exact-ID path.
  return requestByExactId(memory, target.id)
}

function validRawIds(memory: MemoryFile, normalizedTopic: string): string[] {
  return memory.decisions
    .filter(
      (d) =>
        d.still_valid === true && normalizeDecisionTopic(d.topic) === normalizedTopic,
    )
    .map((d) => d.id)
}

/**
 * Confirm a prior `foundational_requested` review for one exact decision ID.
 *
 * The human confirmation boundary sets `foundational=true`, clears the request,
 * records `human_review`, and upgrades extractor/confidence to human-reviewed —
 * while PRESERVING the underlying source session, audit ID, and evidence
 * references (PR 3 §11.2): the human is reviewing that source-backed decision,
 * not inventing new source evidence.
 */
export function confirmFoundationalReview(
  memory: MemoryFile,
  decisionId: string,
  reviewedAt: string,
): DecisionReviewMutation {
  const lookup = getExactDecisionById(memory, decisionId)
  if (lookup.kind === "missing") return { kind: "not-found", targetId: decisionId }
  if (lookup.kind === "duplicate") {
    // Wave-9 (Blocker 2): one confirmation token must never upgrade two rows.
    // Refuse the ambiguous state even though the schema repair normally
    // prevents duplicate IDs from reaching disk.
    return { kind: "duplicate-id", targetId: decisionId, ids: lookup.ids }
  }
  const target = lookup.decision

  if (isTrustedHumanFoundational(target)) {
    return { kind: "already-reviewed", memory, targetId: decisionId }
  }

  if (target.foundational_requested !== true) {
    return { kind: "not-requested", targetId: decisionId }
  }

  const decisions = memory.decisions.map((d) => {
    if (d.id !== decisionId) return d
    return {
      ...d,
      foundational: true,
      foundational_requested: false,
      human_review: {
        channel: "interactive-cli" as const,
        reviewed_at: reviewedAt,
      },
      provenance: toHumanReviewedProvenance(d.provenance),
    }
  })

  return {
    kind: "confirmed",
    memory: { ...memory, decisions },
    targetId: decisionId,
  }
}

/**
 * Explicit human supersession (PR 3 §11.4).
 *
 * Only a trusted human foundational authority may be replaced, and only by a
 * same-topic invalid conflict candidate that is linked to it via
 * `conflicts_with`. The old authority is invalidated and un-foundationalized,
 * the candidate stays historical, and a NEW human-reviewed valid authority is
 * created with a fresh stable UUID so ordinary invalid decisions are never
 * promoted in place and the audit trail is explicit
 * (`derived_from_decision_id = candidateId`).
 */
export function supersedeHumanAuthority(
  memory: MemoryFile,
  args: { authorityId: string; candidateId: string; reviewedAt: string },
): DecisionReviewMutation {
  const { authorityId, candidateId, reviewedAt } = args

  const authorityLookup = getExactDecisionById(memory, authorityId)
  if (authorityLookup.kind === "missing") return { kind: "not-found", targetId: authorityId }
  if (authorityLookup.kind === "duplicate") {
    return { kind: "duplicate-id", targetId: authorityId, ids: authorityLookup.ids }
  }
  const authority = authorityLookup.decision

  if (!isTrustedHumanFoundational(authority)) {
    return { kind: "not-authority", targetId: authorityId }
  }

  const candidateLookup = getExactDecisionById(memory, candidateId)
  if (candidateLookup.kind === "missing") return { kind: "not-found", targetId: candidateId }
  if (candidateLookup.kind === "duplicate") {
    return { kind: "duplicate-id", targetId: candidateId, ids: candidateLookup.ids }
  }
  const candidate = candidateLookup.decision

  // Wave-9 (Concern C): the plan requires the candidate to be an INVALID
  // same-topic conflict candidate. A still-valid row is never a supersession
  // candidate even when it is linked to the authority.
  if (candidate.still_valid !== false) {
    return { kind: "not-linked", targetId: candidateId }
  }

  const sameTopic =
    normalizeDecisionTopic(candidate.topic) === normalizeDecisionTopic(authority.topic)
  const linked = candidate.conflicts_with?.includes(authorityId) === true
  if (!sameTopic || !linked) {
    return { kind: "not-linked", targetId: candidateId }
  }

  const newAuthorityId = randomUUID()
  const newDecision: Decision = {
    id: newAuthorityId,
    topic: candidate.topic,
    decision: candidate.decision,
    rationale: candidate.rationale,
    timestamp: candidate.timestamp,
    git_sha: candidate.git_sha,
    session_id: candidate.session_id,
    last_used_in_session: candidate.last_used_in_session,
    still_valid: true,
    foundational: true,
    foundational_requested: false,
    human_review: {
      channel: "interactive-cli" as const,
      reviewed_at: reviewedAt,
    },
    derived_from_decision_id: candidateId,
    provenance: toHumanReviewedProvenance(candidate.provenance),
  }

  const decisions = memory.decisions.map((d) => {
    if (d.id === authorityId) {
      // The old authority is un-foundationalized, so its human trust claim
      // must also be downgraded (schema §4.1 rejects a human claim without
      // foundational=true). Provenance source/audit/evidence stay preserved.
      return {
        ...d,
        still_valid: false,
        foundational: false,
        superseded_by: newAuthorityId,
        human_review: undefined,
        provenance: toLegacyProvenance(d.provenance),
      }
    }
    if (d.id === candidateId) {
      return { ...d, superseded_by: newAuthorityId }
    }
    return d
  })

  return {
    kind: "superseded",
    memory: { ...memory, decisions: [...decisions, newDecision] },
    targetId: authorityId,
    newAuthorityId,
  }
}
