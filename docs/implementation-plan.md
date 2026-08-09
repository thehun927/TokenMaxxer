# TokenMaxxer — Concrete Reliability Implementation Plan

> **Date:** 2026-08-09  
> **Repository:** `thehun927/TokenMaxxer`  
> **Target branch:** `main`  
> **Source assessment:** `docs/assessment.md`

This document translates the confirmed findings in `docs/assessment.md` into an implementation sequence with concrete APIs, file ownership, dependencies, regression tests, and release gates.

The work should be delivered as **nine small, reviewable pull requests**, not as one large rewrite. PRs 1–5 are release-blocking because they directly affect whether durable memory can be trusted. PRs 6–9 harden LLM semantics, storage/injection budgets, diagnostics, and distribution.

---

## Release gates

### Must fix before release

1. **PR 1 — Storage authority and read semantics**
2. **PR 2 — Cross-process transactions**
3. **PR 3 — Decision authority and promotion trust**
4. **PR 4 — OpenCode host contract**
5. **PR 5 — Source idempotency and truthful outcomes**

### Strongly recommended before wider rollout

6. **PR 6 — Complete LLM trust boundary**
7. **PR 7 — Guaranteed storage and injection budgets**
8. **PR 8 — Accurate diagnostics and artifact storage**
9. **PR 9 — Reproducible release and dependency hygiene**

---

# PR 1 — Make storage authoritative

**Resolves:** C1, I8, I9, I10, I11, N2  
**Primary files:**

- `src/util/fs.ts`
- `src/memory/store.ts`
- `src/memory/schema.ts`
- `src/memory/writer.ts`
- `src/tools/status.ts`
- new `src/memory/paths.ts`

## Goals

- Distinguish missing files from unreadable files.
- Read both project-local and global fallback STATE.
- Select one authoritative current state deterministically.
- Stop relying on mtime alone for logical freshness.
- Ensure non-git projects record the resolved project path rather than `/`.
- Ensure derivative HEADER failures cannot invalidate successful primary persistence.
- Make atomic temp names unique per invocation.
- Make status report the actual selected STATE source/path/size.

## 1. Add a monotonic memory revision

Add an additive field to the existing v3 schema:

```ts
revision: z.number().int().nonnegative().default(0)
```

Do not bump the schema version solely for this change.

Existing v3 files load as revision `0`. Old v1/v2 migrations continue to migrate into v3 and receive revision `0` unless explicitly provided.

Every successful logical STATE mutation increments revision by one.

The revision becomes the primary freshness signal between local/global candidates. Mtime remains a tie-breaker and useful cache invalidation signal.

## 2. Centralize project and storage paths

Create `src/memory/paths.ts` with the canonical path functions:

```ts
export function resolveProjectPath(worktree: string, directory: string): string
export function projectMemoryPath(project: string): string
export function globalProjectStorageDir(project: string): string
export function globalMemoryPath(project: string): string
export function projectStorageHash(project: string): string
```

All storage, status, compaction diagnostic artifacts, and later lock paths should use these functions.

Avoid recomputing the project hash or fallback location independently in other modules.

## 3. Replace authoritative `safeRead()` usage with typed reads

Add a typed read primitive in `src/util/fs.ts`:

```ts
type FileReadResult =
  | { kind: "ok"; content: string; mtime: number }
  | { kind: "missing" }
  | { kind: "error"; code?: string }
```

Rules:

- `ENOENT` -> `missing`
- all other read/stat failures -> `error`
- do not cache an error as missing
- do not authorize creation of empty memory from an unresolved read error

`safeRead()` may remain for non-authoritative, best-effort diagnostics if useful, but STATE reading must use the typed API.

## 4. Introduce a rich state read result

Add:

```ts
type MemoryReadResult = {
  memory: MemoryFile | null
  source: "project" | "global" | null
  path: string | null
  sizeBytes: number
  revision: number
}
```

Expose:

```ts
export async function readMemoryState(...): Promise<MemoryReadResult>
export async function readMemory(...): Promise<MemoryFile | null>
```

`readMemory()` remains a compatibility wrapper around `readMemoryState()`.

## 5. Resolve local/global candidates

For each read:

1. Inspect both local and global candidate files.
2. Parse/migrate any present candidate.
3. If neither exists, return no memory.
4. If exactly one valid candidate exists, use it.
5. If both valid candidates exist:
   - prefer higher `revision`;
   - if equal, prefer newer mtime;
   - if equal again, prefer project-local deterministically.
6. If a candidate exists but is unreadable, do not silently treat it as missing.
7. Corrupt candidates should continue to use the existing backup/quarantine behavior.

The cache should track enough state to detect changes to either candidate:

```ts
type MemoryCacheEntry = {
  result: MemoryReadResult
  projectMtime: number | null
  globalMtime: number | null
}
```

A cache hit is valid only when the observed candidate mtimes still match the cached pair.

## 6. Fix non-git identity

Compute once:

```ts
const project = resolveProjectPath(worktree, directory)
```

Use that resolved project for:

```ts
emptyMemory(project)
```

Do this everywhere, including async merge helpers.

Never initialize memory with `emptyMemory(worktree)` when OpenCode may report `worktree === "/"` for non-git directories.

## 7. Make HEADER best-effort

A successful STATE write must remain successful even if HEADER generation fails.

Change HEADER generation to return a best-effort result or catch internally:

```ts
const headerWritten = await generateHeader(...)
if (!headerWritten) {
  void log(client, "warn", "tokenmaxxer: HEADER generation failed", ...)
}
```

HEADER failure must not:

- roll back STATE success;
- abort optional LLM extraction;
- alter the primary idle outcome.

## 8. Make atomic temp files unique

Replace:

```ts
`${path}.tmp.${process.pid}`
```

with same-filesystem unique temp names, for example:

```ts
`${path}.tmp.${process.pid}.${randomUUID()}`
```

Ensure failed writes clean up temporary files when possible.

## 9. Make status consume storage metadata

`tokenmaxxer_status` must not reconstruct the local path and re-read it independently.

Instead consume `readMemoryState()` and report:

- effective source: project/global
- effective path
- effective byte size
- revision
- current memory values

## Required tests

Add real filesystem tests for:

1. local-only state
2. global-only state
3. local higher revision wins
4. global higher revision wins
5. equal revision + newer local mtime
6. equal revision + newer global mtime
7. exact tie -> local wins
8. local unreadable + no global -> memory unavailable; no empty initialization
9. local unreadable + valid global -> explicit tested policy
10. permissions restored without mtime change
11. global fallback write -> next read returns new state
12. selected source changes after cache fill
13. non-git `worktree="/"` records real directory
14. HEADER failure does not change successful STATE write outcome
15. status path/size/source match effective state
16. same-process atomic writes use different temp files

## Definition of done

A caller can trust that `readMemoryState()` returns the current durable state or explicitly reports that state cannot be safely determined. No read error is silently converted into permission to start from empty memory.

---

# PR 2 — Add cross-process project transactions

**Resolves:** I1  
**Primary files:**

- new `src/memory/project-lock.ts`
- `src/memory/store.ts`
- `src/memory/writer.ts`
- `src/tools/recall.ts`
- `src/memory/lock.ts`

## Goal

Prevent silent lost updates when multiple OpenCode processes mutate the same project memory concurrently.

The existing `src/memory/lock.ts` process-local queue remains useful for coalescing and ordering work in one process, but it is not the durability boundary.

## 1. Create a cross-process lock

Use a project-scoped lock located in the global hashed storage namespace so lock acquisition does not depend on the worktree being writable:

```text
~/.config/opencode/memory/<project-hash>/.state-lock/
```

Recommended primitive: atomic directory creation (`mkdir`).

Inside the lock directory write bounded ownership metadata:

```json
{
  "pid": 12345,
  "hostname": "host",
  "started_at": "2026-08-09T...",
  "nonce": "..."
}
```

## 2. Stale-lock behavior

On lock collision:

- same host + live PID -> backoff/retry
- same host + dead PID -> stale candidate; quarantine/remove safely and retry
- unknown/other host -> fail conservatively after bounded timeout rather than stealing a potentially live lock

Use randomized/jittered backoff.

Do not create an unbounded wait.

## 3. Introduce one mutation primitive

Create a canonical API such as:

```ts
export async function mutateMemory<T>(
  context: MemoryContext,
  mutate: (memory: MemoryFile, state: MemoryReadResult) => Promise<MutationResult<T>> | MutationResult<T>,
): Promise<T>
```

Conceptually:

```ts
withProjectLock(project, async () => {
  const latest = await readMemoryState({ bypassCache: true })
  const base = latest.memory ?? emptyMemory(project)
  const mutation = await mutate(base, latest)
  const next = {
    ...mutation.memory,
    revision: latest.revision + 1,
  }
  await commitMemory(next)
  return mutation.result
})
```

All runtime read/modify/write operations must use the same primitive.

## 4. Mutation sites that must move behind the transaction boundary

- heuristic idle merge
- audit metadata creation
- audit terminal state
- model health updates
- LLM cache commit
- recall usage metadata
- promotion request/confirmation
- future state-mutating tools

Keep raw `writeMemory()` internal enough that application code cannot accidentally bypass transaction semantics.

## 5. Never hold the lock during the LLM request

Correct lifecycle:

```text
fetch transcript / extract heuristics
        ↓
LOCK
read current memory
merge + persist heuristic result
UNLOCK
        ↓
model discovery / audit session creation as appropriate
        ↓
LOCK
persist audit guard
UNLOCK
        ↓
LLM prompt / retry
NO LOCK HELD
        ↓
LOCK
re-read newest state
merge LLM/cache/health outcome
persist
UNLOCK
```

The same principle applies to any long-running external operation.

## 6. Keep process-local queue

The current in-process queue can continue to:

- coalesce duplicate source idle events;
- avoid avoidable lock contention;
- expose queue diagnostics.

The filesystem lock becomes the correctness boundary across processes.

## Required tests

Use child processes, not two promises in a single Vitest process:

1. two child processes update different source sessions concurrently; both survive
2. one process promotes/requests promotion while another idle writer commits; both survive
3. child process dies while holding lock; stale recovery succeeds
4. a live lock is never stolen
5. different projects do not block one another
6. local/global fallback for same project resolves to the same transaction key
7. revision increments monotonically under concurrent writes

## Definition of done

No complete STATE replacement can be based on a stale read while another TokenMaxxer process is concurrently committing a mutation to the same project.

---

# PR 3 — Define decision authority and promotion trust

**Resolves:** I2, I3, I4, I5  
**Primary files:**

- `src/memory/writer.ts`
- `src/memory/schema.ts`
- `src/memory/reader.ts`
- `src/tools/recall.ts`
- `bin/tokenmaxxer`
- tests for merge/prune/recall

## Hard invariants

Encode these as tests before changing implementation:

```text
1 normalized topic -> at most 1 still_valid authoritative decision
invalid decision -> cannot be promoted
human-reviewed foundational -> cannot be silently superseded by automation
foundational -> preferentially retained under storage pressure
human-reviewed -> can only originate from an explicit human-controlled action
```

## 1. Extract decision authority logic

Move decision-specific logic out of the giant `mergeMemory()` loop into something like:

```ts
mergeDecisions(existing, incoming, meta)
```

The implementation should operate on all rows sharing the normalized topic, not a map that retains only one arbitrary/last index.

## 2. Heuristic merge rules

For a new heuristic decision on topic T:

- collect all currently valid decisions for T;
- if no human-reviewed foundational authority exists:
  - invalidate all prior valid authorities for T;
  - create one new authoritative decision;
- if a human-reviewed foundational authority exists:
  - if equivalent, keep the human authority;
  - if conflicting, do not silently invalidate it;
  - record/log the conflict for human review instead.

## 3. LLM corroboration rules

For an LLM decision:

- equivalent to current authoritative decision -> enrich/corroborate the existing authority; do not create a second valid authority
- conflicting with current heuristic/human authority -> do not automatically displace it
- new topic with accepted evidence -> may create a new authoritative decision

If historical LLM observations are useful, store them as non-authoritative audit/provenance information rather than a second `still_valid=true` row.

## 4. Promotion must target stable IDs

Change recall output to expose decision IDs:

```text
id=d-123 database: Use PostgreSQL ...
```

Change the model-callable promotion tool contract to:

```ts
recall_promote({ decision_id })
```

A topic-only compatibility path should be temporary and must reject ambiguity.

## 5. Model-callable promotion becomes a request only

A model tool call may set:

```ts
foundational_requested = true
```

It must not set:

```ts
foundational = true
confidence = "human-reviewed"
extractor = "human"
```

A model call is not proof of human review.

## 6. Add a human-controlled CLI confirmation path

Preferred trust boundary:

```bash
tokenmaxxer decisions
tokenmaxxer promote <decision-id>
```

The CLI:

1. resolves the current project;
2. reads the current valid decision by exact ID;
3. refuses invalid decisions;
4. performs the update through the same cross-process transaction primitive;
5. sets:

```ts
foundational = true
foundational_requested = false
provenance.extractor = "human"
provenance.confidence = "human-reviewed"
```

Optionally add explicit replacement support:

```bash
tokenmaxxer promote <new-id> --supersede <old-id>
```

This is preferable to trusting the model-callable custom tool to mint `human-reviewed` provenance.

## 7. Preserve foundational memory under pruning

Foundational human-reviewed decisions should be the final class eligible for loss under storage pressure.

Normal age-based and 10/5 decision pruning must never drop them merely because they are old.

A later PR will define the final byte-budget failure behavior if foundational data alone exceeds the entire state cap.

## Required tests

1. heuristic X + agreeing LLM -> exactly one valid authority
2. heuristic X + agreeing LLM + later heuristic Y -> only Y valid
3. duplicate valid legacy rows normalize deterministically
4. invalid decision cannot request or receive promotion
5. promotion uses exact ID shown by recall
6. ambiguous topic compatibility path refuses promotion
7. model-callable promotion cannot mint `human-reviewed`
8. CLI promotion creates human-reviewed provenance
9. rejected/aborted human promotion leaves state unchanged
10. 31-day foundational decision survives ordinary prune
11. 10/5 pressure stages retain foundational first
12. conflicting automation cannot silently supersede human-reviewed foundational authority

## Definition of done

`still_valid`, `foundational`, and provenance confidence each have one unambiguous meaning. One topic cannot expose contradictory simultaneously-valid authoritative decisions.

---

# PR 4 — Fix the OpenCode host boundary

**Resolves:** G3, N1, N3, tool argument bounds  
**Primary files:**

- `src/tools/efficiency.ts`
- `src/index.ts`
- `src/memory/llm-adapter.ts`
- `package.json`
- tool integration tests

## 1. Close over the legitimate plugin client

Change registration from:

```ts
registerEfficiencyTools()
```

to:

```ts
registerEfficiencyTools(client)
```

Then:

```ts
async execute(args, context) {
  return _headFiles(args, {
    worktree: context.worktree,
    directory: context.directory,
    client,
  })
}
```

Remove every `(context as any).client` pattern.

Keep `head_files` on the OpenCode host file API instead of creating a separate unrestricted `fs.readFile` path.

## 2. Tighten the supported host range

Current peer dependency claims support too broadly.

Until an older compatible host is explicitly tested, change:

```json
"@opencode-ai/plugin": ">=1.0.0 <2.0.0"
```

to:

```json
"@opencode-ai/plugin": ">=1.18.15 <2.0.0"
```

If CI later proves an earlier compatible version, lower the bound deliberately.

## 3. Make structured-host gating fail safely

The LLM path should not assume “health endpoint absent” proves compatibility unless the runtime contract is independently known compatible.

If runtime compatibility cannot be established:

- disable only optional LLM extraction;
- keep heuristic memory fully operational.

## 4. Add tool argument bounds

At schema boundaries, add explicit limits, for example:

```text
recall limit: 1–25
head_files paths: max 10
head_files lines: 1–500
path/query/topic strings: bounded
```

Choose exact bounds based on current UX/tests, but do not leave unbounded model-callable arrays or large integers.

## 5. Test registered wrappers, not only helpers

Host-boundary tests must instantiate the actual registered tool and a context type compatible with the installed `ToolContext`.

Mocks may not invent host fields.

## Required tests

1. `head_files` succeeds with no `context.client`
2. plugin initialization client is used by registered efficiency tool
3. `preview_compaction` receives legitimate client for logging
4. all registered tools run with real ToolContext shape
5. argument bounds reject oversized inputs
6. oldest supported host version passes compatibility smoke
7. unsupported host disables only optional structured extraction

## Definition of done

TokenMaxxer does not rely on undeclared host context fields, and the package support range matches what is actually tested.

---

# PR 5 — Make idle processing truly idempotent

**Resolves:** I7, C2, G5  
**Primary files:**

- `src/memory/extract-prompt.ts`
- `src/memory/extract-llm.ts`
- `src/memory/writer.ts`
- `src/memory/schema.ts`

## 1. Separate source identity from prompt context

Current cache identity includes prior STATE even though the same source transaction mutates that STATE.

Introduce an explicit extraction contract version:

```ts
export const EXTRACTION_CONTRACT_VERSION = 2
```

Build two different hashes:

```ts
sourceInputSha256 = sha256(
  compressedTranscript +
  fileCandidates +
  EXTRACTION_CONTRACT_VERSION
)

promptInputSha256 = sha256(
  priorState +
  compressedTranscript +
  fileCandidates
)
```

The immutable source hash controls idempotency.

The prior-state-aware hash may still describe the exact prompt payload for diagnostics/audit if useful.

## 2. New cache identity

Use:

```text
source_session_id
+ source_input_sha256
+ provider/model
+ extraction_contract_version
```

Add `contract_version` and `source_input_sha256` to cache metadata.

Existing cache entries without the new contract should simply not satisfy v2 cache identity and can age out/quarantine because cache data is disposable.

## 3. Sequential and reload-safe duplicate handling

Required behavior:

```text
writeMemoryOnIdle(S) -> llm-success
wait for completion
writeMemoryOnIdle(S) again with identical source transcript
=> cache-hit/no-op
=> no new audit session
=> no new prompt
```

Reset process-local maps to simulate reload and repeat. It must remain a hit/no-op.

Appending/changing source transcript content changes the immutable source digest and legitimately permits reprocessing.

## 4. Make idle outcomes stage-accurate

Add an explicit outcome:

```ts
| "error"
```

Contract:

```text
no transcript / missing endpoint      -> no-messages
heuristic write returned false        -> write-failed
unexpected pre-persist exception      -> error
LLM intentionally disabled/unavailable-> heuristic-only
accepted cache reused                 -> cache-hit
LLM completed successfully            -> llm-success
LLM was attempted and failed          -> llm-failed
queue/transaction failure             -> queue-failed
```

Track transaction stage rather than returning `heuristic-only` from one broad catch.

Log bounded error metadata without transcript/prompt content.

## 5. Mark only actually recalled decisions

For each completed `recall_decision` transcript tool part:

1. read structured `state.input.query` and `state.input.limit`;
2. run canonical `queryDecisions()` against the correct pre-merge memory snapshot;
3. collect returned IDs;
4. update `last_used_in_session` only for those IDs.

Do not parse human-readable tool output.

## Required tests

1. successful idle transaction executed twice sequentially -> no second prompt
2. same test after process-local reset/reload
3. appended source message -> new processing allowed
4. pre-persist exception -> `error`
5. write false -> `write-failed`
6. LLM disabled -> `heuristic-only`
7. LLM attempted and failed -> `llm-failed`
8. queue/status records exact final outcome
9. recall query marks only returned decision IDs
10. recall limit is respected when marking recency

## Definition of done

The exact same completed source session can be delivered repeatedly without causing duplicate model work or unstable cache keys, and outcome labels describe what actually happened.

---

# PR 6 — Simplify and complete the LLM trust boundary

**Resolves:** I6 and current extraction type/schema ambiguity  
**Primary files:**

- `src/memory/extract-schema.ts`
- `src/memory/extract-prompt.ts`
- `src/memory/extract-llm.ts`
- `src/memory/writer.ts`
- `src/memory/schema.ts`

## Product decision

For the next reliable release, **LLM extraction should durably contribute decisions only**.

Heuristics remain authoritative for:

```text
current_task
active_files
blockers
next_steps
```

This is deliberately narrower than the current hybrid implementation.

## New LLM output contract

Use a decision-focused shape similar to:

```ts
type LLMDecisionFacts = {
  decisions: Array<{
    topic: string
    decision: string
    rationale?: string
    evidence_refs: string[]
  }>
}
```

Every accepted LLM decision must pass the existing deterministic evidence resolution.

## Remove unsupported LLM durable mutations

LLM results should no longer directly overwrite or append:

- current task
- active files
- blockers
- next steps

Remove generic `firstCandidateEvidence(...)` use as a way to assign `llm-corroborated` provenance to facts that were not validated against that evidence.

## Align types

Remove the current type lie where `evidence_refs` is optional to preserve compatibility with a legacy fact type while runtime schema requires it.

Keep heuristic `ExtractedFacts` and LLM decision facts as separate explicit types.

Likewise align cache construction types with the actual structured LLM result type.

## Required tests

1. LLM decision with valid evidence merges/corroborates
2. LLM decision with unknown evidence is rejected
3. LLM cannot change current task
4. LLM cannot create active file
5. LLM cannot create blocker
6. LLM cannot create next step
7. every persisted `llm-corroborated` decision has exact validated evidence
8. cache only stores accepted evidence-backed decision facts

## Definition of done

`llm-corroborated` has one precise meaning: a durable decision accepted after deterministic evidence validation against the current source session.

---

# PR 7 — Guarantee storage and injection budgets

**Resolves:** G4, I12, remaining I5 pressure cases  
**Primary files:**

- `src/memory/writer.ts`
- `src/memory/schema.ts`
- `src/memory/memory-size.ts`
- `src/compaction/durable.ts`

## 1. Replace weak `pruneOld()` postcondition

Introduce an explicit result:

```ts
type PruneResult =
  | { ok: true; memory: MemoryFile }
  | { ok: false; reason: "foundational-state-exceeds-budget" }
```

For every `ok: true` result:

```ts
memorySizeBytes(memory) <= MEMORY_MAX_BYTES
```

must always be true.

## 2. Retention priority

Prune in this order:

1. completed audit/cache/health metadata
2. invalid decisions
3. stale non-foundational active files
4. old non-foundational decisions
5. verbose rationale/reason text
6. excess non-foundational recent decisions
7. blocker/next-step verbosity if required
8. human-reviewed foundational decisions: never silently discard

If irreducible human-reviewed foundational state itself exceeds the hard storage budget:

- reject the new mutation with a typed failure;
- preserve the previous valid STATE;
- emit a clear bounded diagnostic.

Do not silently delete the human-reviewed record.

## 3. Add field bounds

Add sensible Zod maximums to large durable strings/counts, including:

- topic
- decision
- rationale
- blocker
- next step
- active-file reason/path
- current task

Bounds should be high enough for normal use but low enough to prevent one malformed fact from consuming the entire state budget.

## 4. Add an explicit compaction injection budget

Define, initially:

```ts
export const DURABLE_BLOCK_MAX_BYTES = 4096
```

Render under a total byte budget rather than relying indirectly on STATE's 8 KB cap.

Recommended priority:

1. project identity / last update
2. current task
3. blockers
4. next steps
5. foundational decisions
6. active files
7. recently referenced decisions
8. older fallback decisions

Stop adding lower-priority content when the total would exceed the budget.

Per-section caps may be added as defense in depth, but the total byte budget is the contract.

## Required tests

1. every successful prune result is <= 8192 bytes
2. successful prune result can actually be written by `writeMemory()`
3. 31-day foundational survives when disposable/non-foundational data can be removed
4. 10/5 pressure stages retain foundational first
5. irreducible foundational overflow returns typed failure and preserves prior state
6. durable block always <= declared injection budget
7. retained foundational memory does not have to be fully auto-injected to remain recallable
8. multibyte UTF-8 content respects byte rather than character budgets

## Definition of done

Storage pruning either produces a guaranteed writable state or explicitly refuses the mutation; compaction injection has an independent hard maximum.

---

# PR 8 — Make diagnostics reflect reality

**Resolves:** G8, G6, G7, H1  
**Primary files:**

- new/generalized diagnostic artifact storage helper
- `src/index.ts`
- `src/tools/status.ts`
- `src/memory/writer.ts`
- `src/memory/activity-state.ts`

## 1. Remove process-global compaction timestamp

Delete:

```ts
lastCompactionTimestamp
setLastCompaction()
```

Use persisted per-project diagnostic state instead.

## 2. Use local/global diagnostic artifact resolution

Apply the same project path/hash/fallback policy to:

```text
last_compaction.log
```

and any future durable diagnostics that need to survive read-only worktrees.

Possible paths:

```text
<project>/.opencode/memory/last_compaction.log
~/.config/opencode/memory/<project-hash>/last_compaction.log
```

Read/select candidates with the same effective-location policy used by storage where appropriate.

## 3. Surface best-effort persistence failures

For audit terminal and health metadata writes:

```ts
const persisted = await mutateMemory(...)
if (!persisted) {
  void log(client, "warn", "... persistence failed", ...)
}
```

These paths remain best-effort and must not invalidate heuristic memory success, but failures should be observable.

## 4. Fix active-file activity labels

Replace one undifferentiated count with categories:

```ts
type FileActivity = {
  reads: number
  edits: number
  writes: number
  searches: number
  shellRefs: number
}
```

Render accurate reasons such as:

```text
edited twice
written once
read 4 times
searched 3 times
referenced by shell
```

Do not infer that every bash reference is a read or edit.

## Required tests

1. status survives process reload and reports last compaction
2. read-only project writes/reads global compaction diagnostic artifact
3. two projects in same process report distinct last compaction times
4. audit/health persistence false result logs bounded warning
5. read-only metadata failure does not alter heuristic success
6. grep/glob activity renders as search, not edit
7. bash-only reference is not labeled read/edit unless independently known

## Definition of done

Status and diagnostics report per-project durable reality rather than process-global guesses, and best-effort metadata failures are visible without changing core memory semantics.

---

# PR 9 — Make releases reproducible and auditable

**Resolves:** N4, N5, I13 and stale release documentation  
**Primary files:**

- `.github/workflows/ci.yml`
- new release workflow
- `install.sh`
- `package.json`
- documentation

## 1. Choose one dist source-of-truth strategy

If `dist/` remains committed, CI must run:

```bash
npm run build
git diff --exit-code -- dist/
```

If that is undesirable, stop committing `dist/` and produce distribution artifacts only in release/package jobs.

Choose exactly one strategy.

A release-generated dist is preferred because it avoids source/build drift in normal commits.

## 2. Release one immutable artifact set

A release workflow should build and publish a single versioned set such as:

```text
tokenmaxxer.js
tokenmaxxer-tui.js
tokenmaxxer-cli.js
launcher
install.sh
SHA256SUMS
```

All files must correspond to one tag/commit.

## 3. Pin installer downloads to the immutable release

The installer should resolve one explicit release/tag/version and obtain every artifact from that same immutable source.

Do not independently download mutable `main` files.

## 4. Verify integrity before replacement

The installer must:

1. download artifacts to temporary files;
2. download the checksum manifest;
3. verify SHA-256 values;
4. only then atomically replace installed files;
5. print installed version/commit.

Config files should likewise be edited via temp + atomic rename, with a backup where appropriate.

## 5. Dependency audit triage

Add structured audit output to CI/release review:

```bash
npm audit --json
```

Classify each finding:

```text
direct vs transitive
runtime vs dev-only
bundled into dist?
reachable path?
upgrade available?
```

Do not use `npm audit fix --force` blindly.

## 6. Refresh stale docs

Update documentation to reflect actual implementation, including any claims about:

- Git implementation (`child_process` vs older Bun references)
- supported OpenCode versions
- installer/release behavior
- number and behavior of tools
- human promotion workflow

## Required tests / release gates

1. clean checkout builds release successfully
2. release artifact checksums verify
3. installer refuses modified artifact
4. installer cannot mix revisions
5. installer preserves previous files if verification fails
6. installed version/commit is visible
7. `npm pack` contains exactly intended files
8. dependency findings are retained/triaged

## Definition of done

A user can identify exactly which source revision produced the installed TokenMaxxer files, and the installer verifies that the downloaded files belong to that release.

---

# Merge and dependency order

Use this dependency graph:

```text
PR 1  Storage authority
  ↓
PR 2  Cross-process transactions
  ↓
PR 3  Decision authority / promotion trust
  ↓
PR 4  OpenCode host contract
  ↓
PR 5  Source idempotency / outcomes / recall recency
  ↓
PR 6  LLM trust boundary
  ↓
PR 7  Storage + injection budgets
  ↓
PR 8  Diagnostics
  ↓
PR 9  Release hygiene
```

Do not begin with a large `writer.ts` / `extract-llm.ts` refactor. First establish the new behavioral invariants with regression tests. Once PRs 1–7 have stabilized the contracts, module splitting becomes much safer.

---

# Per-PR engineering workflow

Each PR should follow the same pattern:

1. **Add a regression test that fails on current `main`.**
2. Implement the smallest architecture change that makes it pass.
3. Add adversarial/edge-case tests for the new invariant.
4. Run the full suite.
5. Rebuild distribution artifacts according to the chosen dist strategy.
6. Update relevant documentation in the same PR.
7. Keep one PR focused on one invariant cluster.

Minimum validation on every PR:

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

---

# New invariant test matrix

## Storage

- unreadable existing STATE is never treated as empty
- local/global resolution chooses the authoritative revision
- global fallback round trip works
- source cache invalidates when either candidate changes
- non-git projects retain unique real project identity
- HEADER failure cannot change STATE write success
- status reports the selected backing file
- atomic temp names are invocation-unique

## Concurrency

- two child processes preserve both mutations
- idle + promotion race preserves both
- live lock cannot be stolen
- dead/stale lock can be recovered safely
- different projects remain independent
- revisions remain monotonic

## Decisions

- one valid authoritative row per normalized topic
- equivalent LLM corroboration does not duplicate authority
- later supersession invalidates every prior authority
- automation cannot silently supersede human foundational authority
- promotion uses exact valid decision ID
- invalid decision cannot be promoted
- model tool cannot create `human-reviewed`
- explicit CLI confirmation can
- foundational survives normal age/pressure pruning

## LLM idempotency and provenance

- exact source processed twice sequentially -> no second prompt
- same after process reload
- changed source digest -> reprocessing permitted
- every LLM durable decision has exact evidence
- LLM cannot durably inject unsupported non-decision facts

## Budgets

- successful prune result always fits 8 KB
- failed prune leaves previous valid STATE intact
- durable compaction block always fits declared budget
- storage retention and compaction injection are independently tested

## Host integration

Against the oldest supported OpenCode and the normal verified version, smoke-test:

1. `tokenmaxxer_status`
2. `head_files`
3. `preview_compaction`
4. `get_project_state`
5. `recall_decision`
6. promotion request + human confirmation workflow
7. idle heuristic write
8. optional LLM extraction
9. compaction
10. plugin/process reload
11. non-git directory
12. read-only project/global fallback

---

# Final architecture after the plan

The target runtime should have five explicit invariants:

```text
1. One authoritative storage state per project.
2. One cross-process serialized mutation transaction per project.
3. One authoritative valid decision per normalized topic.
4. One trustworthy meaning for every provenance confidence level.
5. One immutable processing identity for every source session/transcript version.
```

The intended trust ladder becomes:

```text
legacy
  < heuristic observation
  < LLM-corroborated decision with exact source evidence
  < explicitly human-reviewed foundational decision
```

Storage and compaction should remain separate policies:

```text
durable retention != automatic injection
```

A fact may remain durable and recallable without always being injected into compaction context.

---

# Recommended immediate starting point

Start with **PR 1 — storage authority and read semantics**.

Nearly every later fix assumes that reading memory provides a trustworthy answer about the current state. Until local/global resolution, read-error semantics, project identity, and state metadata are reliable, higher-level decision and transaction fixes are harder to prove.

After PR 1, implement PR 2 immediately. The combination of authoritative reads plus a cross-process transaction boundary establishes the foundation required for every remaining memory-integrity improvement.
