# Third-Party Oracle: PR 3 Release-Gate Investigation

You are the third-party reviewer for PR 3 of `docs/CRIP/PR-3/implementation-plan.md`
in the TokenMaxxer repository. PR 3 makes durable decision semantics trustworthy
after PR 1 established authoritative storage and PR 2 established cross-process
transactions. This prompt is the release-gate investigation: an independent
reviewer who did not participate in the implementation, examining the change
with fresh eyes and an adversarial posture.

Read the plan first: `docs/CRIP/PR-3/implementation-plan.md` (1180 lines).

The implementation shipped in waves 1-8 (commit range `5b93492..e1bbf12`) on
`main`. PR 1 (`Storage authority and read semantics`) and PR 2 (`Cross-process
transactions`) are complete.

What was shipped (verify against the diff):

- Wave 1 (`6731e21`, `d476c8b`): failing regression fixtures for decision-
  authority, decision-review, CLI, plus extensions to merge/prune/migrate/recall.
- Wave 2 (`dccfef3`): extended `DecisionSchema` with `foundational`,
  `foundational_requested`, `human_review`, `superseded_by`, `conflicts_with`,
  `derived_from_decision_id`; `superRefine` trust+lineage invariants;
  `repairUnverifiedHumanClaims()` in `loadAndMigrate()`.
- Wave 3 (`1f759f4`): `src/memory/decision-authority.ts` —
  `normalizeDecisionTopic/Text`, `isTrustedHumanFoundational`,
  `resolveDecisionAuthorities` with five reconciliation cases (one valid,
  equivalent text, human veto, conflicting humans, conflicting non-human).
- Wave 4 (`74ad67c`): `mergeDecisions()` extracted from `mergeMemory()`;
  operates on the reconciled read view; new heuristic/LLM rules per plan §7.
- Wave 5 (`51521ef`): authority-aware reader (`queryDecisions`,
  `getDecisionById`, `getDecisionAuthorityConflicts`); `_recallDecision`
  exposes stable IDs; `_getProjectState` renders conflicts; `_recallPromote`
  redesigned as review-request only (`{decision_id}` or `{topic}`, mutation
  sets only `foundational_requested=true`).
- Wave 6 (`b4a2c5c`): `src/memory/decision-review.ts` pure helpers
  (`requestFoundationalReview`, `confirmFoundationalReview`,
  `supersedeHumanAuthority`); `src/cli.ts` with `decisions/promote/supersede`
  and TTY-only confirmation; `bin/tokenmaxxer` dispatches all four subcommands;
  `package.json` adds `build:cli`; `install.sh` downloads the CLI bundle.
- Wave 7 (`a522929`): `pruneOld` protects foundational rows across all stages;
  irreducible over-cap fails closed via `commitMemoryExact` size guard.
- Wave 8 (`e1bbf12`): updated cross-process recall test to assert
  review-request semantics; new adversarial concurrent tests (idle+CLI
  promote, idle+recall_promote review, idle+CLI supersede); CLI smoke
  (`test/cli-smoke/smoke.sh`, `test/cli-smoke/launcher.test.ts`).

CI signal at submission: `tsc --noEmit` clean; `npm run build` produces
`dist/cli.js` (57.92 KB); `bash -n install.sh` and `bash -n bin/tokenmaxxer`
pass; full suite **34 files / 383 tests** all green; 5× adversarial run of
the concurrent-idle-promotion suites green (88 tests each run).

`docs/CRIP/PR-3/blockers.md` is the live implementation decision log; record
wave-by-wave design decisions, test gaps, and the scope deviations.

---

## What to investigate (priority order)

### 1. Decision authority correctness — reconciliation edge cases

`resolveDecisionAuthorities` is the read-view reconciliation that decides
which row is the authority for each normalized topic. Verify each case in
plan §6.2:

- **Single valid row → authority.** Determinism is trivial but verify no
  other transformation is applied to the row (no metadata mutation, no
  provenance copy, no ID change).
- **Multiple valid rows with equivalent normalized decision text.** The
  winner is: trusted-human if present, else oldest timestamp asc, then
  lexical ID. The loser rows become `still_valid=false, superseded_by=
  <winner-id>`. The winner's provenance/rationale is preserved as-is in
  the read view (the plan allows provenance copy when reconciliation is
  persisted, but the read view itself must be pure). Verify the read view
  does NOT mutate the input array — copies are required.
- **Conflicting non-human rows.** Newest timestamp first; trust-rank tie-
  break (`llm-corroborated > heuristic > legacy`); lexical ID as final
  tie-break. Verify the trust-rank function actually reads the right field
  on the `provenance.confidence` literal.
- **One trusted-human + conflicting non-human.** The human stays the
  authority; conflicting rows become invalid with `conflicts_with=
  [human.id]`. **No `superseded_by`** on the conflicting rows (the human
  did not adopt those values). Verify with an actual test that the
  conflicting rows do not get a `superseded_by` set.
- **Multiple conflicting trusted-human rows.** No automated authority.
  Both human rows are kept with `foundational=true` and reciprocal bounded
  `conflicts_with`. The reconciliation must emit exactly one
  `conflicting-human-foundational` conflict record per topic. Verify the
  records are deduped if the same conflict exists across multiple reads.

Adversarial scenarios to specifically test:

- A legacy file with **three duplicate-valid rows for the same topic** —
  the read view returns ONE authority. Confirm that two of the three rows
  are present in the returned `decisions` array with `still_valid=false,
  superseded_by=<winner.id>` and that the input array is unchanged.
- A pre-PR3 file with an unverified `human-reviewed` row (extractor=human
  / confidence=human-reviewed without `human_review`) — confirm the
  compatibility repair in `loadAndMigrate()` downgrades it to legacy +
  foundational_requested=true + foundational=false BEFORE
  `resolveDecisionAuthorities` ever sees it. If a future bug changes the
  repair order, the unverified row would still pass the
  `isTrustedHumanFoundational` predicate (because it lacks
  `human_review`, the predicate returns false — confirm), but the
  reconciliation must NOT emit a `conflicting-human-foundational`
  conflict for that row.

### 2. Schema trust invariants — no path can mint human trust

The plan's hard invariants 4-6 require:

- A trusted human-reviewed foundational decision cannot be silently
  superseded by automation.
- Model-callable code cannot mint trusted human-reviewed provenance.
- Trusted human-reviewed provenance requires an explicit interactive
  human review record.

The `superRefine` in `MemoryFileSchema` enforces:

```text
extractor=human OR confidence=human-reviewed OR human_review present
  =>
foundational=true AND extractor=human AND confidence=human-reviewed
  AND human_review.channel="interactive-cli"
```

Plus lineage rejection of self-superseded_by, self-conflict, and
duplicate conflict IDs.

Verify:

- A `Decision` constructed in a test with
  `provenance.extractor="human"` but no `human_review` is REJECTED by
  `MemoryFileSchema.safeParse()`. Construct a minimal memory containing
  such a decision, assert `safeParse(mem).success === false` and that
  the issue path points to the missing `human_review`.
- The `_recallPromote` mutation produces a memory whose ONLY change is
  `foundational_requested=true`. Confirm that calling `_recallPromote`
  on an authority and then `MemoryFileSchema.safeParse(mem)` STILL
  succeeds — i.e. the review-request mutation does not introduce a
  validation error.
- The `confirmFoundationalReview` mutation produces a memory that
  passes the trust invariant (sets `human_review` AND
  `extractor=human` AND `confidence=human-reviewed` AND
  `foundational=true`).
- The `supersedeHumanAuthority` mutation:
  - new authority has the full human trust set;
  - old authority becomes `foundational=false` AND its
    `provenance.extractor` is downgraded to `legacy` (so the trust
    invariant does NOT require `human_review` on the old row).
    Verify the schema refinement lets `extractor=legacy` +
    `confidence=legacy` + `human_review` absent + `foundational=false`
    pass.
  - candidate becomes `still_valid=false` + `superseded_by=<new-id>`.

Adversarial scenarios:

- Can a model tool construct a `Decision` with all four trust fields
  set (`extractor=human`, `confidence=human-reviewed`, `human_review` =
  `{channel:"interactive-cli", reviewed_at:<ISO>}`, `foundational=true`)
  and bypass the human? The plan's answer is NO if the human-review
  metadata is the trust signal — verify that the schema rejects
  `human_review.channel` values other than `"interactive-cli"` and that
  the `reviewed_at` is bounded. (Note: this is product-level identity,
  not cryptographic; the schema check is the structural guarantee.)

### 3. Reader authority-aware view — never leak two authorities

`queryDecisions(mem)` returns `resolveDecisionAuthorities(mem.decisions).
authorities`. Verify:

- A STATE with two valid rows for the same topic produces
  `queryDecisions` returning ONE entry, not two.
- A STATE with one human + one newer LLM + one newer heuristic for the
  same topic produces ONE entry (the human).
- A STATE with the conflict-quarantine case produces ZERO entries for
  that topic (no automated authority), and
  `getDecisionAuthorityConflicts` returns ONE record with both human
  IDs.

`recall_decision` output includes a copyable stable ID. Verify the
output marker format includes the ID and that the ID matches the
underlying `decision.id` (no transformation).

`get_project_state` includes a bounded conflict line per
`conflicting-human-foundational` topic. Verify:
- the line appears ONLY when conflicts exist;
- the line does NOT dump every historical invalid row;
- the line format is bounded and includes both human IDs.

Adversarial scenarios:

- A STATE with NO decisions produces a sane empty output (no conflict
  line, no decisions line, no crash).
- A STATE with a SINGLE decision topic and NO conflict produces a
  decisions line, NO conflict line.

### 4. `recall_promote` as review-request only

The model-callable tool must NEVER mint `foundational=true` or human
provenance. Verify:

- Calling `_recallPromote({decision_id: <id>})` on a valid non-human
  authority:
  - Sets `foundational_requested=true`.
  - Does NOT change `foundational` (still `false`).
  - Does NOT change `provenance.extractor`, `provenance.confidence`,
    or `human_review` (all unchanged).
- Calling `_recallPromote({topic: "Auth"})` (one-release compat) on a
  STATE with exactly one valid authority for the normalized topic:
  - succeeds; sets `foundational_requested=true` on that authority;
  - the result string includes the request message and the human
    confirmation command.
- Calling `_recallPromote({topic: "Auth"})` on a STATE with MULTIPLE
  authorities or any conflict:
  - refuses with a bounded "ambiguous" message;
  - NO STATE mutation.
- Calling `_recallPromote({decision_id: <non-existent-id>})`:
  - refuses with a bounded "not-found" message;
  - NO STATE mutation.
- Calling `_recallPromote({decision_id: <duplicate-historical-id>})`:
  - refuses with "not-authoritative" or equivalent;
  - NO STATE mutation.
- Calling `_recallPromote({decision_id: <trusted-human-id>})`:
  - no-op message;
  - NO STATE mutation.

Adversarial scenarios:

- A STATE with substring overlap (`auth` vs `authentication`): verify
  that `{topic: "auth"}` does NOT match an authority whose normalized
  topic is `"authentication"`. The normalization is exact, never
  substring.
- A STATE with a non-authoritative historical row that has
  `still_valid=true` but `superseded_by=<winner>`: verify
  `{decision_id:<non-auth-id>}` refuses with "not-authoritative".
- A STATE where the same ID is `still_valid=false` for both an LLM
  conflict-candidate and an authority row: verify the canonical
  authority view (not the historical row) is the only one accepted.

### 5. Human CLI confirmation boundary — TTY-only, transactional revalidation

`src/cli.ts` `promote` and `supersede` MUST:
- require `stdin.isTTY && stdout.isTTY`;
- require the human to type the exact displayed ID/confirmation token;
- never accept `--yes`, env var bypass, or piped confirmation;
- revalidate the exact ID inside one `mutateMemory()` transaction
  with `bypassCache: true`;
- if the target changed during display → confirmation, abort without
  promoting.

Verify:

- A `promote` call with `stdin.isTTY: false` returns a refusal without
  STATE mutation. The test injects a `CliIO` with `stdin.isTTY: false`.
- A `promote` call with `stdin.isTTY: true` and `read()` returning
  wrong ID → STATE byte-for-byte unchanged.
- A `promote` call with `read()` returning the exact ID → STATE updated
  with the full trust set (foundational=true, foundational_requested=
  false, human_review present, extractor=human, confidence=human-
  reviewed, source/audit/evidence preserved).
- A `promote` call where the locked-read base shows the target is no
  longer the authority → transaction returns `noop` with a
  `decision-changed-during-review` outcome; CLI fails closed.
- `supersede` requires the candidate to be linked to the authority via
  `conflicts_with`. Unrelated candidates → "not-linked" refusal.
- `supersede` always creates a NEW authority (UUID v4) rather than
  reactivating the invalid candidate; `derived_from_decision_id` is
  set on the new authority; the old authority is downgraded to legacy
  provenance + `foundational=false` + `superseded_by=<new-id>`.

Adversarial scenarios:

- A `promote` call where the user types the correct ID BUT the locked
  read shows the original authority was superseded during display →
  confirmation. The transaction must abort; no human trust is minted.
  Verify the State's pre-display snapshot equals the post-attempt
  snapshot byte-for-byte.
- A `supersede` call where the user passes an `authorityId` that is
  already superseded → "not-authority" refusal (the legacy downgrade
  removed its trusted-human status).
- A `promote` call where the user passes an ID that exists but is
  marked `still_valid=false` → "not-found" or "not-authoritative"
  refusal.

### 6. Concurrent correctness with PR 2 transactions

The plan's §14 sequence is:
```
LOCK -> re-read + verify exact authority + set requested -> commit -> UNLOCK
```

For model request. For human:
```
read for display
  ↓
interactive human confirmation (NO LOCK)
  ↓
LOCK -> re-read + re-resolve exact IDs + verify unchanged eligibility
  ↓
commit human review/supersession
  ↓
UNLOCK
```

Verify:
- Idle write + `_recallPromote` review-request: the child holds the
  lock during its idle write; the parent's review-request waits, then
  acquires the lock with `bypassCache: true`, sees the idle's
  mutation, rebases, sets `foundational_requested=true`, commits.
  Final STATE: revision = N + 2.
- Idle write + CLI `promote`: same shape; CLI's IO adapter returns
  the exact ID after the child barrier; final STATE has the full
  trust set + the idle write's fact.
- Idle write + CLI `supersede`: same shape; final STATE has one new
  human authority + the idle write's fact.
- Idle write + `_recallPromote` + concurrent idle write from another
  child: both children's idle writes serialize; the review request
  rebases on whichever lands last.
- TOCTOU: child A holds the lock and supersedes the target via a
  trust-conflict candidate during the parent's display window. When
  the parent's CLI `promote` enters the lock, the re-validation
  aborts.

Adversarial scenarios:

- A child holds the lock for a long time (10s+) and the parent's
  review request waits. When the child releases, the parent must
  acquire cleanly; no spurious timeout.
- A child crashes inside the lock (SIGKILL); the lock is recovered
  via the Wave 7/8 ABA-safe canonical claim; the parent's review
  request acquires after recovery.

### 7. `pruneOld` foundational protection

Plan §13 requires:

```text
1. Invalid-decision pruning keeps still_valid=false AND foundational=true.
2. 30-day age pruning never touches foundational rows.
3. 10/5 pressure stages: protected-first; foundational-first selection.
4. If foundational count > target, all foundational kept; stage may
   over-cap; commitMemoryExact rejects; prior STATE intact.
```

Verify:
- A 31-day-old `foundational=true` row survives age pruning.
- The 10-pressure stage with 10 foundational + 10 recent non-
  foundational keeps all foundational + the 10 most-recent
  disposables.
- The 5-pressure stage similarly protects foundational.
- A `foundational=false, superseded_by=<new>` row (explicitly
  superseded) is normally prunable again — Wave 6's
  `supersedeHumanAuthority` downgrades `foundational` on the old
  authority, so it becomes a normal disposable.
- An irreducible over-cap (20+ foundational rows alone exceed 8KB) →
  `pruneOld` returns over-cap state; `commitMemoryExact` rejects
  with `size-cap-exceeded`; `writeMemory` returns false; prior STATE
  on disk is byte-for-byte intact.

Adversarial scenarios:

- A row with `foundational=true` but `still_valid=false` AND
  `superseded_by=<new>` (a hybrid state from a partial supersede) —
  the pruneOld logic should treat this as foundational-protected
  (NOT prunable) until the row is explicitly downgraded.
- A row with `foundational_requested=true` but `foundational=false`
  (a review-request pending) — the pruneOld logic should treat this
  as NORMAL disposable (not yet confirmed foundational).

### 8. Launcher / install / CLI build

`bin/tokenmaxxer` dispatches:
- `opencode` → existing behavior (TOKENMAXXER_LLM_EXTRACT=1);
- `decisions` → CLI bundle;
- `promote` → CLI bundle;
- `supersede` → CLI bundle.

The CLI bundle is `dist/cli.js` (npm-relative `../dist/cli.js`) or
`~/.config/opencode/plugins/tokenmaxxer-cli.js` (raw installer). The
launcher fails with a clear reinstall message if absent.

`install.sh` downloads the CLI bundle alongside the server/TUI bundles
using the existing `download()` mechanics.

Verify:
- `npm run build` produces `dist/cli.js` non-empty.
- `bash -n install.sh` passes; `install.sh` contains the CLI
  download step and references `dist/cli.js`.
- `bash -n bin/tokenmaxxer` passes.
- `test/cli-smoke/smoke.sh` exercises each subcommand against a
  fixture project; assertions are bounded.
- The `verify-cli-bundle` script catches missing `dist/cli.js`,
  installer syntax errors, and missing CLI dispatch in the launcher.

Adversarial scenarios:

- Running `bin/tokenmaxxer unknown-command` exits non-zero with a
  bounded message.
- Running `bin/tokenmaxxer promote <id>` against a project with no
  CLI bundle available (simulated by `PATH` manipulation or
  `find_cli()` override) exits with the reinstall message.
- Running `bin/tokenmaxxer opencode` with no arguments preserves the
  existing opencode launcher behavior.

### 9. Mixed-version safety

The plan §17 (out of scope) explicitly does NOT redesign v4 STATE.
But the implementation MUST handle pre-PR3 v3 STATE files:

- v3 STATE without `human_review` fields → schema defaults make them
  optional or false.
- v3 STATE with `extractor="human" / confidence="human-reviewed"`
  without `human_review` → `loadAndMigrate()` repairs them to
  legacy + foundational_requested=true + foundational=false
  IN MEMORY. The repair persists on the next successful STATE
  mutation.
- v3 STATE with a duplicate-valid same-topic pair → the read view
  via `resolveDecisionAuthorities` collapses to ONE authority
  immediately; the next mutation persists the reconciliation.

Verify:
- A v3 STATE constructed in a test with the legacy unverified
  human-review row, fed through `loadAndMigrate`, produces a
  memory where:
  - the row has `foundational=false`, `foundational_requested=true`;
  - `provenance.extractor === "legacy"`, `provenance.confidence ===
    "legacy"`;
  - `id`, `topic`, `decision`, `rationale`, `timestamp`, `session_id`,
    `evidence` are preserved;
  - no transcript or command text is added.
- A v3 STATE with two legacy duplicate-valid rows, fed through
  `loadAndMigrate`, then `queryDecisions`, returns ONE authority.
  The historical row is `still_valid=false, superseded_by=
  <winner.id>` in the next persisted state.

Adversarial scenarios:

- A v3 STATE with a JSON-bad human-review field that fails schema →
  the existing `loadAndMigrate` corrupt-handling must surface the
  failure without silently dropping the row.
- A v3 STATE with `conflicts_with` containing the row's own id →
  schema rejection (the Wave 2 superRefine invariant).
- A v3 STATE with `superseded_by === id` → schema rejection.

### 10. CLI behavior under pre-PR3 STATE

`src/cli.ts` `decisions` reads the authoritative state via
`readMemoryState` and then `queryDecisions` + `getDecisionAuthorityConflicts`.

Verify:
- A STATE that is `unavailable` (both candidates unreadable) →
  `decisions` distinguishes "unavailable" from "no memory" with a
  bounded message.
- A STATE that is `missing` (no memory exists) → "No project memory
  yet." (or equivalent bounded message).
- A STATE with one authoritative valid row → the decision line is
  emitted with the stable ID marker.
- A STATE with the conflict-quarantine case → the conflict line
  appears; `--all` shows the historical rows; default does NOT.

Adversarial scenarios:

- A STATE with a human-conflict where the human IDs are very long
  (>MAX_IDENTIFIER) → the conflict line is truncated or fails
  gracefully (not buffer-overflowing the CLI output).
- A STATE with hundreds of decisions and `--all` → the output is
  bounded (paginated or limited). The plan does not require
  pagination but the output should not crash on large states.

### 11. Pre-PR3 unverified claims — does the repair survive a read
without a write?

`loadAndMigrate` performs the repair IN MEMORY. It does not write. So
the next mutation must persist the repair.

Verify:
- A STATE with an unverified human-review row is loaded,
  `loadAndMigrate` returns the repaired memory.
- If a read-only tool (`queryDecisions`, `recall_decision`,
  `get_project_state`) is called on that repaired memory, the
  repair is visible (the row appears as legacy + requested).
- If no mutation is performed, the on-disk STATE file is still the
  pre-PR3 byte-for-byte. The next `mutateMemory` call must persist
  the repair naturally.

Adversarial scenarios:

- Two readers (`recall_decision` and `get_project_state`) operating
  on the same pre-PR3 STATE both see the repair in memory, but the
  on-disk file is unchanged until a mutation occurs.
- A pre-PR3 STATE that is repaired in memory and then NEVER mutated
  remains on disk with the original `extractor=human`. The next
  process load re-repairs it.

### 12. CI plumbing

- The PR 2 fixture `transaction-worker.ts` is reused for the new
  barrier-driven concurrent tests. Verify the fixture commands
  (`idle-write`, `barrier-write`, `hold-write`, etc.) cover the
  needs of the new tests.
- `tsconfig.json` includes only `src`. Tests reference
  `../../src/...` or `../src/...` depending on nesting. The
  `tsc --noEmit` invariant is preserved.
- The `tsx` devDependency (added in PR 2) is sufficient for the
  child-process fixtures.

---

## Deliverable

Write your findings as a single markdown document. Structure:

1. **Verdict** — Ship / Ship-with-fixes / Block (one line).
2. **Blocking issues** — file:line, reproduction, recommended fix.
3. **Non-blocking concerns** — file:line, why they matter, suggested
   follow-up.
4. **Test gaps** — scenarios that the test suite does not cover,
   ranked by likelihood × impact. Specifically note any of the
   49 §15 release-gate tests that you could not verify are covered
   with a barrier-driven (not startup-race) test.
5. **Things that look fine** — call out at least three properties
   you verified and confirmed correct, with file:line evidence.
6. **Out of scope** — anything you noticed that is slated for PR 4
   (host-client closure) or later and should not block this PR.

Be specific. Do not say "consider refactoring X" without pointing to
the exact line and explaining what concrete failure mode you are
worried about. Do not pad with generalities.

If you would block the PR, do so with one decisive reason per
blocker. A release gate with five vague concerns is not useful; a
release gate with two precise blockers is.

Pay particular attention to investigation areas 1, 2, 4, 5, 7, and 9.
These are the properties that distinguish a release-gate-correct
implementation from one that merely compiles and passes local
tests.