# PR-8 Guaranteed Storage and Injection Budgets

## Goal

Implement the approved PR-8 plan from planning baseline
`7b1b904deb764cfe99c7b239f7cb75f34635688e` on top of current `main`
`43ff490f56b06b4e1e89db36ca7c6d2c55a2c0ec`, preserving the PR-7 production
baseline `141bec918d08d8e25a358231c15a16fcc37efb62` and all stated storage,
injection, trust, retry, and scope invariants.

## Phase order and ownership

1. **Wave 1 — contract freeze** — complete in `c728924`; three test-only lanes
   cover storage, schema/migration, and durable injection.
2. **Waves 2–3 — shared primitives and compatibility** — bounded production
   lanes for UTF-8/fit primitives and schema/migration ceilings; sequential
   dependency: Wave 2 before Wave 3.
3. **Wave 4 — canonical transaction boundary** — one owner for `mutateMemory`,
   typed budget rejection, next-revision fitting, protection metadata, and
   commit-result state.
4. **Wave 5 — mutation callers** — bounded lanes for writer, recall, CLI,
   completion-marker/audit retry semantics; integrate after Wave 4.
5. **Wave 6 — durable injection** — one owner for the independent 4,096-byte
   render policy, semantic priority, UTF-8 truncation, and evidence-count tags.
6. **Wave 7 — pressure/concurrency integration and repository audit** — release
   matrix integration, race/no-write checks, and scope/audit checks.
7. **Wave 8 — release evidence and Oracle handoff** — run the exact final
   release chain, write `oracle-investigation.md`, and stop. No ship verdict,
   Oracle findings, or PR-9 advancement is owned here.

## Review gates

The user explicitly assigns the release-gate decision and Oracle findings to
the independent Oracle. This implementation lane therefore performs the
required focused test/typecheck/repository evidence after each wave but does
not author Oracle findings or issue a ship verdict. The final handoff records
the specific Oracle attack surface from the approved plan for that independent
review.

## Accepted evidence so far

- Current implementation gaps are recorded in
  `docs/CRIP/PR-8/blockers.md`.
- Wave 1 contract reruns and the TypeScript check are recorded in that log.
- Wave 1 intentionally fails on current PR-7 production behavior; no test was
  weakened to make the baseline green.

## Active phase

Wave 2 is complete in `f9e079a` with 52/52 primitive tests and a passing
TypeScript check. Wave 3 schema/migration compatibility is complete with 19/19
PR-8 contracts, 76 existing schema/migration regressions, and a passing
TypeScript check. Wave 4 canonical transaction integration is complete in
`34d777c` with 55 focused transaction tests and a passing TypeScript check.
Wave 5 mutation callers and retry/public-outcome semantics are complete in
`03ba91e` with 199 focused tests and a passing TypeScript check. Wave 6
independent durable-injection selection and 4,096-byte rendering are now active. The
unrelated `opencode.json` modification and untracked `.opencode/` state remain
outside PR-8 ownership.
