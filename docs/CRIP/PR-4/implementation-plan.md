# PR 4 Implementation Plan — OpenCode Host Contract

> **Program:** Concrete Reliability Implementation Plan (CRIP)  
> **Workstream:** PR 4 — OpenCode host contract  
> **Status:** Ready for implementation  
> **Implementation baseline:** `f708574c543034468c8547342a9178c9a6269c67` (`main`)  
> **Production-code baseline:** `666be8ee033ff257d9e60d9f41c83527399c7052` (PR 3 Wave 10)  
> **Depends on:** PR 1, PR 2, PR 3 — all Ship  
> **Resolves:** G3, N1, N3, model-callable tool argument bounds  
> **Program authority:** `docs/CRIP/implementation-plan.md`

---

## 1. Executive summary

PR 4 makes TokenMaxxer's OpenCode boundary explicit, typed, versioned, and fail-safe.

The current implementation contains one confirmed host-contract violation: efficiency-tool wrappers read `(context as any).client`, but the verified OpenCode `ToolContext` does not contain a client. The legitimate SDK client is supplied once to the plugin initializer and must be injected into registered tools by closure.

PR 4 also tightens TokenMaxxer's declared OpenCode compatibility from an unproven `>=1.0.0 <2.0.0` claim to the contract actually verified by this repository, bounds all model-callable efficiency/recall arguments, and makes the supported structured-output host gate compare the full version contract rather than only major/minor numbers.

The target boundary is:

```text
OpenCode plugin initialization
        │
        ├── legitimate PluginInput.client ──────────────┐
        │                                               │
        ├── hooks / event handlers                      │
        │                                               │
        └── registerEfficiencyTools(client)             │
                    │                                   │
                    └── registered execute(args, ToolContext)
                              │                         │
                              ├── directory/worktree    │
                              │   from ToolContext      │
                              │                         │
                              └── host API calls ───────┘
```

Never:

```text
ToolContext -> (context as any).client
```

Structured extraction remains optional:

```text
host contract accepted
    -> structured extraction may run

host contract rejected / unhealthy / malformed
    -> no audit-session creation
    -> no structured prompt
    -> heuristic memory continues normally
```

---

## 2. Verified host baseline

### 2.1 Supported baseline

The release baseline for this PR is:

```text
@opencode-ai/plugin 1.18.15
peer contract: >=1.18.15 <2.0.0
```

The repository already pins the development dependency to exactly `1.18.15`; only the peer claim is currently wider.

Do **not** lower the minimum during PR 4 merely because an individual endpoint appears in an older release. A lower minimum is valid only after the same contract matrix in this plan passes against that older package/host contract.

### 2.2 Exact v1.18.15 plugin contract verified for this plan

Against the upstream `v1.18.15` source:

- `PluginInput` contains the SDK `client`, `directory`, and `worktree`;
- `ToolContext` contains `directory` and `worktree`, but **does not contain `client`**;
- the generated file API exposes `client.file.read(...)`;
- `file.read` accepts a query containing `path` and optional `directory`;
- the v1.18.15 generated `session.prompt` declaration does not describe the structured-output `format` request field;
- the v1.18.15 host implementation does support the structured JSON-schema request/result contract used by TokenMaxxer.

Therefore:

1. efficiency tools must use the initializer client by closure;
2. `head_files` should remain on the OpenCode file API rather than introducing a raw filesystem read path;
3. the deliberate structured-output casts stay isolated in `src/memory/llm-adapter.ts` rather than spreading SDK-response casts through the codebase.

The current upstream development `ToolContext` still does not expose `client`, which supports the same dependency-injection design, but the release contract for this PR is the frozen `1.18.15` baseline above.

---

## 3. Hard invariants

PR 4 is complete only when all of these hold:

1. **No production tool reads a client from `ToolContext`.**
2. **Every host client used by a registered tool originates from `PluginInput.client`.**
3. **Tool invocation routing uses the invocation's own `directory` / `worktree`, not a stale initialization directory.**
4. **`head_files` continues to use OpenCode's file API; PR 4 does not create an unrestricted raw-fs model tool.**
5. **The declared OpenCode peer range exactly matches the minimum contract TokenMaxxer tests.**
6. **The minimum supported plugin package is compiled in CI as a first-class contract, not inferred from permissive mocks.**
7. **Tests do not invent host fields that are absent from the supported SDK types.**
8. **Structured-output runtime gating compares the complete supported version boundary, including patch and major version.**
9. **Failure of the optional structured-output host contract never disables heuristic memory persistence.**
10. **A rejected host gate never creates an audit session or sends a structured prompt.**
11. **All model-callable string/count arguments are bounded at schema validation.**
12. **`head_files` model-visible output is deterministically bounded even when a host file contains an extremely long line.**
13. **The intentional structured-output wire-contract casts remain centralized in `llm-adapter.ts`.**
14. **PR 4 does not change PR 1 storage authority, PR 2 transaction semantics, or PR 3 decision-trust semantics.**

---

## 4. Expected files

### New

- `src/host/contract.ts`
- `src/tools/bounds.ts`
- `test/host-contract/typecheck.ts`
- `tsconfig.host-contract.json`
- optionally `scripts/verify-host-contract.mjs` if a small cross-file/package assertion script is cleaner than inline CI shell
- `docs/CRIP/PR-4/blockers.md` when implementation begins

### Modified

- `src/tools/efficiency.ts`
- `src/tools/recall.ts`
- `src/index.ts`
- `src/memory/llm-adapter.ts`
- `package.json`
- `package-lock.json`
- `.github/workflows/ci.yml`
- `test/tools/efficiency.test.ts`
- `test/tools/recall.test.ts`
- `test/memory/llm-adapter.test.ts`
- `test/memory/writer-llm.test.ts` or another writer integration test file
- `test/index.test.ts`

Do not create a new transport abstraction for every OpenCode endpoint. PR 4 should centralize the **contract**, not rewrite the SDK.

---

# Part A — Type the host boundary

## 5. Add `src/host/contract.ts`

Create one narrow source module for the parts of the OpenCode contract TokenMaxxer owns.

Conceptual shape:

```ts
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"

export type HostClient = PluginInput["client"]
export type HostToolContext = ToolContext
export type HostProjectContext = Pick<HostToolContext, "directory" | "worktree">

export const MIN_SUPPORTED_OPENCODE_VERSION = "1.18.15"
export const VERIFIED_HOST_CONTRACT_VERSION = "1.18.15"
export const OPENCODE_PLUGIN_PEER_RANGE = ">=1.18.15 <2.0.0"
```

### Why use `PluginInput["client"]`

Do not duplicate the generated SDK client interface for normal host API calls. `PluginInput["client"]` keeps `head_files` coupled to the actual supported client surface and makes SDK drift a compile-time event.

The narrow `V1ClientLike` / casts inside `llm-adapter.ts` are different: they intentionally bridge a verified wire contract that the generated v1.18.15 declaration does not fully describe. Keep that exception local.

## 5.1 Full version comparison

Move the supported-version comparison into the host-contract module.

Use a small strict parser rather than adding a semver dependency solely for this check.

Suggested public shape:

```ts
export type ParsedHostVersion = {
  major: number
  minor: number
  patch: number
}

export function parseHostVersion(value: string): ParsedHostVersion | null
export function isSupportedHostVersion(value: string): boolean
```

Required policy for PR 4:

```text
1.18.14     -> false
1.18.15     -> true
1.18.16     -> true
1.19.0      -> true
1.999.0     -> true
2.0.0       -> false
0.x         -> false
malformed   -> false
prerelease  -> false unless explicitly added to the supported matrix later
```

Build metadata on an otherwise stable version may be accepted if the parser handles it deliberately; prerelease acceptance must not happen accidentally.

Use safe integers and bounded input before parsing.

---

# Part B — Fix efficiency-tool dependency injection

## 6. Change registration to close over the initializer client

Current:

```ts
registerEfficiencyTools()
```

Target:

```ts
registerEfficiencyTools(client: HostClient)
```

In `src/index.ts`:

```ts
...registerEfficiencyTools(client),
```

The tool runtime still supplies the normal `ToolContext` to `execute`; the client comes from the registration closure.

## 6.1 Remove client from helper context types

Prefer:

```ts
export async function _previewCompaction(
  args: Record<string, never>,
  context: HostProjectContext,
  client: HostClient,
): Promise<string>

export async function _headFiles(
  args: HeadFilesArgs,
  context: HostProjectContext,
  client: HostClient,
): Promise<string>
```

Then wrapper code is straightforward:

```ts
async execute(args, context) {
  return _headFiles(args, context, client)
}
```

No:

```ts
(context as any).client
```

No helper context type should claim that a ToolContext contains a client.

## 6.2 Route file reads using the invocation directory

Use the closure client, but preserve the **current invocation's** routing:

```ts
await client.file.read({
  query: {
    path,
    directory: context.directory,
  },
})
```

This matters when one plugin process services different invocation directories. The captured client is stable; the request directory is not.

Do not substitute:

- `process.cwd()`;
- plugin-initialization directory captured in the closure;
- direct `readFile()` from Node;
- a path joined manually to the worktree before handing it to the host API.

The host file API remains the access-policy boundary.

## 6.3 Update tool descriptions

`head_files` currently describes paths as relative to the worktree. Align its description with the host behavior actually used by the implementation: paths are routed through OpenCode using the current tool invocation directory.

Avoid promising path semantics TokenMaxxer itself does not enforce.

---

# Part C — Bound every model-callable argument

## 7. Add `src/tools/bounds.ts`

Keep the values named and shared so tests pin the intended contract.

Recommended initial limits:

```ts
export const TOOL_LIMITS = {
  recallQueryChars: 256,
  recallLimitMax: 25,
  decisionIdChars: 256,
  decisionTopicChars: 256,
  headPathCountMax: 16,
  headPathChars: 1024,
  headLinesMax: 200,
  headLineChars: 2_000,
  headFileOutputChars: 16_384,
  headTotalOutputChars: 65_536,
} as const
```

`decisionIdChars` should stay aligned with the persistence-side `MAX_IDENTIFIER`; either import that constant or add a test that prevents drift.

These are **tool-call / tool-response** limits. They do not replace PR 8's durable-storage and compaction-injection byte budgets.

## 7.1 Recall bounds

Target schemas:

```ts
query: tool.schema
  .string()
  .max(TOOL_LIMITS.recallQueryChars)
  .optional()

limit: tool.schema
  .number()
  .int()
  .min(1)
  .max(TOOL_LIMITS.recallLimitMax)
  .default(10)
```

Do not silently coerce `0`, negative values, fractions, `Infinity`, or oversized counts.

## 7.2 Review-request bounds

```ts
decision_id: tool.schema
  .string()
  .min(1)
  .max(MAX_IDENTIFIER)
  .optional()

topic: tool.schema
  .string()
  .min(1)
  .max(TOOL_LIMITS.decisionTopicChars)
  .optional()
```

The runtime exact-one-selector rule remains in `_recallPromote`; schema bounds do not replace PR 3 authority checks.

## 7.3 `head_files` bounds

Target:

```ts
paths: tool.schema
  .array(
    tool.schema
      .string()
      .min(1)
      .max(TOOL_LIMITS.headPathChars),
  )
  .min(1)
  .max(TOOL_LIMITS.headPathCountMax)

lines: tool.schema
  .number()
  .int()
  .min(1)
  .max(TOOL_LIMITS.headLinesMax)
  .default(40)
```

Reject malformed values at the tool schema boundary rather than accepting them and hoping slicing behaves safely.

## 7.4 Bound `head_files` output

The host file endpoint may return the entire requested file. Even with `lines <= 200`, one line can be arbitrarily large.

Before returning text to the model:

1. retain at most `headLinesMax` requested lines;
2. bound each visible line to `headLineChars`;
3. bound each formatted file section to `headFileOutputChars`;
4. bound the complete response to `headTotalOutputChars`;
5. add deterministic markers when truncation occurs.

Example markers:

```text
...(line truncated)
...(file output truncated)
...(head_files output truncated)
```

Do not include hidden tail content in error strings or diagnostics.

This is not intended to solve memory use inside the host SDK; it guarantees the model-visible tool result is bounded.

---

# Part D — Make the structured host gate match the declared contract

## 8. Refactor `llm-adapter.ts` to use the shared contract

Today the adapter has:

```ts
VERIFIED_HOST_CONTRACT_VERSION = "1.18.15"
MINIMUM_HOST_CONTRACT = "1.18"
```

and compares only major/minor.

Replace that split definition with the shared PR 4 contract so install-time and runtime claims cannot silently diverge.

When `global.health` is present:

```text
healthy=true + supported stable 1.x version -> allow
healthy=false                         -> reject
version < 1.18.15                     -> reject
version >= 2.0.0                      -> reject
malformed version/health envelope     -> reject
health request failure                -> reject
```

## 8.1 Keep the v1.18.15 pinned-compatibility path

The exact v1.18.15 generated client does not expose `global.health`.

Therefore this existing behavior remains intentional:

```text
health endpoint unavailable
    -> allow structured extraction under pinned compatibility
```

Do **not** change missing `global.health` to automatic rejection; that would make the declared minimum contract disable itself.

Document the limitation precisely:

- the peer dependency + pinned minimum SDK are the install/package compatibility contract;
- when the runtime exposes a health/version surface, TokenMaxxer additionally enforces it;
- when that surface is absent on the verified minimum client, TokenMaxxer relies on the verified pinned contract rather than pretending it has runtime version proof.

Do not add an initialization-time network probe solely to discover a version.

## 8.2 Keep structured-output casts isolated

Do not replace the adapter's intentional request/response casts with `any` elsewhere.

The contract remains:

```text
normal host APIs
  -> generated PluginInput["client"] types

v1.18.15 structured-output declaration gap
  -> narrow compatibility casts in llm-adapter.ts only
```

A repository search at Definition of Done should show no new structured-response envelope inspection outside this adapter.

---

# Part E — Prove structured-host failure degrades only the optional layer

## 9. Preserve the idle lifecycle

The current writer already persists heuristics before the optional LLM path. PR 4 must preserve that ordering:

```text
fetch transcript
    ↓
heuristic extraction
    ↓
LOCK -> persist heuristic memory -> UNLOCK
    ↓
optional cache/model work
    ↓
structured host gate
    ├── rejected -> heuristic-only
    └── allowed  -> optional audit/prompt flow
```

The unsupported-host regression must exercise the real writer boundary, not just `getHostStructuredContractGate()` in isolation.

## 9.1 Required unsupported-host integration behavior

With `TOKENMAXXER_LLM_EXTRACT=1` and a runtime health response below the minimum, e.g. `1.18.14`:

- transcript messages are read;
- heuristic facts are committed;
- `writeMemoryOnIdle()` returns the existing nonfatal heuristic fallback outcome;
- STATE retains the heuristic facts;
- `session.create` for the retained audit is never called;
- `session.prompt` is never called;
- no human/LLM trust is minted;
- no stale fallback full-state write is attempted.

Model/config lookup done solely to check a previously accepted cache may remain before the final prompt gate if it does not create an audit or prompt. PR 4 does not need to redesign cache identity/lifecycle; PR 5 owns source idempotency and truthful outcome semantics.

---

# Part F — Replace permissive mocks with a real host contract check

## 10. Add a dedicated compile-time host fixture

The repository's normal `tsconfig.json` excludes `test/`, so Vitest mocks alone cannot prove compatibility with the host's actual TypeScript contract.

Add:

```text
test/host-contract/typecheck.ts
tsconfig.host-contract.json
```

`tsconfig.host-contract.json` should extend the production config, set `noEmit`, and include the contract fixture plus the production modules it imports.

The fixture imports real types from the exact installed minimum package:

```ts
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
```

It should compile examples that prove:

1. `registerEfficiencyTools` accepts `PluginInput["client"]`;
2. a real `ToolContext` object does not need a client;
3. registered `head_files` / `preview_compaction` wrappers accept the supported `ToolContext` shape;
4. `directory` and `worktree` are taken from `ToolContext`;
5. no production helper signature requires an invented `client` property on `ToolContext`.

A useful type-level assertion is:

```ts
type Assert<T extends true> = T
type Equal<A, B> = ...
type ToolContextHasNoClient = Assert<
  Equal<Extract<keyof ToolContext, "client">, never>
>
```

If a future host legitimately adds `client`, this assertion will force an explicit contract review rather than silently changing TokenMaxxer's dependency model.

## 10.1 Runtime ToolContext fixture

Efficiency-tool runtime tests should invoke the registered wrapper with an object matching the supported `ToolContext` fields, for example:

```ts
const context: ToolContext = {
  sessionID: "session-1",
  messageID: "message-1",
  agent: "build",
  directory: "/workspace/project",
  worktree: "/workspace/project",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
}
```

No `client` field.

The client stub is passed to `registerEfficiencyTools(client)` separately.

## 10.2 Audit existing host mocks

`test/index.test.ts` currently invents client members such as `app.info` and casts the whole plugin input through `never`.

PR 4 should replace such mocks with a shared typed factory or `satisfies`-based fixture representing only actual minimum-contract fields needed by the test.

Narrow explicit test stubs are acceptable when constructing the entire generated SDK client is impractical, but invented host fields are not.

Avoid broad `as any` / `as never` at the exact boundary PR 4 is meant to verify.

---

# Part G — Make the peer contract executable in CI

## 11. Tighten package metadata

Update both `package.json` and lockfile root metadata:

```json
"peerDependencies": {
  "@opencode-ai/plugin": ">=1.18.15 <2.0.0"
}
```

Keep:

```json
"devDependencies": {
  "@opencode-ai/plugin": "1.18.15"
}
```

Do not use `^1.18.15` for the minimum-contract dev dependency. CI must compile against the actual floor, not whatever later 1.x npm resolves today.

## 11.1 Add host-contract verification script

Add a script such as:

```json
"typecheck:host-contract": "tsc -p tsconfig.host-contract.json --noEmit",
"verify:host-contract": "node scripts/verify-host-contract.mjs && npm run typecheck:host-contract"
```

The verification script should fail if:

- the OpenCode peer range is not exactly the approved range;
- the dev dependency is not exactly the approved minimum;
- the installed `node_modules/@opencode-ai/plugin` version is not exactly the dev minimum;
- the TypeScript host-contract fixture fails.

If implemented without a script, the same assertions may live directly in CI, but one reusable local command is preferred.

## 11.2 CI order

Extend the existing `verify` job:

```text
npm ci
npm test
npx tsc --noEmit
npm run verify:host-contract
npm run build
bundle checks
CLI checks
```

The minimum-host contract check should run before build so host drift fails early.

An additional non-blocking/latest-host compatibility job may be added later, but it must not replace compilation against the exact minimum package.

---

# Part H — Detailed implementation sequence

## Step 1 — Freeze the host contract in tests first

Before changing production code:

1. add `src/host/contract.ts` constants/types;
2. add `tsconfig.host-contract.json` and compile fixture;
3. add failing wrapper tests that use a real `ToolContext` with no client;
4. add peer/dev-version assertion tests or script;
5. add full-version gate tests (`1.18.14`, `1.18.15`, `2.0.0`).

Expected initial failures:

- efficiency registration requires `context.client` at runtime;
- host-contract fixture exposes the mock/context mismatch;
- peer range still claims `>=1.0.0`;
- `1.18.14` incorrectly passes the existing major/minor-only gate.

## Step 2 — Fix dependency injection

1. make `registerEfficiencyTools(client)` required;
2. pass `client` from `TokenmaxxerPlugin`;
3. remove `client` from helper context types;
4. remove `(context as any).client`;
5. pass `context.directory` to `client.file.read`.

Run runtime wrapper tests and host-contract typecheck before touching the LLM gate.

## Step 3 — Add tool schemas and output bounds

1. add shared tool-bound constants;
2. bound recall query/limit;
3. bound review request ID/topic;
4. bound head path array/path length/line count;
5. implement deterministic model-visible output truncation;
6. add exact boundary tests (`max` succeeds, `max+1` rejects).

## Step 4 — Align runtime version gating

1. move version constants/parser to host contract module;
2. compare major/minor/patch and enforce `<2.0.0`;
3. retain `health-surface-unavailable -> pinned-compatibility` for the verified 1.18.15 minimum;
4. retain process caching;
5. keep all structured-output casts in `llm-adapter.ts`.

## Step 5 — Prove graceful degradation through the real writer

Add a writer integration test with:

```text
LLM feature flag enabled
host health version 1.18.14
normal transcript
```

Assert heuristic STATE is committed and structured audit/prompt calls remain zero.

Also test malformed/unhealthy host cases at the adapter level; one full writer-level unsupported-version case is sufficient unless implementation changes reveal different branches.

## Step 6 — Clean host mocks

Audit at minimum:

- `test/index.test.ts`
- `test/tools/efficiency.test.ts`
- `test/memory/llm-adapter.test.ts`
- any newly touched plugin/tool tests.

Remove invented `ToolContext.client`, invented client endpoints, and broad casts used only to hide an invalid host shape.

Do not turn this into a whole-test-suite typing rewrite unrelated to host-facing code.

## Step 7 — Tighten package range and CI

1. set peer range to `>=1.18.15 <2.0.0`;
2. keep dev dependency exactly `1.18.15`;
3. update lockfile;
4. add `verify:host-contract`;
5. wire it into CI;
6. run full tests/build/smokes.

## Step 8 — Repository-wide boundary audit

Before declaring implementation complete, search for:

```text
context as any
context.client
ToolContext & { client
client: any
@opencode-ai/plugin peer range
VERIFIED_HOST_CONTRACT_VERSION
MINIMUM_HOST_CONTRACT
session.prompt response envelope inspection
```

Expected:

- no production tool obtains client from ToolContext;
- no efficiency helper uses `client: any`;
- one canonical minimum host version;
- structured-response compatibility casts remain only in the adapter;
- package metadata and test baseline agree.

---

# 12. Release-gate test matrix

The following are the **minimum** PR 4 tests. Number them in implementation notes so the oracle review can trace each item.

## A. Client ownership / ToolContext — High priority

1. `head_files` registered wrapper succeeds with an actual minimum-contract `ToolContext` that has no `client`.
2. `head_files` uses the client passed to `registerEfficiencyTools(client)`.
3. `preview_compaction` uses the same captured initializer client.
4. `head_files` sends `context.directory` in the host `file.read` query.
5. Two invocations using one captured client but different `context.directory` values route to their respective invocation directories.
6. No call falls back to an initialization directory or `process.cwd()`.
7. Host file read error remains a bounded per-file result rather than throwing the entire tool call.

## B. Model-callable argument bounds

8. recall query length exactly 256 is accepted.
9. recall query length 257 is rejected by schema.
10. recall limit `1` and `25` are accepted.
11. recall limits `0`, `26`, negative, and fractional are rejected.
12. review-request decision ID exactly `MAX_IDENTIFIER` is accepted; `MAX_IDENTIFIER + 1` is rejected.
13. review-request topic at its max is accepted; max+1 is rejected.
14. `head_files` accepts 1 and 16 paths.
15. `head_files` rejects zero paths and 17 paths.
16. path max length is accepted; max+1 is rejected.
17. head lines `1` and `200` are accepted.
18. head lines `0`, `201`, negative, and fractional are rejected.

## C. `head_files` output bounds

19. normal multi-line file output is unchanged below limits.
20. a single extremely long line is truncated with the deterministic line marker.
21. one file section cannot exceed the per-file output cap.
22. multiple files cannot exceed the total output cap.
23. output truncation never appends hidden tail text after the marker.

## D. Host version / structured gate

24. health reports `1.18.14` -> rejected as `unsupported-version`.
25. health reports `1.18.15` -> accepted.
26. health reports a later stable `1.x` -> accepted.
27. health reports `2.0.0` -> rejected.
28. malformed version -> rejected.
29. prerelease version -> rejected under the initial policy.
30. `healthy !== true` -> rejected.
31. malformed health envelope -> rejected.
32. health request throws -> rejected.
33. health surface absent -> accepted as `pinned-compatibility` for the verified minimum contract.
34. gate result is process-cached as before.

## E. Graceful degradation

35. with LLM enabled and health version `1.18.14`, `writeMemoryOnIdle` still commits heuristic memory.
36. the same unsupported-host run creates no retained audit session.
37. the same unsupported-host run sends no structured prompt.
38. no LLM/human-reviewed decision provenance is minted from the skipped optional path.
39. a supported host follows the existing optional structured-extraction path unchanged.

## F. Minimum package / compile contract

40. package peer range is exactly `>=1.18.15 <2.0.0`.
41. dev dependency is exactly `1.18.15`.
42. CI-installed `@opencode-ai/plugin` is exactly `1.18.15` in the minimum-contract check.
43. `tsconfig.host-contract.json` compiles the real `PluginInput` / `ToolContext` fixture.
44. the fixture proves `ToolContext` does not need / expose a client under the supported baseline.
45. plugin initialization passes `PluginInput.client` into efficiency registration.
46. current host-facing test mocks do not invent `ToolContext.client`.

## G. Regression

47. all PR 1 storage-authority tests stay green.
48. all PR 2 child-process transaction/lock tests stay green.
49. all PR 3 authority/review/CLI tests stay green.
50. distribution build and existing CLI smoke remain green.

---

# 13. Failure semantics

PR 4 should not invent a broad new public outcome taxonomy; PR 5 owns truthful idle outcomes.

Use these rules:

### Efficiency tools

- schema-invalid call -> host/tool validation rejection;
- individual file API error -> bounded result for that file;
- missing captured host file surface should be treated as a bounded tool error, never fall back to raw fs;
- preview failure -> existing bounded error string behavior unless a typed tool-result redesign is independently justified.

### Structured host gate

- verified supported -> optional LLM path may continue;
- unhealthy / malformed / unsupported / health request failed -> optional extraction disabled;
- absent health surface on the pinned minimum contract -> allowed via explicit pinned-compatibility policy;
- never turn a host-gate failure into a failure of the already-committed heuristic memory layer.

---

# 14. Compatibility and migration

No STATE schema migration is expected in PR 4.

The externally visible compatibility change is package metadata:

```text
before: @opencode-ai/plugin >=1.0.0 <2.0.0
PR 4:   @opencode-ai/plugin >=1.18.15 <2.0.0
```

This is intentional. The old range claimed compatibility that had not been demonstrated and included host contracts lacking the boundary this code now tests.

Users on an older OpenCode plugin contract should receive the normal package-manager peer incompatibility signal rather than TokenMaxxer pretending that runtime behavior is supported.

No automatic fallback to a raw filesystem implementation is allowed to preserve older-host compatibility.

---

# 15. Security / trust boundary notes

PR 4 is not a sandboxing PR, but it tightens several trust boundaries:

- model calls cannot request unbounded file counts / line counts / recall counts;
- model-visible `head_files` output is bounded;
- host file access remains mediated by OpenCode;
- no model tool receives a hidden SDK client through an undeclared context field;
- malformed host health/version data fails closed for optional structured extraction;
- no runtime host incompatibility can mint stronger decision provenance merely because a cast succeeded.

Do not log:

- file contents;
- raw structured responses;
- prompts;
- secrets from SDK errors.

Existing bounded/sanitized adapter diagnostics remain the standard.

---

# 16. Explicit non-goals / out of scope

Do not pull later CRIP work into PR 4.

### PR 5

- immutable transcript/source processing identity;
- LLM cache idempotency redesign;
- truthful idle-stage outcomes;
- precise recall recency semantics.

### PR 6

- complete LLM evidence/trust boundary beyond host compatibility;
- deciding which extracted fact classes LLM may authoritatively contribute.

### PR 7

- host-native compaction augmentation vs replacement;
- anti-drift summary semantics;
- durable-memory prompt sanitization.

### PR 8

- hard STATE byte budget semantics;
- durable compaction-injection byte budget.

### PR 9

- module-global diagnostics/status cleanup;
- diagnostic artifact routing.

### PR 10

- immutable/checksummed installers and release artifacts;
- npm audit classification/remediation;
- general distribution parity policy.

Also out of scope:

- supporting OpenCode 2.x before its contract is reviewed;
- dynamically downloading another SDK at runtime;
- probing arbitrary undocumented host endpoints for version discovery;
- replacing OpenCode's file API with a raw filesystem tool;
- proving every historical OpenCode 1.x release compatible.

---

# 17. Oracle investigation checklist

The post-implementation oracle should attack these areas specifically.

## Client provenance

- Is every tool client traceable to the plugin initializer?
- Can any model-supplied/tool context object inject a fake client?
- Does a helper or test still rely on `(context as any).client`?
- Does `head_files` use the current invocation directory on every call?

## File API

- Is there any raw-fs fallback from `head_files`?
- Are error strings/output bounded?
- Can a long single line bypass the visible-output cap?

## Host contract

- Do package peer range, dev dependency, runtime gate, and contract tests all agree on `1.18.15`?
- Does `1.18.14` truly fail when version information is available?
- Does `2.0.0` truly fail?
- Is missing health intentionally/predictably handled for 1.18.15?
- Did the implementation accidentally remove the structured-output compatibility adapter even though the generated minimum SDK omits the request declaration?

## Tool schemas

- Are counts integers?
- Are every string/array/count model-callable inputs bounded?
- Do runtime inner helpers assume the schema ran, and can any internal use bypass create unbounded output?

## Graceful degradation

- Does an unsupported structured host still retain heuristic facts?
- Are audit/session/prompt calls really zero after rejection?
- Can cache/model discovery accidentally prompt before the gate?

## Tests

- Does CI compile against the exact minimum package rather than latest 1.x?
- Do runtime tests use a legitimate `ToolContext` shape?
- Are broad casts hiding host-contract errors?
- Is the host-contract compile fixture actually run by CI?

---

# 18. Definition of done

PR 4 is complete when all of the following are true:

- `registerEfficiencyTools` requires the plugin initializer's typed client;
- `src/index.ts` passes the legitimate client explicitly;
- no production code reads `context.client` from a ToolContext;
- `head_files` calls the host file API using the invocation directory;
- efficiency helper signatures contain no `client: any`;
- recall/decision/head tool schemas have explicit bounded inputs;
- `head_files` model-visible output is bounded;
- package peer range is `>=1.18.15 <2.0.0`;
- dev dependency remains exactly `1.18.15`;
- runtime structured-host gating enforces the full stable-version range when version data exists;
- the pinned no-health path remains explicitly supported for the verified minimum SDK;
- unsupported structured hosts leave heuristic memory operational and create no prompt/audit request;
- a dedicated host-contract TypeScript fixture compiles against `@opencode-ai/plugin@1.18.15` in CI;
- host-facing tests no longer invent `ToolContext.client` or unrelated SDK members to make mocks pass;
- structured-output compatibility casts remain centralized in `llm-adapter.ts`;
- all 50 release-gate cases above are covered directly or by an explicitly mapped existing regression test;
- all prior CRIP regression suites and build/CLI checks are green.

The concise release invariant is:

> **TokenMaxxer uses only declared OpenCode host surfaces, declares only compatibility it actually verifies, and degrades optional structured extraction without compromising durable heuristic memory.**
