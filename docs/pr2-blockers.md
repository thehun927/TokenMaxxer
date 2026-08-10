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
