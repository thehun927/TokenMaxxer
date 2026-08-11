# CRIP PR 4 — OpenCode Host Contract

**Status:** Complete — Ship

PR 4 makes TokenMaxxer's OpenCode integration boundary explicit and verifiable after PR 1 established authoritative storage, PR 2 established cross-process transactions, and PR 3 established trustworthy decision authority/human promotion semantics.

## Primary goals

- inject the legitimate plugin-initialization client into registered tools instead of reading an undeclared `ToolContext.client`;
- keep `head_files` on the OpenCode file API and route requests through the current invocation directory;
- tighten the declared OpenCode peer range to the verified `>=1.18.15 <2.0.0` contract;
- compile a dedicated host-contract fixture against the exact minimum package in CI;
- compare the full runtime host version boundary when health/version data exists;
- preserve the explicit pinned-compatibility path for the verified v1.18.15 SDK, whose generated client lacks the health surface;
- bound model-callable recall/review/head-file arguments and model-visible `head_files` output;
- prove unsupported structured-output hosts disable only optional LLM extraction while heuristic durable memory keeps working.

## Canonical artifacts

- [`implementation-plan.md`](./implementation-plan.md) — concrete implementation sequence, host contract, 50-case release-gate matrix, and oracle checklist.
- [`blockers.md`](./blockers.md) — append-only implementation decision/blocker log.
- [`oracle-investigation.md`](./oracle-investigation.md) — independent release-gate investigation brief.
- [`oracle-findings.md`](./oracle-findings.md) — initial oracle review; verdict **Block** with two focused blockers.
- [`oracle-final-rereview.md`](./oracle-final-rereview.md) — Wave 9 final re-review; verdict **Ship**.

## Verified baseline

**Repository planning baseline:** `f708574c543034468c8547342a9178c9a6269c67`  
**Production-code baseline:** `666be8ee033ff257d9e60d9f41c83527399c7052`  
**Final PR 4 implementation:** `c41e7d79c5c87d9f95df902d03a748f0047a9cc9`  
**Minimum OpenCode plugin package:** `@opencode-ai/plugin@1.18.15`

The plan was designed against the exact upstream v1.18.15 plugin/tool/file/structured-output contract rather than inferred from the repository's existing permissive mocks. In that baseline, the plugin initializer owns the client, `ToolContext` owns invocation context such as `directory`/`worktree` but not a client, and the generated structured-prompt typing is narrower than the verified v1.18.15 wire/server capability. The implementation preserves that intentional adapter boundary.

## Implementation summary

Implementation shipped in waves 1-9:

1. host-contract regression/type fixtures;
2. initializer-client dependency injection;
3. bounded tool schemas and `head_files` output;
4. full-version runtime host gating;
5. writer-level graceful-degradation verification;
6. host mock/tool-map cleanup;
7. peer metadata and minimum-host verification tooling;
8. repository-wide host-boundary audit;
9. oracle blocker fix: single bounded `head_files` output channel plus committed CI host-contract enforcement.

Final GitHub Actions run `31445696398` on `c41e7d7` is green: 485 tests passed + 1 expected pre-build skip, ordinary TypeScript typecheck, exact-minimum host-contract verification, distribution build, bundle checks, CLI bundle verification, post-build CLI smoke, and installer/launcher syntax validation all passed.

## Release invariant

> TokenMaxxer uses only declared OpenCode host surfaces, declares only compatibility it actually verifies, and degrades optional structured extraction without compromising durable heuristic memory.

**Oracle result:** Ship.

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
