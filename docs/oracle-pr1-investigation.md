# Third-Party Oracle: PR 1 Release-Gate Investigation

You are the third-party reviewer for PR 1 of `docs/implementation-plan.md` in the
TokenMaxxer repository (commit `8dee315`, branch `main`, on
`https://github.com/thehun927/TokenMaxxer`). This prompt is the release-gate
investigation: an independent reviewer who did not participate in the
implementation, examining the change with fresh eyes and an adversarial
posture.

Do not look for stylistic nits. Look for the things that will hurt users,
silently corrupt state, pass tests but break in production, or contradict the
plan. The implementation team believes this is ready to ship; your job is to
either confirm that with specific evidence, or surface concrete issues that
must be fixed before ship.

---

## What was changed (summary — verify against the diff)

1. **Schema (`src/memory/schema.ts`):** additive `revision` field on
   `MemoryFileBaseSchema` (`z.number().int().nonnegative().default(0)`);
   `emptyMemory()` initialises it to 0.
2. **New paths module (`src/memory/paths.ts`):** leaf module exporting
   `resolveProjectPath`, `projectMemoryPath`, `globalProjectStorageDir`,
   `globalMemoryPath`, `projectStorageHash`.
3. **Typed fs (`src/util/fs.ts`):** new `FileReadResult` discriminated union
   and `readFileResult()` distinguishing `ok` / `missing` / `error`;
   `atomicWrite` temp files are now `${path}.tmp.${pid}.${uuid}` with
   best-effort orphan cleanup.
4. **Storage authority (`src/memory/store.ts`):** new `readMemoryState()`
   returning `MemoryReadResult` (`memory`, `source`, `path`, `sizeBytes`,
   `revision`); local/global resolution by revision with project-tie-break;
   both candidate mtimes tracked in the cache; `readMemory` reduced to a
   wrapper.
5. **Writer (`src/memory/writer.ts`):** non-git worktree no longer records
   `"/"` as `project_path`; `generateHeader` calls are wrapped in
   `writeHeaderBestEffort` so a HEADER failure no longer changes the STATE
   write outcome.
6. **Status (`src/tools/status.ts`):** consumes `readMemoryState`; adds
   `Memory source:` and `Memory revision:` lines; removes the redundant
   `safeRead` re-read of the local path.

Test additions: `paths.test.ts` (10), `store.test.ts` (10),
`status-extended.test.ts` (4), `writer-header.test.ts` (3),
`writer-nongit.test.ts` (3), `fs.test.ts` (9), plus extensions to
`schema.test.ts` and `status.test.ts`.

CI signal at the time of submission: `npx tsc --noEmit` clean, 243 tests
pass across 27 files.

---

## What to investigate (in order of priority)

### 1. Atomicity of `readMemoryState` under concurrent writers

This is the most consequential part of PR 1. The function now reads BOTH
candidates, picks one, and the writer is unchanged. Does the new read path
introduce any race where:

- Two callers in the same process each read project-local, both decide the
  cache is stale, both write, and the second overwrites the first's STATE
  with stale-data merged in?
- A reader's cache contains a "selected" result computed from project-local
  mtime = T1 and global mtime = T2, then a writer writes only the global
  file at mtime T3 > T2 — does the reader correctly see the new global on
  the next call?
- A reader returns a stale selected result because the cache key is
  `project` but the user mutated a path that aliases a different
  `project` value? (E.g. `worktree` and `directory` both resolving to the
  same `project` via different inputs — is the dedup sound?)

The plan section §4 explicitly forbids "silent empty initialization from an
unresolved read error." Verify there is no path in the new code that, given
a real unreadable file, falls through to `emptyMemory(project)`.

### 2. Revision field semantics

- Is `revision` actually monotonic? Where is it incremented, and is that
  increment reliably inside the project queue (see `src/memory/lock.ts`)?
  If a writer could bypass the project queue, two writers could race on
  the revision and one could end up with a lower revision than the
  on-disk state. PR 2 is supposed to address cross-process transactions;
  PR 1 should at least not make this worse.
- Is the read path consistent with the write path? I.e. if a writer
  sets `revision: 5` and the file is renamed, the reader should observe
  `revision: 5`. Look for any place the revision is read from a stale
  copy, re-derived, or re-defaulted.
- For v2 STATE files (no `revision` field), the new code defaults to 0.
  Is there any code path that would interpret a v2 file as "higher
  revision than a freshly-written v3 file"? That would be a silent
  downgrade.

### 3. `FileReadResult` — does the error/missing distinction actually hold?

`readFileResult` claims to distinguish `ENOENT` (missing) from any other
failure (error with code). Verify:

- The `stat` then `readFile` sequence is not racy in a way that mislabels
  a file that disappears between the two calls. The current implementation
  should be safe (the `stat` mtime is reused), but check.
- The `error` branch's `code` is the OS errno (`EACCES`, `EISDIR`, etc.).
  Does any caller of `readFileResult` that switches on `kind === "error"`
  need to do anything different for different error codes? (E.g. should
  `EACCES` be treated differently from `EISDIR`? The plan treats them
  the same; confirm that's correct.)
- The `safeRead()` function is still present and still used somewhere
  (`index.ts` for HEADER init, possibly more). Is the migration of callers
  to the typed API complete, or are there remaining call sites where a
  silent `null` from `safeRead` is now masking a real error? This is the
  exact bug class the typed read was designed to prevent.

### 4. Atomic write temp file uniqueness

The plan §8 requires the temp file to be unique per invocation, not just
per PID. The new code uses `${path}.tmp.${pid}.${randomUUID()}`. Verify:

- Two concurrent `atomicWrite` calls in the same process can no longer
  collide. The test claims this is covered, but check whether the test
  actually proves it (e.g. is the test deterministic, or does it depend
  on PID reuse?).
- The `rm(tmp, { force: true }).catch(() => {})` cleanup of the orphan
  temp on rename failure is best-effort. If cleanup silently fails, is
  there any scenario where a stale `.tmp.<pid>.<uuid>` accumulates in the
  memory directory? Look for any periodic cleanup, and if there is
  none, decide whether that's a release-blocker.
- `randomUUID()` is `crypto.randomUUID` — confirm Node 18+ has it
  (per `engines.node >= 18` in `package.json`). No polyfill is
  present; is that intentional?

### 5. Non-git worktree identity

The plan §6 requires that `project_path` is the resolved project, not
`"/"`. The fix in `writer.ts` adds `const project =
resolveProjectPath(...)` in `writeMemoryOnIdleSerialized` and
`mergeAsyncFacts` and changes `emptyMemory(worktree)` →
`emptyMemory(project)`. Verify:

- Every place in `writer.ts` that constructs a fallback memory uses
  `project`. Are there any places that still pass `worktree`?
- `store.ts` was not in the fix's scope. Does `readMemory` (now a wrapper
  around `readMemoryState`) correctly use the resolved project when
  constructing an empty fallback? Read the current code — if a caller
  gets a null memory, the fallback in `writeMemoryOnIdleSerialized` is
  `emptyMemory(project)`, but is that the only fallback site?
- The status tool also reads memory but does not construct a fallback;
  confirm.

### 6. HEADER best-effort

The plan §7 requires HEADER failure to be a warn log, not a STATE-write
rejection. Verify:

- The `writeHeaderBestEffort` helper is called from all three sites in
  `writer.ts` (heuristic, LLM cache, `mergeAsyncFacts`). Are there any
  new or existing call sites of `generateHeader` that were missed?
- The helper calls `writerModule.generateHeader` (via the namespace
  import). This is so tests can `vi.spyOn` it. Verify the production
  call site is functionally equivalent to a direct call (no extra
  indirection cost, no module-loading surprise, no tree-shaking issue).
- The `src/index.ts` plugin init still calls `generateHeader` directly
  (not the best-effort wrapper) for the placeholder HEADER.md. Is that
  intentional? The plan only makes the writer paths best-effort, but
  the index.ts init has a `try/catch` that already swallows failures.
  Is the behavior equivalent?

### 7. Status refactor

The plan §9 requires status to consume `readMemoryState`. Verify:

- The output format preserves every existing line and adds exactly
  `Memory source:` and `Memory revision:` in the right place. Compare
  against the diff for `src/tools/status.ts`.
- When `readMemoryState` returns `{ memory: null, source: null, ... }`,
  the status output is `Memory file: none` (or similar). The original
  code did `path = join(project, ...)` and reported that as `Memory
  file:` even when the file was missing. The new code should not
  invent a path that doesn't exist.
- `resolveProjectPath` is still imported in `status.ts` for the queue
  status lookup. Is that lookup correct? Specifically, does the
  queue status use the same `project` resolution as the memory read?
  If not, the status output may describe memory at one path and queue
  activity at another.
- The `lastCompactionTimestamp` module-level state and `setLastCompaction`
  hook are still present. Verify they are wired correctly.

### 8. Test coverage gaps

For each of the ten new `store.test.ts` cases, ask: does this test
actually prove the property, or does it pass for an unrelated reason
(e.g. both branches return the same thing for this input)?

Specific concerns:

- The "non-git worktree" test: is the assertion strong enough? It
  should verify that NO path under `"/"` is ever created.
- The "local unreadable + no global" test: in a root/CI environment
  where chmod 000 is unreliable, the test falls back to a directory
  read. Does that actually prove the code handles a real `EACCES`,
  or only an `EISDIR`? Document the assumption.
- The "selected source changes after cache fill" test: is the sleep
  or mtime-bump enough to ensure the second read sees a different
  mtime on a fast filesystem? Some filesystems have 1-second mtime
  resolution.
- The HEADER test only covers the heuristic path; the LLM path is
  deferred. Is that deferred coverage a release risk?

### 9. Backwards compatibility

- A user upgrading from a previous TokenMaxxer version has STATE.json
  files without `revision`. They load with `revision: 0`. A new write
  sets `revision: 0` (or higher — but where?). What happens to two
  users on the same project, one with old code, one with new code?
  The plan acknowledges this is a graceful additive migration, but
  verify there is no read path that crashes on missing `revision`.
- `opencode.json` was modified outside this commit (config change).
  Confirm this is not a hidden breaking change to the plugin's
  expected config schema.

### 10. Code quality / maintainability

- The cache value in `store.ts` is a structural object with nested
  optional fields. Is the type clean? Are any fields unused?
- `readMemoryState` accepts `bypassCache?` and `client?`. Are these
  used anywhere? If not, are they part of the public API for a reason?
- The `backupCorrupt` helper is still in `store.ts`. Is it reachable
  from the new read path? Trace the call.
- The `safeRead` re-export from `src/util/fs` is still there. Is
  it still needed by any caller outside the plugin init in `index.ts`?
  If it's only used in one place, that's fine; if it's spread, future
  authors may be tempted to use it and reintroduce the missing/error
  conflation.

---

## Deliverable

Write your findings as a single markdown document. Structure:

1. **Verdict** — Ship / Ship-with-fixes / Block (one line).
2. **Blocking issues** — file:line, reproduction, recommended fix.
3. **Non-blocking concerns** — file:line, why they matter, suggested
   follow-up.
4. **Test gaps** — scenarios that the test suite does not cover,
   ranked by likelihood × impact.
5. **Things that look fine** — call out at least three properties you
   verified and confirmed correct, with file:line evidence. This is
   not optional; it calibrates the trust of the report.
6. **Out of scope** — anything you noticed that is not PR 1 (e.g.
   issues in `writer.ts` that are slated for PR 3) and should not
   block this PR.

Be specific. Do not say "consider refactoring X" without pointing to
the exact line and explaining what concrete failure mode you are
worried about. Do not pad with generalities.

If you would block the PR, do so with one decisive reason per blocker.
A release gate with five vague concerns is not useful; a release gate
with two precise blockers is.
