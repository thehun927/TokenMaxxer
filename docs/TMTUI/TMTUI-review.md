# TMTUI Pre-PR-8 Review

**Branch reviewed:** `feat/tmtui`  
**Reviewed head:** `a92751f9d16220b99d4703cfafc6943b43772762`
**Base:** `6f1412fef2479b7a10f42d4e49f1fdc390a3cfc4`  
**Review purpose:** pre-PR-8 quality gate for TMTUI-1 / TMTUI-2 before the branch is parked awaiting TMTUI-3.  
**Gate result:** **Remediation applied; pending clean-run validation and CI result.**

---

## 1. Executive summary

The TMTUI branch is architecturally headed in the right direction.

The important original bug is fixed correctly: the generated TUI now contains Solid's reactive signal machinery instead of the non-reactive server `createSignal` implementation. The UX also matches the intended design: quiet `memory  ·` while idle and a finite theme-native `● -> • -> ·` pulse rather than a perpetual blinking LED. `session.idle` only accelerates polling and does not itself manufacture a green pulse.

The commit-pulse telemetry boundary is also appropriately isolated from durable memory authority. It stores only a timestamp in the global hashed project namespace and deliberately swallows telemetry I/O failures.

However, the review found four issues worth resolving before PR 8 finishes:

1. **BLOCKER:** CI does not install Bun even though `npm run build` now requires it.
2. **HIGH:** `src/tui.tsx` imports `resolveProjectPath` through `memory/store`, unnecessarily coupling the TUI bundle to the exact module PR 8 is rewriting and pulling substantial memory/storage code into `dist/tui.js`.
3. **MEDIUM:** reader-side stale-marker cleanup has a TOCTOU race that can delete a newly written fresh commit marker.
4. **MEDIUM/LOW:** an in-flight asynchronous poll can complete after component cleanup and create a new pulse timer after cleanup has already run.

These fixes are all parallel-safe and should be completed now. None requires touching the canonical STATE commit boundary reserved for TMTUI-3.

---

## 2. Confirmed strengths

### 2.1 Solid/OpenTUI build correction is materially correct

The branch replaces the previous `tsup src/tui.tsx` build with Bun and `createSolidTransformPlugin()` from `@opentui/solid/bun-plugin`.

The generated `dist/tui.js` now contains actual reactive Solid internals, including:

- observer tracking;
- `observerSlots`;
- `readSignal`;
- `writeSignal`;
- reactive dependency propagation.

This addresses the original defect where `setActive()` / `setBlink()` changed closure state without triggering OpenTUI re-rendering.

The current bundle comment may still contain the resolved source path `solid-js/dist/server.js`; therefore checking only for that literal comment would be a false positive. The branch correctly moved toward behavioral/runtime-shape verification rather than relying only on the comment string.

### 2.2 TUI UX matches the intended TMTUI design

Current intended states:

```text
idle:    memory  ·
bright:  memory  ●
fade:    memory  •
idle:    memory  ·
```

Positive properties already present:

- no perpetual blinking;
- no optimistic green state on `session.idle`;
- finite pulse duration;
- theme-native `success` color;
- muted idle label/dot;
- same/older marker timestamps do not retrigger the pulse.

### 2.3 Telemetry is isolated from STATE authority

`src/memory/commit-pulse.ts` has the correct conceptual boundary:

- marker lives in the stable global per-project namespace;
- payload is only `{"committed_at": <timestamp>}`;
- no memory, prompt, transcript, revision, or authority data is stored;
- telemetry write failures are swallowed;
- telemetry cannot make a successful STATE commit fail;
- generic `atomicWrite()` call sites are not being globally instrumented.

This isolation must remain true in TMTUI-3.

### 2.4 TMTUI correctly avoided the PR-8 commit boundary

The branch has not yet modified `src/memory/store.ts` or `src/memory/writer.ts` for the final success pulse hook.

That is correct.

CRIP PR 8 owns the canonical mutation/commit semantics and must settle before TMTUI-3 wires the pulse into the final successful persistence boundary.

---

# 3. Required remediation

## Finding 1 — BLOCKER: CI does not install Bun

### Evidence

`package.json` now makes the normal build depend on Bun:

```json
"build:tui": "bun run scripts/build-tui.ts"
```

and `npm run build` invokes `build:tui`.

The current `.github/workflows/ci.yml` only establishes Node/npm before running:

```text
npm ci
npm test
npx tsc --noEmit
npm run verify:host-contract
npm run build
...
```

There is no explicit Bun setup step.

### Risk

A pull request targeting `main` may reach `npm run build` and fail because the CI environment has not established a `bun` executable.

Local build evidence is not enough; the repository build contract needs to provision every runtime it requires.

### Required fix

Add an explicit Bun setup step to `.github/workflows/ci.yml` before the build is run.

Recommended shape:

```yaml
- name: Set up Bun
  uses: oven-sh/setup-bun@v2
  with:
    bun-version: <PINNED_VERSION>
```

Prefer the Bun version actually used to validate TMTUI locally rather than silently following `latest`.

Do **not** turn this remediation into a broad dependency/toolchain upgrade; PR 10 still owns wider release/dependency hygiene.

### Acceptance criteria

- clean GitHub Actions runner installs Bun explicitly;
- `npm ci` succeeds;
- `npm run build` succeeds on CI;
- `npm run check:tui-bundle` succeeds on CI;
- no local preinstalled Bun assumption remains.

---

## Finding 2 — HIGH: TUI imports storage authority through `memory/store`

### Current code

`src/tui.tsx` currently imports:

```ts
import { resolveProjectPath } from "./memory/store"
```

But `resolveProjectPath()` belongs to the deliberately-created leaf module:

```text
src/memory/paths.ts
```

`store.ts` imports/re-exports it only for compatibility.

### Observed consequence

The generated TUI bundle contains substantially more memory subsystem code than the UI actually needs, including modules such as:

```text
src/util/fs.ts
src/memory/paths.ts
src/memory/schema.ts
src/memory/extract-schema.ts
...
```

The TUI should not need the memory schema, migration, storage authority, or transaction implementation merely to resolve the current project path.

### Why this matters before PR 8

`src/memory/store.ts` is the exact area CRIP PR 8 is actively changing.

TMTUI-1/2 should remain independent of PR 8 until the deliberate TMTUI-3 hook.

Importing a leaf helper through `store.ts` creates unnecessary coupling and increases rebase/bundle risk.

### Required fix

Change:

```ts
import { resolveProjectPath } from "./memory/store"
```

to:

```ts
import { resolveProjectPath } from "./memory/paths"
```

Then rebuild `dist/tui.js`.

### Recommended regression gate

Extend `scripts/check-tui-bundle.mjs` to reject accidental TUI dependency on storage-authority modules.

At minimum consider rejecting markers equivalent to:

```text
src/memory/store.ts
src/memory/schema.ts
src/memory/extract-schema.ts
```

Only use markers proven stable in the actual Bun output; avoid a brittle gate that fails on harmless comments or minifier behavior.

The invariant is:

> TMTUI-1/2 may depend on leaf path helpers and commit-pulse telemetry, but must not bundle the durable STATE transaction/schema subsystem merely to render the composer indicator.

### Acceptance criteria

- `src/tui.tsx` imports `resolveProjectPath` directly from `./memory/paths`;
- rebuilt bundle no longer drags unnecessary storage/schema implementation into TUI;
- package exports still work;
- TUI behavior remains unchanged;
- the final TMTUI-3 persistence hook remains the only intentional interaction with canonical durable commit semantics.

---

## Finding 3 — MEDIUM: stale-marker unlink has a TOCTOU race

### Current pattern

`readRecentMemoryCommit()` currently:

1. reads `.commit-pulse`;
2. parses the timestamp;
3. determines it is stale/future/malformed;
4. unlinks the path best effort.

### Race

A valid new commit may replace the marker between step 1 and step 4:

```text
TUI reader                         STATE writer
----------                         ------------
read old stale marker
                                   durable commit succeeds
                                   atomic replace fresh .commit-pulse
unlink(.commit-pulse)
```

The reader can therefore delete the **new fresh marker**, causing a valid successful persistence pulse to be missed.

This does not threaten STATE correctness, but it violates the UI reliability goal.

### Required fix

Do not unlink stale/future/malformed pulse markers from the normal reader.

Prefer:

```ts
if (!fresh) return null
```

and equivalent behavior for malformed payloads.

The marker is tiny and fixed-size. The next successful commit atomically overwrites it, so reader cleanup provides little value compared with the concurrency race it introduces.

If cleanup is considered necessary later, it must be implemented with compare-and-delete semantics or another race-safe mechanism; do not blindly unlink by pathname after a stale read.

### Test changes

Current tests explicitly expect stale/future/malformed markers to disappear. Update them to verify:

- stale marker -> `null`;
- future marker -> `null`;
- malformed marker -> `null`;
- invalid marker never creates a pulse;
- reader does not require destructive cleanup.

Add a regression test demonstrating that a fresh replacement is not lost due to stale-reader cleanup, if practical at the module level.

### Acceptance criteria

- reader is non-destructive for invalid/stale telemetry;
- new commits cannot be deleted by a stale read;
- telemetry remains bounded to one tiny overwritten file;
- all existing validity/freshness behavior remains fail-closed.

---

## Finding 4 — MEDIUM/LOW: asynchronous poll may outlive component cleanup

### Current behavior

The component correctly cleans up:

```ts
onCleanup(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (pulseTimer) clearTimeout(pulseTimer)
  unsubscribe?.()
})
```

However, `readRecentMemoryCommit(project)` may already be in flight.

Its `.then()` can run after cleanup and call `startPulse()`, which can create a new timeout after cleanup already cleared the previous timer.

### Required fix

Add a component disposal guard.

Recommended pattern:

```ts
let disposed = false

const poll = () => {
  if (!project || disposed || pollInFlight) return
  pollInFlight = true

  void readRecentMemoryCommit(project)
    .then((committedAt) => {
      if (disposed) return
      if (committedAt !== null && committedAt > lastSeenCommitAt) {
        lastSeenCommitAt = committedAt
        startPulse()
      }
    })
    .finally(() => {
      pollInFlight = false
    })
}

onCleanup(() => {
  disposed = true
  ...
})
```

Also consider guarding `startPulse()` itself with `if (disposed) return` for defense in depth.

### Acceptance criteria

- no timer can be created after component disposal;
- no signal update occurs from a completed async poll after disposal;
- interval, pulse timer, and event subscription are all cleaned up;
- no behavioral change while component is mounted.

---

# 4. Contract clarification: burst commits may coalesce

The current protocol uses a single timestamp file and polling.

That is appropriate for a lightweight status indicator, but it does not provide event-log semantics.

Two or more successful commits between polls may overwrite the same marker before the TUI observes every intermediate timestamp. Two commits occurring within the same millisecond can also be indistinguishable with a millisecond timestamp alone.

Do **not** solve this by introducing a queue/event log unless real product evidence demands it.

Document the intended invariant as:

> **A newly observed successful durable commit causes a visible pulse. Rapid commit bursts may coalesce into one pulse. Green must never represent a failed or uncommitted mutation.**

This is the correct semantic priority for the composer indicator.

Recommended acceptance wording should avoid claiming strict one-animation-per-physical-commit accounting.

---

# 5. Documentation correction

`docs/TMTUI/implementation-status.md` currently describes the build ordering differently from the actual `package.json` command sequence.

The actual sequence begins approximately:

```text
rm -rf dist
build:tui
build:tui-decl
tsup index
tsup cli
bundle checks
```

Update the status document so its implementation evidence reflects the real command order.

This is documentation-only and not a production defect.

---

# 6. Validation requirements after remediation

After applying the above fixes, rerun the complete TMTUI-1/2 gate.

Required:

```text
npm test
npx tsc --noEmit
npm run verify:host-contract
npm run build
npm run check:tui-bundle
npm run verify-cli-bundle
npm run smoke:cli
bash -n install.sh
bash -n bin/tokenmaxxer
git diff --check
```

Also rerun the focused commit-pulse suite.

### GitHub CI

A draft PR targeting `main` should be opened after the remediation commit so the real GitHub Actions workflow executes in a clean runner.

The branch push alone does not currently exercise the PR workflow because CI is configured for:

- pushes to `main`;
- pull requests targeting `main`.

Do not treat local success as the final CI gate.

---

# 7. TMTUI-3 remains blocked on PR 8

None of the remediation above changes the TMTUI/CRIP serialization rule.

Do **not** add the final `recordMemoryCommit()` call to pre-PR-8 `store.ts` merely to finish the TMTUI branch sooner.

After PR 8 lands:

1. rebase `feat/tmtui` onto post-PR-8 `main`;
2. inspect the final `mutateMemory()` / commit architecture from scratch;
3. identify the canonical successful durable persistence boundary;
4. emit the pulse only after a successful local or global STATE commit;
5. emit no pulse for:
   - noop;
   - budget rejection;
   - validation failure;
   - lock timeout;
   - unavailable authoritative state;
   - transaction abort;
   - project write failure followed by global fallback failure;
   - any other non-committed mutation outcome;
6. keep `recordMemoryCommit()` best effort so telemetry failure cannot alter the mutation result;
7. reconcile/remove the legacy memory-activity mechanism only against the final post-PR-8 writer/store shape;
8. rerun the full CRIP + TMTUI test and build gates.

Do not mechanically resolve `store.ts` conflicts during rebase. Re-derive the TMTUI-3 hook from PR 8's final semantics.

---

# 8. Recommended subagent split for remediation

Luna may delegate these in parallel:

### Build/CI agent

Own:

- `.github/workflows/ci.yml` Bun setup;
- bundle gate refinement;
- rebuild verification;
- generated `dist/tui.*` consistency.

### TUI isolation/lifecycle agent

Own:

- direct `memory/paths` import;
- disposal guard;
- bundle-size/dependency inspection;
- manual source-level review of slot lifecycle.

### Pulse protocol agent

Own:

- removal of destructive reader cleanup;
- concurrency regression tests;
- freshness/invalid-marker test updates;
- burst-coalescing contract documentation.

### Review/validation agent

Own:

- full test/build matrix;
- `git diff --check`;
- documentation consistency;
- draft-PR CI results;
- confirmation that no pre-PR-8 `store.ts`/`writer.ts` production hook slipped in.

---

# 9. Final pre-PR-8 gate

TMTUI-1/2 may be considered **parked and ready for PR 8 to finish** when all of the following are true:

- [x] GitHub CI explicitly installs Bun.
- [ ] Clean PR CI passes (pending after this remediation push).
- [x] TUI imports project resolution directly from `memory/paths`.
- [x] Rebuilt TUI bundle no longer unnecessarily drags in durable storage/schema implementation.
- [x] Reader-side destructive stale-marker cleanup is removed or made provably race-safe.
- [x] Async poll completion cannot create timers/update state after component disposal.
- [x] Commit-pulse tests are updated and pass.
- [x] Full repository test/typecheck/build/smoke gate passes locally.
- [x] Generated `dist/tui.js` and `dist/tui.d.ts` match source/build output.
- [x] TMTUI documentation reflects the actual build sequence and burst-coalescing semantics.
- [x] No TMTUI-3 persistence hook has been added to obsolete pre-PR-8 commit semantics.

Once that checklist is green, freeze the branch except for rebase maintenance until CRIP PR 8 lands.

Then proceed with TMTUI-3.
