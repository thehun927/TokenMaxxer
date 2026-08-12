# CRIP PR 9 — Accurate Diagnostics and Artifact Storage

**Status:** **Complete — Ship**

PR 9 makes TokenMaxxer's observability describe durable per-project reality rather than process-global guesses. It introduces local/global diagnostic artifact storage, separates compaction prompt snapshots from successful compaction result metadata, removes the process-global compaction timestamp, surfaces bounded best-effort persistence failures, and fixes active-file activity labels without expanding durable semantic authority.

## Release invariant

> **Every diagnostic shown as durable project state must come from a persisted per-project observation of the event/artifact it claims to describe; diagnostic artifacts must survive process reload and read-only worktrees, prompt snapshots must never masquerade as compaction results, file-activity labels must describe only observed operation categories, and diagnostic persistence failure must never change the success/failure semantics of the primary memory or compaction operation.**

## Baselines and final identities

**Planning baseline:** `4df7873856e5f5714e45c120e1224e28450f4ee7`  
**Initial PR-9 implementation:** `29636b7f53abdac10fabeebbc574e5297268c426`  
**Oracle remediation implementation:** `d04c2aa32d3c82c1c61ddfd921b5b32e3a22085c`  
**CI-tested rereview head:** `a12bac2fe20a8dccd76b4910ec2aa49fd6e0686a`  
**Final evidence head before Oracle Ship:** `6c363d0109942ab52f2123f6b2203ac28594ec9f`

Current main also contains the separately validated post-PR-8 TMTUI reactive memory-pulse work. PR 9 preserved `.commit-pulse` semantics and `npm run check:tui-bundle` validation.

## Canonical artifacts

- [`implementation-plan.md`](./implementation-plan.md) — concrete eight-wave plan, artifact resolver, successful compaction-result contract, status semantics, bounded warning policy, file-activity model, 84-case semantic release matrix, Luna/subagent ownership, and Oracle attack surface.
- [`blockers.md`](./blockers.md) — append-only implementation/decision log.
- [`oracle-investigation.md`](./oracle-investigation.md) — initial implementation handoff evidence.
- [`oracle-findings.md`](./oracle-findings.md) — initial independent Oracle **Block** verdict and B1–B4 remediation requirements.
- [`oracle-rereview.md`](./oracle-rereview.md) — remediation evidence and exact CI handoff.
- [`oracle-final-rereview.md`](./oracle-final-rereview.md) — independent final **Ship** verdict.

## Shipped dependencies

PRs 1–8 are complete and cleared to Ship. PR 9 preserves:

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

## Shipped diagnostic artifacts

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

## Final release evidence

GitHub Actions run `31622854338`, job `94201755821`, passed on the documentation-only child of the remediation implementation tree:

```text
Test files          64 passed + 1 expected skip = 65 total
Tests               1167 passed + 1 expected skip = 1168 total
TypeScript          PASS
Host contract       PASS
Distribution build PASS
TUI bundle          PASS
Bundle self-contain PASS
CLI verification   PASS
CLI smoke           PASS
Shell syntax        PASS
```

The focused remediation audit passed `630/630`; the full local suite passed `1168/1168`.

## Scope boundaries preserved

PR 9 did **not**:

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
