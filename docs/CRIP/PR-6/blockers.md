# PR-6 Blockers and Decisions

Append-only implementation log for PR 6. Do not delete or rewrite prior entries.

## 2026-08-11 — implementation start

- [baseline] Production baseline is PR-5 exact tested head
  `29fcffafe1ccbf9b052bf8c30999fff8604e1726`; current local branch was
  fast-forwarded to remote `01072ae` before PR-6 work began.
- [scope] PR-6 narrows the optional structured LLM path to evidence-backed
  decisions only. PRs 1–5 storage, transaction, authority, host-contract,
  source-version, completion-ledger, and truthful-outcome contracts remain
  authoritative.
- [worktree] Pre-existing local changes in `dist/*` and `opencode.json` are
  unrelated and must remain excluded from PR-6 commits.

## 2026-08-11 — Wave 1 contract freeze

- [contract-freeze] Added real Wave 1 tests across extraction schema, extraction
  result, merge, schema, and migration boundaries. No production code changed.
- [expected-failure] The owned Wave 1 command
  `npx vitest run test/memory/extract.test.ts test/memory/extract-llm.test.ts test/memory/merge.test.ts test/memory/schema.test.ts test/memory/migrate.test.ts`
  currently reports 170 tests: 135 passed and 35 failed against the PR-5
  implementation. Failures identify the planned v3 decisions-only contract,
  LLM/non-decision merge boundary, provenance pairing/audit/evidence gates, and
  incomplete-claim compatibility repair gaps.
- [scope] Wave 2 is the next dependency-gated implementation step; no Wave 2
  production work has started.

## 2026-08-11 — Wave 2 contract v3/type separation

- [implementation] `EXTRACTION_CONTRACT_VERSION` is now 3; heuristic facts and
  decisions-only LLM facts have separate type/schema boundaries with required
  evidence references and bounded strict structured output.
- [compatibility] A temporary double assertion remains at the legacy
  `finalLLMMerge` full-facts seam solely to keep the repository compiling until
  Wave 4 replaces that merge with the decisions-only path. It must be removed
  before the final audit.
- [expected-downstream] Owned Wave 2 tests pass: `extract.test.ts` 39/39 and
  `llm-adapter.test.ts` 17/17. `extract-llm.test.ts` has 22 passed and 3
  downstream failures for cache replay/capping and heuristic-candidate evidence;
  those are reserved for Waves 3 and 5.
- [verification] `npx tsc --noEmit` passed after the temporary integration bridge.

## 2026-08-11 — Wave 3 transcript-only evidence boundary

- [implementation] Prepared sources now expose separate transcript candidate/
  digest maps for LLM trust and heuristic candidate/digest maps for heuristic
  provenance. LLM extraction, cache validation, and final merge receive only
  transcript evidence.
- [implementation] LLM evidence resolution rejects `heuristic-candidate` refs;
  heuristic provenance retains its own merged candidate universe.
- [verification] `npx tsc --noEmit` passed. Owned extraction tests remained green
  and the transcript-only rejection case turned green.
- [expected-downstream] The Wave 3 focused run reported 93 passed and 17 failed;
  remaining failures are full-facts writer/cache behavior reserved for Waves 4–6
  plus two legacy cache tests reserved for Wave 5.

## 2026-08-11 — Wave 4 decisions-only merge

- [implementation] Added explicit decisions-only LLM merge semantics. LLM
  extraction cannot mutate current_task, active_files, blockers, next_steps, or
  foundational authority fields; heuristic merge remains the only full-facts
  path.
- [implementation] Removed the temporary Wave-2 type bridge from the active
  final merge seam; decisions-only facts now reach the explicit LLM merge
  boundary.
- [verification] `npx tsc --noEmit` passed; merge tests 33/33 and transaction
  tests 13/13 passed.
- [expected-downstream] `writer-llm.test.ts` had 44 passed and 3 failed; all
  remaining failures are Wave 5 cache/provenance behavior (cache persistence,
  v2 legacy cache identity expectation, and model-gating/cache integration).

## 2026-08-11 — Wave 5 decisions-only cache and compatibility

- [implementation] Cache entries now carry decisions-only LLM facts, current v3
  identity/provenance gates, and no trusted heuristic non-decision fields.
- [implementation] Pre-v3 broad cache payloads are quarantined while semantic
  STATE remains readable; incomplete LLM decision claims downgrade trust to
  legacy without deleting their semantic decision/evidence content.
- [verification] `npx tsc --noEmit` passed; cache/migration/schema/writer focused
  validation passed: 189 tests, 5 skipped.
- [verification] `npm test` passed: 38 files, 627 tests, 5 skipped.
- [gated] The five skipped schema tests are the Wave 6 provenance pairing and
  audit/evidence-gate cases. They remain explicit skips pending Wave 6 and are
  not counted as green contract coverage.

## 2026-08-11 — Wave 6 durable provenance invariants

- [implementation] Provenance schema now enforces extractor/confidence pairing
  and requires non-empty audit identity plus 1–3 evidence entries for LLM trust.
- [implementation] Migration repairs incomplete LLM provenance to legacy while
  preserving semantic decisions/evidence; merge skips LLM decisions without an
  audit session.
- [verification] `npx tsc --noEmit` passed; provenance-focused validation passed:
  206 tests.
- [verification] `npm test` passed: 38 files, 632 tests.
- [scope] All five previously gated provenance tests are re-enabled and green;
  no Wave 7 cleanup has started.

## 2026-08-11 — Wave 7 obsolete seam cleanup

- [audit] Removed the redundant second model lookup, extractor `cachedFacts`
  early-success path, obsolete `mergeAsyncFacts()` seam, and compatibility
  `origin:"llm"` full-facts dispatcher.
- [audit] Repository search found no `firstCandidateEvidence` helper/use. The
  remaining `ExtractedFacts` references are heuristic-only; remaining
  `origin:"llm"` is confined to the decisions-only merge function.
- [verification] `npx tsc --noEmit` passed and `npm test` passed: 38 files, 631
  tests.

## 2026-08-11 — Wave 8 release evidence

- [verification] `npm run verify:host-contract` passed; `npm run build` passed;
  self-contained `dist/index.js`, `dist/tui.js`, and `dist/cli.js` verification
  passed; `npm run verify-cli-bundle` passed; `npm run smoke:cli` passed; and
  `bash -n install.sh` plus `bash -n bin/tokenmaxxer` passed.
- [verification] Exact-head GitHub Actions CI run `31527531666` passed all jobs:
  full tests, TypeScript, host contract, build, self-contained bundles, CLI
  verification, smoke, and syntax checks.
- [worktree] Generated `dist/*` and local `opencode.json` changes remain
  intentionally uncommitted and unrelated to PR-6 implementation commits.
