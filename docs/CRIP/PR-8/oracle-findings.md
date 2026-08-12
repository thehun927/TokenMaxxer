# CRIP PR 8 — Oracle Release-Gate Findings

**Planning baseline:** `7b1b904deb764cfe99c7b239f7cb75f34635688e`  
**PR-7 production baseline:** `141bec918d08d8e25a358231c15a16fcc37efb62`  
**PR-8 implementation head:** `abcbce9ae30e4c55b47261cee7971173023cfb79`  
**Remote source/test-equivalent validation head:** `309fe7e53d61ce98c969862a64f99aee16ac7eeb`  
**GitHub Actions run:** `31558345975` — success  
**Implementation handoff:** [`oracle-investigation.md`](./oracle-investigation.md)  
**Verdict:** **Block**

PR 8 has the right high-level architecture: storage fitting is centralized in `mutateMemory()` after the real next revision is calculated; `commitMemoryExact()` remains the final 8,192-byte guard; budget rejection is typed and no-write/no-revision; operation protection exists for processed-source markers, audit guards, and review targets; schema compatibility ceilings were added; and automatic durable rendering now has an explicit 4,096-byte target.

However, four release-blocking gaps remain. They are concentrated enough for one remediation wave and do not require redesigning PR 8.

---

## B1 — The storage fitter does not actually evict disposable metadata under ordinary schema-valid byte pressure

**Status:** blocker

The documented retention order says operational metadata is disposable before semantic facts. The implementation does not enforce that order for ordinary schema-valid states.

In `src/memory/budget.ts`, the early stages mostly enforce record-count ceilings rather than removing records until the byte budget fits:

- completed audits: keep up to 20;
- cache rows: keep up to 10;
- model health: keep up to 10;
- recent sessions: keep up to 10;
- processed sources: keep up to 10 unprotected rows;
- active files: keep up to 16.

Those are already the persistence/count ceilings for valid current state. Therefore a valid state with, for example, one large disposable cache row is still over budget after the cache stage. Later stages can delete semantic decisions or ultimately return `required-state-exceeds-budget` while the disposable cache row remains.

A deterministic high-value repro is:

1. Start with a schema-valid memory containing no foundational decisions and no operation protection.
2. Add one evidence-backed cache row whose decisions-only payload is large enough that the serialized STATE exceeds 8,192 bytes but remains within the cache/schema field bounds.
3. Call `fitMemoryToBudget()`.
4. Stage 2 retains the single cache row because `slice(-10)` is unchanged.
5. There may be no semantic state left to prune.
6. The fitter can return `required-state-exceeds-budget` even though deleting the optional cache row would make STATE fit immediately.

The same issue exists for completed audit history and model-health rows at their normal schema-valid counts.

There is also an important pending-audit regression: the completed-audit stage retains only pending audit rows explicitly listed in the current `preserveAuditSessionIDs`; other non-stale pending guards can be dropped whenever that stage runs. Prior CRIP semantics deliberately retained active pending guards ahead of completed history. In a cross-process project, one mutation must not silently erase another retained extraction guard merely because it is not the current mutation's audit ID.

Several Wave-2 tests missed this because they construct 30 cache rows, 30 processed sources, 100 health rows, 100 sessions, etc. Those shapes are above the current persistence count ceilings and prove count normalization, not byte-pressure eviction of a schema-valid state.

### Required remediation

Make stages 1–6 genuine pressure stages:

- remove oldest completed audits incrementally while over cap;
- preserve every non-stale pending audit guard unless it is explicitly stale/reclassified;
- remove oldest cache rows incrementally while over cap;
- remove model-health/quarantine metadata incrementally while over cap;
- remove oldest recent sessions and unprotected processed sources incrementally while over cap;
- remove least-recently-touched active files incrementally before semantic decision pressure.

Recompute exact serialized bytes after each deterministic eviction or equivalent deterministic prefix selection.

Add regressions using **MemoryFileSchema-valid** states at normal maximum counts, including:

1. one large disposable cache row + one semantic decision: cache is dropped and decision survives;
2. <=20 completed audits whose aggregate bytes cause pressure: completed audits are removed before decisions;
3. <=10 model-health rows under pressure: health is removed before decisions;
4. two pending audit guards where only one belongs to the current operation: neither active guard is silently discarded;
5. ordinary <=16 active files under pressure: oldest files are evicted before recent valid decisions.

---

## B2 — The mandatory durable-block prefix can exceed the 4,096-byte injection ceiling

**Status:** blocker

`buildDurableBlock()` checks the byte budget only for optional candidates. It unconditionally pushes:

1. the opening delimiter;
2. `DATA Project: ...`;
3. `DATA Memory freshness: ...`;
4. the closing delimiter.

The project path is sanitized with a **character** cap of 1,024 code points. A 1,024-code-point path made from four-byte Unicode characters can therefore contribute roughly 4,096 bytes by itself before `DATA `, labels, newlines, freshness, and delimiters are counted.

Because `projectLine` and `freshnessLine` bypass the projected-size check, the returned block can exceed `DURABLE_BLOCK_MAX_BYTES` even though all optional candidates obey the strict prefix rule.

This violates the hard PR-8 invariant that every automatic durable block is <=4,096 UTF-8 bytes including framing.

The shared `truncateUtf8()` primitive also violates its own byte-fit contract for very small budgets: when `maxBytes < 3`, it returns `"..."`, which itself exceeds the requested budget. The current unit test explicitly expects this at `maxBytes=0`. That helper should never return more bytes than its declared maximum.

### Required remediation

- Budget the mandatory project/freshness lines exactly like all other framing.
- Prefer UTF-8-safe byte truncation for project identity (or a separately bounded mandatory-header builder) so the opening delimiter + mandatory DATA + closing delimiter are guaranteed <=4,096.
- Make `truncateUtf8(value, maxBytes)` satisfy `utf8Bytes(result) <= maxBytes` for every nonnegative budget, including 0, 1, and 2.
- Keep PR-7 sanitization/data-only semantics intact.

Add regressions for:

1. a project path containing 1,024 four-byte emoji/code points;
2. multibyte project identity plus the normal freshness line;
3. exact 4,096-byte mandatory-prefix boundary;
4. `truncateUtf8()` budgets 0, 1, 2, and 3.

---

## B3 — HEADER generation still uses pre-fit callback memory instead of the committed fitted memory

**Status:** blocker

`mutateMemory()` correctly exposes the actual fitted committed state as `result.memory`.

But `processPreparedIdleSource()` still does:

```ts
const heuristicMemory = heuristicResult.value.memory
await writeHeaderBestEffort(client, worktree, directory, heuristicMemory)
```

and after the final LLM merge:

```ts
const finalMemory = finalResult.value.memory
await writeHeaderBestEffort(client, worktree, directory, finalMemory)
```

`value.memory` is the callback's pre-fit candidate. The final LLM callback even documents that callers should use `result.memory`, but the production caller does not.

Under pressure the central fitter may remove/truncate `current_task` or otherwise alter the candidate before persistence. HEADER can therefore describe state that was never committed.

This directly violates PR-8's requirement that derivative HEADER generation consume the actual committed fitted state.

### Required remediation

For committed mutations use:

```ts
heuristicResult.memory
finalResult.memory
```

for HEADER generation and any subsequent logic that claims to represent the committed state.

Do not use callback-carried `value.memory` as authoritative after a commit.

Add a pressure regression where fitting changes/removes current task and prove HEADER matches the persisted fitted STATE rather than the pre-fit candidate.

---

## B4 — Tight automatic creation limits are declared but not fully enforced by heuristic production code

**Status:** blocker

`MEMORY_CREATION_LIMITS` is exported with the intended limits, and the schema tests verify the constant values and broad persistence ceilings. That does not prove automatic producers obey the creation contract.

At least two live heuristic paths remain outside the declared limits:

### Active-file path

`normalizePath()` returns the incoming path without applying `activeFilePathChars = 2048`.

A tool-provided source-like path between 2,049 and 4,096 characters can therefore be newly created and durably accepted because the persistence ceiling is 4,096.

### Heuristic decision topic

`extractTopicPhrase()` returns the normalized topic without applying `decisionTopicChars = 256`.

The decision text is capped at 500, but a long noun phrase before a stop word can create a new heuristic topic longer than the 256-character creation contract while still remaining within the broad 8,192-character persistence ceiling.

Current task, blockers, next steps, and decision text happen to use older tighter caps, but the new centralized creation contract is not mechanically authoritative.

The release-matrix handoff maps cases 41–44 to `pr8-schema-compat.test.ts`; those tests mainly validate exported constants/schema acceptance and do not drive the real heuristic extractor through over-limit inputs.

### Required remediation

Make automatic producers use `MEMORY_CREATION_LIMITS` (or a single shared creation-bound helper) rather than relying on unrelated historical literals.

At minimum:

- cap/reject active-file paths at `activeFilePathChars` before durable creation;
- cap heuristic decision topics at `decisionTopicChars`;
- use the constants for current task, decision text/rationale, blocker/next-step strings/counts, and active-file counts so the contract cannot drift again.

Add real extractor/merge tests with over-limit transcript/tool inputs proving the emitted automatic facts themselves satisfy all creation limits.

---

## What held up

The focused review found the following core PR-8 architecture sound:

- `mutateMemory()` computes `base.revision + 1` before fitting;
- budget rejection is typed and leaves prior STATE/revision untouched;
- successful commits pass the fitted candidate through `commitMemoryExact()`;
- direct exact commits still enforce the 8,192-byte final guard;
- final LLM merge protects the new processed-source key;
- audit creation carries current audit protection;
- `recall_promote` protects its decision target;
- human promotion/supersession remain transactional and fail closed on budget refusal;
- current-v3 non-authoritative array compatibility repair is pure/deterministic;
- durable decision retention remains independent from automatic injection;
- PR-7 DATA sanitization and compaction-mode behavior were not widened;
- `[llm:eN]` now represents retained evidence cardinality rather than render ordinal.

---

## CI evidence

The exact implementation SHA `abcbce9ae30e4c55b47261cee7971173023cfb79` did not receive its own Actions run.

However, remote validation head `309fe7e53d61ce98c969862a64f99aee16ac7eeb` differs from the implementation head only in documentation/ignore files; no source or test file changed. GitHub Actions run `31558345975` is therefore valid evidence for the same production/test tree.

The run is green across the full chain.

Exact Vitest result:

```text
Test files: 50 passed, 1 skipped (51 total)
Tests:      950 passed, 1 skipped (951 total)
```

The skipped test is the expected pre-build CLI launcher test.

The same run passed:

- `npx tsc --noEmit`;
- minimum-host verification against `@opencode-ai/plugin@1.18.15`;
- distribution build;
- self-contained bundle verification;
- CLI bundle/launcher/installer verification;
- post-build CLI smoke;
- installer/launcher shell syntax validation.

The implementation handoff's local statement `951 tests passed; 0 failed` should not be used as the canonical CI count; the remote run is `950 passed + 1 skipped = 951 total`.

Green CI does not close the four semantic gaps above because the current PR-8 fixtures do not exercise those exact shapes.

---

# Exit criteria for focused remediation

One remediation wave should be sufficient:

1. make schema-valid disposable metadata actually evict before semantic state and preserve all live pending guards;
2. guarantee mandatory durable framing/prefixes fit the 4,096-byte total and repair `truncateUtf8()` tiny-budget behavior;
3. use `MemoryMutationResult.memory` for HEADER/committed-state consumers;
4. mechanically enforce automatic creation limits in real heuristic producers;
5. add adversarial regressions for each blocker;
6. run the full release chain on the exact remediation production/test tree;
7. publish `docs/CRIP/PR-8/oracle-rereview.md` for independent focused review.

Do not advance PR 9 until this focused re-review clears.

# Verdict

**Block.**

The PR-8 architecture is close, but the workstream cannot claim guaranteed storage/injection budgets while optional metadata can force semantic loss/refusal, mandatory durable framing can exceed 4KB, derivatives can describe uncommitted pre-fit state, and automatic producers can exceed the declared creation contract.
