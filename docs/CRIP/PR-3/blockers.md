# PR 3 — Live Blocker Log

This file collects blockers and decisions encountered while implementing
`docs/CRIP/PR-3/implementation-plan.md` that are not in the plan itself but must
be surfaced before the oracle re-review. Append-only; each entry records
date, wave, scope, and a one-line resolution.

Format:

```
## YYYY-MM-DD — wave-N scope
- [type] short title — file:line — resolution
```

Types: `bug`, `design-decision`, `scope-deviation`, `test-gap`,
`portability`, `doc-clarification`.

---

## 2026-08-10 — wave-1B existing test extensions
- [test-gap] merge.test.ts extended with 8 failing-on-main tests (§7 merge semantics); expected green in Wave 4.
- [test-gap] prune.test.ts extended with 5 failing-on-main tests (§13 foundational protection); expected green in Wave 7.
- [test-gap] migrate.test.ts extended with 1 failing-on-main test (§5 compatibility repair); expected green in Wave 2.
- [test-gap] recall.test.ts extended with 10 failing-on-main tests (§8 authority-aware reads + §9 review-request tool); expected green in Wave 5.
- [scope-deviation] Tests 22-28 reference _recallPromote({decision_id}) API; current API uses {topic}; the test file will need adapter shim during Wave 1B and the API change ships in Wave 5.
- [scope-deviation] Test 45 references commitMemoryExact; ensure Wave 1B does not import implementation details that don't exist yet.

## 2026-08-10 — wave-1A new test files
- [test-gap] decision-authority.test.ts created with 10 failing-on-main tests; expected green in Wave 3 (decision-authority.ts) + Wave 2 (schema + repair).
- [test-gap] decision-review.test.ts created with 7 failing-on-main tests; expected green in Wave 6 (decision-review.ts).
- [test-gap] cli.test.ts created with 12 failing-on-main tests; expected green in Wave 6 (src/cli.ts).
- [scope-deviation] tests 9 (pre-PR3 repair) and 10 (schema rejection of unverified human-review) reference schema.ts fields that don't exist yet; tests use typed casts at boundaries and will be updated in Wave 2 to use the new fields directly.

## 2026-08-10 — wave-2 schema + compatibility repair
- [design-decision] HumanReviewSchema bounded with max(64) for reviewed_at; channel is z.literal("interactive-cli").
- [design-decision] DecisionSchema new fields are optional or default false so additive loading of pre-PR3 STATE continues to work.
- [design-decision] superRefine validation invariants implemented on MemoryFileSchema (not DecisionSchema) so the rule fires at the memory level; a non-trust claim without human_review is rejected with a stable issue code.
- [bug-fix] loadAndMigrate now repairs pre-PR3 unverified human-review claims BEFORE final MemoryFileSchema.safeParse() so they validate cleanly as legacy+foundational_requested.
- [test-gap] schema.test.ts extended with 10 tests for the new validation invariants; existing tests updated minimally where invariants changed.
- [flakiness] targeted run green; full suite shows only the intended remaining failing fixtures (3 new test files + merge.test.ts/prune.test.ts/migrate.test.ts/recall.test.ts from Wave 1).

## 2026-08-10 — wave-3 decision-authority (retry)
- [design-decision] normalizeDecisionTopic/Text: NFKC, lowercase, trim, collapse whitespace.
- [design-decision] isTrustedHumanFoundational: all five conditions must hold.
- [design-decision] resolveDecisionAuthorities is pure; returns copies; never mutates the input.
- [design-decision] Trust-rank tie-break: llm-corroborated(3) > heuristic(2) > legacy(1); then lexical ID.
- [design-decision] Conflicting non-human rows in a human-foundational topic get conflicts_with (NOT superseded_by).
- [test-gap] 13 tests in decision-authority.test.ts now green.
- [scope-deviation] The first Wave 3 attempt by another agent produced an empty result with no file changes; this is the successful retry.

## 2026-08-10 — wave-4 mergeDecisions extraction
- [design-decision] mergeDecisions begins from resolveDecisionAuthorities's read view, not a topic-index map.
- [design-decision] Heuristic conflicts supersede ALL prior valid non-human same-topic rows (not one mapped index) per plan §7.1.
- [design-decision] LLM-equivalent observations corroborate the same authority ID in place; provenance upgraded when stronger.
- [design-decision] Extraction 'foundational' signal maps only to foundational_requested.
- [design-decision] Conflict-with-human rows carry conflicts_with (NOT superseded_by); the human did not adopt those values.
- [design-decision] LLM observations against a quarantined conflicting-human-foundational topic become invalid conflict candidates linked to the unresolved human IDs (same veto as heuristic, plan §7.1).
- [design-decision] A legacy-only authority is one whose provenance is undefined, extractor "legacy", or confidence "legacy"; only those may be superseded by an evidence-backed LLM conflict (plan §7.2).
- [scope-deviation] plan §7 requires mergeMemory to delegate to mergeDecisions, so src/memory/writer.ts was edited minimally (decision block replaced by a delegation call; dead llmEvidenceFor/randomUUID removed). All non-decision merge logic preserved verbatim.
- [test-gap] 8 PR 3 merge tests now green; existing merge tests still pass.