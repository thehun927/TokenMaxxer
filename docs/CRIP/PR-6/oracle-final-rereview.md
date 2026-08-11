# PR 6 Final Oracle Re-review — Complete LLM Trust Boundary

**Original implementation head:** `63eba2c59b826bdf4eac559278511821d2bdb852`  
**Original findings:** `d70e0b04a61d2a8e71989509c36096196d9806aa`  
**B1–B4 remediation:** `bd14e3c8440cfa43bae3ac367226d59ec1709f34`  
**Re-review handoff head:** `9427716c264e3ca37e0733011cd00e4bf4529d26`  
**Exact remediation CI:** GitHub Actions `31529085213` — success on rerun  
**Verdict:** **Ship**

PR 6 now satisfies the release gate. The focused remediation closes all four persistence/upgrade blockers from `oracle-findings.md`; the exact remediation SHA passes the complete CI chain; and no new release-blocking regression was found in the previously-cleared live extraction, transaction, authority, completion, or host-contract boundaries.

## B1 — Closed: actual PR-5 v3 broad cache rows are quarantined before current-schema validation

`loadAndMigrate()` now applies a contract-version quarantine after version normalization but before final `MemoryFileSchema` validation. A cache row whose `extraction_contract_version` is missing or is not `3` is treated as disposable pre-PR6 payload without first requiring its old broad `facts` object to parse under the new decisions-only schema.

The remediation preserves semantic STATE, revision, and contract-2 `processed_sources`, while a row explicitly claiming extraction contract 3 is retained for ordinary current-schema validation and therefore still fails closed if malformed.

The focused regressions cover contract 2, missing contract version, evidence-backed old cache provenance, preservation of contract-2 completion records, and malformed contract-3 payload rejection.

**Status:** closed.

## B2 — Closed: extractor/confidence meaning is exhaustive

`ProvenanceSchema` now enforces all four exact pairings:

```text
heuristic <-> heuristic
llm       <-> llm-corroborated
human     <-> human-reviewed
legacy    <-> legacy
```

`legacy` can no longer act as a wildcard extractor carrying `heuristic`, `llm-corroborated`, or `human-reviewed` confidence.

The focused regressions reject all three invalid legacy pairings and accept only `legacy + legacy`.

**Status:** closed.

## B3 — Closed: non-decision durable provenance cannot remain LLM-labelled

Compatibility repair now downgrades every ordinary LLM/llm-corroborated provenance tuple on `current_task_provenance` and `active_files[].provenance` to the exact legacy pair regardless of whether the old tuple had otherwise-complete audit/evidence metadata. Semantic task/path/reason values and bounded evidence pointers are preserved.

The future persistence boundary is also closed with `NonDecisionProvenanceSchema`: current-task and active-file provenance accept only heuristic or legacy provenance. A direct current-format write attempting LLM provenance in those locations is rejected even though legitimate old data is conservatively downgraded during `loadAndMigrate()`.

**Status:** closed.

## B4 — Closed: durable LLM corroboration is transcript-only

`ProvenanceSchema` now requires every evidence entry on an LLM/llm-corroborated tuple to have `kind="transcript"`, in addition to the existing audit-session and 1–3 evidence requirements.

Compatibility repair retains an old LLM decision as `llm-corroborated` only when it has the complete audit + bounded transcript-only tuple. Heuristic-candidate evidence and mixed transcript/heuristic evidence cause a trust downgrade to the exact legacy pair while preserving stable decision identity and semantic/history fields.

The current cache path is covered at both levels: current contract-3 cache provenance with non-transcript LLM evidence is invalid at the schema boundary, and cache readers also reject it as a safe miss.

**Status:** closed.

## Exact-head CI evidence

GitHub Actions run `31529085213` checked out exact remediation head `bd14e3c8440cfa43bae3ac367226d59ec1709f34`. Attempt 2 completed successfully without any PR-6 code change between attempts.

- Vitest: **38 files passed, 1 skipped (39 total)**.
- Tests: **650 passed, 1 expected pre-build launcher skip (651 total)**.
- New focused Oracle remediation regressions: **20 passed**.
- `npx tsc --noEmit`: passed.
- `npm run verify:host-contract`: passed against peer `>=1.18.15 <2.0.0` and installed/dev host `1.18.15`.
- Distribution build: passed.
- Self-contained bundle verification: passed.
- CLI bundle/launcher/installer verification: passed.
- Post-build CLI smoke: passed.
- Installer and launcher syntax checks: passed.

The first attempt of the same exact run hit the existing asynchronous activity-marker timing assertion; the rerun passed at the same remediation SHA. With no code change and the full deterministic release chain green on the rerun, this is treated as a non-blocking test-flake signal rather than a PR-6 trust-boundary defect.

## Regression re-check

The remediation is one focused commit after the Oracle findings and changes only the intended provenance/cache compatibility surfaces, their cache validation helper, regression tests, and the append-only blocker log.

Previously-cleared contracts remain intact:

- structured LLM output remains strict and decisions-only;
- the live LLM evidence resolver remains transcript-only;
- mixed-validity output keeps only evidence-valid decisions;
- zero-decision extraction remains a successful retained extraction;
- final LLM merge remains decisions-only and cannot mutate task/files/blockers/next steps;
- LLM extraction cannot mint foundational or foundational-requested state;
- PR 3 decision authority and trusted-human protection remain authoritative;
- PR 2 filesystem transactions remain short and contain no model/network work;
- PR 5 `processed_sources` remains the sole durable completion authority;
- result cache remains optional and decisions-only;
- model identity and truthful idle outcomes remain unchanged;
- PR 4 minimum-host contract verification remains green.

## Non-blocking follow-up notes

1. The exported `ActiveFile` convenience TypeScript type still widens its optional provenance member to the generic `Provenance` type even though `ActiveFileSchema` durably restricts that location to `NonDecisionProvenanceSchema`. Persistence is fail-closed, so this is not a trust-boundary violation, but tightening the helper type would improve compile-time guidance.
2. Compatibility repair intentionally targets the trust-sensitive old shapes required by this workstream. Other historically schema-valid but manually constructed mismatched provenance tuples remain fail-closed under the new exhaustive pairing rules; no production PR-5 writer path was found that emits those mismatches.
3. The first CI attempt's asynchronous activity-marker failure is worth tracking as test reliability cleanup if it recurs.
4. Dependency audit findings remain PR 10 scope.

## Final gate

The PR-6 release invariant is now enforced at both the live extraction boundary and durable persistence boundary:

> `llm-corroborated` means a durable decision accepted through the retained structured extraction path with exact transcript evidence; no non-decision durable semantic field can carry LLM corroboration.

All release-blocking PR 6 findings are closed.

**Final verdict: Ship.**
