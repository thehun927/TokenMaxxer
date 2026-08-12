# PR-10 Oracle Final Rereview

**Verdict: Block — original B1–B4 closed; two narrow final release-hygiene residuals remain**

Independent Oracle rereview of CRIP PR 10 after remediation handoff `docs/CRIP/PR-10/oracle-rereview.md`.

## Reviewed identities

- Original Oracle findings: `7cf723255239015b7a63a2ef124572209ff93833`
- Remediation implementation head: `23bfbfe2e01e871f2d54cb9d92657a75f6f4fe3b`
- Rereview evidence/docs child: `d5a5bfd` (one documentation-only commit after the remediation head)
- GitHub CI run: `31644152523`
- GitHub CI job: `94273638623`

`d5a5bfd` changes only `docs/CRIP/PR-10/oracle-rereview.md`; the exact production/test tree reviewed and exercised by CI is `23bfbfe2e01e871f2d54cb9d92657a75f6f4fe3b`.

No real `v*` tag or GitHub Release exists at this review point.

---

# Original blockers — all closed

## B1 — production installer checksum path: CLOSED

Production `install.sh` now stores the actual parsed digest:

```bash
seen["$filename"]="$digest"
```

and compares downloaded payload bytes against that digest through the portable `sha256_of()` abstraction.

The installer detects either:

- `sha256sum`; or
- `shasum -a 256`;

and fails closed when neither is available.

The new `test/release/installer-e2e/installer-e2e.test.ts` executes the real repository `install.sh`, not the parallel TypeScript contract model. The exact CI run exercised 10 real-shell scenarios covering valid curl/wget installs, `shasum`, tampering, malformed/missing checksums, rollback, first-install cleanup, and destination-temp cleanup.

**B1 is closed.**

## B2 — immutable release endpoint/auth/order: CLOSED

`.github/workflows/release.yml` now:

- uses the dedicated `/repos/${GITHUB_REPOSITORY}/immutable-releases` API;
- authenticates that check through `secrets.RELEASE_ADMIN_TOKEN` rather than `github.token`;
- fails closed when the Administration-read credential is absent;
- creates a draft first;
- uploads the complete asset set;
- verifies uploaded asset inventory plus local staged checksums/identity before publication;
- publishes only after those checks pass;
- runs `gh release verify` only after publication.

A direct Oracle API attempt with the ordinary connector credential receives the expected Administration-permission 403 on this endpoint, supporting the remediation's explicit separate-credential requirement.

**B2 is closed.**

## B3 — ordinary CI release gate: CLOSED

The exact CI workflow now really executes:

```text
npm run audit:release
npm run release:dry-run
npm run release:stage -- --tag v0.1.0 --commit <exact-head> --out .release
npm run release:verify -- --dir .release --tag v0.1.0 --commit <exact-head>
npx vitest run test/release/installer test/release/installer-e2e test/release/workflow
test -z "$(git ls-files 'dist/**')"
```

GitHub run `31644152523` logs successful staging and verification of release `0.1.0 / v0.1.0 / 23bfbfe...`, then executes the real installer E2E suite and the fail-closed tracked-dist assertion.

The previous echo-only checksum placeholder is gone.

**B3 is closed.**

## B4 — runtime/build-tool separation: CLOSED

`package.json` and `package-lock.json` restore:

```json
"engines": { "node": ">=18" }
```

while release-building remains separately pinned to Node `22.23.1`, npm `10.9.8`, and Bun `1.3.14`.

The CLI remains targeted to Node 18 and the OpenCode peer/minimum contract remains `>=1.18.15 <2.0.0` / `1.18.15`.

**B4 is closed.**

---

# Exact validation evidence

GitHub CI run `31644152523`, job `94273638623`, checked out exactly:

`23bfbfe2e01e871f2d54cb9d92657a75f6f4fe3b`

and passed all 26 reported workflow steps.

Exact full-suite counts:

```text
Test files: 78 passed + 1 skipped = 79 total
Tests:      1321 passed + 1 skipped = 1322 total
```

Focused installer/workflow invocation:

```text
8 files passed
117 tests passed
```

Real production installer E2E:

```text
10 tests passed
```

Other exact-head gates observed green include:

- TypeScript typecheck;
- OpenCode minimum-host contract;
- `npm run audit:release`;
- distribution build;
- exact six-file generated dist verification;
- TUI and CLI bundle checks;
- npm package allow-list;
- CLI smoke;
- installer/launcher shell syntax;
- same-toolchain reproducibility;
- deterministic release staging;
- staged release checksum/identity verification;
- `git diff --check`;
- zero tracked `dist/**` files.

Audit at this head is 5 low / 0 moderate / 0 high / 0 critical, while the production-scope `npm audit --omit=dev --audit-level=low` reports zero vulnerabilities.

---

# New residual R1 — README manual install contradicts generated-only dist

**Severity: release-documentation blocker**

PR 10 intentionally removed every tracked `dist/**` file and made `dist/` generated-only. A fresh clone therefore does not contain `dist/index.js` or `dist/tui.js` until the build is run.

However the shipped README currently advertises:

```bash
git clone https://github.com/thehun927/TokenMaxxer.git
cd TokenMaxxer
mkdir -p ~/.config/opencode/plugins
cp dist/index.js ~/.config/opencode/plugins/tokenmaxxer.js
cp dist/tui.js ~/.config/opencode/plugins/tokenmaxxer-tui.js
```

with no `npm ci` / `npm run build` step.

That documented manual installation path deterministically fails on the exact clean-checkout model PR 10 established.

The preceding one-liner description also says it downloads generated `dist/index.js` and `dist/tui.js` directly, while the actual immutable release assets are `tokenmaxxer.js`, `tokenmaxxer-tui.js`, `tokenmaxxer-cli.js`, and `tokenmaxxer`.

PR 10's release invariant explicitly requires documentation claims to describe the implementation that actually shipped. This contradiction must be fixed before final Ship.

### Required remediation

Choose one truthful manual path:

**Build-from-source path:**

```bash
git clone ...
cd TokenMaxxer
npm ci
npm run build
# then copy generated dist targets
```

or document downloading the exact immutable release assets instead.

Also update the one-liner explanation to describe release asset names rather than claiming the installer downloads repository `dist/...` paths.

Add a stale-document regression proving a clean-clone manual path either builds first or never claims generated `dist/` is already present.

---

# New residual R2 — tag workflow does not rerun the complete dependency release gate

**Severity: focused release-policy blocker**

Ordinary CI correctly runs:

```text
npm run audit:release
```

which expands to both:

```text
npm audit --audit-level=high
npm audit --omit=dev --audit-level=low
```

The tag-only release workflow's `Full release validation` step still runs only:

```text
npm audit --audit-level=high
```

This means the actual publication workflow does not independently enforce the PR-10 production-scope low-severity gate at release time.

That distinction matters because npm advisory data is time-dependent: a commit that had green main CI earlier can be tagged later after the advisory database changes. The final release workflow should rerun the complete policy rather than only half of it.

### Required remediation

Replace the tag workflow's standalone high audit with:

```text
npm run audit:release
```

and add a workflow-contract assertion that both ordinary CI and the tag-release workflow invoke the same committed release-audit gate.

No package/dependency redesign is required.

---

# Final remediation scope

Do not redesign PR 10. One micro-wave is sufficient:

1. fix README's generated-dist/manual-install and one-liner release-asset wording;
2. make `.github/workflows/release.yml` invoke `npm run audit:release`;
3. add the two focused contract regressions;
4. rerun full CI on the exact pushed remediation head;
5. publish `docs/CRIP/PR-10/oracle-second-rereview.md` and stop.

Still do **not** create a real tag or GitHub Release during remediation.

## Verdict

The original B1–B4 release failures are convincingly closed and the remediation quality is strong. PR 10 is not being sent back for architectural work.

However, because PR 10 is explicitly the release/documentation hygiene workstream, the final Oracle will not declare CRIP complete while a documented clean-clone install path is known to fail and the real tag workflow enforces only half of the committed dependency release policy.

**Block pending R1–R2 micro-remediation.**
