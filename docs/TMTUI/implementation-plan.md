# TMTUI — Concrete Implementation Plan

**Program:** TokenMaxxer TUI (TMTUI)  
**Scope:** OpenCode composer memory-status integration  
**Status:** Implementation ready  
**Program overview:** [`README.md`](./README.md)  
**Concurrency rules:** [`concurrency.md`](./concurrency.md)

---

## 1. Release invariant

> **The TokenMaxxer composer status element is built with the reactive OpenTUI/Solid runtime and emits one finite, theme-native green pulse only after a successful durable STATE persistence; UI telemetry is best effort and can never change memory correctness.**

Corollaries:

1. `dist/tui.js` must not embed `solid-js/dist/server.js` as its reactive implementation.
2. A `session.idle` event alone must never turn the LED green.
3. Transcript reads, queue waiting, heuristic extraction, LLM work, no-op mutations, failed commits, and failed writes must not produce a success pulse.
4. A successful project-local STATE commit produces a pulse signal.
5. A successful global-fallback STATE commit produces the same pulse signal.
6. Failure to write/read the ephemeral pulse marker must not affect STATE commit success.
7. The UI uses the active OpenCode theme and has no permanent animation while idle.
8. TMTUI must not weaken any CRIP invariant.

---

## 2. Delivery strategy

Implement TMTUI as three narrowly scoped changesets.

### TMTUI-1 — Correct TUI build/runtime

**Can run during CRIP PR 8:** Yes.  
**Primary risk:** package/build-file overlap with later CRIP PR 10.

Purpose: make Solid reactivity real before changing status semantics.

Expected files:

```text
package.json
scripts/build-tui.ts              # recommended new file
.github/workflows/ci.yml           # or existing build verification location
src/tui.tsx                        # only if import/build compatibility requires it
dist/tui.js                        # regenerated tracked artifact
dist/tui.d.ts                      # regenerated if build emits it
```

#### 2.1 Split the TUI build from generic tsup bundling

Current build shape bundles `src/index.ts` and `src/tui.tsx` together through tsup. Replace that with:

- server/plugin entrypoint: existing tsup path;
- CLI entrypoint: existing tsup path;
- TUI entrypoint: Bun build with OpenTUI's Solid transform plugin.

Recommended build script shape:

```ts
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/tui.tsx"],
  outdir: "dist",
  format: "esm",
  target: "bun",
  plugins: [createSolidTransformPlugin()],
  external: [
    "@opencode-ai/plugin",
    "@opencode-ai/plugin/tui",
    "@opentui/solid",
    "@opentui/core",
    "@opentui/keymap",
    "zod",
  ],
})

if (!result.success) process.exit(1)
```

Treat this as a shape, not copy-paste authority: preserve whatever output/declaration settings are required by the current package contract.

#### 2.2 Verify the locked OpenTUI version first

Before changing dependency versions, verify the lockfile-resolved `@opentui/solid` exports `@opentui/solid/bun-plugin` and contains `createSolidTransformPlugin()`.

If yes, make no dependency upgrade.

If no, stop and make the smallest explicit compatibility change necessary; do not fold a broad dependency refresh into TMTUI. Coordinate any version move with CRIP PR 10.

#### 2.3 Add build regression gates

Add a deterministic post-build check. At minimum:

```bash
if grep -q 'solid-js/dist/server.js' dist/tui.js; then
  echo 'ERROR: TMTUI bundled Solid server runtime' >&2
  exit 1
fi
```

A stronger check should also assert that the built TUI still contains/loads the expected OpenTUI JSX runtime and that the `./tui` package export resolves.

Recommended npm scripts:

```text
build:tui
check:tui-bundle
```

Wire both into `npm run build` and CI.

#### 2.4 TMTUI-1 tests

Required:

- package build succeeds;
- `dist/tui.js` does not contain the server `createSignal` implementation;
- `npm run verify:host-contract` still passes;
- existing test suite passes;
- OpenCode can load the built `./tui` entrypoint;
- a minimal reactive smoke test proves a signal update changes rendered slot state.

**Exit gate:** the existing LED may still have old semantics, but a Solid signal update must now rerender the slot.

---

### TMTUI-2 — Commit-pulse protocol and visual component

**Can run during CRIP PR 8:** Yes, provided it does not modify `store.ts` yet.  
**Primary files:** new pulse module + `src/tui.tsx` + tests.

Purpose: replace long-running activity semantics with an event-shaped persistence signal and redesign the status element.

Expected files:

```text
src/memory/commit-pulse.ts         # recommended new module
src/memory/paths.ts                # only for a small dedicated marker-path helper, if desired
src/tui.tsx
test/memory/commit-pulse.test.ts   # recommended new tests
test/tui/...                       # build/render behavior as practical
```

The existing `activity-state.ts` can remain temporarily until TMTUI-3 removes its final call sites. Do not make TMTUI-2 depend on deleting it.

#### 2.5 Define the commit-pulse file

Recommended path:

```text
<globalProjectStorageDir(project)>/.commit-pulse
```

Recommended helpers:

```ts
export const MEMORY_COMMIT_RECENT_MS = 2_000

export function memoryCommitPulsePath(project: string): string

export async function recordMemoryCommit(project: string): Promise<void>

export async function readRecentMemoryCommit(
  project: string,
  now?: number,
): Promise<number | null>
```

`recordMemoryCommit()` writes only:

```json
{"committed_at": 1786492800000}
```

Rules:

- use `atomicWrite()` internally;
- swallow telemetry I/O failures;
- never contain memory/transcript/prompt data;
- do not refresh on an interval;
- do not delete immediately after write;
- malformed/future/stale timestamps return `null` (fail-closed) and are **never
  unlinked by the reader** — the marker is tiny and the next successful commit
  atomically overwrites it, so reader-side cleanup would only introduce a
  TOCTOU race in which a stale read could delete a freshly written marker
  (docs/TMTUI/TMTUI-review.md Finding 3). Any future cleanup must use
  compare-and-delete semantics, never a blind unlink by pathname after a stale
  read.

The 2-second recent window is intentionally longer than the TUI polling interval but short enough that an old marker cannot look like current activity after restart.

#### 2.5.1 Burst coalescing

The marker is a single timestamp file, not an event log. Two or more successful
commits between polls may overwrite the same marker before the TUI observes
every intermediate timestamp, and two commits within the same millisecond are
indistinguishable with a millisecond timestamp alone.

The intended invariant is:

> **A newly observed successful durable commit causes a visible pulse. Rapid
> commit bursts may coalesce into one pulse. Green must never represent a
> failed or uncommitted mutation.**

Do not introduce a queue/event log to achieve strict one-animation-per-physical-commit accounting unless real product evidence demands it.

#### 2.6 Replace activity UI state with a finite pulse state

Remove the `active + blink` presentation model from `src/tui.tsx`.

Recommended TUI state:

```ts
type PulseStage = "idle" | "bright" | "fade"

const [pulseStage, setPulseStage] = createSignal<PulseStage>("idle")
let lastSeenCommitAt = 0
```

Recommended timing:

```text
bright: 350 ms
fade:   450 ms
idle:   thereafter
```

When polling observes a recent `committed_at` value greater than `lastSeenCommitAt`:

1. set `lastSeenCommitAt` immediately;
2. cancel any existing local pulse timers;
3. set stage to `bright`;
4. after ~350 ms, set stage to `fade`;
5. after another ~450 ms, return to `idle`.

If multiple real commits arrive during a pulse, the newer timestamp restarts the pulse from bright.

The animation is based on detection time, not marker age, so every newly detected commit gets a complete visible pulse.

#### 2.7 Polling behavior

Recommended baseline poll:

```text
500 ms
```

Also subscribe to `session.idle` only as a **poll accelerator**:

```text
session.idle -> call poll() immediately
```

Do **not** set the pulse stage from `session.idle`.

This retains fast feedback without lying about whether persistence occurred.

If later measurement shows 500 ms is too slow, reduce conservatively. Do not introduce an unbounded fast filesystem polling loop for cosmetic latency.

#### 2.8 Visual contract

Idle:

```text
memory  ·
```

Bright:

```text
memory  ●
```

Fade:

```text
memory  •
```

Recommended JSX shape:

```tsx
<box flexDirection="row">
  <text fg={api.theme.current.textMuted}>memory  </text>
  <text fg={pulseStage() === "idle"
    ? api.theme.current.textMuted
    : api.theme.current.success}
  >
    {pulseStage() === "bright" ? "●" : pulseStage() === "fade" ? "•" : "·"}
  </text>
</box>
```

Presentation rules:

- no border;
- no background pill in the first implementation;
- no hard-coded color;
- no continuous blink;
- do not change the width of the component across pulse stages;
- keep `memory` stable so the composer does not visually jitter.

#### 2.9 TMTUI-2 tests

Commit-pulse module tests:

- records timestamp;
- reads a recent timestamp;
- rejects stale timestamp;
- rejects future timestamp;
- rejects malformed JSON;
- invalid markers return `null` without requiring destructive cleanup;
- reader is non-destructive: stale/future/malformed markers are left in place;
- a fresh atomically replaced marker is not lost after a stale read (TOCTOU regression);
- I/O failure does not throw from `recordMemoryCommit()`;
- path is derived from the global per-project namespace;
- marker contains no supplied memory payload because the API accepts no payload.

TUI behavior tests/smoke coverage:

- idle renders `memory  ·`;
- new commit timestamp starts `●`;
- pulse advances `● -> • -> ·`;
- same timestamp does not retrigger;
- newer timestamp retriggers;
- `session.idle` without a new commit never turns the indicator green;
- timers/subscriptions are cleaned up on component disposal.

**Exit gate:** TUI can render a truthful commit pulse when a synthetic marker appears, but production STATE commits are not wired to emit the marker yet.

---

### TMTUI-3 — Wire pulse to canonical successful persistence

**Can run concurrently with CRIP PR 8 implementation:** No.  
**Merge order:** CRIP PR 8 first, then rebase TMTUI-3 onto its final canonical commit boundary.

Purpose: emit the UI event from the one place that actually knows a durable STATE write succeeded.

Expected files after PR 8 settles:

```text
src/memory/store.ts
src/memory/writer.ts                # removal of old activity lifecycle only
src/memory/activity-state.ts        # delete if no remaining users
src/memory/commit-pulse.ts
test/memory/store.test.ts
other writer/store transaction tests as affected
```

#### 2.10 Instrument `commitMemoryExact()`, not `atomicWrite()`

At the post-PR-8 canonical persistence boundary, emit the pulse after either successful write path:

```ts
await atomicWrite(projectMemoryPath(project), json)
void recordMemoryCommit(project)
return { ok: true, path }
```

and after successful global fallback:

```ts
await atomicWrite(globalMemoryPath(project), json)
void recordMemoryCommit(project)
return { ok: true, path: globalMemoryPath(project) }
```

Refactor to one success helper if that makes double-emission impossible.

Hard requirements:

- marker write occurs only after STATE write success;
- marker failure is ignored;
- exactly one marker write is attempted per successful logical commit;
- no marker on validation failure;
- no marker on size-budget rejection;
- no marker when project and global writes both fail;
- no marker on mutation `noop`;
- both project-local and global-fallback success pulse.

#### 2.11 Remove old `writeMemoryOnIdle()` activity signaling

Delete:

```ts
const stopActivity = beginMemoryActivity(project)
...
finally {
  stopActivity()
}
```

and remove the import.

Once no production call sites remain, remove `src/memory/activity-state.ts` and migrate/delete its tests.

Do not preserve the old optimistic idle LED behavior.

#### 2.12 TMTUI-3 tests

Extend canonical store/transaction tests to prove:

- committed mutation records one pulse;
- direct `writeMemory()` success records one pulse;
- global fallback success records one pulse;
- `noop` mutation records none;
- validation failure records none;
- over-budget rejection records none;
- I/O failure records none;
- telemetry failure does not change a successful commit result;
- commit revision/state content is unchanged by telemetry.

Writer integration tests must prove `writeMemoryOnIdle()` no longer creates activity state merely because processing started.

**Exit gate:** production composer pulse is causally downstream of actual STATE persistence.

---

## 3. Build and CI hardening

After TMTUI-3, CI should enforce the complete contract.

Recommended gates:

```text
npm run build
npm run check:tui-bundle
npm run verify:host-contract
npm test
```

Add a focused TMTUI smoke test if OpenCode can be launched cheaply enough in CI:

1. load the built package's `./tui` export;
2. mount/register the slot;
3. synthesize/write a commit marker;
4. confirm reactive slot state changes;
5. confirm the state returns to idle.

The smoke test should fail if Solid server runtime leakage returns even if grep-based checks are accidentally weakened later.

---

## 4. Manual acceptance test

Run against a real OpenCode session after all automated gates pass.

### Test A — idle

Expected:

```text
memory  ·
```

No blinking while typing or while the session is idle.

### Test B — idle event with no write

Trigger a path that results in `no-messages`, cache/no-op behavior, or otherwise no durable commit.

Expected: LED remains idle.

### Test C — project-local STATE commit

Trigger a memory update and independently verify STATE revision/mtime advances.

Expected: one visible green `● -> • -> ·` pulse.

### Test D — repeated commits

Trigger two valid commits separated by enough time to observe both.

Expected: one pulse per successful commit.

### Test E — read-only project/global fallback

Use a worktree where project-local STATE persistence fails but global fallback succeeds.

Expected: STATE persists globally and the same pulse appears.

### Test F — forced commit failure

Make both STATE destinations unavailable or otherwise force the canonical commit to fail.

Expected: no green success pulse.

### Test G — theme variation

Check at least one dark and one light/high-contrast OpenCode theme.

Expected: label/idle dot remain legible and subdued; success pulse uses the theme's success color and does not introduce hard-coded visual artifacts.

---

## 5. Rollback boundaries

Each TMTUI changeset must be independently reversible.

- Reverting TMTUI-1 restores the prior build path without touching memory semantics.
- Reverting TMTUI-2 removes the new pulse presentation/protocol without touching persistence authority.
- Reverting TMTUI-3 removes telemetry emission without changing the underlying STATE commit result.

No TMTUI rollback may require migrating `STATE.json` because TMTUI adds no durable schema fields.

---

## 6. Definition of done

TMTUI is complete when all of the following are true:

- [ ] TUI is built with OpenTUI's Solid transform pipeline.
- [ ] `dist/tui.js` does not contain the Solid server runtime implementation.
- [ ] Composer slot rerenders on signal updates.
- [ ] Existing long-running memory-activity marker is no longer the status authority.
- [ ] New global per-project commit marker contains only `committed_at`.
- [ ] `session.idle` cannot directly cause green status.
- [ ] Successful project-local STATE commit pulses once.
- [ ] Successful global-fallback STATE commit pulses once.
- [ ] Failed/no-op persistence does not pulse.
- [ ] Marker failure cannot fail memory persistence.
- [ ] UI renders `memory  ·` when idle.
- [ ] UI renders finite `● -> • -> ·` success animation.
- [ ] UI uses current OpenCode theme colors.
- [ ] No permanent blink timer remains.
- [ ] Host-contract checks pass.
- [ ] Full test suite passes.
- [ ] Real OpenCode manual acceptance test passes.
- [ ] TMTUI-3 is rebased on the final CRIP PR 8 transaction/storage boundary before merge.
