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

## Oracle final residual remediation — R1/R2 — 2026-08-12

- **R1 closed:** README manual clone instructions now run `npm ci` and
  `npm run build` before copying generated `dist/index.js` and `dist/tui.js`.
  The one-liner description now names immutable release assets
  `tokenmaxxer.js`, `tokenmaxxer-tui.js`, `tokenmaxxer-cli.js`, and
  `tokenmaxxer`, rather than claiming repository dist paths are downloaded.
  Focused R1 and stale-document regressions passed 2/2 and 9/9.
- **R2 closed:** tag-only `.github/workflows/release.yml` now invokes the
  committed `npm run audit:release` gate, matching ordinary CI. The focused
  R2 contract verifies both workflows use the same gate and preserve
  tag-only, Administration-read, draft-first, prepublish verification, and
  postpublish attestation behavior. R2 and surrounding workflow contracts
  passed 50/50 in the final micro-wave focus.
- Final sequential micro-wave chain: full `npm test` 81 files/1334 passed;
  typecheck; host contract; audit release; build/dist/TUI/CLI/package/
  reproducibility; shell syntax; release dry-run/verify; focused R1/R2 and
  workflow contracts; YAML parse; diff-check; and zero tracked dist passed.
- No real `v*` tag or GitHub Release was created or published. The second
  Oracle rereview owns the final release gate; this log does not issue a Ship
  verdict.

## Oracle remediation — B1–B4 — 2026-08-12

- **B1 installer checksum/E2E closed:** production `install.sh` now stores the
  parsed digest value, detects `sha256sum` or `shasum -a 256`, fails closed if
  neither exists, and removes in-flight destination temp files during rollback
  and cleanup. Real-shell tests execute the repository installer itself with
  curl, wget, and shasum shims. Focused remediation suite: 71 passed,
  including valid install, tamper/malformed/missing checksum refusal,
  rollback, first-install cleanup, both downloader branches, and receipt.
- **B2 immutable workflow closed:** release workflow queries the dedicated
  `/repos/${GITHUB_REPOSITORY}/immutable-releases` endpoint using the explicit
  `RELEASE_ADMIN_TOKEN` Administration-read secret with a fail-closed guard.
  Draft publication remains ordered after complete asset/checksum/identity
  verification; `gh release verify` occurs only immediately after publication.
  The B2 workflow suite passed 29 focused checks.
- **B3 ordinary CI gate closed:** CI now runs `npm run audit:release`, real
  `release:stage` and `release:verify`, fail-closed empty tracked-dist
  assertion, and `test/release/installer-e2e`. The B3 structural suite passed
  13 checks; the existing workflow suite passed 23 checks.
- **B4 runtime compatibility closed:** shipped `engines.node` is restored to
  `>=18`; builder pinning remains separate in `.node-version`, packageManager,
  setup-node, and RELEASE builder metadata. Runtime/builder separation and
  host peer/minimum tests passed 10 checks.
- Added `docs/RELEASING.md` covering the Administration-read prerequisite,
  green CI, exact tag/version/commit procedure, draft-first sequence,
  post-publication attestation verification, SHA256SUMS, never-reuse-tag rule,
  and the no-real-release remediation boundary.
- Sequential local remediation chain passed: `npm ci`; focused remediation
  suites; full `npm test` (78 passed, 1 skipped file; 1321 passed, 1 skipped
  test); typecheck; host contract; audit release; build/dist/TUI/CLI/package/
  reproducibility checks; shell syntax; release dry-run and release verify;
  YAML parse; diff-check; and empty tracked-dist assertion.
- Local audit remains 5 low, 0 moderate, 0 high, 0 critical; the five low
  findings remain explicitly triaged. No real tag or GitHub Release was
  created or published during remediation.

## Wave 9 — Luna final integration evidence — 2026-08-12

- Final pushed implementation head: `f82eb39ab6c1f57c1e7242dd05b23505ae4eda3c`.
- Final exact implementation chain passed locally, including `npm ci`, full
  tests (75 files/1283 passed), typecheck, host contract, audit gates, build,
  exact dist/package/reproducibility checks, CLI smoke, shell syntax, release
  dry-run, release verification, diff-check, and empty tracked-dist proof.
- GitHub CI run `31638994522`, job `94256443040`, exact head `f82eb39`,
  completed successfully with 26 passed steps, 0 skipped, 0 failed.
- Final CI repair history is recorded here: run `31638418807` found the
  clean-checkout dist test lifecycle defect; run `31638682137` found the
  first CI dry-run version lookup; run `31638849051` found the second final
  contract lookup. Corrective commits `dd20469`, `a3faacc`, and `f82eb39`
  resolved those findings; the final run is green.
- Final staged release evidence was regenerated for `f82eb39`, and no real
  `v*` tag or GitHub Release was created or published. Wave 9 does not issue
  an Oracle Ship verdict or declare CRIP complete.

## Wave 8 — Deterministic release staging and verification — 2026-08-12

- Added deterministic `release:stage` and fail-closed `release:verify` commands.
  They never create or push a Git tag and never call GitHub Release APIs.
- Final local stage/verify identity: package `0.1.0`, tag `v0.1.0`, commit
  `45592338a3fe79435f27668d89baeeb88a21cbd4`.
- Exact staged asset set (11 files): `RELEASE.json`, `SHA256SUMS`,
  `install.sh`, `tokenmaxxer`, `tokenmaxxer.js`, `tokenmaxxer-tui.js`,
  `tokenmaxxer-cli.js`, `tokenmaxxer.d.ts`, `tokenmaxxer-tui.d.ts`,
  `tokenmaxxer-cli.d.ts`, and `tokenmaxxer-0.1.0.tgz`.
- SHA256SUMS installer payload evidence:
  - `RELEASE.json` — `98e0bc13853eb323fe6b109730e9de41d0e4d484dfed3a91a9406d0817050a9e`
  - `tokenmaxxer` — `765915aa0096c5501396e9e93f91ed172bd75888ad2b3c57e39058a90e36f8f9`
  - `tokenmaxxer-cli.js` — `01f638ea5917931689e0e2ff5bbe24be1fa1d3632008e7ae913cac088305661f`
  - `tokenmaxxer-tui.js` — `063b71d065a914c1216de76ee725c678674091c950ac0ccf88ebcf291a3a870b`
  - `tokenmaxxer.js` — `5661d7f3959e6d7409aee9b3d89260403eadf36d960fd886661a042fce3737ee`
- `npm run release:dry-run` and `npm run release:verify -- --dir .release`
  passed. Tampered payload and unexpected extra asset were independently
  rejected, then the restored set verified successfully.
- `npx vitest run test/release/workflow/workflow-contract.test.ts
  test/release/workflow/release-identity.test.ts
  test/release/installer/installer-contract.test.ts`: 69 passed.
- `node --check` for all three release scripts, `npx tsc --noEmit`, and both
  workflow YAML parses: passed.
- Corrected tag-release workflow integration to consume `release:stage` and
  `release:verify`, upload the exact 11-file staged set, and verify the remote
  asset set before draft publication.
- Current local release-builder deviation remains Node `v22.22.1` / npm `9.2.0`
  versus pinned target Node `22.23.1` / npm `10.9.8`; same-toolchain hashes are
  reproducible. No real `v*` tag or GitHub Release was created or published.

## Wave 9 — CI clean-checkout correction — 2026-08-12

- GitHub CI run `31638418807` at implementation head `b628384` exposed a
  legitimate clean-checkout defect: Wave-1 dist inventory tests scanned
  `dist/` before the CI build step and failed with `ENOENT` when generated
  output was correctly absent from the checkout.
- Corrected `test/release/dist-contract.test.ts` and
  `test/release/dist-inventory.test.ts` so a clean checkout explicitly accepts
  absent generated output, while exact six-file/integrity assertions remain
  active whenever `dist/` exists after build.
- Local correction evidence: clean-like run with `dist/` removed passed 8/8
  focused dist tests; post-build full `npm test` passed 75 files/1283 tests;
  `npx tsc --noEmit`, shell syntax, and `git diff --check` passed.
- The failed CI run was not a production behavior failure; it was a test
  lifecycle/order defect. A corrective commit and replacement CI run are
  required before Oracle evidence is finalized.
- Replacement CI run `31638682137` at corrective head `dd20469` passed the
  full suite, typecheck, host contract, audit, build, package, CLI, shell,
  and reproducibility gates, then failed only because a CI `set -u` shell step
  referenced the unavailable `npm_package_version` lifecycle variable.
- Replaced that workflow reference with an explicit `node -p` package-version
  lookup. Local workflow contracts (23/23), CI YAML parsing, dry-run preflight,
  and diff-check pass. A second replacement CI run is required.
- Final checksum policy correction: `SHA256SUMS` now covers all 10 staged
  payloads except the manifest itself, while the installer verifies its five
  downloaded payloads before mutation. Pre-commit staged-manifest evidence at
  implementation head `4559233` was:
  `RELEASE.json` `98e0bc13853eb323fe6b109730e9de41d0e4d484dfed3a91a9406d0817050a9e`;
  `install.sh` `67f85c89b034c334a35b1567dcd6f613f4848ec84e256a5a164497f380b33a3f`;
  `tokenmaxxer` `765915aa0096c5501396e9e93f91ed172bd75888ad2b3c57e39058a90e36f8f9`;
  `tokenmaxxer-0.1.0.tgz` `4d0dcdbcdf4412a0f5025bba46aecac1e683e540f1b539c1ded5325c42ee9853`;
  `tokenmaxxer-cli.d.ts` `e3785b697e3eb2e81e7e2bfdc5d704d5ad6452fd2ce111a04bcb8ed0d32ee94b`;
  `tokenmaxxer-cli.js` `01f638ea5917931689e0e2ff5bbe24be1fa1d3632008e7ae913cac088305661f`;
  `tokenmaxxer-tui.d.ts` `d9d1b42e84b3c870739db5c48a88afed9d1fdba91e6178ad762cd9ea80f13996`;
  `tokenmaxxer-tui.js` `063b71d065a914c1216de76ee725c678674091c950ac0ccf88ebcf291a3a870b`;
  `tokenmaxxer.d.ts` `363ec6aa5dfc1155a20ae1b4a9001100e9fe858b296d960a261731050ea5b32d`;
  `tokenmaxxer.js` `5661d7f3959e6d7409aee9b3d89260403eadf36d960fd886661a042fce3737ee`.

## Wave 6 — Pinned CI and tag-only release workflow — 2026-08-12

- Pinned all workflow Actions by verified full SHA with tag comments:
  checkout `de0fac2e4500dabe0009e67214ff5f5447ce83dd` (`v6.0.2`), setup-node
  `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` (`v6.4.0`), and setup-bun
  `0c5077e51419868618aeaa5fe8019c62421857d6` (`v2.2.0`).
- Ordinary CI remains limited to `contents: read`, runs on main push/PR, and
  contains no GitHub Release mutation. It now includes the mandatory release
  validation, package, installer, reproducibility, dry-run, checksum-contract,
  and tracked-dist gates.
- Added `.github/workflows/release.yml` with only `v*.*.*` tag push trigger,
  `contents: write` job permission, exact Node/Bun toolchain, immutable-release
  API preflight that fails closed, exact identity preflight, complete release
  validation, staged asset generation, draft-first creation, exact asset upload,
  uploaded-set/checksum verification, publish, and post-publish verification.
- `npx vitest run test/release/workflow/workflow-contract.test.ts`: 23 passed.
- Both workflow files parse successfully with the repository YAML parser.
- `git diff --check`: passed.
- Wave-6 scope leaves README stale-claim failures for Wave 7; no real `v*` tag
  or GitHub Release was created or published.

## Wave 7 — Production README truth pass — 2026-08-12

- README now points installation at the canonical GitHub Release asset
  `releases/latest/download/install.sh`, never mutable `raw.githubusercontent`
  main content.
- README now describes `dist/` as generated-only and not tracked, while
  preserving the six-file self-contained release target explanation.
- Current behavior is documented accurately: compaction augments the native
  prompt by default; replacement is explicit; LLM durable authority is
  decisions-only; `recall_promote` requests human review; prompt diagnostics
  and successful result diagnostics are distinct, including
  `last_compaction_result.json`.
- Removed the unverified `npm install -g tokenmaxxer@latest` recovery claim.
- `npx vitest run test/release/workflow/stale-doc-claims.test.ts`: 9 passed.
- `npm test`: 75 files, 1283 passed.
- Focused installer/workflow suites: 5 files, 88 passed.
- `npx tsc --noEmit`, `bash -n install.sh`, `bash -n bin/tokenmaxxer`, and
  `git diff --check`: passed.
- No real `v*` tag or GitHub Release was created or published.
