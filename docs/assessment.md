# tokenmaxxer — Revised Codebase Assessment & Implementation Plan

> **Revised:** 2026-08-09
> **Repository:** `thehun927/TokenMaxxer`
> **Reviewed branch:** `main`
> **Assessment baseline commit:** `9c618f36db458537984140c0989d74d5d850bcd4`
> **Verified baseline:** GitHub Actions CI passed; 202/202 tests across 21 files passed; `npx tsc --noEmit` passed; distribution build and bundle checks passed.
>
> This revision validates the original agentic assessment against the actual repository and current OpenCode host contract. It keeps the useful findings, adjusts severity where appropriate, rejects several brittle or unsafe proposed fixes, removes stale/false findings, and adds missing host-compatibility and storage-path issues.

---

## Executive summary

The original assessment was directionally strong: it understood the architecture well and found several real correctness bugs. It should **not**, however, be implemented verbatim.

The highest-value confirmed issues are:

1. **C1 — global fallback memory is not read back correctly.** This is a durability bug and should be fixed first.
2. **G3 — `head_files` depends on a `client` field that is not part of `ToolContext`.** The diagnosis is correct, but the original proposal to replace the host file API with raw `fs.readFile` should be rejected.
3. **G5 — `markReferencedDecisions` marks every valid decision as recently used after any `recall_decision` call.** This directly damages compaction relevance.
4. **C2 — unexpected pre-persistence failures are reported as `heuristic-only`.** This makes successful fallback indistinguishable from a failed idle transaction.
5. **G4 — the compaction durable block has no explicit output budget.** It relies indirectly on the STATE.json storage cap instead of directly bounding the injected context.

The original assessment also contains several quality-control problems:

- Its headline finding counts do not match its own tables.
- It states that no CI workflow exists even though `.github/workflows/ci.yml` already exists and passed on the assessment commit.
- It overstates the severity of several diagnostic or presentation issues.
- It proposes brittle output-regex parsing for G5 even though structured tool input is already retained in transcript parts.
- It proposes raw filesystem access for G3, unnecessarily creating a second file-access implementation outside the OpenCode client boundary.
- It proposes adding a new durable compaction timestamp field even though `last_compaction.log` already persists that information per project.

### Revised finding status

| Code | Status | Revised severity | Summary |
|---|---|---:|---|
| **C1** | CONFIRMED — fix design revised | **Critical / High** | Global fallback writes can become unreadable or stale relative to a local file. |
| **C2** | CONFIRMED — severity adjusted | **High** | Pre-heuristic exceptions are mislabeled `heuristic-only`; post-persist LLM exceptions also need distinct semantics. |
| **G3** | CONFIRMED — proposed fix rejected | **High** | `ToolContext` has no `client`; close over the plugin client rather than switching to raw fs. |
| **G4** | CONFIRMED — reframed | **High** | Durable block lacks an explicit injected-context budget; STATE.json's 8 KB cap is only an indirect bound. |
| **G5** | CONFIRMED — proposed fix rejected | **High** | Any recall marks all valid decisions as recent. Re-run `queryDecisions` from structured tool input instead of parsing output text. |
| **G6** | CONFIRMED — impact overstated | **Medium** | Audit/health persistence failures are not surfaced, but these paths are intentionally best-effort. |
| **G7** | CONFIRMED — severity adjusted | **Medium** | Read/search activity is mislabeled as editing. |
| **H1** | CONFIRMED — severity adjusted | **Low** | Nullable test/reset mismatch in `setLastCompaction`. |
| **G8** | CONFIRMED — proposed fix simplified | **Medium** | Process-global last-compaction state is wrong, but existing `last_compaction.log` can be the durable source. |
| **N1** | NEW | **High** | `@opencode-ai/plugin >=1.0.0 <2.0.0` claims support for 1.0.x, whose `ToolContext` did not expose `directory`/`worktree`. |
| **N2** | NEW, coupled to C1 | **Medium** | `tokenmaxxer_status` reconstructs the local STATE path and size, so it will misreport memory stored in the global fallback. |
| **N3** | NEW | **Medium** | Unit mocks do not enforce the real host `ToolContext` contract; G3 is evidence of mock-fidelity failure. |
| **N4** | NEW | **Medium** | `dist/` is committed/published but CI does not fail if committed build artifacts are stale relative to source. |
| **N5** | NEW / separate review | **Medium** | Current CI's `npm ci` reports dependency audit findings; investigate separately rather than using `npm audit fix --force`. |
| CI missing | **FALSE / STALE** | — | `.github/workflows/ci.yml` exists and passes. |

---

## 1. Project context and architecture

TokenMaxxer is an OpenCode plugin providing two durable context layers:

- **Layer 1 — compaction quality:** replaces or augments the compaction prompt with a durable project-state block.
- **Layer 2 — cross-session memory:** writes a per-project `STATE.json` on `session.idle`, exposes explicit recall/status tools, and optionally corroborates heuristic facts using an LLM.

The overall architecture is sensible:

```text
src/
├── index.ts                    plugin wiring / hooks
├── config.ts                   environment-driven options
├── types.ts                    shared host/transcript types
├── tui.tsx                     right-side activity indicator
├── util/
│   ├── fs.ts                   atomic read/write primitives
│   ├── git.ts                  current SHA lookup
│   └── log.ts                  bounded host logging
├── compaction/
│   ├── prompt.ts               compaction prompt
│   └── durable.ts              durable-state renderer
├── memory/
│   ├── schema.ts               v3 durable schema
│   ├── migrate.ts              v1 -> v2 -> v3 migration
│   ├── store.ts                STATE.json storage/cache
│   ├── writer.ts               idle extraction + merge + prune
│   ├── extract-llm.ts          optional LLM extraction
│   ├── extract-prompt.ts       canonical extraction input
│   ├── extract-schema.ts       structured extraction schema
│   ├── llm-adapter.ts          host client compatibility boundary
│   ├── provider-inventory.ts   automatic model discovery
│   ├── reader.ts               memory queries
│   ├── lock.ts                 per-project serialization
│   ├── activity-state.ts       TUI activity state
│   └── memory-size.ts          byte accounting
└── tools/
    ├── recall.ts               recall/project-state/promotion tools
    ├── efficiency.ts           preview_compaction + head_files
    └── status.ts               tokenmaxxer_status
```

### What is already strong

These parts should be preserved while fixing the defects below:

- Atomic temp-file + rename persistence.
- Corrupt-file backup and migration rather than blind overwrite.
- 8 KB hard STATE.json storage invariant.
- Explicit provenance and evidence digests rather than persisted source text.
- Opt-in LLM extraction with heuristic persistence first.
- One retry budget for structured LLM extraction.
- Per-project queue serialization and tail-poisoning protection.
- Strict runtime schema validation at persistence boundaries.
- Localized host compatibility code in `llm-adapter.ts` instead of SDK casts spread throughout the memory layer.
- Explicit pull tools instead of unconditional memory injection into the composer.
- CI that runs tests, type checking, build verification, bundle self-containment checks, and installer syntax checks.

Two files remain oversized for comfortable maintenance:

| File | Approx. size | Recommendation |
|---|---:|---|
| `src/memory/writer.ts` | ~1,600 LoC | Split only after correctness fixes land. |
| `src/memory/extract-llm.ts` | ~1,100 LoC | Split by model selection, request lifecycle, evidence/cache, and health after behavior is stable. |

This refactor is useful but should not compete with the correctness work below.

---

## 2. Confirmed correctness findings

## 2.1 C1 — global fallback storage is not a complete read/write abstraction

**Severity:** Critical / High  
**Files:** `src/memory/store.ts`, `src/tools/status.ts`

### Current behavior

`writeMemory()`:

1. attempts `<project>/.opencode/memory/STATE.json`;
2. if that write fails, writes `~/.config/opencode/memory/<project-hash>/STATE.json`;
3. returns success if the global write succeeds.

`readMemory()` only reads the project-local path.

Therefore a successful fallback write is currently not durable from the reader's perspective.

### Additional stale-local scenario missed by the original assessment

The original proposed fix was:

> use global only when the project-local file does not exist; if both exist, project-local wins.

That is insufficient.

Example:

1. Local STATE exists at T1.
2. The worktree later becomes read-only.
3. A new idle transaction successfully writes global STATE at T2.
4. Local T1 and global T2 now both exist.
5. A reader that always prefers local will return stale T1 forever.

The storage layer therefore needs **candidate resolution**, not merely a one-way fallback.

### Recommended design

Introduce a single internal resolver that is used by both memory reads and diagnostics:

```ts
interface MemoryLocationCandidate {
  kind: "project" | "global"
  path: string
  mtime: number | null
}

interface ResolvedMemoryLocation {
  selected: MemoryLocationCandidate | null
  project: MemoryLocationCandidate
  global: MemoryLocationCandidate
}
```

Resolution policy:

1. Stat both candidates.
2. If neither exists: no memory.
3. If exactly one exists: use it.
4. If both exist: use the candidate with the newer file mtime.
5. On an exact mtime tie: prefer project-local deterministically.
6. Parse/migrate the selected candidate as today.

The cache must include enough identity to notice when the other candidate becomes newer. Caching only `{ selectedPath, selectedMtime }` is not sufficient if the selected local file is unchanged but a newer global file appears.

For example:

```ts
interface MemoryCacheEntry {
  mem: MemoryFile | null
  selectedPath: string | null
  projectMtime: number | null
  globalMtime: number | null
}
```

A cache hit is valid only when both current candidate mtimes still match the cached pair.

### Status coupling — N2

`tokenmaxxer_status` currently reconstructs:

```text
<project>/.opencode/memory/STATE.json
```

and `safeRead()`s it separately for byte size.

After C1 is fixed, status would still report the wrong path/size whenever the selected state lives globally.

Do not make status rediscover storage rules. Expose metadata from the store, for example:

```ts
interface MemoryReadResult {
  memory: MemoryFile | null
  source: "project" | "global" | null
  path: string | null
  sizeBytes: number
}
```

`readMemory()` can remain as a compatibility wrapper if desired, while a richer internal `readMemoryState()` feeds status.

### Required tests

Add real-fs tests using temporary directories:

1. Global-only state is readable.
2. Local-only state is readable.
3. If both exist and global is newer, global wins.
4. If both exist and local is newer, local wins.
5. Equal mtimes deterministically prefer local.
6. Cache invalidates when global appears after a cached local read.
7. Cache invalidates when local becomes newer than previously selected global.
8. Corrupt global candidate is backed up when it is selected.
9. `tokenmaxxer_status` reports the selected path and selected file size.
10. Simulated local write failure -> global write success -> next read returns the new state.

Do **not** encode "project always wins when both exist" as a test; that is the stale-state bug described above.

---

## 2.2 C2 — idle failures are semantically collapsed into `heuristic-only`

**Severity:** High  
**File:** `src/memory/writer.ts`

`writeMemoryOnIdleSerialized()` has a broad outer catch that returns `"heuristic-only"`.

This collapses two materially different outcomes:

```text
Heuristic memory persisted; LLM intentionally disabled/unavailable
    -> heuristic-only

Unexpected throw before heuristic memory was persisted
    -> heuristic-only   (incorrect)
```

The original assessment correctly found this but rated it Critical. High is a better fit: it hides a failed transaction and breaks observability, but does not by itself overwrite or corrupt existing durable state.

### Recommended outcome semantics

Retain the current outcome vocabulary but make stages explicit:

```text
no transcript / missing endpoint        -> no-messages
heuristic write returned false          -> write-failed
unexpected throw before heuristic write -> error
LLM deliberately disabled/unavailable   -> heuristic-only
valid LLM cache reused                   -> cache-hit
LLM completed successfully              -> llm-success
LLM attempted and failed/threw           -> llm-failed
project queue failed                     -> queue-failed
```

Track whether heuristic persistence completed:

```ts
let heuristicPersisted = false
```

and log bounded error metadata in the catch.

Do not automatically map every post-persistence exception to `heuristic-only`. If LLM work was actually attempted and then threw, `llm-failed` is the more truthful outcome while preserving the guarantee that heuristic memory is durable.

### Required tests

- `session.messages` throws before persistence -> `error`.
- extraction/merge throws before persistence -> `error`.
- `writeMemory` returns false -> `write-failed`.
- LLM disabled -> `heuristic-only`.
- LLM unavailable without an attempted request -> `heuristic-only`.
- LLM request path throws after heuristic persistence -> `llm-failed`.
- status/queue records the exact final outcome.
- error logs include session ID + whether heuristic persistence completed, but not transcript content.

---

## 2.3 G3 — `head_files` depends on a nonexistent `ToolContext.client`

**Severity:** High  
**Files:** `src/tools/efficiency.ts`, `src/index.ts`

### Diagnosis

The inner helper expects:

```ts
context.client.file.read(...)
```

and the tool wrapper creates that property with:

```ts
client: (context as any).client
```

The cast suppresses the TypeScript error, but `client` is not part of the plugin `ToolContext` contract.

Current OpenCode custom-tool registration explicitly constructs tool context from the runtime tool context and adds `directory` and `worktree`; it does not inject the plugin SDK client. The plugin initialization object, however, does contain `client`.

Relevant upstream references:

- Current custom tool bridge: `https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/registry.ts`
- Plugin initialization context: `https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/index.ts`

### Reject the original raw-fs fix

The original assessment proposed replacing `client.file.read()` with direct `node:fs/promises.readFile()` and even accepting absolute paths.

Do **not** make that change unless there is a deliberate security/design decision to create an independent filesystem access layer.

Reasons:

- It duplicates host file-access behavior.
- It introduces separate path traversal / external-directory / symlink decisions.
- It changes binary/error behavior.
- It creates a second model-callable path to local files outside the OpenCode client boundary.
- It expands the amount of code TokenMaxxer must secure and maintain.

### Recommended fix

Close over the legitimate plugin client:

```ts
export function registerEfficiencyTools(client: unknown) {
  return {
    tool: {
      head_files: tool({
        // ...
        async execute(args, context) {
          return _headFiles(args, {
            worktree: context.worktree,
            directory: context.directory,
            client,
          })
        },
      }),
    },
  }
}
```

and in `src/index.ts`:

```ts
...registerEfficiencyTools(client)
```

Keep `_headFiles()` using the host client file endpoint.

Also remove every `(context as any).client` cast from tool wrappers.

### Required tests

1. Register the actual tool wrapper with a client supplied through the registration closure.
2. Construct execution context using only the real `ToolContext` fields required by the installed plugin version.
3. Assert `head_files` succeeds without a `context.client` property.
4. Assert `preview_compaction` receives the closed-over plugin client for logging.
5. Add bounds for `paths` and `lines` at the tool schema boundary.

This should be a **host-contract test**, not another mock that invents fields the runtime does not provide.

---

## 2.4 G4 — durable compaction output lacks an explicit budget

**Severity:** High  
**Files:** `src/compaction/durable.ts`, `src/memory/schema.ts`, `src/memory/writer.ts`

The original assessment described the durable block as "partially unbounded." That is directionally correct but imprecise.

STATE.json has an 8 KB hard storage limit and `pruneOld()` progressively reduces durable data when that limit is exceeded. Therefore the durable block is not mathematically unbounded by disk state.

The real problem is:

> **The compaction block has no explicit output budget of its own and relies indirectly on the storage budget.**

That is weaker than the project's stated goal of controlling context consumption.

### Recommended design

Define an injected-context budget directly in the compaction layer:

```ts
export const DURABLE_BLOCK_MAX_BYTES = ...
```

or a conservative character/token proxy if byte count is not the desired metric.

Render by priority until the budget is exhausted:

1. Project identity / last update.
2. Current task.
3. Blockers.
4. Next steps.
5. Active files.
6. Foundational decisions.
7. Recently referenced decisions.
8. Older fallback decisions.

Use per-section caps as defense in depth, not as the primary definition of "bounded."

For example:

```text
current task: bounded length
blocker item: bounded length + bounded count
next step item: bounded length + bounded count
active files: existing count cap
foundational injected: bounded count
recent injected: bounded count
older injected: existing top-N behavior
final rendered block: hard total budget
```

### Do not delete durable foundational decisions solely because injection is capped

The original proposal adds pruning that would discard foundational decisions once more than 20 exist.

That conflates two independent budgets:

- **what remains durable and recallable**;
- **what is automatically injected at compaction**.

Prefer limiting the number automatically rendered while retaining older foundational decisions for explicit recall until the existing STATE.json byte budget actually requires pruning.

### Migration

If schema-level item limits are added, migration should truncate legacy over-limit fields rather than reject the whole file and trigger corrupt recovery.

Any normalization should be deterministic and tested.

### Required tests

- The final rendered durable block never exceeds its declared output budget.
- High-priority sections survive before lower-priority sections.
- Large blockers/next steps cannot monopolize the block.
- Hundreds of foundational decisions do not create hundreds of injected lines.
- Non-injected foundational decisions remain in STATE.json and are recallable.
- Migration safely normalizes legacy over-limit values without resetting the memory file.

---

## 2.5 G5 — recall marks all decisions as recently referenced

**Severity:** High  
**Files:** `src/memory/writer.ts`, `src/memory/reader.ts`

Current behavior:

```text
if any transcript part is tool=recall_decision
    mark every still-valid decision.last_used_in_session = current session
```

That destroys the signal used by the durable block to distinguish decisions actually reused in a recent session from unrelated older decisions.

### Reject the original output-regex parser

The original proposal parses the formatted model-visible output:

```text
topic: decision (SHA ..., timestamp)
```

with a regex and then matches `(topic, timestamp)`.

That is unnecessarily brittle because transcript tool parts already retain structured `state.input`, and `recall_decision` already uses the canonical `queryDecisions(mem, query, limit)` helper.

### Recommended fix

For each completed `recall_decision` transcript part:

1. Read `part.state.input.query` and `part.state.input.limit`.
2. Re-run `queryDecisions()` against the same pre-merge memory snapshot.
3. Collect the returned decision IDs.
4. Mark only those IDs as `last_used_in_session = sessionId`.
5. Return a new memory/decision array rather than mutating unrelated decisions in place.

Sketch:

```ts
function recalledDecisionIds(
  mem: MemoryFile,
  messages: TranscriptMessage[],
): Set<string> {
  const ids = new Set<string>()

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.tool !== "recall_decision") continue
      if (part.state?.status && part.state.status !== "completed") continue

      const input = part.state?.input ?? {}
      const query = typeof input.query === "string" ? input.query : undefined
      const limit = typeof input.limit === "number" ? input.limit : 10

      for (const decision of queryDecisions(mem, query, limit)) {
        ids.add(decision.id)
      }
    }
  }

  return ids
}
```

This keeps recall semantics tied to the actual selection implementation instead of a presentation format.

### Caveat

Re-running the query assumes the memory snapshot at idle is equivalent to the memory used when recall executed. In the current serialized project flow this is a better and more deterministic contract than parsing formatted output. If exact historical result identity becomes necessary, add structured non-display metadata to the tool result rather than coupling to human-readable text.

### Required tests

- One recall returning 2 of 5 decisions marks exactly those 2.
- Multiple recalls union their selected IDs.
- Failed/incomplete recall tool parts mark none.
- Same topic with different decision IDs does not over-mark.
- Output formatting can change without breaking marking.
- Decisions not selected retain object/value identity where practical.

---

## 3. Confirmed medium/low findings

## 3.1 G6 — audit and health persistence failures are not surfaced

**Revised severity:** Medium

`persistTerminal` and `onHealthOutcome` await `writeMemory()` but ignore its boolean return.

This is worth diagnosing, but the original impact statement is too strong. These are intentionally best-effort operational metadata paths, and extraction callbacks are designed not to poison heuristic fallback.

Add warning diagnostics when persistence returns `false`, but do not describe a warning log itself as full recovery.

Also correct the original statement that a pending audit necessarily causes "every reload" to re-enter and burn tokens. Persisted audit IDs are used to suppress processing retained extraction sessions, and stale pending audits are reclassified during pruning.

Recommended behavior:

```text
persist false -> bounded warn log
persist true  -> no warning
extraction result semantics unchanged
```

A more advanced retry/escalation policy can be considered later if real-world failures justify it.

---

## 3.2 G7 — active-file reason mislabels reads as edits

**Revised severity:** Medium

`extractActiveFiles()` combines `read`, `edit`, `write`, `glob`, `grep`, and shell-derived paths into one count and renders counts >1 as `edited N times`.

This is incorrect user/model-facing state.

Track operation categories separately. Prefer at least:

```ts
type FileActivity = {
  reads: number
  edits: number
  writes: number
  searches: number
  shellRefs: number
}
```

Suggested rendering:

```text
edited 2x, written 1x, read 3x, searched 4x, shell-referenced 1x
```

Do not classify all `bash` references as reads. A shell reference may represent a read, write, rename, delete, build input, or simply a textual path argument. Label it as a shell reference unless command semantics are deliberately parsed.

---

## 3.3 H1 — `setLastCompaction` type/reset mismatch

**Revised severity:** Low

The module state is `string | null` while `setLastCompaction` accepts only `string`, forcing an awkward test cast.

If G8 is implemented as recommended below, remove this process-global state entirely and H1 disappears with it. Do not ship a standalone PR for this unless G8 is deferred.

---

## 3.4 G8 — last compaction is process-global

**Revised severity:** Medium

`lastCompactionTimestamp` is module-level state:

- it is shared across projects in one process;
- it resets on plugin/module reload.

The original assessment proposes adding `last_compaction_at` to `MemoryFile` and performing another STATE write inside the compaction hook.

That works, but it is unnecessary.

### Preferred solution: use the existing per-project `last_compaction.log`

`src/index.ts` already atomically writes:

```text
<project>/.opencode/memory/last_compaction.log
```

after each compaction.

Make this existing file the status source of truth:

- remove module-level `lastCompactionTimestamp`;
- remove `setLastCompaction`;
- parse or stat `last_compaction.log` in `tokenmaxxer_status`;
- report `none` if absent.

Benefits:

- already per-project;
- survives reload;
- no schema migration;
- no extra STATE write;
- no new queue contention during compaction;
- no duplicate representation of the same fact.

If a structured timestamp becomes useful to other memory consumers later, adding it to STATE can be reconsidered then.

---

## 4. New findings missed by the original assessment

## 4.1 N1 — declared OpenCode plugin compatibility is too broad

**Severity:** High until the minimum compatible version is established  
**File:** `package.json`

Current peer range:

```json
"@opencode-ai/plugin": ">=1.0.0 <2.0.0"
```

TokenMaxxer relies on custom `ToolContext.directory` and `ToolContext.worktree`.

OpenCode issue #10477 documents that 1.0.x custom tool context did **not** expose those fields. Current OpenCode source does add them when bridging plugin tools.

Reference:

`https://github.com/anomalyco/opencode/issues/10477`

Therefore TokenMaxxer appears to claim support for host versions that cannot satisfy its runtime contract.

### Recommended fix

Determine the **oldest actually compatible** OpenCode/plugin release and make that the lower peer bound.

Do not assume the devDependency version (`1.18.15`) is necessarily the exact minimum unless tested. A safe short-term choice is to set the minimum to the oldest version explicitly verified by CI/manual host testing.

Add a compatibility CI matrix for:

- oldest supported 1.x;
- the currently pinned/tested version;
- optionally latest compatible 1.x on a non-blocking or scheduled job if upstream churn is high.

This is especially important because G3 shows that local unit mocks can pass while the host API contract is wrong.

---

## 4.2 N2 — status must report the effective memory location

**Severity:** Medium  
**Files:** `src/tools/status.ts`, `src/memory/store.ts`

This is part of the C1 design, but it deserves an explicit finding because fixing `readMemory()` alone leaves diagnostics wrong.

`tokenmaxxer_status` currently:

1. calls `readMemory()`;
2. separately constructs the project-local path;
3. separately reads it for byte size.

If the store selects global memory, status can simultaneously display the correct memory contents and the wrong file path/size.

Fix this by moving storage-location metadata behind the store abstraction and consuming that metadata in status.

---

## 4.3 N3 — tool tests do not enforce host-context fidelity

**Severity:** Medium  
**Files:** `test/tools/*`

The test suite is broad, but G3 survived because the `_headFiles` test double supplied a `client` field that the actual tool context does not provide.

Add at least one test at the registered-tool boundary using the real installed `ToolContext` type shape.

Policy recommendation:

> Do not add fields to host context mocks that are not in the installed host type. Any compatibility escape hatch should be isolated at a named adapter boundary, not hidden behind `(context as any)` in a tool wrapper.

A release smoke test in a real OpenCode process should also be added for all exported tools.

---

## 4.4 N4 — committed distribution parity is not enforced

**Severity:** Medium  
**Files:** `.github/workflows/ci.yml`, `dist/`

`package.json` publishes `dist/index.js` / `dist/tui.js`, and `dist/` is committed.

CI builds the distribution and checks that bundles are non-empty/self-contained, which is good, but it does not currently fail when the freshly built output differs from committed `dist/`.

If committed `dist/` remains part of the repository, add after `npm run build`:

```bash
git diff --exit-code -- dist/
```

Otherwise stop committing `dist/` and build it only for package/release publication. Pick one source-of-truth strategy and enforce it.

---

## 4.5 N5 — dependency/security audit deserves a separate pass

**Severity:** Medium triage item, not yet a code vulnerability finding

The latest CI run for the assessment commit completed successfully but `npm ci` reported dependency audit findings, including high/critical severities.

This assessment did not inspect the vulnerable package graph or exploitability, so do not turn that console summary directly into a TokenMaxxer vulnerability claim.

Recommended follow-up:

1. Run `npm audit --json` locally/CI.
2. Identify direct vs transitive packages.
3. Determine whether vulnerable code ships in `dist` or is dev-only.
4. Upgrade targeted packages where safe.
5. Do **not** blindly run `npm audit fix --force`.

Also revise the old scope language that described the plugin as having "no network surface." TokenMaxxer is local-first, but optional extraction calls the OpenCode client/model/session APIs and model-callable file tools cross a meaningful trust boundary.

---

## 5. Medium maintainability findings retained from the original review

The following are useful cleanup findings but should follow the correctness work:

| Item | Assessment |
|---|---|
| Repeated construction of decision regex | Minor optimization/readability. Hoist if it improves clarity. |
| `COMMON_WORDS` Set allocated per call | Minor optimization. Hoist to module scope. |
| `stripCodeBlocks` misses indented code blocks | Real heuristic-quality issue; add fixtures before changing behavior. |
| Duplicated file-path extraction/normalization | Worth consolidating after G7 so one canonical implementation remains. |
| `evidence_refs` optional in TS but required by runtime refinement | Real type/runtime mismatch; clean up after the extraction compatibility path is understood. |
| LLM cache construction type uses legacy facts type | Same type-boundary cleanup as above. |
| Cached host-health gate lifetime | Needs behavior-focused test before changing; not proven production bug from static inspection alone. |
| Multiple `pruneOld()` deep clones per LLM flow | Performance/readability issue; optimize only with benchmarks or clear simplification. |
| Dead `typeof resolveProjectPath === "function"` guard | Remove. Production import is statically known. |
| `context.sessionId` fallback | Remove if installed host type confirms only `sessionID`. |
| `registerTools(_ctx)` unused arg | Remove or use only if needed for a closure-based host dependency later. |
| Provenance formatting duplicated | Extract one formatter after behavioral changes stabilize. |
| Hand-maintained JSON Schema mirrors Zod | Drift risk; consider schema generation if it remains compatible with the host structured-output API. |
| Heuristic active files replace cross-session set | Design question, not obviously a bug; document intended semantics before changing. |
| `TRANSCRIPT_WINDOW = 50` | Product tradeoff; document and test rather than calling it inherently wrong. |
| Tool argument bounds | Add explicit max/min bounds for `limit`, `lines`, and `paths`. |
| README `Bun.$` claim | Correct documentation if implementation is `child_process` only. |
| Early `HEADER.md` placeholder creation | Cleanup/product behavior; lower priority. |
| Large writer/extractor files | Refactor after correctness fixes. |
| `verbatimModuleSyntax` | Optional TypeScript hygiene; not a reliability finding by itself. |

---

## 6. False, stale, or corrected statements from the original assessment

### 6.1 "No CI workflow exists" — false

`.github/workflows/ci.yml` exists and currently performs:

- checkout;
- Node setup;
- `npm ci`;
- full Vitest suite;
- `npx tsc --noEmit`;
- `npm run build`;
- bundle self-containment checks;
- `bash -n install.sh`.

The assessment commit itself passed this workflow.

Remove the original HIGH finding that CI is absent.

### 6.2 Finding counts were internally inconsistent

The original header claimed "seven HIGH" and "eight MEDIUM" findings, while its own table and assessment commit message described different totals.

Do not preserve headline counts unless generated from the actual final table.

### 6.3 Repository visibility statement is stale

The original assessment says the repository is private. At the time of this revision the connected GitHub repository reports `visibility: public`.

Distribution/install behavior should be tested against current repository/package state rather than preserving the old private-repository conclusion.

### 6.4 "Local-only, no network surface" is too broad

The plugin is local-first and does not expose its own network server, but optional LLM extraction uses the OpenCode client/model/session path. Security review should therefore include host API trust boundaries, model-callable tools, file access, logs, and package dependencies.

---

## 7. Revised implementation plan

The original five-PR plan mixed correctness, schema changes, presentation cleanup, and questionable remediations. Use the following order instead.

## PR 1 — storage correctness and observability

**Fix:** C1 + N2

Files likely touched:

- `src/memory/store.ts`
- `src/tools/status.ts`
- `test/memory/store.test.ts` (new or expanded)
- `test/tools/status.test.ts`

Deliverables:

- resolve project/global candidates by freshness;
- cache both candidate mtimes;
- expose selected storage metadata;
- status reports actual selected path/size;
- regression test for **stale local + newer global**.

This is the most important PR because it protects the core durability promise.

---

## PR 2 — OpenCode host-contract correctness

**Fix:** G3 + N1 + N3 + tool bounds

Files likely touched:

- `src/tools/efficiency.ts`
- `src/index.ts`
- `package.json`
- `test/tools/efficiency.test.ts`
- CI compatibility configuration if practical

Deliverables:

- `registerEfficiencyTools(client)` closes over plugin client;
- remove `(context as any).client`;
- retain host `client.file.read` behavior;
- constrain `head_files.paths` and `head_files.lines`;
- set peer lower bound to the oldest verified compatible OpenCode plugin version;
- registered-tool test uses a real `ToolContext` shape.

Do **not** introduce raw unrestricted filesystem reading as the default fix.

---

## PR 3 — recall relevance correctness

**Fix:** G5

Files likely touched:

- `src/memory/writer.ts`
- `src/memory/reader.ts` only if helpers need exporting/refactoring
- `test/memory/writer.test.ts`

Deliverables:

- reconstruct recalled decisions from structured `state.input` using `queryDecisions`;
- mark exact decision IDs;
- no parser for formatted output strings;
- multiple-recall and same-topic regression tests.

---

## PR 4 — truthful idle outcomes

**Fix:** C2

Files likely touched:

- `src/memory/writer.ts`
- `test/memory/writer-llm.test.ts`
- possibly queue/status assertions

Deliverables:

- `error` for unexpected pre-persist failures;
- `llm-failed` when LLM work actually attempted and fails after heuristic persistence;
- `heuristic-only` reserved for intentional/no-model heuristic fallback;
- bounded diagnostic log with stage/persistence state.

---

## PR 5 — compaction output budget

**Fix:** G4

Files likely touched:

- `src/compaction/durable.ts`
- `src/memory/schema.ts` if item-level limits are added
- `src/memory/migrate.ts` for safe normalization
- related compaction/schema/migration tests

Deliverables:

- explicit durable block total budget;
- prioritized rendering;
- per-section defense-in-depth caps;
- no unconditional deletion of older foundational decisions merely because injection is capped;
- migration truncates legacy over-limit strings/arrays safely.

---

## PR 6 — status + quality cleanup

**Fix:** G8 + H1 + G7 + G6

Deliverables:

- last compaction read from existing `last_compaction.log`;
- delete process-global last-compaction state and setter;
- correct active-file operation labels;
- warn on failed audit/health metadata writes;
- update tests.

H1 disappears naturally when the setter is removed.

---

## PR 7 — build/dependency hygiene

**Fix:** N4 + N5 and low-risk cleanup

Deliverables:

- either enforce committed `dist/` parity with `git diff --exit-code -- dist/` or stop committing build output;
- audit dependency findings deliberately;
- correct README stale implementation claims;
- remove dead compatibility guards/unused parameters;
- optionally hoist constant Sets/regexes.

---

## 8. Test and verification strategy

The current 202-test suite is a strong base, but the missing dimension is **host fidelity**.

### 8.1 Required automated checks on every PR

```bash
npm ci
npm test
npx tsc --noEmit
npm run build
bash -n install.sh
```

If `dist/` remains committed:

```bash
git diff --exit-code -- dist/
```

### 8.2 Storage proof tests

Required for C1/N2:

| Scenario | Expected |
|---|---|
| no local, no global | no memory |
| local only | local selected |
| global only | global selected |
| local older, global newer | global selected |
| global older, local newer | local selected |
| equal mtimes | deterministic local selection |
| selected global changes | cache invalidates |
| non-selected global becomes newest | cache invalidates and switches source |
| selected local corrupt | corrupt backup + defined recovery behavior |
| selected global corrupt | corrupt backup + defined recovery behavior |
| status with global source | path and byte size show global file |

### 8.3 Host-contract tests

At least one test should exercise the actual registered tool wrapper, not only inner helpers.

The context object must be assignable to the installed `ToolContext` type and must not invent `client`.

Also add a static review rule: no `(context as any).client` in tool registration code.

### 8.4 Real OpenCode smoke test

Before release, run a built install in a real OpenCode session and verify:

1. `tokenmaxxer_status`
2. `head_files`
3. `preview_compaction`
4. `get_project_state`
5. `recall_decision`
6. `recall_promote`
7. one `session.idle` memory write
8. one compaction hook
9. plugin reload followed by status/recall
10. a project where local memory is intentionally unwritable and global fallback is exercised

This should become a repeatable release checklist or integration test. G3 demonstrates that passing unit tests alone is not sufficient for host API compatibility.

### 8.5 Supported-version verification

Once the minimum OpenCode plugin version is chosen:

- run typecheck/tests against that minimum;
- run at least the host-contract smoke test against it;
- run the same against the normal pinned/current supported version.

Do not claim `>=1.0.0` support without proving that contract.

---

## 9. Risk notes

### Storage resolver

Choosing the newest candidate by mtime is safer than unconditional project-path preference, but it makes filesystem timestamp behavior part of source selection. Keep tie-breaking deterministic and test rapid successive writes. If a later design needs stronger ordering, persist a monotonic revision/generation inside the memory format and compare that before mtime.

### Host client closure

Closing over the plugin client couples tool registration to `TokenmaxxerPlugin`, which is appropriate: the client is legitimately part of plugin initialization state. Keep it typed through a small interface or `PluginInput["client"]` if importing that type is stable.

### Recall reconstruction

Re-running `queryDecisions()` from transcript input is much safer than output regex parsing, but exact historical result identity could differ if memory changed between the tool call and idle processing. Current project serialization reduces this risk. If exact identity later matters, include machine-readable result IDs in structured metadata rather than in display text.

### Durable output budget

A hard byte/character budget can truncate lower-priority content. That is the intended tradeoff; ensure explicit recall remains available for omitted decisions. The budget should be documented as an injection policy, not a storage-retention policy.

### Dependency audit

Audit severity alone does not prove exploitability. Separate dev-only packages from shipped/runtime packages before prioritizing upgrades.

---

## 10. Assumptions and limits of this revision

This revision validated the repository structure, current source for the major findings, the assessment document itself, the GitHub Actions workflow/run, and the current OpenCode host contract relevant to custom tool context.

It did **not** perform:

- a live OpenCode runtime session;
- a real LLM extraction request;
- dependency-vulnerability exploitability analysis;
- performance benchmarking;
- fuzzing of migration/state parsing;
- a full security audit of all model-callable surfaces.

Therefore findings such as C1, C2, G3, G4, G5, G7, G8 and the CI/document inconsistencies are code-level confirmed, while dependency/security implications should be treated as follow-up triage until separately tested.

---

## Appendix A — Current CI reality

`.github/workflows/ci.yml` currently runs on pushes and pull requests to `main` and performs:

```text
npm ci
npm test
npx tsc --noEmit
npm run build
bundle self-containment verification
bash -n install.sh
```

For assessment commit `9c618f36db458537984140c0989d74d5d850bcd4`, GitHub Actions completed successfully with:

```text
21 test files passed
202 tests passed
TypeScript check passed
Build passed
Bundle verification passed
Installer syntax passed
```

The previous assessment statement that CI did not exist is removed.

---

## Appendix B — Upstream OpenCode contract references

The compatibility findings above rely on these upstream references:

- Current custom plugin tool bridge:  
  `https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/registry.ts`
- Current plugin initialization/client context:  
  `https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/index.ts`
- Historical 1.0.x ToolContext missing project directory/worktree:  
  `https://github.com/anomalyco/opencode/issues/10477`
- Current built-in read-tool implementation, useful when comparing file-access semantics:  
  `https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/read.ts`

These should be rechecked when changing the supported OpenCode version range because upstream contracts can evolve.

---

## Final recommendation

Do not hand the old implementation plan directly to an implementation agent.

The revised priority is:

```text
1. Fix storage source resolution + status path reporting.
2. Fix the OpenCode tool/client boundary and supported-version claim.
3. Fix exact recall-reference tracking.
4. Make idle outcomes truthful.
5. Add an explicit compaction output budget.
6. Clean up status/activity/audit diagnostics.
7. Refactor large files and lower-priority hygiene afterward.
```

That sequence addresses the durability and host-contract risks first while preserving the strongest parts of the existing architecture.
