# TMTUI / CRIP Concurrency Plan

TMTUI can run while the Concrete Reliability Implementation Plan (CRIP) is active, but it should not be treated as completely independent. The overlap is small and manageable if the work is staged deliberately.

## Current CRIP context at TMTUI planning time

The checked-in CRIP index currently shows:

- PR 1–7: complete;
- PR 8: implementation plan ready;
- PR 9: planned;
- PR 10: planned.

CRIP PR 8 explicitly owns storage-budget behavior at the canonical transaction/commit boundary, including `mutateMemory()` and `commitMemoryExact()`.

That creates one important overlap with TMTUI: the truthful success pulse should eventually be emitted from the canonical successful STATE persistence boundary.

## Short answer

**Yes — run TMTUI in parallel with CRIP.**

Use this order:

```text
CRIP PR 8  ───────────────────────────────┐
                                          ├─> TMTUI-3 rebase + commit hook
TMTUI-1 build/runtime ────────────────┐   │
TMTUI-2 pulse protocol + UI ──────────┴───┘
```

TMTUI-1 and TMTUI-2 are safe to develop while CRIP PR 8 is underway.

TMTUI-3 must wait for, or at minimum rebase onto, the final PR 8 storage boundary before it is merged.

## File-level concurrency matrix

| Area | TMTUI work | CRIP overlap | Parallel rule |
|---|---|---|---|
| `docs/TMTUI/**` | planning/docs | none | safe now |
| `src/tui.tsx` | reactive pulse UI | none expected in PR 8 | safe during PR 8 |
| new `src/memory/commit-pulse.ts` | ephemeral telemetry protocol | none expected in PR 8 | safe during PR 8 |
| `src/memory/paths.ts` | optional pulse-path helper | low | safe if change is narrow |
| `src/memory/activity-state.ts` | retirement of old activity model | low | safe to prepare; delete after final wiring |
| `src/memory/writer.ts` | remove `beginMemoryActivity()` lifecycle | possible incidental PR 8 edits | defer final cleanup or rebase carefully |
| `src/memory/store.ts` | emit pulse after successful canonical commit | **direct PR 8 overlap** | do not merge TMTUI-3 before PR 8 settles |
| `package.json` / build scripts | split TUI build | low during PR 8; likely PR 10 overlap | land before PR 10 or coordinate |
| `.github/workflows/ci.yml` | TUI build regression gate | possible PR 10 overlap | safe now; rebase if PR 10 starts |
| `dist/tui.js` | regenerated artifact | none conceptually | regenerate from final branch state |

## Recommended branch strategy

Use an independent TMTUI branch/worktree.

Recommended sequence:

1. branch TMTUI from the current production/main baseline;
2. implement and validate TMTUI-1;
3. implement TMTUI-2 without touching the canonical STATE commit function;
4. allow CRIP PR 8 to complete and land first;
5. rebase the TMTUI branch onto the post-PR-8 main branch;
6. inspect the final PR-8 `mutateMemory()` / commit architecture instead of assuming the pre-PR-8 shape survived;
7. implement TMTUI-3 at the final canonical successful persistence boundary;
8. run the complete CRIP + TMTUI test suite before merge.

Do not resolve a rebase conflict in `store.ts` by mechanically preserving both sides. Re-derive the pulse hook from PR 8's final transaction semantics.

## Why TMTUI-3 waits for PR 8

TMTUI wants this invariant:

> emit a pulse only when durable STATE persistence has succeeded.

CRIP PR 8 wants this invariant:

> every successful durable mutation fits the final storage budget at the revision actually committed, and protected required state cannot be silently discarded.

PR 8 may alter when a mutation is considered committable, how a commit failure is typed, and where the canonical success point sits.

If TMTUI wires its pulse before those changes settle, it risks one of two bad outcomes:

1. pulsing before PR 8's final budget/commit decision, producing a false success signal; or
2. creating a merge conflict that encourages preserving obsolete pre-PR-8 commit logic.

Waiting only for the final TMTUI-3 hook avoids both problems while allowing almost all TUI work to proceed.

## Interaction with CRIP PR 9

PR 9 is planned around diagnostics/artifact storage. The TMTUI commit marker is telemetry, but it must remain deliberately minimal:

```json
{"committed_at": 1786492800000}
```

It must not grow into a diagnostics payload, event log, prompt trace, or artifact store.

If PR 9 introduces a shared diagnostic-event system that is suitable for cross-process TUI notification, TMTUI may evaluate it, but TMTUI should not block on PR 9. The timestamp file is intentionally tiny and independent.

## Interaction with CRIP PR 10

PR 10 is expected to touch release/dependency hygiene, which can overlap with:

- `package.json`;
- lockfile changes;
- build scripts;
- CI/release checks;
- tracked `dist` artifacts.

Therefore the preferred ordering is:

```text
TMTUI-1 build correction -> land before CRIP PR 10
```

If PR 10 begins first, do not independently upgrade OpenTUI/Solid dependencies in TMTUI. Rebase TMTUI-1 on PR 10's dependency/build baseline and keep the TUI runtime fix as a focused change.

## Cross-program invariants

TMTUI must preserve all CRIP contracts:

1. telemetry never participates in STATE authority;
2. telemetry failure never changes mutation success/failure;
3. no STATE schema field is added for UI purposes;
4. no storage budget is increased for UI purposes;
5. no extra prompt/transcript data is written to the commit marker;
6. no lock is acquired solely to update the LED;
7. the commit marker must not extend the duration of the STATE transaction/lock;
8. the TUI never infers success from `session.idle` alone;
9. after PR 8, the pulse hook is reviewed against the final canonical commit boundary;
10. after any CRIP PR that changes build/runtime dependencies, rerun TMTUI's bundle regression checks.

## Practical execution rule

If another CRIP agent is actively editing files locally, the two programs are still safe to run simultaneously in **separate branches/worktrees**.

The only hard serialization point is:

```text
final PR-8 storage implementation
    before
TMTUI-3 canonical commit instrumentation
```

Everything else can proceed in parallel with ordinary rebasing and test discipline.
