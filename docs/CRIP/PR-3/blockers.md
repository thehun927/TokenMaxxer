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

## 2026-08-10 — wave-5 authority-aware reader + recall redesign
- [design-decision] queryDecisions now uses resolveDecisionAuthorities().authorities, not raw still_valid filtering.
- [design-decision] getDecisionById returns the decision by exact ID regardless of still_valid; callers check authority view themselves.
- [design-decision] _recallDecision exposes the stable decision ID in a bounded marker for copyability.
- [design-decision] _getProjectState includes a bounded 'Decision conflicts: ...' line per conflicting-human-foundational topic.
- [design-decision] _recallPromote now uses {decision_id} OR {topic} (one-release compat); exact-ID is preferred and authoritative.
- [design-decision] _recallPromote mutation sets ONLY foundational_requested=true; never touches foundational, provenance, or human_review.
- [design-decision] Topic compatibility path refuses multiple-authority / conflict state with a bounded message.
- [design-decision] _recallPromote uses one mutateMemory transaction; no separate pre-read.
- [test-gap] 10 PR 3 recall tests now green; existing recall tests still pass.
- [design-decision] Topic compatibility additionally requires exactly ONE raw still_valid row for the normalized topic (test 27 refuses two conflicting raw-valid rows even though resolution picks one authority); unresolved duplicate-valid raw state is refused rather than resolved silently.
- [design-decision] Typed outcomes: requested / already-reviewed / not-found / not-authoritative / conflict / ambiguous; unavailable STATE maps to 'No project memory.', lock-timeout/commit-failed map to bounded 'promotion-write-failed'.
- [test-gap] test/memory/recall.test.ts PR 2 §11.G/§15.14 cross-process test asserts pre-PR3 promotion semantics ("Promoted:", "confidence=human-reviewed", foundational=true on disk). It already failed at baseline (Wave 2 schema validation rejected the old human-minting mutation), and cannot pass under PR 3 §9 without updating the test. Out of Wave 5 scope (only test/tools/recall.test.ts is touchable); the PR 2 cross-process promotion test needs a Wave 8 test update to assert review-request semantics. Full-suite failures reduced from 14 to 5 (2 Wave 6 module-load + 4 Wave 7 prune + this one pre-existing).

## 2026-08-10 — wave-6 decision-review + CLI + launcher
- [design-decision] decision-review.ts pure helpers; no I/O; callers wrap in mutateMemory.
- [design-decision] supersedeHumanAuthority always creates a new decision (UUID v4) rather than reactivating the candidate, preserving lineage.
- [design-decision] CLI commands require interactive TTY for promote and supersede; no --yes, no env bypass, no piped confirmation.
- [design-decision] CLI's promote / supersede revalidates the exact ID inside the mutateMemory transaction after the human has already typed confirmation; if the state changed, the transaction aborts.
- [design-decision] Human confirmation happens BEFORE mutateMemory acquires the lock (no lock held while waiting on stdin).
- [design-decision] Launcher dispatch: opencode | decisions | promote | supersede; falls back to installed plugin dir for raw installer.
- [design-decision] Tsup CLI entry produces dist/cli.js + dist/cli.d.ts; listed in package.json files.
- [test-gap] 22 tests (10 decision-review + 12 cli) now green.
- [design-decision] DecisionReviewMutation kind names follow the Wave 1A test spec (requested/already-reviewed/not-found/not-authoritative/conflict/ambiguous PLUS confirmed/not-requested/superseded+newAuthorityId/not-authority/not-linked). The plan §10 draft "reuse requested as success kind" is not what test/memory/decision-review.test.ts asserts; tests are the spec.
- [design-decision] requestFoundationalReview topic path counts RAW still_valid rows (not the resolved authority count) so two conflicting raw-valid rows are refused as ambiguous — matching Wave 5 recall.ts and test C; substring matching is never used ("auth" != "authentication").
- [design-decision] supersedeHumanAuthority downgrades the old authority's provenance to extractor=legacy/confidence=legacy and clears human_review when clearing foundational; schema §4.1 rejects a human trust claim without foundational=true, so the superseded row cannot keep human provenance.
- [design-decision] confirmFoundationalReview preserves source_session_id / source_audit_session_id / evidence while changing only extractor/confidence to human-reviewed (PR 3 §11.2).
- [design-decision] `tokenmaxxer decisions` default lists the authority-aware view (queryDecisions); `--all` lists every row plus lineage and unresolved human conflicts.
- [bug-fix] test/cli.test.ts Wave 1A fixture used ../../src/... imports from test/ (one level deep), resolving outside the repo; corrected to ../src/... — the fixture could never load otherwise.
- [bug-fix] test/cli.test.ts item 29 seeded auth-1 as both non-authoritative (older duplicate of auth-2's topic) and not review-requested, while its own assertion requires auth-1 listed with requested=true; fixture fixed so auth-1 is the review-requested authority and auth-2 moves to a distinct topic (db).
- [design-decision] The supersede CLI confirmation token is the candidate ID (matches test 40's injected read value "candidate-1"); the promote confirmation token is the decision ID.
- [test-gap] Full-suite failures remain exactly the intended 5: 4 Wave 7 prune tests (§13) + 1 Wave 8 cross-process recall update (PR 2 §11.G/§15.14). No new regressions.

## 2026-08-10 — wave-7 foundational retention in pruneOld
- [design-decision] retentionProtected predicate: decision.foundational === true.
- [design-decision] Invalid-decision pruning retains foundational conflict records (still_valid=false AND foundational=true is kept).
- [design-decision] 30-day age pruning never touches foundational rows.
- [design-decision] 10/5 pressure stages: foundational-first selection; if foundational count exceeds target, all foundational rows are kept and the disposable limit is skipped.
- [design-decision] The 10/5 pressure stage target applies to DISPOSABLE rows: all foundational rows plus up to `target` newest non-foundational rows are kept. This reconciles the plan §13.3 illustrative snippet (`target - foundationals.length`) with release-gate test 42, which requires the newest disposable row (recent-0) to survive alongside 10 foundationals; tests are the spec.
- [design-decision] Irreducible over-cap behavior: pruneOld may intentionally return over-cap state; commitMemoryExact rejects the commit; prior STATE remains intact. NO silent foundational deletion.
- [test-gap] 5 PR 3 prune tests now green; existing prune tests still pass. Full-suite failures are now exactly 1 intended Wave 8 cross-process recall update (PR 2 §11.G/§15.14).

## 2026-08-10 — wave-8 adversarial / integration pass
- [design-decision] Cross-process recall test updated to assert review-request semantics (foundational_requested=true, not foundational=true; no human_review; confidence != human-reviewed) — test/memory/recall.test.ts — PR 3 §9 forbids the pre-PR3 promotion assertions the old test made.
- [test-gap] New adversarial concurrent tests added (idle+CLI promote, idle+recall_promote review, idle+CLI supersede, supersede+idle concurrent) — test/cli.test.ts, test/memory/recall.test.ts, test/memory/transaction.test.ts, test/memory/writer.test.ts — all use barrier-driven child fixtures.
- [test-gap] CLI smoke tests: dist/cli.js non-empty, launcher routes opencode/decisions/promote/supersede, installer syntax valid — test/cli-smoke/smoke.sh, test/cli-smoke/launcher.test.ts, package.json scripts.check-cli-bundle / verify-cli-bundle / smoke:cli.
- [design-decision] CLI concurrent tests use barrier files (not startup race) for deterministic overlap — hold-write child signals ready and holds the lock while the CLI contends; the transaction revalidates the exact ID after the human typed confirmation.
- [design-decision] The vitest launcher smoke (test 48) is `describe.skipIf` when dist/cli.js is absent so the unit suite stays green without a build; the shell smoke (46-49) is the CI-after-build verification step.
- [flakiness] 5x adversarial run of all test files green; no new flakiness.

## 2026-08-10 — wave-9 PR 3 release-gate blocker fix
- [bug-fix] Blocker 1: durable human conflict quarantine via per-row `human_conflict_quarantined` boolean; mergeDecisions preserves conflicts across the entire merge (flag-based re-derivation per iteration + initial reconciliation conflicts); empty incoming does not invalidate the conflict; read view reconstructs from durable state.
- [bug-fix] Blocker 2: Decision.id bounded to MAX_IDENTIFIER; MemoryFileSchema.superRefine rejects duplicate IDs with a stable DUPLICATE_DECISION_ID issue; migration repair assigns fresh UUIDs and updates lineage references; defensive getExactDecisionById refuses on duplicates.
- [design-decision] Concern A: resolveDecisionAuthorities preserves winner provenance/rationale as-is (authority/lineage view only); mergeDecisions performs strongest-provenance enrichment on write (in-place LLM corroboration).
- [design-decision] Concern B: heuristic (and legacy-supersede) rewrites only prior valid same-topic non-human authorities (raw-valid IDs ∪ currently-valid rows); unrelated invalid history (e.g. pre-existing LLM conflict candidates) is left unchanged.
- [design-decision] Concern C: supersedeHumanAuthority requires candidate.still_valid === false (refuses a same-topic, linked, still-valid candidate with kind "not-linked").
- [design-decision] Concern D: _recallPromote routes through requestFoundationalReview inside mutateMemory; the model tool and human CLI share one eligibility definition (regression test compares outcomes for the same locked state).
- [test-gap] Real display→confirmation TOCTOU test added (barrier-driven child invalidates/supersedes the target during the display window; the locked re-read aborts; post-attempt STATE equals the adversarial pre-confirmation STATE byte-for-byte).
- [test-gap] Post-build verify-cli-bundle + smoke:cli + dist/cli.js bundle check + bash -n bin/tokenmaxxer wired into .github/workflows/ci.yml.
- [scope-deviation] Durable conflict representation choice: a per-Decision `human_conflict_quarantined` boolean (default false), NOT a top-level `unresolved_human_conflicts` array. Rationale: the flag lives on the exact rows it describes, so `mergeDecisions`' start-from-reconciled-view carries it through the write path with no extra plumbing; it cannot diverge from the decision rows as a separate array could; the resolver reconstructs conflicts from the flag and from `still_valid=false + foundational=true + human provenance + conflicts_with=[other]` rows (covers pre-wave-9 files lacking the flag); it is additive with a default so pre-PR3 STATE files load unchanged.
- [scope-deviation] `test/memory/decision-review.test.ts` is outside the wave-9 touch scope, so the duplicate-ID refusal tests for `requestFoundationalReview`/`confirmFoundationalReview`/`supersedeHumanAuthority` (and the Concern C still-valid-candidate refusal) live in `test/memory/decision-authority.test.ts` (wave-9 describe blocks) instead.
- [test-update] decision-authority.test.ts item 3 updated to assert the read view keeps the winner's ORIGINAL heuristic provenance (Concern A contract); write-path enrichment is covered by the new wave-9 merge test.
- [test-update] merge.test.ts item 12 retained under the Concern B contract: a later heuristic conflict supersedes every PRIOR VALID same-topic non-human row (both seeded valid rows), while a pre-existing invalid LLM candidate is left untouched (new wave-9 test).
- [scope-deviation] The wave-9 CLI TOCTOU test uses a real child process (`node -e` adversary) that invalidates the target during the stdin-confirmation window; the transaction-worker fixture was not modified (outside scope).
