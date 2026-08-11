# CRIP PR 7 — Compaction Quality & Anti-Drift

**Status:** **Implementation plan ready**

PR 7 makes TokenMaxxer's compaction layer preserve still-applicable continuation state across repeated compactions while defaulting to augmentation of OpenCode's native compaction behavior instead of replacing it.

## Primary goals

- make native host compaction augmentation the default;
- retain explicit replacement mode as an advanced/compatibility option;
- give replacement mode a real previous-summary anchor or safe fallback to augmentation;
- preserve user constraints, completed/current work state, verification state, blockers, rejected approaches, pending actions, and short exact technical details;
- make omission from later turns insufficient evidence that unresolved state disappeared;
- preserve durable/current-session disagreement rather than silently choosing one;
- render durable memory as sanitized, clearly delimited data-only content;
- replace verbose automatic provenance with compact trust tags;
- expose conservative git freshness without treating it as authority;
- stop describing durable file observations as proof that a file was changed;
- rename the compaction diagnostic snapshot so it clearly represents prompt/context input rather than a compacted result;
- preserve PR 1–6 storage, transaction, authority, host, idempotency, completion, outcome, and LLM trust invariants.

## Canonical artifacts

- [`implementation-plan.md`](./implementation-plan.md) — concrete eight-wave plan, host-contract baseline, replacement-summary recovery design, sanitizer/renderer contract, 68-case semantic release matrix, Luna/subagent orchestration rules, and Oracle attack surface.
- `blockers.md` — append-only implementation blocker/decision log once implementation begins.
- `oracle-investigation.md` — implementation handoff after all waves and exact-head release verification.
- `oracle-findings.md` — independent initial Oracle release-gate review when implementation is complete.
- `oracle-rereview.md`, `oracle-final-rereview.md`, etc. — focused remediation reviews if required.

## Baseline

**Planning baseline:** `fdc93cfd757b6cf807a9dadd5127c0abceb657e2`  
**Production baseline:** `bd14e3c8440cfa43bae3ac367226d59ec1709f34` (PR 6 exact tested remediation head)  
**Implementation-plan commit:** `630d70cc5f8b77492ec9ddcbd8a5daeef20a6142`

PRs 1–6 are complete and cleared to Ship.

## Verified host fact that shapes this workstream

On the verified OpenCode minimum (`@opencode-ai/plugin@1.18.15`):

```text
experimental.session.compacting output.context -> augments the native prompt
experimental.session.compacting output.prompt  -> replaces the native prompt
```

The host's native compaction path also carries the previous completed summary into the next compaction prompt. A plugin replacement prompt bypasses that native anchoring path, so PR 7 requires replacement mode to recover the previous summary itself or fall back to augmentation.

## Implementation order

1. freeze host/config/prompt/durable contracts with failing tests;
2. introduce explicit compaction modes and make augmentation the default;
3. implement the shared continuation-preservation contract and prompt builders;
4. harden durable rendering and sanitization;
5. add replacement-mode previous-summary recovery and safe fallback;
6. prove the repeated-compaction information path and conflict semantics;
7. rename prompt diagnostics and remove obsolete compaction seams;
8. run the full repository audit/release chain and publish the Oracle investigation handoff.

## Important scope boundaries

PR 7 does **not**:

- implement the hard total durable injection byte budget — PR 8;
- implement irreducible storage-budget failure semantics — PR 8;
- add post-compaction result/quality persistence — PR 9;
- replace the process-global compaction timestamp with persisted diagnostics — PR 9;
- change decision authority or human-review trust — PR 3;
- widen the LLM durable mutation boundary — PR 6;
- alter source-version completion/idempotency semantics — PR 5.

## Release invariant

> **Compaction preserves still-applicable continuation state across repeated compactions, uses durable memory only as sanitized prior-state data, and augments the supported host's native compaction policy by default instead of unnecessarily replacing it.**

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
