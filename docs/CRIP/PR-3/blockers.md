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