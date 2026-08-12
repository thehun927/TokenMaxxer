# CRIP PR 8 — Guaranteed Storage and Injection Budgets

**Status:** **Complete — Ship**

PR 8 makes TokenMaxxer's hard resource limits part of the reliability contract rather than a final-write fallback. Durable mutation fitting lives at the canonical transaction boundary, protected state has typed no-write failure semantics when it cannot fit, and automatic durable context has an independent deterministic UTF-8 byte ceiling.

## Release invariant

> **Every successful durable mutation is schema-valid and guaranteed writable within the 8,192-byte STATE cap at its actual committed revision, while every automatic durable-context block is sanitized, semantically prioritized, and no larger than 4,096 UTF-8 bytes; protected human authority and operation-required proof are never silently discarded to satisfy either budget.**

## Final release state

**Final residual implementation:** `15d3bb55b180c1db4981abb517f6bd159c68e049`  
**CI-tested validation head:** `79d17e0258176cad83dd862cbfa1561c177e10fd`  
**Final Oracle verdict:** **Ship** — [`oracle-second-final-rereview.md`](./oracle-second-final-rereview.md)  
**GitHub Actions:** run `31567759880` — 998 passed + 1 expected skip; full release chain green.

The CI-tested head differs from the residual implementation only by an append-only `blockers.md` verification entry; no production or test code changed.

## Canonical artifacts

- [`implementation-plan.md`](./implementation-plan.md) — concrete eight-wave plan, central transaction-budget design, typed irreducible failures, field/migration compatibility policy, 4KB injection selection algorithm, Luna/subagent orchestration rules, 80-case semantic release matrix, and Oracle attack surface.
- [`blockers.md`](./blockers.md) — append-only implementation/remediation log.
- [`oracle-investigation.md`](./oracle-investigation.md) — initial implementation handoff.
- [`oracle-findings.md`](./oracle-findings.md) — initial independent Oracle **Block** report.
- [`oracle-rereview.md`](./oracle-rereview.md) — first remediation handoff.
- [`oracle-final-rereview.md`](./oracle-final-rereview.md) — focused Oracle re-review that found the final storage-policy/CI residuals.
- [`oracle-second-final-rereview.md`](./oracle-second-final-rereview.md) — final independent Oracle **Ship** verdict.

## Baselines

**Planning baseline:** `7b1b904deb764cfe99c7b239f7cb75f34635688e`  
**Production baseline:** `141bec918d08d8e25a358231c15a16fcc37efb62` (PR 7 final production change)  
**PR 7 validation baseline:** `383d0190dc3fc43fbdc27d34b4065660222dbc1e`  
**Implementation-plan commit:** `49028e58cbbcee6bd191e1f31b373661692ae363`

PRs 1–8 are complete and cleared to Ship.

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

## Shipped implementation decisions

1. Keep `commitMemoryExact()` as the final 8KB defense, with typed `fitMemoryToBudget()` as the canonical policy.
2. Perform automatic fitting inside `mutateMemory()` **after** calculating the next revision, so revision digit growth is included in the budget.
3. Return typed `budget-rejected` transaction results with no write and no revision bump.
4. Protect PR-3 human foundational authority and transient operation-required proof such as a new PR-5 processed-source key or pending audit guard.
5. Use tighter creation bounds for new automatic facts plus broader persistence compatibility ceilings for existing current-v3 STATE.
6. Never silently truncate existing human-reviewed foundational topic/decision text merely to meet new automatic creation limits.
7. Make `buildDurableBlock()` select sanitized render candidates in semantic priority order under a hard 4KB total budget including delimiters/newlines/prefixes.
8. Use `[llm:eN]` with actual retained evidence count rather than a render ordinal.
9. Under real byte pressure, evict disposable metadata and ephemeral state incrementally before refusing a protected mutation.
10. Generate HEADER from the actual committed fitted STATE, never from a pre-fit callback candidate.

## Scope boundaries preserved

PR 8 did **not**:

- persist per-project compaction/status diagnostics — PR 9;
- replace process-global compaction timestamps — PR 9;
- redesign file-activity labels — PR 9;
- change decision authority or human trust — PR 3;
- widen LLM durable mutation authority — PR 6;
- change source identity/idempotency or public idle-outcome taxonomy — PR 5;
- change augment/replace compaction behavior — PR 7;
- redesign release artifacts/dependency hygiene — PR 10.

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
