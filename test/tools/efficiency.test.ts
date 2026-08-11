import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ToolContext } from "@opencode-ai/plugin"

vi.mock("../../src/compaction/durable", () => ({
  buildDurableBlock: vi.fn(),
}))

import { buildDurableBlock } from "../../src/compaction/durable"
import { TOOL_LIMITS, TOTAL_TRUNCATED_MARKER } from "../../src/tools/bounds"
import {
  _previewCompaction,
  _headFiles,
  registerEfficiencyTools,
} from "../../src/tools/efficiency"

/**
 * The v1.18.15 minimum-contract `ToolContext` shape (PR 4 §10.1): the
 * supported host passes NO client on the tool context — the SDK client is
 * injected by closure at registration.
 */
const toolContext: ToolContext = {
  sessionID: "session-1",
  messageID: "message-1",
  agent: "build",
  directory: "/workspace/project-a",
  worktree: "/workspace/project-a",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
}

function createMockClient(fileContent: Record<string, string | null>) {
  return {
    file: {
      read: vi.fn(
        async ({ query }: { query: { path: string } }) => {
          const content = fileContent[query.path]
          if (content === null) throw new Error("file not found")
          return { data: { content } }
        },
      ),
    },
  }
}

describe("_previewCompaction", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls buildDurableBlock and returns its result", async () => {
    vi.mocked(buildDurableBlock).mockResolvedValue(
      "Project: /test\nCurrent task: testing",
    )

    // Wave 2 signature: (args, HostProjectContext, HostClient) — the client is
    // a separate positional argument, not a property of the context.
    const result = await _previewCompaction(
      {},
      { worktree: "/test", directory: "/test" },
      null,
    )

    expect(result).toBe("Project: /test\nCurrent task: testing")
    expect(buildDurableBlock).toHaveBeenCalledWith({
      worktree: "/test",
      directory: "/test",
      client: null,
    })
  })

  it("catches errors and returns error string", async () => {
    vi.mocked(buildDurableBlock).mockRejectedValue(new Error("build failed"))

    const result = await _previewCompaction(
      {},
      { worktree: "/test", directory: "/test" },
      null,
    )

    expect(result).toContain("Error previewing compaction: Error: build failed")
  })
})

describe("_headFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("with valid paths: returns truncated content", async () => {
    const client = createMockClient({
      "src/index.ts":
        "import foo\nimport bar\nimport baz\nexport const x = 1\nexport const y = 2",
    })

    const result = await _headFiles(
      { paths: ["src/index.ts"], lines: 3 },
      { worktree: "/test", directory: "/test" },
      client,
    )

    expect(result).toContain("### src/index.ts")
    expect(result).toContain("import foo")
    expect(result).toContain("import bar")
    expect(result).toContain("import baz")
    expect(result).toContain("...(truncated)")
  })

  it("with file shorter than lines limit: no truncation marker", async () => {
    const client = createMockClient({
      "short.ts": "line1\nline2",
    })

    const result = await _headFiles(
      { paths: ["short.ts"], lines: 5 },
      { worktree: "/test", directory: "/test" },
      client,
    )

    expect(result).toContain("line1\nline2")
    expect(result).not.toContain("...(truncated)")
  })

  it("with empty file content: returns '(empty or not found)'", async () => {
    const client = createMockClient({
      "empty.ts": "",
    })

    const result = await _headFiles(
      { paths: ["empty.ts"], lines: 40 },
      { worktree: "/test", directory: "/test" },
      client,
    )

    expect(result).toContain("### empty.ts")
    expect(result).toContain("(empty or not found)")
  })

  it("with missing file (throws): returns '(error: ...)'", async () => {
    const client = createMockClient({
      "missing.ts": null,
    })

    const result = await _headFiles(
      { paths: ["missing.ts"], lines: 40 },
      { worktree: "/test", directory: "/test" },
      client,
    )

    expect(result).toContain("### missing.ts")
    expect(result).toContain("(error: ")
  })

  it("with multiple files: returns all results separated by double newline", async () => {
    const client = createMockClient({
      "a.ts": "content a",
      "b.ts": "content b",
    })

    const result = await _headFiles(
      { paths: ["a.ts", "b.ts"], lines: 40 },
      { worktree: "/test", directory: "/test" },
      client,
    )

    expect(result).toContain("### a.ts")
    expect(result).toContain("content a")
    expect(result).toContain("\n\n### b.ts")
    expect(result).toContain("content b")
  })

  it("only returns the first N lines", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`)
    const client = createMockClient({
      "big.ts": lines.join("\n"),
    })

    const result = await _headFiles(
      { paths: ["big.ts"], lines: 40 },
      { worktree: "/test", directory: "/test" },
      client,
    )

    const contentLines = result.split("\n").filter((l) => l.startsWith("line"))
    expect(contentLines).toHaveLength(40)
    expect(result).toContain("...(truncated)")
    // line39 should be in, line40 should not
    expect(result).toContain("line39")
    expect(result).not.toContain("line40")
  })
})

// ─── PR 4 §12 A — client ownership / ToolContext (Wave 2) ──────────────────
// These fixtures fail on the current production code: the efficiency helpers
// read `(context as any).client`, but the v1.18.15 `ToolContext` has no client.
// Wave 2 injects the initializer client by closure and routes file reads by the
// invocation directory; these tests then go green.
describe("PR 4 §12 A — client ownership / ToolContext", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** A fake SDK client whose file.read records every call. */
  function recordingClient(content = "line1\nline2\nline3") {
    const read = vi.fn(
      async ({ query }: { query: { path: string; directory?: string } }) => ({
        data: { content },
      }),
    )
    return { client: { file: { read } }, read }
  }

  it("1. head_files helper succeeds with a minimum-contract ToolContext that has no client", async () => {
    const { client, read } = recordingClient()
    // Planned Wave 2 signature: _headFiles(args, HostProjectContext, HostClient).
    // The current helper reads context.client; the cast documents the boundary.
    const result = await _headFiles(
      { paths: ["a.ts"], lines: 5 },
      toolContext as any,
      client as any,
    )
    expect(read).toHaveBeenCalled()
    expect(result).toContain("### a.ts")
    expect(result).toContain("line1")
    expect(result).not.toContain("(error: ")
  })

  it("2. head_files uses the client passed to registerEfficiencyTools(client)", async () => {
    const { client, read } = recordingClient()
    // Planned Wave 2 signature: registerEfficiencyTools(client: HostClient).
    // The current registration ignores the argument and reads context.client.
    const registered = registerEfficiencyTools(client as any)
    const result = await registered.tool.head_files.execute(
      { paths: ["a.ts"], lines: 5 },
      toolContext,
    )
    expect(read).toHaveBeenCalled()
    expect(result).toContain("line1")
  })

  it("3. preview_compaction uses the same captured initializer client", async () => {
    const capturedClient = { marker: "captured-initializer-client" }
    vi.mocked(buildDurableBlock).mockResolvedValue("durable ok")
    // Planned Wave 2 signature: registerEfficiencyTools(client: HostClient).
    // The current registration reads context.client (undefined here), so the
    // captured client never reaches buildDurableBlock.
    const registered = registerEfficiencyTools(capturedClient as any)
    await registered.tool.preview_compaction.execute({}, toolContext)
    expect(buildDurableBlock).toHaveBeenCalledWith(expect.objectContaining({
      client: capturedClient,
    }))
  })

  it("4. head_files sends context.directory in the host file.read query", async () => {
    const { client, read } = recordingClient()
    // Planned Wave 2 signature: _headFiles(args, HostProjectContext, HostClient).
    const result = await _headFiles(
      { paths: ["a.ts"], lines: 5 },
      toolContext as any,
      client as any,
    )
    expect(result).toContain("a.ts")
    expect(read).toHaveBeenCalledWith({
      query: { path: "a.ts", directory: toolContext.directory },
    })
  })

  it("5. two invocations route to their respective invocation directories", async () => {
    const { client, read } = recordingClient()
    const ctxA = { ...toolContext, directory: "/workspace/a", worktree: "/workspace/a" }
    const ctxB = { ...toolContext, directory: "/workspace/b", worktree: "/workspace/b" }
    // Planned Wave 2 signature: _headFiles(args, HostProjectContext, HostClient).
    await _headFiles({ paths: ["a.txt"], lines: 5 }, ctxA as any, client as any)
    await _headFiles({ paths: ["b.txt"], lines: 5 }, ctxB as any, client as any)
    const directories = read.mock.calls.map(
      ([args]) => (args as { query: { directory: string } }).query.directory,
    )
    expect(directories[0]).toBe("/workspace/a")
    expect(directories[1]).toBe("/workspace/b")
  })

  it("6. no call falls back to process.cwd()", async () => {
    const { client, read } = recordingClient()
    const ctxA = { ...toolContext, directory: "/workspace/x", worktree: "/workspace/x" }
    // Planned Wave 2 signature: _headFiles(args, HostProjectContext, HostClient).
    await _headFiles({ paths: ["x.txt"], lines: 5 }, ctxA as any, client as any)
    const directories = read.mock.calls.map(
      ([args]) => (args as { query: { directory: string } }).query.directory,
    )
    expect(directories.length).toBeGreaterThan(0)
    expect(directories.every((d) => d === "/workspace/x")).toBe(true)
    expect(directories.some((d) => d === process.cwd())).toBe(false)
  })

  it("7. host file read error remains a bounded per-file result", async () => {
    const read = vi.fn(async () => {
      throw new Error("host-read-boom")
    })
    const client = { file: { read } }
    // Planned Wave 2 signature: _headFiles(args, HostProjectContext, HostClient).
    // The cast documents the boundary; today the read never reaches the mock.
    const result = await _headFiles(
      { paths: ["missing.ts"], lines: 40 },
      toolContext as any,
      client as any,
    )
    expect(read).toHaveBeenCalled()
    expect(result).toContain("### missing.ts")
    expect(result).toContain("(error: ")
    expect(result).toContain("host-read-boom")
  })
})

// ─── Oracle wave-9 regression — Blocker 1: `_headFiles` total bound ─────────
// The oracle proved the previous composition appended empty/error notes AFTER
// formatHeadFilesOutput() had already enforced the total cap, so mixed
// success/error input and raw 100 KB host errors could exceed
// headTotalOutputChars and surface hidden tail text after the marker.
// These tests drive `_headFiles` end-to-end (not just the formatter) and pin
// the final model-visible string to the total cap across every outcome mix.
describe("oracle wave-9 — _headFiles total bound across success/empty/error", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** A client whose file.read always throws `makeError()`. */
  function errorClient(makeError: () => unknown) {
    const read = vi.fn(async () => {
      throw makeError()
    })
    return { client: { file: { read } }, read }
  }

  /** A client whose file.read returns ~13 KB for normal paths and throws for `bad.ts`. */
  function mixedSuccessErrorClient() {
    const read = vi.fn(
      async ({ query }: { query: { path: string } }) => {
        if (query.path === "bad.ts") throw new Error("boom")
        return { data: { content: ("v".repeat(100) + "\n").repeat(130) } }
      },
    )
    return { client: { file: { read } }, read }
  }

  it("1. single large host error remains bounded", async () => {
    const { client } = errorClient(() => new Error("x".repeat(100_000)))
    const result = await _headFiles(
      { paths: ["boom.ts"], lines: 40 },
      toolContext as any,
      client as any,
    )
    expect(result.length).toBeLessThanOrEqual(TOOL_LIMITS.headTotalOutputChars)
    // The raw 100 KB error must never surface, not even a 5000-char tail.
    expect(result).not.toContain("x".repeat(5000))
    expect(result).toContain("### boom.ts")
    expect(result).toContain("(error: Error: ")
    // The sanitized error section is tiny (<=256 chars) — far below any cap.
    expect(result.length).toBeLessThan(2000)
  })

  it("2. mixed success/error remains bounded with no content after the marker", async () => {
    // Six successful sections of 130 lines each (~13 KB per section) far exceed
    // the 64 KB total cap once `lines` keeps the whole file (schema max 200),
    // then the seventh path throws a normal short host error. The oracle's
    // deterministic reproduction 1.
    const paths = ["file-0.ts", "file-1.ts", "file-2.ts", "file-3.ts", "file-4.ts", "file-5.ts", "bad.ts"]
    const { client } = mixedSuccessErrorClient()
    const result = await _headFiles(
      { paths, lines: 200 },
      toolContext as any,
      client as any,
    )
    expect(result.length).toBeLessThanOrEqual(TOOL_LIMITS.headTotalOutputChars)
    // The total marker must be the last text — nothing appended after it.
    expect(result.endsWith(TOTAL_TRUNCATED_MARKER)).toBe(true)
    // The error section lands after the total cut and must never surface.
    expect(result).not.toContain("boom")
    expect(result).not.toContain("(error:")
  })

  it("3a. sixteen empty paths remain bounded", async () => {
    const paths = Array.from({ length: 16 }, (_, i) => `empty-${i}.ts`)
    const client = createMockClient(Object.fromEntries(paths.map((p) => [p, ""])))
    const result = await _headFiles(
      { paths, lines: 40 },
      toolContext as any,
      client as any,
    )
    expect(result.length).toBeLessThanOrEqual(TOOL_LIMITS.headTotalOutputChars)
    expect(result).toContain("(empty or not found)")
  })

  it("3b. sixteen throwing paths remain bounded", async () => {
    const paths = Array.from({ length: 16 }, (_, i) => `boom-${i}.ts`)
    const { client } = errorClient(() => new Error("e".repeat(100_000)))
    const result = await _headFiles(
      { paths, lines: 40 },
      toolContext as any,
      client as any,
    )
    expect(result.length).toBeLessThanOrEqual(TOOL_LIMITS.headTotalOutputChars)
    // No raw error tail may surface from any of the sixteen paths.
    expect(result).not.toContain("e".repeat(5000))
  })

  it("4. hidden tail text in a large error string is never appended", async () => {
    const { client } = errorClient(() => new Error("X".repeat(100_000)))
    const result = await _headFiles(
      { paths: ["hidden.ts"], lines: 40 },
      toolContext as any,
      client as any,
    )
    expect(result.length).toBeLessThanOrEqual(TOOL_LIMITS.headTotalOutputChars)
    // Even if a marker were present, no 5000-char tail of the raw error may
    // appear anywhere after it (or at all).
    expect(result).not.toContain("X".repeat(5000))
  })
})
