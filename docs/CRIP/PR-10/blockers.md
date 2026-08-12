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

## Wave 3 — Generated dist, package allow-list, reproducible build — 2026-08-12

- Build output is now generated-only. The four legacy tracked dist entries were
  removed from the Git index; `git ls-files 'dist/**'` prints nothing. The
  working `dist/` remains ignored and is regenerated by `npm run build`.
- Clean build output is exactly six root files: `index.js`, `index.d.ts`,
  `tui.js`, `tui.d.ts`, `cli.js`, and `cli.d.ts`; no `memory/` or `util/`
  declaration subtrees remain. TMTUI source semantics and `.commit-pulse`
  imports were preserved; no source inlining was retained.
- `npm run verify:dist`: passed. `npm run verify:package`: passed against
  npm's authoritative `npm pack --dry-run --json` manifest; the exact intended
  package set is the six dist files, launcher, installer, LICENSE, README, and
  npm's package.json metadata (11 files total).
- `npm run verify:reproducible-build`: passed with full-payload SHA256 equality
  across two builds at commit `328d8befc63eb4b919d2407bc83cc800e183d065`.
  Local evidence hashes were:
  - `index.js` `5661d7f3959e6d7409aee9b3d89260403eadf36d960fd886661a042fce3737ee`
  - `index.d.ts` `363ec6aa5dfc1155a20ae1b4a9001100e9fe858b296d960a261731050ea5b32d`
  - `tui.js` `063b71d065a914c1216de76ee725c678674091c950ac0ccf88ebcf291a3a870b`
  - `tui.d.ts` `d9d1b42e84b3c870739db5c48a88afed9d1fdba91e6178ad762cd9ea80f13996`
  - `cli.js` `01f638ea5917931689e0e2ff5bbe24be1fa1d3632008e7ae913cac088305661f`
  - `cli.d.ts` `e3785b697e3eb2e81e7e2bfdc5d704d5ad6452fd2ce111a04bcb8ed0d32ee94b`
- `npx tsc --noEmit`: passed. Focused Wave-3 release contracts:
  `npx vitest run test/release/dist-contract.test.ts
  test/release/dist-inventory.test.ts test/release/package-contract.test.ts
  test/release/reproducibility-contract.test.ts
  test/release/release-manifest.test.ts`: 27 passed.
- Wave-3 deviation: the current local builder is Node `v22.22.1` rather than
  the pinned release target `22.23.1`; the reproducibility script compares the
  same local locked toolchain across both passes. No real `v*` tag or GitHub
  Release was created.

## Wave 4 — Release identity preflight — 2026-08-12

- Added executable `scripts/release-preflight.mjs` and the
  `npm run release:preflight` entry point. It validates package SemVer,
  exact `v<version>` tag identity, lowercase 40-hex commit shape, OpenCode
  peer/minimum contracts, schema-v1 `RELEASE.json` when present, and the
  no-existing-release-tag implementation invariant.
- The preflight is fail-closed for non-dry-run commit authenticity: a supplied
  commit that differs from checked-out `HEAD`, or an inability to verify it,
  exits nonzero. Explicit `--dry-run` skips only this local authenticity check
  while retaining semantic identity validation; it does not fabricate a
  release identity.
- `npx vitest run test/release/workflow/release-identity.test.ts`: 15 passed.
- `node --check scripts/release-preflight.mjs`: passed.
- `npx tsc --noEmit`: passed.
- Manual CLI evidence: valid explicit dry-run exited 0; mismatched tag exited
  1; malformed/short commit exited 1; `npm run release:preflight` against the
  checked-out `HEAD` exited 0.
- No `v*` tag exists and no real release/tag was created or published.
- Planned network/repository checks (`GITHUB_SHA`, main ancestry, existing
  GitHub Release, and immutable-release proof) remain workflow-owned and are
  intentionally deferred to Waves 6–8; no local preflight bypass is treated
  as release publication evidence.

## Wave 5 — Immutable installer and truthful launcher identity — 2026-08-12

- Replaced mutable-main payload URLs with one embedded exact release tag and
  one `releases/download/${RELEASE_TAG}` base. The installer stages launcher,
  server/TUI/CLI bundles, `RELEASE.json`, and `SHA256SUMS` before any target or
  configuration mutation.
- The staged manifest is validated for schema v1, exact version/tag, exact
  lowercase 40-hex commit, peer range, and minimum verified host. SHA256SUMS
  rejects malformed, duplicate, missing, extra, and mismatched entries and
  verifies all five staged files before commit.
- Target replacement is transactionally backed up and rollback-capable. The
  receipt records schema v1, exact version, tag, and manifest commit. The
  launcher `version` command reports a validated receipt identity or an
  explicit unavailable state; it never fabricates a commit and no longer
  advertises an unverified npm `@latest` channel.
- `npx vitest run test/release/installer/installer-contract.test.ts`: 31
  passed, 0 failed.
- `bash -n install.sh`: passed; `bash -n bin/tokenmaxxer`: passed.
- `bash test/cli-smoke/smoke.sh`: passed, cases 46–49.
- `npx tsc --noEmit`: passed.
- Manual launcher evidence with an empty HOME: `tokenmaxxer version` exits 0
  and reports `unavailable (no release receipt)`; no commit is fabricated.
- Wave-5 limitation: actual GitHub Release download, tamper, and rollback
  execution against a published asset set cannot be performed locally because
  no real tag/release may be created in this implementation workstream. The
  fixture-driven integrity and transaction contracts are green.
- No real `v*` tag or GitHub Release was created or published.
