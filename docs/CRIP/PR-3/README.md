# CRIP PR 3 — Decision Authority and Promotion Trust

**Status:** Implementation complete — release-gate review pending

PR 3 makes durable decision semantics trustworthy after PR 1 established authoritative storage and PR 2 established cross-process transactions.

## Primary goals

- one authoritative valid decision per normalized topic;
- stable decision IDs through corroboration;
- invalid/stale decisions cannot receive ordinary promotion;
- model-callable promotion becomes a review request only;
- trusted `human-reviewed` provenance requires interactive human confirmation;
- automation cannot silently supersede trusted human foundational authority;
- foundational decisions survive ordinary age/count pruning.

## Artifacts

- [`implementation-plan.md`](./implementation-plan.md) — concrete implementation plan and release-gate test matrix.
- [`blockers.md`](./blockers.md) — append-only implementation blocker/decision log.
- `oracle-investigation.md` — to be provided after implementation is pushed for independent review.

**Implementation baseline:** repository `5b93492`; code `e2d2da5` (PR 2 Wave 8).

Program authority: [`../implementation-plan.md`](../implementation-plan.md).

## Implementation summary

Implementation shipped in waves 1-8 (commit range `5b93492..<final wave-8 commit>`; waves 1-7 land at `6731e21`..`a522929`, wave 8 changes sit in the working tree pending the release-gate commit):

- Wave 1: failing regression fixtures (test/memory/decision-authority.test.ts, test/memory/decision-review.test.ts, test/cli.test.ts + extensions to merge/prune/migrate/recall)
- Wave 2: schema review/history fields + compatibility repair
- Wave 3: decision-authority module (normalization + reconciliation)
- Wave 4: mergeDecisions extraction from mergeMemory
- Wave 5: authority-aware reader + recall_promote review-request redesign
- Wave 6: decision-review helpers + human CLI + launcher/installer wiring
- Wave 7: pruneOld foundational protection
- Wave 8: adversarial concurrent tests + CLI smoke + cross-process recall update

Final CI signal: 383 tests pass / 383 total; tsc --noEmit clean; npm run build produces dist/cli.js; bash -n install.sh passes.

Implementation blockers/decision log: see [blockers.md](./blockers.md).

Pre-release-gate oracle investigation: [oracle-investigation.md](./oracle-investigation.md) (created after Wave 8 ships).
