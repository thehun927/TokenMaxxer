# CRIP PR 4 — OpenCode Host Contract

**Status:** Implementation complete — release-gate review pending

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

## Implementation summary

Implementation shipped in waves 1-8 (commit range `5a8758b..fabeb34`):

- Wave 1: failing regression fixtures (src/host/contract.ts, tsconfig.host-contract.json, test/host-contract/*, test/host/contract.test.ts, test/tools/bounds.test.ts, extensions to test/tools/efficiency.test.ts, test/tools/recall.test.ts, test/memory/llm-adapter.test.ts, test/memory/writer-llm.test.ts, test/index.test.ts, test/host/package-meta.test.ts)
- Wave 2: dependency injection (registerEfficiencyTools(client), no more (context as any).client)
- Wave 3: bounded tool schemas + output truncation (src/tools/bounds.ts, head_files formatter)
- Wave 4: full version runtime gating (isSupportedHostVersion from src/host/contract)
- Wave 5: graceful degradation through real writer (verification only — implementation was already correct)
- Wave 6: clean host mocks (tool-map merge in src/index.ts, satisfies PluginInput fixtures)
- Wave 7: peer range + CI integration (verify-host-contract script, package.json + lockfile)
- Wave 8: repository-wide host-boundary audit + oracle investigation brief

Final CI signal: 37 files / 478 tests pass; tsc --noEmit clean; npm run verify:host-contract OK; npm run build produces dist/cli.js; 50 release-gate cases covered.

Pre-release-gate oracle investigation: [oracle-investigation.md](./oracle-investigation.md).

Program authority: [`../implementation-plan.md`](../implementation-plan.md).
