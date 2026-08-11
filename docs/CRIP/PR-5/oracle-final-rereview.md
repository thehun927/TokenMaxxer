# PR 5 Final Oracle Re-review — Source-Version Idempotency & Truthful Idle Outcomes

**Original implementation target:** `c9903a43a78dfabe097ced5a132d833d066f5f1a`  
**Original findings:** `7e5486fd9956eeca146187b27165f8e1ab2e8518`  
**B1–B4 remediation:** `f5810cb5295b4888c5a1e5c85b7007bcb459cc44`  
**Re-review handoff / exact tested head:** `29fcffafe1ccbf9b052bf8c30999fff8604e1726`  
**GitHub Actions:** run `31501420195` — success  
**Verdict:** **Ship**

PR 5 now satisfies the release gate. The focused remediation closes all four blockers from `oracle-findings.md`, the exact pushed head is fully CI-green, and no new release-blocking regression was found in the already-cleared PR 1–4 boundaries.

## B1 — Closed: incomplete cache payload cannot become completion authority

`finalLLMMerge()` now preserves the fresh accepted `args.llmFacts` when the authoritative lock-read state has no matching `processed_sources` completion marker. A schema-valid current-contract cache row without completion proof cannot replace the newly accepted model result before the completion marker is written.

The regression seeds stale cache facts that differ from fresh accepted facts, performs the final merge, and proves the fresh task/blocker/next-step data wins. The newly written cache payload and processed-source marker also reflect the fresh result.

One implementation detail is redundant but safe: `finalLLMMerge()` still re-reads a concurrent cache entry and contains an `else` branch for a completed source, even though the function returns `noop` immediately when that source is already complete. That branch is effectively unreachable under the immutable lock-read `base`; it does not weaken the invariant.

**Status:** closed.

## B2 — Closed: source identity and actual bounded prompt source use the same window

`prepareIdleSource()` now derives both source identity and canonical prompt input from the same `windowMessages = allMessages.slice(-TRANSCRIPT_WINDOW)` value. `buildExtractionSourceInput(windowMessages)` and `buildCanonicalInput(windowMessages, ...)` therefore share transcript and tool-file candidate boundaries.

The adversarial regression uses more than 50 messages and more than 20 historical file candidates, appends a new tool-only candidate in the active window, and proves:

- the candidate is prompt-visible;
- `sourceInputSha256` changes;
- `sourceVersionKey` changes;
- `promptInputSha256` changes.

This closes the false `cache-hit` case caused by all-history source hashing against a bounded prompt.

**Status:** closed.

## B3 — Closed: persisted extraction identity names the model that actually produced the facts

The health-gated model is now resolved first and assigned to `selectedModel`. That same model is used to construct `selectedCacheKey`, validate current-contract cache identity, invoke `extractFactsLLM`, populate audit provider/model/variant metadata, write the result cache, and write `processed_sources.extraction_key`.

The regression gives automatic discovery two eligible models, puts model A on cooldown, and verifies that model B is:

- the model passed to the structured prompt;
- the provider/model/variant in the audit row;
- the provider/model/variant in the result-cache row;
- the model encoded by the processed-source extraction key.

There is still a second `getLLMConfig(..., { ignoreHealth: true })` lookup after the authoritative gated lookup. Its returned model is no longer used for persisted identity or prompting; it is therefore not an identity violation. It is unnecessary work and can conservatively cause `heuristic-only` if that extra lookup transiently fails, so removing it later would simplify the path, but this is non-blocking cleanup rather than a release-gate failure.

**Status:** closed.

## B4 — Closed: malformed recall input shapes cannot mark default authorities

`markReferencedDecisions()` now requires `state.input` to be a non-null, non-array plain object before query/limit parsing. Missing, null, string, array, and non-plain-object values are ignored before defaults are applied.

The new regressions explicitly cover missing, null, string, and array input and prove no decision receives `last_used_in_session`.

Valid structured recall still replays through canonical authority-aware `queryDecisions()` against the pre-merge base, preserving the Wave 7 behavior already cleared in the first review.

**Status:** closed.

## Exact-head CI evidence

GitHub Actions run `31501420195` checked out exact head `29fcffafe1ccbf9b052bf8c30999fff8604e1726` and completed successfully.

- Vitest: **37 files passed, 1 skipped (38 total)**.
- Tests: **578 passed, 1 expected pre-build skip (579 total)**.
- `npx tsc --noEmit`: passed.
- `npm run verify:host-contract`: passed against peer `>=1.18.15 <2.0.0` and installed/dev `1.18.15`.
- Distribution build: passed.
- Self-contained bundle verification: passed for `dist/index.js`, `dist/tui.js`, and `dist/cli.js`.
- CLI bundle/launcher verification: passed.
- Post-build CLI smoke: passed.
- Installer and launcher syntax checks: passed.

## Regression re-check

The remediation does not alter the previously cleared core contracts:

- PR 1 authoritative storage/read semantics remain fail-closed.
- PR 2 filesystem transactions remain short; model/network work remains outside `mutateMemory()` callbacks.
- PR 3 decision authority and human-review trust remain intact.
- PR 4 OpenCode client provenance, host-version gate, and minimum-host CI contract remain intact.
- completed-source re-delivery remains a no-op before heuristic mutation;
- accepted LLM facts and the processed-source completion marker remain atomic in the same final transaction;
- irreducible over-cap final state fails closed instead of reporting `llm-success` without proof;
- queue coalescing remains keyed by source version;
- public idle outcome taxonomy remains stage-accurate;
- recall remains read-only at tool invocation and recency marking remains authority-aware.

## Non-blocking follow-up notes

1. Remove the now-redundant second `ignoreHealth` model-resolution call in `processPreparedIdleSource()` when convenient. It is not used for persisted extraction identity after B3.
2. Simplify the unreachable completed-source cache-substitution branch inside `finalLLMMerge()`; the top-of-transaction completion check already returns `noop` first.
3. `mergeAsyncFacts()` still exposes stale cache-hit-oriented naming/comments even though production no longer authorizes cache replay without `processed_sources` proof.
4. Dependency audit findings remain deferred to PR 10.

## Final gate

All release-blocking PR 5 findings are closed. The durable source-version identity, completion-ledger authority, atomic final commit, truthful idle outcomes, queue semantics, and exact recall recency contract are now supported by adversarial regressions and a fully green exact-head CI run.

**Final verdict: Ship.**
