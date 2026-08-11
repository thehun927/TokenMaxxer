# CRIP PR 5 — Source-Version Idempotency & Truthful Idle Outcomes

**Status:** Implementation plan ready

PR 5 makes one bounded source-session version a stable unit of idle work. Re-delivery of an already completed source version must be a durable no-op across sequential calls and reloads, while a genuinely changed source version must still be processed. The workstream also makes idle outcomes stage-accurate and fixes recall recency so only decisions actually returned by canonical recall are marked as used.

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
- `blockers.md` — append-only implementation blocker/decision log once implementation starts.
- `oracle-investigation.md` — independent release-gate assignment after all implementation waves are pushed.
- `oracle-findings.md` — initial independent findings after the investigation brief lands.
- `oracle-rereview.md`, `oracle-final-rereview.md`, etc. — subsequent gate reviews if required.

## Baseline

**Planning baseline:** `b54b82ab33b30af6cfa4fbc131a866a62bbb27b1`  
**Production baseline:** `c41e7d79c5c87d9f95df902d03a748f0047a9cc9`  
**Implementation-plan commit:** `3f4e9865d88133d7147dbfd245616a8cc2713ced`

PR 4 is complete and cleared to Ship. PR 5 must preserve its client provenance, genuine `ToolContext` contract, version gate, bounded tool interfaces, graceful heuristic fallback, and CI-enforced minimum OpenCode package verification.

## Implementation order

1. freeze source identity and failing idempotency/queue regressions;
2. split immutable source identity from mutable prompt identity;
3. add bounded processed-source schema and retention behavior;
4. prepare source versions before queue coalescing and add the completed-source fast path;
5. atomically commit accepted LLM facts + completion and align cache/audit identity;
6. replace broad fallback reporting with the truthful idle-outcome state machine;
7. mark recall recency from structured tool input + canonical authority-aware queries;
8. perform the repository-wide audit and publish the oracle investigation brief.

## Release invariant

> An already completed source version is a durable no-op across sequential delivery and reload; changed source versions remain processable; idle outcomes and recall recency state exactly what actually happened.

## Important scope boundary

PR 5 does not hold the PR 2 filesystem lock across model/network work and does not claim a crash-recoverable cross-process **in-progress prompt lease**. If two processes both begin the same source before either completion is durable, both may still reach model work; the final PR 2 transaction must nevertheless converge safely so only one durable completion is authoritative.

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
