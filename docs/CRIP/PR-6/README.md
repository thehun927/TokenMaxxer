# CRIP PR 6 — Complete LLM Trust Boundary

**Status:** **Implementation plan ready**

PR 6 narrows TokenMaxxer's optional structured LLM path to one trustworthy semantic role: evidence-backed decision extraction/corroboration. Heuristics remain authoritative for current task, active files, blockers, next steps, and heuristic decision observations.

## Primary goals

- bump the semantic extraction contract to v3;
- separate `HeuristicFacts` from structured `LLMDecisionFacts` at both TypeScript and runtime boundaries;
- make structured LLM output decisions-only;
- require exact source-transcript evidence for every accepted LLM decision;
- remove LLM mutation of current task, active files, blockers, next steps, and foundational-review intent;
- make extractor/confidence provenance pairs mechanically consistent;
- conservatively downgrade old incomplete LLM trust claims instead of silently trusting them;
- quarantine pre-v3 broad LLM cache payloads without invalidating semantic STATE;
- keep PR 3 decision authority and PR 5 source/completion/outcome semantics unchanged;
- remove obsolete cache-replay and redundant model-resolution seams left after PR 5.

## Canonical artifacts

- [`implementation-plan.md`](./implementation-plan.md) — concrete 8-wave implementation sequence, extraction-contract-v3 design, compatibility repair, 72-case semantic release matrix, and Oracle attack surface.
- `blockers.md` — append-only implementation blocker/decision log once implementation begins.
- `oracle-investigation.md` — implementation handoff for independent review after all waves are complete.
- `oracle-findings.md` — independent initial release-gate findings when review occurs.
- `oracle-rereview.md`, `oracle-final-rereview.md`, etc. — subsequent focused gate reviews if required.

## Baseline

**Planning baseline:** `6e41d07b4063d1c880b89e17ed70b37471a39125`  
**Production baseline:** `29fcffafe1ccbf9b052bf8c30999fff8604e1726` (PR 5 exact tested head)  
**Implementation-plan commit:** `8518ed961de7872b3e62e6ecadde5e54a1940bf5`

PRs 1–5 are complete and cleared to Ship. PR 6 must preserve their storage, transaction, authority, host-contract, source-version, completion-ledger, and truthful-outcome invariants.

## Product decision

For the next reliable release:

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

PR 6 bumps:

```ts
EXTRACTION_CONTRACT_VERSION = 3
```

STATE remains `MemoryFile.version = 3`.

The new structured output is:

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

## Implementation order

1. freeze the new trust contract with failing tests;
2. bump extraction contract and split heuristic/LLM types;
3. isolate exact transcript evidence from heuristic provenance;
4. make the writer/authority merge decisions-only for LLM results;
5. introduce the decisions-only cache contract and compatibility repair;
6. enforce durable provenance invariants;
7. remove obsolete broad LLM/cache/model-resolution seams;
8. run the full repository audit and publish the Oracle investigation handoff.

## Release invariant

> `llm-corroborated` means a durable decision produced by the retained structured extraction path, accepted only after exact source-transcript evidence resolution; no other durable semantic field can be written or labelled as LLM-corroborated.

## Important scope boundaries

PR 6 does **not**:

- redesign decision authority established by PR 3;
- move LLM/network work inside PR 2 filesystem transactions;
- replace PR 5 processed-source completion authority with cache payloads;
- redesign compaction semantics (PR 7);
- implement generalized storage/injection budgets (PR 8);
- solve dependency/release hygiene (PR 10).

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
