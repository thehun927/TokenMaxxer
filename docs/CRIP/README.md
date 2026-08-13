# Concrete Reliability Implementation Plan (CRIP)

This directory is the canonical home for TokenMaxxer's **Concrete Reliability Implementation Plan** and every document generated while executing it.

**Program status: Complete — 10/10 workstreams independently reviewed and shipped.**

## Program-level documents

- [`assessment.md`](./assessment.md) — independent codebase assessment that established the confirmed reliability findings.
- [`implementation-plan.md`](./implementation-plan.md) — canonical ten-PR Concrete Reliability Implementation Plan.
- [`post-crip-adversarial-review.md`](./post-crip-adversarial-review.md) — comprehensive post-program adversarial audit of the shipped codebase against every original assessment finding. CRIP remains 10/10 Complete — Ship; the audit identifies **0 Critical, 3 High, 6 Medium, and 2 Low/maintainability** residual or newly exposed hardening findings.

## PR status

| PR | Workstream | Status | Directory |
|---|---|---|---|
| PR 1 | Storage authority and read semantics | **Complete — Ship** | [`PR-1/`](./PR-1/) |
| PR 2 | Cross-process transactions | **Complete — Ship** | [`PR-2/`](./PR-2/) |
| PR 3 | Decision authority and promotion trust | **Complete — Ship** | [`PR-3/`](./PR-3/) |
| PR 4 | OpenCode host contract | **Complete — Ship** | [`PR-4/`](./PR-4/) |
| PR 5 | Source idempotency and truthful outcomes | **Complete — Ship** | [`PR-5/`](./PR-5/) |
| PR 6 | Complete LLM trust boundary | **Complete — Ship** | [`PR-6/`](./PR-6/) |
| PR 7 | Compaction quality and anti-drift | **Complete — Ship** | [`PR-7/`](./PR-7/) |
| PR 8 | Guaranteed storage and injection budgets | **Complete — Ship** | [`PR-8/`](./PR-8/) |
| PR 9 | Accurate diagnostics and artifact storage | **Complete — Ship** | [`PR-9/`](./PR-9/) |
| PR 10 | Reproducible release and dependency hygiene | **Complete — Ship** | [`PR-10/`](./PR-10/) |

The final PR-10 Oracle gate is recorded in [`PR-10/oracle-second-final-rereview.md`](./PR-10/oracle-second-final-rereview.md). The reviewed implementation head is `ca4e11f440494aae8b8ba02ce33ba72acd315a3a`; GitHub CI run `31650370812` passed on that exact tree. No release tag was created before the final Ship verdict.

PR 10 subsequently received the independently reviewed post-Ship release-tag lifecycle hotfix at `c5b2cd2f0bcc56ad41ac2b9b4f335019990f75b9`; see [`PR-10/post-ship-release-tag-hotfix-oracle-final.md`](./PR-10/post-ship-release-tag-hotfix-oracle-final.md). The first `v0.1.0` immutable release is operational evidence considered by the post-CRIP adversarial review.

## Post-program hardening boundary

The post-CRIP audit does **not** reopen or invalidate the ten completed workstreams. It distinguishes successful CRIP implementation from universal claims at newly attacked seams. Its three High findings are:

1. physical project path aliases can derive separate global namespaces/locks for one underlying repository;
2. automatic compaction does not yet consume the centralized decision-authority/trusted-foundation view;
3. the first heuristic source transaction can miss a completion marker inserted after its outer pre-read and return `cache-hit` after a durable mutation.

Those findings should be handled as a separately reviewed hardening tranche before describing the core invariants as universal across aliases, legacy states and adversarial cross-process source timing.

## PR directory convention

Each PR gets its own directory as soon as concrete planning starts. Use consistent names:

- `README.md` — status and artifact index for that PR.
- `implementation-plan.md` — concrete implementation plan when one exists.
- `blockers.md` — live implementation blocker/decision log when needed.
- `oracle-investigation.md` — independent review assignment/brief.
- `oracle-findings.md` — initial release-gate findings.
- `oracle-rereview.md`, `oracle-final-rereview.md`, etc. — subsequent gate reviews when required.

The master [`implementation-plan.md`](./implementation-plan.md) remains the authority for ordering, dependencies, and cross-PR invariants. A PR-specific implementation plan may refine its own workstream but should not silently change program-level invariants.

## Historical path note

The artifacts in `PR-1/` and `PR-2/` were originally written at the `docs/` root. Because they are review records, their prose may still mention the paths that existed when the review occurred (for example `docs/pr2-implementation-plan.md`). The directory structure and this index are now canonical; new CRIP documents should use `docs/CRIP/...` paths.
