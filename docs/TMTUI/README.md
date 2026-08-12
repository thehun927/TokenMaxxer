# TokenMaxxer TUI (TMTUI)

TMTUI is the focused implementation program for TokenMaxxer's OpenCode composer integration.

Its first target is the `memory` status element rendered in OpenCode's `session_prompt_right` slot. The goal is to make that element technically correct, truthful about persistence, visually native to OpenCode, and protected by build/runtime regression tests.

## Status

**Planning complete — implementation ready.**

TMTUI is intentionally separate from the Concrete Reliability Implementation Plan (CRIP). CRIP owns TokenMaxxer's durable-memory correctness and reliability program; TMTUI owns the TUI build/runtime boundary and presentation of memory persistence state.

See:

- [`implementation-plan.md`](./implementation-plan.md) — concrete implementation sequence and acceptance criteria.
- [`concurrency.md`](./concurrency.md) — rules for running TMTUI while CRIP is active.

## Confirmed current problems

### 1. The built TUI contains Solid's server runtime

`src/tui.tsx` uses Solid signals correctly in source form, but the current `dist/tui.js` bundles `solid-js/dist/server.js`. That server implementation of `createSignal()` mutates a stored value without the client-side reactive graph required to invalidate and rerender the OpenTUI node.

The visible consequence is exactly what the current status LED exhibits: event/timer callbacks can call `setActive()` and `setBlink()`, but the composer slot can remain rendered in its original muted state.

OpenTUI provides `createSolidTransformPlugin()` from `@opentui/solid/bun-plugin` specifically to replace the server Solid runtime with the reactive runtime during a Bun build. OpenCode itself uses this build path for its TUI.

**Decision:** build the TUI entrypoint with Bun + OpenTUI's Solid transform plugin instead of bundling `src/tui.tsx` through the generic tsup server build.

### 2. The current indicator has the wrong semantic meaning

The present activity marker begins at entry to `writeMemoryOnIdle()` and remains active through transcript reads, queueing, heuristic extraction, optional LLM extraction, mutation work, and persistence.

That means the LED currently means roughly:

> memory processing is active

It does **not** mean:

> TokenMaxxer successfully persisted STATE.json

**Decision:** the composer indicator will represent a successful durable STATE commit, not generic idle-memory work.

### 3. The existing activity marker is optimized for long-running work, not a commit pulse

The current `.opencode/.tokenmaxxer-memory-activity` marker is refreshed while work remains active and removed when work finishes. This requires reference counts, refresh intervals, stale detection, and an optimistic `session.idle` dwell to make fast work visible.

A successful commit is an instantaneous event, so it needs a different protocol.

**Decision:** replace the activity lifecycle with a timestamped commit-pulse marker. A successful STATE persistence records a timestamp; the TUI detects a new timestamp and performs a short local animation exactly once.

### 4. The visual treatment looks bolted on

The current rendering is effectively:

```text
● memory
```

with continuous blinking when active. The indicator precedes the label like a bullet, and continuous animation makes it read more like a debug/busy flag than a native persistence status.

**Decision:** render the label first and make the LED clearly belong to it:

```text
memory  ·
```

On a newly detected successful commit:

```text
memory  ●
memory  •
memory  ·
```

The pulse is finite. There is no perpetual blink timer.

## UX contract

### Idle

```text
memory  ·
```

- `memory` uses the active OpenCode theme's muted text color.
- `·` uses the same muted color.
- No motion.
- No background pill or border by default; the element should sit naturally in the composer rather than compete with native controls.

### Successful STATE commit

```text
memory  ●
```

- `●` uses `api.theme.current.success`.
- Bright stage: approximately 350 ms after the TUI detects the commit.

### Fade

```text
memory  •
```

- Short second stage, approximately 450 ms.
- Prefer the theme's success color if it remains visually calm; otherwise use muted text for the second stage.

### Return to idle

```text
memory  ·
```

Total local animation target: approximately 800-900 ms.

The animation timing is local to the TUI after detecting a new commit timestamp. This guarantees that a commit discovered near the end of the filesystem polling interval still receives a complete visible pulse rather than entering halfway through the animation.

## Persistence-signal architecture

The persistence signal is **ephemeral telemetry**, not durable memory and not part of `STATE.json`.

### Marker location

Use the existing global per-project storage namespace:

```text
~/.config/opencode/memory/<project-hash>/.commit-pulse
```

Do not place the new marker in the project worktree.

Reasons:

1. read-only worktrees can still persist STATE through TokenMaxxer's global fallback, so the pulse must remain writable there;
2. ephemeral UI telemetry should not create files inside the repository;
3. both server and TUI processes can derive the same stable per-project path through `globalProjectStorageDir(project)`;
4. the marker contains only a timestamp and no prompt, transcript, decision, or memory payload.

Suggested payload:

```json
{"committed_at": 1786492800000}
```

### Marker behavior

- Written only **after** a successful project-local or global-fallback STATE write.
- Best effort: failure to write the pulse marker must never turn a successful STATE commit into a failed memory operation.
- Not refreshed periodically.
- Not immediately removed after the commit.
- Readers accept only recent timestamps and may remove stale/malformed markers best effort.
- The TUI remembers the last observed timestamp so polling the same marker cannot retrigger the animation.

### Do not instrument generic `atomicWrite()`

The pulse marker itself should be written atomically. Instrumenting the generic `atomicWrite()` helper would therefore make the telemetry path recursively signal itself and would also pulse for unrelated atomic writes such as corrupt-state backups.

The signal must be emitted from the canonical successful STATE commit boundary instead.

## Build contract

The TUI is a distinct runtime target and must be built as one.

Requirements:

1. compile `src/tui.tsx` with Bun;
2. install `createSolidTransformPlugin()` from `@opentui/solid/bun-plugin` into that build;
3. retain the existing external package boundaries required by OpenCode/OpenTUI;
4. continue building server/CLI code independently;
5. add a build regression check that fails if `dist/tui.js` contains the bundled Solid server runtime;
6. run the host-contract/type checks after the split build.

The dependency versions should not be opportunistically upgraded as part of TMTUI. First verify that the locked OpenTUI dependency exposes the required build plugin. Any dependency change must be explicit and coordinated with CRIP PR 10's release/dependency-hygiene work.

## Non-goals

TMTUI does not change:

- memory extraction semantics;
- decision authority;
- CRIP storage budgets;
- LLM trust/provenance rules;
- compaction semantics;
- STATE schema contents;
- CRIP's reliability ordering.

The TUI reports persistence; it does not become part of the persistence authority.
