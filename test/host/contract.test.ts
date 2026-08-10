/**
 * Runtime tests for the PR 4 host-contract module (`src/host/contract.ts`).
 *
 * Mirrors the existing test style (vitest describe/it/expect).  The type-level
 * assertions at the bottom are compile-time-only (erased by esbuild); the
 * actual type verification for the fixture lives in
 * `test/host-contract/typecheck.ts`, which is compiled by
 * `tsconfig.host-contract.json`.
 */
import { describe, expect, it } from "vitest"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  isSupportedHostVersion,
  MIN_SUPPORTED_OPENCODE_VERSION,
  OPENCODE_PLUGIN_PEER_RANGE,
  parseHostVersion,
  VERIFIED_HOST_CONTRACT_VERSION,
  type HostClient,
  type HostProjectContext,
  type HostToolContext,
} from "../../src/host/contract"
import type { Equal, Assert } from "../host-contract/utils"

// Compile-time-only contract pinning (verified by tsconfig.host-contract.json).
type _HostClientMatchesPluginInput = Assert<
  Equal<HostClient, PluginInput["client"]>
>
type _HostProjectContextIsProjection = Assert<
  Equal<HostProjectContext, Pick<HostToolContext, "directory" | "worktree">>
>

describe("parseHostVersion", () => {
  it("parses valid stable versions into major/minor/patch tuples", () => {
    expect(parseHostVersion("1.18.15")).toEqual({ major: 1, minor: 18, patch: 15 })
    expect(parseHostVersion("1.18.16")).toEqual({ major: 1, minor: 18, patch: 16 })
    expect(parseHostVersion("1.19.0")).toEqual({ major: 1, minor: 19, patch: 0 })
    expect(parseHostVersion("1.999.0")).toEqual({ major: 1, minor: 999, patch: 0 })
    expect(parseHostVersion("2.0.0")).toEqual({ major: 2, minor: 0, patch: 0 })
    expect(parseHostVersion("0.18.15")).toEqual({ major: 0, minor: 18, patch: 15 })
  })

  it("rejects malformed version strings", () => {
    const malformed = [
      "",
      "abc",
      "1",
      "1.",
      "1.18",
      "1.18.",
      "1.18.15.1",
      "v1.18.15",
      "1.18.15 ",
      " 1.18.15",
      "1.18.15+",
    ]
    for (const value of malformed) {
      expect(parseHostVersion(value), JSON.stringify(value)).toBeNull()
    }
  })

  it("rejects prerelease versions unless explicitly opted in", () => {
    expect(parseHostVersion("1.18.15-rc.1")).toBeNull()
    expect(parseHostVersion("1.19.0-beta")).toBeNull()
  })

  it("rejects oversized input (> 64 chars)", () => {
    expect(parseHostVersion("1.18.15".padEnd(65, "0"))).toBeNull()
    expect(parseHostVersion(`1.18.15-${"x".repeat(60)}`)).toBeNull()
  })

  it("rejects non-string input (cast through unknown)", () => {
    expect(parseHostVersion(42 as unknown as string)).toBeNull()
    expect(parseHostVersion(null as unknown as string)).toBeNull()
    expect(parseHostVersion(undefined as unknown as string)).toBeNull()
    expect(parseHostVersion({} as unknown as string)).toBeNull()
  })

  it("rejects numeric components that are not safe integers", () => {
    // 10-digit components are outside the safe-integer guarantee the parser
    // commits to (each component is capped at 9 digits).
    expect(parseHostVersion("1234567890.1.1")).toBeNull()
  })
})

describe("isSupportedHostVersion", () => {
  it("implements the plan §5.1 truth table", () => {
    expect(isSupportedHostVersion("1.18.14")).toBe(false)
    expect(isSupportedHostVersion("1.18.15")).toBe(true)
    expect(isSupportedHostVersion("1.18.16")).toBe(true)
    expect(isSupportedHostVersion("1.19.0")).toBe(true)
    expect(isSupportedHostVersion("1.999.0")).toBe(true)
    expect(isSupportedHostVersion("2.0.0")).toBe(false)
    expect(isSupportedHostVersion("0.18.15")).toBe(false)
    expect(isSupportedHostVersion("0.999.999")).toBe(false)
  })

  it("rejects malformed, prerelease, and oversized versions", () => {
    expect(isSupportedHostVersion("")).toBe(false)
    expect(isSupportedHostVersion("abc")).toBe(false)
    expect(isSupportedHostVersion("1.18")).toBe(false)
    expect(isSupportedHostVersion("v1.18.15")).toBe(false)
    expect(isSupportedHostVersion("1.18.15-rc.1")).toBe(false)
    expect(isSupportedHostVersion("1.19.0-beta")).toBe(false)
    expect(isSupportedHostVersion("1.18.15".padEnd(65, "0"))).toBe(false)
    expect(isSupportedHostVersion(42 as unknown as string)).toBe(false)
  })
})

describe("version constants", () => {
  it("pins the verified minimum and declared peer range", () => {
    expect(MIN_SUPPORTED_OPENCODE_VERSION).toBe("1.18.15")
    expect(VERIFIED_HOST_CONTRACT_VERSION).toBe("1.18.15")
    expect(OPENCODE_PLUGIN_PEER_RANGE).toBe(">=1.18.15 <2.0.0")
  })
})

describe("host-context type exports", () => {
  it("HostClient is exactly PluginInput['client'] (type-level, pinned above)", () => {
    // The `Equal<HostClient, PluginInput["client"]>` assertion at module scope
    // is the compile-time proof; this runtime test documents it and exercises
    // the structural alias without inventing host fields.
    const client: HostClient = {} as PluginInput["client"]
    expect(typeof client).toBe("object")
  })

  it("HostToolContext-shaped object exposes directory/worktree and has no client field", () => {
    const context = {
      sessionID: "session-1",
      messageID: "message-1",
      agent: "build",
      directory: "/workspace/project",
      worktree: "/workspace/project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    } satisfies HostToolContext

    expect(context.directory).toBe("/workspace/project")
    expect(context.worktree).toBe("/workspace/project")
    expect("client" in context).toBe(false)
  })

  it("HostProjectContext is exactly the directory/worktree projection", () => {
    const project: HostProjectContext = {
      directory: "/workspace/project",
      worktree: "/workspace/project",
    }
    expect(project.directory).toBe("/workspace/project")
    expect(project.worktree).toBe("/workspace/project")
    // A projection type has no client field either.
    expect("client" in project).toBe(false)
  })
})
