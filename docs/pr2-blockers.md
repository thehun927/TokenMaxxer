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
