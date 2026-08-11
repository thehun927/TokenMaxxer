# CRIP PR 7 — Implementation Blockers

This is an append-only implementation log. Entries record discrepancies,
decisions, and validation results; do not rewrite prior entries.

## 2026-08-11 — Initial reconciliation

- **BLOCKER:** The required files `docs/CRIP/PR-7/implementation-plan.md` and
  `docs/CRIP/PR-7/README.md` are absent from the checked-out `main` at
  `9427716c264e3ca37e0733011cd00e4bf4529d26`.
- The available program plan is `docs/CRIP/implementation-plan.md`; its PR-7
  section defines the compaction invariants and required tests but does not
  contain the requested PR-7 wave ownership sections (§13 and §17).
- **BLOCKER:** The supplied planning baseline
  `fdc93cfd757b6cf807a9dadd5127c0abceb6572` is 39 characters and does not
  resolve as a Git commit. The supplied production baseline
  `bd14e3c8440cfa43bae3ac367226d59ec1709f34` resolves and is an ancestor of
  the current PR-6 re-review handoff.
- Current source reconciliation against `main`: `src/index.ts` replaces the
  host compaction prompt whenever `options.compactionPrompt` is true;
  `src/config.ts` exposes only the legacy boolean kill switch;
  `src/compaction/prompt.ts` has the older preservation contract; and
  `src/compaction/durable.ts` interpolates durable values and verbose
  provenance directly without the PR-7 data-only sanitization boundary.
- No production changes have been made. Wave 1 is blocked until the canonical
  PR-7 plan (including §13 and §17 ownership) and a resolvable planning
  baseline are supplied or explicitly authorized to be reconstructed from the
  program-level plan.

## 2026-08-11 — Remote plan reconciled

- Resolved by fetching and fast-forwarding `origin/main` to
  `bfedb5957293ffc2a037926bc1d74b0fac340893`.
- The canonical PR-7 plan and README are now present at
  `docs/CRIP/PR-7/implementation-plan.md` and `docs/CRIP/PR-7/README.md`.
- The plan records the valid planning baseline as
  `fdc93cfd757b6cf807a9dadd5127c0abceb657e`; the user-provided value omitted
  the final `e`. The production baseline matches the supplied
  `bd14e3c8440cfa43bae3ac367226d59ec1709f34` and remains the PR-6 tested
  remediation head.
- Plan §13/§17 ownership is adopted: Wave 1 will use three disjoint,
  test-only lanes owned by host/config, preservation/prompt, and
  durable/adversarial fixtures. Agents are not authorized to modify
  production code or pull PR-8/PR-9 scope forward.

## 2026-08-11 — Wave 1 validation

- Integrated test-only changes from the three disjoint lanes. No `src/`,
  package, or generated production files were changed.
- Reconciled a host-contract test edit that had weakened PR-4 exact type
  equality checks. `test/host-contract/typecheck.ts` now retains the original
  `Equal`/`Assert` checks and adds an exact `Hooks["experimental.session.compacting"]`
  output-shape assertion.
- Reconciled ESM test harness issues by replacing dynamic CommonJS `require()`
  calls in the new prompt fixtures with static imports. This preserves the
  intended red contract failures instead of producing module-resolution errors.
- Reconciled the durable fake-delimiter fixture so full outer delimiters must
  remain exactly once while stored delimiter values must not remain verbatim.
  This matches the sanitizer contract and does not weaken the adversarial case.
- `git diff --check`: **passed**.
- `npx tsc --noEmit`: **passed**.
- `npm run typecheck:host-contract`: **passed**.
- Focused Wave-1 command:
  `npm test -- test/compaction/prompt.test.ts test/compaction/prompt-contract.test.ts test/compaction/anti-drift.fixture.test.ts test/compaction/durable.test.ts test/compaction/bounded.test.ts test/compaction/sanitize.test.ts test/compaction/config.test.ts test/index.test.ts --reporter=dot`
  result: **6 test files failed, 2 passed; 86 tests failed, 34 passed**.
  The failures are the expected frozen PR-7 contracts against the unchanged
  pre-Wave-2/3/4 production implementation; the original prompt and bounded
  behavior remains green.
- Full `npm test -- --reporter=dot` result: **6 test files failed, 37 passed;
  86 tests failed, 658 passed**. Existing PR-1–6 tests passed; the failures
  are confined to the newly added PR-7 contract fixtures and the expected
  Wave-1 hook/config assertions.
- Wave 1 exit: **complete**. Production implementation remains intentionally
  untouched; proceed to Wave 2 only after this test-freeze commit.

## 2026-08-11 — Wave 2 validation

- Integrated Wave 2 production changes in `src/types.ts`, `src/config.ts`, and
  `src/index.ts`. Scope remained limited to explicit mode configuration,
  native augmentation routing, and hook metadata.
- Review correction: an explicitly invalid new mode now fails closed to
  `augment` even when the legacy flag requests replacement; this is covered by
  an added config contract test.
- Review correction: compaction logs and `last_compaction.log` now record
  `requested_mode`, `effective_mode`, and `kind` metadata as required by §11.
- `npm test -- test/compaction/config.test.ts`: **passed, 13 tests**.
- `npm test -- test/index.test.ts -t "PR 7 Wave 1"`: **passed, 5 tests;
  6 skipped**.
- `npx tsc --noEmit`: **passed**.
- `npm run typecheck:host-contract`: **passed**.
- Full `npm test -- --reporter=dot`: **5 test files failed, 38 passed; 74
  tests failed, 671 passed**. Remaining failures are the intentionally
  unfrozen Wave 3/4/5/6/7 contracts; Wave-2-owned config and hook tests are
  green.
- Wave 2 exit: **complete**. Production changes are ready for one coherent
  commit before Wave 3.
