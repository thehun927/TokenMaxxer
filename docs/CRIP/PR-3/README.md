# CRIP PR 3 — Decision Authority and Promotion Trust

**Status:** Implementation plan ready

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
- `blockers.md` — create when implementation starts; append-only implementation blocker/decision log.
- `oracle-investigation.md` — to be provided after implementation is pushed for independent review.

**Implementation baseline:** repository `5b93492`; code `e2d2da5` (PR 2 Wave 8).

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
