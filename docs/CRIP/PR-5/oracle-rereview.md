# PR-5 Oracle Re-review Handoff

**Document role:** remediation handoff for independent Oracle re-review; not a
verdict.

## Review lineage

- Original Oracle review target: `c9903a43a78dfabe097ced5a132d833d066f5f1a`.
- Original findings commit: `7e5486f` (`docs/CRIP/PR-5/oracle-findings.md`).
- Remediation head: `f5810cb5295b4888c5a1e5c85b7007bcb459cc44`.
- Exact remediation range: `7e5486f..f5810cb`.
- Scope: one remediation wave covering Oracle blockers B1–B4 only.

## Remediation summary

### B1 — incomplete cache cannot become authoritative

`finalLLMMerge()` now preserves the current accepted `args.llmFacts` when a
current-contract cache row lacks a matching `processed_sources` completion
marker. Stale cache payload facts cannot be promoted into completion state.

Regression coverage uses distinct stale and fresh facts and asserts the fresh
facts, cache contents, and completion marker.

### B2 — source and prompt windows are unified

`prepareIdleSource()` now builds source identity from the same bounded transcript
window used to construct the canonical prompt. The adversarial regression uses
more than 50 messages and more than 20 historical file candidates, then verifies
that a new in-window candidate changes the source identity and prompt-visible
candidate set.

### B3 — persisted identity names the model actually used

The health-gated model is now the authority for extraction cache identity,
final merge arguments, audit metadata, and `processed_sources.extraction_key`.
The automatic-discovery regression models a cooling model A and healthy model B,
then verifies prompt, cache, audit, and completion metadata all identify B.

### B4 — malformed recall input shapes are rejected

`markReferencedDecisions()` now requires a plain non-null, non-array object for
`state.input` before parsing. Null, missing, string, and array inputs contribute
no recency marks. Real tests cover the required malformed shapes.

## Verification evidence

- `npx tsc --noEmit` — passed.
- Focused command:
  `npx vitest run test/memory/writer-llm.test.ts test/memory/writer.test.ts test/memory/model-health.test.ts test/memory/extract-llm.test.ts test/memory/extract.test.ts test/tools/recall.test.ts`
  — **6 files, 197 tests passed**.
- `npm test` — **38 files, 578 tests passed**.
- `git diff --check` — passed.
- The B1–B4 tests are behavioral regressions, not implementation snapshots or
  placeholder assertions.

## CI status

The original head had green GitHub Actions run `31496973429`. A new exact-head
GitHub Actions run for remediation head `f5810cb` is required for the Oracle
re-review and has not been claimed by this handoff.

## Adversarial re-review targets

The independent Oracle should re-run or challenge:

1. B1 with stale cache facts differing from fresh accepted facts and no durable
   completion marker.
2. B2 with bounded-window file candidates displaced by long-session history.
3. B3 with automatic discovery ordering and model-health transitions that cause
   pre-gate and gated selections to differ.
4. B4 with missing, null, array, string, and object-prototype edge cases in
   completed recall tool input.
5. The full PR-5 release matrix and exact-head GitHub Actions workflow, including
   build, bundle, CLI smoke, and host-contract gates.

No Oracle review, approval, or ship verdict was performed by the implementation
orchestrator.
