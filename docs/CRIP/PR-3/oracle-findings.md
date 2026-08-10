# PR 3 Third-Party Oracle Release-Gate Findings

> **Reviewed implementation:** `5b93492f5cc81e7e2bceb6dee482e43df00d8c41..e1bbf12`  
> **Investigation brief:** `28c885903d849089cf4bd30200bd7c5d02b2034a`  
> **Plan:** `docs/CRIP/PR-3/implementation-plan.md`  
> **CI observed:** GitHub Actions run `31429286028` succeeded on `28c8859`; the actual Vitest result was **382 passed / 1 skipped across 34 files**, followed by successful TypeScript type-check and distribution build. `dist/cli.js` built successfully at 57.92 KB.

## 1. Verdict

**Block.**

PR 3 closes most of the original decision-authority and promotion-trust problems, but two release-gate correctness failures remain:

1. unresolved conflicting human-foundational decisions lose their quarantine state when the write path persists the reconciled decision array, allowing later automation to create a new authority for a topic that explicitly has no automatic authority; and
2. the new exact-ID human review boundary assumes decision IDs are unique, but the schema does not enforce uniqueness and the mutation helpers update every row sharing an ID, so one human confirmation token can mint human trust onto a different decision than the one displayed.

Both failures are directly inside PR 3's trust boundary. They should be fixed before PR 3 is treated as complete.

---

## 2. Blocking issues

### Blocker 1 — conflicting-human quarantine is not durable through `mergeDecisions()`

**Files:**

- `src/memory/decision-authority.ts:172-201`
- `src/memory/merge.ts:189-235`

#### What happens

`resolveDecisionAuthorities()` correctly detects multiple conflicting trusted-human foundational rows. In the returned read view it:

- selects no authority;
- marks the human rows `still_valid=false`;
- adds reciprocal `conflicts_with` IDs; and
- returns one `conflicting-human-foundational` conflict record.

That is correct as an individual read-view operation.

The problem is how `mergeDecisions()` consumes it:

```ts
let result = resolveDecisionAuthorities(existing).decisions

for (const inc of incoming) {
  const resolved = resolveDecisionAuthorities(result)
  // conflict is reconstructed only from this second resolution
}
```

The first call throws away `.conflicts` and retains only `.decisions`. For a conflicting-human topic those copied decisions now have `still_valid=false`. The second call groups only `still_valid === true` rows, so it can no longer rediscover the human conflict. The topic therefore appears to have neither an authority nor a conflict.

The next incoming automated observation reaches:

```ts
if (!authority) {
  result = [...result, newDecisionRow(inc, meta, provenance)]
}
```

and becomes a new **valid automated authority**.

There is an even simpler failure mode: `mergeDecisions(existing, [], meta)` returns the first reconciled `.decisions` array with both humans invalidated. If that result is persisted by an otherwise ordinary idle mutation, the next process/read no longer reports the unresolved human conflict at all because the conflict record was never durable state and both human rows are now invalid.

#### Reproduction

Start with two valid, trusted, human-reviewed foundational rows on normalized topic `database`:

```text
human-a: Use PostgreSQL
human-b: Use MySQL
```

Both have `foundational=true`, human provenance, and `human_review.channel="interactive-cli"`.

Then either:

1. run a normal merge with no incoming decision for that topic and persist it; or
2. merge an incoming heuristic/LLM decision such as `Use SQLite`.

Expected:

```text
no automatic authority
human-a + human-b remain an unresolved protected human conflict
incoming automated observation is invalid and conflicts_with=[human-a,human-b]
```

Actual write-path behavior:

```text
human-a -> still_valid=false
human-b -> still_valid=false
conflict record discarded
incoming automation -> still_valid=true authority
```

After persistence, an authority-aware reader can expose the automated row as the topic authority while the prior human disagreement has disappeared from `getDecisionAuthorityConflicts()`.

This violates the plan's hard rule that multiple conflicting trusted-human authorities are quarantined until **explicit human resolution**, and it violates the automation-veto boundary PR 3 exists to establish.

#### Recommended fix

Make unresolved human conflicts durable across reconciliation and writes. At minimum:

1. Do not discard the initial `DecisionAuthorityResolution.conflicts` when initializing `mergeDecisions()`.
2. Ensure a topic already in `conflicting-human-foundational` state stays quarantined for the entire merge, including later incoming items in the same batch.
3. Ensure the persisted representation can reconstruct the conflict on the **next** read. Either:
   - keep the conflicting human rows in a durable state from which the resolver can still recognize the unresolved conflict; or
   - teach the resolver to reconstruct an unresolved human-foundational conflict from the durable human-review/foundational/conflict lineage even when those rows are non-authoritative; or
   - add an explicit bounded durable conflict representation.
4. Never permit `!authority` to mean "new topic" when the same normalized topic is under unresolved human conflict quarantine.

Required regression tests:

- two conflicting trusted humans + `mergeDecisions(..., [])` + persist/reload -> still one conflict and zero authority;
- two conflicting trusted humans + incoming heuristic -> zero automated authority; incoming row invalid and linked to both human IDs;
- same test for evidence-backed LLM input;
- repeat the merge/reload cycle multiple times to prove the quarantine does not evaporate after one write.

This is not covered by the current §7 merge tests. They cover a **single** trusted-human authority plus automation, not an already-quarantined pair of conflicting trusted humans.

---

### Blocker 2 — exact-ID human review is ambiguous because decision IDs are not required to be unique

**Files:**

- `src/memory/schema.ts:68-84, 231-292`
- `src/memory/reader.ts:61-68`
- `src/memory/decision-review.ts:98-141, 198-235`
- `src/cli.ts:181-290`

#### What happens

PR 3 deliberately makes the stable decision ID the security/trust address for human review. The user is shown one decision, types its exact ID, and the transaction is supposed to revalidate that exact same decision before minting `human-reviewed` provenance.

However, `MemoryFileSchema` does not require decision IDs to be unique. `DecisionSchema` accepts any string ID and the memory-level refinement checks trust/lineage consistency but never rejects duplicate IDs.

The read and mutation operations then use incompatible duplicate-ID semantics:

```ts
getDecisionById(mem, id)
// -> mem.decisions.find(...), first matching row
```

while confirmation uses:

```ts
memory.decisions.map((d) =>
  d.id === decisionId ? humanReviewed(d) : d
)
```

which updates **every** matching row.

The same pattern exists in the review-request path: eligibility is decided using one found/resolved row, but all raw rows with the matching ID receive `foundational_requested=true`.

#### Reproduction

Create a schema-valid v3 STATE containing two rows with `id="dup-id"`:

```text
row 1: invalid/history, topic=auth, decision="Use JWT",
       foundational_requested=true

row 2: valid current authority, topic=auth, decision="Use OAuth2",
       same id="dup-id"
```

This file currently passes the ID portion of `MemoryFileSchema` because uniqueness is not enforced.

Then run:

```bash
tokenmaxxer promote dup-id
```

The CLI can:

1. obtain `raw` using `find()` and display row 1 (`Use JWT`);
2. find a current authority whose ID is also `dup-id` and therefore accept the ID as authoritative;
3. let the human type `dup-id`, believing they are confirming the displayed row;
4. revalidate under the transaction using the same ambiguous ID; and
5. call `confirmFoundationalReview()`, whose `map()` upgrades **both rows** with that ID to `foundational=true`, `human_review`, and human-reviewed provenance.

The current valid authority (`Use OAuth2`) can therefore receive trusted-human provenance even though that is not the decision text the human was shown. The historical row also becomes protected foundational state.

This breaks the core PR 3 guarantee that an exact stable ID binds the displayed human decision to the exact row upgraded under the lock.

#### Recommended fix

Treat decision-ID uniqueness as a persistence invariant, not a convention.

Preferred fix:

1. Bound `Decision.id` consistently with the lineage fields (`MAX_IDENTIFIER`).
2. Add a `MemoryFileSchema.superRefine()` rule rejecting duplicate decision IDs.
3. For legacy/pre-PR3 files that could contain duplicate IDs, either:
   - fail closed as unavailable/corrupt until repaired; or
   - perform a deterministic migration repair that assigns fresh IDs while preserving explicit lineage. Do not silently choose one duplicate as the human-review target.
4. Add defensive exact-ID helpers that require **exactly one** raw match before any review request, promotion, or supersession. A duplicate-ID state should return an explicit ambiguous/invalid-state result even if schema validation is accidentally bypassed in a test or future internal caller.

Required regression tests:

- schema rejects two decisions with the same ID;
- exact-ID `recall_promote` refuses duplicate IDs with no mutation;
- CLI `promote` refuses duplicate IDs before interactive confirmation and mints no human trust;
- `confirmFoundationalReview()` fails closed when passed an in-memory duplicate-ID state;
- `supersede` also rejects duplicate authority/candidate IDs.

The existing "duplicate historical ID" tests use **different IDs for duplicate semantic rows**; they do not exercise duplicate identifier values.

---

## 3. Non-blocking concerns

### A. Read-only authority resolution changes provenance/rationale instead of preserving the winner as-is

**File:** `src/memory/decision-authority.ts:126-151`

For equivalent decision texts, the resolver selects a stable winner and then copies the strongest row's provenance and sometimes rationale onto that winner in the returned read view.

This is pure with respect to the input array, but it is not a faithful read of the persisted winner. A disk state containing an old heuristic row plus a later agreeing LLM row can make `recall_decision` report the heuristic row's stable ID with LLM provenance that is not stored on that row.

The implementation plan permits strongest-provenance copying **when reconciliation is persisted**. The investigation brief explicitly asks the read view to preserve the winner's provenance/rationale as-is. The current test `decision-authority.test.ts` item 3 instead codifies the read-time provenance upgrade, so test and review contract disagree.

Suggested follow-up: keep `resolveDecisionAuthorities()` as an authority/lineage view only; perform provenance enrichment in the write reconciliation/merge path where it becomes durable. At minimum, document one authoritative semantic contract and align the test with it.

### B. Heuristic supersession rewrites lineage on all same-topic non-human history, not only the prior valid authority set

**File:** `src/memory/merge.ts:274-292`

The heuristic conflict path maps every same-topic non-human row to `still_valid=false, superseded_by=<new-id>`, including rows already invalid for another reason (for example an LLM conflict candidate). The plan says a later heuristic supersedes prior valid same-topic non-human authorities.

Repointing historical candidates can erase why a row originally existed and makes lineage less trustworthy. Restrict supersession updates to the reconciled prior authority/valid rows; leave unrelated invalid history unchanged unless there is a deliberate lineage rule.

### C. `supersedeHumanAuthority()` does not itself require the candidate to be invalid

**File:** `src/memory/decision-review.ts:242-319`

The plan says the candidate must be an **invalid** same-topic conflict candidate. The helper checks same topic and `conflicts_with`, but not `candidate.still_valid === false`. The normal merge path creates invalid candidates, so this is not currently a normal-production escalation path, but malformed/manual state can bypass the intended eligibility definition.

Add the invalid-row condition to the shared helper and test a same-topic, linked, still-valid candidate refusal.

### D. Review-request eligibility is duplicated instead of using the shared helper

**Files:** `src/tools/recall.ts`, `src/memory/decision-review.ts`

The plan introduced `decision-review.ts` so model and CLI paths share one eligibility definition. `_recallPromote()` reimplements authority/conflict/topic logic rather than calling `requestFoundationalReview()`. The two are currently close, but this creates avoidable policy drift around future conflict/ID fixes. Once the blockers above are fixed, route the model request through the shared helper inside `mutateMemory()`.

### E. `Decision.id` is unbounded while lineage references are bounded to 256 characters

**File:** `src/memory/schema.ts:68-84`

An existing decision can have an arbitrarily long schema-valid ID, while `superseded_by`, `conflicts_with`, and `derived_from_decision_id` are capped at `MAX_IDENTIFIER`. A later conflict/supersession operation can therefore create an otherwise legitimate lineage reference that fails schema validation. Bounding IDs to the same identifier contract closes this mismatch and naturally belongs with Blocker 2.

---

## 4. Test gaps, ranked by likelihood × impact

### High — no regression for automation arriving while two human authorities are quarantined

This is the missing test that would have caught Blocker 1. §15 tests 13 and 16 cover automation conflicting with **one** human authority. They do not cover the §7 rule for a topic already containing multiple conflicting trusted-human rows.

Add both heuristic and LLM cases, plus a persist/reload cycle.

### High — no duplicate decision-ID test at schema, model request, or CLI trust boundary

This is the missing test for Blocker 2. Existing tests cover duplicate semantic rows with distinct IDs, not duplicate identifier values.

### High — the display→confirmation TOCTOU test is mocked rather than adversarial

`test/cli.test.ts` test 36 stubs `mutateMemory()` to return `decision-changed-during-review`. That verifies output handling, not the actual guarantee that the locked re-read detects a real state change after the user saw the prompt.

The investigation brief specifically asks for a child/barrier test where another mutation actually supersedes or changes the target during the confirmation window and the post-attempt STATE is checked. Add a real barrier-driven test for promotion and, ideally, supersession.

### High — required post-build CLI smoke is not wired into CI

The submission brief says all 383 tests are green and describes `test/cli-smoke/smoke.sh` as the release verification for §15 tests 46-49. The observed CI run actually reports:

```text
33 test files passed, 1 skipped
382 tests passed, 1 skipped
```

The skipped test is `test/cli-smoke/launcher.test.ts`, because `npm test` runs before `dist/cli.js` exists.

After the build, `.github/workflows/ci.yml`:

- verifies generated-chunk imports only for `dist/index.js` and `dist/tui.js`, not `dist/cli.js`;
- runs only `bash -n install.sh`;
- does **not** run `npm run verify-cli-bundle`;
- does **not** run `npm run smoke:cli` / `test/cli-smoke/smoke.sh`;
- does not run `bash -n bin/tokenmaxxer` in the workflow.

So the required launcher/install smoke exists but is never exercised by CI. Wire a post-build step such as:

```bash
npm run verify-cli-bundle
npm run smoke:cli
```

and include `dist/cli.js` in the self-contained bundle check.

### Medium — read-view provenance preservation contract is untested in the direction required by the investigation

Current authority tests assert the opposite behavior (read-time provenance upgrade). Resolve the contract and pin it explicitly.

### Medium — candidate-invalid requirement for `supersede` is not tested

Add a valid-but-linked candidate and assert refusal.

### Medium — repeated conflict reconciliation across writes is not tested

Even after Blocker 1 is fixed, test at least two consecutive unrelated/empty mutations and reloads to prove unresolved human conflicts remain visible and protected until explicit human supersession.

### Low — large `decisions --all` output is not explicitly bounded

The durable STATE cap limits practical size, so this is not a PR 3 blocker, but the investigation asks that a large historical set not crash the CLI. A simple large-fixture smoke test would be sufficient.

---

## 5. Things that look fine

### A. Model-callable `recall_promote` no longer mints human trust

**File:** `src/tools/recall.ts`

The exact-ID and compatibility-topic paths mutate only `foundational_requested=true`. They do not set `foundational`, human provenance, or `human_review`, and the request is performed inside one `mutateMemory()` transaction. The tool also refuses unresolved human-conflict topics and non-authoritative IDs under the normal unique-ID assumption.

This is a material improvement over pre-PR3 behavior.

### B. Structural human-trust validation is correctly enforced at persistence

**File:** `src/memory/schema.ts`

A row claiming any human trust signal (`extractor=human`, `confidence=human-reviewed`, or `human_review`) must be foundational and carry the full consistent human trust set with `human_review.channel="interactive-cli"`. Self-supersession, self-conflict, and duplicate conflict references are also rejected.

The schema is not a cryptographic identity system, but that is explicitly outside the product-level guarantee. Structurally, the intended trust tuple is enforced.

### C. Pre-PR3 unverified human claims are conservatively repaired

**File:** `src/memory/migrate.ts`

`loadAndMigrate()` repairs old `human` / `human-reviewed` rows that lack `human_review` before final v3 validation. It clears `foundational`, sets `foundational_requested=true`, downgrades extractor/confidence to `legacy`, and preserves source/evidence/semantic identity fields. The migration tests verify those properties.

This is the right compatibility posture: old claims are not assumed fake or assumed human; they simply require re-confirmation.

### D. The ordinary unique-ID CLI confirmation lifecycle is correctly shaped

**File:** `src/cli.ts`

For normal well-formed state, `promote` and `supersede`:

- require both stdin and stdout TTY;
- require an exact typed ID;
- offer no `--yes` or environment bypass;
- perform human input before acquiring the project lock;
- then use `mutateMemory()` and re-check current eligibility under the authoritative lock-read state.

No project lock is held while waiting for stdin. This preserves the PR 2 no-lock interactive boundary.

### E. Foundational pruning protection is implemented as fail-closed retention

**File:** `src/memory/writer.ts`

`pruneOld()` keeps foundational rows through invalid-row pruning, 30-day pruning, and 10/5 pressure. If protected state alone is irreducible above 8 KB, it remains over cap and the exact commit size guard rejects the write instead of deleting foundational state. The whole-pipeline test verifies the prior STATE bytes remain unchanged on rejection.

### F. CLI packaging paths are internally consistent

**Files:** `bin/tokenmaxxer`, `install.sh`, `package.json`

The launcher prefers package-relative `../dist/cli.js` and otherwise uses `~/.config/opencode/plugins/tokenmaxxer-cli.js`; the raw installer downloads `dist/cli.js` to that fallback path. `package.json` includes `dist/cli.js`/`.d.ts`, and the observed build produced the CLI bundle successfully.

### G. PR 2 transaction behavior remains green

The observed CI run still passes the project-lock and cross-process transaction suites, including the ABA-safe stale recovery tests and the PR 3 review-request concurrency update. I found no PR 3 regression that requires reopening the PR 2 lock protocol.

---

## 6. Out of scope

The following observations remain in their assigned later CRIP workstreams and should not block PR 3 by themselves:

- **PR 4 — OpenCode host contract:** broad peer dependency (`>=1.0.0 <2.0.0`), host-client closure, tool argument bounds, actual supported host floor.
- **PR 5 — source idempotency / truthful outcomes:** immutable source processing identity, recall recency semantics, truthful stage outcomes.
- **PR 6 — complete LLM trust boundary:** broader limits on what LLM extraction may author outside decision corroboration.
- **PR 7 — compaction quality / anti-drift:** host-native augmentation, repeated-compaction fidelity, durable-memory sanitization.
- **PR 8 — final typed storage/injection budget contract:** explicit irreducible-foundational overflow result rather than the current generic commit failure.
- **PR 9 — diagnostics/artifact accuracy.**
- **PR 10 — release/dependency hygiene:** immutable installer artifacts/checksums and dependency-audit classification. The current `npm ci` still reports the previously known audit findings; do not run a blind force upgrade as part of PR 3.

---

## Release-gate summary

PR 3's architecture is substantially better than the pre-PR3 state: authority-aware reads, request-only model promotion, interactive human confirmation, compatibility repair, foundational retention, and PR 2 transactional integration are all real improvements.

The gate remains **Block** because the two remaining failures occur exactly at the semantics PR 3 is supposed to make trustworthy:

1. an unresolved human-vs-human authority conflict can be erased by the write reconciliation and replaced by automation; and
2. the human confirmation token is not guaranteed to identify exactly one decision row.

Close those two invariants, add the missing adversarial tests (especially post-build CLI smoke and real display→confirmation TOCTOU), and PR 3 should be ready for a focused re-review rather than another broad redesign.
