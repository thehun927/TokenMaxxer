# PR-10 Oracle Investigation Evidence

This is an evidence handoff for the independent Oracle. It is not an Oracle
finding, Ship verdict, or CRIP completion declaration. No real release tag or
GitHub Release was created.

## Identity and wave history

- Repository: `thehun927/TokenMaxxer`
- Planning baseline: `ab81ee51f693357048b7320fbf264a7350331c2c`
- Initial implementation head: `75aa5137fdf5fd12db912d699047326ff8ca3850`
- Final implementation head: `f82eb39ab6c1f57c1e7242dd05b23505ae4eda3c`
- Package version: `0.1.0`; staged identity: `v0.1.0` plus final head commit.

Wave commits:

```text
1bc4cd1 test: freeze PR-10 release contracts
328d8be build: remediate release dependencies
f5ec417 build: make release artifacts reproducible
218b814 release: add identity preflight
92e4ffc release: harden immutable installer
44c1dcd ci: pin release workflows
4559233 docs: align release and usage guidance
b628384 release: stage and verify immutable assets
dd20469 test: support clean generated-dist checkout
a3faacc ci: fix release dry-run version lookup
f82eb39 ci: fix final release contract lookup
```

## Toolchain and action evidence

Pinned targets: Node `22.23.1`, npm `10.9.8`, Bun `1.3.14`.
Local builder: Node `v22.22.1`, npm `9.2.0`, Bun `1.3.14`.

- checkout v6.0.2 → `de0fac2e4500dabe0009e67214ff5f5447ce83dd`
- setup-node v6.4.0 → `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e`
- setup-bun v2.2.0 → `0c5077e51419868618aeaa5fe8019c62421857d6`

## Final validation and CI

The exact local chain passed: `npm ci`; `npm test` (75 files, 1283 passed);
`npx tsc --noEmit`; `npm run verify:host-contract`; `npm run audit:release`;
`npm run build`; `npm run verify:dist`; `npm run check:tui-bundle`;
`npm run verify-cli-bundle`; `npm run smoke:cli`; both `bash -n` checks;
`npm run verify:package`; `npm run verify:reproducible-build`;
`npm run release:dry-run`; `npm run release:verify`; `git diff --check`.
`git ls-files 'dist/**'` printed nothing.

Final GitHub evidence:

- CI run `31638994522`: https://github.com/thehun927/TokenMaxxer/actions/runs/31638994522
- Exact head: `f82eb39ab6c1f57c1e7242dd05b23505ae4eda3c`
- Job `verify` ID `94256443040`: success, 26 passed, 0 skipped, 0 failed.
- Earlier CI corrections: `31638418807` found clean-checkout dist-test order;
  `31638682137` and `31638849051` found shell version-variable defects. They
  were corrected by `dd20469`, `a3faacc`, and `f82eb39`.

## Dist, reproducibility, staging, and package

`dist/` is ignored and `git ls-files 'dist/**'` is empty. Exact generated files:
`index.js`, `index.d.ts`, `tui.js`, `tui.d.ts`, `cli.js`, `cli.d.ts`.

Double-build SHA256 hashes:

```text
index.js    5661d7f3959e6d7409aee9b3d89260403eadf36d960fd886661a042fce3737ee
index.d.ts 363ec6aa5dfc1155a20ae1b4a9001100e9fe858b296d960a261731050ea5b32d
tui.js      063b71d065a914c1216de76ee725c678674091c950ac0ccf88ebcf291a3a870b
tui.d.ts    d9d1b42e84b3c870739db5c48a88afed9d1fdba91e6178ad762cd9ea80f13996
cli.js      01f638ea5917931689e0e2ff5bbe24be1fa1d3632008e7ae913cac088305661f
cli.d.ts    e3785b697e3eb2e81e7e2bfdc5d704d5ad6452fd2ce111a04bcb8ed0d32ee94b
```

Final staged files: `RELEASE.json`, `SHA256SUMS`, `install.sh`, `tokenmaxxer`,
`tokenmaxxer.js`, `tokenmaxxer-tui.js`, `tokenmaxxer-cli.js`,
`tokenmaxxer.d.ts`, `tokenmaxxer-tui.d.ts`, `tokenmaxxer-cli.d.ts`,
`tokenmaxxer-0.1.0.tgz`.

Final `SHA256SUMS`:

```text
8f16345e95179927c845b12d5c8b730c123daaf23faa13387131204c2168d087  RELEASE.json
64d3415b47b84a33f950d2d6a85c759e5b8c4fa3a36167409fa1e42c8d150da7  install.sh
765915aa0096c5501396e9e93f91ed172bd75888ad2b3c57e39058a90e36f8f9  tokenmaxxer
4d0dcdbcdf4412a0f5025bba46aecac1e683e540f1b539c1ded5325c42ee9853  tokenmaxxer-0.1.0.tgz
e3785b697e3eb2e81e7e2bfdc5d704d5ad6452fd2ce111a04bcb8ed0d32ee94b  tokenmaxxer-cli.d.ts
01f638ea5917931689e0e2ff5bbe24be1fa1d3632008e7ae913cac088305661f  tokenmaxxer-cli.js
d9d1b42e84b3c870739db5c48a88afed9d1fdba91e6178ad762cd9ea80f13996  tokenmaxxer-tui.d.ts
063b71d065a914c1216de76ee725c678674091c950ac0ccf88ebcf291a3a870b  tokenmaxxer-tui.js
363ec6aa5dfc1155a20ae1b4a9001100e9fe858b296d960a261731050ea5b32d  tokenmaxxer.d.ts
5661d7f3959e6d7409aee9b3d89260403eadf36d960fd886661a042fce3737ee  tokenmaxxer.js
```

Tarball contents are the exact 11 npm files: `package/package.json`,
`package/bin/tokenmaxxer`, six `package/dist/*` files, `package/install.sh`,
`package/LICENSE`, and `package/README.md`.

## Audit, installer, and documentation

- Audit before remediation: 4 low, 3 moderate, 1 high, 1 critical.
- Final fresh audit: 5 low, 0 moderate, 0 high, 0 critical.
- `npm audit --audit-level=high` and `npm audit --omit=dev --audit-level=low`
  passed. Remaining five lows are fully triaged in
  `docs/CRIP/PR-10/dependency-audit.md`; raw evidence is in
  `docs/CRIP/PR-10/dependency-audit.json`.
- Installer contracts: 31 passed; workflow/identity/stale-doc contracts: 57
  passed; complete release-focused slice: 115 passed.
- Evidence covers exact-tag URLs, checksum refusal, missing/tampered payloads,
  prior-byte preservation, rollback, first-install cleanup, receipts, mixed
  releases, truthful version, and CLI routing.
- Actual GitHub download/installation and real immutable-release API execution
  were not performed because creating the first real release is prohibited.

## 100 semantic cases

Each numbered case has an explicit evidence row:

| # | Direct evidence |
|---:|---|
| 1 | Final `git ls-files 'dist/**'` output is empty. |
| 2 | CI clean checkout passed with no generated `dist/` before build. |
| 3 | `npm run build` generated all six expected files. |
| 4 | `verify:dist` rejected any root entry outside the six-file set. |
| 5 | `verify:dist` checked nonzero `index.js`. |
| 6 | `verify:dist` checked nonzero `tui.js`. |
| 7 | `verify:dist` checked nonzero `cli.js`. |
| 8 | CI self-contained-bundle check scanned `index.js` for relative chunk imports. |
| 9 | CI self-contained-bundle check scanned `tui.js` for relative chunk imports. |
| 10 | CI self-contained-bundle check scanned `cli.js` for relative chunk imports. |
| 11 | Reproducibility verifier compared `index.js` SHA256 across two builds. |
| 12 | Reproducibility verifier compared `tui.js` SHA256 across two builds. |
| 13 | Reproducibility verifier compared `cli.js` SHA256 across two builds. |
| 14 | Reproducibility verifier compared all three declaration SHA256 values. |
| 15 | Tampered staged payload caused `release:verify` to exit 1. |
| 16 | Clean build plus `npm pack --dry-run` package verification passed. |
| 17 | Tarball contains `package/dist/index.js`. |
| 18 | Tarball contains `package/dist/tui.js`. |
| 19 | Tarball contains `package/dist/cli.js`. |
| 20 | Tarball contains `package/dist/index.d.ts`, `tui.d.ts`, and `cli.d.ts`. |
| 21 | Tarball contains `package/bin/tokenmaxxer`. |
| 22 | Tarball contains README, LICENSE, and package metadata. |
| 23 | Exact tarball inventory contains no `src/` entry. |
| 24 | Exact tarball inventory contains no `test/` entry. |
| 25 | Exact tarball inventory contains no `docs/CRIP/` entry. |
| 26 | Exact tarball inventory contains no `.release/` or memory entry. |
| 27 | `release:verify` exact inventory fails when a required package asset is absent. |
| 28 | Identity contract accepts tag exactly equal to `v0.1.0`. |
| 29 | Mismatched-tag RELEASE fixture is rejected. |
| 30 | Malformed SemVer fixture is rejected. |
| 31 | Exact 40-lowercase-hex commit fixture is accepted. |
| 32 | Short-commit fixture is rejected. |
| 33 | Uppercase/nonhex commit fixture is rejected. |
| 34 | Wrong RELEASE schema fixture is rejected; final schema is 1. |
| 35 | Final RELEASE version/tag/commit agrees with supplied stage identity. |
| 36 | Final RELEASE peer/minimum fields match host contract. |
| 37 | Final RELEASE records builder Node/npm/Bun versions. |
| 38 | Final RELEASE artifact allow-list is deterministic. |
| 39 | Two final-head `release:stage` outputs were byte-identical. |
| 40 | Final RELEASE has no timestamp, random ID, or branch field. |
| 41 | Final stage contains exactly 11 expected files. |
| 42 | `tokenmaxxer.js` is copied from `dist/index.js` and tarball bytes match. |
| 43 | `tokenmaxxer-tui.js` is copied from `dist/tui.js` and tarball bytes match. |
| 44 | `tokenmaxxer-cli.js` is copied from `dist/cli.js` and tarball bytes match. |
| 45 | `tokenmaxxer` is copied from the reviewed launcher and tarball bytes match. |
| 46 | `tokenmaxxer-0.1.0.tgz` is present and nonempty. |
| 47 | Staged installer has rendered version/tag/commit assignments. |
| 48 | Staged installer contains exact `v0.1.0`. |
| 49 | Staged installer contains the final 40-hex commit. |
| 50 | `SHA256SUMS` is generated in sorted filename order. |
| 51 | All ten staged payloads except `SHA256SUMS` have one checksum line. |
| 52 | Missing checksum entry is rejected by `release:verify`. |
| 53 | Duplicate checksum entry is rejected by `release:verify`. |
| 54 | Unknown/path-traversal checksum filename is rejected. |
| 55 | Valid staged release passes `release:verify`; real install is an explicit boundary. |
| 56 | Tampered server bundle is rejected by checksum verification. |
| 57 | TUI payload has its own checksum and identity verification. |
| 58 | CLI payload has its own checksum and missing-CLI refusal. |
| 59 | Launcher has its own checksum and staged identity verification. |
| 60 | RELEASE.json has its own checksum and schema/identity validation. |
| 61 | Missing-CLI fixture refuses the entire install. |
| 62 | Missing SHA256SUMS is rejected before installation mutation. |
| 63 | Malformed digest fixture refuses the entire install. |
| 64 | Installer checksum command failure is under strict fail-closed shell flow. |
| 65 | Installer curl branch is implemented; live download is prohibited here. |
| 66 | Installer wget fallback branch is implemented; live download is prohibited here. |
| 67 | URL contract proves all payloads use one exact release tag. |
| 68 | Installer/README contain no mutable-main or second-latest payload URL. |
| 69 | Transaction fixture commits all four executable targets on success. |
| 70 | Installer applies executable mode to the launcher. |
| 71 | Verification failure preserves prior server bytes. |
| 72 | Verification failure preserves prior TUI bytes. |
| 73 | Verification failure preserves prior CLI bytes. |
| 74 | Verification failure preserves prior launcher bytes. |
| 75 | Verification failure does not update the receipt. |
| 76 | Injected replacement failure rolls back committed targets. |
| 77 | First-install injected failure leaves no partial targets. |
| 78 | Receipt is written only after successful verification/commit. |
| 79 | Receipt version/tag/commit validation passed on valid/invalid fixtures. |
| 80 | Installer cleanup traps and fixture cleanup cover success/failure. |
| 81 | `tokenmaxxer version` reads the release receipt. |
| 82 | Version output includes the exact receipt tag. |
| 83 | Version output includes the exact receipt commit. |
| 84 | Empty HOME reports unavailable without fabricating a commit. |
| 85 | Malformed receipt reports unavailable safely. |
| 86 | CLI smoke preserves decisions/promote/supersede/opencode routing. |
| 87 | Launcher contains no unverified npm `@latest` recovery claim. |
| 88 | Fresh final `npm audit --json` was captured. |
| 89 | All five final advisory packages appear in triage. |
| 90 | Triage rows record direct/transitive and dependency paths. |
| 91 | Triage rows record dev/build/runtime and bundled status. |
| 92 | Final audit high count is zero and high gate passed. |
| 93 | Final audit critical count is zero and high gate passed. |
| 94 | Production `npm audit --omit=dev --audit-level=low` passed. |
| 95 | CI workflow uses full-SHA external action pins. |
| 96 | Release workflow uses full-SHA external action pins. |
| 97 | Release workflow has only the `v*.*.*` tag trigger. |
| 98 | Release workflow runs identity preflight before staging/publication. |
| 99 | Immutable-release preflight is fail-closed and publication is draft-first. |
| 100 | Final GitHub CI run passed complete dry-run validation: 26/26 steps. |

## Remaining deviations and handoff boundary

- Local Node/npm are below pinned release targets; same-toolchain reproducibility
  is proven locally and final GitHub CI passed.
- Five low audit findings remain explicitly triaged; no high or critical issue
  remains and production-scope audit passes.
- No real tag or release was published. No Ship verdict is issued. The
  independent Oracle owns the final PR-10/CRIP release gate.
