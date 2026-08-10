/**
 * PR 3 §7 — decision merging.
 *
 * `mergeDecisions()` is the decision-only half of the former `mergeMemory()`
 * decision block.  It reasons over the reconciled authority view produced by
 * `resolveDecisionAuthorities()` instead of a one-index topic map, and applies
 * the heuristic/LLM merge rules from implementation-plan §7.  Every incoming
 * item is judged against ALL same-topic rows of the current reconciled group,
 * so historical duplicate-valid state can never leave a stale authority beside
 * a new one.
 *
 * This module is pure: input arrays are never mutated and every modified row is
 * a fresh object (per-object spread).
 */
import type { Decision, Evidence, Provenance } from "./schema"
import type { EvidenceCandidateMap } from "./extract-llm"
import { resolveEvidenceReferences } from "./extract-llm"
import { sha256Hex, stableJson } from "./extract-prompt"
import {
  isTrustedHumanFoundational,
  normalizeDecisionText,
  normalizeDecisionTopic,
  resolveDecisionAuthorities,
  type DecisionAuthorityConflict,
} from "./decision-authority"
import { randomUUID } from "node:crypto"

/**
 * The incoming decision shape used by the extractor and by `mergeMemory`.
 * `evidence_refs` is the LLM structured-output contract; the legacy heuristic
 * facts type carries only topic/decision/rationale/foundational.
 */
export type ExtractedDecision = {
  topic: string
  decision: string
  rationale?: string
  foundational?: boolean
  evidence_refs?: string[]
  /** Legacy heuristic extractor signal; kept for compatibility. */
  foundational_requested?: unknown
}

/** Merge metadata consumed by decision merging (subset of the writer MergeMeta). */
export type DecisionMergeMeta = {
  sessionId: string
  gitSha?: string | null
  timestamp: string // ISO 8601
  origin?: "heuristic" | "llm"
  /**
   * LLM evidence gate. An LLM decision without resolved exact evidence never
   * enters decision merging.
   */
  evidenceCandidates?: EvidenceCandidateMap
  auditSessionID?: string
}

/** Matches the writer's evidence-search normalization (not NFKC; deterministic). */
function normalizedFact(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ")
}

function heuristicCandidateRef(kind: string, value: unknown): string {
  return `hc-${sha256Hex(stableJson({ kind, value })).slice(0, 16)}`
}

function evidenceDigestMap(
  candidates: EvidenceCandidateMap,
): Readonly<Record<string, string>> {
  const digests: Record<string, string> = {}
  for (const ref of Object.keys(candidates).sort()) {
    const digest = candidates[ref]?.digest
    if (digest) digests[ref] = digest
  }
  return digests
}

function candidateEvidence(
  refs: unknown,
  candidates: EvidenceCandidateMap,
): Evidence[] {
  return resolveEvidenceReferences(refs, {
    evidenceCandidateMap: candidates,
    evidenceDigestMap: evidenceDigestMap(candidates),
  }).evidence
}

/** LLM decision evidence gate: null when the claim has no resolved exact evidence. */
function llmEvidenceFor(
  refs: unknown,
  meta: DecisionMergeMeta,
): Evidence[] | null {
  if (!meta.evidenceCandidates) return null
  const evidence = candidateEvidence(refs, meta.evidenceCandidates)
  return evidence.length > 0 ? evidence : null
}

/** Heuristic decision evidence: deterministic candidate/transcript pointer. */
function heuristicEvidenceFor(
  value: { topic?: string; decision?: string },
  candidates: EvidenceCandidateMap | undefined,
): Evidence[] {
  if (!candidates) return []
  const needle = normalizedFact(value.decision ?? value.topic ?? "")
  const transcript = Object.values(candidates).find((candidate) => (
    candidate.kind === "transcript" &&
    typeof candidate.text === "string" &&
    normalizedFact(candidate.text).includes(needle)
  ))
  if (transcript) {
    return [{ kind: transcript.kind, ref: transcript.ref, digest: transcript.digest }]
  }
  const ref = heuristicCandidateRef("decision", {
    topic: value.topic,
    decision: value.decision,
  })
  const candidate = candidates[ref]
  return candidate
    ? [{ kind: candidate.kind, ref: candidate.ref, digest: candidate.digest }]
    : []
}

function makeProvenance(meta: DecisionMergeMeta, evidence: Evidence[]): Provenance {
  const llm = meta.origin === "llm"
  return {
    extractor: llm ? "llm" : "heuristic",
    source_session_id: meta.sessionId,
    ...(llm && meta.auditSessionID
      ? { source_audit_session_id: meta.auditSessionID }
      : {}),
    confidence: llm ? "llm-corroborated" : "heuristic",
    evidence: evidence.slice(0, 3),
  }
}

/**
 * PR 3 §7.3 — neither heuristic nor LLM extraction may set `foundational=true`
 * or human provenance. An extraction `foundational` signal maps ONLY to
 * `foundational_requested` (a review request, not a promotion).
 */
function incomingFoundationalRequested(
  inc: ExtractedDecision,
  meta: DecisionMergeMeta,
): boolean {
  return meta.origin === "llm"
    ? Boolean(inc.foundational)
    : Boolean(inc.foundational) || Boolean(inc.foundational_requested)
}

function newDecisionRow(
  inc: ExtractedDecision,
  meta: DecisionMergeMeta,
  provenance: Provenance,
  overrides: Partial<Decision> = {},
): Decision {
  return {
    id: randomUUID(),
    topic: inc.topic,
    decision: inc.decision,
    rationale: inc.rationale,
    timestamp: meta.timestamp,
    git_sha: meta.gitSha ?? undefined,
    session_id: meta.sessionId,
    still_valid: true,
    foundational: false,
    foundational_requested: incomingFoundationalRequested(inc, meta),
    provenance,
    ...overrides,
  }
}

/** A row with only legacy provenance has no evidence contract (plan §7.2). */
function isLegacyOnlyAuthority(authority: Decision): boolean {
  const provenance = authority.provenance
  return (
    provenance === undefined ||
    provenance.extractor === "legacy" ||
    provenance.confidence === "legacy"
  )
}

/**
 * Merge incoming extracted decisions into the existing decision list.
 *
 * Rules are documented in implementation-plan §7.1 (heuristic) and §7.2 (LLM).
 * The returned array is the post-merge state: existing reconciled historical
 * rows are kept, one or more new rows are added, and existing authorities may
 * be upgraded in place (same stable ID, updated provenance/rationale).
 */
export function mergeDecisions(
  existing: readonly Decision[],
  incoming: readonly ExtractedDecision[],
  meta: DecisionMergeMeta,
): Decision[] {
  const origin = meta.origin ?? "heuristic"

  // Start from the reconciled read view: existing rows carry repaired
  // still_valid/conflicts_with/superseded_by state for their topic group.
  let result: Decision[] = resolveDecisionAuthorities(existing).decisions.map((d) => ({ ...d }))

  for (const inc of incoming) {
    // Re-resolve against the current group so later incoming items for the
    // same topic judge the newest authority, never a stale mapped index.
    const resolved = resolveDecisionAuthorities(result)
    const authoritiesByTopic = new Map<string, Decision>()
    for (const authority of resolved.authorities) {
      authoritiesByTopic.set(normalizeDecisionTopic(authority.topic), authority)
    }
    const conflictsByTopic = new Map<string, DecisionAuthorityConflict>()
    for (const conflict of resolved.conflicts) {
      conflictsByTopic.set(conflict.normalized_topic, conflict)
    }

    const incTopic = normalizeDecisionTopic(inc.topic)
    const authority = authoritiesByTopic.get(incTopic)
    const conflict = conflictsByTopic.get(incTopic)

    const incEvidence = origin === "llm"
      ? llmEvidenceFor(inc.evidence_refs, meta)
      : heuristicEvidenceFor({ topic: inc.topic, decision: inc.decision }, meta.evidenceCandidates)

    // Mandatory evidence gate: an LLM decision without resolved exact evidence
    // does not enter decision merging.
    if (origin === "llm" && !incEvidence) continue

    const provenance = makeProvenance(meta, incEvidence ?? [])

    // Unresolved conflicting-human-foundational state: extraction must not
    // resolve it. The observation becomes another invalid conflict candidate
    // linked to the quarantined human IDs.
    if (conflict) {
      result = [
        ...result,
        newDecisionRow(inc, meta, provenance, {
          still_valid: false,
          conflicts_with: [...conflict.decision_ids],
        }),
      ]
      continue
    }

    if (!authority) {
      // No authority / new topic: a heuristic observation may create one valid
      // authority; an evidence-backed LLM observation may too.
      result = [...result, newDecisionRow(inc, meta, provenance)]
      continue
    }

    const authorityIsHuman = isTrustedHumanFoundational(authority)
    const sameText = normalizeDecisionText(inc.decision) === normalizeDecisionText(authority.decision)

    if (sameText) {
      if (authorityIsHuman) {
        // Equivalent to trusted human foundational authority: keep unchanged.
        // No provenance downgrade, no duplicate.
        continue
      }

      // Equivalent to the current non-human authority.
      const index = result.findIndex((row) => row.id === authority.id)
      if (index === -1) continue
      const row = result[index]!
      const updated: Decision = { ...row }
      if (updated.rationale === undefined && inc.rationale !== undefined) {
        updated.rationale = inc.rationale
      }
      if (incomingFoundationalRequested(inc, meta)) {
        updated.foundational_requested = true
      }
      if (origin === "llm") {
        // Corroborate IN PLACE: keep the stable decision ID, the semantic
        // decision text, and the authority creation timestamp; upgrade
        // provenance to the evidence-backed LLM provenance.
        updated.provenance = provenance
      }
      const next = [...result]
      next[index] = updated
      result = next
      continue
    }

    // Conflict path.
    if (authorityIsHuman) {
      // Automation may not replace the trusted human authority. The incoming
      // claim becomes an invalid candidate/history row (still_valid=false,
      // conflicts_with=[humanAuthority.id]) available to the human CLI.
      result = [
        ...result,
        newDecisionRow(inc, meta, provenance, {
          still_valid: false,
          conflicts_with: [authority.id],
        }),
      ]
      continue
    }

    if (origin === "heuristic") {
      // A later heuristic observation can represent a real user decision
      // change: create one new valid heuristic authority and supersede ALL
      // prior valid same-topic non-human authority rows (not one mapped index).
      const newId = randomUUID()
      const superseded = result.map((row) => {
        if (normalizeDecisionTopic(row.topic) !== incTopic) return row
        if (isTrustedHumanFoundational(row)) return row
        return { ...row, still_valid: false, superseded_by: newId }
      })
      result = [
        ...superseded,
        newDecisionRow(inc, meta, provenance, { id: newId }),
      ]
      continue
    }

    // origin === "llm"
    if (isLegacyOnlyAuthority(authority)) {
      // An evidence-backed LLM observation may supersede a legacy-only
      // authority (strictly stronger trust ladder); persist lineage.
      const newId = randomUUID()
      const superseded = result.map((row) => {
        if (normalizeDecisionTopic(row.topic) !== incTopic) return row
        if (isTrustedHumanFoundational(row)) return row
        return { ...row, still_valid: false, superseded_by: newId }
      })
      result = [
        ...superseded,
        newDecisionRow(inc, meta, provenance, { id: newId }),
      ]
      continue
    }

    // LLM conflict with heuristic/LLM/trusted-human authority: do NOT displace
    // the current authority; append an invalid evidence-backed candidate.
    result = [
      ...result,
      newDecisionRow(inc, meta, provenance, {
        still_valid: false,
        conflicts_with: [authority.id],
      }),
    ]
  }

  return result
}
