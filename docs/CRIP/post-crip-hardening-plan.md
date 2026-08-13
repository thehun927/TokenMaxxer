# TokenMaxxer — Post-CRIP Hardening Plan

> **Status:** Ready for implementation  
> **Source audit:** [`post-crip-adversarial-review.md`](./post-crip-adversarial-review.md)  
> **Program relationship:** CRIP remains **Complete — Ship, 10/10**. This document defines the next hardening tranche discovered by the post-CRIP adversarial review; it does not reopen the original ten workstreams.

## Goal

Close the remaining adversarial seams where CRIP's canonical primitives are correct but a secondary boundary can still bypass or weaken the intended invariant.

The work is ordered by correctness dependency, not by convenience.

## Priority order

| Order | Finding | Severity | Workstream | Required before next release? |
|---:|---|---:|---|---|
| 1 | **A1** | High | Canonical physical project identity | **Yes** |
| 2 | **A2** | High | Compaction authority/trust alignment | **Yes** |
| 3 | **A3** | High | Source-idempotency transaction recheck | **Yes** |
| 4 | **A7** | Medium | TMTUI commit-pulse test race | **Yes** |
| 5 | **A8** | Medium | Immutable-attestation verification retry | **Yes** |
| 6 | **A9** | Medium | Installer shell portability contract | **Yes** |
| 7 | **A4** | Medium | Durable source-completion horizon | Product decision required |
| 8 | **A5** | Medium | First-run non-git LLM project identity | No, but should follow A1 |
| 9 | **A6** | Medium | Host-health fail-open proof | No, but should be hardened |
| 10 | **A10** | Low | Status authority consistency | No |
| 11 | **A11** | Low / maintainability | Writer orchestration refactor | Only after behavior is frozen |

---

# Tranche 1 — Core invariant completion

These three findings should ship together and receive an independent adversarial re-review. They are the only High findings from the post-CRIP audit.

## A1 — Canonical physical project identity

### Problem

`resolveProjectPath()` returns a lexical path. Global storage and the cross-process project lock are derived from a hash of that string. Two different path spellings or symlinks can point to the same physical repository while deriving different lock/global-storage identities.

That can recreate the original I1 lost-update failure:

```text
/real/repo
/alias/repo -> /real/repo

same physical STATE.json
different projectStorageHash(...)
different .state-lock directories
```

### Required implementation

Introduce one canonical physical project identity primitive and use it consistently for:

- project lock identity;
- global fallback storage identity;
- process-local queue identity where cross-instance equivalence matters;
- diagnostic artifact global fallback identity;
- commit-pulse identity if it is intended to represent one physical project.

Recommended contract:

```text
host worktree/directory
        ↓
lexical effective project path
        ↓
absolute normalization
        ↓
realpath when resolvable
        ↓
canonical physical project identity
```

Keep display/persisted path separate if preserving the host-visible lexical path is useful.

### Fail-closed/fallback behavior

If physical canonicalization fails:

- use a deterministic documented fallback;
- never let different modules independently choose different fallbacks;
- do not turn a canonicalization error into empty-memory authorization.

### Acceptance tests

1. Create one real repository directory and one symlink alias.
2. Assert both resolve to the same lock/global-storage identity.
3. Launch two child processes using the two path spellings.
4. Have both mutate STATE concurrently.
5. Final state must contain both logical updates and revision must advance `N -> N+2`.
6. Repeat with global fallback storage forced.
7. Non-git directory behavior must remain correct.

### Oracle attack cases

- relative path vs absolute path;
- `.`/`..` normalization;
- symlinked parent directory;
- symlink directly on repository root;
- project deleted/unavailable during canonicalization;
- local writable vs global fallback transitions.

---

## A2 — Make automatic compaction use the same authority/trust view as recall

### Problem

Recall consumes `resolveDecisionAuthorities(...).authorities`, but automatic durable-context rendering directly filters raw rows by `still_valid` and prioritizes raw `foundational`.

This can produce cross-surface contradictions:

```text
recall -> one resolved authority
compaction -> two raw conflicting still_valid rows
```

It also lets a legacy/non-human row with `foundational=true` receive protected foundational retention/injection priority without satisfying the full trusted-human tuple.

### Required implementation

1. Build compaction decision candidates from:

```ts
resolveDecisionAuthorities(mem.decisions)
```

2. Automatic injection must use only the returned authoritative decision set.
3. A `conflicting-human-foundational` topic must inject **no automated authority** until the human conflict is resolved.
4. Priority-5 "foundational" automatic injection must use `isTrustedHumanFoundational(decision)`, not raw `decision.foundational`.
5. Define a compatibility policy for historical/legacy `foundational=true` rows:
   - preferred: demote to `foundational_requested=true` unless the full trusted-human tuple exists; or
   - retain as legacy retention intent but never classify it as trusted human authority.
6. Align memory-budget protection with the same distinction so the phrase "foundational-state-exceeds-budget" means what the trust model says it means.

### Acceptance tests

1. Same-topic conflicting non-human rows: recall and compaction expose the same authority ID.
2. Equivalent duplicate observations: only resolved authority is injected.
3. One trusted-human foundation plus automated conflict: human authority only.
4. Two conflicting trusted-human foundations: no automated authority injected; conflict remains visible through explicit read/status surfaces.
5. Legacy `foundational=true` + legacy provenance cannot receive trusted-human priority.
6. Automatic block remains <= 4,096 UTF-8 bytes and deterministic.
7. STATE retention still preserves actual trusted-human foundation under pressure.

### Oracle attack cases

- schema-valid pre-CRIP legacy rows;
- duplicate valid rows with unique IDs;
- quarantined human conflict plus newer LLM row;
- equal timestamps;
- Unicode/NFKC-equivalent topics;
- raw foundational bit without human review.

---

## A3 — Re-check completed source inside the first heuristic transaction

### Problem

The writer checks `processed_sources` before entering the heuristic transaction, but does not repeat the check against the lock-read `base` inside `mutateMemory()`.

Cross-process interleaving can therefore be:

```text
B pre-read: source incomplete
A lock -> completes source -> unlock
B lock -> sees completed source in transaction base
B still commits heuristic state
B post-read sees completion
B returns cache-hit
```

The return value says no-op/cache-hit even though a durable revision was committed.

### Required implementation

Inside the heuristic `mutateMemory()` callback, before reference marking or heuristic merge:

```ts
if (findProcessedSource(base, sourceVersionKey)) {
  return { kind: "noop", value: ... }
}
```

The no-op result must:

- perform no heuristic merge;
- perform no HEADER regeneration;
- produce no commit pulse;
- cause no revision bump;
- return the same public completed-source outcome as the normal fast path.

### Acceptance tests

1. Deterministic two-process race where process B pre-reads before process A completes.
2. Process A commits completion first.
3. Process B must acquire lock, observe completion, return no-op/cache-hit.
4. Final revision must reflect only A's completion transaction, not an extra B heuristic commit.
5. No duplicate heuristic decision/current-task/file updates.
6. No pulse from the B no-op.
7. Same-process coalescing behavior remains unchanged.

### Oracle attack cases

- LLM disabled;
- LLM enabled;
- source completion inserted between outer read and lock acquisition;
- lock timeout;
- global fallback state;
- state exactly at storage budget.

---

# Tranche 2 — Release and lifecycle reliability

These are not evidence of release-integrity failure. The first immutable `v0.1.0` release proved the integrity design works, while exposing reliability assumptions that should be fixed before the next release.

## A7 — Synchronize the TMTUI telemetry failure test

### Problem

`recordMemoryCommit()` is deliberately fire-and-forget after a successful STATE commit. A test immediately tries to turn the pulse path into a directory and races the unfinished marker write, producing nondeterministic `EEXIST` failures.

### Required implementation

Do not make production commit success depend on awaiting telemetry.

Fix the **test seam**, not the production reliability policy. Preferred options:

- expose a test-only awaitable/drain seam for pending pulse writes; or
- seed STATE without firing a pulse before blocking the marker path; or
- mock/spy the pulse writer at the correct synchronization boundary.

### Acceptance tests

- run the focused telemetry suite repeatedly in one process;
- run it under full-suite parallelism;
- no intermittent `EEXIST`/ordering failure;
- successful STATE commits remain independent of telemetry success.

---

## A8 — Retry immutable release attestation verification after publication

### Problem

The first real release became immutable and its GitHub-generated release attestation appeared successfully, but the workflow called `gh release verify` immediately after publication and failed before the attestation was queryable.

### Required implementation

After publishing the already-verified draft:

- poll `gh release verify "$GITHUB_REF_NAME"` with bounded retry/backoff;
- distinguish transient attestation-not-yet-available from permanent verification failure;
- keep a hard upper bound;
- never republish, recreate, retag, or mutate the already-published immutable release as a retry strategy.

Example policy target:

```text
attempt 1 immediately
then bounded delays, e.g. 2s / 4s / 8s / 16s / 30s
hard fail after bounded verification window
```

Exact numbers are implementation choice; deterministic bounded behavior is required.

### Acceptance tests

- workflow contract test requires a bounded retry construct around post-publish `gh release verify`;
- fixture: first N verification attempts fail with attestation unavailable, later attempt succeeds;
- permanent verification failure still ends red;
- publish remains exactly once.

---

## A9 — Make installer shell contract explicit and internally consistent

### Problem

Installer checksum handling intentionally supports GNU `sha256sum` and BSD/macOS `shasum -a 256`, but the script also uses Bash associative arrays (`declare -A`), which are unavailable in older Bash environments such as stock macOS Bash 3.2.

### Required decision

Choose one:

**Option A — Portable installer:** remove Bash-4-only constructs and support the intended macOS/BSD environment.

**Option B — Explicit Bash 4+ contract:** detect Bash version before any downloads or mutations and fail with a clear requirement.

Portable behavior is preferable if the one-line installer is intended to work on ordinary macOS without an additional shell dependency.

### Acceptance tests

- selected shell contract is documented;
- unsupported shell fails before mutation;
- checksum verification behavior remains identical;
- existing curl/wget + sha256sum/shasum E2E cases remain green.

---

# Tranche 3 — Policy and compatibility hardening

## A4 — Decide the source-completion retention horizon

### Problem

`processed_sources` is capped at 10 entries. Once an old completion record is evicted, the same historical source version can be processed again after reload.

### Product decision

Choose and document one of these contracts:

1. **Strict durable idempotency:** completed source identities never become processable again. Requires a more compact/expanded completion representation outside the current 10-row list.
2. **Bounded idempotency horizon:** explicitly define that only the newest N source versions are protected from replay.
3. **Hybrid:** bounded detailed rows plus a compact historical digest/set structure.

Do not leave the current `10` as an accidental semantic contract.

### Acceptance tests

Depend on selected policy, but must explicitly cover the 11th+ source and reload behavior.

---

## A5 — Use resolved project identity for first-run LLM canonical prior

### Problem

When no STATE exists, preparation currently builds the canonical LLM prior from `emptyMemory(worktree)`. In non-git sessions OpenCode may provide `worktree="/"`, while storage correctly resolves to `directory`.

### Required implementation

Use the already resolved effective/canonical project path when constructing empty prior memory.

Prefer implementing this after A1 so there is only one project identity source.

### Acceptance test

Fresh non-git directory + LLM extraction must never place `/` into canonical prior identity or prompt-input hashing when the actual project directory is known.

---

## A6 — Prove the fail-open pinned host contract

### Problem

When `client.global.health` is absent, the structured-output gate currently allows extraction under `source="pinned-compatibility"`. But the production peer range allows `>=1.18.15 <2.0.0`; absence of the endpoint alone does not prove that the running host is exactly the verified 1.18.15 package contract.

### Required implementation

Either:

- establish a reliable runtime proof for the exact verified compatibility contract before taking the fail-open branch; or
- change absent-health behavior to fail closed unless another verified compatibility signal exists.

Minimum-host compile remains useful but is build-time proof, not necessarily runtime identity proof.

### Acceptance tests

- exact verified host without health surface follows documented compatibility behavior;
- newer/unknown host with no health surface cannot silently inherit pinned trust;
- malformed/failed health remains fail closed.

---

# Tranche 4 — Observability consistency and refactor

## A10 — Make status decision reporting authority-aware

### Problem

Status currently counts raw `still_valid` decisions and samples raw decision provenance. That can disagree with `resolveDecisionAuthorities()` for legacy/conflicted state.

### Required implementation

Use the authority resolver for user-facing valid/authoritative decision counts. Preserve separate raw/history counts only if clearly labeled.

Recommended status vocabulary:

```text
decision rows: N
authoritative decisions: M
human-foundational conflicts: K
```

### Acceptance tests

Status, recall and project-state views must agree on authoritative decision count for duplicate/conflict fixtures.

---

## A11 — Refactor `writer.ts` only after A1–A10 behavior is frozen

### Problem

`writer.ts` owns too many lifecycle concerns. This did not directly cause a CRIP regression, but A3 demonstrates how easy it is for a correct invariant to be checked on the wrong side of a transaction boundary.

### Refactor target

Split by durable lifecycle responsibility, not arbitrary line count. Candidate modules:

```text
idle-source.ts          source preparation / version identity
heuristic-transaction.ts
llm-lifecycle.ts        model/audit/prompt lifecycle
final-merge.ts
source-completion.ts
writer.ts               thin orchestration only
```

Do not change observable behavior during this refactor.

### Acceptance criteria

- no semantic changes in same commit as extraction/refactor;
- existing adversarial concurrency tests remain unchanged and green;
- transaction boundaries become visually explicit;
- each durable mutation path has one obvious authoritative helper.

---

# Required implementation sequence

```text
A1 physical project identity
        ↓
A5 first-run identity cleanup

A2 compaction authority/trust

A3 source TOCTOU
        ↓
A4 source-retention policy

A7 telemetry test race
A8 release verification retry
A9 installer shell contract

A6 runtime host proof
A10 status authority consistency

A11 writer refactor LAST
```

The minimum **next-release hardening gate** is:

```text
A1 + A2 + A3 + A7 + A8 + A9
```

A4 requires an explicit product decision, and A5/A6/A10 should follow promptly. A11 remains last because refactoring before the invariants are frozen increases review risk.

---

# Review / shipping convention

Use the same independence discipline that worked for CRIP:

1. Luna/subagents implement one bounded tranche on a branch.
2. Implementation handoff records exact head SHA, tests and CI run.
3. Oracle independently reviews the exact implementation head and attacks the listed adversarial cases.
4. No implementation agent self-marks the tranche Ship.
5. A tranche is complete only after exact-head CI and independent Ship verdict.

Suggested tranche structure:

```text
docs/CRIP/post-CRIP-hardening/
  README.md
  tranche-1-core-invariants.md
  tranche-2-release-lifecycle.md
  tranche-3-policy-compatibility.md
  tranche-4-observability-refactor.md
  oracle-*.md
```

Create that directory when implementation begins; this roadmap remains the program-level authority for ordering and scope.

## Definition of done

Post-CRIP hardening is complete when:

- path aliases cannot split one physical project across transaction authorities;
- recall, compaction, budget protection and status agree on decision authority/trust semantics;
- a completed source cannot cause any durable mutation regardless of interleaving;
- source-completion retention policy is explicit and tested;
- non-git first-run identity is consistent across storage and LLM prompt identity;
- unknown host compatibility cannot inherit unproven pinned trust;
- commit-pulse tests are deterministic without making telemetry part of commit success;
- release attestation verification tolerates bounded GitHub propagation delay;
- installer shell requirements match actual implementation;
- only then is writer orchestration refactored behind frozen behavioral tests.
