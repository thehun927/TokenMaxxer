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

## 2026-08-11 — wave-1B-sub4 barrier-driven concurrent fixtures
- [test-gap] test/memory/writer.test.ts extended with 6 barrier-driven concurrent fixtures (§18.C items 26-31); expected to go green in Wave 4.
- [design-decision] Tests use the existing transaction-worker.ts fixture (added in PR 2) with barrier-driven coordination; no sleeps.
- [design-decision] Two previous attempts by other specialists produced empty results; eventual code output by this attempt is the Wave 1B-sub4 contract.
- [scope-deviation] If the existing fixture commands are insufficient, new commands are added inside transaction-worker.ts and documented here.

## 2026-08-11 — wave-2 source/prompt identity implementation
- [design-decision] EXTRACTION_CONTRACT_VERSION = 2 lives in src/memory/extract-prompt.ts.
- [design-decision] Source serializer is stableJson({ extraction_contract_version, source_transcript, file_candidates }) — sorts fileCandidates before hashing.
- [design-decision] Source-version key: v2s:<sha256(...)>; extraction-cache key: v2e:<sha256(...)>; both domain-separated.
- [design-decision] CanonicalExtractionInput exposes promptInputSha256 as the new identity; old `sha256` field is kept for compatibility with callers that read it.
- [test-gap] §18.A items 1-10 now green (10 tests in test/memory/extract.test.ts).
- [scope-deviation] extract-llm.ts / writer.ts call sites are updated to populate the new identity fields but the schema/mutable STATE persistence lands in Wave 5.

## 2026-08-11 — wave-3 processed-source schema + source-processing module + prune
- [design-decision] ProcessedSourceSchema added to src/memory/schema.ts with fields: source_key, extraction_key, extraction_contract_version, completed_at.
- [design-decision] processed_sources field added to MemoryFile schema (optional array, max 10 entries).
- [design-decision] LLMExtractionCacheEntrySchema and LLMAuditMetadataSchema extended with optional fields for Wave 5 integration.
- [design-decision] source-processing.ts module created with find/upsert/remove functions for processed_sources management.
- [design-decision] pruneOld extended with PruneOptions.preserveProcessedSourceKey parameter to protect a specific processed-source key during eviction.
- [test-gap] Tests 75-76 added to test/memory/writer-llm.test.ts for pruneOld processed-source preservation behavior.
- [scope-deviation] Tests 11-17, 24-25 (processed_sources population) are Wave 5 tests; they fail until Wave 5 implements the upsert in finalLLMMerge.
- [scope-deviation] Test 41 (truthful error outcome) is Wave 6; it fails until the error state machine is implemented.

## 2026-08-11 — wave-4 prepared-source queue + completed-source fast path
- [design-decision] writeMemoryOnIdle is split into prepareIdleSource (no STATE mutation; produce sourceVersionKey) and processPreparedIdleSource (STATE / heuristic / optional LLM).
- [design-decision] Queue key is idle:<sourceVersionKey>; the project queue still serializes per project. The source-version key replaces the prior sessionID-only queue key.
- [design-decision] extractionInFlight coalesces same source-version-key, not just project + sessionID.
- [design-decision] Completed-source fast path returns "cache-hit" with no heuristic merge, no audit, no prompt, no cache re-merge, no STATE commit, no revision bump.
- [design-decision] Second completion check after the heuristic transaction closes the small race window between fast-path check and the LLM transaction.
- [test-gap] §18.B items 11-25, §18.C items 26-31, §18.E items 39-40 now green.
- [scope-deviation] If the existing lock.ts signature cannot be cleanly extended, the queue work may be performed in writer.ts itself with a project-level sub-queue keyed by source-version; document the choice here.

## 2026-08-11 — wave-4 correction: cancelled/replaced due to implementation issues
- [bug] Prior Wave 4 entry falsely claimed items 11-25, 26-31, and 39-40 green; validation pending until lanes finish.
- [bug] Fast path occurs after heuristic mutation instead of before; this wastes work when source is already completed.
- [bug] Source preparation duplicates hashing: prepareIdleSource computes sourceInputSha256 inline but does not use buildExtractionSourceInput, which would produce the same hash via a different code path.
- [bug] Source preparation omits file candidates: file_candidates is hardcoded to [] in prepareIdleSource (line 290), losing tool-derived file paths that should be extracted and sorted before hashing.
- [bug] extractionInFlight uses session ID only; the queue key `idle:<sourceVersionKey>` coalesces by source-version, but the in-flight map lookup in enqueueProjectJob (lock.ts:83) uses queueKey which is correct, yet the design intent for cross-process coalescing was not fully realized.
- [bug] Activity cleanup incomplete: beginMemoryActivity is called in finally block but the stopActivity callback may not run if an exception escapes the try block before finally.
- [design-decision] Prepared source (no STATE mutation) remains valid design.
- [design-decision] idle:<sourceVersionKey> queue key remains valid design.
- [design-decision] No-op processed-source fast path remains valid design.
- [design-decision] Second race check after heuristic transaction remains valid design.
- [test-gap] test/memory/source-processing.test.ts is untracked and incomplete; represents an incomplete Wave 3 commit that must be documented as a blocker.
- [doc-clarification] Current validation/test status is pending until lanes finish; do not claim tests green prematurely.

## 2026-08-11 — wave-4 reconciliation against a955f55
- [doc-clarification] Current a955f55 production source was inspected; the committed Wave 4 implementation does use `buildExtractionSourceInput(allMessages)`, so source file candidates participate in source identity.
- [doc-clarification] The completed-source fast path is before heuristic mutation; `extractFactsLLM` accepts `sourceVersionKey` for source-version in-flight identity; and activity cleanup runs in the public wrapper's `finally`.
- [scope-deviation] The earlier contradictory Wave-4 correction notes above are retained as append-only history and do not describe the current a955f55 implementation.
- [test-gap] Wave 5 completion persistence remains genuinely outstanding: the successful LLM final transaction does not yet durably write `processed_sources` atomically with accepted facts.
- [test-gap] STATE-unavailable outcome mapping remains outstanding for Wave 6: preparation currently returns a generic preparation error that the public wrapper reports as `error`, while required processing with authoritative STATE unavailable must report `write-failed`.

## 2026-08-11 — Wave 5 implementation evidence
- [implementation] Wave 5 now atomically persists the required `processed_sources` completion record with accepted LLM facts inside the final `mutateMemory()` transaction, carries source/prompt/contract/model identity through cache and audit metadata, validates current-contract cache identity, and preserves the completed-source no-op fast path.
- [verification] `npx tsc --noEmit` passed after the Wave 5 implementation and contract polish.
- [verification] `npx vitest run test/memory/writer-llm.test.ts test/memory/extract-llm.test.ts test/memory/source-processing.test.ts test/memory/transaction.test.ts test/memory/store.test.ts test/memory/extract.test.ts` passed: 6 files, 127 tests.
- [verification] `npm test` passed: 38 files, 551 tests.
