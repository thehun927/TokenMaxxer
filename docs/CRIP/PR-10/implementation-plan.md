# CRIP PR 10 — Concrete Implementation Plan

**Workstream:** Reproducible release and dependency hygiene  
**Status:** Implementation plan ready  
**Planning baseline:** `ab81ee51f693357048b7320fbf264a7350331c2c`  
**Depends on:** PRs 1–9 — all **Complete — Ship**

## Release invariant

> **Every installed TokenMaxxer release must be traceable to one immutable Git tag and source commit; every downloaded executable file must come from that same release and verify against its checksum manifest before any existing installation is replaced; release builds must be generated from source by a pinned toolchain rather than trusted from mutable committed `dist/`; package and dependency contents must be auditable; and release/documentation claims must describe the implementation that actually shipped in PRs 1–9.**

PR 10 is the final CRIP workstream. It is distribution hardening, not another semantic-memory redesign.

---

# 1. Confirmed baseline problems

The implementation starts from real current behavior, not a hypothetical release system.

## 1.1 `dist/` has conflicting authority

The repository currently ignores `dist/` in `.gitignore`, but some generated dist files are still tracked. CI rebuilds `dist/`, yet it does not assert tracked/generated parity. The README calls the tracked build artifacts the distribution source.

This is an ambiguous authority model:

```text
source TypeScript/TSX
        ↓ build
working-tree dist/
        ↕
tracked historical dist/
        ↓
raw-main installer
```

PR 10 chooses exactly one strategy:

> **`dist/` is generated build output only. It is not committed release authority.**

Remove every tracked `dist/**` file from Git. Keep `/dist/` ignored. Release and npm-package jobs build it from the tagged source commit.

## 1.2 The current installer can mix mutable revisions

Current `install.sh` downloads independently from mutable `main`:

```text
main/dist/index.js
main/dist/tui.js
main/dist/cli.js
main/bin/tokenmaxxer
```

A branch update between requests can mix revisions.

The current tracked `dist/` also does not contain the CLI bundle that the installer URL names, which proves that checked-in `dist/` cannot remain release authority.

## 1.3 No GitHub release pipeline exists

Current `.github/workflows/` contains only `ci.yml`. There are no GitHub tags or releases at this planning baseline.

PR 10 adds a tag-triggered release workflow, but **Luna must not create/push a release tag during implementation or Oracle handoff**. Publication occurs only after PR 10 receives an independent Oracle **Ship** verdict.

## 1.4 CI Actions are mutable tag references and emit Node-runtime deprecation warnings

Current CI uses:

```yaml
actions/checkout@v4
actions/setup-node@v4
oven-sh/setup-bun@v2
```

PR 10 pins workflow actions to full verified commit SHAs and upgrades the GitHub actions that were still on the deprecated Node 20 action runtime.

Planning-time verified action pins:

```text
actions/checkout v6.0.2
  de0fac2e4500dabe0009e67214ff5f5447ce83dd

actions/setup-node v6.4.0
  48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e

oven-sh/setup-bun v2.2.0
  0c5077e51419868618aeaa5fe8019c62421857d6
```

Luna must re-verify those tag→commit identities before integrating them. Do not silently switch to another tag or SHA.

## 1.5 Dependency audit debt is intentionally deferred here

The final PR-9 CI baseline reported:

```text
9 npm audit findings
4 low
3 moderate
1 high
1 critical
```

This count is only a baseline observation. Advisory data is time-dependent, so PR 10 must regenerate `npm audit --json` on its own implementation head and triage the actual findings it receives.

Do **not** run `npm audit fix --force` as policy.

## 1.6 Release documentation is stale

At minimum the current README still describes:

- tracked `dist/` as distribution truth;
- the compaction hook as replacing the native prompt by default, although PR 7 shipped native augmentation as the default;
- `recall_promote` as directly making a decision foundational, although PR 3 moved human trust/promotion behind the interactive CLI review boundary;
- the old active-file extraction/activity model;
- only the prompt snapshot in debugging, not the PR-9 successful result diagnostic;
- mutable-main installation URLs.

PR 10 must update documentation from current production code and shipped CRIP invariants, not from old prose.

---

# 2. Hard scope boundaries

PR 10 may change build/release/package/install/documentation surfaces and dependency versions needed to remediate release risk.

PR 10 must **not** redesign:

- STATE authority or revision semantics;
- PR-2 mutation locking;
- decision authority/promotion semantics;
- PR-5 source-version completion/idempotency;
- PR-6 decisions-only LLM durable authority;
- PR-7 augment/replace compaction semantics or anti-drift contract;
- PR-8 8,192-byte STATE or 4,096-byte injection budgets;
- PR-9 diagnostic semantics;
- `.commit-pulse` / TMTUI meaning;
- the minimum OpenCode host contract `>=1.18.15 <2.0.0` unless an independently proven compatibility requirement forces a separate explicit decision.

Dependency upgrades are allowed only when all PR 1–9 semantic and host-contract tests remain green.

Npm publication is **not** established as the canonical TokenMaxxer release channel in this PR. `npm pack` is validated because `package.json` advertises a package layout, but PR 10 does not automatically `npm publish` or claim `npm install -g tokenmaxxer@latest` is supported unless a real npm publication channel is separately established and verified.

---

# 3. Chosen end-state architecture

## 3.1 Generated-only `dist/`

Canonical rule:

```text
src/ + scripts/ + lockfile
        ↓ pinned build toolchain
      dist/
        ↓ validation
release staging / npm pack
```

Never:

```text
tracked dist/ → user install
```

Required repository rule:

```bash
# must print nothing
git ls-files 'dist/**'
```

`dist/` stays ignored.

Expected generated dist inventory after a clean build:

```text
dist/index.js
dist/index.d.ts
dist/tui.js
dist/tui.d.ts
dist/cli.js
dist/cli.d.ts
```

No generated chunk imports are allowed in any JS target.

## 3.2 Pinned release build environment

Use the existing verified runtime/build line as the reproducible release environment:

```text
Node: 22.23.1
npm:  10.9.8
Bun:  1.3.14
```

Add repository hints for the build environment as appropriate, for example:

```text
.node-version     22.23.1
.bun-version      1.3.14
packageManager    npm@10.9.8
```

Do not change the shipped CLI's declared Node runtime compatibility merely because the release builder uses Node 22.

Release jobs must print and validate the actual Node/npm/Bun versions before building.

## 3.3 Same-commit reproducibility proof

Add a reusable check, e.g.:

```text
npm run verify:reproducible-build
```

It must:

1. clean `dist/`;
2. build once;
3. hash every expected generated dist file in stable filename order;
4. save the manifest outside `dist/`;
5. remove `dist/`;
6. build again with the same locked dependencies/toolchain;
7. hash again;
8. byte-compare the manifests;
9. fail on any difference, unexpected file, missing file, or generated chunk.

No build timestamp, random ID, temp path, or working-directory-specific value may be embedded in release payloads.

This proves deterministic reproduction in the supported release environment. PR 10 does not claim bit-for-bit cross-platform reproducibility across arbitrary Node/Bun/toolchain versions.

---

# 4. Canonical release identity

One release is identified by all three values:

```text
version  = package.json version, e.g. 0.1.0
tag      = v${version}, e.g. v0.1.0
commit   = exact 40-hex Git commit targeted by that tag
```

They must never disagree.

No release workflow may infer a different version from a mutable branch after receiving a tag event.

## 4.1 Release manifest

Add a deterministic generated `RELEASE.json` with schema version 1.

Target shape:

```json
{
  "schema_version": 1,
  "version": "0.1.0",
  "tag": "v0.1.0",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "opencode_peer": ">=1.18.15 <2.0.0",
  "opencode_minimum_verified": "1.18.15",
  "builder": {
    "node": "22.23.1",
    "npm": "10.9.8",
    "bun": "1.3.14"
  },
  "artifacts": [
    "tokenmaxxer.js",
    "tokenmaxxer-tui.js",
    "tokenmaxxer-cli.js",
    "tokenmaxxer"
  ]
}
```

Rules:

- deterministic field/order generation;
- no generated timestamp;
- no branch name as authority;
- commit exactly 40 lowercase hex;
- tag exactly matches package version;
- artifact allow-list exact.

## 4.2 Release staging directory

Use ignored generated staging, e.g. `.release/`.

Canonical staged release set:

```text
.release/tokenmaxxer.js
.release/tokenmaxxer-tui.js
.release/tokenmaxxer-cli.js
.release/tokenmaxxer
.release/install.sh
.release/RELEASE.json
.release/tokenmaxxer-<version>.tgz
.release/SHA256SUMS
```

Mappings:

```text
dist/index.js  → tokenmaxxer.js
dist/tui.js    → tokenmaxxer-tui.js
dist/cli.js    → tokenmaxxer-cli.js
bin/tokenmaxxer → tokenmaxxer
```

The npm tarball is included as an auditable package-layout artifact but is not the raw installer's input.

## 4.3 Checksum manifest

`SHA256SUMS` must be deterministic and sorted by filename.

Use the conventional form:

```text
<64 lowercase hex><two spaces><filename>
```

It includes every release asset except `SHA256SUMS` itself.

The release staging validator must reject:

- duplicate filenames;
- unknown filenames;
- missing expected filenames;
- path separators / traversal;
- non-lowercase or non-64-hex digests;
- zero-byte executable payloads;
- mismatched checksums.

---

# 5. Immutable GitHub release policy

GitHub Releases is the canonical binary release channel for PR 10.

Before the first real TokenMaxxer release, repository **release immutability must be enabled**. This is a one-time repository setting/admin prerequisite; Luna must document it and make the release workflow fail closed when it is not enabled.

Release immutability is intentionally part of the release invariant because published release assets and the release tag must not be replaceable later.

The workflow preflight should query the repository immutable-release endpoint and fail with an actionable error if it cannot prove immutability is enabled.

## 5.1 Draft-first publication

The tag-triggered workflow must:

1. validate the tag/version/commit;
2. run all release gates;
3. stage and locally verify all artifacts;
4. create a **draft** release for the existing tag;
5. upload the complete artifact set;
6. verify the uploaded asset names/counts and, where supported, re-download and checksum them;
7. only then publish the draft;
8. verify the published release/attestation.

Do not upload assets to a published immutable release one by one.

## 5.2 No release during implementation

Luna/subagents must never push `v*` tags while implementing PR 10.

CI/main validation exercises the exact staging and installer logic with a dry-run identity, but it does not call GitHub release mutation APIs.

After independent Oracle **Ship**, the repository owner may create/push the real version tag. The tag event then publishes the first immutable release.

---

# 6. Release workflow

Add:

```text
.github/workflows/release.yml
```

Trigger only from version tags, for example:

```yaml
on:
  push:
    tags:
      - 'v*.*.*'
```

No mutable-branch auto-release.

Minimum permissions:

```yaml
permissions:
  contents: write
```

Do not add broader permissions without a demonstrated need.

## 6.1 Action pinning

Both `ci.yml` and `release.yml` use full immutable action commit SHAs, with a comment recording the human-readable tag.

Expected pins at planning time:

```yaml
uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
```

Use:

```yaml
node-version: 22.23.1
bun-version: 1.3.14
```

Release checkout uses:

```yaml
fetch-depth: 0
persist-credentials: false
```

## 6.2 Release preflight

Create a reusable script, e.g.:

```text
scripts/release-preflight.mjs
```

Inputs:

```text
--tag
--commit
--require-main-ancestor (release workflow)
```

Checks:

1. version is valid SemVer;
2. tag exactly `v${package.version}`;
3. commit is exactly 40 lowercase hex;
4. `GITHUB_SHA` equals the tag target commit;
5. tagged commit is reachable from `origin/main`;
6. peer range remains `>=1.18.15 <2.0.0`;
7. minimum dev/host contract remains `1.18.15`;
8. no release already exists for the tag;
9. immutable releases are provably enabled.

For local/CI dry-run, the GitHub-mutating/network-only checks are skipped explicitly by a `--dry-run` mode; semantic identity checks still run.

## 6.3 Exact release job sequence

The actual tag job should be structurally equivalent to:

```text
checkout exact tag commit
verify pinned tool versions
release-preflight
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
npm run verify:reproducible-build
npm run verify:package
npm run release:stage -- --tag "$GITHUB_REF_NAME" --commit "$GITHUB_SHA"
npm run release:verify
installer release-fixture tests
create draft GitHub release
upload exact staged set
verify uploaded set
after all checks: publish draft
verify published release attestation
```

Use GitHub CLI already present on GitHub-hosted runners rather than adding a third-party release action unless a concrete platform deficiency is proven.

Never use asset `--clobber` on a published release.

---

# 7. Installer contract

`install.sh` becomes a release-installer template/source. The staged release copy receives embedded immutable identity values:

```text
RELEASE_VERSION
RELEASE_TAG
RELEASE_COMMIT
RELEASE_BASE_URL = .../releases/download/${RELEASE_TAG}
```

The staged installer must contain no unresolved placeholders.

The public README one-liner becomes conceptually:

```bash
curl -fsSL https://github.com/thehun927/TokenMaxxer/releases/latest/download/install.sh | bash
```

`latest` is allowed only to obtain the installer asset itself. Once that installer starts, **every payload URL is pinned to its embedded exact release tag**. The running installer must never subsequently fetch `main` or another `latest` URL.

## 7.1 Download phase — no mutation

Before touching an existing install:

1. create one private staging temp directory;
2. install cleanup trap;
3. detect `curl` or `wget`;
4. detect SHA-256 implementation (`sha256sum` or `shasum -a 256`);
5. download from the embedded exact tag:
   - `SHA256SUMS`
   - `RELEASE.json`
   - `tokenmaxxer.js`
   - `tokenmaxxer-tui.js`
   - `tokenmaxxer-cli.js`
   - `tokenmaxxer`
6. reject missing/empty files;
7. validate checksum-manifest structure/allow-list;
8. verify every downloaded payload and `RELEASE.json` checksum;
9. only after complete verification proceed to installation.

Verification failure must occur before any destination replacement or OpenCode config mutation.

## 7.2 Replacement phase — rollback capable

Use destination-filesystem temp files and backups.

Targets:

```text
~/.config/opencode/plugins/tokenmaxxer.js
~/.config/opencode/plugins/tokenmaxxer-tui.js
~/.config/opencode/plugins/tokenmaxxer-cli.js
~/.local/bin/tokenmaxxer
```

Procedure:

1. copy verified staged files to unique destination-side temporary files;
2. create backups of every existing target;
3. rename verified temps into place;
4. if any replacement fails, restore all prior targets and remove partial new files;
5. set launcher executable mode;
6. only after successful file commit perform package/tui configuration updates;
7. write an installation receipt atomically;
8. print installed version/tag/commit.

A verification error must leave old files byte-for-byte untouched.

## 7.3 Installation receipt

Persist verified release identity outside the plugin loader directory, e.g.:

```text
~/.config/opencode/tokenmaxxer-release.json
```

Target schema:

```json
{
  "schema_version": 1,
  "version": "0.1.0",
  "tag": "v0.1.0",
  "commit": "0123456789abcdef0123456789abcdef01234567"
}
```

Receipt content comes only from the staged installer's embedded verified release identity.

Write atomically after all executable payloads are successfully committed.

## 7.4 Visible installed version

Extend the launcher with:

```text
tokenmaxxer version
```

For raw release installs it reports the receipt, for example:

```text
tokenmaxxer 0.1.0 (v0.1.0, 0123456789abcdef0123456789abcdef01234567)
```

Do not invent a source commit when the receipt is absent. If running from a package/manual layout without release metadata, report the package version if determinable and explicitly state that the source commit is unavailable.

Remove the current unverified `npm install -g tokenmaxxer@latest` recovery claim unless npm publication becomes a separately verified channel.

---

# 8. Npm package contract

The npm tarball is validated even though GitHub Releases is the canonical PR-10 install channel.

## 8.1 Clean-checkout pack must work

A clean checkout with no tracked `dist/` must still produce a correct package after the documented build/prepack flow.

Expected npm package contents should be explicitly allow-listed, including only intended files such as:

```text
package.json
README.md
LICENSE
bin/tokenmaxxer
dist/index.js
dist/index.d.ts
dist/tui.js
dist/tui.d.ts
dist/cli.js
dist/cli.d.ts
```

Do not accidentally package:

```text
src/
test/
docs/CRIP/
.opencode/
.release/
STATE.json
diagnostic artifacts
node_modules/
CI files
```

Whether the source `install.sh` template belongs in the npm tarball should be decided explicitly. Default recommendation: **remove it from the npm `files` list**, because the GitHub release installer is a rendered release artifact, not an npm-runtime input.

## 8.2 Package verification

Add:

```text
npm run verify:package
```

It should consume `npm pack --dry-run --json --ignore-scripts` (after a build) and assert the exact allow-list, no missing dist targets, sensible package size, and no unexpected files.

The release workflow may create the actual `tokenmaxxer-<version>.tgz` with lifecycle scripts enabled after the same validation.

Do not publish it to npm automatically in PR 10.

---

# 9. Dependency audit policy

Add two committed evidence artifacts under PR 10:

```text
docs/CRIP/PR-10/dependency-audit.json
docs/CRIP/PR-10/dependency-audit.md
```

The JSON is the raw `npm audit --json` snapshot used for the implementation handoff. The Markdown file is the human triage.

## 9.1 Required triage fields

For every advisory/finding record:

```text
advisory/package
severity
direct or transitive
dependency path(s)
dev/build/runtime scope
bundled into released JS? yes/no
executed during release build? yes/no
known reachability in TokenMaxxer
non-breaking remediation available?
action taken
residual risk if retained
```

## 9.2 Release policy

Requirements:

1. first attempt normal compatible upgrades and lockfile refresh;
2. do not use `npm audit fix --force` blindly;
3. preserve the OpenCode minimum-host dev pin unless deliberately tested and justified;
4. rerun full PR 1–9 regression after every dependency cluster update;
5. full-tree `npm audit --audit-level=high` must pass before Ship — **no unresolved high or critical advisories**;
6. `npm audit --omit=dev --audit-level=low` must pass for shipped production dependency scope;
7. any remaining low/moderate dev-only findings must be explicitly triaged in `dependency-audit.md` with upgrade path/rationale;
8. if a high/critical finding has no acceptable remediation without violating a shipped invariant, Luna records a blocker and stops rather than waiving it silently.

A changing advisory database may alter counts after implementation; the gate is severity/policy based, not “must equal the planning-time count.”

---

# 10. CI hardening

Refactor `.github/workflows/ci.yml` so release validation is reusable and not duplicated inconsistently.

At minimum CI on every push/PR must run:

```text
clean install
full tests
typecheck
host contract
audit release gate
build
exact dist inventory/self-containment
TUI bundle check
CLI bundle/launcher check
CLI smoke
installer/launcher shell syntax
npm package allow-list
release staging dry-run
release-set checksum verification
installer transactional fixture suite
same-commit reproducible-build check
git diff --check
assert no tracked dist files
```

CI must not mutate releases.

If time cost makes double-build reproducibility too expensive for every ordinary unit-test iteration, it may be one separate required CI job rather than a local default test. It is still mandatory on the exact final PR-10 CI head and every release tag.

## 10.1 Workflow security

- pin all external actions by full SHA;
- keep minimal permissions;
- `persist-credentials: false` where Git writes are not needed;
- no pull-request workflow may receive release write permissions;
- no untrusted PR input is interpolated into shell release commands;
- release job accepts identity from GitHub tag context and validated `package.json`, not arbitrary workflow-dispatch text.

---

# 11. Documentation refresh

Update `README.md` and add a dedicated release operator guide, e.g.:

```text
docs/RELEASING.md
```

## 11.1 README must describe shipped semantics

Required corrections include:

- compaction default = **augment OpenCode native compaction**;
- explicit replace mode = `TOKENMAXXER_COMPACTION_MODE=replace`;
- legacy `TOKENMAXXER_NO_PROMPT` compatibility meaning is documented as legacy, not the primary interface;
- durable context is sanitized/data-only and independently capped;
- STATE has an 8,192-byte hard budget;
- LLM durable authority is decisions-only with transcript evidence;
- `recall_promote` requests human review and cannot mint `human-reviewed` trust itself;
- human promotion/supersession occurs through the interactive CLI;
- accurate file activity wording from PR 9;
- `last_compaction_prompt.log` = prompt/input diagnostic;
- `last_compaction_result.json` = successful host completion metadata;
- `.commit-pulse` remains TUI successful-STATE-commit telemetry;
- supported OpenCode peer range `>=1.18.15 <2.0.0`;
- release installer uses immutable GitHub release assets, not mutable `main`;
- `dist/` is generated, not tracked;
- release verification instructions include `SHA256SUMS` and GitHub immutable-release verification;
- current tool names/count generated from or checked against production registration where practical.

Do not preserve stale claims merely for backward documentation compatibility.

## 11.2 RELEASING.md operator procedure

Document exactly:

1. prerequisite: immutable releases enabled;
2. PR/main CI must be green;
3. package version change is reviewed normally before tagging;
4. tag must be `v${package.version}`;
5. create an annotated tag on the exact main commit;
6. push only that tag;
7. release workflow reruns the full release gate;
8. workflow builds/stages draft assets and publishes only after verification;
9. verify final release:
   - `gh release verify <tag>`
   - `gh release verify-asset <tag> <downloaded-file>`
   - `sha256sum -c SHA256SUMS` (or platform equivalent);
10. never move/reuse a published release tag;
11. fixes ship as a new version/tag, never by replacing an immutable asset.

---

# 12. Proposed production/support files

Likely additions/changes:

```text
.github/workflows/ci.yml
.github/workflows/release.yml
.gitignore
.node-version
.bun-version
package.json
package-lock.json
install.sh
bin/tokenmaxxer
README.md
docs/RELEASING.md

scripts/verify-dist.mjs
scripts/verify-reproducible-build.mjs
scripts/verify-package.mjs
scripts/release-preflight.mjs
scripts/stage-release.mjs
scripts/verify-release-set.mjs
scripts/audit-release.mjs

# focused tests
test/release/dist-contract.test.ts
test/release/package-contract.test.ts
test/release/release-manifest.test.ts
test/release/installer-integrity.test.ts
test/release/workflow-contract.test.ts
test/release/dependency-policy.test.ts
```

Names may be adjusted to current repository naming conventions, but the semantic responsibilities must remain distinct.

---

# 13. Luna/subagent execution plan

Use **nine waves**. Luna owns integration and final decisions; subagents get non-overlapping file ownership.

## Wave 1 — Freeze release contracts with tests only

Use three parallel test-only agents.

### Agent 1A — dist/package/reproducibility contracts

Own only new tests/fixtures under `test/release/` for:

- generated-only dist authority;
- exact expected dist inventory;
- self-contained bundles;
- clean-checkout pack content;
- package allow-list;
- same-commit double-build hash equality;
- release manifest/version/commit shape.

No production/script edits.

### Agent 1B — installer integrity/transaction contracts

Own only installer release-fixture tests:

- exact-tag URL pinning;
- checksum success/failure;
- modified payload refusal;
- prior-install preservation;
- all-or-rollback replacement;
- receipt/version reporting;
- no `main` payload fetches;
- no mixed-release payloads.

No `install.sh` production edits.

### Agent 1C — workflow/dependency/documentation contracts

Own only tests/fixtures for:

- action SHA pinning;
- CI/release permissions/triggers;
- tag/package identity validation;
- release workflow cannot run from an ordinary main push;
- dependency policy parser/triage schema;
- stale release URL/doc assertions that should disappear.

No workflow/package/docs production edits.

### Luna Wave-1 gate

- inspect every test;
- reject tests that merely grep implementation details when a behavioral fixture is possible;
- run the whole new release test slice and record expected failures;
- `npx tsc --noEmit` must still pass aside from intentionally unresolved test imports only if the repository's test strategy permits them;
- append Wave-1 evidence to `docs/CRIP/PR-10/blockers.md`.

## Wave 2 — Dependency remediation and build-tool pinning

One dependency agent owns only:

```text
package.json
package-lock.json
.node-version
.bun-version
docs/CRIP/PR-10/dependency-audit.{json,md}
```

Tasks:

1. capture fresh `npm audit --json`;
2. classify current findings;
3. upgrade compatible tooling/dependencies deliberately;
4. target zero high/critical findings;
5. pin build-manager/tool versions needed for reproducibility;
6. preserve OpenCode 1.18.15 minimum host verification;
7. run full suite after each dependency cluster.

Luna reviews package-lock diff rather than accepting “audit clean” as proof.

Do not edit workflows in this wave.

## Wave 3 — Generated-only dist + package contract

One build/package agent owns:

```text
.gitignore
package.json build/package scripts
scripts/verify-dist.mjs
scripts/verify-reproducible-build.mjs
scripts/verify-package.mjs
tracked dist deletions
```

Tasks:

- remove every tracked `dist/**` file;
- retain `dist/` ignore;
- centralize exact dist validation in reusable script;
- add reproducible-build verifier;
- add clean package verifier;
- ensure CLI dist is always generated;
- ensure package dry-run contains the intended exact set.

Do not edit installer or workflows.

## Wave 4 — Release manifest/staging/checksum machinery

One release-build agent owns:

```text
scripts/release-preflight.mjs
scripts/stage-release.mjs
scripts/verify-release-set.mjs
release-focused fixtures
```

Tasks:

- exact tag/version/commit validation;
- deterministic `RELEASE.json`;
- exact artifact copy/rename;
- deterministic `SHA256SUMS`;
- npm tarball inclusion;
- release-set allow-list;
- staged installer rendering with exact immutable identity;
- no timestamps/random release content.

No GitHub release API calls in unit tests.

## Wave 5 — Transactional installer + visible version

One installer agent owns only:

```text
install.sh
bin/tokenmaxxer
installer test fixtures
```

Tasks:

- exact-tag release URLs;
- stage-all-before-mutation;
- checksum parser/verification;
- Linux/macOS SHA-256 command support;
- destination-side temp files;
- backup/rollback;
- receipt write;
- `tokenmaxxer version`;
- remove mutable-main and unverified npm reinstall claims;
- preserve existing TUI/package-json configuration behavior unless correctness requires a bounded fix.

Luna must run the installer tests against isolated temporary HOME directories and verify the real destination tree after both success and injected failures.

## Wave 6 — CI and tag-release workflows

One workflow agent owns only:

```text
.github/workflows/ci.yml
.github/workflows/release.yml
scripts/audit-release.mjs (if not already owned in Wave 2)
workflow-contract tests
```

Tasks:

- update/pin actions to exact reviewed SHAs;
- remove Node-action deprecation path;
- pin Node/Bun release versions;
- add dependency gate;
- add dist/package/reproducibility/release-dry-run gates to CI;
- add tag-only release job with minimal write permission;
- immutable-release preflight;
- draft-first asset upload;
- verify-before-publish;
- final release attestation check.

No release tag is pushed.

## Wave 7 — Documentation truth pass

One documentation agent owns only:

```text
README.md
docs/RELEASING.md
other user-facing release docs explicitly identified by Luna
```

Before editing, inspect current production registration/config/CLI instead of copying old README language.

Update all known stale PR-3/6/7/8/9 semantics and release instructions.

Do not alter production code.

## Wave 8 — Adversarial integration and full CRIP regression

Luna may delegate non-overlapping audit slices, but integration fixes are Luna-controlled.

Required attacks include:

- clean clone/no dist → build/package/release dry-run succeeds;
- two consecutive clean builds produce identical dist hashes;
- exact release stage generated twice from same tag+commit has identical bytes/checksums;
- wrong tag vs package version fails;
- wrong/malformed commit fails;
- installer tamper before replace leaves prior install untouched;
- installer missing CLI refuses entire install;
- installer cannot fetch `main` after start;
- release staging cannot omit CLI;
- package cannot omit CLI;
- checksum manifest duplicate/traversal/unknown line rejected;
- receipt reflects exact staged commit;
- launcher version reads receipt truthfully;
- PR 1–9 full test suite remains green;
- TUI bundle/commit-pulse remains unchanged;
- minimum host fixture remains 1.18.15;
- read-only/global memory behavior unaffected;
- compaction augment/replace tests unaffected;
- npm audit policy passes.

## Wave 9 — Luna release audit and Oracle handoff

Luna alone:

1. inspect the final integrated diff;
2. confirm no tagged release was accidentally created;
3. run the complete exact-head release chain;
4. push the exact implementation head;
5. verify GitHub CI on that exact production/test/workflow tree;
6. record exact passed/skipped counts;
7. record exact audit counts and disposition;
8. record exact action SHAs;
9. map every semantic release-matrix case below to evidence;
10. create `docs/CRIP/PR-10/oracle-investigation.md` as evidence only;
11. stop for independent Oracle review.

Luna does **not** issue the final CRIP Ship verdict and does not create the first real release tag.

---

# 14. Semantic release matrix

Minimum **100 cases**. More are allowed; do not reduce this matrix by combining materially different failure modes.

## A. Dist authority / build reproducibility — 1–15

1. `git ls-files dist/**` returns empty.
2. clean checkout starts without required generated dist files.
3. `npm run build` creates all six expected dist files.
4. no unexpected generated dist file exists.
5. index bundle non-empty.
6. TUI bundle non-empty.
7. CLI bundle non-empty.
8. no generated relative chunk import in index bundle.
9. no generated relative chunk import in TUI bundle.
10. no generated relative chunk import in CLI bundle.
11. build A and build B index hashes identical.
12. build A/B TUI hashes identical.
13. build A/B CLI hashes identical.
14. declaration outputs are deterministic or explicitly excluded from release-binary reproducibility with documented package behavior.
15. reproducibility verifier fails on one deliberately changed output byte.

## B. Package contract — 16–27

16. clean build + package dry-run succeeds.
17. package includes index.js.
18. package includes tui.js.
19. package includes cli.js.
20. package includes matching declarations.
21. package includes launcher.
22. package includes README/LICENSE/package metadata.
23. package excludes source tree.
24. package excludes tests.
25. package excludes CRIP/debug artifacts.
26. package excludes `.release/` and memory files.
27. package verifier fails if CLI output is absent.

## C. Release identity / manifest — 28–40

28. tag exactly matches package version.
29. mismatched tag fails.
30. malformed SemVer tag fails.
31. exact 40-lowercase-hex commit accepted.
32. short commit fails.
33. non-hex commit fails.
34. `RELEASE.json` schema version exact.
35. release manifest version/tag/commit exact.
36. manifest host peer/minimum exact.
37. manifest builder tool versions exact.
38. manifest artifact allow-list exact.
39. same tag+commit staging twice yields byte-identical RELEASE.json.
40. release stage contains no generated timestamp/random identity.

## D. Checksums / staged release set — 41–54

41. exact expected release filenames present.
42. server release filename maps to current dist index.
43. TUI release filename maps to current dist TUI.
44. CLI release filename maps to current dist CLI.
45. launcher release filename maps to reviewed launcher.
46. npm tarball present.
47. staged installer has all release placeholders rendered.
48. staged installer contains exact tag.
49. staged installer contains exact commit.
50. SHA256SUMS sorted deterministically.
51. every allowed asset except SHA256SUMS itself has one checksum line.
52. missing checksum fails verification.
53. duplicate checksum line fails verification.
54. unknown/path-traversal checksum filename fails verification.

## E. Installer download integrity — 55–68

55. valid staged release installs successfully.
56. modified server bundle refused.
57. modified TUI bundle refused.
58. modified CLI bundle refused.
59. modified launcher refused.
60. modified RELEASE.json refused.
61. missing CLI refuses entire install.
62. missing checksum manifest refuses entire install.
63. malformed digest refuses entire install.
64. no SHA-256 utility fails before destination changes.
65. curl path works in fixture.
66. wget fallback works or is explicitly tested/supported according to installer contract.
67. all payload URLs use one exact release tag.
68. no payload URL uses `raw.githubusercontent.com/.../main` or a second `latest` lookup.

## F. Installer transactional replacement — 69–80

69. successful install replaces all four executable targets.
70. launcher gets executable mode.
71. verification failure leaves existing server byte-identical.
72. verification failure leaves existing TUI byte-identical.
73. verification failure leaves existing CLI byte-identical.
74. verification failure leaves existing launcher byte-identical.
75. verification failure does not write/update receipt.
76. injected replacement failure rolls back already replaced targets.
77. first install with no prior targets leaves no partial install on injected commit failure.
78. success writes receipt atomically.
79. receipt version/tag/commit match staged installer.
80. staging temp data is cleaned on success and failure.

## G. Visible version / launcher truth — 81–87

81. `tokenmaxxer version` prints release receipt version.
82. prints exact tag.
83. prints exact 40-hex commit.
84. missing receipt never fabricates a commit.
85. malformed receipt fails or reports unavailable safely.
86. existing decisions/promote/supersede launcher routing remains unchanged.
87. launcher no longer claims an unverified npm release channel.

## H. Dependency policy — 88–94

88. fresh `npm audit --json` captured.
89. every finding appears in triage.
90. every triage row records direct/transitive and dependency path.
91. every row records dev/build/runtime and bundled status.
92. no unresolved high severity remains.
93. no unresolved critical severity remains.
94. production-scope `npm audit --omit=dev --audit-level=low` passes.

## I. Workflow / immutable release policy — 95–100

95. CI external actions are pinned to full commit SHAs.
96. release external actions are pinned to full commit SHAs.
97. release workflow cannot trigger from ordinary branch push/PR.
98. release workflow validates tag/package/commit before publication.
99. release workflow fails closed when immutable release status cannot be proven and uses draft-first publication.
100. main/PR CI runs the complete dry-run release validation without mutating GitHub Releases.

### Additional mandatory regression evidence outside the numbered 100

The release gate also requires the complete PR 1–9/TMTUI suite, minimum-host verification, build, package, installer shell syntax, CLI smoke, and `git diff --check`. These are not substitutes for any numbered case above.

---

# 15. Exact implementation-head release chain

Luna's final local/CI chain should include at least:

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
npm run release:dry-run
npm run release:verify
# focused installer fixture command if not included by npm test
git diff --check
# must print nothing
git ls-files 'dist/**'
```

If the CI workflow splits this across required jobs, all jobs must point to the same exact commit and all must be green.

Do not report “N tests passed” by adding expected skips to passed counts. Record passed/skipped separately as in prior CRIP gates.

---

# 16. Oracle handoff requirements

`docs/CRIP/PR-10/oracle-investigation.md` must record:

- planning baseline;
- initial and final implementation SHAs;
- every wave commit;
- exact `package.json` version;
- exact Node/npm/Bun release versions;
- exact pinned action SHAs and human-readable action tags;
- proof `dist/` is untracked;
- build A/B hash evidence;
- exact staged release filenames and SHA256SUMS;
- npm package dry-run/tarball contents;
- installer success/tamper/rollback evidence;
- dependency audit before/after counts;
- complete advisory triage location;
- exact GitHub CI run/job IDs and pass/skip counts;
- mapping for all 100 semantic cases;
- confirmation that **no real release tag/release was published during implementation**;
- any remaining low/moderate dependency findings with rationale;
- any deviation from the exact release architecture above.

Suggested Oracle attack surface:

1. stale/mixed release assets;
2. installer time-of-check/time-of-use and rollback behavior;
3. checksum-manifest parsing/traversal/duplicates;
4. tag/package/commit mismatch;
5. deterministic build/staging claims;
6. missing CLI/npm package files;
7. mutable workflow action refs or excessive permissions;
8. immutable-release preflight bypass;
9. dependency-audit classification/reachability claims;
10. stale README claims versus production;
11. semantic regression from dependency upgrades;
12. accidental publication before independent Ship.

The Oracle, not Luna, decides whether CRIP is complete.

---

# 17. Definition of done

PR 10 is complete only when:

- source code and lockfile, not committed `dist/`, are distribution authority;
- the exact release build is reproducible in the pinned release environment;
- one tag/version/commit identifies the entire staged artifact set;
- all release payloads have deterministic SHA-256 checksums;
- release workflow publishes draft-first into immutable GitHub Releases;
- installer pins all payloads to its one embedded release tag;
- installer verifies all payloads before changing the current installation;
- failed verification preserves the prior installation;
- installed version/tag/commit is visible and truthful;
- npm package contents are explicit and complete;
- high/critical dependency audit findings are eliminated;
- remaining dependency findings, if any, are fully triaged;
- CI/release Actions are pinned and no longer rely on the deprecated Node-20 action generation;
- README/release docs match the actual PR 1–9 implementation;
- the full CRIP regression suite is green on the exact final implementation tree;
- Luna publishes evidence and stops without creating the real release tag.

Only after independent Oracle **Ship** should the first real immutable TokenMaxxer release tag be pushed.
