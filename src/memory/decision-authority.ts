/**
 * PR 3 §6 — decision authority.
 *
 * Centralizes every rule that answers "which decision is authoritative?" for a
 * normalized topic. Pure functions only: the same input always produces the
 * same output, and input arrays are never mutated — callers always receive
 * copies. Read-only tools can therefore use the `authorities`/`conflicts` view
 * immediately without rewriting STATE.
 */
import type { Decision } from "./schema"

export type DecisionAuthorityConflict = {
  normalized_topic: string
  decision_ids: string[]
  kind: "conflicting-human-foundational"
}

export type DecisionAuthorityResolution = {
  decisions: Decision[]
  authorities: Decision[]
  conflicts: DecisionAuthorityConflict[]
}

/** Deterministic, locale-independent normalization (plan §6). */
function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ")
}

export function normalizeDecisionTopic(topic: string): string {
  return normalize(topic)
}

export function normalizeDecisionText(decision: string): string {
  return normalize(decision)
}

/**
 * A decision is a trusted human foundational authority only when ALL of the
 * documented conditions hold (plan §6.1). This helper, not a loose check of
 * `foundational`, is the automation-veto boundary.
 */
export function isTrustedHumanFoundational(decision: Decision): boolean {
  return (
    decision.still_valid === true &&
    decision.foundational === true &&
    decision.provenance?.extractor === "human" &&
    decision.provenance?.confidence === "human-reviewed" &&
    decision.human_review?.channel === "interactive-cli"
  )
}

/**
 * Trust rank used for tie-breaks and provenance reconciliation.
 * `human-reviewed` sits on top of the documented ladder for completeness; the
 * non-human conflict path only ever sees ranks 1-3.
 */
const TRUST_RANK: Readonly<Record<string, number>> = {
  "human-reviewed": 4,
  "llm-corroborated": 3,
  heuristic: 2,
  legacy: 1,
}

function trustRank(confidence: string | undefined): number {
  if (confidence === undefined) return 1
  return TRUST_RANK[confidence] ?? 1
}

/** Per-object clone so the returned read view never aliases the input. */
function cloneDecision(decision: Decision): Decision {
  const clone: Decision = { ...decision }
  if (decision.provenance) {
    clone.provenance = {
      ...decision.provenance,
      evidence: [...decision.provenance.evidence],
    }
  }
  if (decision.human_review) clone.human_review = { ...decision.human_review }
  if (decision.conflicts_with) clone.conflicts_with = [...decision.conflicts_with]
  return clone
}

/** Deterministic oldest-first timestamp comparison with a lexical fallback. */
function compareTimestamp(a: Decision, b: Decision): number {
  const ta = Date.parse(a.timestamp)
  const tb = Date.parse(b.timestamp)
  const aOk = Number.isFinite(ta)
  const bOk = Number.isFinite(tb)
  if (aOk && bOk) return ta - tb
  if (aOk) return -1
  if (bOk) return 1
  return a.timestamp.localeCompare(b.timestamp)
}

/** Oldest timestamp asc, then lexical ID asc (duplicate-observation winner). */
function oldestFirst(a: Decision, b: Decision): number {
  const byTime = compareTimestamp(a, b)
  if (byTime !== 0) return byTime
  return a.id.localeCompare(b.id)
}

/**
 * Newest timestamp first; trust rank desc as tie-breaker
 * (`llm-corroborated > heuristic > legacy`); lexical ID asc as final
 * tie-breaker (conflicting non-human authority selection, plan §6.2).
 */
function newestFirst(a: Decision, b: Decision): number {
  const byTime = compareTimestamp(a, b)
  if (byTime !== 0) return -byTime
  const byRank = trustRank(a.provenance?.confidence) - trustRank(b.provenance?.confidence)
  if (byRank !== 0) return -byRank
  return a.id.localeCompare(b.id)
}

/**
 * All valid rows in the topic share one normalized decision text: they are
 * duplicate observations, not competing authorities. A trusted human row wins
 * if present; otherwise preserve the oldest semantic authority ID (timestamp
 * asc, then lexical ID). Copy the strongest trustworthy provenance/rationale
 * onto the winner and mark every other row historical.
 */
function resolveEquivalentTexts(
  group: Decision[],
  trustedHumans: Decision[],
  authorities: Decision[],
): void {
  const winner = (trustedHumans.length > 0 ? trustedHumans : group).slice().sort(oldestFirst)[0]!

  // Strongest provenance/rationale source: highest trust rank, oldest first on
  // ties for determinism.
  const strongest = group
    .slice()
    .sort((a, b) => {
      const byRank = trustRank(b.provenance?.confidence) - trustRank(a.provenance?.confidence)
      if (byRank !== 0) return byRank
      return oldestFirst(a, b)
    })[0]!

  if (strongest.provenance) {
    winner.provenance = {
      ...strongest.provenance,
      evidence: [...strongest.provenance.evidence],
    }
  }
  if (winner.rationale === undefined && strongest.rationale !== undefined) {
    winner.rationale = strongest.rationale
  }

  for (const row of group) {
    if (row.id === winner.id) continue
    row.still_valid = false
    row.superseded_by = winner.id
  }

  authorities.push(winner)
}

/**
 * Exactly one trusted human foundational row plus conflicting non-human rows:
 * the human row stays the authority. Competing rows become invalid conflict
 * candidates linked to the human authority. `superseded_by` is deliberately
 * NOT set because the human authority did not adopt those competing values.
 */
function resolveHumanVsConflicts(group: Decision[], human: Decision, authorities: Decision[]): void {
  for (const row of group) {
    if (row.id === human.id) continue
    row.still_valid = false
    row.foundational = false
    row.conflicts_with = [human.id]
  }
  authorities.push(human)
}

/**
 * Multiple conflicting trusted human foundational rows: never pick one
 * automatically. This is conflict quarantine, not supersession. All rows in the
 * topic become non-authoritative, human rows keep their foundational/review
 * metadata, reciprocal bounded `conflicts_with` IDs are added, and one
 * `conflicting-human-foundational` record is emitted for readers/CLI.
 */
function resolveConflictingHumans(
  topic: string,
  group: Decision[],
  trustedHumans: Decision[],
  conflicts: DecisionAuthorityConflict[],
): void {
  const humanIds = trustedHumans.map((h) => h.id).sort()

  for (const human of trustedHumans) {
    human.still_valid = false
    human.conflicts_with = humanIds.filter((id) => id !== human.id)
  }

  for (const row of group) {
    if (trustedHumans.includes(row)) continue
    row.still_valid = false
    row.foundational = false
    row.conflicts_with = [...humanIds]
  }

  conflicts.push({
    normalized_topic: topic,
    decision_ids: humanIds,
    kind: "conflicting-human-foundational",
  })
}

/**
 * Conflicting non-human rows (legacy/broken duplicate-valid state): choose one
 * deterministic authority — newest timestamp first, trust rank desc, then
 * lexical ID — and mark the other rows historical via `superseded_by`.
 */
function resolveConflictingNonHumans(group: Decision[], authorities: Decision[]): void {
  const selected = group.slice().sort(newestFirst)[0]!
  for (const row of group) {
    if (row.id === selected.id) continue
    row.still_valid = false
    row.superseded_by = selected.id
  }
  authorities.push(selected)
}

/**
 * Resolve which decisions are authoritative per normalized topic (plan §6.2).
 *
 * Pure: the input is never mutated and the same input always yields the same
 * output. The returned `decisions` array contains copies of every input
 * decision, with reconciled `still_valid`/`conflicts_with`/`superseded_by`
 * state applied for the read view.
 */
export function resolveDecisionAuthorities(
  decisions: readonly Decision[],
): DecisionAuthorityResolution {
  const all = decisions.map(cloneDecision)
  const authorities: Decision[] = []
  const conflicts: DecisionAuthorityConflict[] = []

  // Group valid rows by normalized topic, preserving first-seen order.
  const topicGroups = new Map<string, Decision[]>()
  for (const decision of all) {
    if (decision.still_valid !== true) continue
    const key = normalizeDecisionTopic(decision.topic)
    let group = topicGroups.get(key)
    if (!group) {
      group = []
      topicGroups.set(key, group)
    }
    group.push(decision)
  }

  for (const [topic, group] of topicGroups) {
    // One valid row -> that row is the authority.
    if (group.length === 1) {
      authorities.push(group[0]!)
      continue
    }

    const trustedHumans = group.filter(isTrustedHumanFoundational)

    const texts = new Set(group.map((d) => normalizeDecisionText(d.decision)))
    if (texts.size === 1) {
      resolveEquivalentTexts(group, trustedHumans, authorities)
    } else if (trustedHumans.length === 1) {
      resolveHumanVsConflicts(group, trustedHumans[0]!, authorities)
    } else if (trustedHumans.length > 1) {
      resolveConflictingHumans(topic, group, trustedHumans, conflicts)
    } else {
      resolveConflictingNonHumans(group, authorities)
    }
  }

  return { decisions: all, authorities, conflicts }
}
