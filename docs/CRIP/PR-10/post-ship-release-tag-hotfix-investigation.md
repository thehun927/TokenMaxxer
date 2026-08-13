# PR-10 Post-Ship Release Tag Hotfix Investigation

## Identity and scope

- Planning baseline: `6a7dc716f79e5ea26a95e48e8f8744d0d7073618`
- Hotfix plan/current-main baseline: `499fa01e856593c266e22a3de9fe9f50c0eeb409`
- Original release implementation: `ca4e11f440494aae8b8ba02ce33ba72acd315a3a`
- Implementation hotfix commit: `c5b2cd2f0bcc56ad41ac2b9b4f335019990f75b9`
- Package version: `0.1.0`

The obsolete ambient zero-release-tag assertion was historical pre-Ship
evidence, not a lifecycle policy. The hotfix removes it from executable
preflight validation. Dry-run/default validation now tolerates historical
tags; publication mode validates only the requested tag target and its
`origin/main` ancestry.

Changed implementation/test files before this handoff document:

```text
scripts/release-preflight.mjs
test/release/workflow/release-identity.test.ts
test/release/workflow/release-tag-lifecycle.test.ts
```

No `src/**`, installer, launcher, release asset inventory, checksum format,
dependency version, immutable-auth, or workflow file changed.

## Focused lifecycle evidence

`test/release/workflow/release-tag-lifecycle.test.ts` creates disposable Git
repositories under the approved temporary workspace. Each fixture contains:

```text
main commit A
main commit B (child of A)
v0.0.9 -> A
v0.1.0 -> B
orphan/unmerged commit -> v0.2.0
origin/main -> B
```

The fixture tests use captured Git object IDs, exact tag resolution, real
ancestry checks, and cleanup in `finally` blocks. They do not mutate the real
TokenMaxxer checkout.

Focused results on the implementation head:

```text
npx vitest run test/release/workflow/release-tag-lifecycle.test.ts
18 passed

npx vitest run test/release/workflow/release-tag-lifecycle.test.ts \
  test/release/workflow/release-identity.test.ts
33 passed
```

The pre-hotfix reproduction was one failure in the existing executable
identity test: dry-run rejected the ambient `v0.1.0` tag. After the production
change, the combined focused run is fully green.

## H1–H30 evidence map

| Case | Evidence |
| --- | --- |
| H1 | Lifecycle test H1: historical tag and dry-run success |
| H2 | Lifecycle test H2: multiple historical tags tolerated in dry-run |
| H3 | Lifecycle test H3: publication validates the requested tag |
| H4 | H4 fixture and revised identity test; no empty ambient-tag assertion remains |
| H5 | H5 safety test; tag operations use disposable fixture paths |
| H6 | Lifecycle test H6: valid SemVer/tag/40-hex dry-run success |
| H7 | Lifecycle test H7: dry-run success with historical tags |
| H8 | Lifecycle test H8: wrong tag/version rejection |
| H9 | Lifecycle test H9: short commit rejection |
| H10 | Lifecycle test H10: uppercase/nonhex commit rejection |
| H11 | Lifecycle test H11: modified peer/minimum package rejection |
| H12 | Lifecycle test H12: dry-run success and unchanged tag list |
| H13 | Lifecycle test H13: exact annotated `v0.1.0` target succeeds |
| H14 | Lifecycle test H14: missing requested tag fails |
| H15 | Lifecycle test H15: wrong requested-tag target fails |
| H16 | Lifecycle test H16: exact tag succeeds with older tags present |
| H17 | Lifecycle test H17: orphan tag fails `origin/main` ancestry |
| H18 | Lifecycle test H18: non-dry-run HEAD mismatch fails closed |
| H19 | Full `npm test`: 82 files / 1,352 tests passed with real `v0.1.0` present |
| H20 | `npm run release:dry-run` passed with historical tags |
| H21 | `npm run release:preflight` passed on post-release main |
| H22 | Workflow contract tests preserve `--require-main-ancestor` |
| H23 | Immutable-release contract tests preserve preflight ordering/auth |
| H24 | Release-audit contract test and `npm run audit:release` passed |
| H25 | Workflow contracts preserve validation before release mutation |
| H26 | `test -z "$(git ls-files 'dist/**')"` passed |
| H27 | Installer E2E/workflow run: 10 files / 116 tests passed |
| H28 | Staging, verification, and reproducible-build checks passed |
| H29 | Complete local semantic suite: 82 files / 1,352 tests passed |
| H30 | No `src/**` file changed |

## Required local release chain

The exact requested chain passed on the implementation head:

```text
npm ci
npm test
npx tsc --noEmit
npm run verify:host-contract
npm run audit:release
npm run build
npm run verify:dist
npm run check:tui-bundle
npm run verify-cli-bundle
npm run smoke:cli
bash -n install.sh
bash -n bin/tokenmaxxer
npm run verify:package
npm run verify:reproducible-build
npm run release:preflight
npm run release:dry-run
npm run release:verify -- --dir .release --tag v0.1.0 --commit "$(git rev-parse HEAD)"
npx vitest run test/release/installer-e2e test/release/workflow
git diff --check
test -z "$(git ls-files 'dist/**')"
```

Results included 1,352 full-suite tests passed, 116 installer/workflow tests
passed, successful generated-dist/package/reproducibility checks, successful
release staging and verification, and no tracked `dist/**` files.

## Exact-head GitHub CI

- Run: `31660513870`
- Job: `verify` / `94324172875`
- Head: `c5b2cd2f0bcc56ad41ac2b9b4f335019990f75b9`
- Result: success
- URL: https://github.com/thehun927/TokenMaxxer/actions/runs/31660513870/job/94324172875

Every CI step passed, including full tests, audit, build, reproducible build,
release dry-run/stage/verify, installer E2E/workflow contracts, and the
zero-tracked-dist assertion.

## Release/tag safety proof

During implementation and handoff:

- Local `v0.1.0` resolves to
  `ca4e11f440494aae8b8ba02ce33ba72acd315a3a`.
- Remote `refs/tags/v0.1.0` remains annotated object
  `5b0e313c746066538a9e56043bc5e625f639cde6`, resolving to that same commit.
- The hotfix was pushed only to `main`; no tag was created, deleted, moved, or
  recreated.
- `gh api repos/thehun927/TokenMaxxer/releases --paginate` returned `[]`.
- `gh release list` returned no releases or drafts.
- Historical workflow run `31651601925` was not rerun.
- No GitHub Release or draft release was created.

## Deviations and concerns

- The dependency audit reports five low-severity development/build findings;
  there are zero production-scope, moderate, high, or critical findings.
  Existing dependency policy and versions were not changed.
- Git fixture setup emits Git's harmless default-branch advisory and an
  expected empty-index `git rm` diagnostic while constructing an orphan
  fixture. The fixture tests pass and clean up their temporary repositories.
- This document is added after the implementation CI run; its final handoff
  commit and any resulting ordinary CI run must be recorded when available.

Luna did not issue Ship, move `v0.1.0`, create a release, create a draft, or
weaken immutable-release controls. Stop here for independent Oracle review.
