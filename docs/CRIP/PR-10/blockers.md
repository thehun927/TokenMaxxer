# PR-10 Implementation and Decision Log

This file is append-only. Entries record observed implementation-head evidence,
decisions, blockers, and deviations from the PR-10 plan.

## 2026-08-12 — Baseline and pre-Wave-1 inspection

- Pulled `origin/main` fast-forward from `6c363d0` to `75aa513`.
- Planning baseline remains `ab81ee51f693357048b7320fbf264a7350331c2c`.
- Required PR-10 documents were read in order: the concrete implementation
  plan, the PR-10 README, then the repository CRIP implementation plan.
- Current package version is `0.1.0`; OpenCode peer range is preserved as
  `>=1.18.15 <2.0.0`; development host pin is `1.18.15`.
- `dist/` is ignored but currently has tracked `dist/index.js`,
  `dist/index.d.ts`, `dist/tui.js`, and `dist/tui.d.ts`. This remains a
  Wave-3 production remediation; Wave 1 agents must not alter it.
- A clean build on the current head succeeds, but the current build emits
  additional generated declaration subtrees and `dist/cli.*`; exact inventory
  enforcement is deferred to the planned dist/package implementation wave.
- Current environment observed: Node `v22.22.1`, npm `9.2.0`, Bun `1.3.14`.
  The plan's pinned release builder target is Node `22.23.1` / npm `10.9.8` /
  Bun `1.3.14`; this is a local-environment deviation, not a release decision.
- Fresh `npm audit --json` was regenerated on this head: 4 low, 3 moderate,
  1 high, 1 critical (9 total). Raw evidence was captured at implementation
  time outside the repository and must be committed/replaced during Wave 2.
- Verified planning-time action identities against remote tags:
  `actions/checkout@v6.0.2` →
  `de0fac2e4500dabe0009e67214ff5f5447ce83dd`,
  `actions/setup-node@v6.4.0` →
  `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e`, and
  `oven-sh/setup-bun@v2.2.0` →
  `0c5077e51419868618aeaa5fe8019c62421857d6`.
- Baseline tests: `npm test` passed with 1167 passed and 1 skipped across 65
  files. `npx tsc --noEmit` passed. No release tag or GitHub Release was
  created or published.

## Wave log

Wave 1 has not started.

## Wave 1 — Freeze release contracts with tests only — 2026-08-12

- Wave 1 used three bounded test-only lanes. Agent 1A added dist/package/
  reproducibility and manifest contracts; Agent 1B added installer fixtures,
  checksum/identity/transaction helpers and installer contract tests; Agent 1C
  added workflow, identity, dependency-triage, and stale-document contract
  tests plus parsers and fixtures.
- No production behavior, workflow, package, installer, launcher, or `dist/`
  files were modified by the Wave-1 implementation. The only implementation
  paths added are `test/release/**` and this append-only log.
- Luna corrected test-only integration defects before acceptance: replaced
  ESM-incompatible `require()` calls, made release tests derive repository
  paths portably, and fixed installer fixture URL-variable expansion so the
  valid staged release exercises the exact-tag contract.
- Focused command rerun by Luna:
  `npx vitest run test/release/`
  - 10 test files collected;
  - 85 passed;
  - 30 failed as intentional pre-PR-10 production-contract failures;
  - 115 total, 0 skipped.
- The 30 expected failures are current production gaps, not test harness
  failures: tracked dist and extra generated files (4), mutable-main/stale
  documentation claims (9), absent dependency evidence (5), absent release
  preflight (2), mutable CI/missing release workflow and gates (5), and
  installer URL/checksum/transaction/receipt behavior (5).
- Installer fixture-only assertions pass, including valid checksum verification,
  tamper and missing-CLI refusal, malformed/duplicate manifest rejection,
  prior-install byte preservation, rollback after injected replacement failure,
  first-install no-partial behavior, receipt identity validation, and mixed
  release identity rejection.
- `npx tsc --noEmit`: passed.
- `git diff --check`: passed.
- `git ls-files 'dist/**'`: still prints the four planning-baseline tracked
  files (`dist/index.d.ts`, `dist/index.js`, `dist/tui.d.ts`, `dist/tui.js`);
  this is intentionally deferred to Wave 3 and remains a release blocker.
- Wave-1 deviations/blockers: the tests intentionally fail until their
  production owners land in Waves 2–7; dependency audit artifacts,
  `release-preflight.mjs`, release workflow, and production installer behavior
  are not yet implemented. No real `v*` tag or GitHub Release was created.

## Wave 2 — Dependency remediation and audit evidence — 2026-08-12

- Upgraded the development test toolchain from Vitest `2.1.9`/Vite `5.4.21`
  to Vitest `4.1.10`/Vite `8.2.1`, preserving the OpenCode peer range
  `>=1.18.15 <2.0.0` and development pin `1.18.15`.
- Added exact builder hints: Node `22.23.1` in `.node-version`, Bun `1.3.14`
  in `.bun-version`, `npm@10.9.8` as `packageManager`, and package engine
  `>=22.23.1`.
- Fresh final `npm audit --json` was independently regenerated and compared
  byte-structurally by metadata to the committed snapshot:
  5 low, 0 moderate, 0 high, 0 critical, 5 total. npm's audit command exits
  `1` because low findings remain; this is expected and is not the release
  high/critical gate.
- The five remaining low findings are real and explicitly triaged in the
  machine-parseable 11-column table in `dependency-audit.md`; no unresolved
  high or critical finding remains. The report records build/runtime scope,
  reachability, non-breaking action, and residual risk without claiming zero
  risk or silently waiving advisories.
- `npx vitest run test/release/workflow/dependency-policy.test.ts`: 10 passed.
- `npm audit --audit-level=high`: exit 0.
- `npm audit --omit=dev --audit-level=low`: exit 0.
- `npm install --package-lock-only --ignore-scripts --dry-run`: exit 0.
- `npx tsc --noEmit`: passed.
- `npm run verify:host-contract`: passed; peer range, dev pin, and installed
  host dependency remain aligned.
- Full `npm test` after the dependency upgrade: 1258 passed, 25 expected
  pre-PR-10 failures in Waves 3–7 (dist tracking/inventory, installer,
  workflow/release, preflight, and stale README contracts). No dependency
  regression was observed.
- Wave-2 deviation: low advisories remain because the release gate requires
  zero high/critical, while the current audit snapshot still reports five
  low findings. They are documented and triaged; this is not a release-gate
  blocker under the plan. No real `v*` tag or GitHub Release was created.
