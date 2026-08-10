# PR 2 Implementation Plan — Cross-Process Project Transactions

> **Status:** ready for implementation  
> **Baseline:** `34b2602e2fcdf6c2d6cc68a8ecd1bbf2b44e378f`  
> **Resolves:** I1 — cross-process read/modify/write lost updates  
> **Depends on:** PR 1 storage authority and read semantics  
> **Followed by:** PR 3 decision authority and promotion trust

## Executive summary

PR 1 established an authoritative local/global STATE reader, monotonic revision metadata, explicit `ok | missing | unavailable` read outcomes, non-git project identity, and safe fallback persistence.

PR 2 makes those guarantees transactional across **multiple TokenMaxxer/OpenCode processes**.

The current process-local queue prevents two idle jobs inside one Node process from clobbering each other, but another OpenCode process can still:

1. read revision N;
2. independently derive a replacement STATE;
3. race another process that also read revision N;
4. commit last and silently discard the other process's mutation.

PR 2 must make every logical STATE mutation follow one durability boundary:

```text
acquire project lock
        ↓
bypass cache and read authoritative STATE
        ↓
fail closed if STATE is unavailable
        ↓
apply one short in-memory mutation
        ↓
advance revision exactly once
        ↓
commit exact next STATE atomically
        ↓
release project lock
```

The filesystem lock must **never** be held across an LLM request, host API request, transcript fetch, model discovery, retry delay, or other potentially long operation.

---

# 1. Hard invariants

PR 2 is complete only if all of the following are true:

```text
1. One resolved project path -> one cross-process transaction key.
2. Local and global STATE for that project use the same transaction key.
3. Every read/modify/write mutation reads STATE after acquiring the lock.
4. Transaction reads always bypass the process cache.
5. `unavailable` STATE never authorizes empty initialization.
6. One committed logical mutation advances revision exactly once.
7. A no-op mutation does not advance revision.
8. Raw persistence never advances revision by itself.
9. A failed commit does not claim a durable revision advancement.
10. No LLM/network/host call occurs while the project lock is held.
11. A live same-host lock is never stolen.
12. A dead same-host owner can be recovered safely.
13. A foreign/unknown-host lock is never stolen automatically.
14. Stale-lock recovery cannot delete a newly acquired replacement lock.
15. Different projects do not serialize on one global lock.
16. Process-local queuing remains an optimization/coalescing layer, not the durability boundary.
```

Mixed-version limitation: this PR can guarantee correctness only between TokenMaxxer processes that implement this transaction protocol. An older installed process that ignores the lock can still race a new process. Do not claim mixed-version concurrency safety.

---

# 2. Primary files

Expected production files:

- new `src/memory/project-lock.ts`
- `src/memory/store.ts`
- `src/memory/writer.ts`
- `src/memory/lock.ts`
- `src/tools/recall.ts`
- possibly `src/memory/paths.ts` for a centralized lock-path helper

Expected tests/fixtures:

- new `test/memory/project-lock.test.ts`
- new `test/memory/transaction.test.ts`
- new child-process fixture(s) under `test/fixtures/`
- updates to writer, recall, store, and reliability tests

If a TypeScript child-process harness requires it across the supported Node range, add a small explicit dev dependency such as `tsx`; do not rely on Node 22-only type stripping while `package.json` still supports older Node versions.

---

# 3. Lock namespace and identity

Use the same resolved project identity introduced in PR 1:

```ts
const project = resolveProjectPath(worktree, directory)
```

The lock must live in the **global hashed project namespace**, not in the worktree:

```text
~/.config/opencode/memory/<project-hash>/.state-lock/
```

Recommended helper:

```ts
export function projectLockPath(project: string): string {
  return join(globalProjectStorageDir(project), ".state-lock")
}
```

Why global storage:

- read-only worktrees still need locking;
- local and global STATE must share one lock;
- multiple processes resolving the same project get the same key;
- unrelated projects retain independent locks.

Do not derive a second hash or alternate project identity for locking.

---

# 4. Publish a fully initialized lock atomically

A plain sequence of:

```text
mkdir .state-lock
write .state-lock/owner.json
```

creates a crash window where a visible lock has no owner metadata.

Prefer publishing a fully initialized **candidate directory**:

```text
.state-lock.candidate.<pid>.<nonce>/
    owner.json
```

Acquisition flow:

1. ensure the global project storage directory exists;
2. create a unique candidate directory;
3. write bounded `owner.json` inside it;
4. atomically rename the candidate directory to `.state-lock`;
5. if `.state-lock` already exists, acquisition lost — remove the candidate and inspect the current owner;
6. retry with bounded jitter/backoff until acquired or timed out.

The published lock directory is therefore never intentionally empty.

Treat the rename error codes portably (`EEXIST`, `ENOTEMPTY`, platform equivalents) rather than assuming one POSIX errno.

Best-effort cleanup of abandoned candidate directories is acceptable, but candidate directories must never block acquisition; only the canonical `.state-lock` path is authoritative.

---

# 5. Lock owner metadata

Use bounded, non-sensitive metadata only. Do not persist transcript text, project contents, commands, prompts, or absolute project paths inside the owner record.

Recommended shape:

```ts
type ProjectLockOwner = {
  version: 1
  pid: number
  hostname: string
  acquired_at: string
  nonce: string
}
```

Bounds should be explicit, for example:

- `pid`: positive integer;
- `hostname`: <= 255 chars;
- `acquired_at`: bounded ISO timestamp;
- `nonce`: UUID or similarly bounded random token.

The nonce identifies one acquisition instance and should be used when deciding whether the current process still owns the lock it is attempting to release.

Malformed or unreadable owner metadata is **unknown ownership**, not proof of a stale lock.

---

# 6. Lock acquisition state machine

Implement a small explicit state machine rather than scattering retry logic through callers.

Suggested API:

```ts
export async function withProjectLock<T>(
  project: string,
  operation: () => Promise<T>,
  options?: ProjectLockOptions,
): Promise<T>
```

Production options should use bounded defaults. Test-only callers may supply short timeouts/backoff intervals so concurrency tests remain fast and deterministic.

Suggested behavior when `.state-lock` exists:

## Same host + live PID

Treat as actively owned.

- do not steal;
- wait with bounded exponential/jittered backoff;
- stop at acquisition timeout;
- report a typed/bounded lock-timeout failure.

PID liveness check:

```ts
process.kill(pid, 0)
```

Interpret conservatively:

- success -> live;
- `EPERM` -> process exists or cannot be inspected; treat as live/unknown;
- `ESRCH` -> dead;
- unexpected error -> unknown, do not steal.

PID reuse can cause a dead historical lock to look live. That is acceptable: conservative timeout is safer than stealing a live lock.

## Same host + dead PID

Eligible for stale recovery.

Do **not** delete `.state-lock` directly after inspection.

Use ABA-safe quarantine:

```text
.state-lock
    ↓ atomic rename
.state-lock.stale.<nonce>
    ↓
best-effort recursive delete
```

Only the process that successfully renames the canonical stale lock owns that recovery attempt. If rename fails, another contender changed the lock; re-read current ownership and retry.

After quarantine, retry normal acquisition rather than assuming ownership.

## Foreign host

Do not use local PID checks to infer remote liveness.

- do not steal;
- retry until the bounded timeout;
- fail conservatively.

This intentionally avoids unsafe distributed-lock claims on shared filesystems.

## Missing/malformed owner metadata

Treat as unknown ownership.

- do not silently delete;
- retry until bounded timeout;
- emit a bounded diagnostic.

Because new locks are published with metadata already present, missing metadata should represent corruption, manual intervention, or a legacy/abnormal state rather than a normal acquisition window.

---

# 7. Lock release

`withProjectLock()` must release from `finally` on normal return or thrown operation errors.

Before deleting the lock, verify the current owner nonce still matches the acquisition nonce. If ownership no longer matches, do not remove the canonical lock.

Release failures must be logged/returned as bounded diagnostics, but must not cause the process to delete an unrecognized lock.

A process crash may bypass `finally`; dead-owner recovery is the recovery path for that case.

---

# 8. Separate logical mutation from raw persistence

PR 1 currently advances `revision` inside `writeMemory()`.

That was correct for PR 1 because `writeMemory()` was the only durable mutation boundary. It becomes the wrong ownership model once PR 2 adds `mutateMemory()`: if both the transaction layer and raw writer increment revision, one logical mutation can advance revision twice.

Refactor persistence into two concepts.

## Raw exact commit

Conceptually:

```ts
async function commitMemoryExact(
  context: MemoryContext,
  memory: MemoryFile,
): Promise<CommitResult>
```

Properties:

- validates schema;
- enforces the byte cap;
- serializes the supplied revision **exactly**;
- tries project-local atomic write first;
- falls back to global atomic write;
- invalidates process cache on success/failure as appropriate;
- does **not** increment revision;
- does **not** perform a preceding read;
- is not a general runtime mutation API.

Keep it private/internal enough that application code cannot accidentally reintroduce stale full-state writes.

## Canonical logical mutation

Expose one runtime mutation primitive, preferably from `store.ts` so the exact commit can remain private:

```ts
type MutationAction<T> =
  | { kind: "commit"; memory: MemoryFile; value: T }
  | { kind: "noop"; value: T }

type MemoryMutationResult<T> =
  | { status: "committed"; value: T; revision: number }
  | { status: "noop"; value: T; revision: number }
  | { status: "lock-timeout" }
  | { status: "unavailable" }
  | { status: "commit-failed" }

export async function mutateMemory<T>(
  context: MemoryContext,
  mutate: (
    memory: MemoryFile,
    state: MemoryReadResult,
  ) => MutationAction<T>,
): Promise<MemoryMutationResult<T>>
```

Make the mutation callback **synchronous**. This deliberately discourages accidental network/LLM/host waits while the filesystem lock is held.

Conceptual implementation:

```ts
return withProjectLock(project, async () => {
  const state = await readMemoryState({
    worktree,
    directory,
    client,
    bypassCache: true,
  })

  if (state.status === "unavailable") {
    return { status: "unavailable" }
  }

  const base = state.status === "ok"
    ? state.memory
    : emptyMemory(project)

  const action = mutate(base, state)

  if (action.kind === "noop") {
    return {
      status: "noop",
      value: action.value,
      revision: base.revision,
    }
  }

  const next: MemoryFile = {
    ...action.memory,
    revision: base.revision + 1,
  }

  const committed = await commitMemoryExact(context, next)
  if (!committed.ok) {
    return { status: "commit-failed" }
  }

  return {
    status: "committed",
    value: action.value,
    revision: next.revision,
  }
})
```

Important: derive the next revision from the **authoritative base read under the lock**, not from a stale memory object supplied by the caller.

---

# 9. Cache behavior inside transactions

Every transaction read must use:

```ts
bypassCache: true
```

The process cache remains valid for ordinary read-only/status/recall access, but correctness-sensitive read/modify/write transactions must inspect disk after lock acquisition.

This closes the remaining PR 1 non-blocking cache concern for mutation paths: even if an externally replaced readable file preserves an observable mtime, a transaction must not reuse a stale cached base.

Add a regression where:

1. process cache contains revision 1;
2. STATE is externally replaced with revision 5;
3. cache invalidation signals are intentionally made ambiguous/same-mtime if practical;
4. `mutateMemory()` must read revision 5 under the lock and commit revision 6.

---

# 10. Process-local queue ordering

Keep `src/memory/lock.ts`'s process-local queue for:

- same-source coalescing;
- ordering idle jobs inside one process;
- queue/status diagnostics.

But document the lock order:

```text
process-local queue (optional outer layer)
        ↓
cross-process project lock (durability layer)
```

Do not introduce code that acquires the cross-process lock and then waits for the process-local queue for the same project.

The filesystem transaction must still be correct if a future mutation caller does not participate in the process-local queue.

---

# 11. Migrate every STATE mutation site

PR 2 is not complete if only the heuristic write uses `mutateMemory()`.

Search the repository for every path that can replace STATE and route each through the canonical mutation primitive.

## A. Heuristic idle merge

Before acquiring lock:

- fetch transcript;
- derive heuristic facts;
- fetch Git SHA;
- construct evidence candidates.

Then one short transaction:

```text
LOCK
read latest bypassing cache
merge heuristic facts onto latest
record recency/reference metadata
prune
commit revision +1
UNLOCK
```

Do not pass a pre-lock STATE snapshot into the transaction as authority.

## B. Audit guard creation

`onAuditCreated` receives the audit record after host/model setup.

Use one transaction:

```text
LOCK -> read newest -> upsert audit -> prune -> commit -> UNLOCK
```

If lock/read/commit fails, return `false` so prompting does not continue without a durable guard.

## C. Audit terminal outcome

Use a fresh transaction. If the audit row no longer exists, return `noop` rather than bumping revision for no state change.

## D. Model health

Use a fresh transaction. Health metadata is best effort, but it must not overwrite newer durable facts. On transaction failure, skip/log; do not fall back to a stale full-state write.

## E. LLM cache/final fact merge

After the LLM request completes, start a **new** transaction:

```text
LOCK
read newest STATE bypassing cache
check whether cache identity was already committed
merge accepted facts onto newest state
upsert cache/recency
prune
commit
UNLOCK
```

Never merge final LLM facts onto the pre-prompt state.

## F. Recall usage metadata

The later PR 5 will narrow which decisions count as referenced, but any current mutation of `last_used_in_session` must already be transactional in PR 2.

Read-only recall itself does not need the lock.

## G. Promotion

PR 3 will change promotion authority and human-review semantics. PR 2 should **not** redesign that policy yet.

It must, however, make the current mutation transactional so a concurrent idle write cannot erase it.

Keep policy changes out of this PR; only replace the unsafe read/modify/write mechanism.

## H. Future mutations

After migration, a repository search should show no production path performing a raw full-state read followed by raw full-state persistence outside `mutateMemory()`.

---

# 12. LLM lifecycle — explicit no-lock zones

Correct high-level lifecycle:

```text
fetch transcript / compute heuristics / git SHA       NO LOCK
                    ↓
LOCK -> heuristic read/merge/commit -> UNLOCK
                    ↓
model resolution / provider health / host calls       NO LOCK
                    ↓
LOCK -> persist audit guard -> UNLOCK
                    ↓
LLM prompt / retries / timeout                         NO LOCK
                    ↓
LOCK -> terminal/cache/fact mutation(s) -> UNLOCK
```

If health and terminal metadata are persisted as separate logical mutations, each receives its own short transaction/revision. That is acceptable: revision is a durable state freshness counter, not a semantic-task counter.

Do not attempt to keep one transaction open from heuristic extraction through final LLM merge.

---

# 13. Failure semantics

PR 5 will later improve public idle outcome taxonomy, so PR 2 does not need to redesign every outcome string.

For this PR:

- primary heuristic transaction lock timeout/read unavailable/commit failure -> map truthfully to existing `write-failed` behavior and emit a bounded structured reason;
- audit guard transaction failure -> return `false`, do not prompt;
- final LLM mutation failure -> current `llm-failed` behavior;
- terminal audit/model-health best-effort transaction failure -> bounded warning, no stale fallback write;
- lock timeout must never cause an unlocked write.

Recommended internal diagnostic reasons:

```text
lock-timeout
read-unavailable
commit-failed
lock-owner-unknown
lock-release-failed
```

Do not log owner payloads beyond bounded non-sensitive fields needed for diagnosis.

---

# 14. Child-process test harness

Cross-process correctness must be proven with actual OS child processes, not two Promises in one Vitest process.

Create a small worker fixture capable of commands such as:

```text
mutate <project> <fact-id>
hold-lock <project> <barrier-path>
crash-with-lock <project> <ready-path>
promote <project> ...
```

Use parent-coordinated barrier files or IPC so tests are deterministic. Avoid relying on arbitrary `sleep(100)` races as proof of correctness.

The worker should exercise the **real** `withProjectLock()` / `mutateMemory()` implementation.

---

# 15. Required release-gate tests

## Transaction correctness

1. **Two child processes, same project, different facts**
   - seed STATE revision 10;
   - coordinate both workers so they contend;
   - both logical mutations succeed;
   - final STATE revision is 12;
   - fact A survives;
   - fact B survives.

2. **No-op does not bump revision**
   - revision N remains N.

3. **Exactly one revision per mutation**
   - one commit N -> N+1, never N+2.

4. **Transaction bypasses cache**
   - preload stale process cache;
   - replace durable STATE with newer revision;
   - transaction builds on newer durable revision.

5. **Commit failure releases lock**
   - force both STATE destinations to fail;
   - next transaction can still acquire the project lock.

6. **Thrown mutation releases lock and does not commit**
   - callback throws;
   - revision/state unchanged;
   - later acquisition succeeds.

## Lock ownership/recovery

7. **Live same-host owner is never stolen**
   - child A holds lock behind a barrier;
   - child B uses a short timeout;
   - B times out without moving/deleting A's lock.

8. **Dead same-host owner is recovered**
   - child acquires lock then exits abruptly without cleanup;
   - next process detects dead PID;
   - canonical lock is quarantined via rename;
   - next mutation succeeds.

9. **Foreign-host lock is not stolen**
   - create valid owner metadata with a different hostname;
   - acquisition times out;
   - lock remains intact.

10. **Malformed/unknown owner is not stolen**
    - malformed or unreadable owner metadata;
    - bounded timeout;
    - canonical lock remains intact.

11. **ABA-safe stale recovery**
    - two contenders attempt dead-lock recovery;
    - at most one successfully quarantines the stale lock;
    - neither deletes the other's newly acquired lock.

12. **Different projects do not block**
    - project A lock held;
    - project B transaction commits before A releases.

13. **Same project local/global fallback uses one lock key**
    - force one commit to global fallback;
    - verify concurrent mutation still serializes through the same project lock.

## Runtime mutation migration

14. **Idle writer + concurrent promotion mutation preserves both**
    - actual child processes;
    - final STATE contains both mutations.

15. **Concurrent different source sessions preserve both source effects**
    - do not rely only on the existing process-local queue test.

16. **Audit guard cannot overwrite a concurrent heuristic mutation**
    - transaction re-reads newest state before audit upsert.

17. **Model-health update cannot overwrite a concurrent durable mutation**.

18. **Final LLM merge cannot overwrite a mutation committed while the prompt was running**.

19. **No filesystem project lock is held during LLM prompt**
    - while mocked `session.prompt` is intentionally pending, a second child-process mutation for the same project must acquire, commit, and finish;
    - then resolve the prompt;
    - final LLM transaction must preserve the second mutation.

20. **Unavailable STATE fails closed under transaction**
    - no empty initialization;
    - no unlocked fallback write.

---

# 16. Implementation order

Recommended sequence so failures stay localized:

## Step 1 — Lock primitive only

Implement:

- `projectLockPath()`;
- owner schema/parser;
- candidate-directory publication;
- acquisition retry/timeout;
- liveness classification;
- ABA-safe stale quarantine;
- release/finally.

Add lock-only child-process tests before touching STATE mutation code.

## Step 2 — Persistence/revision refactor

- split exact commit from logical mutation;
- remove revision advancement from raw persistence;
- make `mutateMemory()` the sole owner of revision advancement;
- add no-op semantics;
- prove N -> N+1 exactly once.

## Step 3 — Core transaction tests

Prove two child processes preserve both mutations before migrating the large writer lifecycle.

## Step 4 — Heuristic writer

Move the first durable heuristic read/merge/write behind `mutateMemory()`.

## Step 5 — LLM lifecycle mutations

Migrate:

- audit guard;
- terminal audit;
- health;
- cache hit merge;
- final LLM merge/cache.

Explicitly preserve no-lock prompting.

## Step 6 — Recall/promotion/recency mutations

Move remaining tool-driven STATE modifications behind the transaction API without changing PR 3 authority policy.

## Step 7 — Eliminate bypasses

Repository-wide audit for:

```text
writeMemory
commitMemoryExact
atomicWrite(...STATE.json...)
readMemory(...) followed by a STATE write
```

Production code should have one logical mutation route.

## Step 8 — Full regression and adversarial suite

Run child-process contention fixtures repeatedly enough to catch cleanup/race defects, while keeping each individual assertion barrier-driven rather than timing-dependent.

---

# 17. Out of scope for PR 2

Do **not** expand this PR into later plan items:

- decision authority/deduplication policy — PR 3;
- human-reviewed promotion redesign — PR 3;
- OpenCode ToolContext/client compatibility — PR 4;
- immutable LLM source fingerprint/outcome taxonomy — PR 5;
- LLM evidence-boundary simplification — PR 6;
- compaction anti-drift — PR 7;
- hard storage/injection budgets — PR 8;
- diagnostic artifact overhaul — PR 9;
- release/dependency hygiene — PR 10.

It is acceptable to add bounded lock diagnostics required to test/fail safely, but do not turn PR 2 into the diagnostics PR.

---

# 18. Verification commands

Minimum checks:

```bash
npm ci
npm test
npx tsc --noEmit
npm run build
bash -n install.sh
```

Also verify that the child-process transaction suite is part of ordinary `npm test` / CI rather than an optional manual command.

If committed `dist/` parity is currently expected, follow the repository's existing parity policy; do not broaden PR 2 into the later release-artifact redesign.

---

# 19. Review checklist

Before requesting the PR 2 oracle investigation, confirm all answers are **yes**:

- [ ] Does the project lock live under the global hashed project namespace?
- [ ] Is lock publication atomic with owner metadata already present?
- [ ] Is live same-host ownership never stolen?
- [ ] Is dead same-host recovery performed by atomic quarantine rename?
- [ ] Are foreign/unknown owners handled conservatively?
- [ ] Are acquisition waits bounded?
- [ ] Does every transaction read bypass cache?
- [ ] Does `unavailable` fail closed?
- [ ] Is revision advanced exactly once by `mutateMemory()`?
- [ ] Does raw persistence write the supplied revision exactly?
- [ ] Do no-op mutations avoid revision churn?
- [ ] Are all production STATE mutation sites routed through `mutateMemory()`?
- [ ] Is the lock absent during LLM/model/host/network calls?
- [ ] Do child-process tests prove two same-project mutations both survive?
- [ ] Do tests prove a dead owner recovers and a live owner is not stolen?
- [ ] Do tests prove different projects remain independent?
- [ ] Is mixed-version concurrency explicitly not overclaimed?

---

# 20. Definition of done

PR 2 is release-gate complete when:

> No TokenMaxxer process implementing this transaction protocol can commit a complete replacement STATE derived from a pre-lock or stale cached read while another compliant process concurrently commits to the same project.

Concretely, every logical mutation must acquire the same project lock, re-read authoritative durable state with cache bypass, fail closed on unavailable state, merge only its intended change, advance revision exactly once, commit atomically, and release the lock. Long-running LLM/host work must occur outside that critical section.

After implementation is pushed, create a fresh `docs/oracle-pr2-investigation.md` containing the implementation commit/ref and any intentional deviations from this plan for adversarial release-gate review.
