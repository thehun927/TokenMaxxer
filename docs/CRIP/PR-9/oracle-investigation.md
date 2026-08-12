# PR-9 Oracle Investigation Evidence

Evidence-only handoff for independent Oracle review. Luna does not create
Oracle findings and does not issue a Ship verdict.

## Identity and wave commits

- Repository: `thehun927/TokenMaxxer`
- Planning baseline: `4df7873856e5f5714e45c120e1224e28450f4ee7`
- PR-8 residual implementation: `15d3bb55b180c1db4981abb517f6bd159c68e049`
- PR-8 validation head: `79d17e0258176cad83dd862cbfa1561c177e10fd`
- Pulled baseline: `d0f803156bea258671d64438733d3b187b639be1`
- Exact implementation SHA: `29636b7f53abdac10fabeebbc574e5297268c426`
- Wave commits: `7211b61` (contracts), `6592469` (artifacts), `07adadb`
  (compaction), `4816c33` (status), `cd001b9` (warnings), `45c83a2`
  (activity), `29636b7` (Luna integration cleanup).

Wave 7's delegated test-only lane failed on an unavailable model and its
replacement became stuck; Luna performed the cross-feature audit directly.
`src/memory/commit-pulse.ts` and `src/tui.tsx` were not modified.

## PR-9 changed files

```text
docs/CRIP/PR-9/blockers.md
docs/CRIP/PR-9/oracle-investigation.md
src/diagnostics/artifacts.ts
src/diagnostics/artifacts.types.ts
src/diagnostics/compaction.ts
src/index.ts
src/memory/paths.ts
src/memory/writer.ts
src/types.ts
src/tools/status.ts
test/diagnostics/artifacts.test.ts
test/diagnostics/compaction.test.ts
test/index-pr9-compaction.test.ts
test/memory/merge.test.ts
test/memory/pr9-file-activity.test.ts
test/memory/pr9-persistence-warning.test.ts
test/memory/writer.test.ts
test/tools/pr9-status.test.ts
test/tools/status-extended.test.ts
test/tools/status.test.ts
```

## Explicit 84-case evidence mapping

| Case | Evidence |
|---:|---|
| 1 | `test/diagnostics/artifacts.test.ts`: project diagnostic path uses resolved project path |
| 2 | `test/diagnostics/artifacts.test.ts`: global diagnostic path uses stable project hash |
| 3 | `test/diagnostics/artifacts.test.ts`: project-local prompt write |
| 4 | `test/index-pr9-compaction.test.ts`: session.compacted creates result artifact |
| 5 | `test/diagnostics/artifacts.test.ts`: local write failure falls back globally |
| 6 | `test/diagnostics/artifacts.test.ts`: both writes fail -> typed io-failed |
| 7 | `test/diagnostics/artifacts.test.ts`: too-large content does not write |
| 8 | `test/diagnostics/artifacts.test.ts`: UTF-8 bytes differ from JS length |
| 9 | `test/diagnostics/artifacts.test.ts`: local-only read |
| 10 | `test/diagnostics/artifacts.test.ts`: global-only read |
| 11 | `test/diagnostics/artifacts.test.ts`: newer mtime wins |
| 12 | `test/diagnostics/artifacts.test.ts`: equal mtime local tie-break |
| 13 | `test/diagnostics/artifacts.test.ts`: one readable candidate wins |
| 14 | `test/tools/pr9-status.test.ts`: missing result returns missing/none |
| 15 | `test/diagnostics/artifacts.test.ts`: read error returns unavailable |
| 16 | `test/diagnostics/artifacts.test.ts`: traversal name rejected |
| 17 | `test/diagnostics/artifacts.test.ts`: two project global directories differ |
| 18 | `test/diagnostics/artifacts.test.ts`: replacement visible without cache |
| 19 | `test/diagnostics/compaction.test.ts`: augment stores actual payload |
| 20 | `test/diagnostics/compaction.test.ts`: replace stores actual prompt |
| 21 | `test/diagnostics/compaction.test.ts`: unavailable fallback stores augmentation |
| 22 | `test/diagnostics/compaction.test.ts`: requested/effective modes separate |
| 23 | `test/diagnostics/compaction.test.ts`: prompt never result |
| 24 | `test/diagnostics/compaction.test.ts`: real newlines |
| 25 | `test/diagnostics/compaction.test.ts`: fallback reason bounded |
| 26 | `test/diagnostics/compaction.test.ts`: ordinary payload unmodified |
| 27 | `test/diagnostics/compaction.test.ts`: original/stored payload bytes |
| 28 | `test/diagnostics/compaction.test.ts`: UTF-8-safe truncation |
| 29 | `test/diagnostics/compaction.test.ts`: payload_truncated marker |
| 30 | `test/index-pr9-compaction.test.ts`: whole prompt <=96 KiB |
| 31 | `test/index-pr9-compaction.test.ts`: session.compacted creates result |
| 32 | `test/index-pr9-compaction.test.ts`: hook alone creates no result |
| 33 | `test/diagnostics/compaction.test.ts`: runtime-valid result v1 |
| 34 | `test/index-pr9-compaction.test.ts`: result <=4096 bytes |
| 35 | `test/diagnostics/compaction.test.ts`: exact summary byte count |
| 36 | `test/diagnostics/compaction.test.ts`: deterministic SHA-256 |
| 37 | `test/index-pr9-compaction.test.ts`: summary body absent |
| 38 | `test/index-pr9-compaction.test.ts`: missing summary still completes |
| 39 | `test/index-pr9-compaction.test.ts`: unavailable history still completes |
| 40 | `test/index-pr9-compaction.test.ts`: thrown history bounded |
| 41 | `test/diagnostics/artifacts.test.ts`: result global fallback |
| 42 | `test/index-pr9-compaction.test.ts`: result failure does not throw |
| 43 | `test/index-pr9-compaction.test.ts`: repeated result replaces last-only |
| 44 | `test/index-pr9-compaction.test.ts`: no event means no completion advance |
| 45 | `test/tools/pr9-status.test.ts`: reload simulation |
| 46 | `test/tools/pr9-status.test.ts`: project A isolation |
| 47 | `test/tools/pr9-status.test.ts`: project B isolation |
| 48 | `test/tools/pr9-status.test.ts`: no result means none |
| 49 | `test/tools/pr9-status.test.ts`: local source/path |
| 50 | `test/tools/pr9-status.test.ts`: global source/path |
| 51 | `test/tools/pr9-status.test.ts`: newer candidate status |
| 52 | `test/tools/status.test.ts`: malformed result containment |
| 53 | `test/tools/status.test.ts`: invalid diagnostic output |
| 54 | `test/tools/status.test.ts`: prompt reported separately |
| 55 | `test/tools/status.test.ts`: queue process-local label |
| 56 | `test/tools/status.test.ts`: in-flight process-local label |
| 57 | `test/tools/status.test.ts`: idle outcome process-local label |
| 58 | `test/tools/status.test.ts`: durable model-health wording |
| 59 | `test/memory/pr9-persistence-warning.test.ts`: terminal lock-timeout |
| 60 | `test/memory/pr9-persistence-warning.test.ts`: terminal unavailable |
| 61 | `test/memory/pr9-persistence-warning.test.ts`: terminal commit failure |
| 62 | `test/memory/pr9-persistence-warning.test.ts`: terminal budget rejection |
| 63 | `test/memory/pr9-persistence-warning.test.ts`: terminal unexpected throw |
| 64 | `test/memory/pr9-persistence-warning.test.ts`: typed model-health failure |
| 65 | `test/memory/pr9-persistence-warning.test.ts`: model-health unexpected throw |
| 66 | `test/memory/pr9-persistence-warning.test.ts`: warning text bounded |
| 67 | `test/memory/pr9-persistence-warning.test.ts`: primary outcome unchanged |
| 68 | `test/memory/pr9-persistence-warning.test.ts`: audit guard fail-closed |
| 69 | `test/memory/pr9-file-activity.test.ts`: completed read |
| 70 | `test/memory/pr9-file-activity.test.ts`: repeated reads |
| 71 | `test/memory/pr9-file-activity.test.ts`: completed edit |
| 72 | `test/memory/pr9-file-activity.test.ts`: completed write |
| 73 | `test/memory/pr9-file-activity.test.ts`: grep search |
| 74 | `test/memory/pr9-file-activity.test.ts`: glob search |
| 75 | `test/memory/pr9-file-activity.test.ts`: bash shell_refs only |
| 76 | `test/memory/pr9-file-activity.test.ts`: mixed categories |
| 77 | `test/memory/pr9-file-activity.test.ts`: pending/error exclusion |
| 78 | `test/memory/pr9-file-activity.test.ts`: stable ranking |
| 79 | `test/memory/pr9-file-activity.test.ts`: stale reason replacement |
| 80 | `test/memory/pr9-file-activity.test.ts`: no transient STATE field |
| 81 | `test/index.test.ts`, `test/compaction/integration.test.ts`, prompt/history suites; broad audit passed |
| 82 | PR-8 budget/schema/storage suites; broad audit passed |
| 83 | commit-pulse/TMTUI suites plus `npm run check:tui-bundle`; passed |
| 84 | Exact-SHA release chain and GitHub CI evidence below |

## Exact-SHA release chain

All commands ran against `29636b7f53abdac10fabeebbc574e5297268c426`:

| Command | Result |
|---|---|
| `npm ci` | Passed; `ini@7.0.0` engine warning; 9 audit findings; no remediation |
| `npm test` | 65 files, 1,151 passed, 0 failed |
| `npx tsc --noEmit` | Passed |
| `npm run verify:host-contract` | Passed |
| `npm run build` | Passed; server/TUI/declarations/CLI built |
| `npm run check:tui-bundle` | Passed |
| self-contained bundle check | Passed for all three bundles |
| `npm run verify-cli-bundle` | Passed |
| `npm run smoke:cli` | Passed cases 46–49 |
| `bash -n install.sh`; `bash -n bin/tokenmaxxer` | Passed |
| `git diff --check` | Passed after restoring generated `dist/index.js` |

## Invariants and Oracle attack surface

- No production-source `lastCompactionTimestamp` or `setLastCompaction`
  occurrence remains.
- Prompt/result names are distinct; caps are 96 KiB UTF-8 and 4 KiB JSON.
- Result v1 stores bounded completion/summary metadata only; no body or
  conversation is persisted.
- Artifact writes are local-first then hashed-global fallback; reads use
  newest mtime with local tie-break and no cache.
- Diagnostic writes do not touch STATE, revision, IdleWriteOutcome, or
  `.commit-pulse`; successful STATE commits alone own pulse recording.
- Oracle attack surface: read-only/permission fallback; stale local/global
  candidates; traversal and multibyte caps; hook-without-event; unavailable
  history; body leakage; hostile errors; two-project reload isolation;
  `app.log` failure; required audit fail-closed behavior; stale activity
  reasons; and TUI pulse/revision isolation.

## Deferred scope

Tracked dist parity/checksum and dependency remediation remain PR-10 scope.
The build-regenerated tracked `dist/index.js` was restored and is excluded.

## CI evidence

- Workflow: `CI`
- Run: `31619120327`
- URL: https://github.com/thehun927/TokenMaxxer/actions/runs/31619120327
- Head SHA: `476b26f0370dffc00641d5cf28c6ec3209d66590` (the evidence-only
  handoff commit; its parent implementation SHA is
  `29636b7f53abdac10fabeebbc574e5297268c426`).
- Job: `verify`, job ID `94189200265`
- Job URL: https://github.com/thehun927/TokenMaxxer/actions/runs/31619120327/job/94189200265
- Conclusion: success.
- Workflow steps: 14 substantive verification steps passed, including clean
  install, full tests, typecheck, host contract, build, TUI bundle, bundle
  self-containment, CLI verification/smoke, and shell syntax.
- CI test counts from the job log: 64 test files passed and 1 skipped; 1,150
  tests passed and 1 skipped; 0 failed.
