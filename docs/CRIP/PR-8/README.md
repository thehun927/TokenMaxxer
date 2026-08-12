# CRIP PR 8 — Guaranteed Storage and Injection Budgets

**Status:** **Implementation plan ready**

PR 8 makes TokenMaxxer's hard resource limits part of the reliability contract rather than a final-write fallback. Durable mutation fitting moves to the canonical transaction boundary, protected state gets typed no-write failure semantics when it cannot fit, and automatic durable context receives an independent deterministic UTF-8 byte ceiling.

## Release invariant

> **Every successful durable mutation is schema-valid and guaranteed writable within the 8,192-byte STATE cap at its actual committed revision, while every automatic durable-context block is sanitized, semantically prioritized, and no larger than 4,096 UTF-8 bytes; protected human authority and operation-required proof are never silently discarded to satisfy either budget.**

## Canonical artifacts

- [`implementation-plan.md`](./implementation-plan.md) — concrete eight-wave plan, central transaction-budget design, typed irreducible failures, field/migration compatibility policy, 4KB injection selection algorithm, Luna/subagent orchestration rules, 80-case semantic release matrix, and Oracle attack surface.
- `blockers.md` — append-only implementation blocker/decision log once implementation begins.
- `oracle-investigation.md` — Luna's implementation handoff after all waves and exact-head verification.
- `oracle-findings.md` — independent Oracle release-gate review.
- `oracle-rereview.md`, `oracle-final-rereview.md`, etc. — focused remediation reviews if required.

## Baselines

**Planning baseline:** `7b1b904deb764cfe99c7b239f7cb75f34635688e`  
**Production baseline:** `141bec918d08d8e25a358231c15a16fcc37efb62` (PR 7 final production change)  
**PR 7 validation baseline:** `383d0190dc3fc43fbdc27d34b4065660222dbc1e`  
**Implementation-plan commit:** `49028e58cbbcee6bd191e1f31b373661692ae363`

PRs 1–7 are complete and cleared to Ship.

## Hard budgets

```text
STATE.json durable storage:        8,192 UTF-8 bytes
Automatic durable compaction data: 4,096 UTF-8 bytes
```

These are independent policies:

```text
durable retention != automatic compaction injection
```

A retained fact may be omitted from one automatic compaction block and remain available through pull-based recall.

## Core implementation decisions

1. Keep `commitMemoryExact()` as the final 8KB defense, but replace weak writer-specific pruning with a typed `fitMemoryToBudget()` contract.
2. Perform automatic fitting inside `mutateMemory()` **after** calculating the next revision, so revision digit growth is included in the budget.
3. Return typed `budget-rejected` transaction results with no write and no revision bump.
4. Protect PR-3 human foundational authority and transient operation-required proof such as a new PR-5 processed-source key or pending audit guard.
5. Use tighter creation bounds for new automatic facts plus broader persistence compatibility ceilings for existing current-v3 STATE.
6. Never silently truncate existing human-reviewed foundational topic/decision text merely to meet new automatic creation limits.
7. Make `buildDurableBlock()` select sanitized render candidates in semantic priority order under a hard 4KB total budget including delimiters/newlines/prefixes.
8. Use `[llm:eN]` with actual retained evidence count rather than a render ordinal while touching the compact renderer.

## Eight implementation waves

1. freeze storage/schema/injection contracts with failing tests;
2. implement shared UTF-8/storage budget primitives and typed fitting;
3. add schema bounds and current-v3 compatibility repair;
4. make `mutateMemory()` the canonical automatic budget boundary;
5. migrate writer, recall, and human CLI mutation paths;
6. implement the 4KB deterministic durable-injection budget;
7. run pressure/concurrency integration and repository-wide seam audit;
8. run the full release chain and publish `oracle-investigation.md`, then stop for independent Oracle.

## Important scope boundaries

PR 8 does **not**:

- persist per-project compaction/status diagnostics — PR 9;
- replace process-global compaction timestamps — PR 9;
- redesign file-activity labels — PR 9;
- change decision authority or human trust — PR 3;
- widen LLM durable mutation authority — PR 6;
- change source identity/idempotency or public idle-outcome taxonomy — PR 5;
- change augment/replace compaction behavior — PR 7;
- redesign release artifacts/dependency hygiene — PR 10.

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
