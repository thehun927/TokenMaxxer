# PR-6 Oracle Investigation Handoff

**Role:** independent Oracle handoff, not an approval or verdict.

## Baseline and implementation range

- PR-5 shipped production baseline: `29fcffafe1ccbf9b052bf8c30999fff8604e1726`.
- PR-6 implementation wave range: `6ecd164..63eba2c`.
- Exact implementation commits:
  - `6ecd164` — Wave 1 trust-contract tests.
  - `9d6365b` — Wave 2 contract v3 and type separation.
  - `8fb1a89` — Wave 3 transcript-only evidence boundary.
  - `6500289` — Wave 4 decisions-only writer/authority merge.
  - `40bf709` — Wave 5 decisions-only cache and compatibility repair.
  - `99904f7` — Wave 6 durable provenance invariants.
  - `63eba2c` — Wave 7 obsolete seam cleanup.
- PR-6 planning commits preceding implementation: `8518ed9`, `b29444b`,
  `01072ae`.

## Wave summary

### Wave 1 — trust contract freeze

Added failing contract tests for decisions-only structured output, transcript
evidence, non-decision immutability, cache shape, quarantine, and compatibility
repair before production semantics changed.

### Wave 2 — contract v3 and type separation

Raised the extraction contract to v3, introduced distinct heuristic and
decisions-only LLM facts, strict bounded schema/JSON schema, and required
evidence references.

### Wave 3 — transcript-only evidence

Split transcript evidence from heuristic candidates and made LLM evidence
resolution transcript-only. Mixed-validity decisions retain only exact,
source-matching evidence-backed decisions.

### Wave 4 — decisions-only merge

Added an explicit LLM decision merge boundary. LLM extraction cannot mutate
current task, active files, blockers, next steps, or foundational authority
state; PR-3 authority semantics remain authoritative.

### Wave 5 — cache and compatibility

Cache payloads are decisions-only and require current identity plus evidence-
backed provenance. Broad pre-v3 rows quarantine safely, and incomplete LLM
claims downgrade to legacy without deleting semantic state.

### Wave 6 — durable provenance

Provenance extractor/confidence pairings and LLM audit/evidence requirements are
schema-enforced. Migration repairs unsupported non-decision and incomplete LLM
claims conservatively.

### Wave 7 — obsolete seam cleanup

Removed the redundant model lookup, cached-facts early-success path,
`mergeAsyncFacts()` seam, compatibility full-facts LLM dispatcher, and generic
LLM evidence fallback. Remaining `ExtractedFacts` references are heuristic-only.

## Release evidence

| Gate | Evidence | Result |
| --- | --- | --- |
| TypeScript | `npx tsc --noEmit` | Passed |
| Full regression | `npm test` — 38 files, 631 tests | Passed |
| Host contract | `npm run verify:host-contract` | Passed |
| Distribution build | `npm run build` | Passed |
| Self-contained bundles | Node check for non-empty/no generated chunk imports | Passed |
| CLI bundle | `npm run verify-cli-bundle` | Passed |
| CLI smoke | `npm run smoke:cli` | Passed |
| Installer/launcher syntax | `bash -n install.sh`; `bash -n bin/tokenmaxxer` | Passed |
| Exact-head CI | GitHub Actions run `31527531666` on `63eba2c` | Passed |

CI emitted only the existing Node.js 20 action deprecation annotation; no job
failed.

## Known non-blocking concerns

- `dist/*` and `opencode.json` retain unrelated local changes and are excluded
  from PR-6 commits. The CI build generated clean artifacts in its isolated
  checkout.
- PR-6 deliberately does not claim cross-process in-progress prompt
  deduplication; it preserves PR-5's durable-completion convergence boundary.
- The implementation retains heuristic-only `ExtractedFacts` schema/type code;
  no LLM module imports it after Wave 7 cleanup.

## Oracle adversarial targets

The independent Oracle should challenge:

1. Structured output attempts to smuggle current task, files, blockers, next
   steps, or `foundational` fields.
2. Heuristic candidate refs, altered transcript digests, mixed valid/invalid
   decisions, and empty decisions.
3. Direct final-merge callers attempting to pass non-decision fields through a
   type assertion.
4. Broad pre-v3 cache rows and incomplete LLM rows inside otherwise valid STATE.
5. Zero-decision and >3-evidence successes proving completion does not depend on
   cache payload storage.
6. Contract v2 versus v3 completion identity and model A/B health selection.
7. Mismatched extractor/confidence pairs, non-transcript LLM evidence, and
   non-decision LLM provenance after migration.
8. Repository searches for cached-facts early success, full-facts LLM merge,
   generic evidence fallback, redundant model lookup, or network inside a
   filesystem transaction.
9. PR-2 transaction barriers and PR-3 human authority invariants across all
   changed paths.

No Oracle review, approval, or ship verdict was performed by the implementation
orchestrator.
