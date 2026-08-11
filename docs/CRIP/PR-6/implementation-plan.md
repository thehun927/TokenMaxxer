# CRIP PR 6 — Concrete Implementation Plan: Complete LLM Trust Boundary

> **Planning baseline:** `6e41d07b4063d1c880b89e17ed70b37471a39125`  
> **Production baseline:** `29fcffafe1ccbf9b052bf8c30999fff8604e1726` (PR 5 exact tested head, Ship)  
> **Program authority:** [`../implementation-plan.md`](../implementation-plan.md)  
> **Resolves:** I6 and extraction schema/type ambiguity  
> **Status:** Implementation plan ready

PR 6 gives `llm-corroborated` one precise meaning: **a durable decision accepted only after structured validation and deterministic resolution of exact source-transcript evidence**.

The product contract is intentionally narrower than the current implementation:

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

The LLM must never directly mutate current task, active files, blockers, next steps, human trust, or foundational-review intent.

This PR builds on the boundaries already established by PRs 1–5:

- PR 1 remains authoritative for STATE selection and fail-closed unreadable-state handling;
- PR 2 remains authoritative for short cross-process filesystem transactions;
- PR 3 remains authoritative for decision authority, stable IDs, conflict handling, and human review;
- PR 4 remains authoritative for the OpenCode client/host contract;
- PR 5 remains authoritative for source-version identity, completion-ledger idempotency, truthful outcomes, and model identity.

PR 6 must not weaken any of those contracts.

---

# 1. Current failure model

## 1.1 One type currently means two incompatible things

`src/types.ts` defines `ExtractedFacts` as the heuristic shape:

```ts
{
  current_task
  active_files
  decisions
  blockers
  next_steps
}
```

`src/memory/extract-schema.ts` reuses essentially the same full shape for structured LLM output. That forces the writer, cache, and merge paths to pretend heuristic observations and model claims have the same trust contract when they do not.

## 1.2 The model can still durably mutate non-decision state

The current structured schema asks the model for:

```text
current_task
active_files
decisions
blockers
next_steps
```

`mergeMemory(..., { origin: "llm" })` then:

- may fill or replace some current-task state;
- may add active files;
- replaces blockers;
- replaces next steps;
- merges decisions.

That contradicts the intended trust boundary.

## 1.3 Generic evidence can make unrelated facts look corroborated

For non-decision LLM state, `mergeMemory()` can use `firstCandidateEvidence(...)` when no fact-specific evidence exists. The resulting provenance can still say:

```text
extractor = llm
confidence = llm-corroborated
```

The evidence pointer therefore proves only that *some* source candidate existed, not that the durable fact was specifically grounded in it.

## 1.4 The structured decision type lies about mandatory evidence

The runtime schema requires `evidence_refs`, but the Zod/TypeScript boundary currently makes it optional and repairs the mismatch with `superRefine()`.

This means TypeScript callers can construct a nominally valid structured decision without the very field that defines the trust boundary.

## 1.5 The LLM can still request foundational treatment

The current structured decision schema accepts `foundational?: boolean`. PR 3 correctly prevents that from directly minting `foundational=true`, but it can still become `foundational_requested=true`.

PR 6 removes that model-controlled signal entirely. Human-review intent is not an LLM extraction fact.

## 1.6 LLM evidence resolution accepts a broader candidate class than the prompt contract

The prompt tells the model to cite labelled source-transcript evidence IDs. The current resolver also accepts `heuristic-candidate` references because the prepared candidate map combines both classes.

The durable LLM trust boundary should match the prompt contract exactly: accepted LLM evidence is source-transcript evidence, not an internal heuristic candidate.

## 1.7 Existing cache rows encode the old broad contract

PR 5 current-contract cache payloads can contain current task, active files, blockers, and next steps. Once the runtime cache schema becomes decisions-only, those old rows must not make an otherwise valid v3 STATE unreadable.

Cache payload is disposable. Compatibility should preserve semantic STATE and completion history, not preserve an obsolete model-output shape.

---

# 2. Hard invariants

PR 6 is complete only if all of these hold.

```text
1. Structured LLM output contains exactly one top-level semantic field: decisions.

2. An accepted LLM decision requires topic, decision, and 1-3 unique evidence_refs.

3. LLM evidence_refs resolve only to bounded source-transcript candidates from the current prepared source.

4. Unknown, duplicate, drifted, heuristic-candidate, malformed, or missing evidence cannot produce llm-corroborated durable state.

5. Every durable decision with extractor=llm has confidence=llm-corroborated, a retained source_audit_session_id, and at least one transcript evidence pointer.

6. extractor/confidence pairs have one meaning:
   heuristic <-> heuristic
   llm       <-> llm-corroborated
   human     <-> human-reviewed
   legacy    <-> legacy

7. current_task provenance after compatibility repair may be heuristic or legacy, never llm-corroborated.

8. active_file provenance after compatibility repair may be heuristic or legacy, never llm-corroborated.

9. LLM output cannot directly change current_task.

10. LLM output cannot add/remove/change active_files.

11. LLM output cannot create/replace blockers.

12. LLM output cannot create/replace next_steps.

13. LLM output cannot set foundational, foundational_requested, human provenance, or human-review metadata.

14. LLM decision merging still delegates authority semantics to the PR 3 decision-authority layer.

15. Equivalent evidence-backed LLM decisions may corroborate the existing non-human authority in place without changing its stable ID.

16. Conflicting LLM decisions remain invalid candidates and cannot silently displace heuristic or human authorities.

17. The extraction contract version is bumped for the decisions-only contract, so pre-PR6 completion identity cannot suppress one v3 re-evaluation.

18. The `v2s:` / `v2e:` key prefixes remain identity-format markers; changing the extraction contract version changes their hashes without changing the prefix format.

19. Pre-v3 result-cache rows cannot satisfy a v3 cache lookup and cannot make an otherwise valid STATE unreadable.

20. A successful zero-decision LLM extraction is still a completed source version: no cache payload is required, but the PR 5 processed-source completion marker is required.

21. New cache rows contain only accepted decision facts and evidence that belongs to those decisions.

22. Generic first-candidate evidence is never used to justify a new LLM cache row or LLM provenance claim.

23. If accepted decisions collectively require more evidence than the bounded cache provenance can represent, omit the cache payload but still commit decisions + processed-source completion safely.

24. No LLM/network/host request occurs inside a PR 2 project filesystem transaction.

25. PR 5 public idle outcomes retain their meanings; narrowing model output must not collapse write/queue/model failures into heuristic-only.
```

---

# 3. Extraction contract v3

## 3.1 Bump the semantic extraction contract

In `src/memory/extract-prompt.ts`:

```ts
export const EXTRACTION_CONTRACT_VERSION = 3
```

This is **not** a `MemoryFile.version` bump. STATE remains version 3.

The contract bump is necessary because the same transcript now means a different allowed model output and trust policy.

Because PR 5 source identity includes `EXTRACTION_CONTRACT_VERSION`:

```text
same session + same bounded source under contract 2 != contract 3
```

Therefore old `processed_sources` records remain safe durable history but do not suppress the first contract-v3 processing pass.

Do not rename the `v2s:` / `v2e:` prefixes. They identify the source/extraction **key format introduced by PR 5**, not the semantic extraction contract version. The contract version already participates in the hash and is persisted separately.

## 3.2 New structured model output

Replace the full structured fact contract with:

```ts
export type LLMDecisionFacts = {
  decisions: Array<{
    topic: string
    decision: string
    rationale?: string
    evidence_refs: string[]
  }>
}
```

The LLM schema contains no:

```text
current_task
active_files
blockers
next_steps
foundational
foundational_requested
```

Use `additionalProperties: false` at every structured object boundary.

## 3.3 Contract-specific bounds

These are LLM response trust bounds, not the generalized PR 8 storage/injection budget.

Initial contract:

```text
max decisions per extraction: 10
max topic chars:              256
max decision chars:           500
max rationale chars:          500
max evidence refs/decision:   3
max evidence-ref chars:       128
```

Every string must be non-empty after trimming where semantic emptiness matters.

---

# 4. Separate heuristic and LLM types

## 4.1 Heuristic facts

In `src/types.ts`, make the heuristic role explicit:

```ts
export interface HeuristicFacts {
  current_task: string | null
  active_files: { path: string; reason: string }[]
  decisions: {
    topic: string
    decision: string
    rationale?: string
    foundational?: boolean
  }[]
  blockers: string[]
  next_steps: string[]
}
```

Update heuristic extraction/writer call sites to use `HeuristicFacts`.

Do not use `HeuristicFacts` as the LLM structured-result type.

If a temporary source-level alias is needed during one wave to keep the branch compiling, remove it before the final audit. The completed PR must not leave an ambiguous `ExtractedFacts` type serving both trust domains.

## 4.2 LLM decision facts

In `src/memory/extract-schema.ts`, export:

```ts
LLMDecisionSchema
LLMDecisionFactsSchema
LLMDecisionFactsJsonSchema
LLMDecisionFacts
validateLLMDecisionResult()
```

`evidence_refs` is required in both runtime schema and inferred TypeScript type. No `.optional().superRefine(...)` compatibility trick remains.

## 4.3 Typed extraction result

Change the retained extraction result to:

```ts
type LLMExtractionRunResult =
  | { status: "success"; facts: LLMDecisionFacts }
  | ... existing typed failure states
```

Optionally rename `extractFactsLLM()` to `extractDecisionsLLM()` if the implementation wave can do so without obscuring review history. The important requirement is the type boundary, not the function spelling.

---

# 5. Exact source-evidence boundary

## 5.1 Split transcript and heuristic candidate maps

Today `PreparedIdleSource.candidates` combines:

```text
source transcript candidates
+ heuristic candidates
```

PR 6 should stop presenting that mixed map as the LLM evidence universe.

Preferred prepared shape:

```ts
{
  transcriptCandidates: EvidenceCandidateMap
  transcriptDigests: Readonly<Record<string, string>>
  ...
}
```

The heuristic transaction may build/merge heuristic candidates separately for heuristic provenance.

Only `transcriptCandidates` and `transcriptDigests` cross into:

- structured LLM evidence validation;
- final LLM decision merge;
- current-contract decision cache validation.

## 5.2 LLM-specific resolver

Introduce an explicit resolver or mode whose accepted evidence contract is:

```text
kind === "transcript"
ref exists exactly
ref length valid
digest is SHA-256
digest matches the prepared digest map
1-3 unique refs
```

A `heuristic-candidate` ref is invalid for LLM corroboration even if it exists in some internal map.

Heuristic provenance may continue using `heuristic-candidate`; `EvidenceKindSchema` therefore remains a union.

## 5.3 Mixed-validity structured output

Preserve the current useful behavior deliberately:

- zero decisions -> successful extraction with an empty accepted set;
- mixed valid/invalid decisions -> keep only evidence-valid decisions and emit bounded rejection diagnostics;
- non-empty output with zero accepted decisions -> evidence/validation failure and use the existing one-retry budget;
- every persisted accepted decision must have exact transcript evidence.

---

# 6. Make the merge boundary decisions-only

## 6.1 Remove the generic LLM branch from semantic state merging

`mergeMemory()` currently handles both heuristic and LLM origins. PR 6 should make the heuristic path explicit and create a separate LLM decision path.

Target structure:

```ts
mergeHeuristicMemory(
  existing: MemoryFile,
  facts: HeuristicFacts,
  meta: HeuristicMergeMeta,
): MemoryFile

mergeLLMDecisionFacts(
  existing: MemoryFile,
  facts: LLMDecisionFacts,
  meta: LLMDecisionMergeMeta,
): MemoryFile
```

`mergeLLMDecisionFacts()` may change only:

```text
decisions
last_updated
last_git_sha / last_session_id operational metadata as already required
```

It must preserve byte-for-semantic-value:

```text
current_task
current_task_provenance
active_files
blockers
next_steps
```

The final PR 5 transaction uses this decisions-only merge function.

## 6.2 Preserve PR 3 authority semantics

Do not reimplement authority rules in PR 6.

Expose typed decision entry points around the existing PR 3 core, for example:

```ts
mergeHeuristicDecisions(existing, incoming, meta)
mergeLLMDecisions(existing, incoming, meta)
```

The LLM input type requires `evidence_refs` and has no `foundational` field.

Required behavior remains:

```text
LLM equivalent to non-human authority -> corroborate in place, stable ID
LLM new topic                       -> may create authority
LLM conflict with non-human         -> invalid conflict candidate
LLM conflict with trusted human     -> invalid conflict candidate, human remains authority
```

## 6.3 Remove model-controlled foundational request

Delete `foundational` from the structured LLM schema and LLM decision input type.

The heuristic extractor may continue to produce its existing foundational signal, which maps to `foundational_requested` under PR 3 rules.

The human CLI remains the only boundary that can mint trusted foundational state.

## 6.4 Remove generic LLM evidence fallback

Delete `firstCandidateEvidence(...)` from LLM provenance/cache construction.

If the function remains needed for a non-LLM path, rename/scope it so no LLM code can call it.

---

# 7. Strengthen durable provenance invariants

## 7.1 Extractor/confidence pairing

Make `ProvenanceSchema` or its enclosing validation enforce:

```text
extractor=heuristic -> confidence=heuristic
extractor=llm       -> confidence=llm-corroborated
extractor=human     -> confidence=human-reviewed
extractor=legacy    -> confidence=legacy
```

Keep PR 3's additional human-review invariant requiring:

```text
foundational=true
human_review.channel=interactive-cli
```

for trusted human decision state.

## 7.2 LLM provenance requirements

Any durable provenance claiming `extractor="llm"` must also have:

```text
source_audit_session_id present
1-3 evidence entries
every evidence.kind === "transcript"
```

No other durable fact class is allowed to claim LLM provenance after compatibility repair.

## 7.3 Non-decision provenance

After migration/repair:

```text
current_task_provenance -> heuristic | legacy only
active_files[].provenance -> heuristic | legacy only
```

Future code must never write LLM provenance to those fields.

Blockers and next steps remain heuristic-owned strings; PR 6 does not introduce a new generalized provenance format for them. PR 7/8 may later change injection/retention semantics, but PR 6 only closes the model mutation path.

---

# 8. Compatibility repair for existing STATE

Do not bump `MemoryFile.version` solely for this change.

`loadAndMigrate()` already performs deterministic compatibility repair for trust-sensitive older state. Extend that pattern.

## 8.1 Repair unsupported non-decision LLM provenance

For existing v3 STATE:

- `current_task_provenance` claiming LLM/llm-corroborated -> downgrade to `legacy` provenance;
- `active_files[].provenance` claiming LLM/llm-corroborated -> downgrade to `legacy` provenance.

Preserve the semantic value/path/reason. Do not invent heuristic evidence.

The next real heuristic observation may naturally replace it.

## 8.2 Repair incomplete LLM decision trust claims

For an existing decision claiming LLM trust:

Preserve it as LLM-corroborated only if it already has the complete new durable tuple:

```text
extractor=llm
confidence=llm-corroborated
source_audit_session_id present
1-3 evidence entries
all evidence.kind=transcript
```

Otherwise downgrade the provenance to `legacy` while preserving decision content, ID, authority/history state, and available evidence pointers.

This is a trust downgrade, not a semantic deletion.

Do not silently manufacture audit IDs or transcript evidence.

## 8.3 Old broad cache rows are disposable

Before final v3 `MemoryFileSchema` validation, deterministically quarantine/drop cache payload rows whose extraction contract is not the new decisions-only contract.

Policy:

```text
entry.extraction_contract_version !== 3
or missing extraction_contract_version
    -> remove payload from llm_extraction_cache
       increment bounded llm_extraction_cache_quarantine count
       reason = pre-pr6-cache-contract
```

Then the new current cache schema can be decisions-only without making a valid semantic STATE unreadable because of disposable old payload.

A row claiming extraction contract 3 but failing the new schema remains a real current-document validation failure. Do not silently rewrite malformed current-contract cache data.

## 8.4 Processed-source compatibility

Do not delete pre-v3 `processed_sources` entries merely because their `extraction_contract_version` is 2.

They remain valid historical completion records and will age out under existing PR 5 retention.

They cannot authorize a v3 source hit because the contract version participates in `sourceVersionKey`.

All compatibility repair must remain pure/deterministic on read; no random IDs and no filesystem write during `loadAndMigrate()`.

---

# 9. Decisions-only cache contract

## 9.1 New cache payload

Current-contract cache facts become:

```ts
facts: LLMDecisionFacts
```

New cache rows require the current identity fields introduced by PR 5, including:

```text
source_key
source_input_sha256
prompt_input_sha256
extraction_contract_version = 3
provider_id
model_id
model_variant when selected
```

Keep `canonical_input_sha256` only as compatibility/diagnostic metadata if removing it creates unnecessary churn. It is never an idempotency authority.

## 9.2 Cache provenance must describe cached decisions

The cache provenance evidence set is the deduplicated union of evidence actually used by accepted cached decisions.

Rules:

```text
0 accepted decisions            -> no result-cache payload; completion marker still required
1-3 unique evidence refs        -> cache may be written
>3 unique evidence refs         -> omit cache payload; completion marker still required
no audit session ID             -> no cache payload
```

Never use an arbitrary first candidate merely to satisfy the cache provenance schema.

## 9.3 Remove cache-replay compatibility paths that bypass completion authority

PR 5 established that `processed_sources` is the only completion proof.

Remove obsolete internal paths that still imply cache payload itself can be successful semantic replay, including where safe:

- `ExtractFactsLLMOptions.cachedFacts` and its early-success branch;
- stale `mergeAsyncFacts()` cache-hit merge behavior if repository audit confirms no production caller.

If an internal compatibility seam must temporarily remain during implementation, it must accept decisions-only facts and must not be reachable from production after the final audit.

---

# 10. Prompt contract

Rewrite `buildExtractionPrompt()` so it asks only for explicit current-session decisions.

Required instructions:

```text
- Return only the `decisions` field defined by StructuredOutput.
- Each decision needs topic, explicit decision text, and 1-3 evidence IDs.
- rationale is optional.
- Do not return current task, active files, blockers, next steps, foundational state, or review requests.
- Cite only labelled COMPRESSED SOURCE TRANSCRIPT IDs.
- Prior STATE and FILE CANDIDATES are context only and may never be cited as evidence.
- Do not infer a durable decision solely from prior STATE or a file path.
- If no explicit supported decision exists, return decisions: [].
- Do not use tool outputs, file contents, audit/model prose, or the model response as evidence.
```

Keep prior STATE and file candidates available as bounded context unless a later workstream intentionally changes prompt-context composition. They influence the request, so PR 5 source/prompt identity behavior remains unchanged except for the extraction contract version bump.

---

# 11. Model identity cleanup inherited from PR 5

PR 5 final review left one non-blocking redundant model lookup:

```ts
getLLMConfig(... health-gated ...)
// authoritative selectedModel
...
getLLMConfig(... { ignoreHealth: true })
// result no longer controls persisted identity
```

Remove the second lookup in PR 6.

There should be one selected model for one retained extraction attempt, and it should control:

```text
prompt model
cache key
cache provider/model/variant
audit provider/model/variant
processed_sources.extraction_key
health outcome
```

This is cleanup, not a new model-selection policy.

---

# 12. Transaction and outcome discipline

PR 6 changes semantic payload shape only. It does not change the PR 2/5 lifecycle:

```text
prepare bounded source
        ↓
LOCK -> heuristic merge -> persist -> UNLOCK
        ↓
model selection / audit guard transactions
        ↓
LLM request and validation (NO project lock)
        ↓
LOCK -> re-read newest STATE
        -> merge accepted decisions only
        -> optional decisions-only cache
        -> processed-source completion marker
        -> prune
        -> one commit
        -> UNLOCK
```

Outcome meanings remain:

```text
llm-success  -> accepted structured decision result + completion committed
llm-failed   -> retained model path attempted but no accepted result
write-failed -> required durable read/commit failed
queue-failed -> project lock/queue acquisition failed
cache-hit    -> exact completed source already durable, no semantic replay
```

An empty accepted decision set can still produce `llm-success` because the retained extraction succeeded and its completion proof committed.

---

# 13. Implementation waves

Deliver PR 6 as focused waves. Each wave should leave production compiling and should add/turn-green the tests for that wave before continuing.

## Wave 1 — Freeze the trust contract with failing tests

Add tests for:

- decisions-only structured schema;
- mandatory evidence typing/runtime behavior;
- rejection of non-decision top-level fields;
- rejection of `foundational`;
- transcript-only LLM evidence;
- non-decision immutability during LLM merge;
- cache decisions-only shape;
- pre-v3 cache quarantine;
- compatibility provenance downgrades.

Do not change production semantics before the contract tests exist.

## Wave 2 — Contract v3 and type separation

Implement:

- `EXTRACTION_CONTRACT_VERSION = 3`;
- `HeuristicFacts`;
- `LLMDecisionFactsSchema` / JSON Schema / type;
- required `evidence_refs`;
- response bounds;
- decisions-only extraction run result.

Update prompt/schema tests.

## Wave 3 — Split exact transcript evidence from heuristic provenance

Implement:

- separate transcript candidate/digest map at the prepared-source boundary;
- LLM transcript-only evidence resolver;
- mixed-validity decision filtering;
- rejection of heuristic-candidate evidence for LLM trust;
- bounded diagnostics preserved.

Heuristic provenance continues to use its own candidates.

## Wave 4 — Decisions-only writer/authority merge

Implement:

- heuristic-only semantic state merge;
- LLM decision-only merge;
- typed PR 3 heuristic vs LLM decision entry points if needed;
- removal of LLM `foundational` / review-request input;
- deletion of generic LLM evidence fallback.

Prove current task/files/blockers/next steps do not change during final LLM merge.

## Wave 5 — Cache contract and compatibility repair

Implement:

- decisions-only current cache schema/type;
- pre-v3 cache quarantine on all v3 loads;
- current task/file LLM provenance downgrade;
- incomplete old LLM decision trust downgrade;
- current-contract cache evidence union only;
- zero-decision/no-cache completion behavior;
- >3-evidence/no-cache completion behavior.

Do not delete old `processed_sources` solely for contract age.

## Wave 6 — Durable provenance invariants

Enforce:

- extractor/confidence pairing;
- LLM audit/evidence requirements;
- transcript-only LLM provenance;
- heuristic/legacy-only non-decision provenance;
- PR 3 human trust invariants unchanged.

Add migration and schema adversarial cases before tightening final validation.

## Wave 7 — Remove obsolete broad LLM seams

Repository-wide audit and cleanup:

- remove the redundant second `ignoreHealth` model lookup;
- remove `cachedFacts` early-success path;
- remove or quarantine `mergeAsyncFacts()` if no production caller remains;
- eliminate production `origin:"llm"` calls into a full semantic fact merge;
- eliminate new uses of `firstCandidateEvidence` for LLM trust;
- eliminate structured schema references to current_task/active_files/blockers/next_steps/foundational;
- eliminate ambiguous `ExtractedFacts` type use in LLM modules.

## Wave 8 — Full regression and Oracle handoff

Run the complete release chain and audit PRs 1–5 invariants.

Create `docs/CRIP/PR-6/oracle-investigation.md` only after all implementation waves are pushed and the exact implementation head has CI evidence.

That file is a handoff, not an Oracle verdict.

---

# 14. Release-gate test matrix

Minimum **72 explicit cases**. Existing tests can satisfy a case only if they exercise the exact final production path.

## A. Contract v3 and structured schema — 1–14

1. `EXTRACTION_CONTRACT_VERSION === 3`.
2. Same source/session produces a different sourceVersionKey under v3 than the recorded v2 fixture.
3. `{ decisions: [] }` validates.
4. One evidence-backed decision validates.
5. Missing `evidence_refs` rejects.
6. Empty `evidence_refs` rejects.
7. Duplicate evidence refs reject.
8. More than 3 refs reject.
9. Empty/oversized topic rejects.
10. Empty/oversized decision text rejects.
11. Oversized rationale rejects.
12. More than 10 decisions rejects.
13. `foundational` on a structured decision rejects.
14. Top-level `current_task`, `active_files`, `blockers`, `next_steps`, or any unknown field rejects.

## B. Prompt and type boundary — 15–22

15. Prompt asks only for decisions.
16. Prompt explicitly forbids non-decision durable fields.
17. Prompt forbids foundational/review requests.
18. Prompt requires 1-3 transcript evidence IDs.
19. Prompt says prior STATE cannot be evidence.
20. Prompt says file candidates cannot be evidence.
21. Tool output/file contents are absent from compressed transcript evidence.
22. Source/prompt identity remains bounded and deterministic after the contract bump.

## C. Evidence resolution — 23–35

23. Known transcript ref + matching digest resolves.
24. Unknown ref rejects.
25. Digest mismatch rejects.
26. Non-SHA candidate digest rejects.
27. Duplicate refs reject.
28. `heuristic-candidate` ref rejects for LLM trust.
29. Candidate ref mismatch rejects.
30. Mixed valid/invalid decisions retains only the valid decision.
31. Non-empty result with all decisions rejected enters evidence/validation failure.
32. Zero-decision result succeeds without inventing evidence.
33. Rejection diagnostic contains bounded counts/reason only, no source text.
34. Accepted LLM decision provenance contains exact transcript ref/digest.
35. No accepted LLM decision provenance contains `heuristic-candidate` evidence.

## D. Decisions-only merge and PR 3 authority — 36–48

36. LLM final merge cannot change current_task.
37. LLM final merge cannot change current_task_provenance.
38. LLM final merge cannot add active file.
39. LLM final merge cannot alter existing active-file reason/timestamp/provenance.
40. LLM final merge cannot change blockers.
41. LLM final merge cannot change next_steps.
42. LLM decision cannot set foundational=true.
43. LLM decision cannot set foundational_requested=true.
44. Equivalent LLM decision corroborates current non-human authority in place with stable ID.
45. New evidence-backed LLM topic may create one authority.
46. Conflicting LLM decision against heuristic authority becomes invalid candidate.
47. Conflicting LLM decision against trusted human authority remains invalid and does not modify human authority.
48. Human-review CLI behavior and trusted-human schema tests remain green.

## E. Cache and processed-source contract — 49–59

49. New cache row facts contain only `decisions`.
50. New cache row requires extraction contract version 3/current identity fields.
51. Cache provenance evidence is the union of accepted decision evidence, not an arbitrary candidate.
52. Cache read rejects a row whose decision evidence ref is absent from cache provenance.
53. Cache read rejects heuristic-candidate provenance for v3 LLM decisions.
54. Zero-decision success writes processed-source completion but no cache payload.
55. Accepted decisions needing >3 unique evidence refs write completion but no cache payload.
56. One-to-three unique decision evidence refs permit cache storage.
57. Exact completed v3 source still returns cache-hit with no second prompt/revision bump.
58. A v2 processed-source record does not satisfy the v3 sourceVersionKey.
59. Result-cache payload alone never authorizes semantic replay/completion.

## F. Compatibility migration and durable schema — 60–67

60. Existing v3 current-task LLM provenance is downgraded to legacy deterministically.
61. Existing v3 active-file LLM provenance is downgraded to legacy deterministically.
62. Existing LLM decision missing audit ID/evidence is downgraded to legacy without changing ID/authority state.
63. Existing LLM decision with complete transcript evidence tuple remains LLM-corroborated.
64. Pre-v3 broad cache payload is dropped/quarantined while semantic STATE still loads.
65. Existing cache quarantine count is incremented with bounded metadata.
66. Malformed row claiming contract 3 is not silently downgraded as old cache; current-document validation fails closed.
67. Loading identical raw compatibility input twice produces byte-equivalent migrated identities/state.

## G. End-to-end extraction/outcomes/concurrency — 68–72

68. Real idle path with structured `current_task`/other forbidden field exhausts validation path and does not mutate heuristic state.
69. Real idle path with one valid evidence-backed decision returns `llm-success`, updates only decision semantics, and atomically writes completion.
70. Real idle path with zero decisions returns `llm-success`, preserves heuristic semantic fields, and atomically writes completion.
71. Final LLM merge remains outside model/network lock zone and preserves a concurrent PR 2 mutation.
72. Disabled/unsupported/failed LLM paths retain PR 5 truthful outcomes and heuristic persistence.

## H. Full repository release evidence — mandatory in addition to the 72 semantic cases

The exact final implementation head must pass:

```text
npm test
npx tsc --noEmit
npm run verify:host-contract
npm run build
self-contained bundle verification
npm run verify-cli-bundle
npm run smoke:cli
bash -n install.sh
bash -n bin/tokenmaxxer
git diff --check
```

GitHub Actions must be green on the exact implementation/handoff head used by the Oracle.

---

# 15. Oracle attack surface

The independent Oracle should not merely replay happy-path tests. It should specifically challenge:

1. a model trying to smuggle `current_task`, blockers, or next steps into structured output;
2. a model trying to set `foundational` or otherwise request promotion;
3. an invented `hc-*` heuristic candidate ref supplied as LLM evidence;
4. a known transcript ref whose digest differs from the prepared source;
5. mixed valid/invalid decisions where only the valid subset may survive;
6. a direct final-merge caller passing extra non-decision properties through a cast;
7. old PR 5 broad cache rows inside an otherwise valid current STATE;
8. old LLM decision rows with missing audit IDs, empty evidence, or heuristic evidence;
9. zero-decision success and >3-evidence success, proving processed-source completion does not depend on cache storage;
10. same source under extraction contract 2 vs 3, proving the old completion record cannot suppress the new contract;
11. model A/B health selection, proving the single selected model still controls prompt/cache/audit/completion identity after cleanup;
12. PR 2 barrier tests proving the final decision merge still re-reads newest STATE after the prompt and never holds the filesystem lock during network work;
13. schema-level attempts to persist mismatched extractor/confidence pairs;
14. repository search for any remaining production full-facts LLM merge or generic LLM evidence fallback.

---

# 16. Definition of done

PR 6 is complete when this statement is true and mechanically defended:

> **`llm-corroborated` means a durable decision produced by the retained structured extraction path, accepted only after exact source-transcript evidence resolution; no other durable semantic field can be written or labelled as LLM-corroborated.**

At that point:

- heuristic session state and LLM decision trust are separate type/runtime domains;
- the model cannot directly mutate task/files/blockers/next steps or foundational-review intent;
- old broad cache payloads cannot weaken or break the new contract;
- old incomplete LLM trust claims are conservatively downgraded rather than silently trusted;
- PR 3 authority semantics remain the only authority engine for decisions;
- PR 5 idempotency/completion/outcome semantics remain intact.

Only then should the implementation orchestrator publish `docs/CRIP/PR-6/oracle-investigation.md` for independent release-gate review.
