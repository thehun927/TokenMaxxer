# PR-8 Oracle Second Final Re-review

**Verdict: Ship**

This is the independent Oracle release-gate verdict for CRIP PR 8 — Guaranteed Storage and Injection Budgets after the final residual remediation.

## Reviewed identities

- PR-7 production baseline: `141bec918d08d8e25a358231c15a16fcc37efb62`
- Initial PR-8 implementation head: `abcbce9ae30e4c55b47261cee7971173023cfb79`
- Initial Oracle findings: `9ffab0de7963a07356fe6bd1c807cb5da01686cb`
- First remediation: `5db7a53d7d9097a5f4997e4f68a339bef2324e10`
- Focused Oracle re-review Block: `096ddc136db04ce439ef81aef1e31db0c6a0749f`
- Final residual implementation: `15d3bb55b180c1db4981abb517f6bd159c68e049`
- CI-tested validation head: `79d17e0258176cad83dd862cbfa1561c177e10fd`

`79d17e0...` differs from `15d3bb5...` by one append-only documentation change to `docs/CRIP/PR-8/blockers.md`; no production source or test file changed between the residual implementation and the green CI tree.

## Final residual closure

### R1 — storage-policy residual: closed

The final residual patch fixes all three remaining disposable-retention errors in `src/memory/budget.ts`.

1. **Stage 5** now persists `decisions: []` when every invalid disposable decision is removed rather than returning the original memory.
2. **Stage 7** now persists `decisions: []` when every old non-foundational decision is removed rather than restoring the original rows.
3. **Stage 10** now incrementally exhausts disposable ephemeral state under exact serialized-byte pressure: oldest active-file observations, blocker entries, next-step entries, then current-task verbosity/removal. A state with no protected authority/proof can no longer be misclassified as `required-state-exceeds-budget` merely because disposable ephemeral arrays remain.

The new `test/memory/oracle-r1-storage-policy.test.ts` directly exercises those cases, including mixed protected authority plus disposable pressure and the all-disposable case.

### R2 — B3 CI fixture: closed

The B3 HEADER regression no longer relies on fixed decision counts/lengths whose total serialized size varied with the temporary project path. The test now measures the real candidate representation and constructs a deterministic pressure boundary around the actual `MEMORY_MAX_BYTES` value.

The substantive B3 invariant is unchanged: both heuristic and final-LLM HEADER generation must consume the fitted `MemoryMutationResult.memory` that was actually persisted, never callback-carried pre-fit memory.

The previously red GitHub-only outcome is therefore covered without weakening the assertion.

## Original B1-B4 status

All original Oracle blockers are closed.

### B1 — exact storage-pressure eviction: closed

- schema-valid completed audits, cache, model-health/quarantine, sessions/source history and active-file observations are evicted under real byte pressure rather than merely count-normalized;
- every non-stale pending audit guard remains retained;
- operation-protected processed-source/audit/decision proof remains protected;
- invalid/old/non-foundational and ephemeral reductions now reach their actual empty/reduced candidates;
- irreducible protected overflow remains a typed no-write/no-revision refusal.

### B2 — 4,096-byte automatic durable block: closed

- mandatory opening/closing delimiters, DATA prefixes, project identity, freshness line and newlines are all included in the same UTF-8 budget;
- multibyte project paths cannot push the block past 4,096 bytes;
- `truncateUtf8()` respects tiny budgets 0–3 and never emits a truncation marker larger than the requested budget;
- PR-7 DATA-only sanitization and strict semantic-prefix selection remain intact.

### B3 — HEADER describes committed state: closed

Heuristic and final-LLM paths use the transaction's committed fitted `memory` result for HEADER generation. Budget fitting cannot leave HEADER describing current-task or other state that was removed before persistence.

### B4 — automatic creation bounds: closed

The exported creation limits are enforced by actual producers and defensive merge/schema boundaries for automatic current task, observed paths/reasons, decisions/rationale, blockers, next steps and counts. Broad persistence compatibility ceilings remain separate, so existing valid current-v3 state and human-reviewed authority are not collapsed to automatic-creation limits merely by schema loading.

## Core PR-8 invariants rechecked

- durable STATE remains capped at **8,192 UTF-8 bytes**;
- automatic durable compaction DATA remains independently capped at **4,096 UTF-8 bytes**;
- fitting occurs after the real next revision is assigned inside the serialized `mutateMemory()` transaction;
- successful fitting returns the exact schema-valid representation eligible for `commitMemoryExact()`;
- budget rejection performs no write and no revision advancement;
- human-reviewed foundational authority is never silently discarded to fit;
- operation-required completion/audit/review proof cannot be silently evicted while reporting success;
- rejected final LLM completion does not write a processed-source success marker, so the source remains retryable;
- PR-5 public idle outcome taxonomy remains unchanged (`budget-rejected` maps internally to `write-failed`);
- current-v3 compatibility repair remains deterministic and read-only;
- automatic injection selection does not mutate durable STATE;
- durable retention remains independent from one automatic injection block;
- `[llm:eN]` represents retained evidence count rather than rendering ordinal;
- PRs 1–7 authority, transaction, provenance, idempotency and compaction semantics remain intact.

## Exact CI evidence

GitHub Actions run `31567759880`, job `94023045279`, checked out:

`79d17e0258176cad83dd862cbfa1561c177e10fd`

Result:

```text
Test Files          55 passed + 1 expected skip = 56 total
Tests               998 passed + 1 expected skip = 999 total
TypeScript          PASS
Host contract       PASS
Distribution build  PASS
Bundle verification PASS
CLI verification    PASS
CLI smoke           PASS
Shell syntax        PASS
```

The host contract remained `>=1.18.15 <2.0.0` with the verified minimum/dev/installed host package at `1.18.15`.

The repository still reports nine dependency vulnerabilities during `npm ci` (4 low, 3 moderate, 1 high, 1 critical). That remains explicitly in PR 10's dependency/release-hygiene scope and is not a PR-8 storage/injection-budget blocker. The GitHub Actions Node-20 deprecation warning is likewise release-hygiene follow-up, not a PR-8 semantic failure.

## Final decision

**Ship.**

PR 8 now provides one canonical storage-budget authority at the serialized mutation boundary and one independent hard automatic-injection ceiling, with deterministic pressure behavior, protected-state refusal semantics, truthful derivatives and adversarial UTF-8 coverage.

CRIP may advance to PR 9 — Accurate diagnostics and artifact storage.
