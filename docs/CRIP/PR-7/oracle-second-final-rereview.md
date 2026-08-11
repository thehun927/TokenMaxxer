# CRIP PR 7 — Oracle Second Final Re-Review

**Planning baseline:** `fdc93cfd757b6cf807a9dadd5127c0abceb657e2`  
**Production baseline:** `bd14e3c8440cfa43bae3ac367226d59ec1709f34`  
**Initial implementation head:** `c61e16e44f04ca7b2e1f665accf52c1f3c3c1691`  
**First remediation head:** `4827099c9fde67a0151d6d973f8d300f1debeffc`  
**Residual implementation head:** `141bec918d08d8e25a358231c15a16fcc37efb62`  
**Residual validation head:** `383d0190dc3fc43fbdc27d34b4065660222dbc1e`  
**Second re-review handoff:** [`oracle-second-rereview.md`](./oracle-second-rereview.md)  
**GitHub Actions run:** `31548137271` — success  
**Verdict:** **Ship**

PR 7 is cleared for release. The two residual findings from the first final re-review are closed, and the four original Oracle blockers remain closed. No new compaction, trust, host, transaction, storage-authority, idempotency, or regression blocker was found in the focused second re-review.

---

## Residual B1 — closed

The production completion predicate already matched the supported OpenCode host after the first remediation. The remaining release-gate issue was missing adversarial regression coverage for the exact failure mode.

The residual remediation adds pure extraction tests proving:

1. `summary:true` with missing `finish` is ignored;
2. `summary:true` with `finish:false` is ignored;
3. an older finished summary beats a newer unfinished summary;
4. a finished errored summary is ignored;
5. the newest finished, non-error, non-empty summary wins.

These cases directly pin the supported host-compatible `summary && finish && !error` completion semantics and prevent the prior anti-drift hole from silently returning.

**Status:** closed.

---

## Residual B3 — closed

The compaction hook now computes the bounded history-fallback reason once and reuses the same bounded value in both diagnostic destinations:

- structured `client.app.log` metadata;
- `.opencode/memory/last_compaction_prompt.log`.

The new adversarial test injects an 800-character history error and proves the structured log receives the truncated value and that the file snapshot records the exact same bounded value. The fallback still routes to augmentation and leaves `output.prompt` unset.

This closes the remaining unbounded-host-error path identified in the first final re-review.

**Status:** closed.

---

## Previously closed blockers remain closed

The second re-review found no regression in the earlier remediations:

- **Original B1:** replacement history uses host-compatible completed-summary semantics;
- **Original B2:** durable DATA is explicitly non-authoritative prior-state data and cannot override compaction instructions;
- **Original B3:** prompt diagnostics record the actual TokenMaxxer augmentation/replacement payload, bounded fallback metadata, and real line separators;
- **Original B4:** the legacy replacement prompt/string overload is gone and production exposes one typed PR-7 continuation contract.

Already-cleared PR-7 behavior also remains intact:

- augmentation is the default;
- augment mode appends context and leaves `output.prompt` unset;
- augment mode does not fetch previous-summary history;
- explicit replacement recovers the prior completed summary or safely falls back to augmentation;
- previous-summary anchors are bounded and delimiter-sanitized;
- durable STATE is read through authoritative read semantics and is not mutated by compaction rendering;
- durable values remain sanitized DATA lines;
- omission from later turns is not treated as resolution;
- constraints, work state, verification state, exact unresolved details, blockers, rejected approaches, pending actions, and conflicts remain part of the shared preservation contract;
- durable file observations do not claim modification without current-session edit evidence;
- git freshness is informational and does not demote trusted human authority;
- PR 1–6 regression boundaries remain green.

---

## Exact CI evidence

GitHub Actions run `31548137271` completed successfully at validation head `383d0190dc3fc43fbdc27d34b4065660222dbc1e`.

That commit differs from residual implementation head `141bec918d08d8e25a358231c15a16fcc37efb62` only by an append-only `docs/CRIP/PR-7/blockers.md` validation entry; no source or test code changed between the residual implementation head and the CI-tested validation head.

Exact test counts:

```text
Test files: 45 passed, 1 skipped (46 total)
Tests:      843 passed, 1 skipped (844 total)
```

The sole skipped test is the expected pre-build CLI launcher test.

The same run passed:

- `npx tsc --noEmit`;
- minimum-host contract verification against `@opencode-ai/plugin@1.18.15`;
- distribution build;
- self-contained bundle verification;
- CLI bundle / launcher / installer verification;
- post-build CLI smoke;
- installer and launcher shell syntax validation.

The residual-focused local evidence also reports:

```text
2 files passed, 44 tests passed
10 compaction files passed, 199 tests passed
full local suite: 844 total tests
```

---

## Non-blocking follow-ups

The earlier non-blocking observations remain available for later cleanup and do not hold PR 7:

1. `getCurrentGitSha(opts.worktree)` could eventually be normalized through the same centralized resolved-project identity used elsewhere.
2. `[llm:eN]` is currently an ordinal rendering convention rather than clearly documented evidence-cardinality semantics; PR 8 can clarify the compact representation while introducing the hard injection budget.
3. Compaction hook orchestration remains in `src/index.ts`; moving it to a helper is optional refactoring, not a reliability requirement.
4. Dependency audit findings remain PR 10 scope.

---

# Final verdict

**Ship.**

PR 7 satisfies its release invariant:

> Compaction preserves still-applicable continuation state across repeated compactions, uses durable memory only as sanitized prior-state data, and augments the supported host's native compaction policy by default instead of unnecessarily replacing it.

PR 7 may be marked complete and CRIP may advance to **PR 8 — Guaranteed storage and injection budgets**.
