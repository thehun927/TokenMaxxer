# PR-5 Oracle Investigation Handoff

**Document role:** independent-review handoff, not an approval or verdict.

## Baseline and implementation range

- Requested production baseline: `a955f55746027af46d543853174dc5c8310f2a3e`.
- Implementation head: `c9903a43a78dfabe097ced5a132d833d066f5f1a`.
- Exact implementation range: `a955f55746027af46d543853174dc5c8310f2a3e..c9903a43a78dfabe097ced5a132d833d066f5f1a`.
- Wave commits:
  - `b38f39a` — Wave 5 atomic LLM completion and cache/audit identity.
  - `a25e169` — Wave 5 blocker evidence reconciliation.
  - `4e5949e` — Waves 6–7 truthful outcomes and recall recency.
  - `c9903a4` — Wave 8 audit-blocker remediation.

## Wave summary

### Wave 5 — atomic completion and identity

- Accepted LLM facts and the current `processed_sources` completion proof commit
  in one final `mutateMemory()` transaction.
- Current source, prompt, contract, provider/model, and variant identity is
  propagated through cache and audit metadata; legacy rows remain readable but
  cannot satisfy current identity validation.
- Completed-source delivery is a durable no-op; bulky result-cache storage is
  optional and is not completion proof.

### Wave 6 — truthful outcomes

- Added typed LLM run results for unavailable capability, guard persistence
  failure, retained-request failure, and success.
- Public outcomes map to the stage that actually completed or failed, including
  `error`, `write-failed`, `queue-failed`, `heuristic-only`, `cache-hit`,
  `llm-success`, and `llm-failed`.
- Queue status publication is centralized so `lastOutcome` matches the public
  result; unexpected exceptions do not become `heuristic-only`.

### Wave 7 — exact recall recency

- Recall recency replays completed structured `state.input` through canonical
  `queryDecisions()` against the heuristic transaction's pre-merge base.
- Only returned stable decision IDs are marked; malformed, failed, no-hit,
  historical, conflict, and fake-output-ID cases mark nothing.
- `_recallDecision()` remains read-only.

### Wave 8 — audit and remediation

- Audited source identity, queue/in-flight keys, outcome catches, recall output
  parsing, completion writes, and transaction/network boundaries.
- Remediated completion-marker pruning protection and cache-payload replay
  without a durable completion marker.

## Release-gate matrix

| Area | Evidence | Status |
| --- | --- | --- |
| A — source identity | Existing identity and extraction tests in full suite | Local pass |
| B — durable completion/idempotency | Wave 5 writer-LLM tests; focused 127 tests before later waves | Local pass |
| C — queue/source-version behavior | Writer and transaction tests | Local pass |
| D — cache/audit identity | Extraction and writer-LLM tests | Local pass |
| E — truthful outcomes | Wave 6 focused validation: 149 tests | Local pass |
| F — recall recency | Wave 7: 19 new F61–F73 tests; writer/recall validation | Local pass |
| G — regression/migration | `npm test`: 38 files, 572 tests | Local pass |
| TypeScript | `npx tsc --noEmit` | Pass |
| Host contract | `npm run verify:host-contract` | Pass |
| Distribution build | `npm run build` | Pass |
| Self-contained bundles | CI-equivalent Node bundle script | Pass |
| CLI bundle/launcher | `npm run verify-cli-bundle` | Pass |
| Post-build CLI smoke | `npm run smoke:cli` | Pass |
| Installer/launcher syntax | `bash -n install.sh`; `bash -n bin/tokenmaxxer` | Pass |
| GitHub Actions | No run for final commit was available in this session | Pending |

Additional local evidence after Wave 8 remediation:

- Focused remediation suite: 7 files, 203 tests passed.
- Full suite: 38 files, 572 tests passed.

## Known non-blocking concerns and deviations

- `dist/index.js`, `dist/tui.js`, and `opencode.json` had unrelated local
  modifications and were intentionally excluded from implementation commits.
  The build regenerated distribution outputs locally, but they are not part of
  the reviewed implementation head.
- Legacy `canonical_input_sha256` fields and legacy cache-key helpers remain for
  compatibility. Current production idle processing uses explicit source-only
  identity; callers that omit explicit identity retain compatibility fallbacks
  and should be examined for future tightening.
- PR 5 does not claim crash-recoverable cross-process in-progress prompt
  deduplication. Concurrent requests can both reach model work before durable
  completion, but final persistence converges to one authoritative completion.
- A GitHub Actions run for `c9903a4` is still required for release case 84.

## Adversarial Oracle targets

The independent Oracle should actively attempt to establish or refute:

1. Source identity is independent of prior STATE, revision, cache, audit,
   health, and output metadata in every production caller.
2. Accepted facts and the completion marker cannot be observed as separate
   durable revisions, including over-cap and commit-failure paths.
3. A completed-source hit cannot replay stale cached facts or bump revision.
4. Process-local queue and extraction in-flight keys distinguish appended source
   versions while preserving the documented cross-process scope boundary.
5. Every public idle outcome and queue `lastOutcome` remains stage-accurate for
   unavailable, lock-timeout, commit-failed, guard-failed, retained-request,
   unexpected-error, and successful paths.
6. Recall recency never parses formatted output, never marks all decisions, and
   always selects against the pre-merge authority-aware base.
7. No LLM/network operation occurs inside a PR-2 filesystem transaction.
8. Legacy cache/audit rows cannot satisfy a new-contract completion or cache hit.

## Review boundary

This document assigns the above evidence and attack surface to an independent
Oracle. It does not declare PR-5 approved or shippable.
