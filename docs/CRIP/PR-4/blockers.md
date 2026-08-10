# PR 4 — Live Blocker Log

This file collects blockers and decisions encountered while implementing
`docs/CRIP/PR-4/implementation-plan.md` that are not in the plan itself but must
be surfaced before the oracle re-review. Append-only; each entry records
date, wave, scope, and a one-line resolution.

Format:

```
## YYYY-MM-DD — wave-N scope
- [type] short title — file:line — resolution
```

Types: `bug`, `design-decision`, `scope-deviation`, `test-gap`,
`portability`, `doc-clarification`.

---

## 2026-08-10 — wave-1A new host-contract files
- [test-gap] src/host/contract.ts created with full-version comparison (major/minor/patch; reject prerelease and malformed).
- [test-gap] tsconfig.host-contract.json + test/host-contract/typecheck.ts compile-time fixture created.
- [test-gap] test/host/contract.test.ts created with version-truth-table tests (currently green; pin the new contract).
- [test-gap] test/tools/bounds.test.ts created with argument + output bound tests (currently failing on module load; expected to go green in Wave 3).
- [design-decision] The host-contract fixture uses PluginInput["client"] and asserts ToolContext has no client (key=T must never include "client" under 1.18.15).
- [scope-deviation] test/tools/bounds.test.ts references exports that do not yet exist (src/tools/bounds.ts, src/tools/efficiency.ts formatters); tests fail with module-load errors in Wave 1; expected to go green in Wave 3.
- [design-decision] tsconfig.host-contract.json uses `"types": ["node"]` instead of the suggested `"types": []` because `src/**/*` includes production modules that import Node builtins (`node:path`, `node:fs/promises`, ...); `types: []` would fail compilation with TS2307 on every Node import — src/host/contract.ts:1-32.
- [design-decision] tsconfig.host-contract.json overrides `exclude` to `["dist", "node_modules"]` (dropping inherited `test`) so the fixture `test/host-contract/typecheck.ts` is actually compiled; the inherited `exclude: ["test"]` from tsconfig.json would silently skip it — tsconfig.host-contract.json:11-18.

## 2026-08-10 — wave-1B existing test extensions
- [test-gap] test/tools/efficiency.test.ts extended with 7 failing client-ownership fixtures (§12 A items 1-7); expected to go green in Wave 2.
- [test-gap] test/tools/recall.test.ts extended with argument-bound fixtures (§12 B items 8-11 for recall only); expected to go green in Wave 3.
- [test-gap] test/memory/llm-adapter.test.ts extended with full-version-gate fixtures (§12 D items 24-34); expected to go green in Wave 4.
- [test-gap] test/memory/writer-llm.test.ts extended with unsupported-host integration test (§12 E items 35-39); expected to go green in Wave 5.
- [test-gap] test/index.test.ts extended with failing client-injection + peer-range fixtures; expected to go green in Waves 2/6/7.
- [test-gap] test/host/package-meta.test.ts created with peer range + dev dep + installed-version assertions; expected to go green in Wave 7.
- [scope-deviation] Failing fixtures that reference not-yet-existing exports use `as any` at the call boundary to document the planned contract; they may compile-error or runtime-error today; that's intended.

## 2026-08-10 — wave-2 dependency injection
- [design-decision] registerEfficiencyTools now requires HostClient; the registered execute wraps it via closure; the legitimate PluginInput["client"] is the only accepted source.
- [design-decision] Helper signatures are (args, context, client) — client is a separate typed parameter, not a property of the context type.
- [design-decision] head_files routes through client.file.read with query.directory = context.directory; no process.cwd() fallback, no init directory capture, no Node readFile.
- [design-decision] head_files tool description updated to match the v1.18.15 host behavior (paths routed through OpenCode using the current tool invocation directory; the `paths` arg no longer promises worktree-relative resolution).
- [bug-fix] Removed (context as any).client; no production code reads a client from ToolContext.
- [test-gap] 7 §12 A efficiency fixtures now green.
- [scope-deviation] The return shape of registerEfficiencyTools keeps the `{ tool: { head_files, preview_compaction } }` wrapper (matching registerTools/registerStatusTools) instead of the bare `{ head_files, preview_compaction }` map sketched in §6: index.ts spreads the result into the Hooks `tool` map, and both test files address `registered.tool.head_files` — src/tools/efficiency.ts:104-141.
- [test-gap] Pre-existing direct-helper tests in test/tools/efficiency.test.ts (the `_previewCompaction` and `_headFiles` describe blocks) were updated from the old `(args, contextWithClient)` call shape to the spec-mandated `(args, HostProjectContext, HostClient)` shape; they are the same tests, not new fixtures — test/tools/efficiency.test.ts:50-81, 89-181.
- [bug-fix] test/index.test.ts §12 F item 45 still fails, but for a pre-existing reason unrelated to client injection: the plugin return object spreads `...registerTools(ctx)`, `...registerEfficiencyTools(client)`, and `...registerStatusTools()`, and every one of those returns a `tool` key, so the last spread wins and `hooks.tool` only ever contains `tokenmaxxer_status` — src/index.ts:116-120. Item 45's client-injection half is now proven by the second §12 F fixture, which is green. Tool-map merging is a separate wave concern; not fixed in Wave 2 per bounded scope.
