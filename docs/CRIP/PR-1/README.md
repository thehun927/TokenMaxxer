# CRIP PR 1 — Storage Authority and Read Semantics

**Status:** Complete

PR 1 established authoritative local/global memory selection, typed missing/unavailable read semantics, monotonic revision freshness, non-git project identity, safer fallback persistence, and accurate storage status reporting.

## Review artifacts

- [`oracle-investigation.md`](./oracle-investigation.md) — independent release-gate assignment.
- [`oracle-findings.md`](./oracle-findings.md) — initial Block verdict and three storage-correctness blockers.

The initial implementation was reviewed at `8dee315`. The blocker fix landed at `34b2602`, after which the three release-gate findings were rechecked and cleared. No separate final re-review document was created for PR 1.

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
