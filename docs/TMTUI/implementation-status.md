# TMTUI implementation status

## Baseline

- TMTUI branch: `feat/tmtui`
- Post-PR-8 rebase base: `ae35be8305fcbb0d39572062af4d3ef7bb971360` (`origin/main`)
- Pre-rebase TMTUI head: `01ae2c06c5c11f33aafc3d8f45dd4abc2e882dd2`
- CRIP PR 8 is complete/Ship; PR 9 remains next and was not modified.

## Completed work

### TMTUI-1 — build/runtime

- Replaced the TUI tsup path with Bun + `createSolidTransformPlugin()` from the locked OpenTUI 0.4.5 dependency.
- Preserved server and CLI builds, package exports, and `dist/tui.d.ts` through a separate declaration-only TypeScript step. The actual build order is `rm -rf dist` → `build:tui` → `build:tui-decl` → server `tsup` → CLI `tsup` → TUI and CLI checks.
- Added `build:tui`, `build:tui-decl`, and `check:tui-bundle` gates.
- The gate rejects the server `createSignal` implementation and requires reactive-only `writeSignal`/`observerSlots` markers.

### TMTUI-2 — protocol and UX

- Added global per-project `.commit-pulse` telemetry containing only `committed_at`.
- Added fresh/stale/future/malformed marker handling with fail-closed `null` reads and I/O failure swallowing.
- The reader is strictly non-destructive: invalid markers are never unlinked, eliminating the TOCTOU race where a stale read could delete a freshly atomically replaced marker (TMTUI-review.md Finding 3).
- Replaced the old activity LED with quiet `memory  ·` and finite theme-native `● -> • -> ·` pulse behavior.
- `session.idle` accelerates polling only; it cannot create a pulse.
- Burst semantics documented: a newly observed successful durable commit causes a visible pulse; rapid commit bursts may coalesce into one pulse (TMTUI-review.md §4).

### TMTUI-3 — post-PR8 persistence integration

- Canonical hook: `commitMemoryExact()` in `src/memory/store.ts`, after successful project-local or global-fallback STATE persistence.
- Both paths converge on one success epilogue that invalidates cache, emits one `void recordMemoryCommit(project)`, and returns the actual written path.
- No pulse occurs for noop, unavailable, lock timeout, budget rejection, validation failure, size-cap failure, callback failure, transaction failure, or both-destination failure.
- `recordMemoryCommit()` remains fire-and-forget and best effort; telemetry cannot change authoritative mutation results.
- Removed the obsolete `beginMemoryActivity()` writer lifecycle and deleted `src/memory/activity-state.ts` plus its tests.

## Design deviation record

1. **Plan proposal:** use a literal `grep -q 'solid-js/dist/server.js' dist/tui.js` regression check.
   **Finding:** the OpenTUI Bun transform correctly replaces the runtime but preserves the resolved `server.js` path in a bundle comment.
   **Implementation:** check the actual server `createSignal` shape is absent and require reactive-only markers (`writeSignal` or `observerSlots`).
   **Invariant impact:** none; the check is stricter about runtime behavior and avoids a false positive.

2. **Plan proposal:** let the generic build emit TUI declarations alongside the other entries.
   **Finding:** `Bun.build` emits no declarations, and the generic clean build can remove TUI artifacts.
   **Implementation:** build server/CLI first, then Bun TUI JS, then a dedicated declaration-only TypeScript step, followed by the TUI bundle gate.
   **Invariant impact:** package exports and declaration availability are preserved.

## Verification evidence

- `npm test`: 1,049 tests passed, 1 skipped, across 59 files.
- `npx tsc --noEmit`: passed.
- `npm run verify:host-contract`: passed.
- `npm run build`: passed; `dist/index.js`, `dist/tui.js`, `dist/tui.d.ts`, and `dist/cli.js` were produced.
- `npm run check:tui-bundle`: passed with reactive runtime markers.
- `npm run verify-cli-bundle`: passed.
- `npm run smoke:cli`: passed (`46-49`).
- `bash -n install.sh`, `bash -n bin/tokenmaxxer`, and `git diff --check`: passed.
- Focused pre-PR8 commit-pulse suite: 17 tests passed (invalid markers return `null` without deletion; reader is non-destructive; fresh marker survives a stale read).
- Focused post-PR8 suites: 66 tests passed — `store-commit-pulse.test.ts` (10), `tmtui3-pulse-store.test.ts` (19), `tmtui3-pulse-writer.test.ts` (7), `commit-pulse.test.ts` (17), and `transaction.test.ts` (13). Coverage includes local/global success, telemetry isolation, non-committed outcomes, exact-once behavior, writer integration, transaction semantics, and legacy activity absence.
- CI provisions Bun `1.3.14` explicitly and runs `check:tui-bundle` as a named step. Final-head GitHub Actions run `31600259715` passed on `7f72152`.
- No component-level TUI test was added: the repository has no OpenTUI mount/render harness or existing `test/tui` fixture, and the bounded test lane could not exercise the slot without production refactoring. The source-level contract remains verified by typecheck, the reactive bundle gate, and manual code review; component behavior remains a manual OpenCode acceptance item.

## Final validation and acceptance

- TMTUI-1: complete.
- TMTUI-2: complete.
- TMTUI-3: complete at final commit `1a4e801` plus the generated TUI artifact follow-up.
- Manual OpenCode mount/render acceptance was unavailable in this environment; source-level lifecycle review, reactive bundle checks, and deterministic protocol/transaction tests are the available evidence.
- `dist/index.js` was regenerated because the post-PR8 server bundle includes the canonical store hook. Its large format-level diff reflects the repository's floating `tsup` toolchain output rather than broad TMTUI source scope; dependency/toolchain pinning remains PR 10 work.
