# CRIP PR 5 — Source-Version Idempotency & Truthful Idle Outcomes

**Status:** **Complete — Ship**

PR 5 makes one bounded source-session version a stable unit of idle work. Re-delivery of an already completed source version is a durable no-op across sequential calls and reloads, while a genuinely changed source version remains processable. The workstream also makes idle outcomes stage-accurate and fixes recall recency so only decisions actually returned by canonical recall are marked as used.

## Primary goals

- separate immutable source identity from mutable prior-state prompt context;
- introduce an extraction contract version and explicit source/prompt/model identity layers;
- persist a compact processed-source completion ledger independent of the optional bulky result cache;
- atomically commit accepted LLM facts and the source completion marker;
- make exact completed-source re-delivery return `cache-hit` with no semantic replay, prompt, audit session, commit, or revision bump;
- key same-process idle coalescing by source version so appended messages in the same session are not swallowed;
- make `IdleWriteOutcome` describe the stage that actually succeeded or failed, including an explicit `error` outcome;
- replay structured `recall_decision` input through canonical `queryDecisions()` and mark only the returned stable decision IDs;
- preserve all PR 1–4 storage, transaction, decision-trust, and OpenCode host-contract invariants.

## Canonical artifacts

- [`implementation-plan.md`](./implementation-plan.md) — concrete 8-wave implementation sequence, identity/persistence contracts, 84-case release-gate matrix, and oracle attack surface.
- [`blockers.md`](./blockers.md) — append-only implementation blocker/decision log.
- [`oracle-investigation.md`](./oracle-investigation.md) — independent release-gate assignment after the implementation waves.
- [`oracle-findings.md`](./oracle-findings.md) — initial independent release-gate findings; verdict **Block** on four focused invariants.
- [`oracle-rereview.md`](./oracle-rereview.md) — B1–B4 remediation handoff.
- [`oracle-final-rereview.md`](./oracle-final-rereview.md) — final independent gate; verdict **Ship**.

## Baseline and completion

**Planning baseline:** `b54b82ab33b30af6cfa4fbc131a866a62bbb27b1`  
**Production baseline:** `c41e7d79c5c87d9f95df902d03a748f0047a9cc9`  
**Implementation-plan commit:** `3f4e9865d88133d7147dbfd245616a8cc2713ced`  
**Initial implementation head:** `c9903a43a78dfabe097ced5a132d833d066f5f1a`  
**Oracle findings:** `7e5486fd9956eeca146187b27165f8e1ab2e8518`  
**B1–B4 remediation:** `f5810cb5295b4888c5a1e5c85b7007bcb459cc44`  
**Final tested handoff head:** `29fcffafe1ccbf9b052bf8c30999fff8604e1726`  
**Final Oracle report commit:** `541932434044c6a369d3d863437857ce063f5a07`

PR 4 remains preserved. PR 5 is complete and cleared to Ship by the independent Oracle after a focused B1–B4 remediation wave and exact-head CI verification.

## Final release evidence

GitHub Actions run `31501420195` on exact head `29fcffafe1ccbf9b052bf8c30999fff8604e1726` passed the full release chain:

- 578 Vitest tests passed with 1 expected pre-build skip (579 total);
- ordinary TypeScript typecheck passed;
- minimum OpenCode host-contract verification passed;
- distribution build passed;
- self-contained bundle verification passed;
- CLI bundle/launcher verification passed;
- post-build CLI smoke passed;
- installer and launcher syntax checks passed.

## Release invariant

> An already completed source version is a durable no-op across sequential delivery and reload; changed source versions remain processable; idle outcomes and recall recency state exactly what actually happened.

## Important scope boundary

PR 5 does not hold the PR 2 filesystem lock across model/network work and does not claim a crash-recoverable cross-process **in-progress prompt lease**. If two processes both begin the same source before either completion is durable, both may still reach model work; the final PR 2 transaction nevertheless converges safely so only one durable completion is authoritative.

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
