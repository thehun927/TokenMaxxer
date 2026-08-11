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
