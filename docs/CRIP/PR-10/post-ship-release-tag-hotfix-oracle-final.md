# PR-10 Post-Ship Release Tag Hotfix — Independent Oracle Final Review

**Verdict: Ship**

## Reviewed identity

- Plan/index baseline: `499fa01e856593c266e22a3de9fe9f50c0eeb409`
- Hotfix implementation: `c5b2cd2f0bcc56ad41ac2b9b4f335019990f75b9`
- Handoff/evidence main: `451673bf7617eea36ff795fddd3bdd537e4e4828`
- Exact implementation CI: run `31660513870`, job `94324172875`
- Historical pre-hotfix release run: `31651601925` — not final release evidence

`c5b2cd2... -> 451673b...` changes only `docs/CRIP/PR-10/post-ship-release-tag-hotfix-investigation.md`; the production/test tree reviewed here is therefore exactly `c5b2cd2...`.

## Scope review

The hotfix changes exactly:

```text
scripts/release-preflight.mjs
test/release/workflow/release-identity.test.ts
test/release/workflow/release-tag-lifecycle.test.ts
```

No `src/**`, installer, launcher, package metadata, lockfile, dependency version, workflow, release asset inventory, checksum format, or immutable-release authentication code changed.

## Root cause and resolution

The failed first real `v0.1.0` publication exposed an implementation-era invariant that had escaped into perpetual executable policy: the repository was required to contain zero `v*` tags. Once the legitimate post-Ship `v0.1.0` tag existed, `npm test` and dry-run preflight failed even though the real tag publication preflight had already proved the exact tag/commit relation.

The hotfix correctly makes validation lifecycle-aware:

- ambient historical release tags are no longer release authority;
- default/dry-run validation checks proposed release identity without requiring an empty tag namespace;
- publication mode (`--require-main-ancestor`) resolves only the requested tag, requires that it targets the exact supplied commit, and requires the commit to be reachable from `origin/main`;
- non-dry-run validation still requires the supplied commit to equal checkout `HEAD`;
- tag/version, commit format, OpenCode peer/minimum host, and optional manifest identity validation remain intact.

This supports normal repositories containing prior release history and does not special-case `v0.1.0`.

## Adversarial lifecycle coverage

The new lifecycle suite uses disposable Git repositories with real Git objects and this topology:

```text
main A
  |
main B  <- origin/main

v0.0.9 -> A
v0.1.0 -> B

orphan C
v0.2.0 -> C
```

The suite verifies:

- dry-run succeeds with one or multiple historical release tags;
- exact requested annotated tag succeeds in publication mode;
- older unrelated tags do not affect requested-tag validation;
- missing requested tag fails;
- wrong requested-tag target fails;
- unmerged/orphan commit fails ancestry;
- wrong tag/version, malformed/short/uppercase commit, and changed host contract fail;
- dry-run does not mutate tags;
- non-dry-run HEAD mismatch fails closed;
- the real TokenMaxxer checkout is not used as a tag-mutation fixture.

Focused lifecycle + identity result: **33/33 passed**.

## Exact CI verification

GitHub run `31660513870` is `success` and checked out exact head:

```text
c5b2cd2f0bcc56ad41ac2b9b4f335019990f75b9
```

All workflow steps passed, including:

- clean install;
- full semantic suite;
- TypeScript typecheck;
- minimum-host contract;
- full release dependency gate;
- distribution build and exact inventory;
- TUI/CLI bundle checks and CLI smoke;
- npm package allow-list;
- shell syntax;
- reproducible-build proof;
- release dry-run;
- actual staging + release verification;
- production installer E2E and release/workflow contracts;
- `git diff --check` and fail-closed zero-tracked-`dist/**` assertion.

Exact full-suite counts from CI:

```text
Test files: 81 passed + 1 skipped = 82 total
Tests:      1351 passed + 1 skipped = 1352 total
```

The focused CI installer + installer-E2E + workflow block reports **147/147 passed**. The handoff's `1,352 tests passed` wording counts the expected skip in the total; this is bookkeeping only and not a functional defect.

The dependency gate remains:

```text
full tree:       5 low, 0 moderate, 0 high, 0 critical
production tree: 0 vulnerabilities
```

## Release-path review

`.github/workflows/release.yml` remains unchanged from the independently shipped PR-10 workflow. The real publication path invokes:

```text
release-preflight.mjs --tag <github.ref_name> --commit <github.sha> --require-main-ancestor
```

It does **not** combine publication mode with `--dry-run`. After preflight it reruns the complete release validation chain before staging, then stages/verifies assets, creates a draft, verifies uploaded inventory/checksums, publishes the draft, and immediately verifies the immutable release attestation.

A caller can technically provide both `--dry-run` and `--require-main-ancestor`, which would retain requested-tag/ancestry validation while skipping HEAD authenticity. No production workflow does this, and it is outside the defect/remediation acceptance boundary. Treat mutual-exclusion hardening as a non-blocking future cleanup, not a release blocker.

## Tag/release safety boundary

At review time:

- `v0.1.0` is still the original annotated tag object `5b0e313c746066538a9e56043bc5e625f639cde6`;
- it still resolves to `ca4e11f440494aae8b8ba02ce33ba72acd315a3a`;
- no GitHub Release or draft exists;
- no release mutation occurred during hotfix implementation or Oracle review.

## Final verdict

**Ship.**

The post-Ship lifecycle defect is closed. The validated release code/tree is `c5b2cd2f0bcc56ad41ac2b9b4f335019990f75b9`.

Operationally, because no GitHub Release has ever been published for `v0.1.0`, the next step is to recreate/retarget the still-unpublished annotated `v0.1.0` tag onto `c5b2cd2...`, push that corrected tag, and treat the resulting **new tag-push release workflow** as the first-release evidence. Do not reuse historical run `31651601925` as final evidence.
