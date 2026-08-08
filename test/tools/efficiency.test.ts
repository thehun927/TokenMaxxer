import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../src/compaction/durable", () => ({
  buildDurableBlock: vi.fn(),
}))

import { buildDurableBlock } from "../../src/compaction/durable"
import { _previewCompaction, _headFiles } from "../../src/tools/efficiency"

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

    const result = await _previewCompaction(
      {},
      { worktree: "/test", directory: "/test", client: null },
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
      { worktree: "/test", directory: "/test", client: null },
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
      { worktree: "/test", directory: "/test", client },
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
      { worktree: "/test", directory: "/test", client },
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
      { worktree: "/test", directory: "/test", client },
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
      { worktree: "/test", directory: "/test", client },
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
      { worktree: "/test", directory: "/test", client },
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
      { worktree: "/test", directory: "/test", client },
    )

    const contentLines = result.split("\n").filter((l) => l.startsWith("line"))
    expect(contentLines).toHaveLength(40)
    expect(result).toContain("...(truncated)")
    // line39 should be in, line40 should not
    expect(result).toContain("line39")
    expect(result).not.toContain("line40")
  })
})
