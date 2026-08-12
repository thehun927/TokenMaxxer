# PR-9 Implementation / Decision Log

Append-only log for CRIP PR-9 implementation decisions, validation results,
deviations, and unresolved blockers.

## 2026-08-12 — Baseline reconciliation

- Pulled `origin/main` fast-forward from `79d17e0` to `d0f8031`.
- Planning baseline remains `4df7873856e5f5714e45c120e1224e28450f4ee7`.
- PR-8 final residual implementation remains `15d3bb55b180c1db4981abb517f6bd159c68e049`.
- PR-8 final validation head remains `79d17e0258176cad83dd862cbfa1561c177e10fd`.
- Current main includes the separately validated TMTUI commit-pulse work in
  `src/memory/commit-pulse.ts` and `src/tui.tsx`; `.commit-pulse` semantics and
  the TUI bundle check are protected scope.
- Current PR-9 seams confirmed: process-global `lastCompactionTimestamp` /
  `setLastCompaction` in `src/tools/status.ts`; local-only prompt artifact and
  hook-time timestamping in `src/index.ts`; generic active-file labels in
  `src/memory/writer.ts`; best-effort persistence seams require bounded warning
  hardening.
- Wave 1 is test-only and will be integrated before production waves.

## 2026-08-12 — Wave 1 integrated validation

- Integrated six test-only contract files from Agents 1A, 1B, and 1C.
- Focused command rerun by Luna:
  `npx vitest run test/diagnostics/artifacts.test.ts test/tools/pr9-status.test.ts test/diagnostics/compaction.test.ts test/index-pr9-compaction.test.ts test/memory/pr9-persistence-warning.test.ts test/memory/pr9-file-activity.test.ts`
- Actual result: 6 test files, 72 tests; 50 passed and 22 failed. The 28
  artifact/status tests passed. The 22 expected baseline failures are the
  missing PR-9 production seams: compaction diagnostics module/result handler
  and prompt bound (8), unexpected best-effort warning handling/bounds (3),
  and accurate file-activity classification/stale-reason replacement (11).
- `npx tsc --noEmit`: passed with no output.
- `git diff --check`: passed.

## 2026-08-12 — Wave 5 integrated validation

- Hardened best-effort terminal/model-health persistence in
  `src/memory/writer.ts`: unexpected throws are caught, warnings are bounded
  to 500 characters, and required audit-guard failure remains fail-closed.
- Luna rerun: `npx vitest run test/memory/pr9-persistence-warning.test.ts` —
  1 file, 15/15 passed.
- Luna rerun:
  `npx vitest run test/memory/writer.test.ts test/memory/writer-llm.test.ts test/memory/writer-nongit.test.ts test/memory/writer-header.test.ts test/memory/transaction.test.ts test/memory/tmtui3-pulse-writer.test.ts`
  — 6 files, 133/133 passed.
- `npx tsc --noEmit`: passed with no output.
- `git diff --check`: passed. No TUI or commit-pulse source changes.

## 2026-08-12 — Wave 6 integrated validation

- Added transient completed-tool activity categorization in `writer.ts` and
  current-session reason replacement; no durable schema/version bump and no
  transient activity object is persisted.
- Luna rerun:
  `npx vitest run test/memory/pr9-file-activity.test.ts test/memory/writer.test.ts test/memory/merge.test.ts test/memory/writer-header.test.ts`
  — 4 files, 111/111 passed.
- `npx tsc --noEmit`: passed with no output.
- `git diff --check`: passed after removing one trailing-whitespace defect.
- TMTUI commit-pulse source remains unchanged.
- Test-only repair deviations resolved before this validation: missing status
  filesystem imports and non-unique mocked project hashes in the Agent 1A
  tests.
- Wave 1 production behavior remains intentionally unimplemented; failures
  are carried forward as Wave 2–6 acceptance evidence.

## 2026-08-12 — Wave 2 integrated validation

- Implemented centralized diagnostic artifact storage in
  `src/diagnostics/artifacts.ts` and typed contracts in
  `src/diagnostics/artifacts.types.ts`; added project-local path helper in
  `src/memory/paths.ts`.
- Canonical behavior validated: explicit artifact filenames, UTF-8 byte limit
  before disk, atomic project-local then hashed-global fallback, typed
  `ok|missing|unavailable` reads, newest mtime selection with project tie,
  safe-name rejection, no cache, and bounded failure results.
- Luna rerun:
  `npx vitest run test/diagnostics/artifacts.test.ts test/tools/pr9-status.test.ts`
  — 2 files, 32/32 passed.
- Luna rerun: `npx tsc --noEmit` — passed with no output.
- `git diff --check` passed. `src/util/fs.ts` was restored to baseline and is
  outside Wave 2 ownership.

## 2026-08-12 — Wave 3 integrated validation

- Added pure bounded compaction diagnostic builders/validator and wired
  `src/index.ts` to separate prompt observation from successful
  `session.compacted` completion.
- Removed all index imports/calls of `lastCompactionTimestamp` and
  `setLastCompaction`; their remaining definitions are isolated to
  `src/tools/status.ts` and are Wave 4 scope.
- Focused Luna rerun:
  `npx vitest run test/diagnostics/compaction.test.ts test/index-pr9-compaction.test.ts`
  — 2 files, 39/39 passed.
- Regression/compaction Luna rerun:
  `npx vitest run test/index.test.ts test/diagnostics/ test/compaction/`
  — 15 files, 289/289 passed.
- `npx tsc --noEmit`: passed with no output.
- `git diff --check`: passed. No TUI or commit-pulse files changed.

## 2026-08-12 — Wave 4 integrated validation

- Replaced process-global compaction status with separate durable result and
  prompt artifact reads in `src/tools/status.ts`.
- Removed `lastCompactionTimestamp` and `setLastCompaction` from status; no
  module cache, STATE write, revision mutation, IdleWriteOutcome change, or
  TUI pulse path is used.
- Luna rerun:
  `npx vitest run test/tools/status.test.ts test/tools/status-extended.test.ts test/tools/pr9-status.test.ts test/diagnostics/artifacts.test.ts test/index.test.ts test/index-pr9-compaction.test.ts`
  — 6 files, 83/83 passed.
- `npx tsc --noEmit`: passed with no output.
- `git diff --check`: passed.
