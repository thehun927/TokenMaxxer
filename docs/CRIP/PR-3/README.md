# CRIP PR 3 — Decision Authority and Promotion Trust

**Status:** Complete — Ship

PR 3 makes durable decision semantics trustworthy after PR 1 established authoritative storage and PR 2 established cross-process transactions.

## Primary goals

- one authoritative valid decision per normalized topic;
- stable decision IDs through corroboration and legacy duplicate-ID repair;
- invalid/stale decisions cannot receive ordinary promotion;
- model-callable promotion is a review request only;
- trusted `human-reviewed` provenance requires interactive human confirmation;
- automation cannot silently supersede trusted human foundational authority;
- conflicting trusted-human decisions remain durably quarantined with no automatic authority;
- foundational decisions survive ordinary age/count pruning.

## Artifacts

- [`implementation-plan.md`](./implementation-plan.md) — concrete implementation plan and release-gate test matrix.
- [`blockers.md`](./blockers.md) — append-only implementation blocker/decision log through Waves 1–10.
- [`oracle-investigation.md`](./oracle-investigation.md) — independent release-gate investigation brief.
- [`oracle-findings.md`](./oracle-findings.md) — initial Block findings after Waves 1–8.
- [`oracle-rereview.md`](./oracle-rereview.md) — Wave 9 re-review and remaining two edge-case blockers.
- [`oracle-final-rereview.md`](./oracle-final-rereview.md) — final Wave 10 review: **Ship**.

**Implementation baseline:** repository `5b93492`; code `e2d2da5` (PR 2 Wave 8).

**Final reviewed implementation:** `666be8ee033ff257d9e60d9f41c83527399c7052`.

Program authority: [`../implementation-plan.md`](../implementation-plan.md).

## Final release-gate result

PR 3 completed ten implementation/fix waves. The final gate verified:

- deterministic authority reconciliation;
- durable human-vs-human conflict quarantine;
- exact-ID human review with interactive TTY confirmation and transactional revalidation;
- deterministic compatibility repair for legacy duplicate IDs;
- explicit human supersession lineage;
- foundational pruning protection and fail-closed over-cap behavior;
- concurrency preservation under PR 2 transactions; and
- post-build CLI bundle/launcher/installer verification.

CI on the final implementation (`666be8e`) passed with **417 executed passing tests + 1 expected pre-build skipped test (418 total)**, followed by successful type-check, build, bundle verification, CLI smoke, and shell syntax checks.

The next CRIP workstream is **PR 4 — OpenCode Host Contract**.
