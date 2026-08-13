# Idea: TUI Memory Inspector

## Summary

Extend the existing lightweight right-side `memory` indicator with an optional non-composer inspector panel that lets users see what TokenMaxxer currently knows and whether the subsystem is healthy.

The inspector must preserve the architecture established by CRIP:

- server memory remains silent;
- memory content is never injected into the composer merely to display status;
- the TUI remains a separate optional target;
- TUI failure must never compromise durable memory writes.

## Why this fits TokenMaxxer

TokenMaxxer intentionally does most of its work invisibly. That is desirable for agent behavior, but it makes the memory subsystem hard for a human to understand at a glance.

The existing `memory` indicator answers "is TokenMaxxer here?" A memory inspector could answer:

> What does it currently know, when did it last write, and is anything wrong?

## Proposed UX

Keep the normal display minimal:

```text
memory ●
```

A keybinding or command opens a small side/modal panel:

```text
TokenMaxxer Memory

Project      /repo
Revision     142
Last write   18s ago
State size   6.3 KiB / 8 KiB
Extraction   heuristic

Current task
  Harden installer portability contract

Authority
  7 authoritative decisions
  2 human-foundational
  0 unresolved human conflicts

Files
  4 active

Checkpoint
  before release workflow refactor

Health
  PASS memory store
  PASS project identity
  WARN state at 79% budget
```

Exact visual design should remain compact and keyboard-friendly.

## Suggested sections

### Overview

- project identity/display path;
- current branch/worktree when applicable;
- STATE revision;
- STATE bytes/budget;
- last successful commit timestamp;
- last commit pulse/status;
- local vs global fallback storage.

### Memory

- current task;
- active-file count;
- authoritative decision count;
- trusted human-foundational count;
- conflict count;
- blocker count;
- next-step count.

### Extraction

- heuristic vs LLM enabled;
- selected model when applicable;
- last extraction outcome;
- cache hit/miss where available;
- fallback reason when safe to display.

Do not display credentials, prompt contents, or sensitive transcript material.

### Checkpoint / history

When those features exist:

- latest checkpoint;
- cold archive availability;
- archived record count;
- staleness warnings.

### Health

Surface a very small subset of `tokenmaxxer doctor`/status results relevant to the active project. The full doctor command should remain separate.

## Interaction boundaries

Version 1 should be read-only.

Possible later actions:

```text
open current memory detail
open conflict review
create checkpoint
copy memory ID
```

Destructive actions such as forget/supersede should belong to the Human Memory Control Plane and require explicit confirmation rather than becoming accidental single-key TUI operations.

## Architecture

The inspector should consume a stable, bounded status snapshot from shared read-only logic rather than independently parsing or interpreting raw state.

Prefer:

```text
canonical state/status reader
        ↓
server tool output
CLI status
TUI inspector
```

Avoid creating a second definition of "authoritative decision" or "healthy state" inside TUI code.

## Reliability rules

- TUI reads must never hold the project write lock for long periods.
- TUI rendering failure must not affect server memory behavior.
- Missing/corrupt optional telemetry should degrade to `unknown`, not crash.
- No watcher loop should continuously hammer `STATE.json`.
- Use existing commit-pulse/event seams where possible for refresh.

## Acceptance criteria

1. Inspector is entirely optional; core TokenMaxxer works without it.
2. Opening the inspector never writes composer text.
3. TUI failure does not block or roll back a successful memory commit.
4. Counts agree with `tokenmaxxer_status` and authority resolution.
5. Sensitive transcript/model credential data is never displayed.
6. Refresh is bounded and does not create a filesystem polling storm.
7. Local/global fallback state displays correctly.
8. Corrupt/missing telemetry is shown as unknown/warn rather than crashing.
9. Small terminals degrade gracefully.
10. Automated TUI tests cover open/close, refresh, missing-state and commit-pulse races.

## Priority

**Medium.** Strong usability improvement after the underlying memory lifecycle features stabilize.

## Status

Idea only. No implementation yet.
