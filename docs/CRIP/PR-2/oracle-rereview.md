# PR 2 Oracle Re-Review — Wave 7

> **Reviewed fix:** `e3ddd15faa90e08fac9817f7ad68b3dbb5bbca20`  
> **Prior findings:** `docs/oracle-pr2-findings.md`  
> **Original implementation:** `46f3d6e..401fe8d`  
> **Plan:** `docs/pr2-implementation-plan.md`  
> **CI observed:** GitHub Actions run `31415103087` succeeded on `e3ddd15`; submission reports 30 test files / 307 tests and clean typecheck/build.

## 1. Verdict

**Block — one remaining release-gate issue.**

Wave 7 closes the prior second blocker and materially improves the test fidelity. Canonical acquisition now uses true create-if-absent directory creation; release retires the owned lock directory before cleanup; the crash fixture now leaves a genuine SIGKILLed owner; and the transaction/recall contention tests are now deliberately coordinated rather than relying on scheduler luck.

The remaining blocker is narrower: the new recovery claim is described as mutual exclusion between stale-lock recoverers, but its filename is unique per recovering PID. Two different processes can therefore both acquire a claim against the same stale owner, both revalidate that owner as dead, and then recreate the same post-validation ABA race that the claim was intended to eliminate.

PR 2 should not ship until the recovery claim has one canonical create-if-absent identity per stale lock and there is a deterministic test that pauses a recoverer **after successful claim acquisition/revalidation**, not only after the initial dead-owner classification.

---

## 2. Blocking issue

### Recovery claims do not mutually exclude different recoverers

**Primary file:** `src/memory/project-lock.ts` — `acquireRecoveryClaim()`, `quarantineStaleLock()`, dead-owner branches in `withProjectLock()` and `tryAcquireProjectLock()`.

#### Evidence

The claim path is built as:

```ts
const claimPath = join(
  lockDir,
  `.recovery-claim-${process.pid}-${expectedOwner.nonce}`,
)
```

and then acquired with:

```ts
await writeFile(claimPath, ..., { flag: "wx" })
```

`wx` is create-if-absent only for **that exact path**. Because each recovering process has a different `process.pid`, C1 and C2 generate different claim paths for the same stale owner A:

```text
.state-lock/.recovery-claim-111-A_NONCE
.state-lock/.recovery-claim-222-A_NONCE
```

Both writes can succeed. Therefore the comment:

```text
EEXIST means someone else is recovering
```

is false across the cross-process case that matters. EEXIST only excludes a duplicate claim from the same PID against the same stale-owner nonce.

After each process writes its own claim, both independently re-read `owner.json`, see A's nonce, observe A's PID as `ESRCH`, and return a successful claim. At that point there is no further owner-identity check before `quarantineStaleLock(project)` blindly renames the canonical `.state-lock` path.

#### Reproduction / failing interleaving

Start with dead owner A.

```text
C1                                      C2
------------------------------------    ------------------------------------
classify A = dead                       classify A = dead

create claim C1                         create claim C2
(unique PID path; succeeds)             (different PID path; also succeeds)

re-read owner A                         re-read owner A
A nonce matches                         A nonce matches
A PID = ESRCH                           A PID = ESRCH
claim accepted                          claim accepted

PAUSE after claim/revalidation
                                         quarantine .state-lock -> stale-C2
                                         delete stale-C2
                                         acquire canonical live owner B
                                         enter B critical section

resume
quarantine .state-lock -> stale-C1
  ^ source is now LIVE OWNER B
rename succeeds
rm stale-C1
  ^ deletes B's lock
retry/acquire canonical owner C
enter C critical section while B is live
```

This is the same mutual-exclusion failure as the original Blocker 1, just with a smaller race window: the vulnerable interval moved from **after classification** to **after claim revalidation**.

The atomic quarantine rename does not save the protocol because it proves only that C1 moved whatever occupies the canonical path at the instant of rename. The recovery claim must prevent another compliant recoverer from replacing A during the claim-holder's recovery transition.

### Why the new replacement test still passes

The new `replacement between classification and quarantine` regression pauses C1 immediately after C1 classifies A as dead, **before C1 acquires a recovery claim**.

While C1 is paused, C2 recovers A and acquires live B. When C1 resumes, it calls `acquireRecoveryClaim(project, A)`. The claim is created inside B, then the owner re-read sees B's nonce instead of A's nonce, so C1 removes its claim and backs off. That case is correctly fixed.

What the test does **not** force is the remaining vulnerable window:

```text
C1 classify A
C1 claim A
C1 revalidate A dead
--- PAUSE HERE ---
C2 claim A
C2 revalidate A dead
C2 quarantine A + acquire B
--- RESUME C1 ---
C1 quarantine canonical B
```

The existing `ABA-safe stale recovery` test starts two recoverers concurrently, but it has no barrier after claim acquisition/revalidation. Passing that test, even repeatedly, does not establish that the claim is exclusive; scheduler ordering can let the first recoverer quarantine A before the second completes its revalidation.

#### Recommended fix

Use **one canonical claim path per stale lock**, not one claim path per recoverer. For example:

```text
.state-lock/.recovery-claim
```

or, if encoding stale identity in the filename is desired:

```text
.state-lock/.recovery-claim-<expected-owner-nonce>
```

The important property is that every compliant process recovering the same stale owner attempts to create the **same path** with create-if-absent semantics.

Suggested protocol:

1. classify owner A as `dead-same-host`;
2. create the canonical recovery claim with `wx`;
3. write bounded claimant metadata inside it (recoverer PID/nonce + expected stale-owner nonce);
4. re-read `owner.json`;
5. require current owner nonce === A nonce and PID still dead;
6. while still owning the canonical claim, rename the entire `.state-lock` directory to a unique stale quarantine path;
7. after successful quarantine, the claim moves with the stale directory and is deleted with that directory — do not try to remove a claim from a newly created canonical replacement;
8. if quarantine fails, clean up the claim only if it is still demonstrably this recoverer's claim under the same expected owner; otherwise leave it alone and fail conservatively.

A recovery process crashing while holding the short claim may create an availability failure. That is acceptable relative to stealing a live lock; recovery-claim stale handling can be added later if needed, but it must itself preserve identity.

#### Required regression test

Add a deterministic test hook/barrier immediately after `acquireRecoveryClaim()` has successfully:

- created the claim;
- re-read `owner.json`;
- verified the expected nonce;
- verified the PID is dead;

Then test:

1. create genuine dead owner A via SIGKILL;
2. start C1 and pause it **after successful recovery-claim revalidation**;
3. start C2 against the same stale A;
4. while C1 remains paused, prove C2 cannot acquire a second recovery claim, cannot quarantine A, and cannot enter the project critical section;
5. resume C1;
6. C1 quarantines A and completes normal acquisition/release;
7. only afterward may C2 acquire;
8. verify no interval exists with two live critical sections.

With the current PID-specific claim filename, step 4 should fail: C2 can create its own claim.

---

## 3. Prior blocker status

### Prior Blocker 1 — stale recovery identity preservation

**Improved but not fully closed.**

Owner revalidation after claim creation correctly closes the original **classification -> claim** replacement window. The remaining issue is that the claim itself is not exclusive across processes, so a **claim revalidation -> quarantine** replacement window remains.

### Prior Blocker 2 — create-if-absent acquisition and owner-specific release

**Closed.**

Wave 7 replaces `rename(candidate, lockDir)` with:

```ts
await mkdir(lockDir, { recursive: false })
```

so an existing empty/missing-metadata canonical lock cannot be replaced. The new missing-metadata tests directly cover this case.

Release now verifies the owner nonce, atomically renames the canonical lock to a unique retired path, and recursively deletes only the retired path. Old cleanup no longer targets the canonical namespace after ownership is relinquished.

---

## 4. Test fidelity re-review

### Verified improved

- `crash-with-lock` now waits inside the `withProjectLock()` callback and is killed by the parent with `SIGKILL`; it genuinely leaves `owner.json` for a dead PID.
- The dead-owner recovery test now exercises actual stale-owner recovery rather than normal acquisition from a missing lock.
- The two-child transaction test is barrier-driven: A holds the lock before B attempts its mutation, so actual contention is guaranteed.
- The recall promotion test now forces promotion to contend with a child holding the same project lock.
- The replacement-before-claim test is deterministic and correctly validates the owner re-check added in Wave 7.

### Still missing

The suite needs one test at the **post-claim-revalidation / pre-quarantine** boundary. That is the only remaining release-gate concurrency gap identified in this re-review.

---

## 5. Things that look fine

### `mutateMemory()` remains correct

No regression found in the canonical transaction primitive. It still:

- acquires the project lock;
- re-reads authoritative state under the lock with `bypassCache: true`;
- fails closed on `unavailable`;
- initializes empty only on true `missing`;
- advances revision from the lock-read base exactly once;
- leaves no-op revision unchanged;
- maps `ProjectLockTimeoutError` while propagating unexpected callback errors.

### True create-if-absent acquisition

The Wave 7 `mkdir(lockDir, { recursive: false })` transition has the mutual-exclusion semantics needed for the canonical lock namespace. Existing unknown/empty locks remain contended instead of being replaced.

### Retire-then-delete release

The release path now moves the owned canonical lock to an owner-specific retired path before recursive deletion. This is the correct shape for preventing old cleanup from reaching a replacement owner.

### Foreign-host behavior remains conservative

PID liveness is still evaluated only after the owner hostname matches the local hostname. Foreign-host locks remain non-stealable and time out conservatively.

### No-lock LLM lifecycle remains intact

Nothing in Wave 7 moves model resolution, audit-session host calls, prompt/retry/timeout, or LLM transport under the filesystem lock. The earlier no-lock prompt regression remains valid.

### CI

GitHub Actions run `31415103087` for `e3ddd15` completed successfully. The commit reports 30 files / 307 tests plus five repeated adversarial runs of the focused 122-test set.

---

## 6. Non-blocking concerns

### Empty-publication crash window is an availability tradeoff

`acquireOnce()` now creates `.state-lock` first and writes `owner.json` second. A crash between those operations leaves an unknown-owner lock that compliant processes will never steal automatically.

That is safe for mutual exclusion but can require manual cleanup. This differs from the original plan's fully initialized candidate-directory publication. I would not block PR 2 on it because the chosen failure mode is conservative, but it should be documented operationally.

### Recovery test hook is part of the exported options type

`waitForClassificationBarrier` exists only for tests but is exposed through `ProjectLockOptions`. This is minor internal API surface growth. If convenient, hide test hooks behind a test-specific injection layer later; do not complicate the blocker fix for it.

### Broad destination-exists message fallback remains

The message regex fallback for Windows/platform rename/mkdir variants remains broader than error-code checks. Prefer adding concrete Windows CI or targeted mocked errno/message tests later rather than expanding heuristics further.

---

## 7. Out of scope

The following remain explicitly outside PR 2 and should not block this re-review:

- PR 3 decision-authority semantics;
- model-callable promotion currently minting human-reviewed provenance;
- foundational decision retention/pruning policy;
- exact decision-ID promotion redesign;
- PR 5 outcome/idempotency refinements;
- later compaction and storage-budget work.

---

## 8. Release-gate close condition

PR 2 can clear this oracle gate when:

1. stale-owner recoverers contend on one canonical recovery-claim identity;
2. only one compliant process can hold the recovery claim for a given stale lock at a time;
3. a deterministic post-claim-revalidation barrier test proves a second recoverer cannot replace the stale lock before the claimant quarantines it;
4. the full CI suite remains green.

No redesign of `mutateMemory`, writer transactions, release semantics, or the new contention fixtures is otherwise required.