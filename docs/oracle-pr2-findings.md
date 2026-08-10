# PR 2 Third-Party Oracle Release-Gate Findings

> **Reviewed implementation:** `46f3d6eb613ade9d0be12c3b2b1702f84db68b58..401fe8d6d0e978bf9ed24e05fd8294ecc60528fd`  
> **Plan:** `docs/pr2-implementation-plan.md`  
> **Review brief:** `docs/oracle-pr2-investigation.md`  
> **CI observed:** 30 test files / 302 tests passed; TypeScript type-check, build, bundle verification, and installer syntax checks all passed on `401fe8d`.

## 1. Verdict

**Block.**

The `mutateMemory` transaction boundary is substantially correct, the LLM lifecycle is generally split into short transactions correctly, and the migration away from stale full-state writes is in good shape. The release blocker is narrower: the cross-process lock ownership protocol is not actually ABA-safe in two places.

The most serious defect is stale-lock recovery: a contender that classified stale owner A can later rename and delete a newly acquired live owner B because `quarantineStaleLock()` does not bind the quarantine rename to the owner nonce that was classified. The second defect is acquisition/release semantics around directory rename: `rename(candidate, .state-lock)` is being used as if it were a create-if-absent primitive, but on POSIX it can replace an existing **empty** destination directory. That violates the explicit unknown-owner non-stealing invariant and interacts badly with recursive release.

These are lock-layer defects, not a reason to redesign `mutateMemory` or the writer transaction lifecycle.

---

## 2. Blocking issues

### Blocker 1 — stale recovery can quarantine a newly acquired live replacement lock

**Files:**

- `src/memory/project-lock.ts:198-212` — `quarantineStaleLock()`
- `src/memory/project-lock.ts:376-387` — dead-owner branch in `withProjectLock()`
- `src/memory/project-lock.ts:311-329` — same problem in `tryAcquireProjectLock()`
- `test/fixtures/project-lock-worker.ts:55-69` — `crash-with-lock` fixture
- `test/memory/project-lock.test.ts:216-329` — dead-owner and ABA tests

#### Evidence

`withProjectLock()` obtains a `dead-same-host` classification from one acquisition attempt and later calls:

```ts
const quarantined = await quarantineStaleLock(project)
```

`quarantineStaleLock()` then operates only on the canonical path:

```ts
await rename(lockDir, recoveryDir)
```

It does **not** receive the owner that was classified, does not compare the current owner nonce with the stale nonce, and does not re-establish exclusive recovery ownership before moving the canonical directory.

The comment after a failed rename says another contender changed the lock and that the next loop will re-classify. That only handles the case where the rename **fails**. The dangerous case is when the canonical path changed but the rename still **succeeds**.

This violates plan hard invariant 14:

> Stale-lock recovery cannot delete a newly acquired replacement lock.

#### Reproduction / failing interleaving

Start with dead owner A at `.state-lock`.

```text
C1                                  C2
--------------------------------    --------------------------------
acquireOnce()
classifies A = dead
                                    acquireOnce()
                                    classifies A = dead
                                    quarantineStaleLock()
                                    rename A -> stale-C2   [succeeds]
                                    retry acquire
                                    acquire live lock B
                                    enter B critical section

quarantineStaleLock()
rename .state-lock -> stale-C1      [SUCCEEDS, but source is now B]
rm stale-C1                         [deletes B's lock]
retry acquire
acquire lock C
enter C critical section
```

B is still running its transaction while C can now enter another transaction for the same project. Mutual exclusion is gone, so the original PR 2 lost-update failure is possible again.

The atomic rename only proves that one process moved **whatever object occupied the canonical path at rename time**. It does not prove that object is the stale owner the process previously classified.

#### The existing ABA/dead-owner tests do not catch this

The child fixture named `crash-with-lock` does not actually crash while holding the lock:

```ts
await withProjectLock(project, async () => {
  await writeFile(readyPath, "ready", "utf-8")
  await new Promise((r) => setTimeout(r, 200))
})
process.exit(0)
```

Returning from the `withProjectLock()` callback executes its `finally`, which releases the lock. `process.exit(0)` happens **after release**.

Therefore:

- `dead same-host owner is recovered` normally starts from a missing lock, not a crashed owner's lock;
- `ABA-safe stale recovery` starts two normal contenders against a missing lock, so it can pass even if stale recovery were completely broken;
- the reported 5x zero-flakiness run does not add evidence for dead-owner recovery or the ABA property because the fixture never leaves a dead lock behind.

#### Recommended fix

The recovery transition needs an identity-preserving claim before quarantine. A safe directory-based shape is:

1. classify current owner A as dead;
2. atomically create a recovery claim **inside the existing canonical lock**, e.g. `.state-lock/.recovery-claim` using exclusive creation;
3. after acquiring the claim, re-read `owner.json` and verify the exact expected owner nonce is still A and still qualifies as dead;
4. only then rename the whole canonical directory to a unique stale quarantine path;
5. delete only that quarantine path;
6. retry normal acquisition;
7. if the recovery claim cannot be acquired or owner identity changed, do not quarantine — reclassify/retry.

All compliant recoverers must honor the claim. If a process itself crashes while holding the short recovery claim, failing conservatively and requiring timeout/manual cleanup is preferable to stealing an unknown lock.

At minimum, the recovery API must carry the expected stale identity rather than just `project`, but **a second read immediately before rename is not sufficient by itself** because another contender can replace the canonical path between that read and rename. The recovery claim is what closes that interval.

#### Required regression tests

1. Make `crash-with-lock` genuinely leave the lock behind. Prefer: child acquires and signals a barrier; parent sends `SIGKILL`/terminates the child while it is inside the callback; verify `.state-lock/owner.json` remains and the PID is dead.
2. Deterministically pause recoverer C1 after it classifies stale owner A but before quarantine.
3. Let C2 recover A, acquire replacement B, and hold B behind a barrier.
4. Resume C1. C1 must **not** move/delete B and must remain contended until B releases.
5. Verify B's nonce and canonical lock directory remain intact while B is held.
6. Only after B releases may C1 acquire.

Do not use startup timing alone for this test; it needs barriers around the classification/recovery boundary.

---

### Blocker 2 — lock acquisition is not true create-if-absent and can steal an empty unknown lock

**Files:**

- `src/memory/project-lock.ts:254-275` — `acquireOnce()`
- `src/memory/project-lock.ts:216-241` — `ProjectLockHandle.release()`
- `test/memory/project-lock.test.ts:260-301` — malformed/read-error unknown-owner tests

#### Evidence

Acquisition creates a fully initialized candidate directory and publishes it with:

```ts
await rename(candidate, lockDir)
return { status: "acquired", ... }
```

The implementation assumes an existing canonical `.state-lock` always makes this rename fail so `classifyLock()` runs.

That assumption is not portable and is false on POSIX when the destination is an **empty directory**: a directory rename can replace an existing empty destination directory. In that case `acquireOnce()` reports success and never reaches the unknown-owner classifier.

The plan explicitly says missing/malformed owner metadata is unknown ownership and must not be silently deleted or stolen. An empty `.state-lock` is exactly the `missing-metadata` case, yet it can be replaced before `classifyLock()` sees it.

#### Deterministic reproduction on POSIX

```text
mkdir <global-project-dir>/.state-lock
# leave it empty; no owner.json
call tryAcquireProjectLock(project)
```

Expected by the plan:

```text
unknown-owner / missing-metadata -> retry -> bounded timeout
```

Current possible result on POSIX:

```text
candidate directory renames over empty .state-lock -> acquired
```

The unknown lock was stolen.

#### Release makes this protocol shape more concerning

Release currently does:

```ts
const current = await readOwner(lockDir)
if (current.nonce === owner.nonce) {
  await rm(lockDir, { recursive: true, force: true })
}
```

Recursive directory removal is not one atomic namespace transition. It removes `owner.json` and then the directory. During cleanup there can be an empty canonical directory. Because acquisition uses directory `rename` rather than a true no-replace primitive, a contender may publish into that empty path while the previous release is still cleaning it up. Depending on platform/runtime removal behavior, the old cleanup can then fail against or interfere with the replacement.

The application critical section has returned by release time, so this is not automatically an overlap by itself; the problem is that cleanup still targets the canonical path rather than an owner-specific retired path, which makes replacement ownership unnecessarily fragile.

#### Recommended fix

Use primitives whose ownership transitions have the semantics the protocol actually needs:

**Acquisition**

Prefer atomic no-replace creation of the canonical directory itself:

```text
mkdir .state-lock        # succeeds only when canonical path is absent
write owner.json
```

This does create a brief publication interval with missing metadata, but that interval is **safe** if all contenders treat missing metadata as unknown and simply retry. A crash in that tiny window may leave an unknown lock requiring manual cleanup, which is an availability failure rather than a mutual-exclusion failure.

Do not use a generic directory `rename(candidate, lockDir)` as the only create-if-absent guarantee unless the implementation has a real cross-platform NOREPLACE primitive.

**Release**

After nonce verification, atomically retire the owned canonical directory first:

```text
.state-lock
    -> .state-lock.released.<owner-nonce>   # atomic rename
```

Then recursively delete only the unique retired path. Once the canonical rename succeeds, a new owner can acquire; old cleanup can no longer target the replacement lock.

Combined with Blocker 1's recovery claim/revalidation, this gives every ownership transition an identity-specific path rather than recursively deleting the shared canonical path.

#### Required regression tests

1. Create an **empty** canonical `.state-lock` with no `owner.json`; acquisition must not replace it and must time out as unknown-owner.
2. Add a real missing-metadata test; current tests cover malformed JSON and read-error but not the empty-directory case.
3. Coordinate release and a waiting contender with a test hook/barrier; prove cleanup of owner A cannot delete or mutate owner B after B acquires.
4. Verify release cleanup operates on a unique retired path, not recursively on the canonical path after ownership is relinquished.

---

## 3. Non-blocking concerns

### A. `pruneOld()` can initiate host logging from inside a filesystem transaction

**Files:**

- `src/memory/writer.ts:1850-1871`
- transaction callbacks throughout `src/memory/writer.ts`

Many `mutateMemory()` callbacks call `pruneOld(..., client)`. Under high storage pressure, `pruneOld()` executes fire-and-forget `log(client, ...)` calls while the filesystem project lock is still held.

The calls are not awaited, so they do not normally keep the lock held for the network round trip. Still, the host client call is initiated from inside the critical section, which is stricter than the plan's hard invariant 10 (no host/network call while locked).

**Suggested follow-up:** make pruning return bounded diagnostics/events, and emit the logs after `mutateMemory()` releases the lock. This can be folded into the later pruning/budget work if the blocker fix remains focused.

### B. `writeMemory()` remains an exported raw exact-persistence escape hatch

**File:** `src/memory/store.ts:286-302`

The repository-wide migration appears clean: production writer/tool mutation sites use `mutateMemory()`, and `writeMemory()` no longer advances revision. However, `writeMemory()` is still exported from the internal store module and can persist a caller-supplied whole STATE without acquiring the cross-process lock.

This is not currently an active production bypass, but it weakens the “one logical mutation route” invariant for future code.

**Suggested follow-up:** rename it to make the danger explicit (`writeMemoryExactUnsafe` or similar), reduce visibility if feasible, or add a prominent internal-only contract and lint/test guard that production callers cannot import it.

### C. `isDestinationExists()` has a broad message fallback

**File:** `src/memory/project-lock.ts:177-190`

The `EEXIST`/`ENOTEMPTY` code checks are appropriate. The fallback regex also treats any error message containing `already exists` as lock contention. That is understandable for Windows portability but can potentially reclassify an unrelated rename failure as contention and turn it into a misleading timeout.

**Suggested follow-up:** prefer explicit platform error codes and keep message matching limited to exact known rename error forms. Add Windows CI or a small platform-error unit table if cross-platform support is a release target.

### D. `recall_promote` reports unreadable memory as “No project memory.”

**File:** `src/tools/recall.ts:99-105`

The pre-transaction read-only short circuit is safe: it performs no write when `readMemory()` collapses `unavailable` to `null`. But it gives the same user-facing result for “missing” and “unavailable.”

**Suggested follow-up:** when PR 3 touches promotion, use `readMemoryState()` for the pre-check or remove the pre-check and let the transaction return the typed unavailable outcome. This should not block PR 2 because there is no destructive fallback.

### E. Test-only writer seams are exported from source

**File:** `src/memory/writer.ts:505,596,629,667,737`

The five extracted seams are useful and are not exposed through the package root exports, so this is not a public npm API break. They do expand the internal source surface without an `@internal` marker.

**Suggested follow-up:** mark them `@internal` or move test-driving composition into a narrower internal module if the source API starts being consumed externally.

---

## 4. Test gaps

Ranked by likelihood × impact.

### 1. Critical — release-gate §15.8 dead-owner recovery is not actually tested

`test/fixtures/project-lock-worker.ts:55-69` returns normally from `withProjectLock()` before `process.exit(0)`, so `finally` releases the lock. The test named “dead same-host owner is recovered” therefore does not leave a dead owner on disk.

This is the highest-priority test correction because stale recovery is where the actual blocker lives.

### 2. Critical — release-gate §15.11 ABA replacement race is not forced

The current ABA test starts two `recover-lock` workers, but because the “crashed” lock was already cleanly released, the workers simply serialize normal acquisitions. Even after fixing the crash fixture, starting two recoverers concurrently is not enough to prove the replacement-between-classification-and-quarantine case.

Add barriers/hooks at the exact classification → quarantine boundary.

### 3. High — missing-metadata / empty canonical lock is not covered

The suite covers:

- malformed `owner.json`;
- `owner.json` read error;
- foreign owner;
- live owner.

It does not cover an existing empty `.state-lock` with no `owner.json`, even though that case is explicitly named by the lock classification and is where the candidate-directory rename can bypass classification entirely.

### 4. High — core two-child transaction test is not barrier-driven

`test/memory/transaction.test.ts:127-153` allocates `barrierA` and `barrierB` but never uses them. It starts two child processes and hopes process startup overlaps enough to create contention.

The final revision/fact assertions are useful, but this test can pass when the children simply run sequentially. Five consecutive passes are therefore evidence of stability, not strong evidence that the test creates the intended stale-read race.

Add a fixture mode that forces both workers to reach a pre-mutation barrier and then releases them together, or otherwise guarantees one is blocked on the project lock while the other owns it.

### 5. High — `recall_promote` concurrency test is also startup-race based

`test/memory/recall.test.ts` starts an `idle-write` child and immediately calls `_recallPromote()` in the parent, without a barrier proving both operations overlap. The final-state assertions are correct but may be satisfied by sequential execution.

Use a held-lock or pre-mutation barrier to guarantee contention.

### 6. Medium — release/acquire handoff is not tested as an ownership transition

There is a nonce-mismatch release test, but no test that pauses owner A during canonical release while owner B is waiting, then proves A's cleanup cannot affect B after acquisition. This becomes important if release is changed to atomic retire-then-delete as recommended.

### 7. Medium — no dedicated Windows lock-protocol CI

`tsx` is correctly declared and CI installs via `npm ci`, and the implementation has portability branches. Current CI is Ubuntu-only, so Windows rename and PID-liveness branches remain unverified in automation.

### Release-gate coverage that appears genuinely present

The following §15 properties have credible direct coverage:

- §15.2 no-op does not bump revision;
- §15.3 exactly one revision per transaction;
- §15.4 transaction bypasses cache;
- §15.5 failed commit releases lock;
- §15.6 thrown callback releases lock;
- §15.7 live same-host lock is not stolen;
- §15.9 foreign-host lock is not stolen;
- §15.10 malformed/read-error owner is conservative (but missing-metadata is still absent);
- §15.12 different projects do not block;
- §15.13 local/global fallback uses the same project lock key;
- §15.16 audit guard rebases transactionally;
- §15.17 model-health update rebases transactionally;
- §15.18 final LLM merge rebases after prompt-time mutation;
- §15.19 LLM prompt is outside the project lock;
- §15.20 unavailable STATE fails closed.

§15.1/15 and §15.14 have cross-process tests but need stronger deterministic overlap as noted above.

---

## 5. Things that look fine

### A. `mutateMemory()` correctly owns the transaction boundary

**File:** `src/memory/store.ts:390-452`

Verified properties:

- resolves one project key;
- acquires `withProjectLock()` before the authoritative read;
- forces `bypassCache: true` regardless of caller behavior;
- returns `unavailable` without `emptyMemory()` when the authoritative read is unresolved;
- only uses `emptyMemory(project)` for a true missing state;
- runs a synchronous mutation callback;
- no-op returns the base revision and performs no commit;
- committed revision is always `base.revision + 1`, overriding any revision supplied in `action.memory`;
- `commitMemoryExact()` writes that revision without incrementing it again;
- `ProjectLockTimeoutError` maps to `lock-timeout` while other unexpected errors propagate.

This part matches the PR 2 plan well.

### B. Foreign-host handling is conservative

**File:** `src/memory/project-lock.ts:157-176`

`process.kill(pid, 0)` is only reached after `owner.hostname === hostname()`. A foreign-host owner returns `foreign-host` before any local PID probe. There is no heartbeat or TTL-based steal path. Foreign/unknown owners back off until timeout.

That is the intended conservative shared-filesystem behavior.

### C. LLM prompt work is outside the project lock

**Files:**

- `src/memory/writer.ts:240-490`
- `src/memory/writer.ts:505-775`
- `test/memory/writer-llm.test.ts` — “LLM prompt is not held under the lock”

The heuristic write, audit guard, terminal outcome, health update, cache-hit merge, and final merge are separate short `mutateMemory()` calls. `getLLMConfig()` and `extractFactsLLM()` are invoked outside an enclosing transaction.

The no-lock-prompt test is particularly strong: it holds the parent prompt pending, launches a real child process for the same project, requires that child mutation to finish, then releases the prompt and checks the final merge preserves the child fact.

### D. Cache bypass and fail-closed behavior survived the migration

**File:** `src/memory/store.ts:405-421`

Every `mutateMemory()` transaction forces a fresh authoritative read under the lock. The PR 1 error-derived cache behavior remains per-process, and transaction reads do not depend on cached selection freshness.

### E. Process-local queue ordering is correctly outside the filesystem lock

**Files:**

- `src/memory/writer.ts:220-236`
- `src/tools/recall.ts:90-151`
- `src/memory/store.ts:390-452`

Idle work and promotion can use `enqueueProjectJob()` as an outer same-process optimization, while `mutateMemory()` itself does not acquire or depend on that queue. Direct callers of `mutateMemory()` therefore retain cross-process safety without the queue.

### F. HEADER remains derivative and outside the transaction

**Files:**

- `src/index.ts:34-50`
- `src/memory/writer.ts:1880-1900`

The initialization placeholder is best-effort and comment-only. Post-STATE HEADER generation happens after transaction completion and failures remain non-fatal. A HEADER can be stale relative to a later concurrent STATE mutation; that is acceptable for a derivative hint file and does not affect STATE authority.

### G. Build/test plumbing for child fixtures is present

**Files:**

- `package.json` — `tsx` devDependency
- `.github/workflows/ci.yml` — `npm ci`, full `npm test`, typecheck, build

CI on `401fe8d` completed successfully with 302 tests, typecheck, build, bundle verification, and installer syntax validation. The green signal is real; the problem is that two lock-specific tests do not exercise the scenarios their names claim.

---

## 6. Out of scope

The following remain intentionally outside PR 2 and should not block this transaction release once the lock ownership defects are corrected:

- model-callable `recall_promote` still minting `human-reviewed` / foundational authority;
- promotion by topic rather than stable decision ID;
- stale/duplicate decision authority and one-valid-authority-per-topic rules;
- foundational decision pruning guarantees;
- LLM evidence scope for non-decision durable facts;
- LLM source-idempotency/cache redesign;
- hard storage/compaction budgets;
- compaction anti-drift work;
- host ToolContext/client contract changes;
- release artifact/checksum/install hardening.

Those belong to PR 3 and later phases in the implementation plan.

---

## Release-gate summary

PR 2 is close structurally, but the filesystem lock is the foundation of every transaction above it. `mutateMemory()` can be perfectly written and still lose updates if two processes are allowed into the critical section because a stale recoverer moved the wrong lock.

Before re-review, the minimum fix set is:

1. replace stale recovery with an identity-preserving recovery claim + owner revalidation before quarantine;
2. stop treating generic directory rename as create-if-absent for the canonical lock;
3. make release retire the owned lock to a unique path before recursive cleanup;
4. fix the crash fixture so it truly leaves a dead lock;
5. add a deterministic replacement-between-classification-and-quarantine test;
6. add an empty/missing-metadata canonical-lock test;
7. strengthen the primary two-process mutation/promotion tests with barriers that guarantee contention.

After those changes, the rest of PR 2 does not need wholesale redesign.