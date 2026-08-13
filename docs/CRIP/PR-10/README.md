# CRIP PR 10 — Reproducible Release and Dependency Hygiene

**Status:** **Complete — Ship**

PR 10 is the final CRIP workstream. It removes ambiguous committed-`dist/` release authority, creates one tag/version/commit release identity, defines a checksum-verified immutable GitHub Release artifact set, makes installation transactional and revision-pinned, exposes installed release identity, hardens CI/release workflows, triages/remediates dependency findings, and refreshes stale user/release documentation.

## Release invariant

> **Every installed TokenMaxxer release must be traceable to one immutable Git tag and source commit; every downloaded executable file must come from that same release and verify against its checksum manifest before any existing installation is replaced; release builds must be generated from source by a pinned toolchain rather than trusted from mutable committed `dist/`; package and dependency contents must be auditable; and release/documentation claims must describe the implementation that actually shipped in PRs 1–9.**

## Planning baseline

`ab81ee51f693357048b7320fbf264a7350331c2c`

## Final implementation and validation

- final independently reviewed head: `ca4e11f440494aae8b8ba02ce33ba72acd315a3a`;
- final GitHub CI run: `31650370812`, job `94293174237`;
- exact CI suite: **80 passed test files + 1 skipped; 1333 passed tests + 1 skipped**;
- focused release/installer/workflow gate: **129/129 passed**;
- production `install.sh` E2E includes checksum validation, curl/wget, `sha256sum`/`shasum`, tamper refusal, rollback, and first-install cleanup;
- `dist/**` has zero tracked files;
- full-tree audit: 5 low, 0 moderate, 0 high, 0 critical; production-scope audit: zero vulnerabilities;
- no real tag or GitHub Release was created before the independent Ship verdict.

Final Oracle verdict: [`oracle-second-final-rereview.md`](./oracle-second-final-rereview.md) — **Ship**.

## Post-Ship release hotfix — Complete — Ship

The first real `v0.1.0` release attempt exposed one lifecycle-only release validation defect after the Ship verdict: implementation-era tests and dry-run preflight still assumed that the repository must contain zero `v*` tags. Once `v0.1.0` legitimately existed, the tag workflow passed immutable-release and exact-tag preflight but failed the full suite before staging or draft creation.

The lifecycle hotfix removes ambient zero-tag authority from perpetual validation. Ordinary CI and dry-run validation now tolerate historical release tags, while real publication mode validates only the requested tag's exact target plus `origin/main` ancestry and retains non-dry-run HEAD authenticity.

Hotfix implementation:

```text
c5b2cd2f0bcc56ad41ac2b9b4f335019990f75b9
```

Exact implementation CI:

```text
run 31660513870
job 94324172875
81 passed test files + 1 skipped
1351 passed tests + 1 skipped
33/33 focused lifecycle + identity tests
```

Independent hotfix verdict: [`post-ship-release-tag-hotfix-oracle-final.md`](./post-ship-release-tag-hotfix-oracle-final.md) — **Ship**.

CRIP remains **Complete — Ship, 10/10**; this was a narrowly scoped post-Ship release-hygiene correction, not a reopened reliability workstream.

## Canonical artifacts

- [`implementation-plan.md`](./implementation-plan.md) — concrete nine-wave implementation plan, generated-only dist strategy, immutable release contract, transactional installer, dependency policy, pinned workflow actions, documentation truth pass, 100-case semantic release matrix, Luna/subagent ownership, and Oracle attack surface.
- [`post-ship-release-tag-hotfix-plan.md`](./post-ship-release-tag-hotfix-plan.md) — lifecycle-correct tag/preflight hotfix plan discovered during first real release execution.
- [`post-ship-release-tag-hotfix-investigation.md`](./post-ship-release-tag-hotfix-investigation.md) — Luna hotfix implementation evidence and H1–H30 mapping.
- [`post-ship-release-tag-hotfix-oracle-final.md`](./post-ship-release-tag-hotfix-oracle-final.md) — independent final hotfix **Ship** verdict.
- [`blockers.md`](./blockers.md) — append-only implementation/decision log.
- [`dependency-audit.json`](./dependency-audit.json) — implementation-head npm audit snapshot.
- [`dependency-audit.md`](./dependency-audit.md) — advisory triage and disposition.
- [`oracle-investigation.md`](./oracle-investigation.md) — Luna implementation evidence.
- [`oracle-findings.md`](./oracle-findings.md) — initial independent Block findings.
- [`oracle-rereview.md`](./oracle-rereview.md), [`oracle-final-rereview.md`](./oracle-final-rereview.md), [`oracle-second-rereview.md`](./oracle-second-rereview.md) — remediation evidence/reviews.
- [`oracle-second-final-rereview.md`](./oracle-second-final-rereview.md) — final independent **Ship** verdict.
- [`../post-crip-adversarial-review.md`](../post-crip-adversarial-review.md) — post-program audit covering the first real release plus all original CRIP assessment findings.

## Shipped distribution strategy

```text
source + lockfile
      ↓ pinned Node/npm/Bun build
 generated dist/
      ↓ validate / reproduce
 release staging + npm pack
      ↓
 immutable GitHub Release
```

`dist/` is generated only and is not committed release authority.

## Immutable release set

```text
tokenmaxxer.js
tokenmaxxer-tui.js
tokenmaxxer-cli.js
tokenmaxxer
tokenmaxxer.d.ts
tokenmaxxer-tui.d.ts
tokenmaxxer-cli.d.ts
install.sh
RELEASE.json
tokenmaxxer-<version>.tgz
SHA256SUMS
```

One `package.json` version, `v<version>` tag, and exact 40-hex source commit identify the entire set.

The release installer may be fetched through GitHub's latest-release asset redirect, but once executing it pins all payload downloads to its embedded exact tag and verifies them before modifying an existing installation.

## First immutable release — v0.1.0

The first published release now exists and is immutable:

```text
release: v0.1.0
source:  c5b2cd2f0bcc56ad41ac2b9b4f335019990f75b9
tag object: 62c2da8c112e7a4f6b84163a0fac2d49662f8580
release workflow: 31662898531
```

The workflow successfully completed immutable-release preflight, exact tag/version/commit validation, the full release validation chain, staging, draft creation, asset upload, pre-publish inventory/checksum verification, and publication. GitHub currently reports the release as `immutable: true`, and GitHub's release attestation exists and binds the `v0.1.0` release/tag plus the published asset digests.

The workflow itself concluded red only at the final immediate `gh release verify` step: the attestation was not yet queryable in the sub-second interval immediately after publication, but became available afterward. The post-CRIP adversarial review records this as release-gate reliability finding **A8**, not a release-integrity failure. Future release workflows should poll/retry post-publish attestation verification instead of assuming zero propagation delay.

A separate earlier tag attempt also exposed a nondeterministic TMTUI commit-pulse test race; that is recorded as **A7** in the post-CRIP review.

Do not delete, recreate, retag, or republish `v0.1.0`: it is now the immutable first release. Future workflow hardening applies to subsequent versions.

## Scope preserved

PR 10 preserves all shipped PR 1–9 semantics, including:

- authoritative local/global STATE and cross-process transactions;
- decision/human-review trust boundary;
- OpenCode `>=1.18.15 <2.0.0` host contract;
- source completion/idempotency;
- decisions-only LLM durable authority;
- augment-by-default compaction and anti-drift;
- 8,192-byte STATE / 4,096-byte injection budgets;
- durable PR-9 diagnostics;
- TMTUI `.commit-pulse` = successful STATE commit only.

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
