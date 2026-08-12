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

## Canonical artifacts

- [`implementation-plan.md`](./implementation-plan.md) — concrete nine-wave implementation plan, generated-only dist strategy, immutable release contract, transactional installer, dependency policy, pinned workflow actions, documentation truth pass, 100-case semantic release matrix, Luna/subagent ownership, and Oracle attack surface.
- [`blockers.md`](./blockers.md) — append-only implementation/decision log.
- [`dependency-audit.json`](./dependency-audit.json) — implementation-head npm audit snapshot.
- [`dependency-audit.md`](./dependency-audit.md) — advisory triage and disposition.
- [`oracle-investigation.md`](./oracle-investigation.md) — Luna implementation evidence.
- [`oracle-findings.md`](./oracle-findings.md) — initial independent Block findings.
- [`oracle-rereview.md`](./oracle-rereview.md), [`oracle-final-rereview.md`](./oracle-final-rereview.md), [`oracle-second-rereview.md`](./oracle-second-rereview.md) — remediation evidence/reviews.
- [`oracle-second-final-rereview.md`](./oracle-second-final-rereview.md) — final independent **Ship** verdict.

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

## Release boundary after Ship

Implementation and Oracle review intentionally created no real `v*` tag and no GitHub Release. With the independent Ship verdict recorded, the maintainer may now follow [`../../RELEASING.md`](../../RELEASING.md) to create the first real annotated release tag and allow the tag-only workflow to publish the immutable release.

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
