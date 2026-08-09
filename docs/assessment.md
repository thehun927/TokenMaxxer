# tokenmaxxer — Codebase Assessment & Implementation Plans

> **Date:** 2026-08-09
> **Scope:** Whole-codebase review of the tokenmaxxer opencode plugin
> **Baseline:** `npx tsc --noEmit` clean · `npm test` 202/202 passing (1.74s, 21 files)
> **Output:** One CRITICAL memory bug cluster, one CRITICAL tool bug, seven HIGH findings, eight MEDIUM findings, plus a sequenced 5-PR implementation plan

---

## Table of contents

1. [Process and methodology](#1-process-and-methodology)
2. [Project context](#2-project-context)
3. [Code quality — overall assessment](#3-code-quality--overall-assessment)
4. [Findings — full list](#4-findings--full-list)
5. [Critical bugs — code designs (Plan 1)](#5-critical-bugs--code-designs-plan-1)
6. [High-priority cluster — code designs (Plan 2)](#6-high-priority-cluster--code-designs-plan-2)
7. [Test specifications](#7-test-specifications)
8. [Sequencing and migration](#8-sequencing-and-migration)
9. [Verification matrix](#9-verification-matrix)
10. [Effort estimates and top risks](#10-effort-estimates-and-top-risks)
11. [Assumptions and limits](#11-assumptions-and-limits)

---

## 1. Process and methodology

This document is the result of a structured, multi-stage review of the tokenmaxxer opencode plugin. The methodology was chosen for a small, complex, safety-critical codebase where incorrect findings could lead to silent data loss or broken runtime tools.

### 1.1 Stages

| Stage | What | Who | Output |
|---|---|---|---|
| 1. Orchestrator recon | Read intent docs, entry files, utilities, schema, tools, TUI, distribution | orchestrator | oriented context, baseline test run |
| 2. Memory deep-dive (lane 1) | Deep review of `src/memory/*` and tests | oracle specialist (resumed) | findings C1, C2, H1–H7, M1–M7, L1–L5 |
| 3. Compaction + tools deep-dive (lane 2) | Deep review of `src/compaction/*`, `src/tools/*`, utilities, entry | oracle specialist (fresh) | findings G3, G4, H1, plus tool-schema bounds |
| 4. Reconciliation | Merge orchestrator recon + both lane findings | orchestrator | unified ranked list, plus implementation plans |
| 5. Planning | Concrete before/after code, test specs, sequencing | two oracle specialists (parallel) | Plan 1 (C1 + C2) and Plan 2 (G3, G4, G5, G6, G7, H1, G8) |
| 6. Documentation | Synthesize into this document | orchestrator | this file |

### 1.2 Why parallel specialist lanes

Two lanes were chosen because:

- The memory subsystem (`src/memory/*`, ~3,000 LoC across 13 files) is the most complex surface, with heuristic extraction, LLM extraction, caching, audit, and migration logic intermixed.
- The compaction + tools surface (`src/compaction/*`, `src/tools/*`, `src/util/*`, `src/index.ts`, ~700 LoC across 8 files) has a different shape — wiring-heavy, tool-schema-driven, and constrained by the opencode plugin API.
- Splitting them in parallel was 2× faster than serial review and let each specialist go deeper.
- The orchestrator maintained a coherent cross-cutting view (intent docs, distribution, test fixtures, build config) and was the single integrator of the two lanes' findings.

### 1.3 Session reuse

The memory specialist was reused for the planning phase because the same context (writer.ts 1637 LoC, extract-llm.ts 1161 LoC, extract-prompt.ts 524 LoC, llm-adapter.ts 449 LoC, plus the test corpus) was needed. A fresh session was used for the high-priority planning because the scope was different (compaction + tools layer and writer behavior, not the deep memory internals). Both sessions are now reconciled and available for follow-up.

### 1.4 Cross-validation between lanes

The two lanes independently produced findings that the orchestrator's recon would not have caught:

- Lane 1 caught C1 (global-fallback asymmetry) and C2 (catch-all masking) by tracing the data flow from `writeMemory` through `cache.delete` and back into `readMemory`.
- Lane 2 caught G3 (`head_files` using `context.client` which is not on `ToolContext`) by reading the opencode plugin type declarations and the test mock.
- Both lanes independently flagged the unbounded durable block (G4 vs. lane 1's "durable block bounded?" review) with converging evidence.
- Lane 1's `markReferencedDecisions` finding (H1) and lane 2's `durable block bounded` finding (G4) compound: lane 1 found the marking logic over-marks; lane 2 found the bounded policy relies on accurate marking.

The two findings were not duplicated — they were complementary.

### 1.5 What was *not* in scope

- Live runtime testing in a real opencode session (no interactive model, no plugin reload tests)
- Performance benchmarking (the codebase is I/O-bound on idle writes; no hot path)
- Security review beyond data-loss considerations (the plugin is local-only, no network surface)
- Documentation of the TUI module beyond a sanity check (it's the right-side indicator only)
- Review of `dist/` build output (built artifacts, not source)

---

## 2. Project context

### 2.1 Inferred project goal

From `README.md`, `docs/PLAN.md`, `docs/IMPLEMENTATION.md`, `docs/v1.1-plan.md`, `docs/reliability-plan.md`, `docs/improvement-program.md`, and `docs/journal.md`:

> An opencode plugin that provides two silent, durable layers — a schema-constrained compaction prompt with a bounded durable block (Layer 1), and a per-project `STATE.json` memory file written on `session.idle` and exposed through seven explicit pull tools (Layer 2). LLM fact extraction is opt-in via `TOKENMAXXER_LLM_EXTRACT=1`; heuristic extraction is the durable fallback. Memory is never auto-injected into the composer. A separate right-side TUI indicator shows memory activity without touching the composer.

### 2.2 Architecture at a glance

```
src/
├── index.ts                ── plugin entry, wiring only (123 LoC)
├── config.ts               ── kill switch (TOKENMAXXER_NO_PROMPT)
├── types.ts                ── shared types
├── tui.tsx                 ── right-side activity indicator
├── util/
│   ├── fs.ts               ── atomicWrite, safeRead, getMtime
│   ├── git.ts              ── current git SHA
│   └── log.ts              ── client.app.log wrapper (never throws)
├── compaction/
│   ├── prompt.ts           ── schema-constrained compaction prompt
│   └── durable.ts          ── tiered durable-block builder
├── memory/
│   ├── schema.ts           ── v3 Zod schemas, MemoryFile
│   ├── migrate.ts          ── pure v1→v2→v3 migration + provenance
│   ├── store.ts            ── read/write STATE.json, mtime cache, corrupt recovery
│   ├── writer.ts           ── orchestrator (heuristic + LLM + audit + health)
│   ├── extract-llm.ts      ── opt-in LLM extraction
│   ├── extract-prompt.ts   ── canonical extraction input and prompt
│   ├── extract-schema.ts   ── ExtractedFacts Zod + JSON schema
│   ├── llm-adapter.ts      ── host PluginInput v1 client transport adapter
│   ├── provider-inventory.ts ── model discovery from connected providers
│   ├── reader.ts           ── query helpers
│   ├── lock.ts             ── per-project async serialization
│   ├── activity-state.ts   ── per-session activity state for the TUI
│   └── memory-size.ts      ── shared UTF-8 size accounting
└── tools/
    ├── recall.ts           ── recall_decision, get_active_files, get_project_state, recall_promote
    ├── efficiency.ts       ── preview_compaction, head_files
    └── status.ts           ── tokenmaxxer_status
```

### 2.3 What is well-done (do not touch)

- **Evidence-backed provenance** (`src/memory/schema.ts:42-52`, `:191-208`) — source text never crosses the boundary; only refs and digests are persisted. v3 cache entries must carry `extractor: "llm"`, `confidence: "llm-corroborated"`, an audit session ID, and at least one evidence entry. Well-tested.
- **Fail-safe LLM fallback** — every LLM failure path returns `null`; heuristic state is persisted first; the queue prevents tail poisoning. The retry budget is exactly 1. Tested in `test/memory/writer-llm.test.ts` and `test/memory/p0-a-reliability.test.ts`.
- **Atomic writes with corrupt recovery** — `atomicWrite` (temp + rename) prevents corruption; `backupCorrupt` preserves corrupt files for debugging; `readMemory` handles corrupt JSON gracefully.
- **mtime-based multi-instance cache invalidation** — simple and effective.
- **Model discovery policy** — `isEligibleAutomaticModel` requires `zero_cost && tool_callable && active && connected`. No paid fallback. Well-tested.
- **Migration** — v1→v2→v3 is correct, pure (no I/O), and quarantines unproven pre-v3 cache entries.
- **Structured logging** — `log()` never throws, all diagnostics are bounded, and secrets are never logged.
- **Per-project serialization** — `lock.ts` correctly serializes per-project work, coalesces same-source requests, and prevents tail poisoning.
- **Bounded compatibility casts** — all SDK casts live in `llm-adapter.ts`; callers receive typed `AdapterResult<T>`; Zod validates structured output.
- **Inner-function-for-testability pattern** — every tool's `execute` body is an exported `_*` function, called from the `tool()` wrapper. Tests exercise the inner function directly.
- **Kill switch** — `TOKENMAXXER_NO_PROMPT=1` cleanly branches from `output.prompt` replacement to `output.context` append.

---

## 3. Code quality — overall assessment

### 3.1 Architecture

The layering is consistent and well-justified: `util/` (primitives) → `memory/` (storage + schema + reader + writer + extract-llm + llm-adapter + provider-inventory + lock + activity-state + memory-size) → `compaction/` (prompt + durable block) → `tools/` (7 tool wrappers) → `index.ts` (wiring). `migrate.ts` is pure (no I/O), `store.ts` owns all filesystem behavior, and the tool `_*` inner-function pattern is applied uniformly.

**Two files are too large for comfortable navigation:**

| File | LoC | Concern |
|---|---|---|
| `src/memory/writer.ts` | 1637 | Concentrates heuristic extraction, LLM orchestration, merge, prune, audit, and health logic |
| `src/memory/extract-llm.ts` | 1161 | Cache key, model discovery wrapper, LLM extraction, audit lifecycle, evidence resolution |

Splitting each into ~400 LoC sub-modules would improve navigability without changing behavior. (Not in the implementation plans below — defer to a future refactor.)

### 3.2 Readability

- Most modules are well-commented with clear contract documentation.
- `src/tools/status.ts:42-91` is a 70-line inline expression building a status string with nested ternaries — the least readable function in the reviewed set.
- `src/memory/writer.ts:820-825` bullet-point filter logic is correct but convoluted.
- `src/memory/extract-prompt.ts:140-206` has three near-identical tree-walk functions (`findStringLocations`, `findArrayLocations`, `findObjectLocations`) that should be a single generic visitor.
- `src/memory/writer.ts` and `src/memory/extract-prompt.ts` both implement file-path extraction with subtly different normalization rules.

### 3.3 Error handling

The pattern is right: every tool inner function is `try/catch` → string return, `log()` never throws, `store.writeMemory` catches both project and global-path failures and returns `false` (essential because the `session.idle` event handler is fire-and-forget per `docs/journal.md` 2026-08-08). `migrate.ts` returns `null` on validation failure; the store then backs up corrupt files.

**One critical exception:** `src/memory/writer.ts:439-442` wraps the entire `writeMemoryOnIdleSerialized` body in a single `try/catch` that returns `"heuristic-only"`. Any throw before the heuristic write is indistinguishable from a successful heuristic-only extraction. This silently violates the "durable heuristic fallback" invariant — see [Plan 1, C2](#52-c2--pre-heuristic-write-failures-masked-as-heuristic-only).

### 3.4 TypeScript & opencode API conventions

- Strict mode is on (`tsconfig.json:7`).
- `verbatimModuleSyntax: false` is pragmatic but worth flipping to `true` to catch more import bugs.
- A few localized `(context as any).client` casts exist (see [G3](#63-g3-critical--head_files-broken-in-production)).
- One type lie: `setLastCompaction(ts: string)` cannot accept `null` despite module state being `string | null` (see [H1](#610-h1-high--setlastcompaction-type-lie)).
- One type/runtime mismatch: `evidence_refs` is `optional().superRefine(reject undefined)` — TypeScript treats it as optional, Zod rejects it at runtime (see M5 in [section 4](#4-findings--full-list)).
- One construction-type mismatch: `LLMExtractionCacheEntry` uses `LegacyExtractedFacts` but the runtime schema requires `evidence_refs` (see M5).

### 3.5 Tests

- 202 tests across 21 files, organized by module.
- The reliability-plan and P0/P1 test files (`p0-a-reliability.test.ts`, `bounded.test.ts`, `merge.test.ts`, `prune.test.ts`, `extract-llm.test.ts`, `writer-llm.test.ts`) cover the documented risk areas very well.
- Notable gaps: no test verifies `head_files` against a real `ToolContext` shape; no test for `recall_decision.limit` / `head_files.lines` / `head_files.paths` edge cases; no test for `markReferencedDecisions` despite its impact on the durable block; no test for unbounded `blockers`/`next_steps` in the durable block; no test for global-path read fallback (C1); no test for catch-all failure masking (C2).

---

## 4. Findings — full list

Findings are tagged with severity, a short code, the file:line reference, and a one-line description. Cross-references to the implementation plans are included.

### 4.1 Critical

| Code | File:Line | Finding | Plan |
|---|---|---|---|
| **C1** | `src/memory/store.ts:51-100` vs `107-152` | Global fallback data is permanently unreadable. `writeMemory` falls back to `globalPath` on read-only worktrees, but `readMemory` only reads from `memoryPath`. Data written to the global path is silently lost on next read. | [Plan 1, C1](#51-c1--global-fallback-data-is-permanently-unreadable) |
| **C2** | `src/memory/writer.ts:439-442` | Pre-heuristic-write failures are masked as `"heuristic-only"`. Any throw before the heuristic write is indistinguishable from a successful heuristic-only extraction. | [Plan 1, C2](#52-c2--pre-heuristic-write-failures-masked-as-heuristic-only) |
| **G3** | `src/tools/efficiency.ts:21,36,73,95` | `head_files` is broken in production. Reads `context.client` which is not on `ToolContext`; will throw at runtime. The test mock hides the bug. | [Plan 2, G3](#63-g3-critical--head_files-broken-in-production) |

### 4.2 High

| Code | File:Line | Finding | Plan |
|---|---|---|---|
| **G4** | `src/compaction/durable.ts:77-83`; `src/memory/schema.ts:170,174-175` | Durable block is partially unbounded. `blockers`/`next_steps` join the full schema-unbounded arrays; `current_task` has no length cap; foundational decisions are unbounded. | [Plan 2, G4](#64-g4-high--durable-block-partially-unbounded) |
| **G5** | `src/memory/writer.ts:1131-1155` | `markReferencedDecisions` over-marks all valid decisions when any `recall_decision` call appears in the transcript. Defeats the durable block's bounded "foundational + recent + top-5 older" policy. Also mutates the input. | [Plan 2, G5](#65-g5-high--markreferenceddecisions-over-marks) |
| **G6** | `src/memory/writer.ts:341-349, 366-371` | `writeMemory` return value unchecked in `persistTerminal` and `onHealthOutcome`. Failed persistence → stuck "pending" audit guard, cooldown never engages. | [Plan 2, G6](#66-g6-high--writememory-return-unchecked) |
| **G7** | `src/memory/writer.ts:628-631` | Active file reason is misleading. A file only ever read 3× reports "edited 3 times". Test `test/memory/writer.test.ts:217` asserts the wrong behavior. | [Plan 2, G7](#67-g7-high--active-file-reason-is-misleading) |
| **H1** | `src/tools/status.ts:22-24` | `setLastCompaction` type lie. Signature is `(ts: string) => void` but module state is `string \| null`. Test uses a double cast. | [Plan 2, H1](#610-h1-high--setlastcompaction-type-lie) |
| **G8** | `src/tools/status.ts:20-24`; `src/index.ts:68` | `lastCompactionTimestamp` is process-global, not per-project. Resets to `null` on plugin reload. Should be per-project in `STATE.json`. | [Plan 2, G8](#611-g8-high--lastcompactiontimestamp-is-process-global) |

### 4.3 Medium

| Code | File:Line | Finding |
|---|---|---|
| **M1** | `src/memory/writer.ts:834-836` | `new RegExp(DECISION_KEYWORD_RE.source, ...)` constructed per sentence with fragile flag manipulation. |
| **M2** | `src/memory/writer.ts:912-921` | `COMMON_WORDS` Set allocated per call to `isPlausibleTopic`. |
| **M3** | `src/memory/writer.ts:1100-1123` | `stripCodeBlocks` doesn't handle indented code blocks. |
| **M4** | `src/memory/writer.ts:592-745`; `src/memory/extract-prompt.ts:370-451` | Duplicated file extraction logic with subtly different normalization rules. |
| **M5** | `src/memory/extract-schema.ts:22-37`; `src/memory/schema.ts:136-139` | Type/runtime mismatches: `evidence_refs` is optional+superRefine; `LLMExtractionCacheEntry` uses legacy facts type. |
| **M6** | `src/memory/llm-adapter.ts:97-98, 427-443` | `cachedHealthGate` is set once and never invalidated at runtime. |
| **M7** | `src/memory/writer.ts:254, 339, 348, 370, 433, 513` | `pruneOld` called 6× during a single LLM extraction flow, each with full deep clone. |
| **M8** | `src/tools/recall.ts:88-90` | Dead `typeof resolveProjectPath === "function"` guard paying runtime cost for a test-harness compatibility issue. |
| **M9** | `src/tools/recall.ts:104` | `context.sessionId` fallback is dead — the type is `sessionID`. |
| **M10** | `src/tools/recall.ts:127-130` | `registerTools(_ctx)` accepts a `ctx` it never uses. |
| **M11** | 4 files (`durable.ts`, `recall.ts`, `reader.ts`, `status.ts`) | Provenance formatting duplicated 4× with slight variations. |
| **M12** | `src/memory/extract-schema.ts:60-118` | Hand-maintained JSON Schema mirrors Zod schema; risk of drift. |
| **M13** | `src/memory/writer.ts:1285-1290` | Heuristic `active_files` replace rather than accumulate (LLM path accumulates). Cross-session continuity is lost on heuristic path. |
| **M14** | `src/memory/writer.ts:46, 232` | `TRANSCRIPT_WINDOW = 50` may miss early-session decisions. Trade-off not documented in README. |
| **M15** | `src/tools/recall.ts:141`; `src/tools/efficiency.ts:83-89` | Tool argument bounds missing: `limit`, `lines`, `paths` all unbounded. |
| **M16** | `README.md:414` | Claims `Bun.$` fallback in `git.ts`; the implementation uses only `child_process`. |
| **M17** | `src/index.ts:42-52` | `HEADER.md` placeholder created on plugin init before any session. Improvement-program F3. |
| **M18** | `src/types.ts` | `memoryKey` dead field. Improvement-program F9. |

### 4.4 Low (style/dead code/optimization)

- `src/memory/writer.ts:1090` — `getMessageText` type predicate double-cast.
- `src/memory/writer.ts:820-825` — bullet-point filter needs a clarifying comment.
- `src/memory/writer.ts:467-480` — `mostRecentAuditRecords` double-sort needs a comment.
- `src/memory/writer.ts:638-674` — `normalizePath` rejects `/tmp/opencode` but not `/tmp/` generally.
- `src/memory/extract-prompt.ts:140-206` — three near-identical tree-walks → one generic visitor.
- `src/tools/efficiency.ts:33` — `head_files` reads files sequentially; `Promise.all` would parallelize.
- `src/tools/efficiency.ts:50` — `${e}` vs `String(e)` inconsistency.
- `src/tools/status.ts:39-40` — double-read of STATE.json (`readMemory` + `safeRead` for size).
- `src/compaction/durable.ts:46-48` — `recent_sessions` fallback likely dead after v3 migration.
- `src/compaction/durable.ts:31-33` — `localeCompare` sort instead of `Date.parse`.
- `src/memory/extract-llm.ts` (1161 LoC) and `src/memory/writer.ts` (1637 LoC) — split into sub-modules.
- `bin/tokenmaxxer` — print a one-line confirmation that `TOKENMAXXER_LLM_EXTRACT=1` is set.
- `tsconfig.json:18` — consider `verbatimModuleSyntax: true`.
- No `.github/workflows/ci.yml` exists; the 202-test suite and `tsc --noEmit` are not enforced on push. **HIGH** for regression risk.

---

## 5. Critical bugs — code designs (Plan 1)

### 5.1 C1 — Global fallback data is permanently unreadable

**File:** `src/memory/store.ts:51-100` (read) vs `107-152` (write)

**Symptom:** When the project worktree is read-only, `writeMemory` writes to `~/.config/opencode/memory/<hash>/STATE.json`. `readMemory` only reads from `<worktree>/.opencode/memory/STATE.json`. The data written to the global path is silently lost on the next read.

**Why it matters:** In read-only worktree scenarios (the exact case the fallback exists for), every idle write produces data that can never be read back. The plugin appears to work (no errors) but memory is silently ephemeral. This directly contradicts the project goal of "durable memory."

**Design decisions:**

| Decision | Resolution |
|---|---|
| Always try both paths? | No. Stat `memoryPath(project)` first. Only stat `globalPath(project)` when project mtime is `null`. Avoids extra stat on the hot path. |
| Shared or separate cache? | Shared cache keyed by `project`, but each entry records which `path` it was read from. Cache hit requires `cached.path === effectivePath` AND mtime match. Handles the "project path becomes writable" migration. |
| Both paths have data? | Project path wins. No merge, no warning. Global is stale from a read-only period; project is authoritative once writable. |
| `backupCorrupt` on global? | Yes. `backupCorrupt(path, raw)` already takes the path parameter; corrupt backups on global land next to the corrupt file. No change needed. |

**Before:**

```ts
const cache = new Map<string, { mem: MemoryFile | null; mtime: number }>()

export async function readMemory({ worktree, directory }: {
  worktree: string; directory: string
}): Promise<MemoryFile | null> {
  const project = resolveProjectPath(worktree, directory)
  const path = memoryPath(project)
  const mtime = await getMtime(path)
  const cached = cache.get(project)
  if (cached && mtime !== null && cached.mtime === mtime) return cached.mem
  if (cached && mtime === null && cached.mem === null) return null
  const raw = await safeRead(path)
  // ... parse, migrate, cache.set ...
}
```

**After:**

```ts
interface MemoryCacheEntry {
  mem: MemoryFile | null
  mtime: number
  /** The file path that was actually read (project or global fallback). */
  path: string
}
const cache = new Map<string, MemoryCacheEntry>()

// Also export the helper (was private) so tests can target the fallback path
export function globalPath(worktree: string): string { ... }  // was: function

export async function readMemory({ worktree, directory }: {
  worktree: string; directory: string
}): Promise<MemoryFile | null> {
  const project = resolveProjectPath(worktree, directory)
  const projectPath = memoryPath(project)

  // Try the project path first; fall back to the global path only when the
  // project path has no file (e.g. read-only worktree that previously wrote
  // to the global fallback).
  let path = projectPath
  let mtime = await getMtime(path)
  if (mtime === null) {
    const fallback = globalPath(project)
    const fallbackMtime = await getMtime(fallback)
    if (fallbackMtime !== null) {
      path = fallback
      mtime = fallbackMtime
    }
  }

  const cached = cache.get(project)
  if (cached && cached.path === path && mtime !== null && cached.mtime === mtime) {
    return cached.mem
  }
  if (cached && cached.path === path && mtime === null && cached.mem === null) {
    return null
  }

  const raw = await safeRead(path)
  if (raw === null) {
    cache.set(project, { mem: null, mtime: mtime ?? 0, path })
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    await backupCorrupt(path, raw)
    const empty = emptyMemory(project)
    cache.set(project, { mem: empty, mtime: mtime ?? 0, path })
    return empty
  }

  const mem = loadAndMigrate(parsed)
  if (mem === null) {
    await backupCorrupt(path, raw)
    const empty = emptyMemory(project)
    cache.set(project, { mem: empty, mtime: mtime ?? 0, path })
    return empty
  }

  cache.set(project, { mem, mtime: mtime ?? 0, path })
  return mem
}
```

`writeMemory` is unchanged — it already falls back to `globalPath(project)` and calls `cache.delete(project)`. The next `readMemory` finds the global path via the new fallback logic.

**Migration impact:** If a user previously had a read-only worktree, `writeMemory` wrote to `globalPath(project)` but `readMemory` never read it. After the fix, `readMemory` will find the orphaned data on the next read (project path is still empty, global path has data). The fix only adds a read fallback; it does not move, delete, or overwrite data. If both paths have data, the project path wins (authoritative). No migration is needed.

### 5.2 C2 — Pre-heuristic-write failures masked as "heuristic-only"

**File:** `src/memory/writer.ts:176-183, 218, 258, 439-442`

**Symptom:** The catch-all wraps the entire `writeMemoryOnIdleSerialized` body. Any throw before the heuristic write at line 258 is indistinguishable from a successful heuristic-only extraction. The status tool reports `"heuristic-only"` (sounds fine), but no heuristic state was persisted. Bugs in extraction, merge, or transport are invisible.

**Why it matters:** Silent failures make debugging impossible. The project goal of "durable heuristic fallback" is violated when the fallback itself silently fails.

**Design decisions:**

| Decision | Resolution |
|---|---|
| New outcome values? | One new value: `"error"`. Means "unexpected throw before heuristic persistence." Not split into transport/merge/extract sub-types — the error string is logged separately and is sufficient for debugging. |
| Post-heuristic throws? | Return `"heuristic-only"`. Heuristic state IS persisted; the LLM path threw. Semantically correct. The new error log includes `heuristic_persisted: true` so operators can distinguish. |
| `setProjectQueueOutcome` changes? | None. Accepts any string, bounds to 48 chars. |
| `tokenmaxxer_status` changes? | None. Renders `lastOutcome` as a raw string at `status.ts:82`. `"error"` displays as `Last idle outcome: error`. |
| `last_compaction.log`? | No change. This is an idle write, not compaction. |

**Before:**

```ts
export type IdleWriteOutcome =
  | "no-messages" | "heuristic-only" | "cache-hit"
  | "llm-success" | "llm-failed" | "write-failed" | "queue-failed"

async function writeMemoryOnIdleSerialized(opts: IdleWriteOptions): Promise<IdleWriteOutcome> {
  try {
    // ... lines 219-438 ...
    const heuristicPersisted = await writeMemory({ worktree, directory, client }, pruned)
    if (heuristicPersisted === false) return "write-failed"
    // ...
  } catch {
    // Never throw from event handler or poison later queued source sessions.
    return "heuristic-only"
  }
}
```

**After:**

```ts
export type IdleWriteOutcome =
  | "no-messages" | "heuristic-only" | "cache-hit"
  | "llm-success" | "llm-failed" | "write-failed" | "queue-failed"
  | "error"

async function writeMemoryOnIdleSerialized(opts: IdleWriteOptions): Promise<IdleWriteOutcome> {
  let heuristicPersisted = false
  try {
    const { client, worktree, directory, sessionId } = opts

    const c = client as { ... }
    if (!c.session?.messages) return "no-messages"

    // ... lines 228-257 unchanged ...

    heuristicPersisted = await writeMemory({ worktree, directory, client }, pruned)
    if (!heuristicPersisted) return "write-failed"
    await generateHeader(worktree, directory, pruned)

    // ... lines 262-437 unchanged ...
  } catch (error) {
    void log(opts.client, "error", "writeMemoryOnIdle failed", {
      session_id: opts.sessionId,
      heuristic_persisted: heuristicPersisted,
      error: String(error),
    })
    return heuristicPersisted ? "heuristic-only" : "error"
  }
}
```

**Exact diff points in `writer.ts`:**

1. **Line 176-183:** add `| "error"` to the `IdleWriteOutcome` union.
2. **Line 218:** insert `let heuristicPersisted = false` before the `try {`.
3. **Line 258:** change `const heuristicPersisted = await writeMemory(...)` to `heuristicPersisted = await writeMemory(...)` (remove `const`).
4. **Line 259:** change `if (heuristicPersisted === false) return "write-failed"` to `if (!heuristicPersisted) return "write-failed"`.
5. **Lines 439-442:** replace the bare `catch { return "heuristic-only" }` with the logging catch that branches on `heuristicPersisted`.

**Migration impact:** `IdleWriteOutcome` is only consumed in `writer.ts` (definition + 2 function signatures) and `index.ts:108` (discards the return value). The status tool at `status.ts:82` renders `lastOutcome` as a raw string. `lock.ts:103` accepts any string. No caller switches on the outcome. `"error"` is additive.

---

## 6. High-priority cluster — code designs (Plan 2)

### 6.3 G3 (CRITICAL) — `head_files` broken in production

**File:** `src/tools/efficiency.ts:21,36,73,95`

**Symptom:** `ToolContext` (`node_modules/@opencode-ai/plugin/dist/tool.d.ts:2-24`) has no `client` field. `_headFiles` casts `(context as any).client`, which is `undefined` at runtime → `TypeError: Cannot read properties of undefined`. `preview_compaction` survives only because `buildDurableBlock` uses `client` solely for null-safe logging.

**Why it matters:** One of 7 advertised tools is broken as written. The 202-test suite does not catch this because `test/tools/efficiency.test.ts` provides a mock client.

**Fix decision:** Use `node:fs/promises` directly for `head_files`. The tool description already says "relative to worktree" and `ToolContext` exposes `worktree` + `directory`. For `preview_compaction`, pass the real `client` from the plugin closure into `registerEfficiencyTools` (the plugin's `PluginInput` at `index.d.ts:36-46` does have `client`).

**Before:**

```ts
export async function _headFiles(
  args: { paths: string[]; lines: number },
  context: { worktree: string; directory: string; client: any },
): Promise<string> {
  const out: string[] = []
  for (const p of args.paths) {
    try {
      const content = (await context.client.file.read({ query: { path: p } })).data?.content ?? ""
      // ... render head ...
    } catch (e) {
      out.push(`### ${p}\n(error: ${e})`)
    }
  }
  return out.join("\n\n")
}
```

**After:**

```ts
import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { resolveProjectPath } from "../memory/store"

export async function _headFiles(
  args: { paths: string[]; lines: number },
  context: { worktree: string; directory: string },  // drop `client: any`
): Promise<string> {
  const out: string[] = []
  const root = resolveProjectPath(context.worktree, context.directory)
  for (const p of args.paths) {
    try {
      const absPath = isAbsolute(p) ? p : join(root, p)
      const buf = await readFile(absPath)
      // Binary detection: null bytes in first 8KB
      const sample = buf.subarray(0, 8192)
      if (sample.includes(0x00)) {
        out.push(`### ${p}\n(binary file, skipped)`)
        continue
      }
      const content = buf.toString("utf-8")
      if (!content) {
        out.push(`### ${p}\n(empty or not found)`)
        continue
      }
      const allLines = content.split("\n")
      const head = allLines.slice(0, args.lines).join("\n")
      out.push(
        `### ${p}\n${head}${allLines.length > args.lines ? "\n...(truncated)" : ""}`,
      )
    } catch (e) {
      out.push(`### ${p}\n(error: ${e})`)
    }
  }
  return out.join("\n\n")
}

// Pass `client` from the plugin closure
export function registerEfficiencyTools(client: unknown): {
  tool: Record<string, ReturnType<typeof tool>>
} {
  return {
    tool: {
      preview_compaction: tool({
        // ...
        async execute(_args, context) {
          return _previewCompaction(_args as Record<string, never>, {
            worktree: context.worktree,
            directory: context.directory,
            client,  // from closure, not from ToolContext
          })
        },
      }),
      head_files: tool({
        // ...
        async execute(args, context) {
          return _headFiles(args, {
            worktree: context.worktree,
            directory: context.directory,
          })
        },
      }),
    },
  }
}
```

`src/index.ts:117` changes from `...registerEfficiencyTools()` to `...registerEfficiencyTools(client)`.

### 6.4 G4 (HIGH) — Durable block partially unbounded

**File:** `src/compaction/durable.ts:28,43,59-66,77-83` · `src/memory/schema.ts:170,174-175` · `src/memory/migrate.ts` · `src/memory/writer.ts` (pruneOld)

**Symptom:** `mem.blockers` and `mem.next_steps` join with no slice. `current_task` has no schema cap. Foundational decisions all render with no limit. `recall_promote` can grow them indefinitely. A session with 50 blockers and 50 next steps lands the entire arrays in the compaction prompt — the exact failure mode the plugin claims to prevent.

**Why it matters:** Defeats the plugin's "bound context" thesis. The bounded policy in `compaction/durable.ts` is one of the documented differentiators.

**Fix decision:** Schema cap + runtime cap (defense in depth) for arrays; schema cap + migration truncation for `current_task`; runtime cap only for foundational (no schema-level cap since the decisions array is already bounded by the 8KB total).

**Schema** (`schema.ts`):

```ts
current_task: z.string().max(500).optional(),                              // line 170
blockers: z.array(z.string().max(200)).max(20).default([]),               // line 174
next_steps: z.array(z.string().max(200)).max(20).default([]),             // line 175
```

**Runtime caps in `durable.ts`:**

```ts
// line 28 — cap current_task rendering
if (mem.current_task) {
  const task = mem.current_task.length > 500
    ? mem.current_task.slice(0, 497) + "..."
    : mem.current_task
  lines.push(`Current task: ${task}${formatProvenance(mem.current_task_provenance)}`)
}

// line 43 — cap foundational at 20 most recent
const foundational = valid
  .filter((d) => d.foundational)
  .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  .slice(0, 20)

// lines 77-83 — cap blockers/next_steps rendering
if (mem.blockers.length) lines.push(`Blockers: ${mem.blockers.slice(0, 20).join("; ")}`)
if (mem.next_steps.length) lines.push(`Next: ${mem.next_steps.slice(0, 20).join("; ")}`)
```

**Migration** (`migrate.ts`) — add `normalizeBounds` step before `MemoryFileSchema.safeParse`:

```ts
function normalizeBounds(data: RawRecord): RawRecord {
  const result = { ...data }
  if (Array.isArray(result.blockers)) {
    result.blockers = result.blockers.slice(0, 20).map((b: unknown) =>
      typeof b === "string" ? b.slice(0, 200) : b
    )
  }
  if (Array.isArray(result.next_steps)) {
    result.next_steps = result.next_steps.slice(0, 20).map((s: unknown) =>
      typeof s === "string" ? s.slice(0, 200) : s
    )
  }
  if (typeof result.current_task === "string" && result.current_task.length > 500) {
    result.current_task = result.current_task.slice(0, 500)
  }
  return result
}

// In loadAndMigrate, after version migration:
data = normalizeBounds(data)
const parsed = MemoryFileSchema.safeParse(data)
```

**Foundational cap in `pruneOld`** (`writer.ts`) — add after step 4:

```ts
const foundational = cloned.decisions.filter((d) => d.foundational)
if (foundational.length > 20) {
  const keep = new Set(
    [...foundational]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 20)
      .map((d) => d.id),
  )
  cloned.decisions = cloned.decisions.filter(
    (d) => !d.foundational || keep.has(d.id),
  )
}
```

**Migration impact:** `normalizeBounds` truncates existing data on read. **Truncate, don't reject** — rejecting would trigger `backupCorrupt` + `emptyMemory` = data loss. The runtime cap in `durable.ts` and the foundational cap in `pruneOld` are defense in depth. Consider logging an `info` entry on truncation so operators can diagnose missing data.

### 6.5 G5 (HIGH) — `markReferencedDecisions` over-marks

**File:** `src/memory/writer.ts:1131-1155`

**Symptom:** When ANY `recall_decision` tool part exists in the transcript, ALL valid decisions get `last_used_in_session = sessionId`. This defeats the durable block's bounded "foundational + recent + top-5 older" policy. Also a hidden side-effect mutating the input.

**Why it matters:** The "recent" tier in the durable block includes every valid decision whenever the model has ever called recall. This inflates the durable block far beyond the documented 5-decision older tier.

**Fix decision:** Parse `part.state.output` to identify which specific decisions were returned. Match by `(topic, timestamp)` — the output format (`recall.ts:43`) is `${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${d.timestamp})`. The `id` is not in the output, so topic+timestamp is the best key. Don't mutate input — return a new array via `.map`.

**Before:**

```ts
export function markReferencedDecisions(
  mem: MemoryFile, messages: TranscriptMessage[], sessionId: string,
): void {
  let recalled = false
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "recall_decision") {
        recalled = true
        break
      }
    }
    if (recalled) break
  }
  if (recalled) {
    for (const d of mem.decisions) {
      if (d.still_valid) d.last_used_in_session = sessionId
    }
  }
}
```

**After:**

```ts
const DECISION_LINE_RE = /^(.+?): .+ \(SHA .+?, (.+?)\)/

function parseRecalledDecisionKeys(output: string | undefined): Set<string> {
  const keys = new Set<string>()
  if (!output) return keys
  for (const line of output.split("\n")) {
    // Skip non-decision lines: "Project:", "No valid decisions", "Error", "No project memory"
    if (!line.includes(" (SHA ")) continue
    const match = line.match(DECISION_LINE_RE)
    if (!match) continue
    const [, topic, timestamp] = match
    keys.add(`${topic.toLowerCase()}|${timestamp}`)
  }
  return keys
}

export function markReferencedDecisions(
  mem: MemoryFile, messages: TranscriptMessage[], sessionId: string,
): void {
  const recalledKeys = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool" || part.tool !== "recall_decision") continue
      const output = (part as { state?: { output?: string } }).state?.output
      for (const key of parseRecalledDecisionKeys(output)) recalledKeys.add(key)
    }
  }
  if (recalledKeys.size === 0) return
  // Don't mutate input — build new array
  mem.decisions = mem.decisions.map((d) => {
    if (!d.still_valid) return d
    const key = `${d.topic.toLowerCase()}|${d.timestamp}`
    if (recalledKeys.has(key) && d.last_used_in_session !== sessionId) {
      return { ...d, last_used_in_session: sessionId }
    }
    return d
  })
}
```

**Disambiguation note:** If two decisions share both topic and timestamp (extremely unlikely), both get marked — acceptable and strictly better than the current behavior. The tool does not expose `id` in its output, so topic+timestamp is the most precise key available.

**Coupling risk:** The regex assumes the output format never changes. If `recall.ts:43` is later modified to add the decision ID or change the format, the regex would silently stop matching and no decisions would be marked (a regression back to "nothing is marked" rather than "everything is marked"). Mitigate with a test that asserts the regex matches the actual `recall.ts` output format, and add a comment in `recall.ts` warning that the output format is parsed by `markReferencedDecisions`.

### 6.6 G6 (HIGH) — `writeMemory` return unchecked

**File:** `src/memory/writer.ts:341-349, 366-371`

**Symptom:** `persistTerminal` and `onHealthOutcome` call `await writeMemory(...)` but discard the boolean. Failed persistence → stuck "pending" audit guard (terminal never recorded) or cooldown never engages.

**Fix decision:** Diagnostic-only warning log. No recovery path (a `false` return means system-level I/O failure; just diagnose).

**Before/after `persistTerminal`:**

```ts
const persistTerminal = async (auditSessionID: string, outcome: Exclude<AuditTerminalOutcome, "pending">): Promise<void> => {
  const latest = await readMemory({ worktree, directory })
  if (!latest) return
  const updated = setAuditTerminalOutcome(latest, auditSessionID, outcome)
  await writeMemory({ worktree, directory, client }, pruneOld(updated, client))
}
```

```ts
const persistTerminal = async (auditSessionID: string, outcome: Exclude<AuditTerminalOutcome, "pending">): Promise<void> => {
  const latest = await readMemory({ worktree, directory })
  if (!latest) return
  const updated = setAuditTerminalOutcome(latest, auditSessionID, outcome)
  const persisted = await writeMemory({ worktree, directory, client }, pruneOld(updated, client))
  if (!persisted) {
    void log(client, "warn", "audit terminal outcome not persisted", {
      audit_session_id: auditSessionID,
      outcome,
    })
  }
}
```

**Before/after `onHealthOutcome`:**

```ts
onHealthOutcome: async (report) => {
  const latest = await readMemory({ worktree, directory })
  if (!latest) return
  const updated = upsertModelHealth(latest, report)
  await writeMemory({ worktree, directory, client }, pruneOld(updated, client))
}
```

```ts
onHealthOutcome: async (report) => {
  const latest = await readMemory({ worktree, directory })
  if (!latest) return
  const updated = upsertModelHealth(latest, report)
  const persisted = await writeMemory({ worktree, directory, client }, pruneOld(updated, client))
  if (!persisted) {
    void log(client, "warn", "model health outcome not persisted", {
      provider_id: report.provider_id,
      model_id: report.model_id,
      outcome: report.last_outcome,
    })
  }
}
```

**Known limitation:** If `writeMemory` persistently fails (e.g. disk full), the audit guard stays "pending" forever and every reload re-enters the audit session, burning LLM tokens. A follow-up should cap retry attempts or escalate to error-level after N failures.

### 6.7 G7 (HIGH) — Active file reason is misleading

**File:** `src/memory/writer.ts:592-632`

**Symptom:** A file only ever read 3× reports "edited 3 times". `extractActiveFiles` counts all tool interactions (`read`, `edit`, `write`, `glob`, `grep`, `bash`) in a single `Map<string, number>`. The reason is user-facing in `get_project_state`, `get_active_files`, and the durable block.

**Fix decision:** Track reads/edits/writes separately per file. Generate a reason string that lists operation types with counts, edits first (most semantically relevant for "active file").

**Before:**

```ts
function extractActiveFiles(messages: TranscriptMessage[]): { path: string; reason: string }[] {
  const fileCounts = new Map<string, number>()
  // ... counts all tools equally ...
  return sorted.map(([path, count]) => ({
    path,
    reason: count > 1 ? `edited ${count} times` : "read once",
  }))
}
```

**After:**

```ts
type FileActivity = { reads: number; edits: number; writes: number }

function extractActiveFiles(messages: TranscriptMessage[]): { path: string; reason: string }[] {
  const fileActivity = new Map<string, FileActivity>()

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      const toolName = part.tool
      const input = ((part as { state?: { input?: Record<string, unknown> } }).state?.input ?? {}) as Record<string, unknown>
      if (toolName !== "read" && toolName !== "edit" && toolName !== "write" &&
          toolName !== "glob" && toolName !== "grep" && toolName !== "bash") continue
      const paths = extractPaths(toolName, input)
      for (const p of paths) {
        const normalized = normalizePath(p)
        if (!normalized) continue
        const activity = fileActivity.get(normalized) ?? { reads: 0, edits: 0, writes: 0 }
        if (toolName === "edit") activity.edits++
        else if (toolName === "write") activity.writes++
        else activity.reads++  // read, glob, grep, bash → reads
        fileActivity.set(normalized, activity)
      }
    }
  }
  const total = (a: FileActivity) => a.reads + a.edits + a.writes
  const sorted = [...fileActivity.entries()]
    .sort(([, a], [, b]) => total(b) - total(a))
    .slice(0, 5)
  return sorted.map(([path, activity]) => ({ path, reason: fileReason(activity) }))
}

function fileReason(activity: FileActivity): string {
  const parts: string[] = []
  if (activity.edits > 0) parts.push(`edited ${activity.edits}x`)
  if (activity.writes > 0) parts.push(`written ${activity.writes}x`)
  if (activity.reads > 0) parts.push(`read ${activity.reads}x`)
  return parts.join(", ") || "touched once"
}
```

**Test fixture update** (`test/memory/writer.test.ts:191-222`):
- `src/index.ts`: reads=1, edits=1 → reason `"edited 1x, read 1x"`
- `src/util.ts`: writes=1 → reason `"written 1x"`

**Known limitation:** `bash` is classified as `reads++`, but `bash` can run `rm` or `sed -i` (mutations). Correctly classifying bash commands would require parsing the command string for write operations (`>`, `>>`, `sed -i`, `rm`, `mv`, etc.). The current fix is a major improvement; bash-classification refinement can be a follow-up.

### 6.8 (not numbered; part of M3 above) — `setLastCompaction` type lie

**File:** `src/tools/status.ts:22-24`

**Before/after:**

```ts
// Before
export function setLastCompaction(ts: string) { lastCompactionTimestamp = ts }

// After
export function setLastCompaction(ts: string | null) { lastCompactionTimestamp = ts }
```

**Test fixture** (`status.test.ts:75`): replace
```ts
;(setLastCompaction as (ts: string | null) => void)(null as unknown as string)
```
with:
```ts
setLastCompaction(null)
```

### 6.10 H1 (HIGH) — `setLastCompaction` type lie

See [section 6.8 above](#68-not-numbered-part-of-m3-above--setlastcompaction-type-lie).

### 6.11 G8 (HIGH) — `lastCompactionTimestamp` is process-global

**File:** `src/tools/status.ts:20-24` · `src/memory/schema.ts` · `src/memory/store.ts` · `src/index.ts:24,68`

**Symptom:** Module-level `let` shared across projects in the same process. Resets to `null` on plugin reload. Status for project A reports project B's last compaction.

**Fix decision:** Move `last_compaction_at` into `MemoryFile` (per-project, durable). The compaction hook writes it to STATE.json; the status tool reads it from `mem`. Delete the module-level state entirely.

**Schema (additive):**

```ts
last_compaction_at: z.string().datetime({ offset: true }).or(z.string().max(128)).optional(),
```

**New helper in `store.ts`:**

```ts
export async function recordCompaction(
  { worktree, directory, client }: { worktree: string; directory: string; client?: unknown },
  timestamp: string,
): Promise<void> {
  const project = resolveProjectPath(worktree, directory)
  await enqueueProjectJob(project, "record-compaction", async () => {
    const mem = await readMemory({ worktree, directory })
    if (!mem) return
    await writeMemory({ worktree, directory, client }, { ...mem, last_compaction_at: timestamp })
  })
}
```

**`src/index.ts:68`:** replace `setLastCompaction(new Date().toISOString())` with:

```ts
await recordCompaction({ worktree, directory, client }, new Date().toISOString())
```

Remove `setLastCompaction` from the import at `src/index.ts:24`.

**`src/tools/status.ts`:** delete lines 20-24 (module state + setter). In `_tokenmaxxerStatus`, replace `lastCompactionTimestamp ?? "none"` (line 79) with `mem?.last_compaction_at ?? "none"`.

**Migration impact:** `last_compaction_at` is additive and optional. Existing STATE.json files without it parse fine. Status shows "none" until the first compaction after the fix.

**Risk:** Adding a `writeMemory` call to the compaction hook (a hot path that fires on every compaction) introduces a new failure mode: if STATE.json is read-only and the global fallback also fails, `recordCompaction` silently fails and the timestamp isn't recorded. This is strictly better than the current process-global state (which also shows "none" after reload), but operators might not realize the timestamp is best-effort. Mitigate by logging a warning on failed `recordCompaction`.

---

## 7. Test specifications

### 7.1 Plan 1 tests

**New file `test/memory/store.test.ts`** — real `fs` against temp dirs, 5 tests:

| Test | Setup | Asserts |
|---|---|---|
| Falls back to global path when project path empty | Write valid `MemoryFile` directly to `globalPath(project)` | `readMemory` returns it; `current_task` matches |
| Prefers project path when both have data | `writeMemory` data A; write data B to `globalPath` | `readMemory` returns data A |
| Cache invalidates when data moves from global to project | Write to global, `readMemory`, then `writeMemory` (writable project) | second `readMemory` returns project data |
| `writeMemory` fallback + `readMemory` recovery | `chmod 0500` memory dir, `writeMemory`, restore chmod, `readMemory` | returned data matches; skipped if `getuid === 0` |
| `backupCorrupt` on global path | Write corrupt JSON to `globalPath` | returns `emptyMemory`; `.corrupt.*` exists in `dirname(globalPath)` |

```ts
import { afterEach, describe, it, expect } from "vitest"
import { mkdtemp, rm, writeFile, mkdir, chmod } from "node:fs/promises"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { readMemory, writeMemory, globalPath } from "../../src/memory/store"
import { emptyMemory } from "../../src/memory/schema"
import type { MemoryFile } from "../../src/memory/schema"

const dirs: string[] = []

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tokenmaxxer-store-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
```

**Additions to `test/memory/writer-llm.test.ts`** — 5 mock-based tests:

| Test | Setup | Asserts |
|---|---|---|
| Returns `"error"` when `session.messages` throws before heuristic write | mock throws; `TOKENMAXXER_LLM_EXTRACT=0` | outcome `=== "error"`; no `STATE.json`; `app.log` error includes `session_id` and `heuristic_persisted: false` |
| Returns `"heuristic-only"` when LLM path throws after heuristic write | LLM enabled, `session.create` throws | outcome `=== "heuristic-only"`; `STATE.json` exists; log has `heuristic_persisted: true` |
| `getProjectQueueStatus` shows `"error"` | as above | `lastOutcome === "error"` |
| No error log on `"no-messages"` | `session.messages` returns `[]` | outcome `"no-messages"`; no `writeMemoryOnIdle failed` log |
| `"error"` distinct from `"write-failed"` | pre-existing STATE.json + read-only memory dir (skip if root) | outcome `=== "write-failed"` (not thrown — write attempted and returned false) |

### 7.2 Plan 2 tests

**G3 — `test/tools/efficiency.test.ts` (rewrite `_headFiles` block):**

Delete the `createMockClient` helper and all 6 existing `_headFiles` tests. Add 10 real-fs tests:

| Test | Setup | Assertions |
|---|---|---|
| Valid paths: returns truncated content | tmpdir with `src/index.ts` (5 lines) | `### src/index.ts`, first 3 lines, `...(truncated)` |
| File shorter than lines limit: no truncation marker | tmpdir with `short.ts` (2 lines) | content present, no `...(truncated)` |
| Empty file: returns "(empty or not found)" | tmpdir with `empty.ts` (0 bytes) | `(empty or not found)` |
| Missing file: returns "(error: ...)" | tmpdir, path doesn't exist | `(error: ` present |
| Multiple files: returns all results separated by double newline | tmpdir with `a.ts`, `b.ts` | both sections, `\n\n` separator |
| Only returns the first N lines | tmpdir with 100-line file | 40 lines, `...(truncated)`, `line39` present, `line40` absent |
| Binary file: returns "(binary file, skipped)" | tmpdir with file containing null bytes | `(binary file, skipped)` |
| Permission denied: returns "(error: ...)" | tmpdir with unreadable file (`chmod 000`) | `(error: ` present |
| Absolute path: resolves correctly | tmpdir, pass absolute path | content present |
| Path relative to worktree: resolves against worktree | tmpdir as worktree, `src/foo.ts` relative | content present |

**G4 — `test/compaction/durable.test.ts` (add) + new `test/memory/schema.test.ts` + new `test/memory/migrate.test.ts`:**

| File | Tests |
|---|---|
| `test/compaction/durable.test.ts` | Caps blockers at 20 (50 input); caps next_steps at 20; caps `current_task` at 500 chars (10KB input); caps foundational at 20 (100 input) |
| `test/memory/schema.test.ts` | Rejects blockers >20; rejects next_steps >20; rejects blocker item >200 chars; rejects `current_task` >500 chars; accepts at exactly 20; accepts `current_task` at exactly 500 chars |
| `test/memory/migrate.test.ts` | Truncates blockers to 20 on migrate; truncates next_steps to 20; truncates `current_task` to 500; truncates blocker items to 200 chars |

**G5 — `test/memory/writer.test.ts` (new describe block, 7 tests):**

| Test | Setup | Assertions |
|---|---|---|
| Marks only decisions returned by `recall_decision` | mem with 3 valid decisions (topics: db, auth, framework); transcript with one `recall_decision` call whose output contains db + auth lines | only db and auth get `last_used_in_session = sessionId`; framework unchanged |
| Does not mark when output is an error | transcript with `recall_decision` whose `state.output` is `"Error recalling decisions: ..."` | no decisions marked |
| Does not mark when output is "No valid decisions" | output is `"No valid decisions matching \"x\"."` | no decisions marked |
| Does not mark when no `recall_decision` calls | transcript with only `read`/`edit` tools | no decisions marked |
| Unions marks across multiple `recall_decision` calls | two calls: one returns db, other returns auth | both db and auth marked |
| Does not mutate decisions not in output | mem with 5 valid decisions, recall returns 2 | other 3 unchanged (same object identity) |
| Marks by topic+timestamp, not topic alone | two decisions with same topic, different timestamps; recall returns one | only the matching one marked |

**G6 — `test/memory/writer-llm.test.ts` (add) or new `test/memory/writer-persist.test.ts` (3 tests):**

| Test | Setup | Assertions |
|---|---|---|
| `persistTerminal` logs warn when `writeMemory` returns false | mock writeMemory → false; trigger persistTerminal | `log` called with `"warn"`, `"audit terminal outcome not persisted"`, includes `audit_session_id` + `outcome` |
| `persistTerminal` does not log when `writeMemory` returns true | mock writeMemory → true | `log` not called with that message |
| `onHealthOutcome` logs warn when `writeMemory` returns false | mock writeMemory → false; trigger onHealthOutcome | `log` called with `"warn"`, `"model health outcome not persisted"`, includes `provider_id` + `model_id` |

**G7 — `test/memory/writer.test.ts` (update existing + add 5):**

| Test | Setup | Assertions |
|---|---|---|
| Update existing line 191 | `src/index.ts`: reads=1, edits=1; `src/util.ts`: writes=1 | `indexFile.reason === "edited 1x, read 1x"`, `utilFile.reason === "written 1x"` |
| Read-only file reports "read Nx" | 3 `read` calls on same file | reason `"read 3x"` |
| Edit-heavy file reports edits first | 2 `edit` + 3 `read` on same file | reason `"edited 2x, read 3x"` |
| Write-only file reports "written Nx" | 2 `write` calls | reason `"written 2x"` |
| Mixed operations report all types | 1 read + 2 edit + 1 write | reason `"edited 2x, written 1x, read 1x"` |
| `glob` and `grep` count as reads | 1 `glob` + 1 `grep` on same pattern | reason `"read 2x"` |

**H1 — `test/tools/status.test.ts` (update + add 1):**

| Change | Detail |
|---|---|
| Update line 75 | replace the double cast with `setLastCompaction(null)` |
| Add to describe("setLastCompaction") | `accepts null` — `setLastCompaction(null)`, `expect(lastCompactionTimestamp).toBeNull()` |

**G8 — `test/tools/status.test.ts` (update) + new `test/memory/record-compaction.test.ts` (3 tests):**

| Change / Test | Detail |
|---|---|
| Remove imports of `lastCompactionTimestamp` and `setLastCompaction` | from `status.test.ts` |
| Remove the `describe("setLastCompaction")` block (lines 278-289) | from `status.test.ts` |
| Update `beforeEach` (line 75) | remove the `setLastCompaction(null)` call |
| Update "with memory: returns formatted status with counts" (line 78) | add `last_compaction_at: "2026-08-08T11:00:00.000Z"` to `makeMemory` override; keep assertion `Last compaction: 2026-08-08T11:00:00.000Z` |
| Rename "lastCompactionTimestamp not set" (line 122) | to `"last_compaction_at absent: shows 'none'"`; ensure `makeMemory` does NOT include `last_compaction_at` |
| Update "uses only each temporary project's durable model health" (line 193) | add distinct `last_compaction_at` to each project's memory; assert each status shows its own compaction timestamp, not the other's |
| Schema tests | `accepts last_compaction_at as optional ISO string`; `accepts last_compaction_at absent` |
| `recordCompaction` writes timestamp to STATE.json | tmpdir with existing STATE.json; STATE.json has `last_compaction_at` = timestamp |
| `recordCompaction` is a no-op when no memory exists | tmpdir with no STATE.json; no file created |
| `recordCompaction` serializes with idle writes | concurrent recordCompaction + writeMemoryOnIdle; no corruption; both writes succeed |

---

## 8. Sequencing and migration

### 8.1 Plan 1 sequencing

**Ship separately. C1 first, then C2.** They are independent. C1 is pure `store.ts`; C2 adds a union member that no caller switches on.

- **Commit 1 — C1:** `src/memory/store.ts` + new `test/memory/store.test.ts`. Cache type change is internal; `writeMemory` unchanged; no external API change.
- **Commit 2 — C2:** `src/memory/writer.ts` + `test/memory/writer-llm.test.ts`. Verified: `status.ts:82` renders `lastOutcome` as a raw string; `lock.ts:103` accepts any string; `index.ts:108` discards the return value. No switch/enum anywhere.

### 8.2 Plan 2 sequencing

Recommended shipping order (4 PRs):

1. **PR A — G3 + H1** (Commit 1+2). Independent. Unblocks production `head_files`.
2. **PR B — G4** (Commit 3). Schema change. Re-baselines durable tests. The `normalizeBounds` migration is mandatory or existing STATE.json with >20 blockers fails validation and triggers `backupCorrupt` → data loss.
3. **PR C — G5 + G6 + G7** (Commit 4+5+6, one PR). Writer-layer fixes. G5 must follow G4 to avoid double re-baselining `durable.test.ts`.
4. **PR D — G8** (Commit 7). Schema change, depends on H1 (deletes `setLastCompaction`).

**Hard dependencies:** G4 → G5 (durable block behavior). H1 → G8 (deletions). G3 is fully independent. G6 and G7 are independent of all schema changes.

### 8.3 Cross-plan sequencing

**No inter-plan dependencies.** Plan 1 and Plan 2 touch different files (except both touch `test/`). Plan 1's C1 (`store.ts`) doesn't affect Plan 2's tests. Plan 1's C2 (`writer.ts:439-442`) doesn't affect Plan 2's G5/G6/G7.

### 8.4 Recommended ship order (5 PRs)

| PR | Commits | Description | Effort | Tests added |
|---|---|---|---|---|
| **1** | C1 | `store.ts` global-path read fallback | ~2.5h | 5 |
| **2** | C2 | `"error"` outcome in `writer.ts` | ~1.5h | 5 |
| **3** | G3 + H1 | `head_files` fix + signature widen | ~2.5–3.5h | 11 |
| **4** | G4 | Durable block bounded (schema + migration + runtime) | ~4–6h | ~14 + re-baseline |
| **5** | G5 + G6 + G7 + G8 | Writer correctness + per-project compaction timestamp | ~10–15h | ~18 + re-baseline |

PRs 1 and 2 can ship in parallel with PR 3 (different files, different lanes). PRs 4 and 5 can be parallelized across two engineers (one on memory schema, one on writer behavior) if the team has capacity. The G4→G5 hard dependency requires coordination: PR 4 lands first, then PR 5.

### 8.5 Migration and compatibility

| Plan | Impact | Resolution |
|---|---|---|
| **C1** | Orphaned global data is auto-recovered | Read-only addition; no move, delete, or overwrite. If project becomes writable, project path wins on next write. |
| **C2** | `"error"` outcome is additive | No caller switches on `IdleWriteOutcome`; status tool renders as raw string. |
| **G3** | `registerEfficiencyTools(client)` signature change | `index.ts:117` is the only caller. |
| **G4** | `current_task` max 500, `blockers`/`next_steps` max 20 items × 200 chars | `normalizeBounds` truncates on read; runtime caps in `durable.ts` are defense in depth; foundational cap at 20 in `pruneOld`. |
| **G5** | No schema change | Regex couples to `recall.ts:43` output format — add a test and a comment. |
| **G6** | No schema change | Diagnostic-only. |
| **G7** | Test fixture update (line 217 assertion is wrong) | Update assertion in same commit. |
| **H1** | Signature widening | Only caller is the compaction hook (string) and the test (null). No production code passes null. |
| **G8** | `last_compaction_at` additive and optional | No migration needed; status shows "none" until first compaction after fix. |

---

## 9. Verification matrix

### 9.1 Automated

```bash
# Type check
npx tsc --noEmit

# All tests
npm test

# Build
npm run build
```

### 9.2 Per-fix proof tests

| Plan | Fix | Test file | What it proves |
|---|---|---|---|
| 1 | C1 | `test/memory/store.test.ts` (new) | Global fallback data is readable; cache invalidates; corrupt recovery works on global |
| 1 | C2 | `test/memory/writer-llm.test.ts` (additions) | `"error"` is distinct from `"heuristic-only"` and `"write-failed"`; no log on `"no-messages"` |
| 2 | G3 | `test/tools/efficiency.test.ts` (rewrite) | `head_files` works with real fs; binary/missing/permission-denied all handled |
| 2 | G4 | `test/compaction/durable.test.ts` (4 new); `test/memory/schema.test.ts` (6 new); `test/memory/migrate.test.ts` (4 new) | Blockers/next_steps/`current_task`/foundational are bounded; schema rejects over-cap; migration truncates |
| 2 | G5 | `test/memory/writer.test.ts` (7 new in describe block) | `markReferencedDecisions` only marks returned decisions; regex matches `recall.ts:43` format |
| 2 | G6 | `test/memory/writer-llm.test.ts` (3 new) | Warning logged on `writeMemory === false`; not logged on `true` |
| 2 | G7 | `test/memory/writer.test.ts` (1 update + 5 new) | Reason accurately reflects operation types |
| 2 | H1 | `test/tools/status.test.ts` (1 update + 1 new) | `setLastCompaction(null)` works without cast |
| 2 | G8 | `test/tools/status.test.ts` (updates + 1 new) + `test/memory/record-compaction.test.ts` (3 new) | Per-project isolation; timestamp persisted; no-op when no memory; serializes with idle writes |

### 9.3 Manual smoke tests

**C1:**
```bash
# 1. Create a project with a read-only memory directory
mkdir -p /tmp/c1-test/.opencode/memory
chmod 0500 /tmp/c1-test/.opencode/memory

# 2. Start opencode (TOKENMAXXER_LLM_EXTRACT=0)
cd /tmp/c1-test
TOKENMAXXER_LLM_EXTRACT=0 opencode

# 3. Send a message: "Let's use Postgres for the database"
# 4. Wait for session.idle to complete
# 5. Exit opencode

# 6. Verify global path has data
ls ~/.config/opencode/memory/*/STATE.json

# 7. Verify project path is empty
ls /tmp/c1-test/.opencode/memory/STATE.json  # should not exist

# 8. Restart opencode in the same project
cd /tmp/c1-test
TOKENMAXXER_LLM_EXTRACT=0 opencode

# 9. Call tokenmaxxer_status tool — should show decisions and current_task
# 10. Call recall_decision — should return the Postgres decision

# Cleanup
chmod 0700 /tmp/c1-test/.opencode/memory
rm -rf /tmp/c1-test ~/.config/opencode/memory/*/STATE.json
```

**G3:**
1. `npm run build`
2. Install plugin in a real opencode session
3. Invoke `head_files` with `{ paths: ["src/index.ts"], lines: 10 }` — should return first 10 lines
4. Invoke `head_files` with a binary file (e.g. `node_modules/.bin/...`) — should return `(binary file, skipped)`
5. Invoke `head_files` with a missing path — should return `(error: ...)`
6. Invoke `preview_compaction` — should return the durable block (no crash)

### 9.4 Full verification matrix

| Check | Command | Expected |
|---|---|---|
| Type check | `npx tsc --noEmit` | clean |
| All tests | `npm test` | ~260+ tests pass (was 202) |
| Build | `npm run build` | `dist/index.js` + `dist/tui.js` self-contained, no chunks |
| Plan 1 C1 | `npx vitest run test/memory/store.test.ts` | 5/5 pass |
| Plan 1 C2 | `npx vitest run test/memory/writer-llm.test.ts` | 5 new pass |
| Plan 2 G3 | `npx vitest run test/tools/efficiency.test.ts` | all rewritten + 10 new pass |
| Plan 2 G4 | `npx vitest run test/compaction/durable.test.ts test/memory/schema.test.ts test/memory/migrate.test.ts` | all pass |
| Plan 2 G5/G7 | `npx vitest run test/memory/writer.test.ts` | new + updated pass |
| Plan 2 G6 | `npx vitest run test/memory/writer-llm.test.ts` | 3 new pass |
| Plan 2 H1/G8 | `npx vitest run test/tools/status.test.ts` | updated pass |
| Plan 2 G8 | `npx vitest run test/memory/record-compaction.test.ts` | 3 new pass |
| Plan 2 G3 manual | build, install, call `head_files` on text/binary/missing paths | returns content / (binary file, skipped) / (error: ...) |

---

## 10. Effort estimates and top risks

### 10.1 Effort summary

| Plan | Fix | Hours | Notes |
|---|---|---|---|
| 1 | C1 | 2.5 | 30 min code + 1.5 hr tests + 15 min verify |
| 1 | C2 | 1.5 | 20 min code + 1 hr tests + 15 min verify |
| 2 | G3 | 2–3 | Rewrite `_headFiles` + 10 new real-fs tests + `registerEfficiencyTools` signature change |
| 2 | H1 | 0.5 | One-line signature + one test fixture |
| 2 | G4 | 4–6 | Schema caps + `normalizeBounds` + durable caps + pruneOld foundational + ~12 new tests + re-baseline |
| 2 | G5 | 3–4 | New parser + rewrite + 7 new tests |
| 2 | G6 | 1–2 | Two `if (!persisted)` blocks + 3 mock tests |
| 2 | G7 | 2–3 | `FileActivity` type + increment + reason generator + update 1 test + 5 new tests |
| 2 | G8 | 4–6 | Schema field + `recordCompaction` helper + status tool rewrite + delete module state + re-baseline + 3 new tests |
| **Total** | | **20.5–28.5** | ~2.5–3.5 working days for a single engineer; ~5 days with two engineers parallelizing PRs 4 and 5 |

### 10.2 Per-commit size summary

| Commit | Files touched | LoC changed (est.) | Test LoC added (est.) |
|---|---|---|---|
| C1 | 2 (1 src, 1 test new) | +25 / -10 | +200 |
| C2 | 2 (1 src, 1 test edit) | +15 / -5 | +150 |
| G3 | 3 (2 src, 1 test edit) | +40 / -25 | +250 |
| H1 | 2 (1 src, 1 test edit) | +1 / -1 | +10 |
| G4 | 7 (4 src, 3 test edit/new) | +60 / -15 | +350 |
| G5 | 2 (1 src, 1 test edit) | +30 / -15 | +180 |
| G6 | 2 (1 src, 1 test edit/new) | +10 / -0 | +90 |
| G7 | 2 (1 src, 1 test edit) | +35 / -10 | +120 |
| G8 | 6 (4 src, 2 test edit/new) | +50 / -20 | +200 |

### 10.3 Top risks per fix

**C1:** The cache `path` field introduces a new cache invalidation dimension. If any code path writes to `memoryPath` but the cache still has a `globalPath` entry, the cache will serve stale data until the mtime check catches it. The fix mitigates this by checking `cached.path === path` (path mismatch → cache miss), but the risk is an untested code path that writes without calling `cache.delete(project)`. The `writeMemory` function already calls `cache.delete(project)` on all paths (success, fallback success, and both failures), so this risk is low but should be verified by running the full test suite.

**C2:** The `let heuristicPersisted = false` declaration outside the `try` block means any early `return` statement returns with `heuristicPersisted === false`. If an early return is added in the future for a case where heuristic state WAS persisted (e.g. a new early-exit after the write), the catch would incorrectly return `"error"` instead of `"heuristic-only"`. This is mitigated by the fact that all early returns before line 258 are genuinely pre-write (`"no-messages"`, `"write-failed"`), and all returns after line 258 are explicit outcome strings that bypass the catch entirely.

**G3:** The `resolveProjectPath` import creates a new dependency from `tools/efficiency.ts` to `memory/store.ts`; if `store.ts` has side effects on import (it doesn't currently, but future changes could introduce them), the efficiency tool would inherit them. Mitigate by importing only the pure `resolveProjectPath` function, which is already side-effect-free.

**G4:** The `normalizeBounds` migration truncates existing data silently — a user with 50 blockers loses 30 on next read with no warning. This is the right tradeoff (rejecting causes data loss via `backupCorrupt`), but the truncation should be logged via `log(client, "info", "truncated blockers to schema max")` so operators can diagnose missing blockers.

**G5:** The regex `^(.+?): .+ \(SHA .+?, (.+?)\)` assumes the output format never changes. If `recall.ts:43` is later modified to change the output format (e.g. add the decision ID), the regex would silently stop matching and no decisions would be marked — a regression back to "nothing is marked" rather than "everything is marked." Mitigate by adding a test that asserts the regex matches the actual `recall.ts` output format, and a comment in `recall.ts` warning that the output format is parsed by `markReferencedDecisions`.

**G6:** The warning log is diagnostic-only with no recovery path. If `writeMemory` persistently fails (e.g. disk full), the audit guard stays "pending" forever and every reload re-enters the audit session, burning LLM tokens. The warning is necessary but not sufficient — a follow-up should cap retry attempts or escalate to error-level after N failures. This fix is still correct as a first step; the risk is that operators don't notice the warning.

**G7:** The `bash` tool is classified as `reads++`, but `bash` can run `rm` or `sed -i` (mutations). The reason string would say "read 1x" for a file that was actually deleted via bash. This is a known imprecision — correctly classifying bash commands would require parsing the command string for write operations (`>`, `>>`, `sed -i`, `rm`, `mv`, etc.). The current fix is still a major improvement over "edited 1x" for a read-only `bash` call, and the bash-classification refinement can be a follow-up.

**H1:** Widening the signature from `string` to `string | null` could mask future bugs where a non-null string is expected but null is passed. The risk is low because the only caller is the compaction hook (which passes a string) and the test (which passes null). No production code passes null.

**G8:** Adding a `writeMemory` call to the compaction hook (a hot path that fires on every compaction) introduces a new failure mode: if STATE.json is read-only and the global fallback also fails, `recordCompaction` silently fails and the timestamp isn't recorded. The status tool would show "none" even though compaction happened. This is strictly better than the current process-global state (which also shows "none" after reload), but operators might not realize the timestamp is best-effort. Mitigate by logging a warning on failed `recordCompaction`.

---

## 11. Assumptions and limits

### 11.1 Inferred intent

Project intent was inferred from `README.md`, `docs/PLAN.md`, `docs/IMPLEMENTATION.md`, `docs/v1.1-plan.md`, `docs/reliability-plan.md`, `docs/improvement-program.md`, and `docs/journal.md`. The silent-server, opt-in LLM, heuristic-fallback invariants were treated as ground truth. Where the docs explicitly flag historical-but-superseded proposals (vector search, header-injection, M5 duplicate, `15000` reserved), they were not treated as gaps.

### 11.2 Runtime verification not performed

- No live opencode session was run.
- No LLM extraction was invoked against a real model.
- No user-project STATE.json files were inspected.

The 202-test suite is the behavior evidence base. The plans above add ~45 new tests across 6 test files; the 1 manual smoke test for G3 is the only runtime verification recommended.

### 11.3 Independent specialist sessions

Two specialist deep-dives were independent and produced non-overlapping findings. The memory layer specialist flagged two CRITICAL bugs (C1, C2) and 1 HIGH (H1 over-marking) that orchestrator-level reading would not have caught. The compaction + tools specialist flagged one CRITICAL (head_files) and one HIGH (durable block unboundedness) plus a cluster of MEDIUM tool-schema bounds. The two lanes cross-validated each other and the orchestrator recon.

### 11.4 Reusable sessions

Both specialist sessions are reconciled and available for follow-up:
- `ora-1` (memory layer deep-dive) — context includes writer.ts 1637 LoC, extract-llm.ts 1161 LoC, extract-prompt.ts 524 LoC, llm-adapter.ts 449 LoC, plus the full test corpus and README.
- `ora-2` (compaction + tools deep-dive) — context includes writer.ts 627 LoC, durable.test.ts 362 LoC, status.test.ts 290 LoC, schema.ts 247 LoC, migrate.ts 192 LoC, recall.ts 178 LoC, store.ts 165 LoC, efficiency.test.ts 159 LoC, plus more.

### 11.5 Distribution state

The repository is private at the time of this assessment, so raw-GitHub installer URLs return 404 by design (documented in `docs/journal.md` 2026-08-09 and classified as release-blocker F1 in `docs/improvement-program.md`). This is a deployment-state finding, not a code-quality issue, and is not in scope for any of the implementation plans.

### 11.6 What was not in scope

- Vector index / M7 (only if 8KB cap is regularly hit, per `docs/PLAN.md`).
- The TUI module beyond a sanity check (right-side indicator only).
- `dist/` build output (built artifacts, not source).
- Performance benchmarking (the codebase is I/O-bound on idle writes; no hot path).
- Security review beyond data-loss considerations (local-only, no network surface).
- Live runtime testing.

---

## Appendix A — File inventory (as reviewed)

### Source files

| File | LoC | Reviewed by |
|---|---|---|
| `src/index.ts` | 123 | orchestrator + ora-2 |
| `src/config.ts` | 12 | orchestrator + ora-2 |
| `src/types.ts` | 54 | orchestrator + ora-2 |
| `src/tui.tsx` | 79 | orchestrator |
| `src/util/fs.ts` | 38 | orchestrator + ora-2 |
| `src/util/git.ts` | 23 | orchestrator + ora-2 |
| `src/util/log.ts` | 19 | orchestrator + ora-2 |
| `src/compaction/prompt.ts` | 46 | orchestrator + ora-2 |
| `src/compaction/durable.ts` | 111 | orchestrator + ora-2 |
| `src/memory/schema.ts` | 247 | orchestrator + ora-1 + ora-2 |
| `src/memory/migrate.ts` | 192 | orchestrator + ora-1 + ora-2 |
| `src/memory/store.ts` | 165 | orchestrator + ora-1 + ora-2 |
| `src/memory/writer.ts` | 1637 | ora-1 + ora-2 |
| `src/memory/extract-llm.ts` | 1161 | ora-1 |
| `src/memory/extract-prompt.ts` | 524 | ora-1 |
| `src/memory/extract-schema.ts` | 124 | orchestrator + ora-1 |
| `src/memory/llm-adapter.ts` | 449 | ora-1 |
| `src/memory/provider-inventory.ts` | 355 | ora-1 |
| `src/memory/reader.ts` | 78 | orchestrator + ora-1 |
| `src/memory/lock.ts` | 133 | orchestrator + ora-1 |
| `src/memory/activity-state.ts` | 97 | orchestrator |
| `src/memory/memory-size.ts` | 12 | orchestrator |
| `src/tools/recall.ts` | 178 | orchestrator + ora-2 |
| `src/tools/efficiency.ts` | 101 | orchestrator + ora-2 |
| `src/tools/status.ts` | 114 | orchestrator + ora-2 |
| `bin/tokenmaxxer` | 15 | orchestrator |
| `install.sh` | 177 | orchestrator |

### Test files (21 files, 202 tests)

| File | Tests | Reviewed by |
|---|---|---|
| `test/memory/merge.test.ts` | — | ora-1 |
| `test/memory/migrate.test.ts` | — | ora-1 + ora-2 |
| `test/memory/prune.test.ts` | — | ora-1 |
| `test/memory/writer.test.ts` | 537 LoC | ora-1 + ora-2 |
| `test/memory/extract-llm.test.ts` | 621 LoC | ora-1 |
| `test/memory/writer-llm.test.ts` | — | ora-1 |
| `test/memory/p0-a-reliability.test.ts` | 416 LoC | ora-1 |
| `test/compaction/prompt.test.ts` | — | ora-2 |
| `test/compaction/durable.test.ts` | 362 LoC | ora-2 |
| `test/compaction/bounded.test.ts` | — | ora-2 |
| `test/tools/recall.test.ts` | — | ora-2 |
| `test/tools/efficiency.test.ts` | 159 LoC | ora-2 |
| `test/tools/status.test.ts` | 290 LoC | ora-2 |
| `test/fixtures/transcripts/*.json` | 6 files | ora-1 |
| `test/index.test.ts` | — | orchestrator |

### Documentation

| File | Reviewed by |
|---|---|
| `README.md` | orchestrator + ora-1 |
| `docs/PLAN.md` | orchestrator |
| `docs/IMPLEMENTATION.md` | orchestrator |
| `docs/v1.1-plan.md` | orchestrator |
| `docs/reliability-plan.md` | orchestrator |
| `docs/improvement-program.md` | orchestrator |
| `docs/journal.md` | orchestrator |

---

## Appendix B — Reusable specialist sessions

Both specialist sessions are reconciled and available for follow-up. Resume by passing the session ID to the next `task` call.

| Session ID | Specialist | Context | Best for |
|---|---|---|---|
| `ses_0176e8774ffeU34evHtLX9gnpX` | `oracle` | writer.ts 1637 LoC, extract-llm.ts 1161 LoC, extract-prompt.ts 524 LoC, llm-adapter.ts 449 LoC, full memory test corpus, README | Memory-layer follow-ups: writer.ts split, markReferencedDecisions fix design, evidence resolution refinements |
| `ses_01765dda5ffeguazQi3oPUdy7Q` | `oracle` | writer.ts 627 LoC, durable.test.ts 362 LoC, status.test.ts 290 LoC, schema.ts 247 LoC, migrate.ts 192 LoC, recall.ts 178 LoC, store.ts 165 LoC, efficiency.test.ts 159 LoC | Compaction + tools follow-ups: tool description tightening, durable block format review, TUI activity marker design |

---

*End of document.*
