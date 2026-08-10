# PR 2 — Live Blocker Log

This file collects blockers and decisions encountered while implementing
`docs/pr2-implementation-plan.md` that are not in the plan itself but must
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

## 2026-08-10 — wave-2 persistence/refactor
- [design-decision] `commitMemoryExact` kept module-private; tests seed via `writeMemory` (which now writes the supplied revision exactly) and assert through `mutateMemory`/`readMemoryState` — src/memory/store.ts — no test-only export needed.
- [design-decision] `writeMemory` retained as a backward-compat low-level primitive (fallback/migration) but no longer advances revision; revision ownership moved solely to `mutateMemory` — src/memory/store.ts — existing writer/recall callers keep working until Wave 3 migration.
- [test-gap] p0-a-reliability "preserves durable global memory" asserted writer revision 2→3 via `writeMemory`; updated to expect revision 2 (unchanged) since raw persistence no longer bumps revision — test/memory/p0-a-reliability.test.ts:515.

## 2026-08-10 — wave-3 heuristic writer migration
- [design-decision] `markReferencedDecisions` made pure (returns a new MemoryFile, never mutates input) and called inside the `mutateMemory` callback on the authoritative lock-protected base — src/memory/writer.ts:1205 — the heuristic transaction rebases on the locked read, so a best-effort outside-lock mutation would be discarded.
- [design-decision] The pre-lock `readMemoryState` snapshot is retained ONLY to feed the LLM cache fingerprint (`canonicalInput`); it is never the merge authority. The heuristic merge runs inside the transaction on the lock-read base — src/memory/writer.ts:261 — LLM cache check still uses `readMemoryState`/`writeMemory` outside the heuristic transaction; intentional for Wave 3, migrated in Wave 4.
- [design-decision] `IdleWriteOptions` gains a test-only `lockOptions` field threaded into `mutateMemory` so the lock-timeout test can bound acquisition — src/memory/writer.ts:204 — no production behavior change.
- [test-gap] p0-a-reliability "preserves durable global memory" revision assertion updated 2→3 because the heuristic write now runs through `mutateMemory` (advances revision exactly once) — test/memory/p0-a-reliability.test.ts:516.
- [test-gap] writer.test.ts extended with three Wave-3 tests: heuristic transaction bumps revision 0→1; lock-timeout returns `write-failed` with no STATE write; unavailable STATE returns `write-failed` and preserves the global fallback — test/memory/writer.test.ts.

## 2026-08-10 — wave-4 LLM lifecycle migrations
- [design-decision] All five LLM lifecycle mutations (`persistAudit`, `persistTerminal`, `onHealthOutcome`, cache-hit `mergeAsyncFacts`, final-LLM merge) now run inside `mutateMemory` with `bypassCache:true`; the LLM prompt/retry/timeout/host-call work remains strictly outside the lock per plan §12 — src/memory/writer.ts — pre-lock model resolution, prompt, audit session creation, and the post-LLM HEADER write are all unaffected.
- [design-decision] `persistTerminal` returns `noop` (not `committed`) when the audit row no longer exists in the locked read base — per plan §11.C this avoids a no-op revision bump. Best-effort failures (`lock-timeout`, `commit-failed`, `unavailable`) emit a bounded `warn` log and continue without a stale fallback write — src/memory/writer.ts.
- [design-decision] The final-LLM `mutateMemory` callback re-checks the cache identity against the locked read base (not the pre-lock snapshot); this closes the pre-existing race where a cache identity committed during the prompt would be silently re-applied — src/memory/writer.ts — concrete correctness improvement over the prior Wave-3 design.
- [test-gap] The dedicated Wave-4 cross-process tests (audit-guard-failure-does-not-prompt, audit-terminal-noop, model-health-best-effort, cache-hit-under-lock, final-LLM-cache-identity-under-lock, no-lock-prompt-zone) were NOT added in this wave — src/memory/writer.ts, test/memory/writer-llm.test.ts — deferred to Wave 6 (full regression and adversarial suite) per plan §16 Step 8. The 284 pre-Wave-4 tests still pass; no LLM-lifecycle regression was detected by existing coverage, but the Wave-4-specific scenarios need explicit child-process proof.
- [scope-deviation] Wave-4 result body from the dispatched agent was empty; production code shipped (writer.ts modified, 277-line diff) but no narrative summary was returned. TSC clean, full vitest run green. Logged here for transparency rather than re-running the wave.

## 2026-08-10 — wave-5 recall/promotion/recency mutations
- [design-decision] `_recallPromote` migrated from `readMemory` + mutate + `writeMemory` to a single transactional `mutateMemory`; the mutation runs on the authoritative lock-read base so a concurrent idle write cannot erase the promotion — src/tools/recall.ts:106. Promotion authority/human-review semantics kept UNCHANGED per plan §11.G (PR 3 will redesign them); only the persistence mechanism changed.
- [design-decision] `_recallPromote` keeps a read-only `readMemory` short-circuit before the transaction to preserve the "No project memory." output and avoid a transaction when there is nothing to promote — src/tools/recall.ts:99. This read does not need the lock per §11.F; the authoritative mutation below it does.
- [design-decision] `_recallPromote` best-effort failures (`lock-timeout`/`commit-failed`/`unavailable`) return a bounded non-throwing `"promotion-write-failed"` string — src/tools/recall.ts:140. No stale unlocked fallback write.
- [design-decision] `_recallDecision`, `_getActiveFiles`, `_getProjectState` are pure-read tools and remain on `readMemory` with NO lock, per §11.F — src/tools/recall.ts:37,55,72. No transaction added.
- [design-decision] `markReferencedDecisions` (the `last_used_in_session` usage-metadata mutation) is already pure and runs only inside the Wave-3 heuristic `mutateMemory`; it is NOT called from any recall tool — src/memory/writer.ts:1305. No recall-tool migration needed for usage metadata.
- [test-gap] `test/tools/recall.test.ts` `_recallPromote` block rewritten to drive the real `mutateMemory` callback (mockMutateCommitted) instead of asserting `writeMemory`; added lock-timeout/unavailable bounded-failure cases and a read-only no-lock suite — test/tools/recall.test.ts.
- [test-gap] New `test/memory/recall.test.ts` proves `recall_promote` is transactional against a real child-process idle write (both the promotion's `foundational=true` and the idle fact survive; revision advances exactly twice) and fails closed on unavailable STATE — test/memory/recall.test.ts.
- [scope-deviation] No `src/memory/recall.ts` or `test/memory/recall.test.ts` existed before this wave; the recall logic lives entirely in `src/tools/recall.ts`. The new `test/memory/recall.test.ts` was created for the cross-process promotion proof.
- [deferred] Promotion authority and human-review trust redesign explicitly deferred to PR 3 per plan §11.G/§17; Wave 5 only made the current mutation transactional.

## 2026-08-10 — wave-6 bypass audit + full regression/adversarial suite
- [design-decision] Bypass audit (plan §16 Step 7) found NO remaining unsafe STATE-write path. `writeMemory`/`commitMemoryExact`/`atomicWrite(...STATE.json)` appear only in `src/memory/store.ts` (the low-level primitive and its `mutateMemory` internal use). The only `writeMemory` import in production was a dead import in `src/memory/writer.ts:14` (unused since Wave 3); removed. All `readMemory` call sites are read-only (recall tools, compaction durable block, extract-llm persisted-retained-session guard) and never followed by a STATE write. Production now has exactly one logical mutation route: `mutateMemory`.
- [design-decision] Extracted the five LLM-lifecycle mutations into exported test seams so the Wave-4-deferred and §15 release-gate tests can drive them directly with real `mutateMemory`/lock: `finalLLMMerge` (src/memory/writer.ts:505), `persistAuditGuard` (596), `persistTerminalTransaction` (629), `persistModelHealth` (667), `mergeAsyncFacts` (737). No production behavior change; the writer's inline callbacks now delegate to these seams.
- [test-gap] Added the six Wave-4-deferred tests to test/memory/writer-llm.test.ts: audit-guard transaction failure does not prompt; audit-terminal noop does not bump revision; model-health transaction failure is best-effort (no fallback writeMemory); cache-hit transaction is inside the lock (times out against a held lock); final-LLM transaction reads cache identity under the lock (child `replace-state` at higher revision); LLM prompt is not held under the lock (child idle-write completes while prompt pending and survives final merge).
- [test-gap] Added release-gate tests to test/memory/transaction.test.ts: §15.16 audit guard cannot overwrite a concurrent heuristic mutation; §15.17 model-health update cannot overwrite a concurrent durable mutation; §15.18 final LLM merge cannot overwrite a mutation committed while the prompt was running; §15.20 unavailable STATE fails closed under transaction (spy asserts no unlocked `writeMemory`). §15.14 (idle writer + concurrent promotion) and §15.15 (concurrent different sources) were already covered by test/memory/recall.test.ts and the existing "two child processes, same project, different facts" test; §15.19 is covered by the Wave-4 "LLM prompt is not held under the lock" test.
- [test-gap] Added `replace-state` and `hold-lock-after` commands to test/fixtures/transaction-worker.ts for deterministic child-process coordination (barrier-driven, no sleeps).
- [flakiness] 5x adversarial run of transaction/project-lock/recall/p0-a-reliability/writer-llm/writer/store tests: 117 tests passed on all 5 runs; no flakiness observed. Full suite: 30 files, 302 tests green; `npx tsc --noEmit` exit 0.
