# PR-10 Oracle Second Final Rereview

**Verdict: Ship**

Independent final release-gate rereview for CRIP PR 10 — Reproducible Release and Dependency Hygiene.

This review closes the two residual findings recorded in `oracle-final-rereview.md` and, with them, the final workstream in the ten-PR Concrete Reliability Implementation Plan.

## Reviewed identities

- Prior residual findings: `752b72f4c071c688c5591e170c48d3d83ff41110`
- Final implementation/evidence head: `ca4e11f440494aae8b8ba02ce33ba72acd315a3a`
- Evidence handoff: `docs/CRIP/PR-10/oracle-second-rereview.md`
- Package version: `0.1.0`
- Candidate first-release identity exercised in CI: `v0.1.0` at `ca4e11f440494aae8b8ba02ce33ba72acd315a3a`
- GitHub CI run: `31650370812`
- GitHub CI job: `94293174237`

GitHub Actions checked out exactly `ca4e11f440494aae8b8ba02ce33ba72acd315a3a`. There is no production/test-tree indirection in this final gate.

At review time the repository still has no `v*` tags and no GitHub Releases. The implementation boundary prohibiting publication before independent Oracle Ship was preserved.

---

## R1 — documentation matches generated-only distribution authority

**Closed.**

The README manual-clone path now builds generated artifacts before copying them:

```bash
git clone https://github.com/thehun927/TokenMaxxer.git
cd TokenMaxxer
npm ci
npm run build
mkdir -p ~/.config/opencode/plugins
cp dist/index.js ~/.config/opencode/plugins/tokenmaxxer.js
cp dist/tui.js ~/.config/opencode/plugins/tokenmaxxer-tui.js
```

This is compatible with the PR-10 invariant that `dist/` is generated output and has no tracked files.

The one-line installer description also now names the actual immutable GitHub Release assets (`tokenmaxxer.js`, `tokenmaxxer-tui.js`, `tokenmaxxer-cli.js`, `tokenmaxxer`) rather than claiming the installer downloads repository `dist/...` paths.

Focused regressions are present and green:

- `test/release/workflow/residual-r1-manual-install.test.ts`: 2/2
- `test/release/workflow/stale-doc-claims.test.ts`: 9/9

No stale manual-install contradiction remains in the reviewed surface.

---

## R2 — tag publication reruns the complete dependency release policy

**Closed.**

The tag-only release workflow's full release validation now invokes the same committed dependency gate as ordinary CI:

```bash
npm run audit:release
```

which expands to:

```bash
npm audit --audit-level=high
npm audit --omit=dev --audit-level=low
```

Thus the future release tag cannot rely solely on a potentially older green branch audit: it regenerates both the full-tree high/critical gate and production-scope low-severity gate immediately before build/staging/publication.

Focused regression:

- `test/release/workflow/release-audit-gate.test.ts`: 10/10

The previous release-workflow safety properties remain intact:

- tag-only trigger;
- immutable-release status checked through the dedicated endpoint;
- explicit Administration-read credential required and absence fails closed;
- ordinary `GITHUB_TOKEN` is not treated as Administration-read authority;
- exact tag/version/commit preflight;
- complete validation before staging;
- draft-first release creation;
- complete asset upload and remote inventory check before publication;
- staged checksum/identity verification before publication;
- `gh release verify` only after publication.

---

## Final CI evidence

Run `31650370812`, job `94293174237`, is green on exact head `ca4e11f440494aae8b8ba02ce33ba72acd315a3a`.

Exact full-suite counts from GitHub Actions:

```text
Test files: 80 passed + 1 skipped = 81 total
Tests:      1333 passed + 1 skipped = 1334 total
```

The expected skip is the existing launcher smoke test file; it is not a PR-10 failure.

The dedicated release/installer/workflow invocation is also green:

```text
10 test files passed
129 tests passed
```

That invocation includes the actual production `install.sh` E2E suite rather than only the parallel TypeScript contract model.

The exact CI chain passed:

- `npm ci`
- full `npm test`
- `npx tsc --noEmit`
- minimum OpenCode host contract (`>=1.18.15 <2.0.0`, dev/verified minimum `1.18.15`)
- `npm run audit:release`
- build
- exact generated-dist verification
- TUI bundle verification
- self-contained bundle verification
- CLI bundle/launcher/installer verification
- npm package allow-list verification
- CLI smoke
- installer/launcher shell syntax
- same-commit reproducible-build check
- actual `release:dry-run`
- actual `release:stage`
- actual `release:verify`
- focused installer E2E + workflow contracts
- `git diff --check`
- fail-closed assertion that `git ls-files 'dist/**'` is empty.

The staged immutable release set was generated and verified for `0.1.0 / v0.1.0 / ca4e11f...` without creating a tag or release.

---

## Dependency status

The final audit observed:

```text
5 low
0 moderate
0 high
0 critical
```

The production-scope `npm audit --omit=dev --audit-level=low` returned zero vulnerabilities. Remaining low development/build findings are triaged in `docs/CRIP/PR-10/dependency-audit.md` and do not violate the PR-10 release policy.

No high or critical advisory is being waived.

---

## Final PR-10 release invariant assessment

The release invariant is satisfied:

> Every installed TokenMaxxer release is designed to be traceable to one immutable Git tag and source commit; downloaded executable payloads are pinned to that one release and checksum-verified before installation mutation; release builds are generated from source under the pinned builder rather than trusted from committed `dist/`; package/dependency contents are auditable; installation is transactional with rollback; and user/release documentation describes the implemented PRs 1–9 behavior and PR-10 distribution model.

The remaining first-release action is operational, not an implementation blocker: after this Ship verdict, the maintainer may follow `docs/RELEASING.md` to create the first real annotated version tag and let the tag-only release workflow publish the immutable GitHub Release. That real release execution should not retroactively change the reviewed source tree.

## Verdict

**Ship.**

PR 10 is complete.

With PRs 1 through 10 independently gated as Ship, the Concrete Reliability Implementation Plan is **10/10 complete**.
