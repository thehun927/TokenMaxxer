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

## 2026-08-11 — wave-1B idempotency basics fixtures
- [test-gap] test/memory/writer-llm.test.ts extended with 7 failing-on-main fixtures (§18.B items 11-17); expected to go green in Wave 4.
- [design-decision] Tests use the real writeMemoryOnIdle boundary and existing writeMemoryOnIdle test patterns.
- [scope-deviation] Items 18-25 (advanced idempotency) and 39-41 (truthful outcomes) will be added in subsequent sub-waves.

## 2026-08-11 — wave-1B-sub2 advanced idempotency fixtures
- [test-gap] test/memory/writer-llm.test.ts extended with 8 failing-on-main fixtures (§18.B items 18-25); expected to go green in Wave 4.
- [design-decision] Items 18-19 (process-local reset + cache-row deletion) prove the completion ledger is independent of the bulky result cache.
- [design-decision] Item 24 (append-source second success) covers the same-session changed-version idempotency boundary.
- [design-decision] Item 25 (size-cap-edge marker preservation) is acceptable to fail with either 'llm-success + marker survives' or 'transaction refused + prior STATE unchanged' — the bug is 'llm-success without marker on disk'.
- [scope-deviation] Items 26-31 (barrier-driven concurrent cases, §18.C) and 39-41 (truthful outcomes, §18.E) are deferred to subsequent sub-waves.

## 2026-08-11 — wave-1B-sub3 truthful outcomes fixtures
- [test-gap] test/memory/writer-llm.test.ts extended with 3 failing-on-main fixtures (§18.E items 39-41); expected to go green in Wave 6.
- [design-decision] Item 41 specifically asserts that the broad catch (-> 'heuristic-only') is replaced by an explicit 'error' outcome.
- [design-decision] The remaining §18.E items 42-58 (write-failed, queue-failed, llm-failed, the lastOutcome alignment, etc.) are deferred to Wave 6 when the truthful outcome state machine is implemented.
- [scope-deviation] Items 26-31 (barrier-driven concurrent cases, §18.C) are deferred to Wave 4 where the source-version queue key is implemented.

## 2026-08-11 — wave-2 source/prompt identity implementation
- [design-decision] EXTRACTION_CONTRACT_VERSION = 2 lives in src/memory/extract-prompt.ts.
- [design-decision] Source serializer is stableJson({ extraction_contract_version, source_transcript, file_candidates }) — sorts fileCandidates before hashing.
- [design-decision] Source-version key: v2s:<sha256(...)>; extraction-cache key: v2e:<sha256(...)>; both domain-separated.
- [design-decision] CanonicalExtractionInput exposes promptInputSha256 as the new identity; old `sha256` field is kept for compatibility with callers that read it.
- [test-gap] §18.A items 1-10 now green (10 tests in test/memory/extract.test.ts).
- [scope-deviation] extract-llm.ts / writer.ts call sites are updated to populate the new identity fields but the schema/mutable STATE persistence lands in Wave 5.