# PR-10 Post-Ship Hotfix — Release Tag Lifecycle Validation

**Status:** implementation plan ready

This is a narrowly scoped post-Ship release-hygiene hotfix discovered while attempting the first real immutable `v0.1.0` publication. It does **not** reopen the CRIP reliability architecture and must not change TokenMaxxer runtime semantics from PRs 1–10.

## 1. Incident / current state

The first release tag exists:

```text
v0.1.0 -> ca4e11f440494aae8b8ba02ce33ba72acd315a3a
```

The tag is annotated (`TokenMaxxer 0.1.0`). No GitHub Release or draft release exists.

Release workflow run `31651601925` failed closed several times while the release security controls were configured. The latest attempt successfully proved:

- `RELEASE_ADMIN_TOKEN` is valid;
- repository immutable releases are enabled;
- `v0.1.0` resolves to `ca4e11f440494aae8b8ba02ce33ba72acd315a3a`;
- the tagged commit is reachable from `origin/main`;
- release identity preflight passes in publication mode.

It then failed during the full test suite because two implementation-era tests still require that **no `v*` tag exists anywhere in the repository**:

```text
test/release/workflow/release-identity.test.ts
  FAIL no release tag exists before the independent Oracle Ship

  expected: []
  received: ["v0.1.0"]

  FAIL spawned release preflight accepts exact identity and rejects mismatches
  because --dry-run still invokes the same no-existing-release-tags check
```

This condition was correct only before the independent PR-10 Ship verdict. It is invalid after Ship and would make every future release impossible once any prior release tag exists.

No staging, draft release creation, upload, publication, or immutable attestation occurred in the failing release attempts.

## 2. Hotfix invariant

> **Release validation must be lifecycle-correct: ordinary CI and dry-run validation may run in repositories that already contain historical release tags; a real tag-triggered publication must instead prove that the requested `v<package.version>` tag exists, resolves to the exact release commit, and that commit is reachable from `main`. Historical proof that no release tag existed before the original Oracle Ship belongs in CRIP evidence, not in perpetual executable release policy.**

Corollaries:

1. Existing historical `v*` tags are normal after the first release.
2. `--dry-run` must never require the repository to contain zero release tags.
3. The default/local preflight must never require the repository to contain zero release tags.
4. Tag publication mode must continue to fail closed on a missing tag, wrong tag target, wrong version/tag pair, malformed commit, or commit not reachable from `main`.
5. The hotfix must not weaken immutable-release, checksum, dependency, staging, installer, or attestation gates.
6. The hotfix must not modify runtime memory/compaction/diagnostic behavior.

## 3. Baselines

Post-CRIP `main` baseline at planning time:

```text
6a7dc716f79e5ea26a95e48e8f8744d0d7073618
```

Original independently reviewed release implementation:

```text
ca4e11f440494aae8b8ba02ce33ba72acd315a3a
```

Existing annotated release tag object:

```text
v0.1.0
  tag object: 5b0e313c746066538a9e56043bc5e625f639cde6
  commit:     ca4e11f440494aae8b8ba02ce33ba72acd315a3a
```

Failed historical release workflow:

```text
run: 31651601925
latest observed publication job: 94316794259
```

Do **not** use that historical workflow run as final release evidence after the hotfix. A hotfix release must be triggered from the final validated hotfix tag target.

## 4. Exact scope

Expected production/test files:

```text
scripts/release-preflight.mjs
test/release/workflow/release-identity.test.ts
```

Likely new focused lifecycle test/fixture file(s):

```text
test/release/workflow/release-tag-lifecycle.test.ts
# optional temp-git fixture helpers under test/release/workflow/
```

Update only if needed for truthful operator guidance:

```text
docs/RELEASING.md
```

`package.json` should not need a version change for the implementation hotfix. Its release scripts may be changed only if required to express the corrected lifecycle contract.

Out of scope unless a concrete regression proves otherwise:

```text
src/**
install.sh
bin/tokenmaxxer
scripts/release-stage.mjs
scripts/release-verify.mjs
.github/workflows/release.yml
.github/workflows/ci.yml
package-lock.json
dependency versions
release asset inventory
checksum format
immutable-release auth model
```

If Luna discovers that any out-of-scope production file genuinely must change, record the reason in the hotfix handoff before modifying it.

## 5. Required implementation behavior

### 5.1 Retire ambient zero-tag authority

Remove `validateNoExistingReleaseTags()` from perpetual release validation.

There must be no production/test requirement equivalent to:

```bash
git tag --list 'v*'  # must be empty
```

That was a one-time pre-Ship implementation boundary, already permanently evidenced in the PR-10 Oracle records.

Do not replace it with a special case such as:

```text
allow v0.1.0 but reject other v* tags
```

The hotfix must support normal future history containing `v0.1.0`, `v0.1.1`, `v0.2.0`, etc.

### 5.2 Base/default preflight

The base preflight continues to validate:

- `package.json` version is valid SemVer;
- supplied tag is exactly `v${package.version}`;
- supplied commit is exactly 40 lowercase hex;
- OpenCode peer remains `>=1.18.15 <2.0.0`;
- minimum verified host remains `1.18.15`;
- optional `RELEASE.json` identity is valid if present;
- non-dry-run invocation rejects a supplied commit that does not equal checkout `HEAD`.

It must **not** reject merely because historical release tags exist.

### 5.3 Dry-run mode

`--dry-run` is a proposed-release identity check. It must:

- validate tag/version/commit syntax and package contract;
- allow fixture/proposed 40-hex commits without requiring them to equal checkout `HEAD`;
- ignore unrelated existing historical release tags;
- never create/delete/move tags;
- never call GitHub Release APIs.

A command such as:

```bash
node scripts/release-preflight.mjs \
  --tag v0.1.0 \
  --commit 0123456789abcdef0123456789abcdef01234567 \
  --dry-run
```

must remain valid even when `v0.1.0` or other `v*` tags already exist in the ambient repository, because dry-run does not claim that the supplied commit is the actual tag target.

### 5.4 Tag publication mode

`--require-main-ancestor` remains the real publication mode and must continue to validate the **requested tag**, not global tag absence.

Required checks:

```text
requested tag exists
requested tag == v${package.version}
requested tag resolves to exact supplied commit
supplied commit is exactly checkout HEAD in non-dry-run release execution
supplied commit is reachable from origin/main
```

It must reject:

```text
missing requested tag
requested tag -> wrong commit
wrong v<version> tag
short/nonhex/uppercase commit
commit not reachable from origin/main
```

The presence of older unrelated release tags must not affect the result.

### 5.5 Tests must not depend on ambient repository history

Delete/replace this production-tree assertion:

```ts
it("no release tag exists before the independent Oracle Ship", ...)
```

Do not replace it with another test that assumes the real repository currently has a particular number of tags.

Tests for Git tag behavior should use isolated temporary Git repositories wherever tag topology matters.

A temp fixture should be able to create at least:

```text
main commit A
main commit B
v0.0.9 -> A
v0.1.0 -> B
```

and prove historical tags do not invalidate the requested tag.

For wrong-ancestry coverage, create an orphan/unmerged commit/tag in the fixture rather than mutating the actual TokenMaxxer repository.

## 6. Mandatory focused regression matrix

Luna must map each item to a named automated test or exact command.

### Lifecycle / ambient tags

H1. Full release identity test file passes when at least one historical `v*` tag exists.

H2. Multiple unrelated historical release tags do not fail dry-run validation.

H3. Multiple unrelated historical release tags do not fail publication-mode validation of the requested tag.

H4. Tests do not assert that ambient `git tag --list 'v*'` is empty.

H5. Tests do not delete, force-move, or create tags in the real TokenMaxxer checkout.

### Base/dry-run preflight

H6. Exact valid SemVer/tag/40-hex proposed identity passes dry-run.

H7. Dry-run passes with historical tags present.

H8. Wrong tag/version pair fails.

H9. Short commit fails.

H10. uppercase/nonhex commit fails.

H11. Changed OpenCode peer/minimum-host contract fails.

H12. Dry-run performs no tag mutation.

### Publication mode

H13. Requested annotated/lightweight tag resolving to the exact supplied commit passes as applicable to fixture coverage.

H14. Requested tag missing fails.

H15. Requested tag pointing at a different commit fails.

H16. Requested tag exact while older release tags exist passes.

H17. Requested commit not reachable from `origin/main` fails.

H18. Non-dry-run supplied commit differing from checkout HEAD fails.

### Release workflow compatibility

H19. `npm test` passes in a checkout that contains an existing `v0.1.0` tag.

H20. `npm run release:dry-run` passes after release tags exist.

H21. `npm run release:preflight` passes on an ordinary post-release `main` checkout without requiring zero tags.

H22. Existing release workflow contract tests still prove `--require-main-ancestor` is used by the tag workflow.

H23. Immutable-release preflight remains before staging/publication.

H24. `npm run audit:release` remains in the tag workflow.

H25. No release/draft API operation occurs before full validation succeeds.

### Non-regression

H26. `dist/**` still has zero tracked files.

H27. production `install.sh` E2E remains green.

H28. release staging/verification remains deterministic and green.

H29. complete PR 1–10 semantic suite remains green.

H30. no runtime `src/**` behavior changed.

## 7. Luna execution plan

This hotfix is intentionally small. Use four waves.

### Wave 1 — reproduce and freeze lifecycle contracts

One test-only subagent.

Allowed changes:

```text
test/release/workflow/**
```

Tasks:

1. Reproduce the two failures with the existing real `v0.1.0` tag present.
2. Add isolated temp-Git lifecycle fixtures/tests covering H1–H18.
3. Replace the obsolete zero-tag production-tree assertion with lifecycle-correct expectations.
4. Do not modify production code in Wave 1.

Luna reruns focused tests and confirms they fail for the expected production reason before proceeding.

### Wave 2 — preflight lifecycle implementation

One production subagent.

Owned file:

```text
scripts/release-preflight.mjs
```

Optional only if demonstrably required:

```text
package.json
```

Tasks:

1. Remove ambient zero-tag validation from default/dry-run policy.
2. Preserve exact tag-target/main-ancestry publication validation.
3. Preserve non-dry-run HEAD authenticity validation.
4. Keep CLI behavior fail-closed for malformed/mismatched identity.
5. Update comments/usage text so they no longer claim perpetual zero-tag authority.

Do not change the tag workflow or version number merely to make tests pass.

### Wave 3 — integration / operator truth

Luna owns integration.

Tasks:

1. Run all H1–H30 focused checks.
2. Inspect `docs/RELEASING.md`; update only if it still implies that a repository must have no prior release tags.
3. Run the complete release gate locally on the integrated hotfix head.
4. Confirm no GitHub Release or draft was created.
5. Confirm the existing remote `v0.1.0` tag has **not** been moved by implementation work.

### Wave 4 — pushed CI and handoff

Luna only.

1. Push the hotfix implementation to `main` using the normal implementation workflow.
2. Run/observe exact-head ordinary GitHub CI.
3. Record exact test counts, CI run/job, and focused lifecycle evidence.
4. Create:

```text
docs/CRIP/PR-10/post-ship-release-tag-hotfix-investigation.md
```

5. Stop for independent review.

Luna must **not** move/delete/recreate `v0.1.0`, create a draft release, publish a release, or rerun the old release workflow as part of implementation.

## 8. Required final validation chain

At minimum on the exact final hotfix implementation head:

```bash
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

If `release:dry-run` itself stages and verifies `.release`, do not duplicate unsafe cleanup; follow the existing scripts' contract.

The release-tag fixture tests must also be run explicitly and their count recorded.

## 9. Post-hotfix release procedure — NOT for Luna implementation

The currently existing `v0.1.0` tag points to the pre-hotfix `ca4e11f...` tree. The historical release run `31651601925` is therefore not suitable as the final release run for the hotfix.

No GitHub Release has ever been published for `v0.1.0`. Under GitHub immutable-release semantics, the associated tag becomes locked only once an immutable release is published; tags not tied to a release remain movable.

After the hotfix receives an independent Ship verdict:

1. confirm again that there is still no GitHub Release/draft for `v0.1.0`;
2. confirm final hotfix head is the exact desired `0.1.0` release source;
3. recreate/retarget the annotated `v0.1.0` tag to that validated hotfix head;
4. push the corrected tag so GitHub creates a **new tag-push release workflow run** on the hotfix SHA;
5. do **not** use a rerun of `31651601925`, because that run is tied to the old tag event/tree;
6. verify the new workflow passes immutable preflight, full validation, staging, draft upload/inventory verification, publication, and `gh release verify`;
7. verify the resulting Release reports immutable and its tag/commit/assets match `RELEASE.json` and `SHA256SUMS`.

If GitHub refuses retargeting the still-unpublished tag for any policy reason, stop. Do not weaken immutability. The fallback is a separately planned `0.1.1` version bump/release, because the current exact identity contract correctly requires `tag == v${package.version}`.

## 10. Handoff evidence

`post-ship-release-tag-hotfix-investigation.md` must contain:

- planning baseline and final hotfix SHA;
- exact files changed;
- explanation that zero-tag authority was historical/pre-Ship only;
- mapping H1–H30 to tests/commands;
- focused lifecycle test counts;
- full suite passed/skipped counts;
- full local release-chain results;
- exact GitHub CI run/job on hotfix head;
- proof `v0.1.0` still points to `ca4e11f...` during implementation handoff;
- proof no GitHub Release/draft exists;
- confirmation Luna did not move/delete/recreate a release tag;
- every deviation or concern.

Then stop for independent review.

## 11. Independent review attack surface

Oracle should specifically attack:

1. whether any ambient/global zero-tag assumption remains;
2. whether dry-run accidentally treats an existing tag as authority for a fabricated fixture commit;
3. whether publication mode still validates exact requested tag target;
4. whether prior historical release tags are tolerated;
5. whether wrong-target/missing/unmerged tags fail closed;
6. whether tag workflow still performs immutable/dependency/full validation before any draft creation;
7. whether tests mutate the real repository's tags;
8. whether PR 1–10 runtime semantics remain untouched;
9. whether the proposed post-Ship retag procedure is deferred until after independent hotfix Ship.

This hotfix is complete only when ordinary CI and dry-run validation remain valid in a mature repository containing prior releases while real publication still proves exact tag/version/commit authority.