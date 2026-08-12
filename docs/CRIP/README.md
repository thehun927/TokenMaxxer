# Concrete Reliability Implementation Plan (CRIP)

This directory is the canonical home for TokenMaxxer's **Concrete Reliability Implementation Plan** and every document generated while executing it.

## Program-level documents

- [`assessment.md`](./assessment.md) — independent codebase assessment that established the confirmed reliability findings.
- [`implementation-plan.md`](./implementation-plan.md) — canonical ten-PR Concrete Reliability Implementation Plan.

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
| PR 9 | Accurate diagnostics and artifact storage | **Implementation plan ready** | [`PR-9/`](./PR-9/) |
| PR 10 | Reproducible release and dependency hygiene | Planned | `PR-10/` |

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
