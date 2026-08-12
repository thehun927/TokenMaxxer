# CRIP PR 9 — Concrete Implementation Plan

**Workstream:** Accurate diagnostics and artifact storage  
**Status:** Implementation plan ready  
**Planning baseline:** `4df7873856e5f5714e45c120e1224e28450f4ee7`  
**PR-8 final residual implementation:** `15d3bb55b180c1db4981abb517f6bd159c68e049`  
**PR-8 final Oracle validation head:** `79d17e0258176cad83dd862cbfa1561c177e10fd`  
**Post-PR-8 integration note:** current `main` includes the separately validated TMTUI commit-pulse work at `4df7873`; PR 9 must preserve it.

PR 9 resolves CRIP findings **G8, G6, G7, H1** and the remaining compaction-observability cleanup. PRs 1–8 are already shipped invariants and must not be weakened.

---

## 1. Release invariant

> **Every diagnostic shown as durable project state must come from a persisted per-project observation of the event/artifact it claims to describe; diagnostic artifacts must survive process reload and read-only worktrees, prompt snapshots must never masquerade as compaction results, file-activity labels must describe only observed operation categories, and diagnostic persistence failure must never change the success/failure semantics of the primary memory or compaction operation.**

This PR is about truthfulness and survivable observability, not new memory authority.

The core separation is:

```text
STATE.json                         = product memory authority
last_compaction_prompt.log         = TokenMaxxer compaction input diagnostic
last_compaction_result.json        = successful host compaction completion metadata
.commit-pulse                      = tiny TMTUI successful-STATE-commit telemetry
process-local queue/model counters = ephemeral process diagnostics
```

These surfaces must not be conflated.

---

## 2. Current implementation facts to preserve or correct

### 2.1 Process-global last-compaction state is still wrong

`src/tools/status.ts` currently exports:

```ts
export let lastCompactionTimestamp: string | null = null
export function setLastCompaction(ts: string) { ... }
```

`src/index.ts` calls that setter when `experimental.session.compacting` fires.

Consequences:

- project A can make project B appear recently compacted in the same process;
- process restart loses the value;
- the timestamp records **hook invocation**, not successful compaction completion;
- the nullable-reset test seam does not match the setter type (H1).

PR 9 removes this state entirely.

### 2.2 Prompt artifact storage is local-only

The compaction hook currently writes:

```text
<project>/.opencode/memory/last_compaction_prompt.log
```

with a direct `atomicWrite()` and silently swallows failure.

Read-only projects that already require global STATE fallback can therefore lose the prompt diagnostic entirely.

### 2.3 The minimum host has a real successful-compaction event

Verified against **OpenCode v1.18.15** at:

```text
anomalyco/opencode
packages/opencode/src/session/compaction.ts
```

The host:

1. runs `experimental.session.compacting` before summary generation;
2. persists the compaction assistant message;
3. returns `stop` on processor error/overflow;
4. publishes `session.compacted` only when `result === "continue"`;
5. publishes only `{ sessionID }` in that event.

Therefore PR 9 **will** add a bounded post-compaction result artifact. We do not need polling or unsupported host internals.

The event proves successful completion. Because it does not contain the summary body or summary metrics, TokenMaxxer may re-read `client.session.messages()` after the event using the already verified PR-7 completed-summary semantics. Failure of that secondary read does not erase the fact that the host emitted successful completion.

### 2.4 Current file reasons are semantically false

`extractActiveFiles()` collapses `read`, `edit`, `write`, `glob`, `grep`, and bash-derived path references into one counter and currently renders repeated references as:

```text
edited N times
```

A grep, glob, repeated read, or shell mention is not evidence of an edit.

### 2.5 Best-effort persistence must stay best-effort, but failures must be visible

Audit terminal and model-health metadata are non-authoritative diagnostics. Their failures must not turn a successful heuristic memory operation into failure, but they must emit bounded warnings rather than disappear.

The required audit guard is different: guard persistence remains a prerequisite for the optional LLM prompt and must keep PR-2/PR-6 fail-closed behavior.

### 2.6 TMTUI commit pulse is not PR-9 compaction status

Current `main` contains `src/memory/commit-pulse.ts` and `src/tui.tsx` from TMTUI. The marker lives in the stable global project namespace and means only:

> a successful durable STATE commit occurred recently.

PR 9 must not rename it, repurpose it as compaction status, delete it during diagnostic cleanup, or make TUI success dependent on PR-9 artifact writes.

---

## 3. New diagnostic artifact storage contract

Create:

```text
src/diagnostics/artifacts.ts
```

This is a small filesystem policy module for last-only diagnostic artifacts. It does **not** read or write `STATE.json` and it does not participate in memory revision authority.

### 3.1 Path authority

Add or reuse a central project memory-directory helper so diagnostic paths are never independently reinvented.

Recommended small addition to `src/memory/paths.ts`:

```ts
export function projectMemoryStorageDir(project: string): string
```

with existing paths expressed through it where practical:

```text
project-local:
  <project>/.opencode/memory/<artifact>

global fallback:
  ~/.config/opencode/memory/<project-hash>/<artifact>
```

Use the existing `globalProjectStorageDir(project)` and stable `projectStorageHash(project)` contract. Do not introduce a second project hash.

### 3.2 Safe artifact names

No caller-controlled path traversal.

Prefer an explicit union for PR-9 artifacts:

```ts
type DiagnosticArtifactName =
  | "last_compaction_prompt.log"
  | "last_compaction_result.json"
```

If the helper is made generic for future diagnostics, enforce `basename(name) === name`, reject separators / `..`, and keep tests for traversal attempts.

### 3.3 Typed write result

```ts
type DiagnosticArtifactWriteResult =
  | {
      ok: true
      source: "project" | "global"
      path: string
      sizeBytes: number
    }
  | {
      ok: false
      reason: "too-large" | "io-failed"
      sizeBytes: number
      maxBytes: number
    }
```

Write policy:

1. compute exact UTF-8 bytes first;
2. reject an over-limit artifact before touching disk;
3. atomically write project-local first;
4. on local I/O failure, atomically write global fallback;
5. if both fail, return typed failure;
6. never throw as the expected API contract.

`atomicWrite()` already has invocation-unique temp names and remains the low-level primitive.

### 3.4 Typed read result

```ts
type DiagnosticArtifactReadResult =
  | {
      status: "ok"
      content: string
      source: "project" | "global"
      path: string
      sizeBytes: number
      mtime: number
    }
  | {
      status: "missing"
      source: null
      path: null
      sizeBytes: 0
    }
  | {
      status: "unavailable"
      source: null
      path: null
      sizeBytes: 0
      errors: Array<{
        source: "project" | "global"
        path: string
        code?: string
      }>
    }
```

Selection semantics mirror the already shipped local/global diagnostic expectations:

```text
both readable  -> newer mtime wins
mtime tie      -> project-local wins
one readable   -> readable candidate wins
none readable + any read error -> unavailable
both absent    -> missing
```

No process cache is necessary for two tiny status files; correctness and simple reload behavior outrank an unnecessary cache.

### 3.5 Artifact writes are never product-success authority

A failed diagnostic artifact write:

- never changes `IdleWriteOutcome`;
- never changes compaction hook output;
- never changes STATE revision;
- never changes the TMTUI commit pulse;
- emits a bounded warning when a host client is available.

---

## 4. Compaction prompt diagnostic

Create:

```text
src/diagnostics/compaction.ts
```

Move prompt-snapshot construction out of `src/index.ts`.

### 4.1 Name means exactly what it says

The artifact remains:

```text
last_compaction_prompt.log
```

It records the exact TokenMaxxer-supplied compaction payload for that hook invocation:

- replacement mode -> TokenMaxxer replacement prompt;
- augmentation mode -> TokenMaxxer context augmentation;
- replacement-history failure -> actual augmentation fallback payload.

It does **not** record the host-generated compaction summary.

### 4.2 Structured header

Use a deterministic text header such as:

```text
artifact=tokenmaxxer-compaction-prompt
format_version=1
observed_at=2026-08-12T...
session=<bounded id>
requested_mode=augment|replace|...
effective_mode=augment|replace
kind=context-augmentation|replacement-prompt
payload_bytes=<original UTF-8 bytes>
payload_stored_bytes=<stored UTF-8 bytes>
payload_truncated=false|true
fallback_reason=<bounded, optional>
--- payload ---
<actual TokenMaxxer payload or clearly truncated prefix>
```

Use real newlines.

### 4.3 Hard diagnostic bound

Define:

```ts
export const COMPACTION_PROMPT_ARTIFACT_MAX_BYTES = 96 * 1024
```

Rationale: PR 7 bounds the previous-summary interpolation to 16,384 characters and PR 8 bounds durable context to 4,096 UTF-8 bytes. A 96 KiB diagnostic ceiling remains hard/bounded while covering the known worst-case TokenMaxxer replacement payload with substantial margin.

The budget includes header + payload + newlines.

If a future payload exceeds it:

- truncate only the stored diagnostic payload on a UTF-8 boundary;
- leave the actual compaction output untouched;
- set `payload_truncated=true`;
- retain original `payload_bytes` and actual `payload_stored_bytes`;
- the final artifact must be `<= COMPACTION_PROMPT_ARTIFACT_MAX_BYTES`.

Do not truncate or alter the payload being sent to the host in order to make a diagnostic fit.

### 4.4 Persistence failure is visible and non-fatal

Replace the current silent `catch {}` with a bounded warning carrying only:

```text
artifact name
project
failure reason
size/max bytes when relevant
```

Never log the prompt body merely because artifact persistence failed.

---

## 5. Successful compaction result diagnostic

Because OpenCode v1.18.15 provides `session.compacted`, PR 9 should implement the optional master-plan result diagnostic now.

Artifact:

```text
last_compaction_result.json
```

### 5.1 Result schema

Recommended v1 shape:

```ts
type CompactionResultDiagnostic = {
  version: 1
  completed_at: string
  session_id: string
  host_event: "session.compacted"
  summary:
    | {
        status: "found"
        bytes: number
        sha256: string
      }
    | { status: "missing" }
    | {
        status: "unavailable"
        reason: string
      }
}
```

Use a runtime schema for parsing status artifacts. Bounds:

```text
session_id     <= 256 chars
reason         <= 500 chars
sha256         exactly 64 lowercase hex
whole JSON     <= 4096 UTF-8 bytes
```

`completed_at` is the timestamp at which TokenMaxxer receives the host's successful `session.compacted` event. The host emits that event only after successful compaction processing, so this is a truthful completion observation.

### 5.2 Never persist the summary body

On `session.compacted`:

1. obtain `sessionID` from the event;
2. call the already verified session-message/history path;
3. if the latest completed summary is found:
   - compute UTF-8 byte size;
   - compute SHA-256 for diagnostic identity;
   - discard the summary body;
4. if no completed summary is found, record `summary.status="missing"`;
5. if session history is unavailable/malformed, record `summary.status="unavailable"` plus a bounded reason;
6. persist the result JSON via the diagnostic artifact resolver.

The host event is the authority for **completion**. A secondary summary-read failure must not cause TokenMaxxer to omit the successful compaction observation.

### 5.3 Do not invent unsupported quality claims

Do **not** initially persist semantic booleans such as:

```text
constraints_preserved=true
verification_preserved=true
next_steps_preserved=true
```

unless a deterministic check actually proves them. Native/augment summaries do not have guaranteed headings, so string-presence heuristics would create another misleading diagnostic.

PR 9 result metadata is factual:

```text
successful completion event
session identity
summary retrieval status
summary size/hash when available
```

No LLM-based diagnostic grader is added.

### 5.4 Event integration

Extend the existing `event` handler in `src/index.ts`:

```text
session.compacted
  -> recordCompactionResultBestEffort(...)

session.idle
  -> existing memory pipeline unchanged
```

The compaction-result path must not call `writeMemoryOnIdle`, change STATE, or create an LLM extraction audit.

---

## 6. Status becomes durable per-project truth

Delete from `src/tools/status.ts`:

```text
lastCompactionTimestamp
setLastCompaction
```

Delete all tests/imports that reset or mutate that module-global state.

### 6.1 Read completed compaction from disk

`_tokenmaxxerStatus()` resolves the project exactly once, then reads:

```text
last_compaction_result.json
last_compaction_prompt.log
```

through the artifact resolver.

Recommended output lines:

```text
Last completed compaction: <timestamp|none|unavailable>
Compaction session: <id|none>
Compaction summary metadata: found <N> bytes | missing | unavailable
Compaction result artifact: <path|none> (<project|global|none>)
Compaction prompt snapshot: <path|none> (<project|global|none>, <N> bytes)
```

If result JSON exists but fails its runtime schema, report:

```text
Last completed compaction: unavailable (invalid diagnostic artifact)
```

Do not throw the entire status response away because one diagnostic artifact is malformed.

### 6.2 Label ephemeral status as ephemeral

The following are process-local/process-wide and must say so explicitly:

```text
Queue depth (process-local)
In-flight (process-local)
Last idle outcome (process-local)
LLM evidence (process-wide)
LLM candidates (process-wide)
LLM variant (process-wide)
```

Do not imply those values survive reload.

### 6.3 Do not call durable health “selected model”

The newest `model_health` row is historical durable health metadata, not proof of the model that would be selected by a future request.

Rename status wording from:

```text
LLM selected: provider/model (durable-health)
```

to something truthful, for example:

```text
Latest durable model health: provider/model
```

Keep the process-wide live resolution line separately labeled if retained.

### 6.4 Two projects in one process

Status A must never show project B's compaction result merely because B compacted more recently in the same OpenCode process.

This is a release-gate test, not an implementation assumption.

---

## 7. Bounded diagnostics and best-effort persistence warnings

Create a small shared helper, recommended:

```text
src/diagnostics/bounds.ts
```

```ts
export function boundedDiagnosticValue(value: string, maxChars = 500): string
export function boundedDiagnosticError(error: unknown, maxChars = 500): string
```

Use it instead of accumulating one-off `boundReason()` / writer-only helpers.

### 7.1 Audit required vs best-effort persistence

Preserve this distinction:

```text
audit guard creation
  required before optional LLM prompt
  failure remains guard-failed / no prompt

audit terminal outcome
  best effort
  failure logs warning but does not rewrite primary outcome

model health update
  best effort
  failure logs warning but does not rewrite primary outcome
```

### 7.2 Catch unexpected best-effort exceptions

`persistTerminalTransaction()` and `persistModelHealth()` should not leak an unexpected filesystem/transaction exception into the extraction lifecycle if their documented contract is best-effort.

Wrap expected calls so:

```text
lock-timeout/unavailable/commit-failed/budget-rejected
  -> bounded warning, return

unexpected throw
  -> bounded warning, return
```

Do not add stale full-state retry writes.

### 7.3 Bound existing observability errors while touching the seam

At minimum review:

- compaction hook outer error;
- compaction-result artifact failure;
- prompt artifact failure;
- HEADER best-effort error;
- audit terminal error;
- model-health error;
- LLM diagnostic error strings already routed through writer bounds.

Do not redesign the generic OpenCode logging transport in this PR. Bound the values at the TokenMaxxer call sites that accept arbitrary host/filesystem text.

---

## 8. Accurate file-activity classification

Do not change `MemoryFile.version` and do not add a durable activity-count schema merely to fix labels.

Track structured activity transiently during heuristic extraction, then persist the deterministic reason string already supported by `ActiveFileSchema`.

### 8.1 Transient activity type

In `src/types.ts` or a focused writer helper:

```ts
type FileActivity = {
  reads: number
  edits: number
  writes: number
  searches: number
  shellRefs: number
}
```

Recommended heuristic active-file shape:

```ts
type HeuristicActiveFile = {
  path: string
  reason: string
  activity: FileActivity
}
```

The `activity` object remains transient and must not accidentally spread into durable `active_files`.

### 8.2 Operation mapping

Only completed tool operations count:

```text
read         -> reads += 1
edit         -> edits += 1
write        -> writes += 1
glob / grep  -> searches += 1
bash path    -> shellRefs += 1
```

A bash mention proves only a shell reference. It does not prove read, edit, write, rename, or deletion.

Errored/pending tool calls do not increment successful activity counters.

### 8.3 Deterministic reason format

Use compact explicit category labels containing only nonzero counts, for example:

```text
reads=2 edits=1 searches=3 shell_refs=1
writes=1
searches=2
shell_refs=1
```

This is preferred over natural-language guesses such as `edited 4 times`.

The final reason stays under the existing automatic creation bound.

### 8.4 Ranking

Keep ranking behavior narrow:

1. rank by total observed completed activity count;
2. stable first-seen order breaks ties;
3. retain the existing top-N / `activeFilesMax` ceiling.

Do not invent a hidden weight where one edit automatically outranks ten reads unless separately justified.

### 8.5 Current-session reason replaces stale generic history

`mergeHeuristicMemory()` currently preserves an older reason when the incoming reason looks generic (`read once` / `edited N times`). That would undermine the PR-9 fix.

For each current-session incoming active file, persist the newly derived accurate current-session reason. Prior reasons are not evidence of what happened in this source transcript.

Active files not present in the current extracted set continue to follow the existing active-file merge semantics; PR 9 does not turn the list into a lifetime audit log.

---

## 9. No new STATE authority or schema migration

PR 9 does **not** store compaction diagnostics in `STATE.json`.

Reasons:

- compaction observability should not consume the protected 8KB memory budget;
- a diagnostic write must not advance memory revision;
- a read-only worktree may still persist diagnostics globally;
- result metadata has a different lifecycle from semantic project memory.

PR 9 also does not bump `MemoryFile.version` for file activity. The durable file reason remains a string.

---

## 10. Compatibility and failure semantics

### 10.1 Existing local prompt artifact

If a project already has a project-local `last_compaction_prompt.log`, the new resolver reads it normally. No migration is required.

If both local and global prompt artifacts exist, select by mtime with local tie-break.

### 10.2 No legacy process-global fallback

Do not retain `lastCompactionTimestamp` as a fallback when no result artifact exists. After PR 9:

```text
no persisted successful result artifact -> Last completed compaction: none
```

This prevents process-local guesses from re-entering the system.

### 10.3 Result artifact corruption

A malformed `last_compaction_result.json` is a diagnostic failure, not memory corruption.

Status reports it as unavailable/invalid and continues displaying STATE, queue, LLM, and provenance health.

### 10.4 Artifact write failure

A diagnostic write failure must not become:

```text
write-failed
llm-failed
queue-failed
compaction hook error
```

unless the underlying primary operation independently failed.

---

## 11. Implementation waves

Luna owns integration, wave boundaries, reconciliation, and final release evidence. Subagents own bounded disjoint slices.

### Wave 1 — Freeze behavioral contracts with failing tests

Use three parallel test-only agents.

#### Agent 1A — artifact storage / status contracts

Own new tests only, recommended:

```text
test/diagnostics/artifacts.test.ts
test/tools/pr9-status.test.ts
```

Freeze:

- project/global artifact resolution;
- mtime selection and local tie-break;
- read-only fallback;
- process reload;
- two-project isolation;
- invalid result JSON handling;
- process-local labeling.

#### Agent 1B — compaction prompt/result contracts

Own new tests only:

```text
test/diagnostics/compaction.test.ts
test/index-pr9-compaction.test.ts
```

Freeze:

- prompt artifact remains prompt-only;
- 96 KiB prompt diagnostic bound;
- `session.compacted` completion persistence;
- summary body never persisted;
- result JSON <=4 KiB;
- summary missing/unavailable still records completion;
- diagnostic failures do not affect compaction output.

#### Agent 1C — writer diagnostics / activity contracts

Own new tests only:

```text
test/memory/pr9-persistence-warning.test.ts
test/memory/pr9-file-activity.test.ts
```

Freeze:

- best-effort terminal/health failures warn and do not escape;
- required audit guard still fails closed;
- exact read/edit/write/search/shell classification;
- stale old reason cannot override current-session observed activity;
- no activity object enters durable STATE.

Wave 1 agents may not change production architecture.

Luna integrates all Wave-1 tests, runs them to confirm expected failures against the baseline, records them in `blockers.md`, then starts production waves.

### Wave 2 — Diagnostic artifact storage helper

**Primary ownership:** artifact-storage agent  
**Files:**

```text
src/diagnostics/artifacts.ts
src/memory/paths.ts (small central path helper only)
test/diagnostics/artifacts.test.ts
```

Deliver:

- safe artifact names;
- typed local/global writes;
- typed local/global reads;
- exact UTF-8 size reporting;
- newest-mtime selection;
- no cache;
- project-hash fallback reuse.

Do not touch compaction/status behavior yet beyond compile-required imports.

### Wave 3 — Compaction prompt + successful-result persistence

**Primary ownership:** compaction-diagnostics agent  
**Files:**

```text
src/diagnostics/compaction.ts
src/index.ts
src/compaction/history.ts only if a narrow reusable latest-summary helper is needed
test/diagnostics/compaction.test.ts
test/index-pr9-compaction.test.ts
```

Deliver:

- prompt snapshot builder/writer;
- bounded prompt artifact;
- `session.compacted` handler;
- bounded result JSON;
- summary bytes/hash metadata only;
- completion persists even when summary retrieval is unavailable;
- remove `setLastCompaction()` call from index.

Do not modify PR-7 prompt/augmentation semantics.

### Wave 4 — Durable per-project status

**Primary ownership:** status agent  
**Files:**

```text
src/tools/status.ts
test/tools/status.test.ts
test/tools/status-extended.test.ts
test/tools/pr9-status.test.ts
```

Deliver:

- delete global timestamp/setter;
- read result/prompt artifacts by resolved project;
- status survives reload;
- project A/B separation;
- global artifact source/path reporting;
- malformed diagnostic containment;
- explicit process-local/process-wide labels;
- rename historical durable health wording.

Do not redesign recall/status tool registration or host ToolContext.

### Wave 5 — Bounded best-effort persistence diagnostics

**Primary ownership:** persistence-diagnostics agent  
**Files:**

```text
src/diagnostics/bounds.ts
src/memory/writer.ts (persistence/logging seams only)
src/index.ts (shared bound helper adoption only)
test/memory/pr9-persistence-warning.test.ts
```

Deliver:

- shared bounded arbitrary diagnostic/error strings;
- terminal-audit unexpected failures swallowed + warned;
- model-health unexpected failures swallowed + warned;
- HEADER diagnostic error bounded;
- primary heuristic/LLM outcome unchanged by best-effort metadata failure;
- audit guard remains required/fail-closed.

Do not refactor the large writer or extraction architecture.

### Wave 6 — Accurate file activity

**Primary ownership:** activity agent  
**Files:**

```text
src/types.ts
src/memory/writer.ts (active-file extraction/merge seams only)
test/memory/pr9-file-activity.test.ts
relevant existing writer/extract tests
```

Deliver:

- transient `FileActivity`;
- completed-tool category counts;
- deterministic reason rendering;
- current-session reason replacement;
- stable total-count ranking;
- no durable schema/version expansion.

### Wave 7 — Cross-feature integration and adversarial audit

**Primary ownership:** adversarial integration agent + Luna reconciliation

Focus:

- read-only project with global STATE + global diagnostic artifacts;
- two projects in one plugin process;
- process reload after successful compaction;
- prompt/result artifacts cannot be confused;
- diagnostic write failures during successful memory/compaction operations;
- repeated compactions replace last-only artifacts cleanly;
- PR-7 augment/replace + previous-summary behavior unchanged;
- PR-8 4KB injection/8KB STATE budgets unchanged;
- TMTUI commit pulse still triggers only successful STATE commits;
- no diagnostics path touches `.commit-pulse`;
- no STATE revision changes from compaction artifact persistence.

Luna must inspect the integrated diff after this wave rather than accepting independent agent summaries.

### Wave 8 — Luna release audit and Oracle handoff

Luna only.

Run the complete release chain on the exact final implementation SHA:

```bash
npm ci
npm test
npx tsc --noEmit
npm run verify:host-contract
npm run build
npm run check:tui-bundle
# existing self-contained bundle check from CI
npm run verify-cli-bundle
npm run smoke:cli
bash -n install.sh
bash -n bin/tokenmaxxer
git diff --check
```

Do not add PR-10 dist-parity/checksum/dependency remediation in PR 9.

Create:

```text
docs/CRIP/PR-9/oracle-investigation.md
```

Then stop. Luna does not issue the Oracle verdict.

---

## 12. Luna/subagent ownership rules

### 12.1 One orchestrator

Luna owns:

- baseline reconciliation;
- wave sequencing;
- integration conflict resolution;
- exact test reruns after subagent work;
- final SHA and CI evidence;
- implementation handoff.

### 12.2 No concurrent ownership of the same major source file

In particular, `src/index.ts` and `src/memory/writer.ts` are conflict magnets.

Do not run Wave 3 and Wave 5 agents concurrently against `src/index.ts`.
Do not run Wave 5 and Wave 6 agents concurrently against `src/memory/writer.ts`.

Recommended order:

```text
Wave 1   parallel test agents
Wave 2   artifact storage
Wave 3   compaction diagnostics
Wave 4   status
Wave 5   persistence warnings
Wave 6   file activity
Wave 7   adversarial integration
Wave 8   Luna only
```

### 12.3 Subagents may not broaden scope

If an agent discovers a PR-10 release issue, record it in `blockers.md`; do not fix it here unless required to keep PR-9 code compiling/running.

---

## 13. Semantic release matrix

Minimum release matrix: **84 behavioral cases**. Luna may add more; she may not silently remove these.

### A. Artifact path/write/read semantics — 18 cases

1. project diagnostic path uses resolved project path
2. global diagnostic path uses existing stable project hash
3. prompt artifact local write succeeds
4. result artifact local write succeeds
5. local write failure falls back globally
6. both writes fail -> typed `io-failed`
7. over-limit content -> typed `too-large`, no write
8. UTF-8 byte count uses encoded bytes, not JS length
9. local-only read selects local
10. global-only read selects global
11. both readable -> newer mtime wins
12. equal mtime -> local deterministic tie-break
13. one readable + other missing -> readable wins
14. neither present -> `missing`
15. neither readable + any read error -> `unavailable`
16. traversal artifact name rejected
17. two projects produce different global artifact directories
18. artifact read has no process cache dependency / sees replacement immediately

### B. Prompt snapshot truthfulness/bounds — 12 cases

19. augment snapshot stores actual augmentation payload
20. replace snapshot stores actual replacement prompt
21. history-unavailable fallback stores actual augmentation, not attempted replacement
22. requested/effective mode recorded separately
23. artifact is named prompt, never result
24. real newlines are used
25. fallback reason is bounded
26. ordinary payload stores unmodified diagnostic copy
27. original payload bytes are recorded
28. over-limit diagnostic is UTF-8 safely truncated
29. truncated diagnostic says `payload_truncated=true`
30. whole prompt artifact <=96 KiB

### C. Post-compaction result semantics — 14 cases

31. `session.compacted` event creates result artifact
32. hook invocation alone does not create successful result artifact
33. result JSON has runtime-valid v1 schema
34. result artifact <=4096 bytes
35. summary found -> exact UTF-8 byte count recorded
36. summary found -> deterministic SHA-256 recorded
37. summary body is absent from JSON
38. no summary after successful event -> `summary.status=missing`
39. session.messages unavailable -> completion still recorded with `summary.status=unavailable`
40. thrown history read -> bounded unavailable reason
41. result write local failure uses global fallback
42. result write failure emits bounded warning and does not throw event handler
43. repeated successful compaction replaces last-only result
44. failed/errored compaction with no `session.compacted` event cannot advance completed result

### D. Status durability and project isolation — 14 cases

45. persisted result survives process/module reload
46. project A status shows A result only
47. project B status shows B result only
48. no result artifact -> last completed compaction none
49. local result artifact source/path reported accurately
50. global result artifact source/path reported accurately
51. local/global newer candidate selection reflected in status
52. malformed result JSON does not crash whole status
53. malformed result displays invalid/unavailable diagnostic
54. prompt artifact path/source/size displayed separately
55. queue depth labeled process-local
56. in-flight labeled process-local
57. last idle outcome labeled process-local
58. newest durable model-health row is not labeled future/current selected model

### E. Best-effort persistence observability — 10 cases

59. audit terminal lock timeout warns and returns
60. audit terminal unavailable warns and returns
61. audit terminal commit failure warns and returns
62. audit terminal budget rejection warns and returns
63. audit terminal unexpected throw warns and returns
64. model-health typed failure warns and returns
65. model-health unexpected throw warns and returns
66. warning arbitrary error text is bounded
67. metadata failure does not change heuristic success
68. required audit guard failure still prevents optional LLM prompt

### F. File activity truthfulness — 12 cases

69. completed read -> `reads=1`
70. repeated reads -> correct read count, never edit wording
71. completed edit -> `edits=1`
72. completed write -> `writes=1`
73. grep -> `searches=1`
74. glob -> `searches=1`
75. bash path -> `shell_refs=1` only
76. mixed categories render each nonzero category accurately
77. errored/pending tools do not count as completed activity
78. stable total-count ranking preserves top-N contract
79. current grep-only observation replaces stale prior `edited N times` reason
80. transient activity object is not persisted in `STATE.json`

### G. Cross-PR regression / release — 4 cases

81. PR-7 augment/replace/replacement-anchor tests remain green
82. PR-8 storage/injection budget suites remain green
83. TMTUI commit-pulse tests and bundle check remain green
84. full repository release chain passes on exact implementation head

---

## 14. Oracle attack surface

The independent Oracle should specifically try to break these seams:

### Artifact resolution

- stale local prompt/result vs newer global fallback;
- read-only worktree;
- local permission error + valid global candidate;
- traversal-like artifact names;
- multibyte near-cap diagnostics.

### Compaction truthfulness

- hook fires but compaction later fails: status must not claim completion;
- `session.compacted` event but session history unavailable: completion must still survive;
- summary body must never leak into result JSON;
- result JSON must remain bounded with a hostile/very long host error reason;
- augment vs replace prompt artifacts must record what TokenMaxxer actually supplied.

### Status isolation

- two projects compact in one process in alternating order;
- reload process and query both;
- corrupt one project's result artifact without breaking the other's status;
- process-local queue/model diagnostics must remain explicitly labeled ephemeral.

### G6 best-effort boundary

- terminal/health mutation throws rather than returning a typed failure;
- app.log itself throws;
- metadata warning path cannot alter the primary outcome;
- required audit guard must not accidentally become best-effort.

### File activity

- grep and bash references must never become edits;
- write must not be collapsed into edit;
- pending/error tools must not claim successful activity;
- old generic active-file reason must not override new current-session evidence.

### TMTUI coexistence

- diagnostic artifact writes must not create a green memory pulse;
- failed diagnostic writes must not suppress a successful STATE pulse;
- PR-9 cleanup must not delete or repurpose `.commit-pulse`.

---

## 15. Scope walls

PR 9 does **not**:

- change STATE authority, revision, lock, or budget semantics — PRs 1, 2, 8;
- change decision authority, foundational trust, or human review — PR 3;
- change host peer range or supported tool contract — PR 4;
- change source identity, completion ledger, or idle outcome taxonomy — PR 5;
- widen LLM durable semantic authority — PR 6;
- change compaction preservation policy or augment/replace ownership — PR 7;
- change the 8KB STATE or 4KB durable injection budgets — PR 8;
- redesign TMTUI commit-pulse semantics — separate shipped TMTUI work;
- enforce committed `dist/` parity, release checksums, immutable installer downloads, action upgrades, or dependency remediation — PR 10;
- add a diagnostic LLM grader;
- persist full compaction summaries/conversations merely for diagnostics;
- refactor `writer.ts` or `extract-llm.ts` beyond the narrow PR-9 seams.

---

## 16. Definition of done

PR 9 is complete only when all are true:

1. no process-global last-compaction timestamp/setter remains;
2. successful compaction status comes from persisted per-project result metadata;
3. prompt snapshot and result metadata are distinct artifacts with distinct meanings;
4. both artifacts use project-local/global fallback and survive read-only worktrees;
5. prompt/result artifacts have hard UTF-8 byte ceilings;
6. `session.compacted` completion is recorded even if secondary summary retrieval fails;
7. no full compaction summary/conversation is persisted by the result diagnostic;
8. status survives reload and isolates multiple projects correctly;
9. process-local/process-wide values are labeled as such;
10. best-effort audit terminal/model-health persistence failures emit bounded warnings without changing primary outcomes;
11. required audit guard semantics remain fail-closed;
12. active-file reasons distinguish reads, edits, writes, searches, and shell references without inference;
13. no PR-9 artifact write changes STATE revision or TMTUI commit-pulse behavior;
14. all 84 minimum semantic cases are mapped to tests/evidence;
15. the full release chain is green on the exact final implementation SHA;
16. `docs/CRIP/PR-9/oracle-investigation.md` is published and implementation stops for independent Oracle review.

---

## 17. Luna implementation handoff requirements

`oracle-investigation.md` must record:

- planning baseline and final implementation SHA;
- every wave commit and owning agent;
- exact file list changed by PR 9;
- mapping of all 84 minimum cases to test files/test names;
- confirmation that `lastCompactionTimestamp` / `setLastCompaction` are absent;
- verified OpenCode v1.18.15 `session.compacted` host-event evidence;
- exact artifact byte caps and schemas;
- local/global fallback evidence;
- two-project + reload evidence;
- file-activity category evidence;
- best-effort persistence failure evidence;
- TMTUI non-regression evidence;
- exact CI run/job/SHA and actual passed/skipped counts;
- every release-chain command and result;
- deviations, unresolved concerns, and anything deliberately deferred to PR 10;
- Oracle attack surface from §14.

The handoff is evidence only. Luna must not issue `Ship`, create Oracle findings, or advance PR 10.
