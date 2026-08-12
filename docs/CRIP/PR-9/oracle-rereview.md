# PR-9 Oracle Rereview Evidence

Evidence-only remediation handoff for the independent Oracle. This document
does not issue a release-gate verdict.

## Reviewed identities

- Oracle findings: `28c8d7a2e370aed9f6ce2f6cdbb86dd7031190e4`
- Blocked implementation: `29636b7f53abdac10fabeebbc574e5297268c426`
- Remediation head: `d04c2aa32d3c82c1c61ddfd921b5b32e3a22085c`

## B1 — overlapping last-only publication

`src/index.ts` now captures receipt ordering before asynchronous history work,
keeps history retrieval outside the publication queue, and serializes only
short per-project/artifact publication. Older same-process observations cannot
replace newer ones; publication failures remain non-fatal and do not touch
STATE, revision, IdleWriteOutcome, or `.commit-pulse`.

Evidence: deferred-promise regressions in
`test/index-pr9-compaction.test.ts`; the index slice passed 41/41.

## B2 — prompt metadata bound/injection

`src/diagnostics/compaction.ts` bounds and visibly escapes CR/LF/control text
for header metadata, uses trusted effective-mode values, and guarantees the
complete header/payload/footer is at most 96 KiB UTF-8.

Evidence: hostile 200 KiB mode, multiline metadata, fallback reason, emoji,
and final-bound tests in `test/diagnostics/compaction.test.ts`; 36/36 passed.

## B3 — persisted result runtime validation

The read-side validator rejects result JSON above 4096 UTF-8 bytes, oversized
session IDs/reasons, negative/fractional/unsafe byte counts, invalid ISO
timestamps, and non-lowercase/non-64-character SHA values. Invalid artifacts
remain contained and are surfaced by status as unavailable invalid diagnostics.

Evidence: corrupt-artifact regressions in
`test/diagnostics/compaction.test.ts`; diagnostics/consumer coverage passed
349/349.

## B4 — arbitrary outer error bounds

`src/index.ts` safely bounds arbitrary thrown text at the outer compaction-hook
and event-handler catches. Hostile multi-kilobyte errors and failing app.log
transport are covered; raw tail markers do not reach app.log.

Evidence: B4 regressions in `test/index-pr9-compaction.test.ts`; index slice
passed 41/41.

## Focused remediation validation

The combined B1–B4/PR-7/PR-8/TMTUI command passed 32 files and 630/630 tests.
`npx tsc --noEmit` and `git diff --check` passed. Full `npm test` on the
remediation head passed 65 files and 1,168/1,168 tests.

## Exact remediation release chain

All checks below ran against `d04c2aa32d3c82c1c61ddfd921b5b32e3a22085c`:

- `npm ci`: passed; Node 22.22.1 emitted the `ini@7.0.0` engine warning and
  npm reported 9 audit findings; no dependency changes were made.
- `npm test`: 65 files, 1,168 passed, 0 failed.
- `npx tsc --noEmit`: passed.
- `npm run verify:host-contract`: passed; peer `>=1.18.15 <2.0.0`, installed
  and development host `1.18.15`.
- `npm run build`: passed; server, TUI, declarations, and CLI built.
- `npm run check:tui-bundle`: passed.
- Bundle self-containment check: passed for `dist/index.js`, `dist/tui.js`,
  and `dist/cli.js`.
- `npm run verify-cli-bundle`: passed.
- `npm run smoke:cli`: passed cases 46–49.
- `bash -n install.sh` and `bash -n bin/tokenmaxxer`: passed.
- `git diff --check`: passed after restoring generated `dist/index.js`.

PRs 1–8 and the separately validated TMTUI pulse/bundle behavior remain
covered. No dependency, dist-parity, installer-integrity, or PR-10 work was
introduced.

## CI evidence

Append the exact GitHub run/job, remediation head, conclusion, and pass/skip
counts after pushing this rereview.
