# Third-Party Oracle: PR 4 Release-Gate Investigation

You are the third-party reviewer for PR 4 of `docs/CRIP/PR-4/implementation-plan.md`
in the TokenMaxxer repository. PR 4 makes TokenMaxxer's OpenCode integration
boundary explicit and verifiable after PR 1 established authoritative storage,
PR 2 established cross-process transactions, and PR 3 established trustworthy
decision authority/human promotion semantics.

Read the plan first: `docs/CRIP/PR-4/implementation-plan.md` (1022 lines).

The implementation shipped in waves 1-8 (commit range `5a8758b..fabeb34`) on
`main`. PR 1, PR 2, and PR 3 are complete and reviewed.

What was shipped (verify against the diff):

- Wave 1 (`5a8758b`): failing regression fixtures for the host contract —
  `src/host/contract.ts` (version parser + full-version gate),
  `tsconfig.host-contract.json`, `test/host-contract/typecheck.ts`,
  `test/host/contract.test.ts`, `test/tools/bounds.test.ts`, plus extensions
  to `test/tools/efficiency.test.ts`, `test/tools/recall.test.ts`,
  `test/memory/llm-adapter.test.ts`, `test/memory/writer-llm.test.ts`,
  `test/index.test.ts`, and `test/host/package-meta.test.ts`.
- Wave 2 (`3f78f35`): dependency injection — `registerEfficiencyTools(client)`
  closes over the initializer client; no more `(context as any).client`;
  helper signatures are `(args, HostProjectContext, HostClient)`.
- Wave 3 (`f61ce17`): bounded tool schemas + output truncation —
  `src/tools/bounds.ts` with `TOOL_LIMITS`, deterministic `head_files`
  truncation markers, schema-bound recall/review/head-file arguments.
- Wave 4 (`511c1f1`): full version runtime gating via `isSupportedHostVersion`
  imported from `src/host/contract`; local `VERIFIED_HOST_CONTRACT_VERSION` /
  `MINIMUM_HOST_CONTRACT` constants removed; pinned-compatibility path kept.
- Wave 5 (`3642ca0`): graceful degradation through the real writer
  (verification only — the implementation was already correct): rejected gate
  commits heuristic memory, never calls `session.create` / `session.prompt`.
- Wave 6 (`7ecf3ad`): clean host mocks — tool-map merge in `src/index.ts`,
  `satisfies PluginInput` fixtures, no invented `ToolContext.client`.
- Wave 7 (`fabeb34`): peer range tightened to `>=1.18.15 <2.0.0`; dev dep stays
  exactly `1.18.15`; `scripts/verify-host-contract.mjs` asserts peer range,
  dev dep, and installed version; `npm run verify:host-contract` runs the
  script + the host-contract compile fixture; `.github/workflows/ci.yml`
  change is local-only (not pushed — PAT lacks the `workflow` scope).
- Wave 8 (uncommitted docs): repository-wide host-boundary audit logged in
  `docs/CRIP/PR-4/blockers.md`; this investigation brief. No production or
  test file changes in Wave 8.

CI signal at submission: `tsc --noEmit` clean; `npm run verify:host-contract`
OK (peer `>=1.18.15 <2.0.0`, dev `1.18.15`, installed `1.18.15`); `npm run build`
produces `dist/cli.js` (65.83 KB, non-empty); full suite **37 files / 478
tests** all green.

`docs/CRIP/PR-4/blockers.md` is the live implementation decision log; the
wave-8 section records the audit results for every search below.

---

## What to investigate (priority order)

### 1. Host client provenance

[per plan §17 — Client provenance]

- Is every tool client traceable to the plugin initializer?
  `src/index.ts` passes the legitimate `PluginInput["client"]` into
  `registerEfficiencyTools(client)`; the registered `execute` wrappers close
  over that client (src/tools/efficiency.ts).
- Can any model-supplied/tool context object inject a fake client? The
  `ToolContext` type has no `client` member under the supported baseline; no
  production code reads `context.client` (0 hits for `context.client` and
  `context as any` in `src/`).
- Does a helper or test still rely on `(context as any).client`? 0 hits in
  `src/`; the host-contract fixture asserts `keyof ToolContext` does not
  include `"client"` under the 1.18.15 package.
- Does `head_files` use the current invocation directory on every call? It
  routes through `client.file.read` with `query.directory = context.directory`
  on each invocation; no `process.cwd()` fallback, no init-directory capture.
- Does a registered tool receive a client that differs from the one passed to
  `registerEfficiencyTools(client)`? Both `head_files` and `preview_compaction`
  close over the same captured client.

### 2. File API

[per plan §17 — File API]

- Is there any raw-fs fallback from `head_files`? None: the tool calls
  `client.file.read`, never `node:fs`.
- Are error strings/output bounded? Per-file host errors are returned as
  bounded per-file results; `head_files` output is truncated with four
  deterministic markers (line, per-file, total, line-count).
- Can a long single line bypass the visible-output cap? No: per-line
  truncation applies a deterministic `...(line truncated)` marker and the
  cap math is covered by §12 C cases 19-23.
- Does head_files use the OpenCode file API or substitute with direct Node
  readFile? The OpenCode file API only; see wave-2/3 blockers.

### 3. Host contract

[per plan §17 — Host contract]

- Do package peer range, dev dependency, runtime gate, and contract tests all
  agree on `1.18.15`? Peer `>=1.18.15 <2.0.0` (package.json:47), dev
  `1.18.15` exact (package.json:54), runtime gate policy from
  `src/host/contract.ts` (`1.18.15` accepted, `1.18.14` rejected, `2.0.0`
  rejected), and the compile fixture compile against the installed exact
  minimum.
- Does `1.18.14` truly fail when version information is available? Yes —
  `isSupportedHostVersion("1.18.14") === false`; truth table matches plan
  §5.1.
- Does `2.0.0` truly fail? Yes — `major !== 1` returns false.
- Is missing health intentionally/predictably handled for 1.18.15? Yes —
  absent `global.health` yields `pinned-compatibility` / `health-surface-
  unavailable` and is allowed for the verified minimum contract.
- Did the implementation accidentally remove the structured-output
  compatibility adapter even though the generated minimum SDK omits the
  request declaration? No — the casts live only in `src/memory/llm-adapter.ts`
  (`format: { type: "json_schema" }` request cast; `data.info.structured`
  envelope validation), and the Wave 4/5 fixtures pin the pinned path.

### 4. Tool schemas

[per plan §17 — Tool schemas]

- Are counts integers? Schema bounds reject fractional/negative/non-integer
  limits (§12 B cases 9-11, 18).
- Are every string/array/count model-callable inputs bounded? recall query
  (256), limit (1-25), decision ID / topic (MAX_IDENTIFIER 256), head_files
  paths (1-16, max path length), head lines (1-200) — see
  `src/tools/bounds.ts`.
- Do runtime inner helpers assume the schema ran, and can any internal use
  bypass create unbounded output? `_headFiles` truncates independently of
  schema validation, so even a bypass cannot exceed the output caps.

### 5. Graceful degradation

[per plan §17 — Graceful degradation]

- Does an unsupported structured host still retain heuristic facts? Yes —
  Wave 5 proves the rejected gate still commits heuristic memory through the
  real writer.
- Are audit/session/prompt calls really zero after rejection? Yes — the
  rejected gate returns before `session.create` / `session.prompt`; fixtures
  assert no retained audit session and no structured prompt.
- Can cache/model discovery accidentally prompt before the gate? The
  structured gate is checked before the optional extraction flow starts;
  model discovery does not itself create sessions or prompt.

### 6. Tests

[per plan §17 — Tests]

- Does CI compile against the exact minimum package rather than latest 1.x?
  `npm ci` installs exactly `1.18.15` (package-lock pins the dev dep); the
  verify script fails on any installed-version drift.
- Do runtime tests use a legitimate `ToolContext` shape? Yes — no invented
  `ToolContext.client`; fixtures use `satisfies PluginInput` and a
  `HostToolContext`-shaped object.
- Are broad casts hiding host-contract errors? No `as any` remains in `src/`;
  the only casts are the deliberate structured-output adapter casts.
- Is the host-contract compile fixture actually run by CI? `npm run
  verify:host-contract` includes `tsc -p tsconfig.host-contract.json
  --noEmit`, which compiles `test/host-contract/typecheck.ts` against the
  installed 1.18.15 package.

---

## Deliverable

Write your findings as a single markdown document. Structure:

1. **Verdict** — Ship / Ship-with-fixes / Block (one line).
2. **Blocking issues** — file:line, reproduction, recommended fix.
3. **Non-blocking concerns** — file:line, why they matter, suggested follow-up.
4. **Test gaps** — scenarios that the test suite does not cover, ranked by likelihood × impact. Specifically note any of the 50 §12 release-gate cases that you could not verify are covered.
5. **Things that look fine** — call out at least three properties you verified and confirmed correct, with file:line evidence. This is not optional; it calibrates the trust of the report.
6. **Out of scope** — anything you noticed that is slated for PR 5 (source idempotency / truthful outcomes), PR 8 (storage budget), PR 10 (release/dependency hygiene) or later and should not block this PR.

Be specific. Do not say "consider refactoring X" without pointing to the exact line and explaining what concrete failure mode you are worried about. Do not pad with generalities.

If you would block the PR, do so with one decisive reason per blocker. A release gate with five vague concerns is not useful; a release gate with two precise blockers is.

Pay particular attention to investigation areas 1, 2, 3, and 5. These are the properties that distinguish a release-gate-correct implementation from one that merely compiles and passes local tests.
