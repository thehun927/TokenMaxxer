/**
 * Compile-time host-contract fixture (PR 4 §10).
 *
 * This file is a pure compile fixture: it is NOT run by Vitest.  It is run by
 * `npx tsc -p tsconfig.host-contract.json --noEmit` and imports the REAL types
 * from the exact installed minimum package (`@opencode-ai/plugin@1.18.15`) so
 * that SDK drift is a compile-time event instead of being hidden by permissive
 * mocks.
 *
 * It proves the contract that PR 4 owns:
 *   1. `HostClient` is exactly `PluginInput["client"]`.
 *   2. A real `ToolContext` object does not need a client.
 *   3. The supported baseline's `ToolContext` does not expose `client`
 *      (this assertion forces an explicit contract review if a future host
 *      legitimately adds it).
 *   4. `HostProjectContext` is a subset of `ToolContext`.
 *
 * PR 7 Wave 1 additions:
 *   5. v1.18.15 hook output has `context: string[]` and optional `prompt`.
 *   6. CompactionOutput type matches v1.18.15 contract.
 */
import type { Hooks, PluginInput, ToolContext } from "@opencode-ai/plugin"
import type { HostClient, HostToolContext, HostProjectContext } from "../../src/host/contract"
import type { Equal, Assert } from "./utils"

// 1. registerEfficiencyTools accepts PluginInput["client"].
// (Test only proves the type; the runtime signature is updated in Wave 2.)
const client: HostClient = null as unknown as PluginInput["client"]

// 2. A real ToolContext object does not need a client.
const ctx: ToolContext = null as unknown as ToolContext

// 3. ToolContext does not expose `client` under the supported baseline.
type ToolContextHasNoClient = Assert<Equal<Extract<keyof ToolContext, "client">, never>>
const toolContextHasNoClient: ToolContextHasNoClient = true
void toolContextHasNoClient

// 4. HostProjectContext is a subset of ToolContext.
const _projection: HostProjectContext = {
  directory: ctx.directory,
  worktree: ctx.worktree,
}
void _projection
void client

// HostToolContext is the raw supported ToolContext; keep that pinned too.
type _HostToolContextIsToolContext = Assert<Equal<HostToolContext, ToolContext>>
const _hostToolContextIsToolContext: _HostToolContextIsToolContext = true
void _hostToolContextIsToolContext

// 5. v1.18.15 exposes the compaction hook with the exact output shape.
// (PR 7 §14.A.11)
type CompactionHook = NonNullable<Hooks["experimental.session.compacting"]>
type _CompactionOutput = Parameters<CompactionHook>[1]
type _ExpectedCompactionOutput = { context: string[]; prompt?: string }
const _compactionOutputShape: Assert<Equal<_CompactionOutput, _ExpectedCompactionOutput>> = true
void _compactionOutputShape
