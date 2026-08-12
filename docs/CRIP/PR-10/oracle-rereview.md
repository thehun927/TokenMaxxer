# PR-10 Oracle Rereview Evidence

Evidence handoff for the independent Oracle after remediation of the four
focused blockers in `docs/CRIP/PR-10/oracle-findings.md`. This document does
not issue a Ship verdict or declare CRIP complete.

## Identities

- Findings commit: `7cf723255239015b7a63a2ef124572209ff93833`
- Remediation implementation commit: `23bfbfe2e01e871f2d54cb9d92657a75f6f4fe3b`
- Package version: `0.1.0`
- Staged identity: `v0.1.0` at
  `23bfbfe2e01e871f2d54cb9d92657a75f6f4fe3b`
- No real `v*` tag or GitHub Release was created or published.

## Exact GitHub CI evidence

- Run: `31644152523`
- URL: `https://github.com/thehun927/TokenMaxxer/actions/runs/31644152523`
- Job: `verify`, ID `94273638623`
- Head: `23bfbfe2e01e871f2d54cb9d92657a75f6f4fe3b`
- Conclusion: success
- Workflow steps: 26 passed, 0 skipped, 0 failed
- Full test step: 78 test files passed, 1 skipped; 1321 tests passed, 1 skipped
- Installer/workflow fixture step: 8 files, 117 tests passed
- Real production installer E2E: 10 tests passed in the full test step and
  the dedicated installer-E2E invocation.

## B1 — Production installer checksum and shell E2E

Production `install.sh` now:

- stores each parsed SHA256 digest rather than a presence sentinel;
- detects `sha256sum` or `shasum -a 256` and fails closed if neither exists;
- verifies the five downloaded payloads before mutation;
- preserves duplicate, missing, malformed, unexpected, and traversal checks;
- removes in-flight destination temp files during cleanup/rollback.

The real repository `install.sh` is executed by
`test/release/installer-e2e/installer-e2e.test.ts`, not by the model helper.
The test runs isolated HOME/TMPDIR sandboxes with local curl/wget/shasum
shims and passed 10/10 scenarios:

- valid curl install, executable launcher, four byte-identical targets, and
  receipt;
- valid wget install;
- valid `shasum -a 256` path;
- tampered payload preserves prior installation bytes;
- malformed checksum preserves prior installation bytes;
- missing checksum entry preserves prior installation bytes;
- replacement failure rolls back already-replaced targets and leaves no temp
  artifacts;
- first-install failure leaves no partial files;
- both downloader branches execute the production shell verifier;
- production-file sanity assertion confirms the repository installer is used.

`bash -n install.sh` and `bash -n bin/tokenmaxxer` passed.

## B2 — Immutable-release API and ordering

The tag-only release workflow now:

- queries the dedicated `/repos/${GITHUB_REPOSITORY}/immutable-releases`
  endpoint;
- uses `secrets.RELEASE_ADMIN_TOKEN` as the explicit Administration-read
  credential and fails closed when absent;
- does not treat `github.token` with `contents: write` as Administration read;
- creates a draft, uploads the complete asset set, verifies remote inventory
  plus local staged checksums/identity, then publishes;
- runs `gh release verify` only immediately after publication.

Structural workflow regressions passed 29/29 and existing workflow contracts
passed 23/23. YAML parsing passed. No real release workflow execution was
attempted because remediation must not publish the first release.

## B3 — Ordinary CI executes the actual release gate

Ordinary CI now executes:

```text
npm run audit:release
npm run build
npm run verify:dist
npm run verify:package
npm run verify:reproducible-build
npm run release:dry-run
npm run release:stage -- --tag "v<version>" --commit "$(git rev-parse HEAD)" --out .release
npm run release:verify -- --dir .release --tag "v<version>" --commit "$(git rev-parse HEAD)"
npx vitest run test/release/installer test/release/installer-e2e test/release/workflow
test -z "$(git ls-files 'dist/**')"
```

The previous echo-only checksum step is gone. The B3 structural suite passed
13/13. The final CI run logged successful `release:stage` and `release:verify`
steps, real installer-E2E execution, and the fail-closed tracked-dist check.

## B4 — Runtime engine and builder separation

- Shipped `package.json` and `package-lock.json` engine floor: `>=18`.
- Release builder remains separately pinned: Node `22.23.1`, npm `10.9.8`,
  Bun `1.3.14`.
- Workflow setup-node remains `22.23.1`; `.node-version` and
  `packageManager` remain builder hints.
- OpenCode peer remains `>=1.18.15 <2.0.0`; dev minimum remains `1.18.15`.
- Runtime/builder separation contract suite passed 10/10.

## Stage, package, audit, and tracked-dist evidence

- Final local `release:stage` produced exactly 11 assets.
- Final `release:verify` passed for `0.1.0`, `v0.1.0`, and the remediation
  commit.
- SHA256SUMS contained 10 payload entries, excluding only SHA256SUMS itself.
- `git ls-files 'dist/**'` printed nothing.
- Fresh final audit: 5 low, 0 moderate, 0 high, 0 critical.
- `npm run audit:release` passed; all remaining low findings are explicitly
  triaged in `docs/CRIP/PR-10/dependency-audit.md`.
- Final staged `RELEASE.json` recorded schema 1, version/tag/commit identity,
  peer/minimum host contracts, and builder metadata.
- `docs/RELEASING.md` documents the Administration-read prerequisite,
  draft-first procedure, exact tag/version/commit process, post-publication
  attestation verification, SHA256SUMS, never-reuse-tag rule, and the
  no-real-release remediation boundary.

## Remaining boundary

No real tag, GitHub Release, remote asset upload, or post-publication
attestation was performed during remediation. The independent Oracle owns the
final rereview and release gate; this handoff contains evidence only.
