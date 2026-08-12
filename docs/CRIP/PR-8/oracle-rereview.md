# PR-8 Oracle Re-review Evidence

Evidence-only handoff for the independent Oracle's focused re-review. This
document does not issue a clearance, Ship verdict, or advance PR-9.

## Remediation identity

- Oracle findings baseline: `9ffab0de7963a07356fe6bd1c807cb5da01686cb`
- Remediation commit: `5db7a53d7d9097a5f4997e4f68a339bef2324e10`
- Findings report: `docs/CRIP/PR-8/oracle-findings.md`

## Blocker resolutions

- **B1 storage pressure:** `src/memory/budget.ts` now evicts disposable audit,
  cache, health/quarantine, session/source, and active-file metadata under
  exact serialized-byte pressure, preserves every non-stale pending audit
  guard, and keeps tiny UTF-8 truncations within their declared budgets.
- **B2 durable framing:** `src/compaction/durable.ts` budgets mandatory project
  and freshness framing, including multibyte project paths, within the full
  4,096-byte framed block while preserving strict prefix and DATA sanitization.
- **B3 committed HEADER:** `src/memory/writer.ts` uses committed
  `MemoryMutationResult.memory` for heuristic and final-LLM HEADER generation.
- **B4 automatic creation bounds:** `src/memory/writer.ts`, `src/memory/merge.ts`,
  and `src/memory/extract-schema.ts` enforce centralized creation bounds for
  automatic task/path/reason/decision/blocker/next-step producers while broad
  persistence ceilings continue to preserve valid human-reviewed v3 state.

## Focused evidence

Exact command:

```text
npx vitest run test/memory/oracle-b1-storage.test.ts \
  test/memory/oracle-b3-header.test.ts \
  test/memory/oracle-b4-creation.test.ts \
  test/compaction/oracle-b2-durable.test.ts \
  test/memory/pr8-wave7-integration.test.ts
```

Result: **5 files, 41 tests passed, 0 failed**.

Additional focused regression suites passed:

- `npx vitest run test/memory/pr8-budget-primitives.test.ts test/memory/pr8-storage-budget.test.ts test/memory/pr8-schema-compat.test.ts test/memory/merge.test.ts test/memory/extract.test.ts test/memory/writer.test.ts test/memory/writer-header.test.ts test/memory/writer-llm.test.ts test/compaction` — passed.
- `npm test` — **55 files, 987 tests passed, 0 failed**.
- `npx tsc --noEmit` — passed.

## Release-chain evidence on remediation SHA

All commands were run locally with `HEAD` equal to
`5db7a53d7d9097a5f4997e4f68a339bef2324e10`:

- `npm test` — 55 files / 987 tests passed.
- `npx tsc --noEmit` — passed.
- `npm run verify:host-contract` — passed; host peer/dev/installed version
  `1.18.15`.
- `npm run build` — passed; index, TUI, and CLI bundles built successfully.
- `npm run verify-cli-bundle` — passed.
- `npm run smoke:cli` — passed checks 46–49.
- `bash -n install.sh && bash -n bin/tokenmaxxer` — passed.
- `git diff --check` — passed.

Generated tracked distribution files were restored after the build; they are
not part of the remediation commit.

## Repository and scope notes

- No PR-9 advancement or PR-10 dependency/release work was added.
- The pre-existing local `opencode.json`/`.opencode/` state remains outside
  this remediation.
- No exact-remediation-SHA GitHub CI run is claimed here; the release-chain
  evidence above is local. The independent Oracle owns any CI/re-review gate.

## Attack surface for focused re-review

Please re-attack: ordinary schema-valid disposable metadata pressure at normal
count ceilings; preservation of every live pending audit guard; exact mandatory
4,096-byte durable framing with emoji/CJK; tiny UTF-8 budgets 0–3; HEADER/state
identity after current-task fitting; heuristic over-limit paths/topics and
automatic count/string bounds; concurrent near-cap mutations; and preservation
of human authority and operation-required proof under irreducible overflow.

Stop condition: this is evidence only. The independent Oracle must issue the
focused re-review result.
