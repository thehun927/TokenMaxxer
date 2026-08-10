# Third-Party Oracle: PR 2 Release-Gate Investigation

You are the third-party reviewer for PR 2 of `docs/pr2-implementation-plan.md`
in the TokenMaxxer repository. PR 2 makes STATE mutations transactional
across multiple TokenMaxxer/OpenCode processes via a cross-process project
lock (`withProjectLock`) and a single canonical mutation primitive
(`mutateMemory`). This prompt is the release-gate investigation: an
independent reviewer who did not participate in the implementation,
examining the change with fresh eyes and an adversarial posture.

Read the plan first: `docs/pr2-implementation-plan.md` (827 lines).
The implementation commit range is `46f3d6e..401fe8d` on `main`.

What was shipped (verify against the diff):

- Wave 1 (`46f3d6e`): cross-process project lock primitive in
  `src/memory/project-lock.ts` (`withProjectLock`, `tryAcquireProjectLock`,
  `ProjectLockOwnerSchema`, `LockClassification`, `ProjectLockHandle`,
  `ProjectLockTimeoutError`). Lock is a directory under the global hashed
  project namespace; published atomically via candidate-directory rename;
  ABA-safe stale recovery; nonce-checked release; portable
  destination-exists detection. 13 child-process tests in
  `test/memory/project-lock.test.ts`.
- Wave 2 (`7c7367b`): `commitMemoryExact` (module-private) and
  `mutateMemory<T>` (canonical mutation primitive) in `src/memory/store.ts`;
  `writeMemory` refactored to write the supplied revision exactly
  (no advancement). 4 in-process mutateMemory tests + 8 cross-process
  transaction tests + child fixture in `test/fixtures/transaction-worker.ts`.
- Wave 3 (`5afbedf`): heuristic idle-merge transaction in
  `writeMemoryOnIdleSerialized` migrated behind `mutateMemory` with
  `bypassCache:true`; pre-lock work stays outside the lock;
  `markReferencedDecisions` made pure and called on the locked read base.
  3 writer.test.ts tests.
- Wave 4 (`77e0034`): all five LLM lifecycle mutations (`persistAudit`,
  `persistTerminal`, `onHealthOutcome`, cache-hit `mergeAsyncFacts`,
  final-LLM merge) behind `mutateMemory`; cache identity rechecked under
  the lock; LLM prompt/retry/timeout/host-call work stays outside the lock.
- Wave 5 (`00de9f9`): `_recallPromote` in `src/tools/recall.ts` migrated
  behind `mutateMemory`; promotion authority semantics unchanged per §11.G
  (deferred to PR 3). 27 recall tool tests + 2 cross-process recall tests.
- Wave 6 (`401fe8d`): bypass audit confirmed exactly one logical
  mutation route (`mutateMemory`); 6 Wave-4-deferred tests + 4 §15
  release-gate tests added; 5x adversarial run of the cross-process
  suites, zero flakiness. Writer extracted 5 named test seams
  (`persistAuditGuard`, `persistTerminalTransaction`, `persistModelHealth`,
  `finalLLMMerge`, `mergeAsyncFacts`) with no production behavior change.

CI signal at submission: `tsc --noEmit` clean; 30 test files / 302 tests
pass. The cross-process suites (transaction, project-lock, recall,
p0-a-reliability, writer-llm, writer, store) passed 5 consecutive runs.

`docs/pr2-blockers.md` is the live implementation decision log; it
records wave-by-wave design decisions, test gaps, and the empty-result
anomaly from the Wave-4 dispatched agent (production code shipped,
summary was empty; tsc and full vitest were green).

---

## What to investigate (priority order)

### 1. Lock primitive correctness — ABA-safe quarantine

The lock is a directory at `<globalProjectStorageDir(project)>/.state-lock`,
published atomically by renaming a fully-initialized candidate directory.
Verify:

- Two contenders cannot both rename the same `.state-lock` into their own
  stale-recovery directory; only the winner of the atomic rename owns the
  recovery, the loser observes the missing lock and re-acquires cleanly.
- A replacement lock acquired between the dead-owner detection and the
  quarantine rename is NOT stolen. The current code does this by re-reading
  classification after a failed quarantine rename; verify the re-read is
  correct and does not race with another contender.
- A dead-owner recovery cannot delete a NEWLY ACQUIRED lock. Trace the
  recovery path: after quarantine succeeds, the loser sees the lock is
  gone and attempts normal acquisition. If a NEW process acquired the
  lock during that window, can the recoverer accidentally delete it?
  Look at the path from `kind: "dead-same-host"` → quarantine rename
  → best-effort rm → retry normal acquisition.
- The portable destination-exists detection covers both POSIX errnos and
  Windows/platform message variants. Is the message-based fallback
  reliable enough for `ENOTEMPTY` and `EEXIST` on non-Linux platforms?
  Verify the regex/string match does not produce false positives (e.g.
  "already exists" inside an unrelated error message).

### 2. Foreign-host lock stealing — conservative by design

Per plan §6 "Foreign host", the implementation does not use local PID
checks on a foreign hostname and never steals. Verify:

- The PID liveness check (`process.kill(pid, 0)`) is gated behind
  `owner.hostname === os.hostname()`. A foreign-host lock must NEVER
  trigger `process.kill`.
- On a SHARED FILESYSTEM (NFS, SMB, overlay mounts), this policy means
  a foreign-host lock will time out instead of being stolen. Is there
  any code path that does steal it? Search for `os.hostname` usage and
  confirm the only kill is hostname-gated.
- The plan explicitly avoids distributed-lock claims. Confirm there is
  no heartbeat, no TTL, no time-based ownership claim — only the
  metadata in `owner.json`. A process that crashes mid-transaction and
  cannot update `owner.json` is recovered via dead-PID detection only,
  not by timeout.

### 3. mutateMemory correctness — bypassCache + fail-closed + exactly-once

The canonical mutation primitive is `mutateMemory<T>` in
`src/memory/store.ts`. Verify:

- `mutateMemory` ALWAYS reads with `bypassCache: true` inside the lock.
  Even if a caller passes `bypassCache: false`, the implementation must
  not honor it. Confirm the implementation forces bypass.
- On `state.status === "unavailable"`, `mutateMemory` returns
  `{ status: "unavailable" }` WITHOUT calling `emptyMemory(project)`.
  Confirm there is no path in the callback that constructs a fresh
  empty memory on `unavailable`.
- Revision advances exactly once from the AUTHORITATIVE BASE READ UNDER
  THE LOCK, not from a stale caller-supplied memory. Verify the
  callback receives `base` and uses `base.revision + 1` — there must
  be no place where `action.memory.revision` is used directly to
  derive the persisted revision.
- A no-op mutation (`{ kind: "noop" }`) does NOT advance revision.
  Trace the path: callback returns noop → result is
  `{ status: "noop", value, revision: base.revision }` → no commit
  → cache not invalidated for the no-op's "write" (or is it? verify
  what happens to the cache when a transaction returns noop).
- A thrown callback releases the lock. The plan calls for this. Verify
  `withProjectLock`'s finally block runs even when the operation
  throws. Confirm `mutateMemory` propagates the throw (not swallow it
  into `{ status: "commit-failed" }`).
- `ProjectLockTimeoutError` maps to `{ status: "lock-timeout" }`;
  other errors propagate. Confirm the mapping is correct and that
  any unexpected lock-state-classification (e.g. unknown-owner) is
  handled — does it time out, return a status, or throw?

### 4. No-lock zone discipline — LLM prompt must not be held

Plan §12 says: model resolution, provider health, host calls, LLM
prompt/retry/timeout — NONE of these may occur while the project lock
is held. Verify:

- `extractFactsLLM(...)` and its callback chain (prompt, retries,
  transport) are called OUTSIDE `mutateMemory`'s lock.
- `getLLMConfig(...)` for both cache-config (no health gate) and
  final-config (with health gate) is called outside the lock.
- The `persistAudit` transaction is its OWN transaction — the LLM
  prompt does NOT start until `persistAudit` returns success.
- The `persistTerminal` and `onHealthOutcome` transactions are
  independent and happen after the prompt returns.
- The final-LLM transaction re-checks the cache identity under the
  lock (per Wave 4 fix). Confirm this re-check uses the LOCKED READ
  base, not a pre-lock snapshot.
- Look for ANY callback that might inadvertently run inside a
  transaction: `session.create`, `session.prompt`, model discovery,
  health gates, etc.

### 5. Writer migration completeness — every STATE mutation site

The bypass audit in Wave 6 found no remaining unsafe STATE-write path.
Independently verify:

- Search `src/` for every call to `writeMemory`, `commitMemoryExact`,
  `atomicWrite` to a STATE.json path, and `readMemory`/`readMemoryState`
  followed by any mutation. Confirm each match is in an allowed
  location (transaction callback, HEADER init, low-level primitive).
- The `_recallPromote` migration in Wave 5 is the only tool-driven
  mutation. Are there any other tools that mutate STATE — recall
  invalidate, future tools, debug tools, hidden helpers? Search
  exhaustively.
- The `markReferencedDecisions` helper is now pure and called inside
  the Wave-3 heuristic transaction. Confirm no caller invokes it
  with mutation expectations (e.g. directly mutating `mem.decisions`
  in place after the call).
- The HEADER placeholder in `src/index.ts` still uses `atomicWrite`
  directly. The plan §7 says this is best-effort and acceptable. Is
  the error-handling around it correct (try/catch with no rethrow)?
  Is the placeholder content correct (a comment-only file)?

### 6. Cross-process tests — actually testing concurrency

Verify the 8 transaction.test.ts tests, 2 recall.test.ts cross-process
tests, and the 6 Wave-4-deferred writer-llm.test.ts tests actually
exercise child processes, not just two promises in one Vitest process.

- Each test should fork a real OS child via the transaction-worker
  fixture or project-lock-worker fixture.
- Barrier-driven coordination: the fixture should write a barrier file
  and wait for a corresponding release barrier. Sleeping is acceptable
  only as a fallback when barriers are impractical; prefer barriers.
- The 5x adversarial run produced zero flakiness. Is this evidence of
  correctness or evidence of underspecified timing assertions? Look
  for any test that "always passes because both children serialize
  through the lock anyway" and would still pass if the lock were
  broken.

### 7. Process-local queue interaction

The process-local queue in `src/memory/lock.ts` is documented as an
"outer optimization layer" while the cross-process lock in
`withProjectLock` is the durability boundary. Verify:

- `writeMemoryOnIdleSerialized` still calls `enqueueProjectJob` first
  (process-local queue). The inner STATE mutation then calls
  `mutateMemory` which calls `withProjectLock` (cross-process lock).
  This means: a single process serializes its own idle jobs
  per-project AND acquires the cross-process lock for each one.
- The process-local queue MUST NOT be acquired INSIDE `withProjectLock`.
  Search for `enqueueProjectJob` calls inside `mutateMemory` /
  `withProjectLock` callbacks. There should be none.
- An idle job that does not participate in the process-local queue
  (e.g. a future direct caller) must still be safe — the cross-process
  lock alone is sufficient. Verify this with a test, or document why
  the existing tests do not cover it.

### 8. Cache behavior inside transactions

Plan §9 says every transaction read must use `bypassCache: true`.
Verify:

- The implementation always passes `bypassCache: true` from
  `mutateMemory`. Search for any code path that reads inside a
  transaction callback without `bypassCache: true`.
- The PR-1 cache-skip-on-error behavior still works: when a candidate
  was unreadable on a previous call, the next call re-reads even if
  mtimes are unchanged. Does the cache-skip interact correctly with
  the lock? Specifically: a transaction that reads while the lock is
  held observes an `unavailable` candidate. The cache records this
  with `readResult.kind === "error"`. On the NEXT call (perhaps from
  a different process), the cache MUST be re-read, not reused as-is.
  Verify the cache key is per-process (the module-level `Map`) and
  the read-result invalidation is per-candidate.

### 9. Cross-platform and portability

Plan §4 says "Treat the rename error codes portably (`EEXIST`,
`ENOTEMPTY`, platform equivalents) rather than assuming one POSIX
errno." Verify:

- The implementation handles `EEXIST`, `ENOTEMPTY`, and Windows
  message variants. The Wave-1 report claims a regex fallback over
  `error.message` for Windows variants — verify the regex is not
  over-eager (e.g. matching "file already exists" inside an
  unrelated message).
- PID liveness on Windows: `process.kill(pid, 0)` has different
  semantics on Windows. Does the implementation handle the Windows
  ESRCH equivalent correctly, or does it assume POSIX?
- The `~/.config/opencode/memory/<hash>/.state-lock` path uses
  `homedir()`. On Windows, `os.homedir()` returns `%USERPROFILE%`;
  is the resolution consistent with the existing global fallback path
  in `src/memory/paths.ts`?
- `tsx` is required as a devDependency for child-process fixtures.
  Verify the package.json entry is correct and CI installs it
  (`npm ci` or equivalent).

### 10. Mixed-version safety

The plan §1 explicitly notes: "this PR can guarantee correctness only
between TokenMaxxer processes that implement this transaction protocol.
An older installed process that ignores the lock can still race a new
process. Do not claim mixed-version concurrency safety."

- The implementation does NOT log a version warning or refuse to
  start when an older process is detected. Is this acceptable per the
  plan, or should the implementation at least refuse to run if a
  `.state-lock` directory exists without a valid `owner.json`? (The
  unknown-owner path is documented to be conservative — retry until
  timeout — which is the right behavior. Confirm no further
  protection is implied by the plan.)
- An older process that calls `writeMemory` directly (no lock, no
  transaction) will write the STATE file. A new process that reads
  inside the lock will see the older write. The new revision
  advancement will be from the LOCKED READ base, so the older write
  will be preserved. Is this the intended interaction, or does the
  plan call for the older process to be detected and refused?

### 11. HEADER placement and lock interaction

The HEADER.md is written:
- In `src/index.ts` plugin init (best-effort, atomicWrite, try/catch).
- In `src/memory/writer.ts` `generateHeader` after each successful
  STATE write (now via `writeHeaderBestEffort`).

Verify:

- HEADER writes do NOT acquire the project lock. Confirm
  `writeHeaderBestEffort` (or its equivalent) does not call
  `withProjectLock` or `mutateMemory`.
- HEADER failure is genuinely best-effort: the writer returns
  `"heuristic-only"` / `"llm-success"` even when HEADER fails. Confirm
  the outcome mapping in the heuristic and LLM paths correctly handles
  HEADER failures.
- A HEADER write that succeeds but the corresponding STATE write
  later fails (e.g. due to a global fallback path) — does the HEADER
  become stale? The HEADER is derived from the in-memory `mem` before
  the write commit, so a successful HEADER + failed STATE write leaves
  a HEADER that describes a state that does not exist on disk. Is
  this acceptable? The plan calls HEADER "derivative" so the answer
  is probably yes, but document the behavior.

### 12. Migration cleanliness

- The dead `writeMemory` import in `src/memory/writer.ts` was removed
  in Wave 6. Are there other dead imports or unused exports left
  over from the migration?
- The 5 extracted writer test seams (`persistAuditGuard`,
  `persistTerminalTransaction`, `persistModelHealth`, `finalLLMMerge`,
  `mergeAsyncFacts`) are EXPORTED. Should they be? They are
  test-only by design; an internal API surface expansion. Is the
  test seam surface documented? Are they @internal or otherwise
  marked?
- `tsconfig.json` and `package.json` changes: `tsx` added as
  devDependency. Any other devDependencies needed? Any
  tooling/CI changes?

---

## Deliverable

Write your findings as a single markdown document. Structure:

1. **Verdict** — Ship / Ship-with-fixes / Block (one line).
2. **Blocking issues** — file:line, reproduction, recommended fix.
3. **Non-blocking concerns** — file:line, why they matter, suggested
   follow-up.
4. **Test gaps** — scenarios that the test suite does not cover,
   ranked by likelihood × impact. Specifically note any of the §15
   release-gate tests that you could not verify are covered.
5. **Things that look fine** — call out at least three properties
   you verified and confirmed correct, with file:line evidence.
   This is not optional; it calibrates the trust of the report.
6. **Out of scope** — anything you noticed that is slated for PR 3
   (decision authority, promotion trust, foundational retention) or
   later and should not block this PR.

Be specific. Do not say "consider refactoring X" without pointing to
the exact line and explaining what concrete failure mode you are
worried about. Do not pad with generalities.

If you would block the PR, do so with one decisive reason per
blocker. A release gate with five vague concerns is not useful; a
release gate with two precise blockers is.

Pay particular attention to investigation areas 1, 3, 4, and 6.
These are the properties that distinguish a release-gate-correct
implementation from one that merely compiles and passes local
tests.