# PR 1 Third-Party Oracle Release-Gate Findings

> **Reviewed implementation:** `8dee315ceef44b685b8cb18511551746b36f5a43`  
> **Plan baseline:** `631d2831743bcfeb46451f484379922cb59d84a7`  
> **Review brief:** `docs/oracle-pr1-investigation.md`  
> **CI observed:** 27 test files / 243 tests passed; TypeScript type-check, build, bundle verification, and installer syntax checks all passed.

## 1. Verdict

**Block.**

PR 1 should not ship yet. The implementation has three concrete storage-correctness failures in the exact invariants PR 1 is intended to establish: revision freshness is not actually monotonic, equal-revision selection ignores the required mtime tie-break, and an unreadable STATE file can still collapse into the same `null` result as a truly missing file and authorize empty-state initialization.

The remainder of the PR is largely sound. These are concentrated release-gate defects rather than a rejection of the overall approach.

---

## 2. Blocking issues

### Blocker 1 — `revision` is not monotonic and can be silently reset to zero

**Files:**

- `src/memory/schema.ts` — `MemoryFileBaseSchema` / `MemoryFile` / `emptyMemory`
- `src/memory/store.ts` — `writeMemory`
- `src/memory/writer.ts` — `pruneOld`

#### Evidence

The schema introduces:

```ts
revision: z.number().int().nonnegative().default(0)
```

and `emptyMemory()` starts at `revision: 0`. However, no production mutation path increments the revision before persistence.

There is a second problem: `MemoryFile` is based on the Zod **input** type, so a defaulted field remains optional to TypeScript. `pruneOld()` reconstructs a new `MemoryFile` object but does not copy `revision`. The omission therefore type-checks. `writeMemory()` later runs `MemoryFileSchema.safeParse(mem)`, which supplies the default and writes revision `0`.

That means a state can enter the writer with a nonzero revision and leave `pruneOld()` as revision zero.

#### Reproduction

1. Create project-local STATE at revision `5` containing the current memory.
2. Create a stale global fallback STATE at revision `3`.
3. Run any ordinary idle mutation.
4. `readMemory()` selects local revision `5`.
5. `mergeMemory()` spreads the existing object, so revision `5` survives initially.
6. `pruneOld()` rebuilds the object without `revision`.
7. `writeMemory()` validates it; Zod defaults the missing revision to `0` and persists it.
8. The next authoritative read compares local revision `0` with stale global revision `3` and selects the stale global state.

Even without a preexisting nonzero revision, normal writes remain revision `0` indefinitely because no mutation increments the field.

This directly contradicts the PR 1 plan requirement:

> Every successful logical STATE mutation increments revision by one.

#### Why this blocks release

The new revision field is the primary authority signal between project-local and global fallback storage. If normal writes do not monotonically advance it, the resolver can resurrect stale memory after a perfectly successful write.

#### Recommended fix

1. Make `MemoryFile.revision` required in the in-memory TypeScript shape. Do not leave it optional merely because the disk schema has a default for backward compatibility.
2. Preserve `revision` in every clone/reconstruction, especially `pruneOld()`.
3. Increment revision exactly once per successful logical STATE mutation from the latest known base state.
4. Keep the increment inside the existing per-project serialized mutation path for PR 1. PR 2 can later extend that correctness boundary across processes.
5. Add regression tests proving:
   - sequential idle mutations advance `0 -> 1 -> 2`;
   - `pruneOld()` preserves a nonzero revision;
   - a successful global fallback write receives a revision greater than the stale local candidate;
   - no normal mutation can decrease revision.

---

### Blocker 2 — equal revisions ignore the required mtime tie-break

**File:** `src/memory/store.ts` — `selectCandidate`

#### Evidence

The implementation plan requires the authority order to be:

1. higher revision;
2. if revision ties, newer mtime;
3. if both tie, project-local.

The current selector only implements steps 1 and 3:

```ts
if (local.kind === "memory" && global.kind === "memory") {
  if (global.revision > local.revision) {
    return resultFromCandidate("global", globalPath, global)
  }
  return resultFromCandidate("project", localPath, local)
}
```

The candidate representation does not carry mtime, even though `readFileResult()` already returns it for readable files.

#### Reproduction

This is particularly important on upgrade:

1. A pre-PR1 project has a stale local STATE and a newer global fallback STATE.
2. Neither file contains `revision` because they predate this feature.
3. Migration/defaulting loads both as revision `0`.
4. Global has a newer mtime and should win under the documented policy.
5. The implementation instead always returns project-local because revisions tie.

The stale-local/global bug that motivated PR 1 therefore survives for legacy dual-file states.

This is independent of Blocker 1: even if revision increments are fixed for all future writes, preexisting files necessarily begin tied at revision zero and still need the mtime bridge.

#### Why this blocks release

PR 1 is explicitly the migration from a write-only fallback model to one authoritative local/global resolver. Existing users are exactly the population most likely to have two files without revision metadata. Choosing the stale one at upgrade is a silent state regression.

#### Recommended fix

Carry mtime through candidate classification and implement the documented ordering exactly:

```text
higher revision
  -> if tied, newer candidate mtime
  -> if tied again, project-local
```

Add deterministic tests using explicit `utimes()` values rather than sleep-based timing:

- equal revision, global newer -> global;
- equal revision, local newer -> local;
- equal revision and exact mtime tie -> local;
- legacy local/global files with no revision, newer global -> global.

---

### Blocker 3 — unreadable STATE still authorizes empty-memory initialization

**Files:**

- `src/memory/store.ts` — `selectCandidate`, `readMemory`, cache handling
- `src/memory/writer.ts` — `writeMemoryOnIdleSerialized` and other `readMemory(...) ?? emptyMemory(project)` fallbacks
- `test/memory/store.test.ts` — unreadable-state case

#### Evidence

`selectCandidate()` preserves an explicit `Candidate.kind === "error"` internally, but the exported result loses that distinction unless there is another valid memory candidate.

For example, local unreadable + global missing falls through to:

```ts
return {
  memory: null,
  source: null,
  path: null,
  sizeBytes: 0,
  revision: 0,
}
```

That is the same externally visible shape as both candidates being genuinely absent.

`readMemory()` then strips even that context and returns only:

```ts
return (await readMemoryState(args)).memory
```

The writer does:

```ts
const existing = (await readMemory({ worktree, directory })) ?? emptyMemory(project)
```

so an unreadable STATE is still treated as permission to construct a fresh project memory.

#### Reproduction

A realistic destructive sequence is:

1. A valid local `STATE.json` exists and global fallback is absent.
2. The file itself becomes unreadable, e.g. mode `000`, while the parent `.opencode/memory` directory remains writable.
3. `stat()` succeeds but `readFile()` returns `EACCES`.
4. `readMemoryState()` returns the same all-null result used for a missing project.
5. `readMemory()` returns `null`.
6. The idle writer creates `emptyMemory(project)` and merges only the current session.
7. Atomic rename can replace the unreadable old file because replacement is governed by directory write permissions, not read permission on the old file.
8. Previous durable memory is silently destroyed.

If the local replacement instead fails and global fallback succeeds, the newly written global file is still derived from an empty base, so the unknown existing local memory has been logically lost.

The current test named:

```text
local unreadable + no global: no silent empty initialization
```

does **not** prove its title. It creates a directory at the STATE path to force `EISDIR`, calls `readMemoryState()`, and asserts the all-null result. It never invokes a mutation/writer and therefore does not prove that empty initialization is prevented.

#### Error-cache follow-on

There is another failure in the same contract. The cache validity check compares only project/global mtimes. Permission changes such as `chmod 000` -> readable normally change ctime, not file mtime. An error-derived all-null selection can therefore remain cached even after read permission is restored, because the mtime pair is unchanged.

The cache stores the original `readResult` but does not use its error state when deciding whether a cached selection is safe to reuse.

#### Why this blocks release

The PR 1 definition of done states that no unresolved read error may silently become permission to start from empty memory. The public read contract still makes “missing” and “unavailable” indistinguishable to mutation callers, so the core safety property is not established.

#### Recommended fix

1. Give `MemoryReadResult` an explicit availability/status discriminator, for example:

```ts
type MemoryReadResult =
  | { status: "ok"; memory: MemoryFile; ... }
  | { status: "missing"; memory: null; ... }
  | { status: "unavailable"; memory: null; errors: ... }
```

2. A mutation path may call `emptyMemory(project)` **only** for `status === "missing"`.
3. Mutation paths must fail closed on `unavailable` and return/log a truthful write/read failure rather than replacing state.
4. Either make `readMemory()` return `null` only for true missing and throw/return a typed error for unavailable, or require all mutation callers to consume `readMemoryState()` directly.
5. Do not cache an error-derived selection solely by mtime. The simplest safe PR 1 policy is to skip caching whenever either candidate read produced an error, so repaired permissions are rechecked on the next access.
6. Add an end-to-end unreadable-file mutation test. If CI runs privileged and cannot reliably produce `EACCES` with `chmod`, mock/inject the read layer or execute the relevant fixture as a non-root child process rather than substituting `EISDIR` and claiming the writer invariant is proven.

---

## 3. Non-blocking concerns

### A. Cache invalidation is still mtime-only for externally changed readable candidates

**File:** `src/memory/store.ts`

The selected-state cache invalidates when either candidate's `getMtime()` changes. In-process `writeMemory()` explicitly deletes the cache, so normal same-process writes are safe from this particular issue. However, a second process or external writer that replaces an already-existing file without producing an observable mtime change can leave the cached selection stale on filesystems with coarse timestamp behavior.

The current cache-switch test only proves `global missing -> global exists`, where the observed value necessarily changes from `null` to a numeric mtime. It does not prove same-mtime replacement of an existing candidate.

**Suggested follow-up:** PR 2's transaction reads should use `bypassCache: true`. Longer term, consider mtime + size + inode/ctime or a revision-aware direct read for correctness-sensitive operations.

### B. `CacheEntry.readResult` is stored but currently unused

**File:** `src/memory/store.ts`

The cache records both mtime and the full typed read result, but cache validity only checks mtimes. The unused `readResult` appears to be exactly the information needed to avoid reusing error-derived cache entries.

**Suggested follow-up:** either use it as part of cache eligibility after fixing Blocker 3 or remove it to avoid implying a stronger cache contract than exists.

### C. Store warnings may be silent in production callers

**Files:** `src/memory/store.ts`, callers of `readMemory()`

`readMemoryState()` accepts optional `client` and logs only when both candidates are unreadable. Most current production reads use the `readMemory()` wrapper, which does not accept/pass a client. As a result, the warning can be a no-op.

**Suggested follow-up:** once unavailable is part of the returned contract, status should render it directly and mutation callers that possess the host client should pass it for diagnostics.

### D. Project identity is path-string stable, not filesystem-canonical

**File:** `src/memory/paths.ts`

`resolveProjectPath()` does not canonicalize symlinks or equivalent path spellings. Two different strings referring to the same physical project can therefore use different cache keys, global hashes, and future project-lock keys.

This behavior predates the cross-process transaction work and should not block PR 1.

**Suggested follow-up:** decide canonicalization deliberately in PR 2 before the project hash becomes the filesystem lock identity.

### E. Atomic-write orphan cleanup is best-effort only

**File:** `src/util/fs.ts`

If rename fails and temp cleanup also fails, a unique `.tmp.<pid>.<uuid>` file can remain. The UUID removes correctness/collision risk; this is now primarily hygiene/disk accumulation under repeated exceptional failures.

**Suggested follow-up:** optional age-based cleanup of TokenMaxxer temp files during startup or writes. Not a release blocker.

### F. `safeRead` is now appropriate only for best-effort artifacts; remove the unused store import

**Files:** `src/memory/store.ts`, `src/index.ts`

`store.ts` still imports `safeRead` although authoritative STATE reading no longer uses it. The remaining observed use in `src/index.ts` is the first-session HEADER placeholder, which is already wrapped in a broad non-fatal `try/catch` and is genuinely best-effort.

**Suggested follow-up:** remove the unused store import and keep the utility documented as unsuitable for authoritative state.

### G. Mixed old/new TokenMaxxer processes cannot participate in the new revision contract

An older binary can still write STATE without a revision field; new code will read that as revision zero. No new cross-process lock can force an old binary to obey future transaction semantics.

**Suggested follow-up:** retain the mtime fallback for legacy/tied revisions and document concurrent mixed-version use as unsupported during the migration window.

### H. HEADER failure tests directly cover only the heuristic path

The implementation routes heuristic, final LLM, and `mergeAsyncFacts` HEADER writes through the same `writeHeaderBestEffort()` helper, so the code path is shared and appears correct. The test suite directly forces failure only on the heuristic call.

**Suggested follow-up:** add one LLM/final-merge failure fixture when that area is next touched. Low release risk.

---

## 4. Test gaps

Ranked by **likelihood × impact**.

### High

1. **Production revision lifecycle.** There is no test that an actual idle or other logical mutation advances revision, and no test that `pruneOld()` preserves it. Store tests synthesize revisions directly instead of exercising production mutation semantics.
2. **Real global-fallback end to end.** The test named global fallback round trip writes the global file directly with `atomicWrite`; it does not force `writeMemory()` to fail locally, create the fallback, then prove that the next authoritative read selects the new state over an old local file.
3. **Unreadable-file mutation safety.** Current coverage tests `readMemoryState()` against an `EISDIR` surrogate but never exercises the writer's `?? emptyMemory(project)` behavior.
4. **Equal revision + mtime ordering.** The implementation plan explicitly requires this, but there is no global-newer/local-newer/exact-tie test.
5. **Permission recovery without mtime change.** There is no regression proving an unreadable candidate is re-read after access is restored when mtime did not change.
6. **Revision downgrade/resurrection.** Seed local rev5/global rev3, run a real idle mutation, and assert local remains >5 and stale global never becomes authoritative.

### Medium

7. **Legacy dual-candidate upgrade.** Both files missing revision; global newer by mtime; resolver must choose global.
8. **Existing candidate replaced with unchanged/coarse mtime.** Current cache test only covers candidate appearance (`null` mtime -> number), not replacement of an existing file.
9. **All writer fallback sites fail closed on unavailable state.** Audit, model-health, LLM merge/cache, recall promotion, and idle heuristic writes should eventually share the same typed mutation rule rather than depending on the nullable wrapper.

### Low / medium

10. **LLM/cache HEADER failure.** Same helper is used but only heuristic failure is directly covered.
11. **Non-git no-root-side-effect assertion.** Current tests prove the effective path and `project_path`, but do not explicitly assert that no `/.opencode/memory/STATE.json` write was attempted. This may require fs mocking to test safely.
12. **Atomic temp-name determinism.** The concurrent test demonstrates two writes complete and leave no orphan. Instrumenting UUID/temp paths would more directly prove each invocation receives a unique temp name, though the implementation itself is clear.
13. **Mixed-version sequential compatibility.** If this compatibility is claimed, test an old-style write followed by a new read/selection and document the unsupported concurrent case.

---

## 5. Things that look fine

### 1. `readFileResult()` correctly distinguishes missing from filesystem read failures

**File:** `src/util/fs.ts`

The primitive itself is well-designed:

- stat `ENOENT` -> `missing`;
- other stat failures -> `error`;
- read failure after successful stat -> `error` with OS code/message;
- successful reads include content + mtime.

If a file disappears between stat and read, the second `ENOENT` is conservatively returned as `error`, not as a silently missing file. That is the safer classification for an authoritative read transaction.

`EACCES`, `EISDIR`, and similar codes do not need different mutation semantics at this layer: they all mean the state could not be authoritatively read. The bug is in the store losing that distinction afterward, not in `readFileResult()`.

### 2. Atomic temp filenames are invocation-unique and same-filesystem

**File:** `src/util/fs.ts`

`atomicWrite()` now uses:

```ts
`${path}.tmp.${process.pid}.${randomUUID()}`
```

The temp file remains adjacent to the destination, preserving same-filesystem rename semantics, and same-process concurrent writes no longer share one PID-only temp filename.

The package declares Node `>=18`, where `node:crypto` `randomUUID()` is available; no polyfill is required.

### 3. The non-git project identity fix is correctly applied in the primary writer paths

**Files:** `src/memory/paths.ts`, `src/memory/writer.ts`

`resolveProjectPath("/", directory)` returns the actual directory. `writeMemoryOnIdleSerialized` now initializes with `emptyMemory(project)`, and `mergeAsyncFacts` does the same. Status does not construct an empty fallback.

The new tests verify the read-back `project_path` is the real directory rather than `/`.

### 4. HEADER generation is genuinely derivative in writer paths

**File:** `src/memory/writer.ts`

`writeHeaderBestEffort()` catches and warns on `generateHeader()` failure. The PR diff replaces all three relevant writer call sites:

- heuristic persistence;
- final LLM persistence;
- `mergeAsyncFacts` persistence.

The plugin-init placeholder HEADER in `src/index.ts` remains a direct best-effort operation, but it was already enclosed in a non-fatal `try/catch`, so its behavior is equivalent for this invariant.

### 5. Status now reports the selected storage metadata rather than reconstructing a local path

**File:** `src/tools/status.ts`

Status consumes `readMemoryState()` and reports:

- actual selected path;
- byte size;
- source (`project`/`global`/none);
- revision.

When no memory is returned it prints `Memory file: none`, rather than inventing a local path. The queue lookup uses the same `resolveProjectPath(worktree, directory)` function as storage.

### 6. The PR's commit scope is clean

Comparing the implementation commit to its parent shows only the expected storage/schema/writer/status/fs source files and their tests. `opencode.json` is not part of PR 1, so the investigation brief's config concern does not reveal a hidden schema/config change in this commit.

### 7. CI is genuinely green

The push CI for `8dee315` completed successfully with:

- 27 test files / 243 tests;
- TypeScript type-check;
- distribution build;
- self-contained bundle verification;
- installer syntax validation.

The release block is therefore not “CI is failing”; it is that the current tests do not encode three critical storage invariants.

---

## 6. Out of scope

The following issues are real or already planned, but they should **not** be used to block PR 1 once the three blockers above are fixed:

- **PR 2 / I1:** true cross-process read-modify-write isolation and filesystem project lock.
- **PR 3 / I2-I5:** decision authority, stale promotion, human-review trust, foundational retention.
- **PR 4 / G3/N1/N3:** OpenCode host client/context compatibility and real host-shape tests.
- **PR 5 / I7/C2/G5:** source idempotency, truthful idle outcomes, exact recall recency marking.
- **PR 6 / I6:** narrowing/completing the LLM durable evidence boundary.
- **PR 7:** compaction quality, augmentation-by-default, anti-drift, sanitization, constraints/verification preservation.
- **PR 8 / G4/I12:** hard storage-prune and compaction-injection budgets.
- **PR 9 / G8/G6/G7/H1:** per-project compaction diagnostics, metadata persistence visibility, activity labels.
- **PR 10 / N4/N5/I13:** release reproducibility, dependency triage, immutable installer artifacts.
- Existing module-global `lastCompactionTimestamp` behavior is a known later diagnostics issue and should not be pulled into PR 1.
- CI's npm audit output (including high/critical labels) remains the already-scheduled dependency-triage item, not evidence that PR 1 itself is unsafe.

---

## Release-gate summary

PR 1's overall architecture is worth keeping: centralized project paths, typed filesystem reads, dual-candidate resolution, invocation-unique atomic temp files, best-effort HEADER generation, and storage-aware status are all improvements.

Before ship, however, the storage contract must satisfy these three executable properties:

```text
1. Every logical mutation monotonically advances and preserves revision.
2. Equal revisions resolve by newer mtime, then deterministic local tie-break.
3. Unreadable/unknown state is distinguishable from missing state and can never authorize empty initialization.
```

Once those are encoded in end-to-end regression tests and fixed in production paths, I would re-run this release gate. PR 2 can then add the cross-process transaction boundary on top of a storage layer whose single-process authority semantics are actually trustworthy.
