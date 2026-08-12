# PR-8 Implementation / Decision Log

This file is append-only. Entries record implementation evidence, blockers,
deviations, and decisions; they do not replace the approved PR-8 plan.

## 2026-08-12 — baseline reconciliation before Wave 1

- Planning baseline: `7b1b904deb764cfe99c7b239f7cb75f34635688e`.
- PR-7 production baseline: `141bec918d08d8e25a358231c15a16fcc37efb62`.
- Current `main` after fast-forward from `origin/main`: `43ff490f56b06b4e1e89db36ca7c6d2c55a2c0ec` (`Mark PR 8 implementation plan ready`).
- The working tree had a pre-existing, unrelated modification to `opencode.json` (`small_model`); it is intentionally preserved and excluded from PR-8 implementation ownership.
- No PR-8 production implementation changes have been made at this point.

### Current implementation facts confirmed against `main`

- `src/memory/memory-size.ts` keeps `MEMORY_MAX_BYTES = 8_192` and counts the pretty-printed JSON representation with UTF-8 byte length, but has no shared UTF-8 truncation/fitting helpers.
- `src/memory/writer.ts` still owns `pruneOld()` / `pruneOldForCommit()` and can return an over-cap `MemoryFile`; `mutateMemory()` in `src/memory/store.ts` currently relies on the final commit guard.
- `mutateMemory()` increments the revision before commit, but does not fit against the incremented candidate and has no typed `budget-rejected` result or transient protection metadata.
- `src/memory/schema.ts` has broad/unbounded semantic strings such as `current_task`, active-file path/reason, decision topic/text/rationale, blockers, and next steps; current-v3 compatibility repair in `src/memory/migrate.ts` does not yet add the PR-8 compatibility ceilings/array repair.
- `src/compaction/durable.ts` has PR-7 sanitization and compact provenance, but no aggregate 4,096-byte UTF-8 budget, candidate selection contract, or actual evidence-count `[llm:eN]` semantics.
- `src/tools/recall.ts` and `src/cli.ts` route review/promotion through `mutateMemory()` but do not yet pass operation-required storage protection or map typed budget refusal.

### Scope decision

Wave 1 is test-contract-only. Three disjoint agents may add or update tests
only in their assigned areas; they must not alter production architecture or
pull PR-9 diagnostics/status or PR-10 release/dependency work into this PR.

## 2026-08-12 — Wave 1 contracts integrated

- Integrated test-only files: `test/memory/pr8-storage-budget.test.ts`, `test/memory/pr8-schema-compat.test.ts`, and `test/compaction/pr8-budget.test.ts`.
- No `src/` production files were changed. The unrelated `opencode.json` working-tree modification remains preserved.
- Storage focused rerun: `npx vitest run test/memory/pr8-storage-budget.test.ts` → 15 tests, 14 passed, 1 intentional failure. The failure is the expected current-main legacy `commit-failed` result where PR-8 requires typed `budget-rejected` for irreducible protected overflow; no-write/revision assertions remain active.
- Schema focused rerun: `npx vitest run test/memory/pr8-schema-compat.test.ts` → 19 tests, 6 passed, 13 intentional failures for absent creation limits, persistence ceilings, and v3 array repair.
- Durable focused rerun: `npx vitest run test/compaction/pr8-budget.test.ts` → 15 tests, 4 passed, 11 intentional failures for absent 4,096-byte fitting and evidence-count tags.
- TypeScript check: `npx tsc --noEmit` → passed (exit 0).
- Decision: retain the failing assertions; they are the Wave-1 production contracts and were not weakened to match PR-7 behavior.
- Decision: storage fixtures were corrected to use schema-valid provenance, to exercise `mutateMemory()` rather than raw writes for fitting, and to return the constructed irreducible candidate. The correction was completed after two writer lanes stopped without terminal results; ownership is now reconciled by Luna.
- Wave 1 is complete. Production implementation may begin only in the next planned wave after this contract commit.

## 2026-08-12 — Wave 2 budget primitives reconciled

- Owned implementation: `src/memory/budget.ts`; `src/memory/memory-size.ts` remains at the canonical `MEMORY_MAX_BYTES = 8_192` and exact pretty-JSON UTF-8 accounting.
- Owned focused contracts: `test/memory/pr8-budget-primitives.test.ts`.
- Independent focused rerun: `npx vitest run test/memory/pr8-budget-primitives.test.ts` → 52 passed, 0 failed.
- TypeScript check: `npx tsc --noEmit` → passed (exit 0).
- The fit primitive now deep-copies input, threads each retention candidate, uses deterministic `now`, keeps protected source/audit/decision proof, bounds disposable source history, reduces top-level blocker/next-step arrays, and returns typed no-memory failures without an over-cap memory result.
- Temporary measurement files created during fixture calibration (`measure.mjs`, `measure2.mjs`) are excluded from the deliverable and removed before commit.
- Deepwork ignore rules were added once as required for `.slim/deepwork/`; the unrelated `opencode.json` change remains intentionally unstaged.
- Wave 2 is complete. Wave 3 schema/migration compatibility is the next dependency-ordered phase; no Wave 4+ integration has started.

## 2026-08-12 — Wave 3 schema/migration compatibility reconciled

- Owned implementation: `src/memory/schema.ts` and `src/memory/migrate.ts`; no transaction, writer, durable, recall, or CLI integration was included.
- PR-8 focused rerun: `npx vitest run test/memory/pr8-schema-compat.test.ts` → 19 passed, 0 failed.
- Existing schema/migration regression rerun: `npx vitest run test/memory/schema.test.ts test/memory/migrate.test.ts` → 76 passed, 0 failed.
- Full memory-suite rerun: 24 files / 562 passed; the only four failures are outside Wave 3 ownership: the intentional Wave-1 typed storage result still reports legacy `commit-failed`, plus existing P0-A direct-write logging/UTF-8 and activity-marker assertions. These remain blockers for later transaction/reliability integration and were not weakened.
- TypeScript check: `npx tsc --noEmit` → passed (exit 0).
- Decision: keep broad persistence ceilings separate from tight automatic creation constants; migration repairs only oversized non-authoritative arrays deterministically and never truncates semantic text or invents provenance/evidence.
- Wave 3 is complete. Wave 4 canonical `mutateMemory()` transaction-budget integration is now the next phase.

## 2026-08-12 — Wave 4 canonical transaction budget reconciled

- Owned transaction implementation: `src/memory/store.ts`; mechanical discriminant narrowing in `src/memory/writer.ts` and `src/tools/recall.ts`; storage contracts in `test/memory/pr8-storage-budget.test.ts`.
- `MutationAction.commit` now accepts `budgetProtection`; `mutateMemory()` calculates the actual next revision before fitting, calls `fitMemoryToBudget()` as the sole storage-budget authority, returns typed `budget-rejected` with unchanged base revision and no write, and exposes the exact committed fitted `memory`.
- Focused rerun: `npx vitest run test/memory/pr8-storage-budget.test.ts test/memory/store.test.ts test/memory/transaction.test.ts` → 55 passed, 0 failed.
- Caller compatibility rerun: writer/recall suites pass except one existing writer-LLM assertion that still expects legacy `commit-failed`; actual result is the intentional new `budget-rejected` status. Wave 5 owns its public/internal outcome reconciliation.
- TypeScript check: `npx tsc --noEmit` → passed (exit 0).
- Decision: Wave 4 did not add a new public idle outcome; budget refusal remains an internal typed result and is mechanically routed through existing failure behavior until Wave 5 adds bounded reason mapping/protection at each caller.
- Wave 4 is complete. Wave 5 mutation callers and retry/public-outcome semantics are now the active phase.

## 2026-08-12 — Wave 5 mutation callers reconciled

- Writer integration owns `src/memory/writer.ts` and the related typed failure unions in `src/memory/extract-llm.ts`; human promotion integration owns `src/tools/recall.ts` and `src/cli.ts`; the writer regression expectation is in `test/memory/writer-llm.test.ts`.
- Final LLM merge protects the new processed-source key; audit guard and terminal updates protect their audit IDs; heuristic and model-health writes submit unpruned candidates to central `mutateMemory()`; ad-hoc `pruneOld()` is no longer used by durable mutation callers.
- Final LLM budget rejection maps to existing `write-failed`, writes no completion marker, and leaves the source retryable. Audit budget refusal is non-success and boundedly logged. Recall promotion and CLI promote/supersede protect selected human decision IDs and map refusal without inventing public idle outcomes.
- Combined focused rerun: `npx vitest run test/memory/writer.test.ts test/memory/writer-llm.test.ts test/memory/pr8-storage-budget.test.ts test/memory/transaction.test.ts test/tools/recall.test.ts test/cli.test.ts` → 199 passed, 0 failed.
- TypeScript check: `npx tsc --noEmit` → passed (exit 0).
- Decision: retain `pruneOld()`/`pruneOldForCommit()` as compatibility/test seams only; no writer durable mutation caller invokes them after Wave 5.
- Wave 5 is complete. Wave 6 independent durable-injection selection and 4,096-byte rendering is now the active phase.

## 2026-08-12 — Wave 6 durable injection reconciled

- Owned implementation: `src/compaction/durable.ts`; directly related contract adjustments: `test/compaction/pr8-budget.test.ts` and the PR-8 evidence-tag assertions in `test/compaction/durable.test.ts`.
- `DURABLE_BLOCK_MAX_BYTES` is independently `4_096`; the renderer now selects sanitized candidates under the complete framed UTF-8 budget, with deterministic semantic priority and strict prefix stop.
- Rendering remains read-only and retention-independent; omitted decisions remain available to pull recall. `[llm:eN]` reports each decision's actual retained evidence pointer count.
- Focused rerun: `npx vitest run test/compaction/pr8-budget.test.ts test/compaction/durable.test.ts test/compaction/prompt-contract.test.ts` → 78 passed, 0 failed.
- Full compaction rerun: `npx vitest run test/compaction` → 214 passed, 0 failed across 11 files.
- TypeScript check: `npx tsc --noEmit` → passed (exit 0).
- The full repository baseline still has two P0-A reliability failures concerning direct oversized writes/structured logging; they reproduce on the untouched pre-Wave-6 baseline and remain for Wave 7 integration/audit. No durable test was weakened to accommodate them.
- Wave 6 is complete. Wave 7 pressure/concurrency integration and repository audit is now the active phase.

## 2026-08-12 — Wave 7 pressure, concurrency, and seam audit reconciled

- Added test-only adversarial contracts in `test/memory/pr8-wave7-integration.test.ts`: protected foundational overflow, required proof overflow, same-project concurrent near-cap mutations, final LLM retryability/no completion marker, and recall-promotion protected refusal.
- Corrected two `src/memory/budget.ts` defects exposed by those contracts: explicit protected decision IDs now participate in irreducible-state classification, and minimal-state measurement no longer spreads disposable blockers/cache/files/task fields.
- Reconciled the two P0-A fixtures in `test/memory/p0-a-reliability.test.ts` to use schema-valid broad-ceiling decision topics while preserving exact 8,192/8,193 byte and structured size-rejection assertions.
- Focused Wave 7 rerun: `npx vitest run test/memory/p0-a-reliability.test.ts test/memory/pr8-wave7-integration.test.ts` → 21 passed, 0 failed.
- Broader integrated rerun: `npx vitest run test/memory/ test/compaction/ test/tools/recall.test.ts test/cli.test.ts` → 51 files, 951 passed, 0 failed after fixture reconciliation.
- TypeScript check: `npx tsc --noEmit` → passed (exit 0).
- Repository seam audit (src-only) found zero production `pruneOld()`/`pruneOldForCommit()` callers, all mutation callers routed through central fitting, read-only durable rendering, preserved PR-7 sanitization/augment-replace, and no PR-9/PR-10 scope leakage. Low-severity latent concerns remain: exported dead `pruneOldForCommit()` can return over-cap state if future callers misuse it, and direct commit failure reasons collapse to generic `commit-failed`; neither is an active production path.
- Decision: do not expand Wave 7 into PR-9 diagnostics, PR-10 dependency cleanup, or unrelated dead-seam refactoring. Preserve concerns for the independent Oracle attack surface.
- Wave 7 is complete. Wave 8 is now active: exact final release chain and evidence-only Oracle handoff.

## 2026-08-12 — Wave 8 release chain and handoff

- Exact implementation SHA: `abcbce9ae30e4c55b47261cee7971173023cfb79`.
- Local release chain passed on that SHA: `npm test` (51 files / 951 tests), `npx tsc --noEmit`, `npm run verify:host-contract`, `npm run build`, `npm run verify-cli-bundle`, `npm run smoke:cli` (checks 46–49), `bash -n install.sh`, `bash -n bin/tokenmaxxer`, and `git diff --check`.
- Build-generated tracked `dist/index.js` and `dist/tui.js` were restored after verification; the production/test tree remains exactly the implementation SHA.
- No GitHub CI run/job exists for the exact SHA because it is local and unpushed. The latest observed CI run is explicitly recorded as non-evidence in `oracle-investigation.md`.
- `docs/CRIP/PR-8/oracle-investigation.md` is complete as evidence-only handoff. No Oracle findings, Ship verdict, or PR-9 advancement is issued by this implementation lane.

## 2026-08-12 — Oracle blocker remediation wave

- B1 resolved in `src/memory/budget.ts`: stages 1–6 now perform genuine exact-byte pressure eviction of disposable completed audits, cache, health/quarantine metadata, sessions/sources, and active files; every non-stale pending audit guard remains retained; `truncateUtf8()` never exceeds budgets 0–3.
- B2 resolved in `src/compaction/durable.ts`: mandatory project/freshness framing is byte-budgeted with UTF-8-safe project truncation, preserving delimiters, DATA-only sanitization, strict prefix ordering, and the independent 4,096-byte ceiling.
- B3 resolved in `src/memory/writer.ts`: heuristic and final-LLM HEADER generation consume committed `MemoryMutationResult.memory`, not callback-carried pre-fit memory.
- B4 resolved in `src/memory/writer.ts`, `src/memory/merge.ts`, and `src/memory/extract-schema.ts`: heuristic producers and structured extraction now use the centralized creation bounds for task, paths, reasons, decisions, blockers, next steps, counts, and automatic heuristic decision fields; human-reviewed persisted text remains governed by broad persistence ceilings.
- Added focused regression suites: `test/memory/oracle-b1-storage.test.ts`, `test/compaction/oracle-b2-durable.test.ts`, `test/memory/oracle-b3-header.test.ts`, and `test/memory/oracle-b4-creation.test.ts`.
- Corrected the stale Wave-7 ephemeral-pressure assertion to reflect B1's required behavior: disposable blockers/cache are evicted and the mutation commits rather than being rejected as required-state overflow.
- Focused blocker matrix: 41 passed, 0 failed.
- Full local repository rerun: `npm test` → 55 files, 987 tests passed, 0 failed.
- TypeScript check: `npx tsc --noEmit` → passed (exit 0).
- Remediation is implementation-complete locally. Release-chain verification and `docs/CRIP/PR-8/oracle-rereview.md` remain pending independent focused Oracle re-review; no Ship verdict or PR-9 advancement is made here.
