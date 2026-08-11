# PR-6 Oracle Re-review Handoff

**Role:** focused independent re-review handoff, not an approval or verdict.

## Review lineage

- Findings source: `d70e0b0`, `docs/CRIP/PR-6/oracle-findings.md`.
- Findings reviewed head: `1acdce7`.
- Single remediation-wave head: `bd14e3c`.
- Exact remediation range: `d70e0b0..bd14e3c`.
- Exact remediation-head CI: GitHub Actions `31529085213`, passed on rerun.

## B1–B4 remediation

### B1 — current-v3 PR-5 broad cache upgrade

`loadAndMigrate()` now quarantines cache rows whose extraction contract is
missing or not v3 before current decisions-only cache parsing. Semantic STATE,
revision, and existing processed-source records survive. Contract-3 malformed
rows still fail closed.

### B2 — exhaustive provenance pairing

`ProvenanceSchema` now enforces the exact four pairings:

```text
heuristic ↔ heuristic
llm       ↔ llm-corroborated
human     ↔ human-reviewed
legacy    ↔ legacy
```

### B3 — non-decision LLM provenance

All LLM provenance on `current_task_provenance` and active-file provenance is
downgraded to legacy during compatibility repair, preserving semantic values,
paths, reasons, and bounded evidence. Field-specific durable schemas reject
future LLM claims in those non-decision locations.

### B4 — durable transcript-only LLM provenance

Durable LLM provenance now requires 1–3 transcript evidence entries. Mixed or
heuristic-candidate evidence is invalid; migration downgrades old claims that
do not satisfy the complete transcript-only tuple while preserving decision
identity and semantic history.

## Regression evidence

- New focused file: `test/memory/pr6-oracle-b1b4.test.ts` with 20 behavioral B1–B4
  regressions.
- Focused B1–B4/schema/migration/merge/extraction validation: **154 passed**.
- `npx tsc --noEmit`: passed.
- `npm test`: **39 files, 651 tests passed**.
- `git diff --check`: passed.

## Exact-head release evidence

GitHub Actions run `31529085213` passed all CI gates on remediation head
`bd14e3c`: full suite, TypeScript, host contract, build, self-contained bundle
verification, CLI bundle/launcher/installer checks, CLI smoke, and syntax checks.

The first attempt of that run hit an existing asynchronous activity-marker test
timing assertion; the same exact run was rerun without changing PR-6 code and
passed.

## Focused adversarial targets for Oracle

1. Version-3 PR-5 broad cache rows with contract 2, absent contract, and
   evidence-backed old provenance; preserve semantic STATE and contract-2
   processed sources.
2. Contract-3 malformed cache rows must fail closed rather than be silently
   downgraded.
3. All legacy/non-legacy extractor-confidence mismatches.
4. Complete and incomplete LLM provenance on current task and active files;
   verify exact legacy downgrade and preservation of bounded semantic data.
5. LLM provenance with heuristic-candidate or mixed evidence must not remain
   llm-corroborated, including current cache rows and migrated decisions.
6. Human authority, duplicate-ID, PR2 transaction, PR5 completion, and full
   release invariants remain unchanged.

No Oracle re-review, approval, or ship verdict was performed by the
implementation orchestrator.
