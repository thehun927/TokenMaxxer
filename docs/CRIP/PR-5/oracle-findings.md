# PR 5 Oracle Findings — Source-Version Idempotency & Truthful Idle Outcomes

**Review target:** `c9903a43a78dfabe097ced5a132d833d066f5f1a`  
**Handoff commit:** `9a928e00973927510ed24a7219918c8727136dca`  
**CI:** GitHub Actions run `31496973429` — green  
**Verdict:** **Block**

PR 5 is substantially implemented and the exact pushed head is CI-green, but four release-gate invariants are still breakable by deterministic states the current tests do not cover. These are focused correctness issues, not a request to redesign the workstream.

---

## 1. Blocking issues

### B1 — `finalLLMMerge()` can promote a cache payload that has no durable completion marker

**Files:** `src/memory/writer.ts` (`processPreparedIdleSource`, `finalLLMMerge`)

Wave 8 correctly changed the pre-prompt cache path so a result-cache row without `processed_sources` is ignored rather than replayed. However, `finalLLMMerge()` re-reads the authoritative base and still does this:

```ts
const concurrentCacheEntry = readExtractionCacheEntry(...)
if (concurrentCacheEntry) {
  effectiveFacts = concurrentCacheEntry.facts
  effectiveAuditSessionID = concurrentCacheEntry.provenance?.source_audit_session_id
    ?? args.extractionAuditSessionID
}
```

It then merges `effectiveFacts` and writes a new processed-source completion record.

That allows a cache payload without completion proof to become authoritative after all, just later in the same pipeline.

#### Deterministic reproduction

1. Persist a schema-valid current-contract cache row for source `S`, model `M`, valid evidence, facts `OLD`, but **no** `processed_sources` entry.
2. Deliver source `S` again.
3. The pre-prompt path correctly ignores the cache row.
4. Let the retained LLM request return accepted facts `NEW`.
5. `finalLLMMerge()` re-reads the old cache row, replaces `args.llmFacts` (`NEW`) with `OLD`, merges `OLD`, writes the completion marker, and returns success.

The fresh accepted result is discarded and a previously incomplete cache payload is effectively promoted into completed source state.

This violates the PR 5 rule that the cache is optional payload only and cannot authorize replay/completion without the durable processed-source ledger.

#### Required fix

Inside `finalLLMMerge()`:

- `processed_sources` is the only already-complete authority;
- if the source is not complete, merge **the current accepted `args.llmFacts`**;
- do not substitute facts from an uncompleted cache row;
- a concurrent cache row without its matching completion marker is diagnostic/disposable only.

Add a regression where stale cache facts differ from the fresh accepted facts and prove the fresh facts win and the stale payload is never replayed.

---

### B2 — Source-version identity is computed from a different file-candidate window than the actual prompt

**Files:** `src/memory/writer.ts` (`prepareIdleSource`), `src/memory/extract-prompt.ts` (`buildExtractionSourceInput`, `extractFileCandidates`, `buildCanonicalInput`)

`prepareIdleSource()` does:

```ts
const windowMessages = allMessages.slice(-TRANSCRIPT_WINDOW)
const sourceInput = buildExtractionSourceInput(allMessages)
...
const canonicalInput = buildCanonicalInput(windowMessages, canonicalPrior)
```

`extractFileCandidates()` scans every message it receives, sorts candidates, and keeps only the first 20.

Therefore the durable source key is based on **all-history** file candidates, while the prompt is based on the **last-50-message** file candidates.

This can make a genuinely changed prompt input retain the old source key.

#### Deterministic reproduction

1. Build a long session with more than 50 messages and at least 20 older tool-file candidates that sort before a later candidate (for example `src/a00.ts` ... `src/a19.ts`).
2. Complete source version `S`.
3. Append a tool-only message in the current last-50 window with `src/z-new.ts`, without adding eligible text.
4. `buildCanonicalInput(windowMessages, ...)` now includes `src/z-new.ts` in `fileCandidates`.
5. `buildExtractionSourceInput(allMessages)` still takes the lexicographically first 20 all-history candidates, so `src/z-new.ts` is excluded and the source hash can remain unchanged.
6. The prior `processed_sources` hit can return `cache-hit`, skipping extraction even though the model-visible file-candidate set changed.

This violates hard invariant 7 and release case A6: changed bounded file-candidate input must change source identity.

#### Required fix

Use one canonical bounded source window for both source identity and prompt construction. The simplest correction is to build `ExtractionSourceInput` from the same `windowMessages` used by `buildCanonicalInput`, or factor both through one prepared source object so transcript/file-candidate semantics cannot diverge.

Add an adversarial test with >50 messages and >20 historical candidates proving a new in-window tool candidate changes `sourceVersionKey`.

---

### B3 — Model-specific extraction identity can describe a different model than the one that actually produced the facts

**Files:** `src/memory/writer.ts` (`processPreparedIdleSource`), `src/memory/extract-llm.ts` (`getLLMConfig`, automatic discovery)

The writer resolves a model twice:

```ts
const cacheConfig = await getLLMConfig(..., { ignoreHealth: true })
const selectedModel = cacheConfig.model
const selectedCacheKey = makeExtractionCacheKey({ model: selectedModel, ... })

const gatedConfig = await getLLMConfig(..., { memory: afterHeuristic, ... })
...
const llmResult = await extractFactsLLM(..., gatedConfig, ...)

finalLLMMerge(... {
  selectedModel,
  selectedCacheKey,
  llmFacts,
})
```

Automatic discovery explicitly filters cooling models when health is respected. Consequently the two calls can select different models:

- ignore-health lookup selects automatic model `A`;
- health-aware lookup skips cooling `A` and selects `B`;
- the prompt runs against `B`;
- final cache metadata and `processed_sources.extraction_key` are built from `A`.

That breaks the PR 5 contract that the extraction key identifies the exact provider/model/variant invocation which produced the accepted facts.

#### Required fix

After the gated model is resolved, make that model the single authority for:

- extraction key;
- cache lookup/write identity;
- final merge `selectedModel`;
- processed-source `extraction_key`;
- audit/provider/model/variant metadata.

If a pre-gate cache lookup is retained, it must not cause final persisted identity to describe a model other than `gatedConfig.model`.

Add an automatic-discovery test with two eligible models where the first is cooling. Assert the prompt, cache row, audit row, and processed-source extraction key all identify the second model.

---

### B4 — Malformed recall `state.input` shape can mark the default ten authorities as recently used

**File:** `src/memory/writer.ts` (`markReferencedDecisions`)

The implementation validates `query` and `limit` fields, but never validates that `state.input` itself is a record:

```ts
const input = ((part as any).state?.input ?? {}) as Record<string, unknown>
const parsed = parseToolInput(input)
```

A TypeScript cast does not validate runtime shape. For example:

```ts
state: {
  status: "completed",
  input: "garbage"
}
```

causes `input["query"]` and `input["limit"]` to resolve `undefined`, so the parser accepts the production defaults (`query=undefined`, `limit=10`) and marks the newest ten authorities.

Likewise `input: null` is converted to `{}` by `?? {}` and treated as a valid empty invocation.

PR 5 explicitly requires malformed/failed recall calls to mark nothing.

#### Required fix

Before parsing fields, require a plain non-array object for `state.input`. Missing/null/string/array/other malformed shapes must contribute no recency marks.

Add F68 regressions for at least:

- `input: null`;
- `input: "garbage"`;
- `input: []`;
- optionally missing `input` if production considers that malformed rather than equivalent to `{}`.

---

## 2. Non-blocking concerns

1. `mergeAsyncFacts()` remains exported with comments describing a cache-hit merge even though current production no longer uses cache payload replay. This is stale API/comment surface and could invite future misuse; remove or clearly mark it compatibility/test-only when convenient.
2. `prepareIdleSource()` currently scans the full session for source identity before bounded helpers cap their outputs. Even after B2 is fixed, keep source preparation bounded to avoid work scaling with indefinitely long sessions.
3. The handoff says “38 files, 572 tests passed.” The exact CI result is 571 passing + 1 expected pre-build skipped = 572 total. This is only wording, not a gate issue.
4. `npm ci` still reports 9 dependency vulnerabilities; unchanged and deferred to PR 10 as previously planned.

---

## 3. Test gaps ranked by likelihood × impact

### High

1. Current-contract cache row without completion marker + fresh successful LLM result with **different facts**. Prove final merge uses fresh facts, never stale cache payload.
2. >50-message session + >20 historical file candidates + new in-window tool-only candidate. Prove source key changes with the prompt-visible candidate set.
3. Automatic discovery with model A cooling and model B healthy. Prove all persisted extraction identity belongs to B.

### Medium

4. Completed `recall_decision` with non-object/null/array `state.input` marks nothing.
5. Automatic discovery where the ignore-health and health-aware inventory calls return different ordering; persisted identity must still describe the actually prompted model.

---

## 4. Things that look correct

- Exact pushed head has a fully green GitHub Actions run.
- `processed_sources` is written in the same final `mutateMemory()` transaction as accepted semantic facts.
- The newly written completion marker is protected through pruning, and irreducible over-cap state fails closed instead of returning `llm-success` without proof.
- Normal completed-source fast path occurs before heuristic mutation and performs no replay/revision bump.
- Same-process idle queue identity uses `sourceVersionKey`, not session ID alone.
- LLM in-flight identity includes project + source + model.
- Required lock timeout vs commit/read failure mappings are separated into `queue-failed` vs `write-failed`.
- Unexpected pipeline exceptions map to `error`, not `heuristic-only`.
- Queue `lastOutcome` publication is centralized at the public writer boundary.
- Recall recency uses canonical `queryDecisions()` against the pre-merge base and does not parse formatted output.
- `_recallDecision()` remains read-only.
- No LLM/network call was found inside a PR 2 `mutateMemory()` callback.
- Legacy cache/audit rows cannot directly satisfy the new processed-source completion lookup.

---

## 5. Release-gate exit criteria

PR 5 can return for focused re-review after one remediation wave that:

1. removes cache-payload substitution from incomplete-source final merge;
2. unifies source identity and actual bounded prompt source window;
3. binds persisted extraction identity to the model actually used after gating;
4. rejects malformed recall input shapes;
5. adds the four adversarial regressions above;
6. produces a fully green exact-head GitHub Actions run.

No broader PR 5 redesign is required.
