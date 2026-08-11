# CRIP PR 6 — Complete LLM Trust Boundary

**Status:** **Complete — Ship**

PR 6 narrows TokenMaxxer's optional structured LLM path to one trustworthy semantic role: evidence-backed decision extraction/corroboration. Heuristics remain authoritative for current task, active files, blockers, next steps, and heuristic decision observations.

## Primary goals

- bump the semantic extraction contract to v3;
- separate `HeuristicFacts` from structured `LLMDecisionFacts` at both TypeScript and runtime boundaries;
- make structured LLM output decisions-only;
- require exact source-transcript evidence for every accepted LLM decision;
- remove LLM mutation of current task, active files, blockers, next steps, and foundational-review intent;
- make extractor/confidence provenance pairs mechanically consistent;
- conservatively repair unsupported old LLM trust claims without deleting semantic state;
- quarantine pre-PR6 broad LLM cache payloads without invalidating semantic STATE;
- keep PR 3 decision authority and PR 5 source/completion/outcome semantics unchanged;
- remove obsolete cache-replay and redundant model-resolution seams left after PR 5.

## Canonical artifacts

- [`implementation-plan.md`](./implementation-plan.md) — concrete 8-wave implementation sequence, extraction-contract-v3 design, compatibility repair, 72-case semantic release matrix, and Oracle attack surface.
- [`blockers.md`](./blockers.md) — append-only implementation and remediation log.
- [`oracle-investigation.md`](./oracle-investigation.md) — completed implementation handoff for independent review.
- [`oracle-findings.md`](./oracle-findings.md) — initial independent release-gate review; verdict Block on four persistence/upgrade issues.
- [`oracle-rereview.md`](./oracle-rereview.md) — focused B1–B4 remediation handoff.
- [`oracle-final-rereview.md`](./oracle-final-rereview.md) — independent final re-review; verdict **Ship**.

## Baseline and final implementation

**Planning baseline:** `6e41d07b4063d1c880b89e17ed70b37471a39125`  
**Production baseline:** `29fcffafe1ccbf9b052bf8c30999fff8604e1726` (PR 5 exact tested head)  
**Implementation-plan commit:** `8518ed961de7872b3e62e6ecadde5e54a1940bf5`  
**Initial PR-6 implementation head:** `63eba2c59b826bdf4eac559278511821d2bdb852`  
**Oracle B1–B4 remediation:** `bd14e3c8440cfa43bae3ac367226d59ec1709f34`  
**Exact remediation CI:** GitHub Actions `31529085213` — success on rerun

PRs 1–5 remain cleared to Ship; the final Oracle re-review found no regression in their storage, transaction, authority, host-contract, source-version, completion-ledger, or truthful-outcome invariants.

## Product decision

```text
heuristics own:
  current_task
  active_files
  blockers
  next_steps
  heuristic decision observations

LLM owns only:
  evidence-backed decision proposals/corroboration
```

The model may not directly request foundational treatment or human trust.

## Extraction contract

PR 6 uses:

```ts
EXTRACTION_CONTRACT_VERSION = 3
```

STATE remains `MemoryFile.version = 3`.

The structured LLM output is decisions-only:

```ts
{
  decisions: Array<{
    topic: string
    decision: string
    rationale?: string
    evidence_refs: string[]
  }>
}
```

Only exact labelled source-transcript references can justify LLM-corroborated decision provenance.

## Final durable trust contract

```text
heuristic <-> heuristic
llm       <-> llm-corroborated
human     <-> human-reviewed
legacy    <-> legacy
```

In addition:

- LLM provenance requires a retained audit session and 1–3 transcript-only evidence pointers;
- current-task and active-file provenance may be only heuristic or legacy;
- old non-decision LLM provenance is conservatively downgraded to legacy;
- old LLM decisions retain LLM trust only when the complete transcript-backed tuple is present;
- pre-PR6 cache payloads are disposable and cannot make semantic STATE unreadable;
- current contract-3 malformed cache state remains fail-closed.

## Release invariant

> `llm-corroborated` means a durable decision produced by the retained structured extraction path, accepted only after exact source-transcript evidence resolution; no other durable semantic field can be written or labelled as LLM-corroborated.

## Final release evidence

The exact remediation SHA passed the full CI release chain:

- 38 Vitest files passed + 1 expected pre-build launcher file skipped;
- 650 tests passed + 1 expected skip = 651 total;
- TypeScript typecheck passed;
- minimum OpenCode host contract verification passed;
- distribution build and self-contained bundle checks passed;
- CLI bundle verification and post-build smoke passed;
- installer/launcher syntax checks passed.

The first attempt of the same CI run hit an existing asynchronous activity-marker timing assertion; the unchanged exact SHA passed on rerun. The final Oracle classified that as non-blocking test-flake evidence, not a PR-6 trust defect.

## Important scope boundaries

PR 6 does **not**:

- redesign decision authority established by PR 3;
- move LLM/network work inside PR 2 filesystem transactions;
- replace PR 5 processed-source completion authority with cache payloads;
- redesign compaction semantics (PR 7);
- implement generalized storage/injection budgets (PR 8);
- solve dependency/release hygiene (PR 10).

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
