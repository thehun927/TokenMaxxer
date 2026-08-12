# CRIP PR 8 — Concrete Implementation Plan

**Workstream:** Guaranteed storage and injection budgets  
**Planning baseline:** `7b1b904deb764cfe99c7b239f7cb75f34635688e`  
**Production baseline:** `141bec918d08d8e25a358231c15a16fcc37efb62` (PR 7 final production change)  
**PR 7 validation baseline:** `383d0190dc3fc43fbdc27d34b4065660222dbc1e`  
**Status:** Implementation plan ready  
**Program authority:** [`../implementation-plan.md`](../implementation-plan.md)

PR 8 closes the remaining resource-boundary gap between TokenMaxxer's durable-state semantics and its actual byte limits. PRs 1–7 established authoritative storage, transactions, decision authority, host compatibility, source idempotency, the LLM trust boundary, and compaction anti-drift. PR 8 must make those semantics hold **under storage pressure and automatic-injection pressure**, not only in ordinary states.

---

## 1. Release invariant

> **Every successful durable mutation produces a schema-valid STATE representation that is guaranteed to fit the 8,192-byte storage cap at the revision that will actually be committed; every automatic durable-context block is a deterministic sanitized UTF-8 representation no larger than 4,096 bytes; protected human authority and operation-required proof are never silently discarded to satisfy either budget.**

Corollaries:

1. `MEMORY_MAX_BYTES = 8_192` remains the hard on-disk ceiling.
2. `DURABLE_BLOCK_MAX_BYTES = 4_096` becomes the independent automatic injection ceiling.
3. Byte accounting is UTF-8 byte accounting, never JavaScript character count.
4. A successful budget-fit result is directly writable; there is no legitimate successful over-cap intermediate state.
5. If protected state cannot fit, the mutation is rejected without a revision bump and the previous authoritative STATE remains intact.
6. Durable retention and automatic injection remain independent policies.
7. PR 3 human authority, PR 5 completion/idempotency proof, PR 6 trust meaning, and PR 7 data-only compaction semantics may not be weakened to make a budget fit.

---

## 2. Confirmed current gaps

### 2.1 Storage has a hard final guard but not a guaranteed pruning postcondition

`src/memory/memory-size.ts` already defines:

```ts
MEMORY_MAX_BYTES = 8_192
memorySizeBytes(memory)
```

and `commitMemoryExact()` rejects an over-cap serialized STATE. That final defense is correct and remains.

The current `pruneOld()` contract is weaker: it returns a `MemoryFile` even when the result remains over 8KB. `commitMemoryExact()` then converts the actual failure into generic `commit-failed`. That is safe against writing an oversized file, but it does not provide a typed storage-pressure contract and does not guarantee that a reported prune success is writable.

### 2.2 Pruning happens before `mutateMemory()` advances revision

The current writer prunes inside the mutation callback, then `mutateMemory()` replaces the revision with `base.revision + 1` before serialization.

A state that fits exactly before the revision changes can grow by one or more bytes when the decimal revision gains a digit (`9 -> 10`, `99 -> 100`, etc.). PR 8 must budget the **actual committed representation**, not the callback's pre-revision representation.

### 2.3 Writer-specific pruning does not cover every mutation path

Human promotion/supersession and `recall_promote` use `mutateMemory()` directly. They currently rely on the final commit size guard rather than the same deterministic pruning contract used by idle writes.

Storage budgeting belongs at the canonical transaction boundary so every commit path has one policy.

### 2.4 Some logical mutation effects must be protected under pressure

PR 5 requires the newly written `processed_sources` completion marker to survive the same transaction as accepted LLM facts. The audit guard that permits retained extraction also has to survive before the model call occurs. A foundational review request should not report success if its target decision is pruned in the same commit.

Budget fitting therefore needs explicit operation-required protection in addition to foundational retention.

### 2.5 Durable schema fields remain broadly unbounded

The v3 schema bounds provenance identifiers and several operational structures, while important semantic strings such as `current_task`, active-file path/reason, decision topic/text/rationale, blockers, and next steps remain broadly or entirely unbounded at the persistence layer.

New runtime construction should have tight creation bounds. Existing v3 state must remain compatible: PR 8 must not make a previously valid PR-7 STATE unreadable merely because a new `.max()` was added.

### 2.6 Automatic durable rendering has per-field character caps, not a total byte contract

PR 7 intentionally left `buildDurableBlock()` without a total byte limit. It currently renders project identity, task, observed files, decisions, blockers, and next steps after per-field sanitization. Large but valid retained state can therefore create a large automatic compaction payload.

PR 8 owns the hard aggregate limit.

---

## 3. Hard constants and shared primitives

### 3.1 Storage ceiling

Keep:

```ts
export const MEMORY_MAX_BYTES = 8_192
```

Do not raise this limit to avoid fixing pruning semantics.

### 3.2 Injection ceiling

Add:

```ts
export const DURABLE_BLOCK_MAX_BYTES = 4_096
```

Prefer placing this with the durable-render budget code (`src/compaction/durable.ts` or a small `src/compaction/budget.ts`). It is not the STATE storage ceiling and should not be reused for storage pruning.

### 3.3 UTF-8 helpers

Centralize exact helpers instead of scattering `Buffer.byteLength` calls:

```ts
export function utf8Bytes(value: string): number
export function fitsUtf8Budget(value: string, maxBytes: number): boolean
export function truncateUtf8(value: string, maxBytes: number): string
```

`truncateUtf8()` must never split a UTF-8 code point and must reserve space for its truncation marker when one is emitted.

`memorySizeBytes()` remains based on the exact pretty-printed representation written by `commitMemoryExact()`:

```ts
JSON.stringify(memory, null, 2)
```

---

## 4. Replace `pruneOld()` with a typed budget contract

Create a dedicated module, recommended:

```text
src/memory/budget.ts
```

Do not leave the primary policy buried inside `writer.ts`.

### 4.1 Result type

Use an explicit success/failure union:

```ts
export type MemoryBudgetFailureReason =
  | "foundational-state-exceeds-budget"
  | "required-state-exceeds-budget"

export type MemoryBudgetProtection = {
  preserveProcessedSourceKeys?: readonly string[]
  preserveAuditSessionIDs?: readonly string[]
  preserveDecisionIDs?: readonly string[]
}

export type PruneResult =
  | {
      ok: true
      memory: MemoryFile
      bytes: number
      maxBytes: number
      pruned: boolean
    }
  | {
      ok: false
      reason: MemoryBudgetFailureReason
      requiredBytes: number
      maxBytes: number
    }
```

The failure branch must **not** return an over-cap memory object that a caller might accidentally commit.

### 4.2 API

```ts
export function fitMemoryToBudget(
  memory: MemoryFile,
  options?: {
    now?: number
    protection?: MemoryBudgetProtection
  },
): PruneResult
```

The input memory already contains the revision that will be serialized. The function must never mutate the input.

### 4.3 Protected durable authority

Use the canonical PR-3 trust predicate where possible. At minimum, a human-reviewed foundational authority is never deleted to satisfy the storage cap.

Do not weaken this to “newest foundational only.” Every trusted human foundational row required by the authority/history model survives ordinary pruning.

### 4.4 Operation-required protection

`MemoryBudgetProtection` is temporary commit intent, not a new durable field.

Required examples:

- final LLM merge: protect the newly created `processed_sources.source_key`;
- retained extraction audit creation: protect the new pending `audit_session_id`;
- `recall_promote`: protect the target decision ID so a successful review request cannot prune its own target/effect;
- human promotion/supersession: the new human foundational authority is inherently protected; explicit ID protection is allowed for defense-in-depth.

Do not protect cache rows, model health, completed audit history, or old processed-source rows merely because they are recent.

---

## 5. Deterministic storage-retention policy

Budget fitting should remove or compress **one semantic class at a time**, rechecking exact serialized bytes after every deterministic stage. Avoid fixed “keep 10 then keep 5” jumps when incremental eviction can preserve more state.

Use this order unless implementation evidence proves a narrower ordering is required:

### Stage 0 — normalize disposable operational metadata

- reclassify stale pending audits using the existing timeout rule;
- apply existing hard record-count bounds;
- remove impossible duplicate disposable metadata where existing helpers already define identity.

### Stage 1 — completed audit history

Remove oldest completed audit rows first. Pending protected audit guards are not eligible.

### Stage 2 — result cache

Remove oldest cache rows. Cache is optional; completion proof is not.

### Stage 3 — model-health and quarantine metadata

Remove oldest model-health rows, then cache-quarantine metadata.

### Stage 4 — old source/session bookkeeping

- remove oldest `recent_sessions` entries;
- remove oldest `processed_sources` entries except protected source keys.

The protected current source key must survive a successful final LLM commit.

### Stage 5 — invalid disposable decisions

Remove `still_valid === false` decisions that are not protected human conflict/history rows and are not explicitly protected by the current operation.

### Stage 6 — stale observed files

Remove least-recently-touched active-file observations one at a time. Active files cannot carry human/LLM authority after PR 6.

### Stage 7 — old non-foundational decisions

Remove non-protected, non-foundational decisions older than 30 days, oldest first.

### Stage 8 — verbose optional detail

Shorten/drop optional verbosity before deleting authoritative core text:

- decision rationale (including foundational rationale, because rationale is optional while topic/decision/trust are not);
- active-file reason;
- blocker/next-step verbosity;
- current-task verbosity.

Use deterministic UTF-8-safe truncation floors. Do not strip provenance/evidence needed to justify a trust level.

### Stage 9 — non-foundational decision pressure

Remove oldest/least-recently-used non-foundational decisions one at a time. Recently recalled decisions should outrank otherwise equivalent old non-foundational rows.

Operation-protected decision IDs cannot be removed.

### Stage 10 — current ephemeral state pressure

If still required to fit protected authority:

- remove oldest remaining active files;
- reduce/remove lower-priority blocker and next-step entries;
- reduce/remove current task if necessary.

This state is valuable but does not outrank trusted human authority.

### Stage 11 — typed refusal

If no legal disposable reduction remains:

1. compute whether the minimal legal state containing all trusted human foundational rows already exceeds `MEMORY_MAX_BYTES`;
2. if yes, return `foundational-state-exceeds-budget`;
3. otherwise the overflow is caused by operation-required protected proof/state and return `required-state-exceeds-budget`.

Never silently delete a protected row in order to return `ok: true`.

### Successful postcondition

Every `ok: true` result MUST satisfy:

```ts
memorySizeBytes(result.memory) === result.bytes
result.bytes <= MEMORY_MAX_BYTES
MemoryFileSchema.safeParse(result.memory).success === true
```

---

## 6. Move budget enforcement into `mutateMemory()`

`mutateMemory()` is the one cross-process serialized commit boundary and should become the one automatic storage-budget boundary.

### 6.1 Extend commit actions with transient budget protection

```ts
export type MutationAction<T> =
  | {
      kind: "commit"
      memory: MemoryFile
      value: T
      budgetProtection?: MemoryBudgetProtection
    }
  | { kind: "noop"; value: T }
```

### 6.2 Fit after calculating the real next revision

Inside the lock:

```text
read authoritative base
→ synchronous mutation callback
→ if noop: return
→ next.revision = base.revision + 1
→ fitMemoryToBudget(next, action.budgetProtection)
→ if budget failure: reject, no write, no revision bump
→ commitMemoryExact(fitted.memory)
```

This closes revision-digit growth (`9 -> 10`, `99 -> 100`) and ensures every successful fit is the exact representation that reaches the write primitive.

### 6.3 Add a typed transaction result

Extend internal transaction outcomes:

```ts
export type MemoryMutationResult<T> =
  | { status: "committed"; value: T; revision: number; memory: MemoryFile }
  | { status: "noop"; value: T; revision: number }
  | { status: "budget-rejected"; reason: MemoryBudgetFailureReason; revision: number }
  | { status: "lock-timeout" }
  | { status: "unavailable" }
  | { status: "commit-failed" }
```

`budget-rejected.revision` is the unchanged base revision.

The committed result must expose the **actual fitted memory**. Current writer callbacks sometimes place a pre-pruned memory object inside generic `value`; callers that need HEADER generation must switch to `result.memory` so diagnostics cannot describe state that pruning removed.

### 6.4 Public outcomes remain PR-5-compatible

Do not invent a new `IdleWriteOutcome`.

Map internal storage-budget refusal to:

```text
idle writer -> write-failed
```

with a bounded structured diagnostic carrying only the typed reason/current bytes/max bytes.

Human CLI operations may return a clearer user-visible refusal such as:

```text
Promotion would exceed the protected STATE budget; STATE unchanged.
```

but must not weaken the interactive review boundary.

---

## 7. Wire every durable mutation through the one policy

Audit every `mutateMemory()` caller. At minimum cover:

- heuristic idle transaction;
- final LLM merge;
- audit guard creation;
- audit terminal update;
- model-health update;
- `recall_promote` review request;
- CLI `promote`;
- CLI `supersede`.

Remove ad-hoc writer-side `pruneOld()` / `pruneOldForCommit()` calls after the central transaction boundary owns fitting.

### Required operation semantics

#### Heuristic idle write

Budget rejection -> `write-failed`; prior STATE and revision unchanged.

#### Final LLM merge

Protect the new processed-source key. A budget refusal means:

- no completion marker;
- no partial accepted-fact commit;
- no cache-only success;
- public result `write-failed`;
- the same source version remains retryable later.

#### Audit guard

Protect the newly created pending audit ID. If the guard cannot fit, do not prompt the model.

#### Best-effort terminal/health metadata

They may be pruned away under pressure and remain non-fatal, but a budget refusal must emit a bounded warning rather than pretending persistence happened.

#### Review request

Protect the selected decision ID for that commit. A successful `recall_promote` must leave the target row present with the requested state.

#### Human promotion/supersession

Trusted human state is never silently discarded. If adding the human-review proof itself makes protected state irreducible over budget, reject the mutation and preserve the prior unreviewed STATE.

---

## 8. Add field and construction bounds without breaking existing v3 STATE

PR 8 needs two layers of limits:

1. **tight creation bounds** for new automatic content;
2. **broader persistence compatibility ceilings** so an existing PR-7 `version:3` file does not suddenly become corrupt.

### 8.1 New automatic-content limits

Centralize creation limits, recommended:

```ts
export const MEMORY_CREATION_LIMITS = {
  currentTaskChars: 512,
  activeFilePathChars: 2_048,
  activeFileReasonChars: 512,
  decisionTopicChars: 256,
  decisionTextChars: 500,
  decisionRationaleChars: 500,
  blockerChars: 512,
  nextStepChars: 512,
  blockersMax: 8,
  nextStepsMax: 8,
  activeFilesMax: 16,
} as const
```

The LLM decisions-only contract already uses `256 / 500 / 500` and remains unchanged.

Heuristic extraction/merge must obey the same or tighter creation limits before values enter durable state.

### 8.2 Persistence compatibility ceilings

Add finite schema maxima to formerly unbounded persisted fields, but do not silently rewrite trusted human decision text merely to meet the new creation limits.

Recommended persistence ceilings:

```text
project_path                4096 chars
current_task                2048 chars
active_file.path            4096 chars
active_file.reason          2048 chars
blocker / next_step         2048 chars
decision topic/text/rationale 8192 chars each (grandfather ceiling; total 8KB file cap remains authoritative)
decision/session identifiers existing bounded identity contracts
```

The intentionally broad decision ceiling preserves old semantic/human-reviewed text. **New** decision creation remains capped at the tighter limits above.

Do not add a small hard schema count limit to `decisions`: count-pressure is semantic and must respect foundational/operation-required protection. The total byte budget is the authority for decision count.

Non-authoritative arrays may use broad safety ceilings (for example active files/blockers/next steps <= 128) plus tighter new-write creation limits.

### 8.3 Current-v3 compatibility repair

Before final `MemoryFileSchema.safeParse()` in `loadAndMigrate()`:

- normalize only fields that can be safely bounded without changing trusted authority meaning;
- cap grossly excessive non-authoritative arrays deterministically;
- preserve human-reviewed foundational topic/decision text exactly within the broad persistence ceiling;
- never invent provenance/evidence to repair a size problem;
- never run storage pruning during a read; loading remains pure and cannot silently persist a reduced document.

Add fixtures built from **actual current-version `version:3` shapes**, not only v1/v2 migration fixtures.

---

## 9. Independent 4,096-byte durable-injection policy

### 9.1 Total budget includes framing

For successful memory reads, the 4,096-byte budget includes:

- opening delimiter;
- every `DATA ` prefix;
- separators/newlines;
- compact provenance/freshness tags;
- closing delimiter.

`buildDurableBlock()` must satisfy:

```ts
Buffer.byteLength(block, "utf8") <= DURABLE_BLOCK_MAX_BYTES
```

The small `(no prior project memory)` and `(memory unavailable)` sentinels also trivially satisfy the same limit.

The limit applies only to the durable block. Do **not** truncate PR-7's outer preservation contract or host prompt to make the durable block fit.

### 9.2 Render candidates, not whole sections

Refactor durable rendering into deterministic candidates:

```ts
type DurableRenderCandidate = {
  priority: number
  stableKey: string
  line: string
}
```

Build sanitized lines first, then select them under the total byte budget.

### 9.3 Semantic priority

Use this deterministic priority:

1. project identity / memory freshness metadata;
2. current task;
3. blockers;
4. immediate next steps;
5. human-reviewed foundational decisions;
6. most-recently-touched durable file observations;
7. recently recalled/referenced valid decisions;
8. remaining valid non-foundational decisions, newest first;
9. lower-priority observed files/older decisions only while budget remains.

Within equal-priority groups use deterministic ties (timestamp descending, then stable decision ID/path lexically). Never depend on object insertion order where semantic ordering matters.

Human foundational decisions are high-priority **for injection**, but injection still does not promise that every foundational decision fits. Full durable state remains pull-recallable.

### 9.4 Prefix rule

Reserve the closing delimiter before adding each candidate.

For each candidate in priority order:

```text
if lines + candidate + closing delimiter <= 4096 bytes:
    include it
else:
    stop automatic lower-priority inclusion
```

Do not skip an oversized high-priority candidate and then fill the remaining bytes with lower-priority facts; that would invert semantic priority.

Individual rendered values may use UTF-8-safe render-only truncation so one field cannot consume the entire block. Such truncation changes only the automatic representation, never STATE.

### 9.5 Compact LLM provenance tag cleanup

Resolve the PR-7 non-blocking ambiguity while touching the renderer:

```text
[llm:eN]
```

should use `N = actual retained evidence pointer count (1..3)`, not a sequential ordinal across rendered LLM decisions.

This is representation-only; it does not change PR-6 trust semantics.

### 9.6 Data-only safety survives budgeting

The selection algorithm operates on already sanitized lines. It must never:

- reinsert raw stored newlines;
- split or synthesize durable delimiters;
- drop the `DATA ` prefix from a retained line;
- byte-slice through a UTF-8 code point;
- reinterpret instruction-like durable content as prompt syntax.

---

## 10. Retention and injection remain independent

The following must be demonstrated explicitly:

```text
STATE can retain fact X
AND
automatic 4096-byte durable block can omit X
AND
recall_decision/get_project_state can still retrieve X
```

A durable fact is not deleted merely because it did not fit automatic compaction injection.

Conversely, automatic injection selection must not mutate STATE, usage timestamps, revision, or provenance.

---

## 11. Concurrency and failure semantics

PR 8 must preserve PR 1–7 transactional invariants under budget pressure.

### 11.1 Rejection happens under the project lock

The callback sees the authoritative lock-read base. Budget fitting is performed against the resulting candidate and next revision before the atomic commit.

A concurrent actor cannot make the rejected candidate overwrite a newer state because no stale fallback write exists.

### 11.2 Budget refusal is a no-write, no-revision event

For `budget-rejected`:

```text
STATE bytes unchanged
revision unchanged
selected source unchanged
no HEADER generated from an uncommitted candidate
```

### 11.3 Required-source completion failure remains retryable

If final LLM persistence is rejected by storage budget, the protected source key was never written. A later attempt at the same unchanged source is therefore not a false `cache-hit`.

### 11.4 Header uses committed fitted state

After a committed mutation, HEADER generation must receive `result.memory`, the actual fitted state returned by the transaction, not a pre-fit object retained inside callback state.

---

## 12. Diagnostics owned by PR 8 vs PR 9

PR 8 may emit bounded warnings such as:

```text
memory budget rejected
reason=foundational-state-exceeds-budget|required-state-exceeds-budget
required_bytes=<number>
max_bytes=8192
```

Do not add new persistent diagnostic artifacts or per-project status history here; PR 9 owns diagnostic storage and status realism.

Do not include full decision text, paths, prompts, or STATE JSON in budget warnings.

---

## 13. Eight implementation waves

### Wave 1 — Freeze budget contracts with failing tests

Use three non-overlapping test agents before production edits.

**Agent A — storage/accounting tests**

Own only new/updated tests around `memory-size`, pruning, revision growth, and transaction rejection.

**Agent B — schema/migration compatibility tests**

Own only v3 compatibility and field-bound tests.

**Agent C — durable-injection tests**

Own only `test/compaction/*` budget/UTF-8/priority/adversarial fixtures.

Wave-1 agents must not redesign production code.

Luna integrates and verifies that the tests fail for the intended reasons.

### Wave 2 — Shared budget primitives

Recommended owner: storage-budget agent.

Files:

- `src/memory/memory-size.ts`;
- new `src/memory/budget.ts`;
- focused unit tests.

Deliver:

- UTF-8 helpers;
- `PruneResult` / failure reasons / protection type;
- pure deterministic `fitMemoryToBudget()`;
- exact incremental retention stages;
- no writer/store integration yet.

### Wave 3 — Schema + current-v3 compatibility

Recommended owner: schema/migration agent.

Files:

- `src/memory/schema.ts`;
- `src/memory/migrate.ts`;
- migration/schema tests.

Deliver:

- creation limits;
- persistence ceilings;
- pure pre-validation compatibility repair;
- no human foundational semantic truncation;
- current-v3 fixtures remain readable.

Do not change decision authority semantics.

### Wave 4 — Canonical transaction-budget boundary

Recommended owner: store/transaction agent.

Files:

- `src/memory/store.ts`;
- budget module as required;
- store/transaction tests.

Deliver:

- action-level transient protection;
- real-next-revision fitting inside `mutateMemory()`;
- `budget-rejected` typed result;
- committed result exposes actual fitted memory;
- commitMemoryExact remains the final invariant guard.

### Wave 5 — Migrate all durable mutation callers

Recommended owner: writer/CLI integration agent, with Luna resolving overlap.

Files may include:

- `src/memory/writer.ts`;
- `src/tools/recall.ts`;
- `src/cli.ts`;
- relevant tests.

Deliver:

- remove weak writer-specific prune return semantics;
- protect new source marker / pending audit guard / review target where required;
- map budget rejection to truthful public outcomes;
- HEADER uses committed fitted state;
- human promotion/supersession preserve prior STATE on protected overflow.

Do not run LLM/network calls under the project lock.

### Wave 6 — 4KB automatic durable block

Recommended owner: compaction-budget agent.

Files:

- `src/compaction/durable.ts`;
- optional new `src/compaction/budget.ts`;
- compaction budget tests.

Deliver:

- `DURABLE_BLOCK_MAX_BYTES = 4096`;
- deterministic candidate priority;
- UTF-8-safe accounting including delimiters;
- strict prefix rule;
- actual evidence-count `[llm:eN]` tags;
- unchanged PR-7 data-only sanitization and augment/replace behavior.

### Wave 7 — Pressure/concurrency integration and repository audit

Recommended owner: adversarial integration agent; Luna reconciles.

Test:

- foundational overflow;
- required processed-source overflow;
- audit-guard overflow;
- review-request overflow;
- revision digit growth;
- same-project concurrent near-cap mutations;
- read-only/global fallback near cap;
- multibyte injection;
- retained-but-not-injected recall;
- PR 1–7 regression suites.

Repository searches must prove there is no production call path that still treats an over-cap `MemoryFile` as a successful prune result.

### Wave 8 — Full release gate + Oracle handoff

**Luna only.**

Run the complete release chain on the exact final implementation SHA and create:

```text
docs/CRIP/PR-8/oracle-investigation.md
```

Then stop. Luna/subagents do not create Oracle findings, issue Ship, or advance PR 9.

---

## 14. Subagent orchestration rules for Luna

1. Luna is the implementation orchestrator, not Oracle.
2. Read this plan, `README.md`, and the master CRIP plan before assigning work.
3. Create `docs/CRIP/PR-8/blockers.md` before Wave 1 as an append-only implementation/decision log.
4. Prefer disjoint file ownership. Do not let two agents concurrently rewrite `store.ts`, `writer.ts`, `schema.ts`, or `durable.ts`.
5. Each wave gets one coherent reviewable commit after Luna inspects the integrated diff.
6. Do not accept “tests pass” from an agent without rerunning the named command after integration.
7. Do not weaken foundational retention, completion proof, audit guards, human review, or PR-7 sanitization to make a fixture green.
8. Do not pull PR 9 diagnostic persistence or PR 10 dependency/release work into PR 8.
9. If implementation evidence contradicts this plan materially, append the conflict to `blockers.md`; do not silently rewrite the contract.
10. Wave 8 handoff is evidence only. Independent Oracle owns the release verdict.

---

## 15. Semantic release matrix — 80 minimum cases

### A. Exact storage-size accounting — cases 1–8

1. `memorySizeBytes` matches the exact UTF-8 bytes written by `serializeMemory`.
2. ASCII and multibyte values with equal JS length produce different byte sizes where expected.
3. successful fit at exactly 8,192 bytes is accepted.
4. 8,193-byte candidate cannot return `ok:true`.
5. `truncateUtf8` never leaves malformed UTF-8/code-point fragments.
6. input memory is never mutated by budget fitting.
7. revision `9 -> 10` is included before budget fit.
8. revision `99 -> 100` is included before budget fit.

### B. Deterministic pruning/retention — cases 9–28

9. already-fitting memory remains semantically unchanged.
10. oldest completed audit is removed before semantic facts.
11. pending audit survives completed-audit pruning.
12. oldest cache is removed before semantic facts.
13. model-health rows are disposable before semantic facts.
14. cache-quarantine metadata is disposable before semantic facts.
15. oldest recent session is disposable under pressure.
16. oldest processed source is disposable when unprotected.
17. protected processed source key survives.
18. invalid non-foundational decision is removed before valid decisions.
19. protected human conflict/history row is not removed by invalid-decision stage.
20. least-recently-touched observed file is removed before recent observed files.
21. >30-day non-foundational decision is age-pruned.
22. >30-day human foundational decision survives.
23. decision rationale is removed/truncated before foundational core text.
24. active-file reason verbosity is reduced before protected authority.
25. blocker/next-step verbosity can be reduced under later pressure.
26. old non-foundational decisions are removed incrementally, newest/recently-used surviving first.
27. current ephemeral task/files may be discarded before trusted human authority.
28. two identical inputs produce byte-identical fit results.

### C. Typed irreducible failure + transactions — cases 29–40

29. protected human foundational minimum >8KB -> `foundational-state-exceeds-budget`.
30. required protected marker causes otherwise-fitting protected state to overflow -> `required-state-exceeds-budget`.
31. budget failure returns no over-cap memory object.
32. `mutateMemory` budget rejection writes nothing.
33. budget rejection does not increment revision.
34. local/global authoritative source selection is unchanged after rejection.
35. `commitMemoryExact` still independently rejects an oversized direct write.
36. a successful `mutateMemory` commit returns the actual fitted memory.
37. HEADER generation consumes actual committed fitted memory.
38. lock timeout remains lock-timeout, not budget-rejected.
39. unreadable authoritative STATE remains unavailable, not budget-rejected.
40. true I/O failure remains commit-failed, not budget-rejected.

### D. Field bounds and current-v3 compatibility — cases 41–52

41. new heuristic current task obeys creation bound.
42. new active-file path/reason obey creation bounds.
43. new heuristic decision topic/text/rationale obey creation bounds.
44. blockers and next steps obey creation count/string bounds.
45. current PR-7 v3 fixture loads unchanged under new persistence ceilings.
46. current-v3 oversized non-authoritative array is repaired deterministically before final validation.
47. migration repair never invents provenance/evidence.
48. human-reviewed foundational topic/decision is not silently truncated to automatic creation limits.
49. malformed current-format data beyond the broad persistence ceiling still fails closed.
50. LLM decisions-only schema remains 256/500/500 and 1–3 evidence refs.
51. storage field bounds do not widen PR-6 LLM mutation authority.
52. repeated load of the same repaired v3 bytes returns deterministic semantic state.

### E. Mutation-path pressure semantics — cases 53–64

53. heuristic commit under pressure either fits or returns public `write-failed`.
54. final LLM commit protects the new processed-source key.
55. final LLM budget rejection writes neither accepted facts nor completion marker.
56. rejected source remains retryable and is not a false cache-hit.
57. pending audit guard is protected before model prompting.
58. audit-guard budget rejection prevents the model request.
59. terminal audit metadata may be dropped under pressure without changing semantic success.
60. model-health metadata may be dropped under pressure without changing semantic success.
61. `recall_promote` protects its target decision/effect.
62. review-request budget rejection reports write failure and leaves STATE unchanged.
63. human promotion overflow leaves the prior unreviewed authority intact.
64. human supersession overflow leaves the prior authority/candidate state intact.

### F. Automatic durable injection — cases 65–76

65. missing-memory sentinel <=4,096 bytes.
66. unavailable-memory sentinel <=4,096 bytes.
67. smallest valid durable block contains intact opening/closing delimiters.
68. every ordinary durable block is <=4,096 UTF-8 bytes.
69. multibyte CJK/emoji fixture is budgeted by bytes, not characters.
70. block size includes `DATA ` prefixes/newlines/delimiters.
71. current task outranks lower-priority observed files.
72. blockers outrank lower-priority old decisions.
73. immediate next steps outrank lower-priority old decisions.
74. human foundational decisions outrank non-foundational decisions.
75. recently recalled decisions outrank older unreferenced decisions.
76. when one priority candidate does not fit, lower-priority candidates are not opportunistically inserted after it.

### G. Injection safety + retention independence — cases 77–79

77. hostile Markdown/XML/instruction-like durable values remain sanitized DATA under the 4KB algorithm.
78. `[llm:eN]` reports actual evidence count (1..3), not render ordinal.
79. a durable decision omitted by the automatic budget remains retrievable by pull recall and STATE is not mutated by rendering.

### H. Full regression/release gate — case 80

80. exact final implementation SHA passes the full repository release chain and the Oracle handoff records precise pass/skip counts without calling skipped tests passed.

---

## 16. Required commands on final implementation head

At minimum:

```bash
npm test
npx tsc --noEmit
npm run verify:host-contract
npm run build
npm run verify-cli-bundle
npm run smoke:cli
bash -n install.sh
bash -n bin/tokenmaxxer
git diff --check
```

Also run focused suites for storage budget, schema/migration, writer/transaction, CLI/recall, and compaction durable rendering.

CI must be green on the exact final implementation tree (a docs-only handoff child is acceptable only if production/test tree equality is demonstrated explicitly, as in prior CRIP reviews).

---

## 17. Repository audit before Oracle handoff

Search for and resolve/justify all of these:

```text
pruneOld(
pruneOldForCommit(
MEMORY_MAX_BYTES
memorySizeBytes(
Buffer.byteLength(
buildDurableBlock(
current_task: z.string()
path: z.string()
reason: z.string()
topic: z.string()
decision: z.string()
rationale: z.string()
blockers: z.array(z.string())
next_steps: z.array(z.string())
status === "commit-failed"
```

Audit questions:

1. Can any production mutation bypass central budget fitting?
2. Can a successful fit become oversized after revision increment?
3. Can pruning remove the current operation's required proof while returning success?
4. Can foundational human authority be silently deleted or text-truncated?
5. Can automatic durable injection exceed 4,096 bytes through multibyte content or framing overhead?
6. Can a high-priority omitted item be followed by lower-priority injected content?
7. Can automatic rendering mutate STATE or durable recency?
8. Can any budget diagnostic persist/log unbounded semantic content?

Record findings in `oracle-investigation.md`; do not issue an Oracle verdict.

---

## 18. Oracle attack surface

The independent Oracle should specifically attempt:

- exact-boundary 8,192 / 8,193 byte states;
- revision digit growth after callback;
- 31+ day human foundational authority under extreme disposable pressure;
- multiple human foundational rows whose irreducible representation exceeds the cap;
- final LLM source marker + near-cap foundational state;
- audit guard + near-cap protected state;
- `recall_promote` whose target would otherwise be the next pruned decision;
- human promotion where `human_review` pushes the state over cap;
- current-v3 PR-7 files with long but previously valid semantic strings;
- 4KB durable blocks containing emoji/CJK/combining sequences;
- hostile stored delimiters/headings near the byte boundary;
- one large high-priority candidate followed by many tiny low-priority candidates;
- many retained foundationals where only a subset can be automatically injected;
- concurrent near-cap mutations in two processes;
- read-only worktree/global fallback under budget pressure;
- any remaining production `pruneOld()` caller that can return an over-cap `MemoryFile` as if pruning succeeded.

---

## 19. Explicit scope boundaries

PR 8 does **not**:

- add persistent per-project compaction diagnostics — PR 9;
- replace the process-global compaction timestamp — PR 9;
- redesign file activity labels — PR 9;
- change decision authority/human trust — PR 3;
- widen the LLM durable mutation boundary — PR 6;
- change source-version identity or public idle outcome taxonomy — PR 5;
- alter augment-vs-replace compaction semantics or repeated-summary anchoring — PR 7;
- change release artifact strategy or dependency audit policy — PR 10;
- raise the 8KB STATE cap as a substitute for correct pruning.

---

## 20. Definition of done

PR 8 is complete only when:

1. every automatic durable mutation is fitted centrally against the real next committed revision;
2. every successful fit is schema-valid and <=8,192 UTF-8 bytes;
3. irreducible protected overflow is typed, no-write, and no-revision;
4. protected human authority and operation-required proof are never silently discarded;
5. old current-v3 state remains compatibly readable under the new field-bound policy;
6. automatic durable context is always <=4,096 UTF-8 bytes including framing;
7. injection priority is deterministic and semantically ordered;
8. omitted automatic context remains durably recallable;
9. PR 1–7 regression boundaries remain green;
10. Luna publishes `docs/CRIP/PR-8/oracle-investigation.md` and stops for independent Oracle review.
