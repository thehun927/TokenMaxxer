# PR 4 Oracle Release-Gate Findings

> **Reviewed implementation:** `0af8f8d9462543b1a3c0c0bfde1d71dc14924cf7`  
> **Plan:** `docs/CRIP/PR-4/implementation-plan.md`  
> **Investigation brief:** `docs/CRIP/PR-4/oracle-investigation.md`  
> **Observed GitHub Actions run:** `31444892745`

## 1. Verdict

**Block.**

The central PR 4 design is sound: registered efficiency tools now close over the legitimate plugin-initialization client; the supported v1.18.15 `ToolContext` is no longer treated as if it contains a client; `head_files` stays on the OpenCode file API and uses the current invocation directory; the peer/runtime version contract is aligned at `1.18.15`; and unsupported structured-output hosts degrade to heuristic memory without creating an audit session or sending a structured prompt.

Two release-gate requirements are still not satisfied:

1. `head_files` does not actually guarantee its advertised total model-visible output bound on the error/empty-note path; and
2. the dedicated minimum-host compile contract exists locally but is not wired into the committed GitHub Actions workflow, so the exact host type boundary is not a CI-enforced contract. The submitted commit's actual Actions run is also red.

These are focused fixes. The host-boundary architecture does not need to be redesigned.

---

## 2. Blocking issues

### Blocker 1 — `head_files` error notes bypass both per-file and total output caps

**File:** `src/tools/efficiency.ts` — `_headFiles()` / `formatHeadFilesOutput()` (approximately lines 56-139 in `0af8f8d`).

#### What is correct

Successful file contents are accumulated as `HeadFileSection` objects and passed through `formatHeadFilesOutput()`, which applies:

- per-line truncation;
- per-file section truncation; and
- final total-output truncation.

That path is correctly bounded.

#### What fails

Empty-file and host-error results are accumulated separately in `notes`:

```ts
const sections: HeadFileSection[] = []
const notes: string[] = []
...
if (!content) {
  notes.push(`### ${p}\n(empty or not found)`)
  continue
}
...
} catch (e) {
  notes.push(`### ${p}\n(error: ${e})`)
}
...
const formatted = formatHeadFilesOutput(sections)
return [...(formatted.length > 0 ? [formatted] : []), ...notes].join("\n\n")
```

The notes are appended **after** `formatHeadFilesOutput()` has enforced the total cap. They are never re-bounded.

This violates PR 4 hard invariant 12 and release-gate cases 7, 22, and 23 as implemented at the actual tool-helper boundary.

#### Deterministic reproduction 1 — normal error pushes an already-capped response past the cap

Use six successful files large enough that `formatHeadFilesOutput(sections)` reaches `TOOL_LIMITS.headTotalOutputChars` and ends with:

```text
...(head_files output truncated)
```

Then make a seventh file's `client.file.read()` throw a normal short error such as:

```ts
throw new Error("boom")
```

`_headFiles()` returns:

```text
<65536-char bounded successful result ending in total marker>

### bad.ts
(error: Error: boom)
```

The returned string is now **greater than `headTotalOutputChars`**, and content is appended after the total truncation marker.

So this does not require a pathological host error; mixed success/error input is enough.

#### Deterministic reproduction 2 — one large host error is completely unbounded

Have `client.file.read()` throw:

```ts
new Error("x".repeat(100_000))
```

With no successful sections, `formatted` is empty and the raw stringified error is returned directly from `notes`. The result can exceed both the intended per-file and total caps by an arbitrary amount.

#### Why existing tests miss it

`test/tools/bounds.test.ts` cases 19-23 call `formatHeadFilesOutput()` directly using only successful `HeadFileSection` values. They prove the formatter, not `_headFiles()`'s final composition.

`test/tools/efficiency.test.ts` case 7 exercises a host read error, but only with the short string `host-read-boom`; it checks that the error is returned, not that its size is bounded or that mixed success/error output remains under the total cap.

The investigation brief therefore overstates case 7 when it says host errors are bounded per-file: the current production composition does not enforce that property.

#### Recommended fix

Do not keep a separate unbounded `notes` channel.

Preferred shape:

1. represent success, empty, and error outcomes as sections;
2. sanitize/bound the host error to a small deterministic `name/message` string before inserting it;
3. pass **every** model-visible section through one final formatter; and
4. perform the total bound exactly once over the complete response.

For example, empty/error cases can become:

```ts
sections.push({ path: p, content: "(empty or not found)" })
sections.push({ path: p, content: `(error: ${boundedHostError(e)})` })
```

Then `formatHeadFilesOutput(sections)` is the only return path.

At minimum, if notes remain separate, the fully joined result must go through a final deterministic total-cap function and no text may be appended after the total marker.

#### Required regression tests

1. one file throws an error message much larger than `headTotalOutputChars` -> result remains `<= headTotalOutputChars`;
2. successful sections reach the total cap + a later file throws -> final result remains bounded and nothing appears after the total marker;
3. many empty/error entries still remain within the total cap;
4. hidden tail text in a large error string never appears after a truncation marker.

---

### Blocker 2 — the exact minimum-host compile contract is not enforced by committed CI

**Files:**

- `.github/workflows/ci.yml`
- `package.json`
- `tsconfig.host-contract.json`
- `test/host-contract/typecheck.ts`
- `docs/CRIP/PR-4/blockers.md`

#### What the plan requires

PR 4 Step 7 explicitly requires:

```text
add verify:host-contract
wire it into CI
```

Hard invariant 6 says the minimum supported plugin package must be compiled in CI as a first-class contract.

Release-gate cases 43-44 depend on the dedicated compile fixture proving that real v1.18.15 `ToolContext` does not expose/require `client`.

#### What is actually committed

The repository has the right local machinery:

```json
"typecheck:host-contract": "tsc -p tsconfig.host-contract.json --noEmit",
"verify:host-contract": "node scripts/verify-host-contract.mjs && npm run typecheck:host-contract"
```

and `test/host-contract/typecheck.ts` explicitly states that it is **not run by Vitest**.

However, the committed `.github/workflows/ci.yml` does not call either script. Its sequence is still:

```text
npm ci
npm test
npx tsc --noEmit
npm run build
...
```

The Wave 8 blocker log confirms why: the intended workflow edit remained local because the token used to push did not have GitHub `workflow` scope.

That is an operational explanation, not satisfaction of the release invariant. The release gate is about what future commits are forced to prove in the repository, not what was run manually once.

The package-metadata cases 40-42 *are* exercised by Vitest, and ordinary production `src/` compilation uses the exact dev dependency. But cases 43-44 are deliberately housed in a separate compile fixture precisely because the normal TypeScript config excludes tests. Without the workflow step, that proof can silently rot while CI stays green.

#### Current CI signal is also red

The actual GitHub Actions run for `0af8f8d`, run `31444892745`, concluded **failure**.

Vitest reported:

```text
35 passed files
1 failed file
1 skipped file
476 passed tests
1 failed test
1 skipped test
478 total
```

The failing test was:

```text
test/memory/activity-state.test.ts
memory activity marker > stays present until concurrent local work has settled
```

at its final post-`second()` freshness assertion.

That test/file was not modified by PR 4 and is timing-based, so I do **not** treat it as evidence that the PR 4 host implementation is wrong. But the exact release candidate is not CI-green, and because the test phase failed, GitHub Actions skipped the subsequent ordinary TypeScript typecheck, build, bundle checks, and CLI smoke.

The submission brief's "37 files / 478 tests all green" is therefore a local signal, not the observed Actions signal for `0af8f8d`.

#### Recommended fix

1. push the intended workflow change using credentials permitted to modify `.github/workflows/ci.yml`;
2. add an explicit step after the ordinary typecheck, for example:

```yaml
- name: Verify minimum OpenCode host contract
  run: npm run verify:host-contract
```

3. ensure its log proves installed `@opencode-ai/plugin` is exactly `1.18.15` and runs `tsc -p tsconfig.host-contract.json --noEmit`;
4. rerun CI and require the entire workflow to be green before the final oracle pass;
5. rerun or stabilize the unrelated `activity-state` timing fixture sufficiently that the exact reviewed commit has a green release signal.

#### Required release evidence

The final Actions log must show, in one successful job:

```text
npm test                         PASS
npx tsc --noEmit                PASS
npm run verify:host-contract    PASS
npm run build                   PASS
bundle verification             PASS
CLI smoke                       PASS
```

---

## 3. Non-blocking concerns

### A. Several efficiency tests still use broad `as any` call-site casts

**File:** `test/tools/efficiency.test.ts` — PR 4 §12 A fixtures.

The production boundary is typed correctly, and the dedicated host-contract fixture is the stronger proof. Still, several runtime fixtures invoke `_headFiles(..., toolContext as any, client as any)` even though the Wave 2 implementation now has stable `HostProjectContext` / `HostClient` types.

This does not hide the production bug fixed by PR 4 because `test/host-contract/typecheck.ts` and `test/index.test.ts` independently pin the real host shapes. But cleaning these casts would make the runtime tests better reflect the final API rather than the pre-Wave-2 planned signature.

Suggested follow-up: construct `HostProjectContext` directly and use one localized exact `PluginInput["client"]` stub helper rather than per-call `as any` casts.

### B. `preview_compaction` error text is still not explicitly bounded

**File:** `src/tools/efficiency.ts` — `_previewCompaction()`.

The helper returns:

```ts
`Error previewing compaction: ${String(e)}`
```

PR 4's explicit hard response cap is for `head_files`, so this is not a release blocker for this workstream. But the implementation plan's failure-semantics prose describes preview failure as bounded. A pathological thrown value can still create a very large model-visible preview error.

Suggested follow-up: reuse a small safe host/tool error sanitizer and cap preview error output as well.

### C. The `activity-state` CI failure is outside the PR 4 diff but should not be ignored

The failing file was not touched by the PR 4 commit range, and its test relies on 10 ms timing windows. That makes it a likely pre-existing flake/timing sensitivity rather than a host-contract regression.

It should not expand PR 4 scope into an activity-state redesign. But before declaring Ship, obtain a green rerun or make the test deterministic in the appropriate workstream so CI is a meaningful release signal.

---

## 4. Test gaps ranked by likelihood × impact

### High × High

1. **Actual `_headFiles()` mixed success/error total bound.** Current case 22 tests only the formatter. Add successful content that reaches the cap plus a later throwing read and assert the returned tool result remains within `headTotalOutputChars`.
2. **Large host-error result.** Throw a 100 KB error message and assert the returned model-visible result is bounded with no hidden tail.
3. **Minimum-host compile fixture in GitHub Actions.** Cases 43-44 are not currently executed by the committed workflow.

### Medium × High

4. **Complete release candidate CI.** The submitted commit's workflow stops at `npm test`; typecheck/build/bundle/CLI smoke never run because the job is red.

### Medium × Medium

5. **Empty/error-only `head_files` fanout.** Sixteen bounded paths all returning empty/error notes should still be checked at the final response cap.
6. **Preview error size.** Not part of the explicit `head_files` invariant, but a useful model-output hardening test.

### Release-gate case coverage I could not accept as complete

- **Case 7:** a short host error is tested, but the advertised bounded per-file behavior is not actually enforced for arbitrary error text.
- **Cases 22-23:** covered for `formatHeadFilesOutput()`, but not for `_headFiles()`'s final response after notes are appended.
- **Cases 43-44:** local compile fixture exists and appears correct, but it is not committed into the GitHub Actions execution path.
- **Case 50:** local build/smoke may be green, but the observed Actions run for the submitted commit fails before build/smoke.

The remaining cases are materially covered by the current tests/source inspection.

---

## 5. Things that look fine

### A. Client provenance is now correct

**Files:** `src/host/contract.ts`, `src/index.ts`, `src/tools/efficiency.ts`.

`HostClient` is derived from `PluginInput["client"]`; `HostProjectContext` is a projection of the real `ToolContext`; `registerEfficiencyTools(client)` requires the initializer client; and the registered wrappers close over that client instead of reading any client from the invocation context.

Independent upstream verification of OpenCode `v1.18.15` confirms exactly this host shape: `PluginInput` contains `client`, while `ToolContext` contains `directory`/`worktree` but no `client`.

The adversarial test that supplies a fake `client` property on an extended context and proves the captured registration client still wins is a useful regression.

### B. Current invocation-directory routing is correct

**File:** `src/tools/efficiency.ts`.

Each `head_files` request sends:

```ts
client.file.read({
  query: { path: p, directory: context.directory },
})
```

The directory comes from the current invocation context on every call; no `process.cwd()`, initialization-directory capture, raw `readFile`, or path join bypass was introduced.

### C. Tool registration no longer clobbers earlier tool maps

**File:** `src/index.ts`.

The plugin now builds one `tool` object and merges:

```ts
...registerTools(ctx).tool
...registerEfficiencyTools(client).tool
...registerStatusTools().tool
```

This fixes the pre-existing top-level spread behavior where each `{ tool: ... }` wrapper overwrote the previous one. The registered `head_files` path is therefore actually reachable for the client-injection tests.

### D. Argument schema bounds match the concrete plan

**File:** `src/tools/bounds.ts`.

The model-callable recall/review/head-file strings and counts are bounded at the plugin schema boundary:

- recall query 256;
- recall limit integer 1-25;
- decision ID aligned to `MAX_IDENTIFIER`;
- topic 256;
- paths 1-16 with 1024 chars each;
- lines integer 1-200.

Boundary tests cover max/max+1 and reject zero/negative/fractional counts.

### E. Full host-version gating matches the declared range

**Files:** `src/host/contract.ts`, `src/memory/llm-adapter.ts`.

The old major/minor-only comparison is gone. The stable parser/gate now rejects `1.18.14`, accepts `1.18.15` and later stable 1.x, rejects 2.x, malformed versions, and prereleases. `llm-adapter.ts` consumes that single policy instead of maintaining a second minimum constant.

The missing-health `pinned-compatibility` path remains explicit for the exact verified v1.18.15 generated SDK, which lacks that health surface.

### F. Graceful structured-host degradation is tested at the writer boundary

**File:** `test/memory/writer-llm.test.ts`.

The `1.18.14` integration case verifies the important order:

1. heuristic memory persists;
2. host gate rejects optional structured extraction;
3. `session.create` remains zero;
4. `session.prompt` remains zero;
5. no LLM/human trust is minted;
6. outcome remains the nonfatal heuristic fallback.

The supported `1.18.15` control still exercises the normal structured path.

### G. Structured-output compatibility casts remain isolated

**File:** `src/memory/llm-adapter.ts`.

The deliberate v1.18.15 wire-contract gap is still handled in one adapter. PR 4 did not spread response-envelope casts through writer/extraction code merely to satisfy incomplete generated declarations.

### H. Peer/dev/installed package versions agree

`package.json` declares:

```text
peer: >=1.18.15 <2.0.0
dev:  1.18.15
```

and the package-metadata tests in the observed Actions run passed, including the installed-version assertion for `1.18.15`.

---

## 6. Out of scope

Do not block PR 4 on the following later CRIP workstreams:

- PR 5 — immutable source processing identity, source idempotency, recall-recency semantics, and truthful idle outcomes;
- PR 6 — the remaining complete LLM trust/evidence boundary;
- PR 7 — compaction quality and anti-drift;
- PR 8 — final durable storage and compaction-injection byte budgets;
- PR 9 — diagnostic/artifact accuracy and process-global diagnostic cleanup;
- PR 10 — dependency-audit classification, release artifact reproducibility, installer checksums/immutability, and distribution hygiene.

The existing npm audit findings remain PR 10 scope.

The unrelated `activity-state` timing failure should not be used as a reason to redesign PR 4's host boundary, although a green release-candidate CI run remains required before Ship.

---

## Release-gate summary

**PR 4 is close, but not ready to Ship.**

The production host-client ownership, OpenCode file routing, peer/runtime version policy, tool input schemas, structured adapter boundary, and heuristic fallback behavior are all in good shape.

The blocker-fix wave should stay narrow:

1. route **all** `head_files` output paths (success, empty, error) through the final deterministic response cap, with regression tests at `_headFiles()` level; and
2. commit the `verify:host-contract` GitHub Actions step and obtain a fully green CI run for the resulting release candidate.

After those two items are demonstrably closed, PR 4 should be suitable for a focused final re-review rather than another broad implementation wave.
