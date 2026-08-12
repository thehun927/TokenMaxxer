# PR-10 Oracle Findings

**Verdict: Block**

Independent Oracle release-gate review for CRIP PR 10 — Reproducible Release and Dependency Hygiene.

PR 10 is the final CRIP workstream. This review therefore treats an incorrect installer or non-executable release workflow as a release blocker even when ordinary CI is green.

## Reviewed identities

- Planning baseline: `ab81ee51f693357048b7320fbf264a7350331c2c`
- Final implementation tree: `f82eb39ab6c1f57c1e7242dd05b23505ae4eda3c`
- Oracle evidence/docs child: `44f794d13b478f2cd7668697bccd72c202956883`
- Handoff: `docs/CRIP/PR-10/oracle-investigation.md`
- GitHub CI run: `31638994522`
- CI job: `94256443040`

`44f794d...` is one commit ahead of `f82eb39...` and changes only `docs/CRIP/PR-10/blockers.md` plus the new `oracle-investigation.md`. The CI-tested production/test tree is therefore exactly the final implementation tree.

No real `v*` tag or GitHub Release exists at this review point. That implementation boundary was respected.

## What held up

The major PR-10 architecture is directionally correct and should not be redesigned during remediation:

- tracked `dist/**` files are removed; generated `dist/` is ignored;
- clean builds produce the intended six-file distribution inventory;
- the pinned CI builder is Node `22.23.1`, npm `10.9.8`, Bun `1.3.14`;
- external CI/release actions are pinned by full commit SHA;
- same-toolchain double-build reproducibility succeeds for all six generated files;
- package allow-list checks are present;
- deterministic `RELEASE.json`, staging and `SHA256SUMS` machinery exists;
- release identity is version + exact `v<version>` tag + exact 40-hex commit;
- release workflow is tag-triggered and draft-first;
- installer URLs are pinned to one exact release tag rather than mutable `main`;
- installer has a transaction/rollback/receipt structure;
- launcher has truthful `tokenmaxxer version` receipt behavior;
- dependency remediation reduced the observed audit from 4 low / 3 moderate / 1 high / 1 critical to 5 low / 0 moderate / 0 high / 0 critical;
- PRs 1–9 semantic source files were not changed;
- PRs 1–9 and TMTUI regressions remain green in the full test suite.

The blockers below are focused release-integrity gaps in that architecture.

---

## B1 — production installer cannot verify a valid checksum manifest

**Severity: release blocker — deterministic first-install failure**

The production `install.sh` checksum parser records only a presence sentinel:

```bash
seen["$filename"]=1
```

but verification later compares the real SHA-256 digest against that stored value:

```bash
actual="$(sha256sum "$STAGING_DIR/$expected" | awk '{print $1}')"
[ "$actual" = "${seen[$expected]}" ] || die "SHA256SUMS verification failed for $expected"
```

Therefore every valid payload is compared against the literal string `1`. A legitimate immutable release cannot pass the production installer checksum step.

This is not theoretical and does not require network timing or a malformed release. The happy path is broken.

### Why the current tests missed it

`test/release/installer/installer-contract.test.ts` uses the parallel TypeScript contract implementation in `test/release/installer/installer-contract.ts` for checksum and transaction behavior. Production `install.sh` receives structural assertions, but the rendered production shell checksum path is not executed end-to-end against a staged release.

The release invariant is about the actual installer that users execute, not an equivalent test model.

### Additional portability gap

The concrete PR-10 plan required SHA-256 implementation detection (`sha256sum` or `shasum -a 256`). Production currently calls only `sha256sum`. This should be fixed in the same remediation instead of leaving the first release GNU-coreutils-only by accident.

### Required remediation

1. Store the actual parsed digest for each manifest filename, not a presence sentinel.
2. Keep duplicate/missing/unexpected/path-traversal rejection.
3. Add a small checksum command abstraction that detects and uses `sha256sum` or `shasum -a 256`; fail clearly if neither exists.
4. Add production-shell integration tests that execute the **rendered real installer** in an isolated HOME with download commands shimmed to copy a local staged release:
   - valid release installs all four executable targets and the receipt;
   - tampered payload fails before mutation;
   - missing/malformed checksum fails before mutation;
   - replacement failure restores all prior bytes;
   - first-install failure leaves no partial targets;
   - curl branch and wget fallback both exercise the real shell verifier.
5. Do not replace these with another model/helper-only test.

---

## B2 — immutable-release preflight and verification sequence is not executable as written

**Severity: release blocker — tag workflow would fail before a legitimate publication**

The release workflow currently attempts to prove immutable releases with:

```bash
settings="$(gh api "repos/${GITHUB_REPOSITORY}" --jq '{immutable_releases: .security_and_analysis.immutable_releases}')"
test "$(printf '%s' "$settings" | jq -r '.immutable_releases.enabled // false')" = true
```

That is not the GitHub immutable-release status API. GitHub documents a dedicated endpoint:

```text
GET /repos/{owner}/{repo}/immutable-releases
```

whose successful response includes `enabled` / `enforced_by_owner`. The endpoint requires repository **Administration: read** permission for fine-grained/App authentication.

The workflow supplies only the ordinary `github.token` under `contents: write`. GitHub's Actions documentation says that when required permissions are not available through `GITHUB_TOKEN`, a GitHub App installation token or appropriately scoped PAT secret must be used.

The normal repository object also does not expose `.security_and_analysis.immutable_releases`, so the current query fails closed for the wrong reason even before considering authorization.

There is a second ordering problem. The workflow does:

```text
create draft
upload assets
gh release verify <tag>
publish draft
gh release verify <tag>
```

GitHub documents `gh release verify` as verification of the cryptographic attestation for an immutable release, while immutable protection/attestation applies after publication. GitHub's recommended sequence is draft -> attach all assets -> publish. The pre-publication draft should be validated for asset inventory/digests without claiming immutable-attestation verification; immutable verification belongs immediately after publish.

### Required remediation

1. Query the dedicated immutable-release endpoint, not the general repository object.
2. Use an authentication mechanism that actually has Administration-read permission (for example a narrowly scoped GitHub App installation token or suitable PAT secret), or document and implement another genuinely fail-closed prerequisite. Do not pretend `contents: write` grants Administration read.
3. Keep draft-first publication.
4. Before publish, verify the complete uploaded asset inventory and local/staged checksums/identity.
5. Publish only after those checks pass.
6. Run `gh release verify <tag>` immediately after publication to verify the immutable release attestation.
7. Add workflow-contract regressions that reject:
   - the wrong repository endpoint;
   - missing required auth input for immutable-status lookup;
   - `gh release verify` before the draft is published;
   - publish before asset-set verification.
8. Preserve the implementation rule that no real release is published during remediation/Oracle handoff.

---

## B3 — green ordinary CI does not execute the release gate claimed by the handoff

**Severity: release blocker — release automation is not independently exercised on the exact head**

Run `31638994522` is genuinely green on `f82eb39...`, but several steps are weaker than the concrete PR-10 gate and the handoff description.

### Dependency gate mismatch

CI runs:

```bash
npm audit --audit-level=high
```

instead of the canonical:

```bash
npm run audit:release
```

which also includes the production-scope `npm audit --omit=dev --audit-level=low` gate.

### Release dry-run is only preflight

The step named `Release staging dry-run (no publication)` runs only:

```bash
npm run release:preflight -- ... --dry-run
```

It does **not** run `release:stage` or `release:verify`.

### Checksum-verification step is echo-only

The step named `Release-set checksum verification contract` contains only two `printf` statements. It performs no release staging or checksum verification.

### Final release-contract step still does not stage/verify

The final step again invokes only preflight plus:

```bash
git diff --check
git ls-files 'dist/**'
```

`git ls-files` exits successfully even when it prints tracked files, so this is not itself a fail-closed zero-tracked-dist assertion.

As a result, the exact green CI run never executes the real `release:stage` / `release:verify` scripts that are supposed to be release authority. Local handoff evidence is useful, but PR 10's purpose is to make the automation itself reproducible and auditable; the exact GitHub gate must exercise it.

### Required remediation

Ordinary CI on the exact remediation tree must, at minimum:

```bash
npm run audit:release
npm run build
npm run verify:dist
npm run verify:package
npm run verify:reproducible-build
npm run release:dry-run
npm run release:verify -- --dir .release --tag "v<package-version>" --commit "$(git rev-parse HEAD)"
test -z "$(git ls-files 'dist/**')"
```

It must also run the real production-shell installer integration tests from B1.

Remove the echo-only checksum step or replace it with real execution. The final Oracle handoff must cite the exact remediation-head CI run and precise passed/skipped counts.

### CI count correction

The exact run reports:

```text
Test files: 74 passed + 1 skipped = 75 total
Tests:      1282 passed + 1 skipped = 1283 total
```

The handoff's `1283 passed` wording treats the expected skip as a pass. Future evidence should preserve passed/skipped separately.

---

## B4 — package runtime support was narrowed to the release builder version contrary to the PR-10 contract

**Severity: release blocker — unplanned compatibility regression**

The planning baseline declared:

```json
"engines": { "node": ">=18" }
```

PR 10 now declares:

```json
"engines": { "node": ">=22.23.1" }
```

while the CLI build still explicitly targets Node 18.

The concrete PR-10 plan explicitly separated release-builder pinning from shipped runtime compatibility:

> Do not change the shipped CLI's declared Node runtime compatibility merely because the release builder uses Node 22.

The implementation log describes the new `engines >=22.23.1` as part of builder hints, which conflates those two contracts. No independently demonstrated runtime incompatibility justifies dropping the previously declared Node 18 support in this PR.

### Required remediation

1. Restore the shipped runtime engine floor to the previously supported value (normally `>=18`) unless a real runtime incompatibility is independently demonstrated and deliberately approved as a compatibility break.
2. Keep the reproducible builder pinned separately through `.node-version`, `packageManager`, workflow setup-node, and `RELEASE.json` builder metadata.
3. Add a package/release contract test that distinguishes runtime `engines.node` from the release-builder Node version so they cannot drift together accidentally.
4. Preserve the OpenCode host peer/minimum contract unchanged.

---

## Exact CI evidence

GitHub Actions run `31638994522`, job `94256443040`, checked out:

`f82eb39ab6c1f57c1e7242dd05b23505ae4eda3c`

The run is green, and it does prove substantial non-release regression health:

```text
Test files          74 passed + 1 expected skip = 75 total
Tests               1282 passed + 1 expected skip = 1283 total
TypeScript          PASS
Host contract       PASS
High-severity audit PASS
Build               PASS
Dist inventory      PASS
TUI bundle          PASS
Bundle self-contain PASS
CLI/package checks  PASS
CLI smoke           PASS
Shell syntax        PASS
Reproducible build  PASS
Release fixtures    PASS
```

It also uses the pinned Node `22.23.1`, npm `10.9.8`, Bun `1.3.14`, and the planned full-SHA action pins.

This CI success does **not** clear B1–B3 because the production shell install is not executed and the real release stage/verify path is not exercised in ordinary CI.

## Non-blocking / closeout items to fold into remediation

- The concrete plan requested a release operator guide such as `docs/RELEASING.md`. It is not present at the implementation head. Add it while fixing B2 so the first-release procedure documents the immutable-release prerequisite, required credential, tag/version rules, post-publication `gh release verify`, and never-reuse-tag policy.
- Keep the five remaining low dependency advisories explicitly triaged. They are not a Block reason because high/critical are zero and production-scope audit passes under the planned policy.
- Do not broaden this remediation into PR 1–9 semantic code.

---

# Focused final remediation wave

Keep this to one release-integrity wave:

```text
R1  Fix the real installer checksum map + portable SHA command.
    Add shell-level rendered-installer happy/tamper/rollback integration tests.

R2  Fix immutable-release API/auth and draft/publish verification ordering.
    Add workflow regressions for endpoint, auth and ordering.

R3  Make ordinary CI execute the actual release gate:
    audit:release, stage, verify, real installer E2E, and fail-closed zero tracked dist.

R4  Restore runtime Node compatibility separately from builder pinning.
    Pin the distinction in package tests.

R5  Add docs/RELEASING.md and update handoff evidence.
```

Then run the complete PR 1–9 + PR-10 chain on the exact pushed remediation implementation SHA and publish:

`docs/CRIP/PR-10/oracle-rereview.md`

as evidence only.

The rereview handoff must include:

- exact remediation implementation SHA;
- exact GitHub CI run/job;
- exact passed + skipped counts;
- production-shell installer E2E command/results;
- actual `release:stage` / `release:verify` CI evidence;
- immutable-status endpoint/auth contract evidence;
- runtime engine/build-toolchain separation evidence;
- `git ls-files 'dist/**'` explicit empty assertion;
- fresh dependency audit summary;
- confirmation that no real tag/release was created.

Do **not** create a release tag, publish a GitHub Release, mark PR 10 Complete, or declare CRIP complete before the independent rereview.

## Final decision

**Block.**

PR 10 is not yet safe to publish. CRIP remains **9/10 complete** until the four focused release-integrity gaps above are closed and the exact remediation tree is green.