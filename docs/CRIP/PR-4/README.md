# CRIP PR 4 — OpenCode Host Contract

**Status:** Implementation plan ready

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
- `blockers.md` — create/append during implementation for design decisions, scope deviations, blocked cases, and test updates.
- `oracle-investigation.md` — to be supplied after implementation is pushed for independent release-gate review.
- `oracle-findings.md` — independent findings after the investigation brief lands.

## Verified baseline

**Repository planning baseline:** `f708574c543034468c8547342a9178c9a6269c67`  
**Production-code baseline:** `666be8ee033ff257d9e60d9f41c83527399c7052`  
**Minimum OpenCode plugin package:** `@opencode-ai/plugin@1.18.15`

The plan was designed against the exact upstream v1.18.15 plugin/tool/file/structured-output contract rather than inferred from the repository's existing permissive mocks. In that baseline, the plugin initializer owns the client, `ToolContext` owns invocation context such as `directory`/`worktree` but not a client, and the generated structured-prompt typing is narrower than the verified v1.18.15 wire/server capability. The implementation plan preserves that intentional adapter boundary.

## Implementation order

1. freeze the host contract in types/tests;
2. close efficiency tools over `PluginInput.client`;
3. add bounded tool schemas/output;
4. align full-version runtime gating;
5. prove unsupported-host heuristic fallback through the real writer;
6. clean host-facing mocks;
7. tighten peer metadata and run the exact minimum contract in CI;
8. perform a repository-wide host-boundary audit.

## Release invariant

> TokenMaxxer uses only declared OpenCode host surfaces, declares only compatibility it actually verifies, and degrades optional structured extraction without compromising durable heuristic memory.

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
