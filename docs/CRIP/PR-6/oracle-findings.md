# PR 6 Oracle Findings — Complete LLM Trust Boundary

**Planning baseline:** `6e41d07b4063d1c880b89e17ed70b37471a39125`  
**PR-6 implementation head:** `63eba2c59b826bdf4eac559278511821d2bdb852`  
**Wave-8 handoff head reviewed:** `1acdce77202b5843ad632339110dcc7f858a7b20`  
**Implementation handoff:** [`oracle-investigation.md`](./oracle-investigation.md)  
**Exact implementation CI:** GitHub Actions `31527531666` — success  
**Exact handoff CI:** GitHub Actions `31527686956` — success  
**Verdict:** **Block**

PR 6 substantially succeeds at narrowing the live extraction path: structured output is decisions-only, production LLM evidence is transcript-only, final LLM merge cannot mutate non-decision semantic state, cache payloads are decisions-only, the redundant model lookup/cached-facts/full-facts seams are removed, and the PR-2/3/5 transaction/authority/completion boundaries remain intact.

The release gate is nevertheless blocked by four persistence/upgrade invariants that the current green suite does not exercise. They are concentrated compatibility/schema issues rather than a reason to redesign the PR.

---

## B1 — Real PR-5 v3 broad cache rows can make STATE unreadable after the PR-6 upgrade

### Why this blocks

PR 5 already wrote `MemoryFile.version = 3`. Its current-contract cache rows used extraction contract 2 and could contain the old broad facts payload:

```text
current_task
active_files
decisions
blockers
next_steps
```

PR 6 changes `LLMExtractionCacheEntrySchema.facts` to the decisions-only `LLMDecisionFactsSchema`, which is correct for new writes.

The required compatibility policy in the PR-6 plan is also explicit: **before final v3 MemoryFile validation**, any cache row whose `extraction_contract_version !== 3` or is missing that field must be removed/quarantined, because disposable cache payload must not make semantic STATE unreadable.

The implementation does not currently apply that policy to a pre-PR6 **version-3** document.

`quarantineUnprovenCache()` is called only by `migrateV2ToV3()`. `loadAndMigrate()` skips `migrateV2ToV3()` when the raw document already says `version: 3`. A real PR-5 v3 broad cache row therefore reaches the new decisions-only `MemoryFileSchema` unchanged and can make `MemoryFileSchema.safeParse()` fail. `loadAndMigrate()` then returns `null`.

That is an upgrade-path availability failure at the authoritative storage boundary: disposable PR-5 cache data can make otherwise valid semantic STATE unreadable.

### Deterministic reproduction

Construct a valid PR-5-era `version: 3` STATE with:

- valid semantic task/files/decisions/blockers/next steps;
- `llm_extraction_cache[0].extraction_contract_version = 2` (or absent);
- evidence-backed PR-5 provenance;
- broad `facts` containing the old five-field shape.

Then:

```ts
loadAndMigrate(raw)
```

currently reaches final v3 parsing without pre-PR6 cache quarantine. The new strict decisions-only cache schema rejects the broad payload and the whole load can return `null`.

The existing migration regressions use `version: 2` cache fixtures, so they pass through `migrateV2ToV3()` and do not reproduce the actual PR-5 upgrade shape.

### Required remediation

Add a pure/deterministic **current-v3 compatibility repair before final schema validation**:

```text
for each raw llm_extraction_cache row:
  extraction_contract_version !== 3
  OR extraction_contract_version missing
    -> drop payload
    -> increment bounded quarantine count
    -> reason = pre-pr6-cache-contract
```

Do not require an obsolete broad row to parse under the new cache schema before deciding it is pre-contract data.

Preserve:

- all semantic STATE fields;
- revision and storage identity;
- existing `processed_sources`, including contract-2 records;
- other valid operational metadata.

A row claiming extraction contract 3 but failing the current schema should remain a real current-document validation error.

### Required regressions

1. PR-5 `version:3` broad cache row with `extraction_contract_version:2` is quarantined and semantic STATE loads.
2. Same with the version field absent.
3. Same with otherwise complete evidence-backed PR-5 provenance.
4. Existing contract-2 `processed_sources` survives unchanged.
5. Malformed row claiming contract 3 still fails closed.

**Status:** blocker.

---

## B2 — `legacy` provenance is not paired exclusively with `legacy` confidence

### Why this blocks

The PR-6 trust contract requires one exact extractor/confidence meaning:

```text
heuristic <-> heuristic
llm       <-> llm-corroborated
human     <-> human-reviewed
legacy    <-> legacy
```

`ProvenanceSchema.superRefine()` enforces the first three pairings, but explicitly leaves `extractor="legacy"` with no pairing requirement.

Therefore a value such as:

```ts
{
  extractor: "legacy",
  source_session_id: "legacy",
  confidence: "llm-corroborated",
  evidence: []
}
```

can pass the generic provenance schema. Because the additional LLM audit/evidence requirements trigger only when `extractor === "llm"`, this produces a durable `confidence="llm-corroborated"` label without satisfying the LLM trust boundary.

That breaks the program invariant that every confidence level has one trustworthy meaning.

### Required remediation

Make the pairing exhaustive:

```text
extractor=legacy -> confidence=legacy
```

Do not treat `legacy` as a wildcard escape hatch around confidence semantics.

Compatibility repair may downgrade old unsupported claims to the full legacy pair; it should never retain a non-legacy confidence while changing only the extractor to legacy.

### Required regressions

Reject at minimum:

- `legacy + heuristic`
- `legacy + llm-corroborated`
- `legacy + human-reviewed`

and continue accepting exactly:

- `legacy + legacy`.

**Status:** blocker.

---

## B3 — Fully populated LLM provenance on current task / active files survives compatibility repair

### Why this blocks

PR 6 intentionally says no non-decision durable semantic field may remain or become LLM-corroborated. The implementation plan requires existing v3 state to repair:

```text
current_task_provenance claiming LLM trust -> legacy
active_files[].provenance claiming LLM trust -> legacy
```

while preserving the semantic value/path/reason.

`repairIncompleteLLMProvenanceInState()` currently downgrades those fields only when the LLM tuple is **incomplete** (missing audit ID or evidence). A fully populated PR-5-era non-decision claim such as:

```text
extractor = llm
confidence = llm-corroborated
source_audit_session_id = present
evidence = non-empty
```

passes through unchanged.

The persistence schema also uses generic `ProvenanceSchema` for `current_task_provenance` and `ActiveFileSchema.provenance`; it does not restrict these locations to `heuristic | legacy`.

So the live writer no longer creates non-decision LLM state, but old fully populated LLM labels can remain durable indefinitely, and a manually/current-format constructed v3 state can still introduce them. This violates the final PR-6 invariant:

> no other durable semantic field can be written or labelled as LLM-corroborated.

### Required remediation

Compatibility repair must downgrade **all** LLM/llm-corroborated provenance on:

- `current_task_provenance`;
- every `active_files[].provenance`;

regardless of whether audit/evidence is otherwise complete.

Preserve the semantic value and existing bounded evidence pointers; change the trust label to the exact legacy pair. Do not invent heuristic provenance.

Also enforce the future persistence boundary, for example with field-specific provenance schemas or `MemoryFileSchema` refinement, so current task / active files accept only:

```text
extractor=heuristic, confidence=heuristic
OR
extractor=legacy, confidence=legacy
```

### Required regressions

1. Complete old LLM current-task provenance is downgraded to legacy.
2. Complete old LLM active-file provenance is downgraded to legacy.
3. Incomplete variants still downgrade.
4. Semantic task/path/reason and bounded evidence pointers are preserved.
5. A current-format v3 document attempting LLM provenance on current task is rejected after compatibility has already run on legitimate upgrade data.
6. Same for active files.

**Status:** blocker.

---

## B4 — Durable LLM provenance does not enforce transcript-only evidence at schema/migration time

### Why this blocks

The **live extraction path** is correctly narrowed: `resolveEvidenceReferences()` now accepts only `candidate.kind === "transcript"`, and the writer supplies only transcript candidates to LLM extraction/final merge.

The durable boundary is weaker.

`EvidenceKindSchema` correctly remains a union because heuristic provenance still needs `heuristic-candidate`. But `ProvenanceSchema`'s LLM refinement currently checks only:

- extractor/confidence pairing;
- audit session present;
- evidence count non-zero / bounded.

It does not require every LLM evidence entry to have `kind === "transcript"`.

Likewise, `repairIncompleteLLMClaims()` considers an old LLM decision complete when it has an audit session and any non-empty evidence array. It does not verify the plan's required full tuple that **all evidence.kind are transcript**.

Therefore a PR-5-era decision such as:

```text
extractor = llm
confidence = llm-corroborated
source_audit_session_id = present
evidence = [{ kind: heuristic-candidate, ... }]
```

survives repair and passes the generic durable schema, even though PR 6 explicitly makes heuristic candidates invalid evidence for LLM trust.

The same generic provenance weakness applies to current-contract cache provenance unless the higher-level read path happens to reject it later. The durable label itself should not be schema-valid as `llm-corroborated`.

### Required remediation

For any durable provenance claiming LLM trust, enforce:

```text
1-3 evidence entries
AND every evidence.kind === "transcript"
```

Extend compatibility repair for existing decision rows so an LLM claim is retained as LLM-corroborated only when the complete tuple is present:

```text
extractor=llm
confidence=llm-corroborated
source_audit_session_id present
1-3 evidence
all evidence.kind=transcript
```

Otherwise downgrade the provenance to the exact legacy pair while preserving stable decision ID, semantic content, authority/history state, and bounded evidence references.

### Required regressions

1. `ProvenanceSchema` rejects LLM provenance containing `heuristic-candidate` evidence.
2. Old v3 decision with audit ID + heuristic-candidate evidence downgrades to legacy rather than remaining LLM-corroborated.
3. Mixed transcript/heuristic evidence also downgrades.
4. Complete transcript-only LLM decision remains LLM-corroborated.
5. Contract-3 cache provenance with non-transcript LLM evidence cannot become a valid current cache row.

**Status:** blocker.

---

# What passed the independent review

These areas do **not** need redesign in the remediation wave:

- extraction contract is correctly bumped to 3 while `MemoryFile.version` remains 3;
- structured LLM output is decisions-only and strict;
- `evidence_refs` is mandatory at the LLM TypeScript/runtime boundary;
- model output cannot include `foundational` in the decisions-only structured schema;
- production LLM evidence resolution is transcript-only;
- mixed-validity structured decisions preserve only evidence-valid decisions;
- zero-decision extraction is accepted;
- the final LLM merge is explicitly decisions-only and preserves current task/files/blockers/next steps;
- PR-3 authority logic remains delegated to the established decision merge layer;
- LLM extraction cannot create foundational or foundational-requested state;
- current cache writes are decisions-only and use actual decision evidence rather than generic first-candidate evidence;
- zero-decision / over-evidence results can still complete without requiring a cache payload;
- PR-5 `processed_sources` remains the completion authority;
- the redundant second model resolution and cached-facts/full-facts production seams were removed;
- model/network work remains outside the PR-2 filesystem transaction;
- PR-5 public outcome meanings remain intact.

The exact implementation CI run `31527531666` is genuinely green. Its actual Vitest result is **630 passed + 1 expected pre-build skip = 631 total**, followed by successful ordinary TypeScript checking, minimum-host contract verification, distribution build, self-contained bundle checks, CLI verification/smoke, and shell syntax checks. The Wave-8 handoff head `1acdce7...` also has a successful CI run (`31527686956`).

Green CI does not close B1–B4 because the existing test fixtures miss the exact current-v3 upgrade shapes and field-specific durable trust conditions described above.

---

# Non-blocking notes

1. The decisions-only prompt relies on the strict output schema rather than explicitly enumerating every forbidden non-decision/foundational field in prose. Tightening the prompt wording to mirror the plan would improve defense-in-depth but is not a trust-boundary blocker because the strict structured schema rejects those fields.
2. Some `LLMExtractionCacheEntrySchema` identity fields remain optional at the entry schema even though current identity lookups are strict. Current production behavior turns incomplete identity into a safe miss; requiring the full current identity tuple conditionally for contract-3 persisted rows would be a reasonable hardening improvement.
3. The inherited dependency audit still reports 9 vulnerabilities; dependency triage remains PR 10 scope.
4. The handoff describes `npm test` as 631 tests passed; the exact CI log is 630 passed plus one expected skipped launcher test, 631 total.

---

# Required remediation gate

A single focused remediation wave is appropriate. It should:

1. apply pre-PR6 cache quarantine to actual PR-5 `version:3` STATE before current schema validation;
2. make all four extractor/confidence pairings exact, including legacy;
3. downgrade every old non-decision LLM provenance claim and reject future non-decision LLM provenance at the durable schema boundary;
4. require transcript-only evidence for every durable LLM-corroborated provenance claim and include that condition in compatibility repair;
5. add adversarial regressions for the exact B1–B4 shapes;
6. run the full release chain and obtain a green exact remediation-head GitHub Actions run.

After that wave, publish `docs/CRIP/PR-6/oracle-rereview.md` as a handoff and request a focused independent re-review. Do not declare Ship from the implementation/orchestration side.

**Final verdict: Block.**
