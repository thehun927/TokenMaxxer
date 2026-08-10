# PR 2 Oracle Final Re-Review — Wave 8

> **Reviewed fix:** `e2d2da57c3655ee70ab4745ed8a0811195aa3eac`  
> **Prior re-review:** `docs/oracle-pr2-rereview.md`  
> **Plan:** `docs/pr2-implementation-plan.md`  
> **CI observed:** GitHub Actions run `31415977734` succeeded on `e2d2da5`; 30 test files / 308 tests passed, followed by successful TypeScript type-check, build, bundle verification, and installer syntax validation.

## 1. Verdict

**Ship.**

Wave 8 closes the final PR 2 release-gate blocker. The recovery claim now has one canonical filesystem identity per stale owner, so two compliant recoverers cannot both pass the claim boundary for the same stale lock. The new post-claim barrier test also exercises the exact interval that remained unproven in Wave 7: after claim acquisition and dead-owner revalidation, but before quarantine.

I found no remaining PR 2 blocker in the cross-process transaction or lock protocol.

---

## 2. Final blocker closure

### Canonical recovery claim now provides actual cross-process exclusion

**File:** `src/memory/project-lock.ts`

Wave 7 used a recovery claim path containing the recovering PID, allowing different processes to create different claims for the same stale owner. Wave 8 changes that to:

```ts
const claimPath = join(lockDir, `.recovery-claim-${expectedOwner.nonce}`)
```

The path is now derived only from the stale owner's nonce. Every compliant recoverer of owner A therefore attempts to create the same directory:

```ts
await mkdir(claimPath, { recursive: false })
```

Only one process can succeed. A second recoverer gets contention rather than an independent claim.

The winning recoverer then writes bounded claimant metadata, re-reads `owner.json`, requires the exact expected owner nonce to remain present, and requires the PID to still classify as dead before returning the claim handle.

This is the missing identity-preserving transition required by PR 2 hard invariant 14.

### The claim remains bound to the stale directory through quarantine

`quarantineStaleLock(project, claim)` renames the entire canonical `.state-lock` directory. Because the canonical recovery claim lives inside that directory, the claim moves with the stale lock into the unique quarantine path and is deleted with that retired directory.

This is a good protocol shape: after the atomic rename, old cleanup no longer targets the canonical namespace, so a newly acquired replacement lock cannot be deleted by stale-recovery cleanup.

If quarantine fails, `cleanupClaimIfOwned()` removes a canonical claim only after checking claimant metadata against this process and the expected stale owner. Otherwise it leaves ownership untouched and fails conservatively.

### Accepted availability tradeoff

A recoverer that crashes after acquiring the canonical recovery claim but before quarantine can leave a stale claim that blocks automated recovery until manual cleanup. That is an availability failure, not a mutual-exclusion failure, and it is explicitly documented. For this lock protocol that is the correct safety preference: refusing to steal an uncertain lock is better than permitting concurrent STATE transactions.

---

## 3. Regression test verification

The new `post-claim-revalidation barrier (canonical claim identity)` test covers the exact Wave 7 gap:

1. a child acquires the real project lock and is SIGKILLed, leaving genuine stale owner A;
2. C1 classifies A dead, acquires the canonical recovery claim, revalidates A, then pauses after that successful revalidation;
3. while C1 is paused, C2 attempts `withProjectLock()` for the same project;
4. C2 cannot acquire the same canonical recovery claim and times out without modifying A;
5. C1 resumes, quarantines A, acquires a fresh lock, runs, and releases;
6. a subsequent caller acquires a new live owner whose nonce differs from A.

That is the correct deterministic test boundary. It no longer depends on scheduler luck or a pre-claim pause.

The earlier Wave 7 regressions also remain in place:

- true create-if-absent canonical acquisition;
- empty/missing-metadata lock is not stolen;
- genuine SIGKILL dead-owner recovery;
- release retire-then-delete behavior;
- replacement between initial classification and recovery claim;
- concurrent stale recovery;
- barrier-driven same-project transaction contention;
- barrier-driven promotion versus idle mutation;
- no LLM prompt while the filesystem project lock is held.

---

## 4. CI verification

GitHub Actions run `31415977734` completed successfully on `e2d2da5`.

Observed CI results:

- `npm ci` succeeded;
- 30 test files passed;
- 308 tests passed;
- `test/memory/project-lock.test.ts`: 19 tests passed, including the new post-claim-revalidation case;
- `test/memory/transaction.test.ts`: 12 tests passed;
- TypeScript `tsc --noEmit` succeeded;
- distribution build succeeded;
- self-contained bundle verification succeeded;
- `bash -n install.sh` succeeded.

No regression signal appeared in the full suite.

---

## 5. Non-blocking follow-ups carried forward

These are not PR 2 release blockers and should remain later-work items:

### A. Host logging initiated from pruning inside transactions

Some transaction callbacks call `pruneOld(..., client)`, and pruning may initiate fire-and-forget host logging before the filesystem lock is released. Because those calls are not awaited, I do not consider this a practical PR 2 mutual-exclusion blocker, but later budget/pruning work should preferably return diagnostics and emit them after the transaction.

### B. Exported raw exact persistence primitive

`writeMemory()` remains an exported exact-persistence path that does not acquire the cross-process transaction lock. The repo-wide migration currently keeps logical production mutations on `mutateMemory`, so this is not an active bypass. Later cleanup should make the unsafe/raw nature harder to misuse, or enforce imports with tests/linting.

### C. Broad platform error-message fallback

`isDestinationExists()` still has a message-regex fallback after checking `EEXIST` / `ENOTEMPTY`. This is acceptable for PR 2 portability, but it can be tightened if future Windows testing identifies specific error shapes.

### D. Recovery-claim crash requires manual cleanup

This is intentionally documented and safety-preserving. A future operational/diagnostic PR could expose the stuck claim in status output and provide a cautious recovery command, but automatic stealing should not be added casually.

---

## 6. Out of scope

The following remain intentionally deferred and do not block PR 2:

- decision authority and stale-authority collapse;
- `recall_promote` human-review trust semantics;
- foundational retention and supersession rules;
- LLM durable evidence-boundary redesign;
- compaction quality and anti-drift;
- hard storage/injection budgets;
- diagnostics/status improvements;
- release/dependency hygiene.

---

## 7. Final release-gate conclusion

PR 2 now satisfies the cross-process correctness properties I was gating:

- one project -> one filesystem transaction key;
- local/global storage share that key;
- transaction reads occur after lock acquisition and bypass process cache;
- unavailable STATE fails closed;
- revision advances exactly once per committed logical mutation;
- live locks are not stolen;
- dead same-host locks are recoverable;
- unknown/foreign locks fail conservatively;
- stale recovery is identity-preserving across both the pre-claim and post-claim ABA windows;
- release cleanup cannot target a replacement lock;
- real child-process contention preserves both mutations;
- LLM prompting remains outside the filesystem critical section.

**PR 2 release gate: cleared. Proceed to PR 3 — decision authority and promotion trust.**
