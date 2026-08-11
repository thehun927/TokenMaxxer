# CRIP PR 5 — Concrete Implementation Plan: Source-Version Idempotency & Truthful Idle Outcomes

> **Planning baseline:** `b54b82ab33b30af6cfa4fbc131a866a62bbb27b1`  
> **Production baseline:** `c41e7d79c5c87d9f95df902d03a748f0047a9cc9` (PR 4 Wave 9, Ship)  
> **Program authority:** [`../implementation-plan.md`](../implementation-plan.md)  
> **Resolves:** I7, C2, G5  
> **Status:** Implementation plan ready

PR 5 makes one source-session version a stable unit of work. The same completed source version must not spend model tokens twice merely because TokenMaxxer mutated its own STATE, reloaded, or received the same idle event again. At the same time, a genuinely changed source transcript must remain processable, and every reported idle outcome must describe the stage that actually succeeded or failed.

This plan is intentionally compatible with the boundaries already established by PRs 1–4:

- PR 1 remains the authority for local/global STATE resolution and unreadable-vs-missing semantics;
- PR 2 remains the authority for cross-process short transactions and monotonic revisions;
- PR 3 remains the authority for decision identity/trust and authority-aware queries;
- PR 4 remains the authority for OpenCode client ownership, host compatibility, and tool argument bounds.

PR 5 does **not** weaken any of those contracts to obtain idempotency.

---

# 1. Current failure model

## 1.1 Cache identity is self-invalidating

Today `buildCanonicalInput()` hashes:

```text
prior STATE
+ compressed source transcript
+ file candidates
```

and `extractionCacheKey()` uses that hash with source session + provider/model.

The same idle run then mutates STATE with:

- `last_updated`;
- `last_session_id`;
- `recent_sessions`;
- current task;
- active files;
- decisions;
- blockers;
- next steps.

Therefore:

```text
run 1: source S + prior X      -> key K1 -> writes X+S
run 2: same source S + prior X+S -> key K2
K1 != K2
```

The durable cache row written by run 1 can miss immediately on run 2 even though the source transcript is byte-for-byte equivalent after TokenMaxxer's bounded normalization.

## 1.2 The result cache is not a sufficient completion ledger

A successful LLM merge does **not** always write `llm_extraction_cache` today. `finalLLMMerge()` deliberately skips cache storage when the accepted decision evidence cannot be represented safely by the cache provenance cap.

So this implication is false:

```text
llm-success -> cache row exists
```

PR 5 must not make reload idempotency conditional on an optional result-cache payload. Successful processing needs a separate, compact completion marker.

## 1.3 Same-session queue coalescing can swallow a new source version

`enqueueProjectJob(project, sourceSessionID, ...)` coalesces all concurrent calls for one project/session ID onto one promise.

That is correct only if the source session is immutable while the first job is running.

A real sequence can be:

```text
idle event A -> source session S contains messages 1..10
processing A is still running
source session S receives messages 11..12
idle event B -> same session ID S, different source version
```

Today event B can receive A's existing promise and never process messages 11..12.

The queue identity must therefore be **source-version-specific**, not session-ID-only.

## 1.4 Idle outcomes are not stage-accurate

`writeMemoryOnIdleSerialized()` currently ends with a broad catch that returns `heuristic-only`.

That can describe:

- an unexpected exception before heuristic persistence;
- a post-persist optional extraction failure;
- an actual intentional heuristic fallback;

with the same string.

That is not observability; it is information loss.

## 1.5 Recall recency over-marks decisions

`markReferencedDecisions()` currently checks only whether any `recall_decision` tool part occurred, then stamps `last_used_in_session` onto **every valid decision**.

This defeats recency as a retention/injection signal. A recall of one result with `limit=1` must not make every authority look recently used.

---

# 2. Hard invariants

PR 5 is complete only if all of these hold.

```text
1. Source identity contains no prior STATE, revision, timestamp, cache, audit, health, or output written by processing that source.

2. Prompt identity may contain prior durable context, but prompt identity never decides whether a completed source version is already processed.

3. The extraction contract version is part of source identity. A contract/schema/prompt semantic change can invalidate old completion identities deliberately.

4. One successful accepted LLM merge atomically persists a compact processed-source completion record in the same project transaction.

5. A processed-source record is proof of completion only after accepted LLM facts and the completion marker committed together.

6. Re-delivery of an already completed source version returns `cache-hit` without a new heuristic merge, audit session, prompt, semantic merge, or revision bump.

7. A changed bounded source transcript or changed file-candidate set produces a different source identity and is eligible for processing.

8. Same-process queue coalescing keys on source version, so exact duplicates coalesce but two versions of the same session do not.

9. Existing pre-PR5 cache/audit rows cannot accidentally satisfy the new completion identity.

10. `llm-success` means accepted LLM facts plus the current completion record committed durably.

11. `heuristic-only` means the heuristic layer committed and the optional LLM path was intentionally not attempted because it was disabled or unavailable.

12. Unexpected exceptions are never reported as `heuristic-only`.

13. `llm-failed` means the optional retained extraction path was actually attempted and failed to produce accepted facts.

14. Required STATE commit failures are never reported as LLM/model failures.

15. Queue/transaction-acquisition failure is distinguishable from commit failure.

16. Queue/status `lastOutcome` is exactly the final public `IdleWriteOutcome` returned to the caller.

17. Recall recency is computed from structured `recall_decision` input and canonical `queryDecisions()` results; human-readable tool output is never parsed.

18. Only IDs that canonical recall would return for the supplied query/limit may receive `last_used_in_session`.

19. Read-only recall tools stay read-only. PR 5 does not move recency mutation into `recall_decision`; the idle writer updates it inside the existing heuristic transaction.

20. No LLM/network/host request is moved inside the PR 2 project filesystem lock.
```

---

# 3. New terminology

PR 5 separates four identities that are currently conflated.

## 3.1 Source input

The bounded source material visible to extraction:

```ts
export interface ExtractionSourceInput {
  compressedTranscript: string
  fileCandidates: string[]
  extractionContractVersion: number
  sourceInputSha256: string
}
```

The digest is based only on:

```text
EXTRACTION_CONTRACT_VERSION
compressedTranscript
fileCandidates
```

It does **not** include source session ID. The same bounded content can exist in two sessions; the session ID is added at the source-version-key layer.

## 3.2 Source version key

The durable model-independent identity of one source-session version:

```text
source session ID
+ sourceInputSha256
+ extraction contract version
```

Persist it as an opaque bounded hash, not a long concatenated string:

```text
v2s:<64 lowercase hex chars>
```

This is the key used for:

- same-process idle coalescing;
- durable completed-source lookup;
- deciding whether an exact completed source is a no-op.

## 3.3 Prompt input

Prompt context is allowed to include prior project memory:

```ts
export interface CanonicalExtractionInput extends ExtractionSourceInput {
  priorStateJson: string
  promptInputSha256: string
}
```

`promptInputSha256` hashes the actual bounded prompt ingredients, including prior state. It is audit/debug identity only.

A changed prior state may change `promptInputSha256` while `sourceInputSha256` and `sourceVersionKey` remain stable.

## 3.4 Extraction key

The exact model invocation identity:

```text
sourceVersionKey
+ providerID
+ modelID
+ selected variant (or null)
+ extraction contract version
```

Persist as:

```text
v2e:<64 lowercase hex chars>
```

This becomes the new `cache_key` for current-contract result-cache and audit rows.

The model-independent source key and model-specific extraction key serve different purposes:

```text
sourceVersionKey  -> "has this completed source version already succeeded?"
extractionKey     -> "which exact model invocation/cache identity produced it?"
```

---

# 4. Extraction contract version

Add one canonical constant in `src/memory/extract-prompt.ts`:

```ts
export const EXTRACTION_CONTRACT_VERSION = 2
```

Version `2` is the first source-version identity contract.

The constant must participate in source hashing, source-version keys, extraction keys, cache metadata, audit metadata, and completion records.

## Version discipline

Increment this constant whenever a change can alter what "the same extraction" means, including:

- compressed transcript normalization;
- eligible source-message window semantics;
- file-candidate derivation semantics;
- evidence-reference semantics;
- extraction prompt instructions that materially change accepted output;
- structured extraction schema/accepted output contract.

**PR 6 is expected to bump this again** when it narrows durable LLM output to decisions only.

Do not use the `MemoryFile.version` schema number as the extraction contract version. They are independent compatibility axes.

---

# 5. Refactor `extract-prompt.ts` into source identity vs prompt identity

## 5.1 New source serializer

Add:

```ts
export function serializeExtractionSourceInput(input: {
  compressedTranscript: string
  fileCandidates: string[]
  extractionContractVersion: number
}): string
```

Canonical payload:

```ts
stableJson({
  extraction_contract_version: input.extractionContractVersion,
  source_transcript: input.compressedTranscript,
  file_candidates: input.fileCandidates,
})
```

## 5.2 New source builder

Add:

```ts
export function buildExtractionSourceInput(
  messages: readonly TranscriptMessage[],
): ExtractionSourceInput
```

It must call the existing bounded/deterministic:

- `compressTranscript(messages)`;
- `extractFileCandidates(messages)`.

Then derive `sourceInputSha256` from the source serializer.

## 5.3 New key builders

Add domain-separated helpers:

```ts
export function makeSourceVersionKey(args: {
  sourceSessionID: string
  sourceInputSha256: string
  extractionContractVersion: number
}): string

export function makeExtractionCacheKey(args: {
  sourceVersionKey: string
  extractionContractVersion: number
  model: {
    providerID: string
    modelID: string
    variant?: string
  }
}): string
```

Use `stableJson(...)` + SHA-256 with explicit domain strings so a source hash can never be confused with an extraction hash.

For example:

```text
tokenmaxxer:source-version:v2:<canonical-json>
tokenmaxxer:extraction:v2:<canonical-json>
```

Do not build durable keys by direct provider/model/session concatenation. Hashing gives a fixed-size key even when host identifiers approach their schema limits.

## 5.4 Prompt identity

Replace ambiguous `CanonicalExtractionInput.sha256` with explicit:

```ts
promptInputSha256
```

Build it from:

```text
extraction contract version
bounded priorStateJson
compressedTranscript
fileCandidates
```

`buildExtractionPrompt()` continues to consume the same visible prior-state/source fields. This PR changes identity semantics, not the extraction prompt's fact policy; PR 6 owns that policy change.

## 5.5 Compatibility cleanup

Update internal callers/tests so no production code uses generic `.sha256` to mean both source and prompt identity.

If a one-wave compatibility alias is needed while tests are migrated, it must be clearly deprecated and removed before the PR 5 release gate.

---

# 6. Add a compact durable processed-source completion ledger

## 6.1 Why a separate ledger is required

The result cache is optional. A successful accepted extraction may be too evidence-rich to store as one reusable cache entry, yet the source is still complete and must not be prompted again on reload.

Add optional STATE metadata:

```ts
export const ProcessedSourceSchema = z.object({
  source_key: z.string().regex(/^v2s:[a-f0-9]{64}$/),
  extraction_key: z.string().regex(/^v2e:[a-f0-9]{64}$/),
  extraction_contract_version: z.number().int().positive().max(10_000),
  completed_at: z.string().datetime({ offset: true }).or(z.string().max(128)),
})

processed_sources?: ProcessedSource[]
```

Initial hard cap:

```ts
MAX_PROCESSED_SOURCES = 10
```

The record deliberately stores no transcript, prompt, response, model name, file path, or raw session ID. It is a compact completion identity only.

## 6.2 New helper module

Prefer a small module:

```text
src/memory/source-processing.ts
```

with:

```ts
findProcessedSource(memory, sourceVersionKey)
upsertProcessedSource(memory, record)
removeOldestProcessedSource(...)
```

Use newest-completion order deterministically.

## 6.3 Atomic success invariant

The current source completion record must be added inside the **same `mutateMemory()` callback** that merges accepted LLM facts.

Correct:

```text
LOCK
  read newest state
  re-check completed source / cache identity
  merge accepted LLM facts
  optionally store result-cache payload
  store processed-source completion record
  prune
  commit once
UNLOCK
```

Incorrect:

```text
commit facts
unlock
commit processed source later
```

A crash between those writes would make a successfully processed source look incomplete and spend model work again after reload.

## 6.4 Completion marker retention during its creation transaction

Extend `pruneOld()` with an optional preservation parameter such as:

```ts
pruneOld(mem, client, now, {
  preserveProcessedSourceKey?: string,
})
```

During the final successful LLM transaction, the newly created source key is temporarily protected from processed-source metadata eviction.

Older processed-source records remain disposable.

If the state cannot fit even after pruning all allowed disposable data while preserving the newly created completion marker and durable facts, the transaction must fail rather than return `llm-success` without its completion proof.

PR 8 will later define the final generalized storage budget contract; PR 5 only protects the correctness of its newly introduced completion invariant.

## 6.5 Pruning order

Treat processed-source records as operational metadata, but retain them longer than bulky result-cache payloads.

Suggested disposable order:

```text
completed audit metadata
old result-cache payloads
model health rows
old processed-source completion records
cache quarantine metadata
recent session IDs
```

Pending audit guards remain protected as today.

---

# 7. Make cache/audit identity current-contract-aware

## 7.1 Additive cache fields

Keep `MemoryFile.version === 3`; do not force an unrelated STATE schema-version migration.

Extend `LLMExtractionCacheEntrySchema` additively with optional-on-read fields:

```ts
source_key?: string
source_input_sha256?: string
prompt_input_sha256?: string
extraction_contract_version?: number
model_variant?: string
```

New PR 5 cache entries **must** populate them.

`canonical_input_sha256` may remain as a compatibility field for old v3 documents; for new entries it should equal the explicit prompt-input digest or be deprecated in favor of `prompt_input_sha256`. Do not use it for idempotency.

## 7.2 Additive audit fields

Likewise extend `LLMAuditMetadataSchema` with optional-on-read:

```ts
source_key?: string
source_input_sha256?: string
prompt_input_sha256?: string
extraction_contract_version?: number
model_variant?: string
```

New audit rows populate them.

## 7.3 Legacy cache rows are safe misses

A pre-PR5 cache row can remain valid historical/disposable metadata, but it cannot satisfy a current-contract cache identity because it lacks the new contract/source metadata and has an old key shape.

Do not reinterpret it as current completion.

No payload quarantine is required merely because an otherwise evidence-backed cache row predates PR 5. It may age out normally.

## 7.4 Result-cache lookup validates identity, not just a string key

Refine `readExtractionCacheEntry()` so current production callers supply an identity object, not only an arbitrary cache-key string.

A current hit must verify:

```text
cache_key == recomputed extraction key
source_key == expected source version key
source_input_sha256 == expected source digest
extraction_contract_version == current contract
provider/model/variant == expected model identity
provenance/evidence still validates against current source candidates
```

This is defense in depth against malformed or manually edited STATE.

---

# 8. Prepare source identity before queue coalescing

## 8.1 Split source preparation from serialized processing

Refactor the public lifecycle into two phases:

```text
writeMemoryOnIdle(opts)
  ↓
prepareIdleSource(opts)        // fetch + normalize source, no STATE mutation
  ↓
enqueueProjectJob(project, sourceVersionKey, ...)
  ↓
processPreparedIdleSource(...) // STATE/heuristic/optional LLM lifecycle
```

Suggested type:

```ts
type PreparedIdleSource = {
  allMessages: TranscriptMessage[]
  windowMessages: TranscriptMessage[]
  sourceInput: ExtractionSourceInput
  sourceVersionKey: string
}
```

The existing `TRANSCRIPT_WINDOW = 50` remains the outer heuristic/file-candidate window unless implementation evidence justifies changing it. `compressTranscript()` still applies its own 20-message text cap.

## 8.2 Source preparation outcomes

Before enqueueing:

```text
missing session.messages endpoint -> no-messages
empty/missing transcript data     -> no-messages
session.messages throws           -> error
source normalization throws       -> error
```

The public wrapper must still call `setProjectQueueOutcome(project, outcome)` for these pre-queue terminal outcomes.

## 8.3 Queue key

Use the bounded source-version key, optionally with a fixed idle prefix:

```text
idle:<sourceVersionKey>
```

Do not use raw session ID alone.

This gives the desired same-process behavior:

```text
same project + same session + same source version -> exact promise coalescing
same project + same session + changed source      -> distinct queued job
same project + different session                  -> distinct queued job
```

The project queue still serializes all jobs for one project; PR 2's filesystem transaction remains the cross-process authority.

---

# 9. Completed-source fast path

## 9.1 Check before heuristic mutation

Inside the queued job, after a safe STATE read but **before** heuristic mutation:

```ts
const completed = findProcessedSource(existing, prepared.sourceVersionKey)
if (completed) return "cache-hit"
```

This fast path performs:

```text
no heuristic merge
no last_updated change
no recent_sessions rewrite
no audit session
no model discovery
no host compatibility probe
no prompt
no cache re-merge
no STATE commit
no revision bump
```

This is the strongest and simplest interpretation of an exact completed-source no-op.

`cache-hit` becomes the existing public label for a durable processed-source completion hit, even when the bulky result-cache payload has already been pruned.

## 9.2 Why stale facts are not re-applied

A completion hit must **not** call `mergeAsyncFacts()` with cached facts.

The cache was written atomically with the accepted merge. Re-applying an old source later can revive facts that have since been superseded or pruned deliberately.

So:

```text
processed source hit -> no-op
```

not:

```text
processed source hit -> replay cached facts
```

## 9.3 Second completion check before model work

After the heuristic transaction and before opening a retained audit session, re-read the authoritative state and check the source key again.

This catches a completion that another process committed between the first check and optional LLM work.

It does not create a cross-process prompt lease, but it narrows the race window without holding the project lock across host/model work.

---

# 10. Final LLM merge behavior

Refactor `finalLLMMerge()` arguments to carry explicit identities:

```ts
sourceInput
sourceVersionKey
promptInputSha256
extractionKey
selectedModel
```

Inside its `mutateMemory()` callback:

1. re-check `processed_sources` by `sourceVersionKey`;
2. if already completed, return `noop` / `already-complete` without replaying cached facts;
3. otherwise merge the current accepted LLM facts against the newest state;
4. optionally store the result-cache payload when safe;
5. always store the compact processed-source completion record;
6. prune while preserving the newly written source key;
7. commit exactly once.

Only branch 3–7 can produce public `llm-success`.

A concurrent process that wins the completion race may cause this transaction to return an already-complete result. Map that to `cache-hit` and log a bounded race/coalescing diagnostic; do not overwrite the winner with a second source replay.

---

# 11. Typed LLM run result for truthful outcome mapping

The writer currently receives `ExtractedFacts | null`, which collapses too many reasons.

Replace the writer-facing extraction return with a typed result.

Suggested shape:

```ts
export type LLMExtractionRunResult =
  | { status: "success"; facts: ExtractedFacts }
  | { status: "unavailable"; reason: "missing-session-endpoint" }
  | { status: "guard-failed" }
  | {
      status: "failed"
      reason:
        | "session-create"
        | "structured-request"
        | "timeout"
        | "validation"
        | "evidence"
    }
```

The exact reason vocabulary may reuse existing bounded diagnostic enums; do not create duplicate strings if the implementation can share them cleanly.

Required semantics:

```text
missing session create/prompt capability -> unavailable (no model request attempted)
session.create request/response failure   -> failed
prompt/retry/validation/evidence failure  -> failed
audit guard could not persist             -> guard-failed
accepted corroborated result              -> success
```

Diagnostics remain best-effort and cannot change the typed result.

The process-local `extractionInFlight` map should coalesce the same **extraction identity**, not only project + source session ID. At minimum include the prepared source-version key; including extraction key after model resolution is preferred.

---

# 12. Stage-accurate public idle outcomes

Add the missing public outcome:

```ts
export type IdleWriteOutcome =
  | "no-messages"
  | "heuristic-only"
  | "cache-hit"
  | "llm-success"
  | "llm-failed"
  | "write-failed"
  | "queue-failed"
  | "error"
```

## 12.1 Outcome matrix

### `no-messages`

Only:

- `session.messages` endpoint absent;
- transcript response has no messages.

A thrown transcript request is **not** `no-messages`.

### `error`

Unexpected exception not represented by a typed store/queue/LLM result, especially before heuristic persistence:

- transcript request throws;
- source preparation throws;
- heuristic extraction throws;
- unexpected application exception.

Do not convert this to `heuristic-only`.

If an unexpected exception occurs after heuristics committed, `error` still reports the unexpected pipeline failure; bounded diagnostics may additionally state `heuristic_committed=true`. PR 9 can expose richer durable diagnostics later.

### `write-failed`

Required STATE persistence cannot be completed:

- authoritative STATE is unavailable when a required mutation must proceed;
- `mutateMemory()` returns `commit-failed`;
- durable audit guard registration fails because its required commit/read failed;
- accepted LLM facts cannot be committed with their completion marker.

### `queue-failed`

Serialization/transaction acquisition fails:

- process-local queue rejects unexpectedly;
- required project mutation returns `lock-timeout`.

This follows the master plan's `queue/transaction failure -> queue-failed` rule.

### `heuristic-only`

Heuristic STATE committed, and optional LLM extraction was **intentionally not attempted** because:

- feature flag disabled;
- model unavailable;
- model cooling down;
- host structured contract unavailable/unsupported;
- required LLM session capability is absent before a retained request is attempted.

### `cache-hit`

The source-version completion ledger says the exact completed source was already processed, or the final transaction discovers another actor already committed that exact source.

Normal fast-path cache hit is a true no-op with no revision bump.

### `llm-success`

A new accepted structured extraction was durably merged and the current processed-source completion record was committed atomically.

### `llm-failed`

The retained LLM extraction path was actually attempted and failed:

- retained audit session creation request failed;
- structured prompt failed/timed out;
- retry budget exhausted;
- structured validation/evidence acceptance failed.

A required STATE write failure is not `llm-failed`; report the persistence outcome instead.

## 12.2 No broad `catch -> heuristic-only`

The serialized writer may have a top-level safety catch so an OpenCode event never throws into the host, but it must map to `error`, not `heuristic-only`.

Use typed helper results and explicit stage transitions for expected failures so the catch is genuinely exceptional.

---

# 13. Queue/status records the exact final outcome

Centralize final publication:

```ts
function finishIdleOutcome(project: string, outcome: IdleWriteOutcome): IdleWriteOutcome {
  setProjectQueueOutcome(project, outcome)
  return outcome
}
```

or equivalent.

Every public terminal path, including pre-queue `no-messages` / `error`, must pass through this publication point.

Do not let `enqueueProjectJob()`'s internal generic `"failed"` placeholder become the externally reported final state when the writer has a more precise `IdleWriteOutcome`.

`tokenmaxxer_status` may keep rendering the existing `Last idle outcome:` line; PR 5's job is to make the underlying value truthful. PR 9 owns broader diagnostic redesign.

---

# 14. Fix recall recency from structured tool input

## 14.1 Preserve PR 2's read-only recall contract

Do **not** make `_recallDecision()` acquire the project filesystem lock merely to update recency.

The recall tools remain read-only as established in PR 2.

The existing heuristic idle transaction already has the correct mutation boundary. Recency should be computed immediately before the session's heuristic merge against that transaction's authoritative `base` memory.

## 14.2 Replace the boolean scanner

Replace:

```ts
"any recall_decision call happened" -> mark every valid decision
```

with:

```ts
markReferencedDecisions(
  base,
  allMessages,
  sessionId,
)
```

where the implementation:

1. finds completed `recall_decision` tool parts;
2. reads only structured `state.input`;
3. reconstructs `{ query, limit }` using the same production defaults/bounds (`limit` default 10, max 25; optional bounded query);
4. calls canonical `queryDecisions(base, query, limit)`;
5. unions the returned stable IDs across all recall calls;
6. updates `last_used_in_session` only on those exact IDs.

Use the **pre-merge authoritative base**. Do not run the query after the current source's heuristic decisions have changed the authority set.

## 14.3 Malformed/failed recall calls

A tool part that did not complete successfully, or whose structured input cannot represent a valid production recall invocation, contributes no recency marks.

Do not silently turn malformed `limit=999` into a broader recall than the host would have executed.

## 14.4 Never parse formatted output

A human-readable result can contain:

```text
[id=...]
```

but those strings are presentation, not the recency contract.

Tests must prove that fake decision IDs placed in tool output/text do not influence recency.

---

# 15. Schema and migration policy

## 15.1 No `MemoryFile.version` bump

All PR 5 durable additions are optional and additive:

```text
processed_sources
new cache identity metadata
new audit identity metadata
```

Existing v3 STATE remains readable.

## 15.2 Legacy cache/audit behavior

Pre-PR5 rows:

- remain readable if otherwise valid;
- never satisfy current source completion;
- never satisfy the new extraction-key validation;
- age out under existing bounded metadata retention.

Do not rewrite a legacy cache key into a PR 5 key; the missing source-contract identity cannot be reconstructed safely from cache metadata alone.

## 15.3 Processed-source rows are operational, not semantic memory

They are not shown as decisions, active files, blockers, or compaction durable context.

They exist solely to suppress duplicate completed-source work.

---

# 16. Cross-process scope boundary

PR 5 guarantees:

- sequential duplicate-source idempotency;
- reload/new-process duplicate-source idempotency after completion is durable;
- same-process concurrent duplicate coalescing by source version;
- same-session changed source versions are not swallowed;
- atomic semantic persistence under PR 2 transactions.

PR 5 does **not** introduce a long-lived cross-process lease around an in-progress LLM request.

Two processes that both begin the same source version before either has committed its completion record may still both reach model work. The second completion transaction must observe the first winner and become a no-op, so durable state remains correct, but duplicate prompt spend during that narrow in-progress race is not claimed as solved.

Solving that would require a crash-recoverable, timeout-aware prompt lease whose lifetime spans network work—the exact class of long-held cross-process ownership PR 2 intentionally avoided. It should be designed separately if production evidence shows simultaneous multi-process duplicate prompt spend is material.

Do not accidentally claim this stronger guarantee in docs/tests.

---

# 17. Implementation sequence / waves

## Wave 1 — Freeze source identity with failing tests

Files:

```text
src/memory/extract-prompt.ts
test/memory/extract-prompt.test.ts (or existing canonical-input tests)
test/memory/writer-llm.test.ts
```

Add failing fixtures for:

- same source + different prior STATE -> same source hash;
- same source + different prior STATE -> different prompt hash is allowed;
- appended source text -> different source hash;
- changed file candidate -> different source hash;
- contract version changes identity;
- same successful idle twice currently prompts twice;
- reload duplicate currently prompts again;
- same-session changed-version queue event currently coalesces incorrectly.

No production identity change beyond test scaffolding unless needed for compilation.

## Wave 2 — Source/prompt identity implementation

Implement:

- `EXTRACTION_CONTRACT_VERSION`;
- `ExtractionSourceInput`;
- `buildExtractionSourceInput()`;
- `sourceInputSha256`;
- `promptInputSha256`;
- `makeSourceVersionKey()`;
- hashed model-specific extraction key including variant;
- remove ambiguous production reliance on `CanonicalExtractionInput.sha256`.

Update extraction prompt/cache/audit construction compile errors, but do not yet claim idempotency until completion persistence lands.

## Wave 3 — Processed-source schema + retention

Implement:

```text
ProcessedSourceSchema
MemoryFile.processed_sources
src/memory/source-processing.ts
pruneOld clone/disposal support
current-completion preservation option
legacy-v3 load tests
```

No successful LLM path may write the marker in a separate transaction.

## Wave 4 — Prepared-source queue + completed-source fast path

Refactor `writeMemoryOnIdle()`:

```text
fetch/prepare source
compute sourceVersionKey
enqueue by sourceVersionKey
read state
completed-source lookup
heuristic transaction only on miss
```

Prove:

- exact duplicate coalesces/no-ops;
- appended same-session source is a distinct queued job;
- no revision bump on completed-source fast path.

## Wave 5 — Atomic LLM completion + cache identity

Refactor:

- cache/audit metadata;
- `readExtractionCacheEntry()` identity validation;
- `finalLLMMerge()`;
- current processed-source record written atomically with accepted facts;
- cache optionality no longer affects completion proof;
- cache-hit does not replay facts.

Add the evidence-rich-success/no-cache-row regression.

## Wave 6 — Truthful outcome state machine

Add `error`, typed LLM run results, and explicit mapping of:

```text
source read
heuristic transaction
intentional LLM skip
completed-source hit
audit registration
actual LLM attempt
final persistence
queue/lock failure
```

Remove the broad `catch -> heuristic-only` behavior.

Make queue/status record every final outcome exactly.

## Wave 7 — Exact recall recency

Replace the boolean recall scanner with structured-input replay through canonical `queryDecisions()` against the heuristic transaction's pre-merge base.

Keep `_recallDecision()` itself read-only.

Add single-result, limit, multi-recall, malformed/failed-call, conflict, and fake-output-ID tests.

## Wave 8 — Repository-wide audit + oracle brief

Before submission:

Search/audit at minimum:

```text
canonicalInput.sha256
canonical_input_sha256 used as cache identity
makeExtractionCacheKey old signature
sourceSessionID-only queue keys in idle writer
catch -> heuristic-only
mark all still_valid after recall
human-readable recall output parsing
processed_sources writes outside final LLM transaction
LLM/network call inside mutateMemory callback
```

Then create:

```text
docs/CRIP/PR-5/oracle-investigation.md
```

with the exact implementation commit range and release evidence.

---

# 18. Release-gate test matrix

These are minimum tests, not suggestions. Number them in implementation notes so the oracle can trace them.

## A. Source identity

1. Same bounded transcript + file candidates + contract version produces the same `sourceInputSha256` repeatedly.
2. Same source with two different prior STATE snapshots produces the same `sourceInputSha256`.
3. The same case is allowed to produce different `promptInputSha256` values.
4. Cache/audit/model-health/revision-only prior-state changes cannot alter source identity.
5. Appending a new eligible user/assistant message changes source identity.
6. Changing a tool-derived file candidate changes source identity.
7. Reordering canonical file candidates cannot change identity because candidates are normalized/sorted first.
8. Changing extraction contract version changes source identity.
9. Source-version key changes when source session ID changes even for identical content.
10. Extraction key changes when provider, model, or selected variant changes.

## B. Durable completion / sequential idempotency

11. First successful source returns `llm-success` and persists exactly one processed-source record.
12. The processed-source record is committed in the same revision as accepted LLM facts.
13. Exact source delivered again returns `cache-hit`.
14. The second exact delivery creates no audit session.
15. The second exact delivery sends no structured prompt.
16. The second exact delivery performs no heuristic semantic merge.
17. The second exact delivery does not bump revision.
18. Reset process-local queue/in-flight/audit-session state and repeat: still `cache-hit`, no prompt.
19. Remove the bulky result-cache row while preserving the processed-source record: repeat still no-ops.
20. Successful extraction whose combined evidence deliberately prevents a reusable cache payload still persists a processed-source record.
21. Repeat of case 20 still no-ops and does not prompt.
22. LLM failure does not write a processed-source record.
23. Retrying a previously failed source remains permitted.
24. Appending a source message after completion produces a new source key and permits a new LLM extraction.
25. A current completion marker is not silently pruned from the same transaction that returns `llm-success`.

## C. Queue/source-version behavior

26. Two concurrent same-process calls with the same project/session/source version share one queued execution and one prompt.
27. Two concurrent idle events for the same session ID but different prepared source versions become two serialized jobs, not one promise.
28. The later changed source version from case 27 is durably reflected after both finish.
29. Different source sessions in one project remain serialized by the project queue.
30. Different projects remain independent.
31. Queue diagnostics return to depth/in-flight zero after both source-version jobs finish.

## D. Cache/audit identity and compatibility

32. New cache key is bounded fixed-size hashed identity, not raw concatenation.
33. New cache row records source key, source digest, prompt digest, contract version, provider/model and variant metadata.
34. New audit row records the same current-contract source/prompt identity fields.
35. Pre-PR5 evidence-backed cache row remains loadable but cannot satisfy current-contract extraction identity.
36. A malformed row with a matching `cache_key` string but mismatched source metadata is rejected as a hit.
37. A cache entry whose evidence no longer matches current source candidates is rejected.
38. Final merge sees a completion committed by another actor and returns no-op/cache-hit without replaying cached facts.

## E. Truthful public outcomes

39. Missing `session.messages` endpoint -> `no-messages`.
40. Empty/missing transcript data -> `no-messages`.
41. `session.messages` throws -> `error`.
42. Unexpected source/heuristic pre-persist exception -> `error`.
43. Initial STATE unavailable for required mutation -> `write-failed`.
44. Heuristic transaction `commit-failed` -> `write-failed`.
45. Heuristic transaction `lock-timeout` -> `queue-failed`.
46. LLM feature disabled after heuristic commit -> `heuristic-only`.
47. Model unavailable/cooling after heuristic commit -> `heuristic-only`.
48. Unsupported host structured contract after heuristic commit -> `heuristic-only`.
49. Missing LLM session capability with no request attempted -> `heuristic-only`.
50. Completed-source fast path -> `cache-hit`.
51. Retained session-create request failure -> `llm-failed`.
52. Structured prompt retry exhaustion -> `llm-failed`.
53. Structured validation/evidence exhaustion -> `llm-failed`.
54. Audit guard required commit failure -> `write-failed` (or `queue-failed` only when the typed cause is lock-timeout).
55. Accepted LLM result + final commit failure -> `write-failed`.
56. Accepted LLM result + final lock timeout -> `queue-failed`.
57. Successful accepted merge + completion commit -> `llm-success`.
58. Broad unexpected catch can return `error` but never `heuristic-only`.
59. `getProjectQueueStatus(project).lastOutcome` equals the exact returned final outcome for each representative terminal class.
60. A later successful job replaces an earlier failure in `lastOutcome`; generic internal `failed` does not leak over the precise outcome.

## F. Recall recency

61. One completed `recall_decision` returning one authority marks only that authority ID.
62. `limit=1` marks exactly one ID even when many authorities exist.
63. `limit=2` marks exactly the same two IDs canonical `queryDecisions()` would return.
64. Query filtering marks only matching returned IDs.
65. Two recall calls in one session mark the union of their returned IDs and no others.
66. A recall with no hits marks nothing.
67. A failed/non-completed recall tool part marks nothing.
68. Malformed/out-of-bounds structured recall input marks nothing.
69. Invalid/historical non-authority rows are never marked merely because their text/topic matches.
70. An unresolved human-authority conflict does not fabricate recency for quarantined rows absent from canonical `queryDecisions()` output.
71. Fake `[id=...]` text in assistant/tool output cannot influence recency.
72. The current source's new heuristic decisions cannot change which pre-existing IDs are marked for an earlier recall; selection uses the pre-merge base.
73. `_recallDecision()` itself remains read-only and does not call `mutateMemory()`.

## G. Retention/migration/regression

74. Pre-PR5 v3 STATE with no `processed_sources` loads unchanged.
75. Processed-source array is bounded at the declared maximum.
76. Old processed-source records are deterministically disposable under pressure while the current completion can be protected during its commit.
77. PR 1 local/global authority tests remain green.
78. PR 2 child-process lock/transaction tests remain green.
79. PR 3 decision authority/review/CLI tests remain green.
80. PR 4 host-contract/tool-bound/graceful-fallback tests remain green.
81. `npx tsc --noEmit` passes.
82. `npm run verify:host-contract` passes.
83. Distribution build, self-contained bundle checks, CLI bundle verification, and post-build CLI smoke pass.
84. Exact reviewed commit has one fully green GitHub Actions run.

---

# 19. Test construction guidance

## 19.1 Real two-run idempotency test

Do not repeat the current pre-seeded-cache pattern as the primary proof.

The release gate must execute:

```text
real writeMemoryOnIdle
  -> actual heuristic transaction
  -> actual retained audit session
  -> actual structured prompt stub
  -> actual final LLM transaction
  -> llm-success

then call writeMemoryOnIdle again with the same source
  -> cache-hit
  -> no create
  -> no prompt
  -> no revision bump
```

Then reset process-local state and run the third call.

## 19.2 Evidence-rich successful no-cache test

Construct accepted LLM decisions whose union of evidence exceeds the reusable cache provenance representation so the result-cache payload is intentionally absent.

Assert:

```text
facts committed
processed_sources current key exists
llm_extraction_cache for that extraction may be absent
repeat -> cache-hit/no prompt
```

This is the regression that proves the completion ledger is not merely a renamed cache.

## 19.3 Same-session changed-version queue test

Use barriers, not sleeps alone:

1. first `session.messages` call returns source A;
2. first queued job is held at a deterministic LLM barrier;
3. second public idle call for the same `sessionId` fetches source B with an appended eligible message;
4. prove B receives a different source-version queue key and waits behind A rather than sharing A's promise;
5. release A;
6. prove B runs and completes.

## 19.4 Outcome failure injection

Prefer typed seams around:

- `readMemoryState`;
- `mutateMemory` status;
- typed LLM run result;
- queue rejection.

Do not simulate every outcome by throwing generic exceptions; the purpose is to prove expected failures map through explicit branches rather than the safety catch.

## 19.5 Recall tests

Build memory with at least four authorities with distinct timestamps plus one invalid historical row. Drive real `queryDecisions()` where possible instead of mocking its return for the release-gate cases.

Use actual structured tool parts such as:

```ts
{
  type: "tool",
  tool: "recall_decision",
  state: {
    status: "completed",
    input: { query: "database", limit: 1 },
  },
}
```

Also include fake formatted output containing unrelated IDs and prove it is ignored.

---

# 20. Expected file changes

Primary production changes:

```text
src/memory/extract-prompt.ts
src/memory/extract-llm.ts
src/memory/writer.ts
src/memory/schema.ts
src/memory/source-processing.ts        # new, preferred
src/memory/lock.ts                     # only if queue diagnostics/API need a small source-key adjustment
```

Likely tests:

```text
test/memory/extract-prompt.test.ts      # or current canonical-input test file
test/memory/extract-llm.test.ts
test/memory/writer-llm.test.ts
test/memory/writer.test.ts
test/memory/schema.test.ts
test/memory/migrate.test.ts
test/tools/recall.test.ts
test/tools/status*.test.ts
```

Documentation during implementation:

```text
docs/CRIP/PR-5/blockers.md
docs/CRIP/PR-5/oracle-investigation.md
```

Do not modify PR 6's extraction trust policy or PR 8's generalized budget contract while implementing PR 5.

---

# 21. Implementation risks / oracle attack surface

The eventual oracle review should actively try to break these assumptions.

## A. Hidden mutable state in source hash

Search the source hash serializer for:

```text
priorStateJson
revision
last_updated
recent_sessions
llm_extraction_*
model_health
```

Any of those in source identity is a blocker.

## B. Completion written separately from facts

A crash between accepted-facts commit and completion-marker commit recreates I7. They must be one transaction/revision.

## C. Completion marker pruned during the successful commit

`llm-success` without a surviving current completion marker is not release-safe.

## D. Cache replay on hit

A completed-source hit that re-merges old facts can revive superseded state. Fast path must be no-op.

## E. Source-session-only in-flight key

Search process-local queue and extraction in-flight maps. Same session + appended source must not be swallowed.

## F. Contract version omitted from one identity layer

The version must influence source key and extraction key, not live only as metadata.

## G. Variant omitted from model-specific key

If the host selects a materially different model variant, the extraction key must differ.

## H. Legacy cache accidentally accepted

Old evidence-backed rows can stay readable but must not pass current-contract identity checks.

## I. Broad outcome catch

Any `catch { return "heuristic-only" }` in the idle pipeline is presumptively a blocker.

## J. `llm-failed` used for persistence failures

If accepted LLM work cannot commit because STATE is unavailable/commit-failed/lock-timeout, the outcome must report the persistence/transaction failure rather than blaming the model.

## K. Recall output parsing

Any regex/string parsing of formatted recall output to obtain IDs is a blocker. Use structured input + canonical query.

## L. Recall post-merge selection

If current-source heuristic mutations happen before the recall query is replayed, the returned-ID set can drift from the pre-existing memory the recall tool was consulting.

---

# 22. Explicit non-goals

PR 5 does not:

- change the decision authority hierarchy from PR 3;
- allow the LLM to mint stronger provenance;
- implement PR 6's decisions-only LLM durable contract;
- redesign compaction;
- solve PR 8's final storage/injection budgets;
- redesign process/project diagnostics beyond making the existing outcome truthful;
- change OpenCode host compatibility established by PR 4;
- hold the project filesystem lock across model/network work;
- claim a crash-recoverable cross-process **in-progress prompt lease**.

---

# 23. Definition of done

PR 5 is ready for oracle review when all of the following are true:

```text
same completed source version
  -> durable processed-source hit
  -> cache-hit
  -> zero audit session
  -> zero prompt
  -> zero semantic replay
  -> zero revision bump

same behavior after process-local resets/reload

same session + appended bounded source
  -> different source version key
  -> distinct queued work
  -> processing permitted

LLM success
  -> accepted facts + completion marker in one transaction

every public idle outcome
  -> describes the stage that actually completed/failed

recall recency
  -> exactly the authority IDs canonical recall would return for structured query/limit input
```

The release candidate must pass all 84 release-gate cases, the full PR 1–4 regression suite, host-contract verification, build/bundle/CLI smoke, and one fully green GitHub Actions run.
