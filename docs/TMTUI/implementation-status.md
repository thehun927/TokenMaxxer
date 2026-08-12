# TMTUI implementation status

## Baseline

- TMTUI branch: `feat/tmtui`
- TMTUI base: `6f1412fef2479b7a10f42d4e49f1fdc390a3cfc4` (`origin/main` at branch creation)
- CRIP local `main` advanced to PR 8 Wave 4 at `34d777c`; its `store.ts`/`writer.ts` work remains active and is not present on this branch.
- No TMTUI production hook has been added to `store.ts` or `writer.ts`.

## Completed parallel-safe work

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

- `npm test`: 861 tests passed across 47 files.
- `npx tsc --noEmit`: passed.
- `npm run verify:host-contract`: passed.
- `npm run build`: passed; `dist/index.js`, `dist/tui.js`, `dist/tui.d.ts`, and `dist/cli.js` were produced.
- `npm run check:tui-bundle`: passed with reactive runtime markers.
- `npm run verify-cli-bundle`: passed.
- `npm run smoke:cli`: passed (`46-49`).
- `bash -n install.sh`, `bash -n bin/tokenmaxxer`, and `git diff --check`: passed.
- Focused commit-pulse suite: 17 tests passed (invalid markers return `null` without deletion; reader is non-destructive; fresh marker survives a stale read).
- CI now provisions Bun `1.3.14` explicitly and runs `check:tui-bundle` as a named step. Clean GitHub Actions execution remains pending after this remediation push.
- No component-level TUI test was added: the repository has no OpenTUI mount/render harness or existing `test/tui` fixture, and the bounded test lane could not exercise the slot without production refactoring. The source-level contract remains verified by typecheck, the reactive bundle gate, and manual code review; component behavior remains a manual OpenCode acceptance item.

## Outstanding CRIP dependency

TMTUI-3 must wait until CRIP PR 8 Waves 4–5 are final and landed. After rebasing onto that post-PR-8 `main`:

1. Re-inspect the final `mutateMemory()` / `commitMemoryExact()` transaction boundary.
2. Emit exactly one best-effort pulse only after a successful committed local or global STATE write.
3. Emit none for noop, budget rejection, validation failure, lock timeout, unavailable state, commit failure, or aborted mutation.
4. Reconcile any existing `beginMemoryActivity()` removal from CRIP rather than mechanically applying the old cleanup plan.
5. Rerun the complete CRIP + TMTUI validation gate.

TMTUI is not merge-ready until this rebase and TMTUI-3 wiring are complete. The parallel-safe remediation is locally validated; the draft PR's clean-run CI result remains the final pre-PR-8 gate.
