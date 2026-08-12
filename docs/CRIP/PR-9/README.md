# CRIP PR 9 — Accurate Diagnostics and Artifact Storage

**Status:** **Implementation plan ready**

PR 9 makes TokenMaxxer's observability describe durable per-project reality rather than process-global guesses. It introduces local/global diagnostic artifact storage, separates compaction prompt snapshots from successful compaction result metadata, removes the process-global compaction timestamp, surfaces bounded best-effort persistence failures, and fixes active-file activity labels without expanding durable semantic authority.

## Release invariant

> **Every diagnostic shown as durable project state must come from a persisted per-project observation of the event/artifact it claims to describe; diagnostic artifacts must survive process reload and read-only worktrees, prompt snapshots must never masquerade as compaction results, file-activity labels must describe only observed operation categories, and diagnostic persistence failure must never change the success/failure semantics of the primary memory or compaction operation.**

## Baselines

**Planning baseline:** `4df7873856e5f5714e45c120e1224e28450f4ee7`  
**PR-8 final residual implementation:** `15d3bb55b180c1db4981abb517f6bd159c68e049`  
**PR-8 final validation head:** `79d17e0258176cad83dd862cbfa1561c177e10fd`

Current `main` also contains the separately validated post-PR-8 TMTUI reactive memory-pulse work. PR 9 must preserve `.commit-pulse` semantics and `npm run check:tui-bundle` validation.

## Canonical artifacts

- [`implementation-plan.md`](./implementation-plan.md) — concrete eight-wave plan, artifact resolver, successful compaction-result contract, status semantics, bounded warning policy, file-activity model, 84-case semantic release matrix, Luna/subagent ownership, and Oracle attack surface.
- `blockers.md` — append-only implementation/decision log once Luna begins implementation.
- `oracle-investigation.md` — implementation handoff after the exact-head release chain is green.
- `oracle-findings.md` — independent Oracle release-gate review.
- `oracle-rereview.md`, `oracle-final-rereview.md`, etc. — focused remediation reviews if required.

## Shipped dependencies

PRs 1–8 are complete and cleared to Ship. PR 9 must preserve:

- authoritative local/global STATE selection;
- cross-process mutation transactions;
- one trusted decision authority per topic;
- human promotion boundary;
- OpenCode `>=1.18.15 <2.0.0` host contract;
- PR-5 source completion/idempotency and public outcomes;
- PR-6 decisions-only LLM durable authority;
- PR-7 compaction augment/replace and anti-drift semantics;
- PR-8 8,192-byte STATE / 4,096-byte automatic-injection budgets;
- post-PR-8 TMTUI successful-STATE-commit pulse semantics.

## New diagnostic artifacts

```text
last_compaction_prompt.log
  = TokenMaxxer payload supplied to the compaction hook

last_compaction_result.json
  = metadata from a successful host `session.compacted` event

.commit-pulse
  = unchanged TMTUI successful-STATE-commit telemetry
```

Project-local diagnostics fall back to the existing hashed global namespace for read-only worktrees.

## Host result surface

The minimum supported OpenCode host, v1.18.15, publishes `session.compacted` only after successful compaction processing and supplies `sessionID`. PR 9 therefore implements a real result diagnostic rather than treating the pre-compaction hook as completion. The result artifact stores metadata only; it never stores the full summary or conversation.

## Eight implementation waves

1. freeze artifact/status, compaction-result, persistence-warning, and file-activity contracts with failing tests;
2. implement generalized diagnostic artifact local/global storage;
3. persist bounded compaction prompt and successful result diagnostics;
4. make `tokenmaxxer_status` read durable per-project compaction artifacts;
5. centralize bounded warning text and harden best-effort terminal/health persistence;
6. classify active-file reads/edits/writes/searches/shell references accurately;
7. run read-only, reload, multi-project, repeated-compaction, PR-7/8, and TMTUI integration attacks;
8. Luna runs the full release chain and publishes `oracle-investigation.md`, then stops.

## Scope boundaries

PR 9 does **not**:

- change STATE authority/revision/transactions;
- change decision trust or LLM semantic authority;
- change source identity/idempotency;
- change compaction preservation/augment-replace semantics;
- change the 8KB STATE or 4KB injection budgets;
- repurpose the TMTUI commit pulse;
- persist full compaction summaries/conversations;
- add an LLM-based diagnostic grader;
- enforce dist parity, immutable release artifacts/checksums, installer integrity, dependency remediation, or GitHub Action upgrades — those remain PR 10.

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
