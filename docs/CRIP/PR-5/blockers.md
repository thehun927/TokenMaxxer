# PR 5 — Live Blocker Log

This file collects blockers and decisions encountered while implementing
`docs/CRIP/PR-5/implementation-plan.md` that are not in the plan itself but must
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

## 2026-08-11 — wave-1A source identity fixtures
- [test-gap] test/memory/extract.test.ts extended with 10 failing-on-main fixtures (§18.A items 1-10); expected to go green in Wave 2.
- [design-decision] Tests use `import * as prompt from "../../src/memory/extract-prompt"` cast through `as any as { ... }`; today's import resolves to the existing module; `buildExtractionSourceInput`, `makeSourceVersionKey`, `makeExtractionCacheKey` do NOT yet exist, so the tests reference them through a typed stub. Today the tests fail because the new exports are absent.
- [scope-deviation] The fixtures are pure unit tests of the new helpers; integration with writeMemoryOnIdle is covered by Lane B.