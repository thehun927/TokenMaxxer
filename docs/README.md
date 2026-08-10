# TokenMaxxer Documentation

This directory contains the long-lived product documentation plus explicitly scoped implementation programs.

## Current documentation map

- [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) — implementation/reference documentation.
- [`PLAN.md`](./PLAN.md) — project planning/reference document.
- [`v1.1-plan.md`](./v1.1-plan.md) — version-specific planning document.
- [`CRIP/`](./CRIP/) — **Concrete Reliability Implementation Plan**, including its assessment, master implementation plan, and all PR-specific investigation/review artifacts.

## Earlier reliability planning

- [`reliability-plan.md`](./reliability-plan.md)
- [`improvement-program.md`](./improvement-program.md)

These predate the current CRIP execution sequence and are retained for historical context. They are not the canonical source for the active ten-PR reliability program.

## Documentation rule

All new documents produced as part of the Concrete Reliability Implementation Plan belong under `docs/CRIP/`. PR-specific plans, blocker logs, oracle investigations, findings, and re-reviews belong under `docs/CRIP/PR-N/`; do not add new CRIP artifacts directly to `docs/`.
