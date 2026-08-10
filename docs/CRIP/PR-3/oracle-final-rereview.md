# PR 3 Final Oracle Re-Review

> **Reviewed fix:** `666be8ee033ff257d9e60d9f41c83527399c7052`  
> **Prior re-review:** `docs/CRIP/PR-3/oracle-rereview.md`  
> **CI observed:** GitHub Actions run `31436298457` succeeded. Vitest reported **417 passed / 1 skipped (418 total) across 34 files**; TypeScript type-check, distribution build, self-contained bundle verification, `verify-cli-bundle`, post-build `smoke:cli`, and installer/launcher syntax checks all passed. `dist/cli.js` built at ~65.8 KB.

## 1. Verdict

**Ship.**

Wave 10 closes both remaining PR 3 release-gate blockers from the Wave 9 re-review. I found no remaining correctness issue that should block PR 3.

The two final invariants now hold:

1. a `conflicting-human-foundational` topic cannot expose an automated authority, including when upgrading a contaminated pre-Wave-9 state; and
2. a duplicate-ID legacy STATE repairs to the same stable decision IDs on every pure read, so an ID exposed by recall/CLI survives the PR 2 transaction's fresh `bypassCache: true` re-read.

---

## 2. Blocking issues

**None.**

---

## 3. Final verification of prior blockers

### Blocker 1 — contaminated durable human conflict no longer leaks an authority

**File:** `src/memory/decision-authority.ts`

Wave 10 keeps the two-pass resolver but now applies a final defensive authority filter after `resolveDurableHumanConflicts()`:

```ts
const conflictedTopics = new Set(
  conflicts.map((c) => normalizeDecisionTopic(c.normalized_topic)),
)
const finalAuthorities = authorities.filter(
  (a) => a.still_valid === true && !conflictedTopics.has(normalizeDecisionTopic(a.topic)),
)
```

This closes the exact Wave 9 failure mode. If the first pass selects an automated row and the second pass later reconstructs a protected human-human conflict for that topic, the second pass invalidates the row and the final filter removes it from `authorities`.

The returned authority list now has a useful defensive invariant: every returned authority is still valid and no returned authority belongs to a quarantined human-conflict topic.

The new tests exercise the realistic upgrade state:

```text
human-a: trusted human, persisted non-authoritative conflict row
human-b: trusted human, persisted non-authoritative conflict row
auto-c: raw-valid automated row created by the pre-Wave-9 bug
```

They verify:

- `resolveDecisionAuthorities()` returns zero authorities and one conflict;
- `queryDecisions()` exposes no authority for the topic;
- `getProjectState()` shows the conflict but no automated decision authority; and
- `mergeDecisions(existing, [], meta)` persists all rows non-authoritative and a reload still returns zero authorities.

This is the correct regression shape and closes the blocker.

### Blocker 2 — duplicate-ID repair is stable across pure reads and transactions

**File:** `src/memory/migrate.ts`

`repairDuplicateDecisionIds()` no longer uses `randomUUID()` in the read-only migration path.

For an ordinary duplicate group:

- the deterministic canonical winner keeps the original shared ID;
- non-winners receive deterministic fixed-length IDs derived from SHA-256 of a versioned domain separator, the old ID, and stable group ordinal.

For an overlong legacy ID, the canonical row also receives a deterministic derived ID so it satisfies the new identifier bound.

This design has the key property the previous implementation lacked:

```text
same raw STATE bytes -> same repaired IDs -> same rewritten lineage
```

That property is now tested at four levels:

1. repeated direct `loadAndMigrate()` calls produce byte-for-byte equivalent repaired memory;
2. `readMemoryState()` exposes an ID that survives `mutateMemory()`'s fresh `bypassCache: true` read;
3. `recall_decision` exposes an ID that remains usable by `_recallPromote`; and
4. the real CLI `decisions` -> `promote <id>` flow succeeds against an on-disk duplicate legacy STATE.

The human-trust safety rule is also preserved: if any row in a duplicate group carries `human_review`, the entire duplicate group is demoted back to review-request state before any row can be treated as trusted human foundational.

This closes the exact-ID blocker.

---

## 4. Additional properties verified

### Durable marker now respects the trust boundary

`merge.ts` no longer treats `human_conflict_quarantined=true` on an arbitrary row as proof of a human conflict; `quarantinedHumanConflicts()` requires the row to satisfy `isHumanTrustRow()`.

A malformed heuristic row carrying the marker therefore cannot freeze a topic into protected human quarantine.

### Read-only reconciliation remains provenance-safe

Equivalent-text authority resolution preserves the winner's persisted provenance in the read view. Stronger LLM corroboration is applied only by the write path, so merely reading memory cannot manufacture a higher trust level.

### Human confirmation boundary remains intact

The Wave 10 changes do not weaken the PR 3 review boundary:

- model-callable promotion remains request-only;
- actual human trust still requires interactive CLI confirmation;
- confirmation occurs outside the filesystem lock;
- the exact decision is re-read and revalidated inside `mutateMemory()` before human trust is committed;
- concurrent stale confirmation fails closed.

### PR 2 transaction semantics remain intact

The new compatibility repair works with, rather than around, PR 2's transaction rule. Mutation reads still use `bypassCache: true`, and the stable migration IDs make the fresh authoritative read compatible with exact-ID review rather than weakening the fresh-read requirement.

### Foundational retention remains fail-closed

Nothing in Wave 10 changes the PR 3 pruning behavior: trusted foundational decisions remain protected from ordinary age/count pruning, and irreducible protected over-cap state is rejected by the commit size guard rather than silently deleting protected decisions.

### CLI release checks are actually executed

The earlier CI gap remains fixed. The Wave 10 CI run executes:

- the normal Vitest suite;
- `npm run build` including `dist/cli.js`;
- self-contained bundle checks including `dist/cli.js`;
- `npm run verify-cli-bundle`;
- post-build `npm run smoke:cli`; and
- `bash -n` on both installer and launcher.

The one skipped Vitest launcher test is the expected pre-build test; the equivalent release behavior is exercised after build by the shell smoke, so it is not a gate issue.

---

## 5. Non-blocking concerns

### Deterministic derived-ID collision handling could be made explicit

`derivedDecisionId()` produces a 128-bit truncated SHA-256 value in UUID-shaped form. Accidental collision risk is negligible, but the migration does not explicitly collision-check a derived ID against unrelated IDs already present in a deliberately crafted legacy document.

A crafted file could pre-use the exact deterministic replacement ID and cause final schema validation to fail rather than selecting another deterministic replacement. This is fail-closed and does not create a trust escalation, so it does not block PR 3. A future migration-hardening pass could deterministically probe a second ordinal/domain suffix until an unused ID is found.

### Dependency audit remains deferred

CI still reports the existing npm audit findings. Dependency classification/remediation belongs to PR 10 and is unchanged by PR 3.

---

## 6. Test coverage conclusion

The PR 3 release-gate matrix is now materially covered, including the adversarial cases that previously failed review:

- duplicate/stale topic authority reconciliation;
- human-vs-human conflict quarantine;
- contaminated-state upgrade recovery;
- heuristic/LLM conflict behavior;
- exact evidence-backed corroboration;
- model promotion request-only semantics;
- duplicate-ID refusal and migration repair;
- deterministic exact-ID behavior across fresh reads;
- interactive human confirmation and real display-to-confirmation TOCTOU;
- concurrent idle write + promotion;
- explicit human supersession;
- foundational retention and irreducible over-cap failure;
- CLI bundle/launcher/installer release checks.

CI on `666be8e` is green with **417 executed passing tests + 1 expected pre-build skipped test**, followed by all build and post-build verification steps.

---

## 7. Out of scope / next workstream

PR 3 is complete. The next CRIP workstream is **PR 4 — OpenCode Host Contract**, covering the host-client closure and supported peer/API contract.

Later work remains intentionally separate:

- PR 5 — source idempotency and truthful outcomes;
- PR 6 — complete LLM trust boundary;
- PR 7 — compaction quality and anti-drift;
- PR 8 — guaranteed storage/injection budgets;
- PR 9 — diagnostics/artifact correctness;
- PR 10 — reproducible release and dependency hygiene.

---

## Release-gate summary

**PR 3: Ship.**

The decision-authority model, review-request boundary, human-confirmed foundational trust, durable conflict quarantine, exact-ID compatibility repair, concurrent mutation behavior, and foundational retention now satisfy the Concrete Reliability Implementation Plan's PR 3 invariants.
