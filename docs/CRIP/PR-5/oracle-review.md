# PR 5 Oracle Review Handoff

Date: 2026-08-11

Release-gate testing and final approval are owned by the third-party oracle.
This document is a handoff only; no internal Oracle review or release-gate
validation is authoritative.

## Current implementation scope

- Wave 4 source preparation is split from queued processing.
- Queue coalescing uses `idle:<sourceVersionKey>`.
- The completed-source fast path checks before heuristic mutation.
- A second completion check remains before optional model work.
- Activity cleanup covers pre-queue terminal outcomes.
- PR 4 host/cooldown gating is restored for new LLM extraction.
- Wave 3 source-processing tests use schema-valid source keys.

## Known review points for the third-party oracle

- Verify the final working-tree diff and exclude unrelated `dist/*` and
  `opencode.json` changes from the PR 5 commit.
- Verify the preparation-time STATE-unavailable outcome against the project
  outcome contract (`write-failed` versus `error`) and the existing tests.
- Verify that `extractFactsLLM` coalesces by source-version identity, not only
  by session ID.
- Verify Wave 5 atomic `processed_sources` persistence separately; it is not
  implemented as part of the Wave 4-only scope.
- Run the complete release-gate test matrix independently and report all
  blockers in `docs/CRIP/PR-5/blockers.md`.

## Stop condition

No internal release-gate testing, Oracle approval, commit, push, or further
implementation is authorized by this handoff.
