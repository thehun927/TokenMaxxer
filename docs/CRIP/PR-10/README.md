# CRIP PR 10 — Reproducible Release and Dependency Hygiene

**Status:** **Implementation plan ready**

PR 10 is the final CRIP workstream. It removes ambiguous committed-`dist/` release authority, creates one tag/version/commit release identity, publishes a checksum-verified immutable GitHub Release artifact set, makes installation transactional and revision-pinned, exposes installed release identity, hardens CI/release workflows, triages/remediates dependency findings, and refreshes stale user/release documentation.

## Release invariant

> **Every installed TokenMaxxer release must be traceable to one immutable Git tag and source commit; every downloaded executable file must come from that same release and verify against its checksum manifest before any existing installation is replaced; release builds must be generated from source by a pinned toolchain rather than trusted from mutable committed `dist/`; package and dependency contents must be auditable; and release/documentation claims must describe the implementation that actually shipped in PRs 1–9.**

## Planning baseline

`ab81ee51f693357048b7320fbf264a7350331c2c`

At this baseline:

- PRs 1–9 are **Complete — Ship**;
- `dist/` is ignored but some generated files remain tracked;
- the raw installer downloads server/TUI/CLI/launcher independently from mutable `main`;
- tracked `dist/` does not contain the CLI artifact the installer names;
- there is no release workflow;
- the repository has no GitHub tags/releases;
- final PR-9 CI reported 9 dependency audit findings (4 low, 3 moderate, 1 high, 1 critical), to be regenerated and triaged during PR 10;
- current CI uses older mutable action tag references that emitted the Node-action runtime deprecation warning.

## Canonical artifacts

- [`implementation-plan.md`](./implementation-plan.md) — concrete nine-wave implementation plan, generated-only dist strategy, immutable release contract, transactional installer, dependency policy, pinned workflow actions, documentation truth pass, 100-case semantic release matrix, Luna/subagent ownership, and Oracle attack surface.
- `blockers.md` — append-only implementation/decision log once Luna starts.
- `dependency-audit.json` — raw implementation-head npm audit snapshot.
- `dependency-audit.md` — human advisory triage and disposition.
- `oracle-investigation.md` — Luna's implementation evidence after exact-head CI is green.
- `oracle-findings.md` / rereviews — independent Oracle release-gate records.

## Chosen distribution strategy

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

## Planned immutable release set

```text
tokenmaxxer.js
tokenmaxxer-tui.js
tokenmaxxer-cli.js
tokenmaxxer
install.sh
RELEASE.json
tokenmaxxer-<version>.tgz
SHA256SUMS
```

One `package.json` version, `v<version>` tag, and exact 40-hex source commit identify the entire set.

The release installer may be fetched through GitHub's latest-release asset redirect, but once executing it must pin **all** payload downloads to its embedded exact tag and verify them before modifying an existing installation.

## Implementation waves

1. freeze dist/package, installer, workflow/dependency/release contracts with three test-only agents;
2. remediate/triage dependencies and pin the build toolchain;
3. remove tracked dist authority and implement dist/package reproducibility verification;
4. implement deterministic release manifest/staging/checksum machinery;
5. implement transactional checksum-verifying installer and `tokenmaxxer version`;
6. harden CI and add tag-only draft-first immutable release workflow;
7. refresh README and add operator release documentation from current production semantics;
8. adversarial integration plus complete PR 1–9/TMTUI regression;
9. Luna runs the exact-head release audit, publishes `oracle-investigation.md`, and stops.

## Important release boundary

Luna and implementation subagents **must not create or push a real `v*` tag and must not publish the first real GitHub release** during PR-10 implementation.

The release workflow is exercised through dry-run staging, checksum, package, and installer fixtures on main/CI. The first real immutable release is created only after the independent Oracle issues **Ship** for PR 10.

## Scope preserved

PR 10 must preserve all shipped PR 1–9 semantics, including:

- authoritative local/global STATE and cross-process transactions;
- decision/human-review trust boundary;
- OpenCode `>=1.18.15 <2.0.0` host contract;
- source completion/idempotency;
- decisions-only LLM durable authority;
- augment-by-default compaction and anti-drift;
- 8,192-byte STATE / 4,096-byte injection budgets;
- durable PR-9 diagnostics;
- TMTUI `.commit-pulse` = successful STATE commit only.

Dependency upgrades are accepted only with the complete regression suite green.

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
