# tokenmaxxer — Independent Codebase Assessment & Implementation Plan

> **Revised:** 2026-08-09
> **Repository:** `thehun927/TokenMaxxer`
> **Reviewed branch:** `main`
> **Source baseline:** current `main` after the first assessment revision
> **Prior assessment baseline:** `9c618f36db458537984140c0989d74d5d850bcd4`
> **Prior assessment revision:** `dc08bf0101016cca4a5b8077f81bc41e5c8a7102`
> **Verified pre-review CI baseline:** 202/202 tests across 21 files passed; `npx tsc --noEmit` passed; build, bundle verification, and installer syntax checks passed.
>
> This document combines validation of the original agentic assessment with a separate, independent source review. The independent pass did not assume the earlier finding list was complete. It traced storage, queueing, decision merge semantics, promotion, pruning, LLM evidence/caching, host compatibility, diagnostics, tests, installer behavior, and low-level filesystem primitives.

---

## Executive summary

The codebase has a strong safety-oriented architecture for an early release: heuristic-first persistence, structured LLM output, provenance, atomic rename, bounded memory size, corruption backup, explicit recall tools, and a substantial test suite are all good design choices.

The independent review nevertheless found several **core memory-integrity problems that are more important than many of the original assessment findings**.

### Highest-priority findings

1. **I1 — cross-process read/modify/write races can silently lose durable memory.** The project queue is explicitly process-local. Atomic rename prevents malformed files, not lost updates when two OpenCode processes use the same project.
2. **C1/I8 — the storage abstraction does not correctly distinguish local/global state or “missing” from “unreadable.”** A global fallback write is not read today; a stale local file can outrank newer global data under a naive fix; and a read error is currently treated like no memory.
3. **I2 — the decision merge algorithm can leave two conflicting decisions simultaneously valid.** An agreeing LLM corroboration creates a duplicate valid decision; a later supersession may invalidate only the duplicate and leave the old heuristic decision valid.
4. **I3/I4 — `recall_promote` can promote a stale invalid decision and can label a model-triggered action as `human-reviewed` without explicit human confirmation.** This undermines the provenance trust model.
5. **I5 — “foundational / never forgotten” decisions can be silently deleted by normal pruning.** Age pruning and last-resort decision caps do not prioritize foundational state.
6. **I6 — evidence enforcement covers LLM decisions, but not every durable LLM fact.** Active files, blockers, next steps, and some current-task updates can be durably accepted without fact-specific evidence while still receiving corroborated-looking provenance.
7. **I7 — the LLM cache key can self-invalidates after a successful write.** The canonical input includes durable state that the same source session mutates, so a later identical idle event can miss the prior cache and prompt again.
8. **G3/N1 — the OpenCode host boundary is inconsistent.** `head_files` expects `context.client` even though current custom `ToolContext` does not provide it; the peer range also claims support for versions older than the code's own minimum host assumptions.
9. **C2 — idle outcomes can report failure as `heuristic-only`.** The broad catch makes observability materially less trustworthy.
10. **G4/I12 — both injection budgeting and storage pruning need stronger contracts.** The compaction block has no explicit total output budget, and `pruneOld()` can return a value that is still over the hard 8 KB write limit.

### Severity/status matrix

| Code | Status | Severity | Summary |
|---|---|---:|---|
| **I1** | **NEW — independently confirmed** | **Critical** | Process-local queue cannot prevent cross-process lost updates to STATE.json. |
| **C1** | Confirmed, design expanded | **Critical / High** | Global fallback writes are not read; local/global freshness requires a real resolver. |
| **I8** | **NEW — independently confirmed** | **High** | `safeRead()` maps every read error to `null`, so unreadable state is treated as absent. |
| **I2** | **NEW — independently confirmed** | **High** | Decision merge can retain stale and replacement decisions as simultaneously valid. |
| **I3** | **NEW — independently confirmed** | **High** | `recall_promote` selects by topic without filtering validity and may promote a stale decision. |
| **I4** | **NEW — independently confirmed** | **High** | A model-callable promotion tool directly writes `human-reviewed` provenance without human confirmation. |
| **I5** | **NEW — independently confirmed** | **High** | Foundational decisions are deleted by 30-day/10/5 decision pruning under pressure. |
| **I6** | **NEW — independently confirmed** | **High** | LLM evidence validation is decision-specific; other durable LLM facts are not equivalently corroborated. |
| **I7** | **NEW — independently confirmed** | **High** | Cache identity includes mutable same-source durable state and can miss on sequential duplicate idle events. |
| **G3** | Confirmed — original remediation rejected | **High** | `ToolContext.client` does not exist; close over plugin client instead of bypassing host file semantics. |
| **N1** | Confirmed/expanded | **High** | Peer range starts at 1.0.0 while code assumes newer ToolContext/host contracts; health gate can fail open when health is absent. |
| **G5** | Confirmed — original remediation rejected | **High** | Any recall marks all valid decisions recent; use structured tool input/query semantics. |
| **C2** | Confirmed — severity adjusted | **High** | Pre-persistence failures can be mislabeled `heuristic-only`. |
| **G4** | Confirmed/reframed | **High** | Durable compaction block lacks its own hard output budget. |
| **I9** | **NEW** | **Medium** | Non-git memory can be stored in the right directory but record `project_path: "/"`. |
| **I10** | **NEW** | **Medium** | Successful global fallback can be followed by local HEADER write failure that aborts later idle work. |
| **I11** | **NEW** | **Medium** | `atomicWrite()` temp names use only PID; same-process writes to one artifact can collide. |
| **I12** | **NEW** | **Medium** | `pruneOld()` may return an over-budget state that `writeMemory()` must reject. |
| **I13** | **NEW** | **Medium** | Installer fetches mutable `main` artifacts independently without a release pin or integrity manifest. |
| **G6** | Confirmed — impact overstated originally | **Medium** | Audit/health write failures are swallowed as best-effort diagnostics. |
| **G7** | Confirmed — severity adjusted | **Medium** | Read/search/shell references are mislabeled as editing activity. |
| **G8** | Confirmed — remediation corrected again | **Medium** | Last compaction is process-global; local-only `last_compaction.log` is insufficient for read-only projects. |
| **N2** | Confirmed, coupled to C1 | **Medium** | Status reconstructs local STATE path and can report the wrong path/size. |
| **N3** | Confirmed | **Medium** | Tool mocks can invent host fields and hide runtime contract bugs. |
| **N4** | Confirmed | **Medium** | Committed/published `dist/` parity is not enforced after build. |
| **N5** | Triage item | **Medium** | Dependency audit findings need package/exploitability analysis, not blind force upgrades. |
| **H1** | Confirmed | **Low** | Nullable compaction setter mismatch; disappears when G8 removes module-global state. |
| CI missing | **FALSE / STALE** | — | `.github/workflows/ci.yml` exists and passes. |

---

# 1. Architecture assessment

TokenMaxxer has two principal layers:

- **Compaction layer:** renders durable state and substitutes/augments OpenCode's compaction prompt.
- **Memory layer:** extracts session facts at `session.idle`, writes per-project durable memory, optionally corroborates via an LLM, and exposes explicit recall/status tools.

The code is sensibly decomposed into `memory/`, `compaction/`, `tools/`, and small utility modules. The important weakness is that several modules individually implement only part of a larger invariant:

```text
storage location       -> store.ts
process queue          -> lock.ts
atomic replacement     -> util/fs.ts
memory semantics       -> writer.ts
promotion semantics    -> tools/recall.ts
injection semantics    -> compaction/durable.ts
host compatibility     -> tools + llm-adapter.ts
```

Each piece looks reasonable in isolation, but correctness failures appear at their boundaries. The most important examples are:

- atomic writes without cross-process transaction isolation;
- global fallback writes without global fallback reads;
- human-reviewed provenance without a human-confirmation boundary;
- foundational injection semantics without foundational retention semantics;
- evidence-backed decisions without evidence-backed non-decision LLM facts;
- cache identity derived partly from state that the cache-producing transaction itself mutates.

## What should be preserved

- Heuristic persistence before optional LLM work.
- Structured-result-only LLM acceptance.
- One bounded retry for LLM extraction.
- Evidence references/digests rather than persisted source excerpts.
- Atomic replacement rather than direct overwrite.
- Corrupt-file backup.
- Hard 8 KB write rejection as a final guard.
- Per-project in-process serialization as a useful first layer.
- Retained audit sessions and durable audit IDs.
- Model health/cooldown behavior as optional metadata rather than a prerequisite for heuristic memory.
- Explicit pull-based memory tools.
- CI with tests, typecheck, build, bundle, and installer syntax checks.

Two files remain too large for comfortable reasoning:

| File | Approx. size | Recommendation |
|---|---:|---|
| `src/memory/writer.ts` | ~1,600 LoC | Refactor after transaction/merge invariants are fixed. |
| `src/memory/extract-llm.ts` | ~1,100 LoC | Split after evidence/cache contracts stabilize. |

Do not start with those refactors. The current behavior needs tests around its invariants first.

---

# 2. Independent critical findings

## 2.1 I1 — cross-process lost updates are possible

**Severity: Critical**  
**Files:** `src/memory/lock.ts`, `src/memory/store.ts`, `src/memory/writer.ts`, `src/tools/recall.ts`

`lock.ts` explicitly says its serialization is **process-local**:

```ts
const queues = new Map<string, ProjectQueueState>()
```

This protects two idle jobs inside one OpenCode process, but not two OpenCode processes using the same project.

`STATE.json` writes are atomic replacements, but atomic replacement only guarantees that readers do not observe a half-written JSON file. It does **not** make this transaction atomic:

```text
read current state
merge session A
write full replacement state
```

### Lost-update sequence

```text
STATE = X

Process A reads X
Process B reads X

A merges session A -> XA
B merges session B -> XB

A atomically writes XA
B atomically writes XB

Final STATE = XB
Session A's update is silently lost.
```

The mtime cache does not solve this. It can tell the next read that the file changed, but both processes have already made decisions from stale snapshots.

This also affects read/modify/write tools such as `recall_promote`.

### Why this is Critical

Durable cross-session memory is the product's core purpose. Silent loss of a valid committed update is therefore a core correctness failure, even though the JSON file remains syntactically valid.

The repository already contains explicit multi-instance cache invalidation logic, so multiple processes/instances are not an unreasonable edge case.

### Recommended design

Add a **cross-process project transaction lock** for read/modify/write operations.

The lock location should not depend on the worktree being writable. A safe place is the same project-hashed user-level storage namespace used for fallback memory.

Do not hold a filesystem lock across a two-minute LLM request. Use short durable transactions:

```text
A. acquire project lock
   read newest state
   merge/write heuristic state
   release lock

B. perform LLM request outside lock

C. acquire project lock
   re-read newest state
   merge LLM/cache/audit/health outcome
   write
   release lock
```

`recall_promote` and any other state mutation must use the same transaction primitive.

Implementation options include a well-maintained lockfile primitive or atomic lock-directory creation with owner/timestamp/stale-lock recovery. Avoid a naive “create a file and hope” lock without crash recovery.

### Required tests

Use child processes, not two promises in one Vitest process:

1. Two processes update different source sessions concurrently; both facts survive.
2. One process promotes while another idle writer commits; both changes survive.
3. A process dies while holding a lock; stale recovery works without deleting a live lock.
4. Different projects do not block one another.
5. Global-fallback projects use the same transaction key as local storage.

The existing same-process queue tests are useful but do not prove this invariant.

---

## 2.2 C1 + I8 — storage needs a real state-location and read-error model

**Severity: Critical / High**  
**Files:** `src/memory/store.ts`, `src/util/fs.ts`, `src/tools/status.ts`

### C1: successful global writes are not readable today

`writeMemory()` tries:

1. `<project>/.opencode/memory/STATE.json`
2. user-level global fallback if local write fails

`readMemory()` only reads the first path.

A successful fallback write therefore does not satisfy the durable-read contract.

### A simple “global only when local missing” fix is still wrong

Suppose:

```text
local STATE T1 exists
project becomes read-only
global STATE T2 is successfully written
T2 > T1
```

Both files now exist. If local always wins, the reader permanently returns stale T1.

The store needs a candidate resolver that can compare both locations and choose the current state.

### I8: “unreadable” is currently indistinguishable from “missing”

`safeRead()` does this:

```ts
try {
  return await readFile(path, "utf-8")
} catch {
  return null
}
```

`readMemory()` interprets `null` as “there is no memory.”

That means `EACCES`, `EIO`, transient filesystem errors, and `ENOENT` all become the same state.

Potential failure:

```text
STATE exists but is temporarily unreadable
readMemory() -> null
idle writer creates emptyMemory(...)
writer later obtains write access
new full-state replacement overwrites the old STATE
```

The null cache can also remain valid if permissions are repaired without changing the file's mtime.

### Recommended storage API

Use typed filesystem results:

```ts
type FileReadResult =
  | { kind: "ok"; content: string; mtime: number }
  | { kind: "missing" }
  | { kind: "error"; code?: string }
```

Only `ENOENT` should mean missing.

A storage read error should produce “memory unavailable” and must **not authorize initialization from empty state**.

Then resolve both local/global candidates:

```ts
type MemoryCandidate = {
  kind: "project" | "global"
  path: string
  status: "present" | "missing" | "error"
  mtime?: number
}
```

Suggested policy:

1. Explicitly inspect both candidates.
2. If one valid present candidate exists, use it unless the other candidate has an unresolved error that makes freshness unknowable and policy requires fail-closed behavior.
3. If both valid candidates exist, choose newer mtime; deterministic local tie-break.
4. Never cache permission/I/O failure as “no memory.”
5. Keep selected source/path/size metadata with the read result.

Longer term, a monotonic `revision` inside memory is stronger than mtime ordering and would also help cross-process compare-and-swap logic.

### N2: status must consume the resolved source

`tokenmaxxer_status` currently reconstructs the local path independently and reads it again for byte size. That can display the right logical memory with the wrong file path/size after C1 is fixed.

Expose one rich store read result and make diagnostics use it.

### Required tests

- local only
- global only
- local newer
- global newer
- equal timestamps
- local unreadable + global valid
- local unreadable + no global: fail closed, do not initialize empty
- permission restored without mtime change
- selected source changes after cache fill
- status path/size match selected source
- global write -> subsequent read round trip

---

## 2.3 I2 — decision merge can violate the “one current decision per topic” invariant

**Severity: High**  
**File:** `src/memory/writer.ts`

The decision merge builds this map:

```ts
const existingTopicMap = new Map<string, number>()
for (let i = 0; i < existingDecisions.length; i++) {
  existingTopicMap.set(normalizedFact(existingDecisions[i].topic), i)
}
```

Only one index survives for each topic: the **last** matching decision.

The LLM corroboration path can intentionally keep the original heuristic decision valid while appending another valid, equivalent LLM decision.

That creates the following sequence:

```text
1. Heuristic:
   database = Postgres        H1 valid

2. LLM agrees:
   database = Postgres        H1 valid
   database = Postgres        L1 valid

3. Later heuristic changes decision:
   database = MySQL
```

On step 3, the topic map points at L1. L1 is invalidated and the MySQL decision is appended, but H1 can remain valid.

Result:

```text
Postgres H1   valid   <-- stale
Postgres L1   invalid
MySQL H2      valid   <-- current
```

Recall and compaction can now see two conflicting “valid” decisions for the same exact normalized topic.

### Recommended invariant

Make this explicit and testable:

> For a canonical normalized topic, at most one authoritative decision may have `still_valid=true`.

Corroboration should not need a second authoritative decision row.

Preferred design:

- preserve the existing authoritative decision ID;
- attach corroboration/audit provenance to it or a separate observation history;
- on actual supersession, invalidate **all** prior valid rows for that normalized topic before making the replacement authoritative.

If preserving multiple historical observations is valuable, separate “observation/audit record” from “current decision authority.” Do not overload `still_valid` for both.

### Required tests

1. Heuristic X + agreeing LLM -> one valid authoritative decision.
2. Heuristic X + agreeing LLM + later heuristic Y -> only Y valid.
3. Preexisting duplicate-valid rows are normalized deterministically on next merge/migration.
4. Human foundational status is not lost during corroboration.
5. Recall with an exact topic does not return contradictory simultaneously-valid rows.

---

## 2.4 I3 — `recall_promote` can promote the wrong historical decision

**Severity: High**  
**File:** `src/tools/recall.ts`

Promotion currently selects:

```ts
const d = mem.decisions.find(
  (d) => d.topic.toLowerCase() === args.topic.toLowerCase(),
)
```

It does not require `still_valid`.

Because historical superseded decisions are intentionally retained, the first matching topic can be an old invalid decision.

The tool then sets that stale row `foundational=true` and reports success. The durable block later filters invalid decisions, so the user/model can be told a decision was promoted even though it will not be automatically retained in compaction context.

### Recommended fix

Promotion should use a stable decision identifier, not topic text.

Preferred tool contract:

```text
recall_decision -> exposes decision ID with each result
recall_promote({ decision_id })
```

At minimum, a topic-based compatibility path must:

- filter `still_valid=true`;
- reject ambiguity if multiple valid rows exist;
- select the newest canonical row only when unambiguous.

Fix I2 before relying on topic uniqueness.

### Required tests

- invalid old + valid new same topic -> valid new is selected
- multiple valid same topic -> promotion refuses ambiguity
- invalid ID -> no write
- promoted ID is the ID shown by recall

---

## 2.5 I4 — `human-reviewed` provenance is currently model-forgeable

**Severity: High**  
**Files:** `src/tools/recall.ts`, `docs/reliability-plan.md`

`recall_promote` is a normal model-callable custom tool. Calling it directly performs:

```ts
d.foundational = true
d.provenance = {
  ...,
  extractor: "human",
  confidence: "human-reviewed",
}
```

There is no explicit human-confirmation step in that function.

This conflicts with the reliability plan, which states that promotion is a human review path requiring explicit confirmation.

A model choosing to call a tool is **not evidence that a human reviewed the fact**.

### Why this matters

The provenance layer is one of the strongest parts of TokenMaxxer. `confidence: "human-reviewed"` should be the strongest trust label. If a model can mint that label autonomously, every downstream distinction between heuristic, LLM-corroborated, and human-reviewed becomes weaker.

### Recommended design

A model-callable action may **request** promotion but should not itself assert human review.

Possible design:

```text
model tool call -> foundational_requested = true
explicit user confirmation -> foundational = true + human-reviewed provenance
```

Current OpenCode custom `ToolContext` includes an `ask` capability in the current host bridge, so a host-mediated confirmation path may be possible. Verify the exact supported permission/question semantics for the pinned minimum host before coupling the design to it.

Upstream references:

- `https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/registry.ts`
- `https://github.com/anomalyco/opencode/issues/10477`

If an in-tool confirmation cannot reliably distinguish explicit user approval, use a separate human-only CLI/config/manual editing workflow instead.

### Required tests

- model invocation without affirmative confirmation cannot set `human-reviewed`
- rejection leaves the decision unchanged
- explicit confirmation records human provenance
- promotion request remains visible until resolved

---

## 2.6 I5 — foundational decisions are not actually “never forgotten”

**Severity: High**  
**Files:** `src/memory/writer.ts`, `src/compaction/durable.ts`, `README.md`

The tool description/README describes foundational decisions as architecture-level state that should not be forgotten and is always included in compaction.

`buildDurableBlock()` does prioritize all valid foundational decisions that still exist.

But `pruneOld()` can delete them:

1. all decisions older than 30 days are removed without checking `foundational`;
2. later only the 10 most recent decisions are retained;
3. last resort retains only the 5 most recent decisions;
4. none of those stages prefer human-reviewed foundational decisions.

A human can therefore explicitly promote a decision, then lose it simply because the state file is under pressure and the decision is old.

### Correct separation of budgets

There are two different policies:

- **retention:** what remains durable/recallable;
- **injection:** what is automatically placed into compaction context.

Do not solve compaction bloat by deleting durable foundational memory prematurely.

Recommended retention order under pressure:

1. disposable audit/cache/health metadata
2. invalid decisions
3. stale non-foundational active state
4. old non-foundational decisions
5. verbose rationale/reason text
6. non-foundational recent decisions beyond retention target
7. human-reviewed foundational decisions **last**

If foundational data itself can exceed the 8 KB file, define an explicit overflow/archive strategy or a documented final degradation policy. Silent age-based deletion is not consistent with “never forgotten.”

### Required tests

- 31-day foundational survives when non-foundational data can be pruned instead
- 10/5 last-resort stages retain foundational first
- human-reviewed foundational remains recallable after high-pressure prune
- compaction injection can remain bounded without deleting non-injected foundational records

---

## 2.7 I6 — LLM evidence enforcement is incomplete for durable non-decision facts

**Severity: High**  
**Files:** `src/memory/extract-schema.ts`, `src/memory/extract-llm.ts`, `src/memory/writer.ts`, `docs/reliability-plan.md`

The reliability plan says, in substance:

> add provenance on every accepted extracted fact; LLM facts require a source audit session and at least one evidence reference.

The current runtime contract enforces `evidence_refs` on **decisions**.

It does not require equivalent fact-specific evidence for:

- `current_task`
- `active_files`
- `blockers`
- `next_steps`

`corroborateLLMFacts()` iterates the decisions array. If there are no decisions, it returns the other structured facts without evidence corroboration.

### Provenance mismatch

`mergeMemory()` can assign an LLM current task or active file a provenance object based on a generic `firstCandidateEvidence(...)` fallback.

That candidate is not necessarily evidence for the fact being labeled.

Blockers and next steps are overwritten from `extracted.blockers` / `extracted.next_steps` and do not have field-level provenance at all.

Therefore an LLM can plausibly produce:

```text
active file that was never touched
blocker not stated in the session
next step not stated in the session
current task inferred incorrectly
```

and those values can become durable even though the project describes the LLM layer as evidence-backed.

### Recommended design

Choose one of two explicit contracts:

**Option A — evidence-backed every durable LLM fact**

- current task carries evidence refs
- each active file carries evidence refs and path must match a tool-derived file candidate
- each blocker carries evidence refs
- each next step carries evidence refs
- validate each fact against the exact referenced source candidate before merge
- persist provenance for every durable field

**Option B — only decisions may be LLM-durable**

- keep current task/files/blockers/next steps heuristic-authoritative
- ignore LLM updates for those fields
- use LLM solely to corroborate/augment decisions

Either is stronger than the current hybrid state.

Do not label a fact `llm-corroborated` using arbitrary first-candidate evidence.

### Required tests

- hallucinated active file not in source/tool candidates is rejected
- blocker unsupported by cited transcript is rejected
- next step unsupported by cited transcript is rejected
- current task unsupported by cited transcript is rejected
- every persisted `llm-corroborated` fact can identify the evidence actually used to validate that fact

---

## 2.8 I7 — cache identity can change because the same source session wrote memory

**Severity: High for opt-in LLM reliability**  
**Files:** `src/memory/writer.ts`, `src/memory/extract-prompt.ts`, `src/memory/extract-llm.ts`

The cache key is conceptually:

```text
source session ID
+ canonical input hash
+ provider/model
```

That is good in principle.

The problem is that the canonical input includes a capped prior STATE snapshot, and that prior state includes durable fields the same source-session transaction modifies:

- last_updated
- last_session_id
- recent_sessions
- current task
- decisions
- active files
- blockers
- next steps

The first successful processing of source session S therefore changes the input used to calculate S's next cache key.

### Sequence

```text
Run 1:
  prior state = X
  key = hash(S + X)
  heuristic/LLM writes X+S
  cache row stored under hash(S + X)

Run 2, same source transcript:
  prior state = X+S
  key = hash(S + X+S)
  prior cache row does not match
```

The process-local in-flight map handles simultaneous duplicate calls, but it does not prove sequential/reload idempotency.

The existing cache-hit test pre-seeds a cache against an unchanged prior snapshot; it does not execute a real successful idle transaction twice and prove the second run produces no prompt.

This conflicts with the reliability plan's intended repeated-source idempotency behavior.

### Recommended identity

Base source idempotency on **immutable source inputs**, not state mutated by processing that source.

One practical design:

```text
source_session_id
source_transcript/tool-input digest
provider/model
extractor contract/schema version
```

Persist a bounded `processed_sources`/extraction record mapping source ID + source digest + model to completion/cache identity.

If prior project context is required to improve extraction, it can remain prompt input without being part of the “has this exact source already been processed?” identity, or the pre-source revision can be recorded once and reused for duplicate events.

### Required test that is currently missing

1. Run `writeMemoryOnIdle` and reach `llm-success`.
2. Let it fully finish.
3. Run the same source session/transcript again.
4. Assert no second `session.create` and no second prompt.
5. Simulate process reload and repeat; still no prompt.
6. Append a new message to the source transcript; a new extraction is allowed.

---

# 3. Previously identified findings — validated and refined

## 3.1 C2 — idle outcomes are not stage-accurate

**Severity: High**

The outer `writeMemoryOnIdleSerialized()` catch returns `heuristic-only` regardless of whether heuristic persistence happened.

Recommended semantics:

```text
no transcript / missing message endpoint -> no-messages
heuristic write returned false           -> write-failed
unexpected pre-persist exception         -> error
LLM intentionally disabled/unavailable   -> heuristic-only
cache reused                              -> cache-hit
LLM success                              -> llm-success
LLM attempted and failed                 -> llm-failed
queue failure                            -> queue-failed
```

Track transaction stage explicitly. Do not map an actual LLM attempt failure to `heuristic-only` merely because heuristics survived.

This becomes especially important after I10, because derivative HEADER failure currently falls into the same catch and produces a misleading result.

---

## 3.2 G3 — `head_files` uses a client that ToolContext does not provide

**Severity: High**

The diagnosis remains correct.

Current OpenCode's plugin bridge constructs custom tool context with the runtime fields plus `ask`, `directory`, and `worktree`; it does not attach the initialization SDK client.

Upstream current source:

`https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/registry.ts`

Historical 1.0.x context gap:

`https://github.com/anomalyco/opencode/issues/10477`

### Correct fix

Capture the legitimate initialization `client`:

```ts
registerEfficiencyTools(client)
```

and close over it inside the registered tool.

Keep `head_files` on the host client file API rather than replacing it with unrestricted raw `fs.readFile`.

Current OpenCode built-in read handling includes project/external-directory and permission semantics. A TokenMaxxer raw-fs implementation would create another model-callable file access path with different policy.

Upstream read implementation:

`https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/read.ts`

---

## 3.3 G4 — compaction durable block needs its own explicit output budget

**Severity: High**

STATE.json is hard-limited to 8 KB, so the durable block is indirectly bounded by stored state. That is not the same as explicitly budgeting injected context.

Add a total rendered budget and render sections in priority order.

Recommended priority:

1. project/last update
2. current task
3. blockers
4. next steps
5. active files
6. foundational decisions
7. recently referenced decisions
8. older fallback decisions

Per-section caps are defense in depth; the final total budget is the contract.

Do not delete foundational storage just because only a subset can be injected. See I5.

---

## 3.4 G5 — recall usage over-marks all decisions

**Severity: High**

`markReferencedDecisions()` currently checks only whether any `recall_decision` tool part exists, then marks all valid decisions used in the session.

Do not parse human-readable tool output with a regex.

Transcript tool parts already preserve structured input. Re-run the canonical `queryDecisions(mem, query, limit)` against the appropriate pre-merge snapshot and mark the returned IDs.

After I2, decision authority should make this selection more deterministic.

---

## 3.5 G6 — audit/health persistence return values are ignored

**Severity: Medium**

`persistTerminal` and `onHealthOutcome` discard the boolean result of `writeMemory()`.

Log bounded warnings for false persistence, but keep these callbacks best-effort so metadata failures do not destroy heuristic fallback.

The original “every reload burns tokens forever” characterization was too strong; retained audit IDs and stale-pending handling reduce that risk.

---

## 3.6 G7 — active-file reason conflates operation categories

**Severity: Medium**

Read/edit/write/glob/grep/bash-derived paths all feed one counter; multiple references render as “edited N times.”

Track at least:

```ts
reads
edits
writes
searches
shellRefs
```

Do not assume `bash` means read. A shell command can read, modify, rename, delete, or simply mention a path.

---

## 3.7 G8 — last compaction state is process-global; local log alone is not a complete fix

**Severity: Medium**

The module-global `lastCompactionTimestamp` is wrong for multi-project processes and disappears on reload.

The previous revision recommended using the existing project-local `last_compaction.log` as the sole source. The independent pass found that recommendation is incomplete.

The exact projects that require global STATE fallback can also fail the local `last_compaction.log` write because `index.ts` writes it only under the project `.opencode/memory` directory and swallows failure.

### Revised fix

Remove module-global timestamp state and create a **per-project diagnostic artifact resolver** with the same local/global storage policy as the memory store.

For example:

```text
project .opencode/memory/last_compaction.log
or
~/.config/opencode/memory/<project-hash>/last_compaction.log
```

Read the current/newest candidate with the same location rules used by status.

This avoids an extra STATE.json write during compaction while still supporting read-only worktrees.

---

# 4. Additional independent medium findings

## 4.1 I9 — non-git projects record the wrong project identity

**Severity: Medium**

`resolveProjectPath("/", directory)` correctly returns `directory` for non-git sessions.

But the idle writer initializes absent state with:

```ts
emptyMemory(worktree)
```

and `mergeAsyncFacts` does the same.

When OpenCode reports `worktree: "/"`, the STATE file is stored under the correct session directory while the state records:

```json
"project_path": "/"
```

`mergeMemory()` preserves that project path, so status, recall, compaction context, and HEADER can continue identifying the project as `/`.

Fix by computing the resolved project once and consistently using it for empty-memory initialization and project identity.

Test at least two different non-git directories with `worktree="/"` to prove they retain distinct identities.

---

## 4.2 I10 — derivative HEADER write can turn successful fallback persistence into an apparent failure

**Severity: Medium**

After heuristic `writeMemory()` succeeds, the writer immediately calls:

```ts
await generateHeader(...)
```

`generateHeader()` writes only to the local project `.opencode/memory/HEADER.md` and does not catch its own filesystem failure.

In the read-only worktree case:

```text
local STATE write fails
global STATE write succeeds
generateHeader local write fails
outer writer catch fires
LLM flow is skipped / outcome becomes misleading
```

`mergeAsyncFacts` has the same derivative-header behavior after a successful memory write.

HEADER generation must be best-effort and must not change whether the primary memory transaction succeeded.

A broader artifact-storage policy can decide whether HEADER should have a global counterpart or remain local-only.

---

## 4.3 I11 — `atomicWrite` temp file names are not unique per invocation

**Severity: Medium**  
**File:** `src/util/fs.ts`

Current temp path:

```ts
const tmp = `${path}.tmp.${process.pid}`
```

Two same-process writes to the same path use the exact same temp filename.

The STATE queue prevents most same-process STATE races, but other artifacts and future callers do not universally share that queue. Overlapping writes can race on the shared temp and one rename can remove the file the other invocation expected.

Use a unique suffix per invocation, e.g. cryptographic random ID or a safely-created temporary file in the same directory:

```text
STATE.json.tmp.<pid>.<random>
```

Keep the temp on the same filesystem so rename remains atomic.

Also consider whether the project's use of “durable” requires file/directory `fsync`; rename atomicity and crash durability are not identical guarantees.

---

## 4.4 I12 — `pruneOld` does not guarantee a writable result

**Severity: Medium**

At the final pruning step, the function can log that the state is **still** above 8 KB and return it anyway.

`writeMemory()` then correctly rejects it.

That means the function named/used as the path to fit the storage budget does not actually guarantee its postcondition.

This is easier to trigger because decision topic/decision/rationale lengths and counts are not comprehensively bounded at every input boundary.

Recommended contract:

```ts
type PruneResult =
  | { ok: true; memory: MemoryFile }
  | { ok: false; reason: "unrepresentable" }
```

or make `pruneToBudget()` deterministically guarantee `memorySizeBytes(memory) <= MEMORY_MAX_BYTES`.

Add input bounds and final truncation rules that preserve I5's foundational priority.

The existing last-resort test checks decision count/error logging but should also assert final byte size and that `writeMemory()` can actually persist the result.

---

## 4.5 I13 — installer is mutable-main, multi-download, and unverified

**Severity: Medium release/supply-chain risk**  
**File:** `install.sh`

The one-line installer downloads these independently from `main`:

- launcher
- `dist/index.js`
- `dist/tui.js`

There is no immutable release/tag/commit pin and no integrity manifest/checksum validation.

Consequences:

- `main` can move between downloads, producing a mixed-revision installation;
- any compromise/mistake on `main` is immediately executable by new installers;
- users cannot easily prove which source revision produced installed artifacts.

Recommended release flow:

1. installer resolves one immutable version/tag/commit;
2. all artifacts come from that same release;
3. publish a checksum manifest and verify it before replacement;
4. perform config edits via temp + atomic rename and keep a backup;
5. print installed version/commit.

This is not evidence of an active compromise. It is a release-hardening issue.

---

# 5. Host compatibility and testing findings

## 5.1 N1 — peer range overstates compatibility and host gate can fail open

**Severity: High**

`package.json` declares:

```json
"@opencode-ai/plugin": ">=1.0.0 <2.0.0"
```

The code itself defines:

```ts
MINIMUM_HOST_CONTRACT = "1.18"
VERIFIED_HOST_CONTRACT_VERSION = "1.18.15"
```

Historical OpenCode 1.0.x custom ToolContext lacked `directory`/`worktree`, while TokenMaxxer tools rely on them.

Further, the structured-contract gate allows extraction when the host health surface is missing:

```text
source = pinned-compatibility
allowed = true
reason = health-surface-unavailable
```

That assumption is only safe if the runtime is independently known to be the pinned compatible contract. The broad peer range makes that inference unsafe.

### Recommended fix

- Set peer lower bound to the **oldest actually verified compatible release**.
- Test that version explicitly.
- If runtime version cannot be established, fail closed for optional LLM extraction unless the installed host/plugin contract is independently proven compatible.
- Heuristic memory can continue when the optional structured path is gated off.

CI should exercise at least:

```text
oldest supported 1.x
normal pinned/tested 1.x
```

Current upstream references:

- `https://github.com/anomalyco/opencode/issues/10477`
- `https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/registry.ts`

---

## 5.2 N3 — host mocks do not enforce the real ToolContext shape

**Severity: Medium**

G3 survived a large test suite because an inner-helper test supplied a `client` property the host context does not provide.

Add registered-tool boundary tests whose mock is type-checked as the installed `ToolContext`.

Policy:

> Do not add fields to host mocks that do not exist in the supported host type. Compatibility exceptions belong at explicit adapters/closures.

Add a real OpenCode release smoke test for all seven registered tools.

---

## 5.3 N4 — committed `dist/` parity is not enforced

**Severity: Medium**

CI builds and validates self-contained bundles, but if `dist/` is committed/published it should also prove committed output equals fresh build output:

```bash
npm run build
git diff --exit-code -- dist/
```

Alternative: stop committing `dist/` and produce it only in release/package jobs.

Pick one source-of-truth strategy.

---

## 5.4 N5 — dependency findings need explicit triage

**Severity: Medium triage item**

The previously inspected CI installation reported dependency audit findings, including high/critical labels. That console output alone is not enough to call TokenMaxxer exploitable.

Run and retain structured audit output, then determine:

- direct vs transitive
- runtime vs dev-only
- whether vulnerable code ships in `dist`
- whether the vulnerable path is reachable

Do not use `npm audit fix --force` blindly.

---

# 6. LLM and provenance design observations

The LLM subsystem is one of the better-designed parts of the project, but its trust vocabulary should be made stricter.

Recommended trust ladder:

```text
legacy
  < heuristic observation
  < LLM corroborated with fact-specific evidence
  < explicitly human reviewed
```

The following should become hard invariants:

1. `llm-corroborated` means the exact fact passed a deterministic evidence check.
2. `human-reviewed` means a human completed an affirmative confirmation action outside model control.
3. `foundational` implies explicitly human-promoted current authoritative decision.
4. no invalid decision may become foundational.
5. one normalized topic has at most one authoritative valid decision.
6. provenance should not be fabricated by using unrelated “first available” evidence.

These invariants are more valuable than adding more extraction heuristics.

---

# 7. Corrected implementation sequence

The independent findings change the recommended order substantially.

## PR 1 — storage read semantics and effective location

**Fix:** C1 + I8 + N2 + I9 + I10 + I11

Goals:

- typed missing/error filesystem reads
- local/global candidate resolver
- cache tracks enough state to notice either candidate changing
- selected path/source/size exposed to diagnostics
- non-git project identity uses resolved project
- HEADER generation cannot overturn primary persistence success
- unique atomic temp names

Do this before other memory behavior because every higher layer depends on trustworthy storage reads.

---

## PR 2 — cross-process transaction correctness

**Fix:** I1

Goals:

- one project transaction primitive across processes
- short lock windows around read/modify/write
- no lock held during LLM network/model request
- idle merge, audit metadata, model health, cache commit, and promotion all use the same transaction discipline
- child-process concurrency tests

This is the largest core durability fix.

---

## PR 3 — decision authority and promotion trust

**Fix:** I2 + I3 + I4 + I5

Goals:

- one authoritative valid decision per normalized topic
- corroboration does not create duplicate valid authority
- promotion targets decision ID
- invalid decisions cannot be promoted
- model calls can request but not mint `human-reviewed`
- explicit human confirmation required
- foundational decisions receive highest retention priority

This PR should define the decision-state machine in tests before changing implementation.

---

## PR 4 — OpenCode host contract

**Fix:** G3 + N1 + N3 + tool argument bounds

Goals:

- close over plugin client for efficiency tools
- remove `(context as any).client`
- keep host file API semantics
- tighten supported host range
- make health/version fallback policy consistent with supported range
- registered-tool tests use real ToolContext shape
- real host smoke test

---

## PR 5 — source idempotency and outcome semantics

**Fix:** I7 + C2 + G5

Goals:

- immutable source-processing identity
- sequential duplicate idle event is cache/no-op after success
- process reload does not cause repeat prompt for unchanged source
- append/change to source permits reprocessing
- stage-accurate idle outcomes
- recall marks exact returned decision IDs from structured input/query semantics

---

## PR 6 — complete LLM evidence boundary

**Fix:** I6 + existing extract-schema type mismatch

Choose and document either:

- evidence-backed every durable LLM fact, or
- LLM durability restricted to decisions.

Do not keep the present ambiguous hybrid.

If all facts are accepted:

- add fact-specific evidence refs
- add blocker/next-step provenance or structured fact objects
- validate active files against tool-derived candidates
- remove generic first-candidate corroboration

---

## PR 7 — compaction and storage budgets

**Fix:** G4 + I12

Goals:

- explicit total durable-block injection budget
- section priority under budget
- storage prune has a guaranteed representable result or typed failure
- foundational retention priority maintained
- bounds on decision fields and other large strings

---

## PR 8 — status and diagnostic artifacts

**Fix:** G8 + G6 + G7 + H1

Goals:

- remove process-global last compaction
- use local/global diagnostic artifact resolver
- surface best-effort metadata persistence failures
- accurate file activity categories
- H1 disappears with removal of setter

---

## PR 9 — release/build/dependency hygiene

**Fix:** N4 + N5 + I13 + stale documentation

Goals:

- enforce or eliminate committed-dist parity
- dependency vulnerability triage
- release-pinned installer + integrity manifest
- atomic config edits/backups
- update stale README claims such as `Bun.$` usage if implementation remains `child_process`

---

# 8. Verification plan

## 8.1 Existing checks

Every PR should keep:

```bash
npm ci
npm test
npx tsc --noEmit
npm run build
bash -n install.sh
```

If `dist/` remains tracked:

```bash
git diff --exit-code -- dist/
```

## 8.2 New invariant tests

### Storage

- unreadable existing STATE is never treated as empty
- local/global newest selection
- global fallback round trip
- status reports effective source
- non-git project identity
- HEADER failure cannot change memory write outcome
- same-process atomic writes use distinct temp files

### Concurrency

- two child processes preserve both updates
- idle + promotion child-process race preserves both
- stale lock recovery
- different projects remain independent

### Decisions

- one valid row per normalized topic
- equivalent LLM corroboration does not produce duplicate authority
- later supersession invalidates all prior authority
- promote by ID only
- invalid decision cannot promote
- human-review label requires affirmative confirmation
- foundational survives age/pressure pruning

### LLM

- exact source processed twice sequentially -> no second prompt
- same after simulated process reload
- changed source digest -> new extraction permitted
- every accepted corroborated fact has fact-specific evidence
- unsupported file/blocker/next-step/current-task claims rejected

### Budget

- `pruneOld`/replacement always fits 8 KB or returns explicit failure
- durable compaction block stays under declared injection budget
- retention and injection priority independently tested

### Host integration

Run a built release against the oldest supported OpenCode and normal pinned/tested version:

1. `tokenmaxxer_status`
2. `head_files`
3. `preview_compaction`
4. `get_project_state`
5. `recall_decision`
6. promotion request/confirmation path
7. idle heuristic write
8. LLM extraction when enabled
9. compaction
10. reload
11. non-git directory
12. read-only project/global fallback

---

# 9. Lower-priority maintainability items

These are still worth addressing after the correctness work:

| Item | Recommendation |
|---|---|
| Decision regex recreated per sentence | Hoist/clean up after behavioral tests. |
| `COMMON_WORDS` Set allocated per call | Hoist to module scope. |
| `stripCodeBlocks` misses indented code | Add fixtures before altering extraction. |
| Duplicated file normalization | Consolidate after G7/I6 define canonical semantics. |
| `evidence_refs` optional in TS but runtime-required | Remove type lie when I6 restructures schema. |
| Cache construction uses legacy facts type | Align construction/runtime types with I6. |
| Repeated `pruneOld` cloning | Optimize after transaction semantics are stable. |
| Dead `resolveProjectPath` compatibility guard | Remove. |
| `sessionId` fallback in recall context | Remove if supported host type confirms `sessionID`. |
| Unused `registerTools(_ctx)` | Remove or use explicit closure dependencies. |
| Provenance formatting duplicated | Centralize after provenance model stabilizes. |
| Hand-maintained JSON Schema + Zod | Consider generation or drift tests. |
| `TRANSCRIPT_WINDOW = 50` | Document as product tradeoff. |
| Tool bounds | Add max/min for recall limit, head lines, path count/string length. |
| Early HEADER placeholder | Reconsider after artifact storage policy. |
| Large writer/extract-llm modules | Split after correctness contracts land. |
| `verbatimModuleSyntax` | Optional TS hygiene, not reliability priority. |

---

# 10. Corrections to the original agentic assessment

## 10.1 CI exists

The original assessment said no CI workflow existed. That is false/stale.

`.github/workflows/ci.yml` currently runs:

```text
npm ci
npm test
npx tsc --noEmit
npm run build
self-contained bundle verification
bash -n install.sh
```

The previously reviewed assessment commit passed with 21 test files / 202 tests.

## 10.2 Finding counts were internally inconsistent

Do not preserve static “X critical / Y high / Z medium” prose unless generated from the actual final table.

## 10.3 Raw fs is not the preferred G3 fix

The original G3 remediation would create a new file-access boundary. Capture the legitimate plugin client instead.

## 10.4 G5 should not parse display output

Use structured tool input and the canonical decision query implementation.

## 10.5 G8 local log recommendation required correction

The first revised assessment suggested existing `last_compaction.log` as the durable source. The independent review found that local-only artifact fails in the same read-only case that motivates global STATE fallback. Use a local/global diagnostic artifact resolver instead.

## 10.6 Security scope should not say “no network surface”

TokenMaxxer is local-first, but optional extraction calls host model/session APIs and custom tools cross file/permission boundaries. Security review should include those boundaries and installer/dependency supply chain.

---

# 11. Assumptions and limits

This independent pass reviewed the current source and tests for the major runtime paths, including:

- `src/index.ts`
- `src/util/fs.ts`, `git.ts`, `log.ts`
- `src/memory/store.ts`
- `src/memory/lock.ts`
- `src/memory/schema.ts`
- `src/memory/migrate.ts`
- `src/memory/writer.ts`
- `src/memory/extract-schema.ts`
- `src/memory/extract-prompt.ts`
- `src/memory/extract-llm.ts`
- `src/memory/llm-adapter.ts`
- `src/memory/reader.ts`
- `src/memory/activity-state.ts`
- `src/compaction/durable.ts`
- `src/compaction/prompt.ts`
- `src/tools/recall.ts`
- `src/tools/status.ts`
- `src/tui.tsx`
- `install.sh`
- `bin/tokenmaxxer`
- `package.json`
- `.github/workflows/ci.yml`
- key merge/prune/writer/recall/reliability tests
- reliability and README contracts

It also checked current upstream OpenCode source relevant to custom ToolContext behavior.

It did **not** execute a live OpenCode session, induce real cross-process races, perform real permission-failure filesystem tests, invoke a real LLM during this review, or perform exploitability analysis of npm audit findings. Findings above marked confirmed are direct static/data-flow violations or invariant mismatches visible in the current source; the recommended regression tests are intended to convert them into executable proofs before implementation.

---

# 12. Final priority recommendation

If only a few changes can be made immediately, do these first:

```text
1. Make storage reads trustworthy: local/global resolution + typed read errors.
2. Add cross-process transaction isolation for every memory read/modify/write.
3. Repair decision authority: one valid decision per topic.
4. Make promotion target an exact valid decision and require real human confirmation.
5. Protect foundational decisions from ordinary pruning.
6. Make source-session idempotency survive completed writes and process reload.
7. Complete the evidence contract for every durable LLM-generated fact.
8. Fix the OpenCode client/context compatibility boundary and supported version range.
9. Add explicit compaction/prune budget postconditions.
10. Then address status, activity labels, build parity, dependencies, and release installer hardening.
```

The most important architectural theme is this:

> **TokenMaxxer already has good local safety mechanisms, but the next reliability step should turn implicit assumptions into global invariants: one current storage source, one serialized project transaction across processes, one authoritative decision per topic, one trustworthy meaning for each provenance label, and one stable identity for each processed source session.**

Those invariants will provide more reliability than adding further extraction features before the persistence model is hardened.
