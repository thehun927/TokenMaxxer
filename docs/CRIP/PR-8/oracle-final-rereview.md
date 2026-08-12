# PR-8 Oracle Final Re-review

**Verdict: Block**

Focused re-review of Oracle remediation commit:

`5db7a53d7d9097a5f4997e4f68a339bef2324e10`

Handoff:

`docs/CRIP/PR-8/oracle-rereview.md`

Original Oracle findings:

`docs/CRIP/PR-8/oracle-findings.md`

## Summary

The remediation materially closes the four originally reported production seams:

- B1 now performs real byte-pressure eviction for completed audits, cache, model-health/quarantine, recent sessions, unprotected processed sources, and stale active-file observations, while retaining live pending audit guards.
- B2 now budgets the mandatory durable project/freshness prefix inside the full 4,096-byte UTF-8 ceiling; tiny `truncateUtf8()` budgets no longer return more bytes than requested.
- B3 production code now uses `MemoryMutationResult.memory` — the actual fitted committed STATE — for heuristic and final-LLM HEADER generation.
- B4 now enforces automatic creation bounds in the heuristic producer/merge path and structured LLM decision contract.

However, the release gate remains blocked by one remaining storage-policy defect plus a red pushed CI validation run.

---

## R1 — Blocker: Stage 10 can still reject purely disposable ephemeral state as `required-state-exceeds-budget`

The PR-8 plan requires Stage 10 to:

- remove oldest remaining active files;
- **reduce/remove** lower-priority blocker and next-step entries;
- **reduce/remove** current task if necessary;
- reach typed refusal only when no legal disposable reduction remains.

The implementation still only truncates these values:

```ts
function stage10EphemeralState(mem: MemoryFile): MemoryFile {
  const truncatedCurrentTask = mem.current_task
    ? truncateUtf8(mem.current_task, 512)
    : mem.current_task

  const truncatedBlockers = (mem.blockers ?? []).map((b) => truncateUtf8(b, 512))
  const truncatedNextSteps = (mem.next_steps ?? []).map((n) => truncateUtf8(n, 512))

  // ... keep newest 8 files ...

  return {
    ...mem,
    current_task: truncatedCurrentTask,
    blockers: truncatedBlockers,
    next_steps: truncatedNextSteps,
    active_files: retainedFiles,
  }
}
```

There is no final incremental deletion of blocker entries, next-step entries, or current task.

A schema-valid/current-v3 compatibility state can therefore remain above 8,192 bytes with **only disposable ephemeral state**. For example, eight 512-byte blockers plus eight 512-byte next steps already consume roughly the whole storage budget before normal JSON/base-state overhead. Stage 10 leaves all sixteen entries in place; Stage 11 then reports `required-state-exceeds-budget` even though no foundational authority or operation-required proof is responsible for the overflow.

That violates the Stage-11 meaning:

> `required-state-exceeds-budget` is only valid after all legal disposable reduction is exhausted and the remaining overflow is caused by operation-required protected proof/state.

Required remediation:

1. Stage 10 must incrementally remove disposable active files / blockers / next steps / current task until the exact serialized candidate fits or those fields are exhausted.
2. Add a regression with no decisions, no protected source/audit/decision IDs, and enough schema-valid blockers/next steps to exceed the cap; expected result is `ok: true`, not `required-state-exceeds-budget`.
3. Add a mixed protected-authority fixture proving ephemeral state is exhausted before typed refusal.

### Related deterministic priority bugs

Two earlier stages have the same empty-retention guard problem:

```ts
if (retained.length === 0) {
  return mem
}
```

in the invalid-decision and old-non-foundational-decision stages. If *all* decisions in one of those categories are disposable, the stage returns the original memory instead of the empty retained set. Later stages may then evict lower-priority active-file state before those decisions are eventually removed.

These should be corrected in the same B1 residual patch so the documented Stage 5 -> Stage 6 -> Stage 7 ordering is mechanically true for the zero-retained case as well.

---

## R2 — Release evidence is red on the pushed remediation tree

Remote validation head:

`57ce759289f4624deade43c4c7487c1ba8732316`

is a docs-only child of remediation commit `5db7a53...`, so it is valid production/test-tree evidence for the remediation.

GitHub Actions run:

`31563606353`

failed in `npm test` before typecheck/build/release verification could execute.

Failure:

```text
FAIL test/memory/oracle-b3-header.test.ts
Oracle B3 — HEADER consumes the committed fitted STATE
heuristic path: HEADER matches the persisted fitted STATE when the fitter truncates current_task

Expected: "heuristic-only"
Received: "write-failed"
```

Run totals:

```text
53 passed files
1 failed file
1 skipped file

985 passed tests
1 failed test
1 skipped test
```

Because the failure is in a newly-added Oracle remediation regression and the remainder of the release chain was skipped, it cannot be treated as a harmless pre-existing CI flake without further evidence.

The production B3 code itself is structurally corrected: both heuristic and final-LLM HEADER paths consume the committed `result.memory`. The red test may ultimately prove to be fixture-size/environment sensitivity rather than a production B3 defect, but the release gate requires a stable passing regression and a green exact production/test-tree CI run.

Required remediation:

1. Diagnose why the near-cap heuristic fixture produces `write-failed` in GitHub Actions while passing locally.
2. If fixture sensitivity is the cause, make the test construct its pressure boundary deterministically from actual serialized bytes rather than relying on a fixed decision count/length.
3. Do not weaken the assertion that HEADER must reflect a state that actually underwent fitting.
4. Obtain a green pushed run completing tests, TypeScript, host contract, build, bundle verification, CLI smoke, and shell syntax.

---

## Closed original blockers

### B1 — original metadata-pressure seam: closed, subject to R1 above

The remediation now removes completed audits/cache/health/quarantine/session/source/file metadata based on actual serialized pressure instead of merely reapplying count ceilings, and preserves every live pending audit guard.

### B2 — closed

Mandatory durable framing is included in the 4,096-byte UTF-8 budget. Emoji/CJK project paths are byte-truncated safely, delimiters remain intact, and the strict-prefix candidate rule remains in force.

`truncateUtf8()` now satisfies the hard postcondition `utf8Bytes(result) <= maxBytes` for tiny budgets 0-3.

### B3 — production code closed; validation blocked by R2

Heuristic HEADER:

```ts
heuristicMemory = heuristicResult.memory
await writeHeaderBestEffort(..., heuristicMemory)
```

Final LLM HEADER:

```ts
const finalMemory = finalResult.memory
await writeHeaderBestEffort(..., finalMemory)
```

The pre-fit callback `value.memory` is no longer used for HEADER generation.

### B4 — closed

Automatic heuristic current-task/path/reason/decision/blocker/next-step paths now obey the PR-8 creation contract, and heuristic merge defensively caps incoming decisions. Structured LLM decisions remain bounded at the same 256/500/500 contract.

One minor maintainability note: `extract-schema.ts` mirrors the numeric creation constants rather than importing `MEMORY_CREATION_LIMITS` because of the existing schema dependency cycle. The new regression suite pins the values in sync. This is not release-blocking.

---

## Final disposition

PR 8 remains **Block**.

A small final remediation should:

1. complete Stage-10 disposable eviction;
2. fix zero-retained Stage-5/Stage-7 behavior;
3. stabilize the B3 pressure regression without weakening it;
4. produce one green pushed full release-chain run on an unchanged production/test tree;
5. publish a second focused handoff (for example `docs/CRIP/PR-8/oracle-second-rereview.md`).

Do not advance PR 9 until the independent Oracle clears that head.
