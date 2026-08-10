# PR 3 Wave 9 Oracle Re-Review

> **Reviewed fix:** `d21ea511447f4855730fa82046ee8b428cf222b5`  
> **Prior findings:** `docs/CRIP/PR-3/oracle-findings.md`  
> **CI observed:** GitHub Actions run `31433131640` succeeded. The Vitest phase reported **405 passed / 1 skipped (406 total) across 34 files**; type-check, build, self-contained bundle checks, `verify-cli-bundle`, post-build `smoke:cli`, and launcher/installer syntax checks all passed. `dist/cli.js` built at ~65 KB.

## 1. Verdict

**Block.**

Wave 9 materially closes both original PR 3 blocker reproductions in the normal/current-state path. Durable human-conflict markers now survive ordinary merge/reload cycles, schema validation rejects duplicate decision IDs, exact-ID mutation helpers fail closed on raw duplicates, the real display→confirmation TOCTOU test is now barrier-driven, and the CLI smoke is actually wired into CI.

Two release-gate edge cases remain, both in compatibility/repair paths introduced by Wave 9:

1. durable human-conflict reconstruction can invalidate a previously selected automated row without removing that row from the returned `authorities` array; and
2. duplicate-ID migration assigns fresh random UUIDs on every read-only load, so the “stable” repaired IDs exposed by recall/CLI are not stable across the subsequent transactional re-read.

These are narrow fixes, but both violate PR 3's central authority/exact-ID invariants and should be closed before Ship.

---

## 2. Blocking issues

### Blocker 1 — second-pass durable conflict reconstruction can return an invalid automated authority

**File:** `src/memory/decision-authority.ts` — `resolveDurableHumanConflicts()` and `resolveDecisionAuthorities()` final return (approximately lines 243-340 in Wave 9).

#### What happens

`resolveDecisionAuthorities()` performs authority selection in two phases:

1. first pass: group only raw `still_valid === true` rows and push selected rows into `authorities`;
2. second pass: `resolveDurableHumanConflicts(all, conflicts)` reconstructs persisted human-human conflicts from non-authoritative trusted-human rows.

The second pass correctly marks **every row in that quarantined topic** `still_valid=false`, including any automated row that the first pass already selected. But it never removes that row from `authorities`.

Because the object in `authorities` aliases the same cloned row in `all`, the result can literally contain:

```text
conflicts: [conflicting-human-foundational]
authorities: [ automated-row-with-still_valid=false ]
```

That violates the reader invariant that a conflicting-human-foundational topic has **zero** automated authorities.

#### Reproduction

Use a schema-valid state representing an upgrade from the pre-Wave-9 buggy state:

```text
human-a
  topic=database
  still_valid=false
  foundational=true
  human provenance + human_review
  conflicts_with=[human-b]

human-b
  topic=database
  still_valid=false
  foundational=true
  human provenance + human_review
  conflicts_with=[human-a]

auto-c
  topic=database
  still_valid=true
  foundational=false
  provenance=heuristic
```

This state is realistic: the previous blocker could persist `human-a`/`human-b` as non-authoritative and later allow automation to create `auto-c`.

Call:

```ts
const res = resolveDecisionAuthorities([humanA, humanB, autoC])
```

First pass:

```text
auto-c -> pushed into authorities
```

Second pass:

```text
human-a + human-b -> durable conflict reconstructed
auto-c.still_valid -> false
auto-c.conflicts_with -> [human-a, human-b]
```

But `authorities` still contains `auto-c`.

Expected:

```text
res.authorities.length === 0
res.conflicts.length === 1
```

Actual by code inspection:

```text
res.authorities.length === 1
res.authorities[0].id === auto-c
res.authorities[0].still_valid === false
```

#### Impact

`queryDecisions()` and `getProjectState()` consume `.authorities`, so an upgraded pre-Wave-9 state can still expose an automated decision as the project's authority while simultaneously reporting an unresolved protected human conflict.

The model-review path is safer because `requestFoundationalReview()` checks the conflict before promotion, but the semantic authority leak itself is release-gate relevant: PR 3 exists to make one trustworthy authority view.

#### Recommended fix

When durable conflict reconstruction quarantines a topic, remove every authority for that normalized topic before returning.

Good options:

```ts
resolveDurableHumanConflicts(all, conflicts)
const conflictedTopics = new Set(conflicts.map(c => c.normalized_topic))
const finalAuthorities = authorities.filter(a =>
  a.still_valid === true && !conflictedTopics.has(normalizeDecisionTopic(a.topic))
)
```

or have `resolveDurableHumanConflicts()` explicitly mutate an authority map/set while it reconstructs the conflict.

The final returned authority list should also defensively satisfy `authority.still_valid === true`.

#### Required regression tests

1. two persisted non-authoritative trusted humans + one raw-valid automated row, same topic → **zero authorities**, one conflict;
2. `queryDecisions()` on that state returns zero entries for the topic;
3. `getProjectState()` shows the conflict but no decision authority for that topic;
4. `mergeDecisions(existing, [], meta)` persists all three rows non-authoritative and the next reload still returns zero authorities.

---

### Blocker 2 — duplicate-ID migration generates different repaired IDs on every load

**Files:**

- `src/memory/migrate.ts` — `repairDuplicateDecisionIds()` (approximately lines 108-195)
- `src/memory/migrate.ts` — `loadAndMigrate()` duplicate repair call
- `src/memory/store.ts` — `candidateFrom()` and `mutateMemory()`'s `bypassCache: true` transaction read

#### What happens

Wave 9 correctly rejects duplicate IDs at the persisted schema boundary and attempts compatibility repair before validation.

However, `repairDuplicateDecisionIds()` assigns:

```ts
row.id = randomUUID()
```

for every row in the duplicate group.

`loadAndMigrate()` is deliberately pure and does **not** persist a migration during a read. Therefore the same on-disk bytes produce a different set of repaired IDs every time the file is loaded.

This directly conflicts with the meaning of a stable decision ID.

#### Reproduction — CLI

On disk:

```json
{
  "decisions": [
    { "id": "dup", "topic": "database", "decision": "Use PostgreSQL", ... },
    { "id": "dup", "topic": "database", "decision": "Use MySQL", ... }
  ]
}
```

Run:

```bash
tokenmaxxer decisions
```

Load #1 repairs `dup` to random IDs:

```text
A
B
```

The CLI displays authority ID `A` or `B`.

No write occurs.

Then run:

```bash
tokenmaxxer promote <displayed-id>
```

Load #2 repairs the exact same disk file to:

```text
C
D
```

The copied ID from the first command no longer exists, so promotion fails before the human can review it.

#### Reproduction — model tool / transaction

This can also fail inside one long-running process:

1. `recall_decision` reads and exposes repaired ID `A`;
2. `_recallPromote({decision_id: A})` enters `mutateMemory()`;
3. PR 2 correctly performs a `bypassCache: true` disk re-read under the lock;
4. `loadAndMigrate()` creates new repaired IDs `C/D`;
5. exact ID `A` is now `not-found`.

So the exact-ID path cannot reliably act on the ID it just exposed until some unrelated successful mutation happens to persist one random repair.

#### Impact

The Wave 9 duplicate-ID compatibility repair protects against trust being minted onto the wrong row, but it makes repaired decision IDs non-addressable across reads. That breaks the core human workflow:

```text
inspect stable ID -> confirm exact same ID transactionally
```

for the very legacy files the repair exists to support.

#### Recommended fix

The repair must be deterministic for identical input bytes.

Two reasonable designs:

**Preferred/simple:** preserve the old shared ID on one deterministic canonical winner and assign deterministic derived IDs only to the other duplicates. Existing lineage references to the old ID then naturally continue to point at the canonical winner.

Or:

- derive every replacement ID deterministically from a stable digest of fields such as old ID + row semantic identity + deterministic duplicate ordinal;
- encode it in a bounded UUID-like/string form;
- collision-check within the document.

Do not use `randomUUID()` in a read-only migration unless the migration is atomically persisted before exposing those IDs—which would violate the current intentionally-pure read design.

#### Required regression tests

1. call `loadAndMigrate(rawDuplicateState)` twice and assert the repaired IDs and rewritten lineage are identical;
2. store-level test: write raw duplicate-ID JSON, `readMemoryState()` to get the repaired authority ID, then perform `mutateMemory()` targeting that ID; the transaction's bypass-cache re-read must resolve the **same** ID and commit successfully;
3. CLI integration: `decisions` output ID from a duplicate legacy state remains usable by the subsequent `promote` invocation after review is requested;
4. model integration: `recall_decision` ID remains usable by `_recallPromote` despite the transaction's fresh disk read.

---

## 3. Non-blocking concerns

### A. `quarantinedHumanConflicts()` trusts the marker without verifying human trust

**File:** `src/memory/merge.ts` — `quarantinedHumanConflicts()`.

The merge helper treats any two rows with `human_conflict_quarantined=true` as a protected human conflict; it does not require `isHumanTrustRow(row)`. The schema also does not constrain the flag to human-trust rows.

A malformed but schema-valid file containing two heuristic rows with the flag could freeze a topic into human quarantine. This is fail-closed rather than a trust escalation, so I would not block PR 3 on it, but the durable marker should ideally be structurally tied to the human trust tuple or filtered through `isHumanTrustRow` in the merge helper.

### B. New ID length validation can reject a previously schema-valid v3 file

**File:** `src/memory/schema.ts` — `DecisionSchema.id` now `.max(MAX_IDENTIFIER)`.

Pre-Wave-9 v3 allowed arbitrary-length decision IDs. Generated IDs are UUIDs, so practical risk is low, but a manually edited/legacy v3 file with an ID >256 characters now fails migration/validation rather than receiving a compatibility repair. Consider bounding/repairing legacy overlong IDs during load if strict backward compatibility is desired.

### C. Vitest still reports one skipped launcher test, but the release gate is now covered

CI reports **405 passed / 1 skipped**, not 406 executed. The skipped Vitest launcher test remains expected before build, but Wave 9 now correctly runs `verify-cli-bundle` and `smoke:cli` after `npm run build`, and those checks pass. This is no longer a release blocker.

---

## 4. Test gaps ranked by likelihood × impact

### High × High

1. **Contaminated pre-Wave-9 human conflict:** two persisted human conflict rows plus one raw-valid automated row; assert the final authority list is empty.
2. **Duplicate migration stability across repeated loads:** same bytes must produce same repaired IDs.
3. **Duplicate migration + transaction re-read:** ID exposed by a read must survive `mutateMemory(... bypassCache=true)`.

### Medium × High

4. CLI/model exact-ID end-to-end flow beginning from an actual on-disk duplicate legacy state rather than a manually constructed in-memory duplicate.

### Low/Medium × Medium

5. Non-human rows carrying `human_conflict_quarantined=true` should not manufacture a human conflict.
6. Legacy overlong decision ID should either be repaired deterministically or explicitly documented as incompatible/corrupt.

The original 49 release-gate tests are materially better covered after Wave 9. The real display→confirmation TOCTOU case is now barrier-driven, and tests 46-49 are actually run post-build in CI.

---

## 5. Things that look fine

### Original blocker 1 common-path fix is correct

`resolveConflictingHumans()` now sets a durable quarantine marker on the conflicting trusted-human rows, and repeated merge/reload tests verify that an empty merge no longer erases the conflict. `mergeDecisions()` also checks durable quarantine before allowing an incoming automated authority.

### Original blocker 2 persistence and mutation guard is substantially fixed

`Decision.id` is bounded, `MemoryFileSchema.superRefine()` rejects duplicate IDs, and `getExactDecisionById()` gives mutation code a fail-closed `{exact|duplicate|missing}` result instead of first-match semantics. Review request, confirmation, supersession, and CLI pre/post-confirmation checks use that boundary.

### Read-only reconciliation no longer invents stronger provenance

Equivalent-text reconciliation now preserves the selected winner's own persisted provenance in the read view. LLM corroboration upgrades provenance only on the write path.

### Supersession candidate eligibility is stronger

`supersedeHumanAuthority()` now explicitly requires `candidate.still_valid === false`; a linked but currently-valid row cannot be used as an explicit human supersession candidate.

### Shared model review eligibility is now centralized

`_recallPromote()` routes through `requestFoundationalReview()` inside `mutateMemory()`, reducing drift between model-callable request behavior and the shared decision-review rules.

### Real TOCTOU regression is present

The new CLI test pauses during the actual display→stdin window, lets a real child process invalidate the target, then confirms the stale ID and verifies the CLI adds no additional write. That is the right test shape.

### CI smoke plumbing is fixed

Run `31433131640` executes the post-build CLI checks. `verify-cli-bundle` and `smoke:cli` both pass, and `dist/cli.js` is included in the self-contained bundle check.

---

## 6. Out of scope

- PR 4 OpenCode host-client closure / peer-contract tightening remains out of scope.
- PR 8 owns the final typed storage-budget contract.
- PR 10 owns immutable/checksummed distribution and dependency-audit classification.
- The existing npm audit findings remain a later release/dependency-hygiene concern and do not affect this PR 3 gate.

---

## Release-gate summary

Wave 9 is a strong correction and closes the original two failures for clean/current state. The remaining work is small and concentrated:

1. make durable human-conflict reconstruction purge any authority already selected for that topic; and
2. make duplicate-ID migration produce stable deterministic IDs across repeated read-only loads.

After those two regressions are fixed with the explicit tests above, PR 3 should be ready for a final re-review rather than another broad implementation wave.
