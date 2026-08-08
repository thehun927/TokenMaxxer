import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the memory store module BEFORE importing it or the module under test
vi.mock("../../src/memory/store", () => ({
  readMemory: vi.fn(),
}))

// Mock the log module to prevent actual log calls and allow verification
vi.mock("../../src/util/log", () => ({
  log: vi.fn(),
}))

import { readMemory } from "../../src/memory/store"
import { buildDurableBlock } from "../../src/compaction/durable"
import { log } from "../../src/util/log"
import type { MemoryFile } from "../../src/memory/schema"

const mockClient = {} as unknown

function makeFullMemory(overrides?: Partial<MemoryFile>): MemoryFile {
  return {
    version: 1,
    project_path: "/home/user/my-project",
    last_updated: "2026-08-08T12:00:00.000Z",
    last_git_sha: "abc1234",
    last_session_id: "sess-001",
    current_task: "Building the compaction module",
    active_files: [
      { path: "src/compaction/prompt.ts", reason: "main implementation file", last_touched: "2026-08-08T12:00:00.000Z" },
      { path: "src/compaction/durable.ts", reason: "durable block builder", last_touched: "2026-08-08T11:30:00.000Z" },
    ],
    decisions: [
      {
        id: "d1",
        topic: "database",
        decision: "Use PostgreSQL",
        rationale: "Better JSON support",
        timestamp: "2026-08-07T10:00:00.000Z",
        git_sha: "def5678",
        session_id: "sess-001",
        still_valid: true,
        foundational: true,
      },
      {
        id: "d2",
        topic: "framework",
        decision: "Use Express",
        timestamp: "2026-08-06T10:00:00.000Z",
        git_sha: "aaa1111",
        session_id: "sess-000",
        still_valid: false, // superseded
        foundational: false,
      },
      {
        id: "d3",
        topic: "auth",
        decision: "Use JWT for authentication",
        timestamp: "2026-08-07T11:00:00.000Z",
        session_id: "sess-001",
        still_valid: true,
        foundational: false,
        last_used_in_session: "sess-001",
      },
    ],
    blockers: ["Waiting on API key"],
    next_steps: ["Write unit tests", "Document the API"],
    ...overrides,
  }
}

describe("buildDurableBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns '(no prior project memory)' when readMemory returns null", async () => {
    vi.mocked(readMemory).mockResolvedValue(null)

    const result = await buildDurableBlock({
      worktree: "/some/worktree",
      directory: "/some/worktree",
      client: mockClient,
    })

    expect(result).toBe("(no prior project memory)")
  })

  it("returns formatted string when memory is full", async () => {
    vi.mocked(readMemory).mockResolvedValue(makeFullMemory())

    const result = await buildDurableBlock({
      worktree: "/home/user/my-project",
      directory: "/home/user/my-project",
      client: mockClient,
    })

    expect(result).toContain("Project: /home/user/my-project")
    expect(result).toContain("Last updated: 2026-08-08T12:00:00.000Z")
    expect(result).toContain("git SHA: abc1234")
    expect(result).toContain("Current task: Building the compaction module")
    expect(result).toContain("Active files:")
    expect(result).toContain("  - src/compaction/prompt.ts — main implementation file")
    expect(result).toContain("  - src/compaction/durable.ts — durable block builder")
    expect(result).toContain("Valid decisions:")
    expect(result).toContain("Blockers: Waiting on API key")
    expect(result).toContain("Next: Write unit tests; Document the API")
  })

  it("filters out still_valid: false decisions", async () => {
    vi.mocked(readMemory).mockResolvedValue(makeFullMemory())

    const result = await buildDurableBlock({
      worktree: "/home/user/my-project",
      directory: "/home/user/my-project",
      client: mockClient,
    })

    // d1 (database, still_valid: true) and d3 (auth, still_valid: true) should appear
    expect(result).toContain("database:")
    expect(result).toContain("PostgreSQL")
    expect(result).toContain("auth:")
    expect(result).toContain("JWT")
    // d2 (framework, still_valid: false) should NOT appear
    expect(result).not.toContain("framework:")
    expect(result).not.toContain("Express")
  })

  it("applies the bounded decision policy", async () => {
    const decisions = Array.from({ length: 50 }, (_, index) => ({
      id: `d${index}`,
      topic: `topic-${index}`,
      decision: `decision-${index}`,
      timestamp: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
      git_sha: `sha-${index}`,
      session_id: `old-${index}`,
      still_valid: true,
      foundational: index < 2,
      ...(index >= 2 && index < 5 ? { last_used_in_session: "current" } : {}),
    }))

    vi.mocked(readMemory).mockResolvedValue(
      makeFullMemory({ last_session_id: "current", decisions }),
    )

    const result = await buildDurableBlock({
      worktree: "/home/user/my-project",
      directory: "/home/user/my-project",
      client: mockClient,
    })

    expect(result.length).toBeLessThan(2_000)
    expect(result).toContain("Valid decisions:")
    for (let index = 0; index < 5; index++) {
      expect(result).toContain(`topic-${index}: decision-${index}`)
      expect(result).toContain(`2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`)
    }

    expect(result).toContain("Older decisions:")
    for (const index of [27, 26, 25, 24, 23]) {
      expect(result).toContain(`topic-${index}: decision-${index}`)
      expect(result).toContain(`(SHA sha-${index}, 2026-07-${String((index % 28) + 1).padStart(2, "0")})`)
      expect(result).not.toContain(`2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`)
    }
    for (const index of Array.from({ length: 45 }, (_, i) => i + 5)) {
      if (index < 23 || index > 27) {
        expect(result).not.toContain(`topic-${index}:`)
      }
    }
  })

  it("caps active files at the eight most recently touched", async () => {
    const active_files = Array.from({ length: 15 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      reason: `reason-${index}`,
      last_touched: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }))
    vi.mocked(readMemory).mockResolvedValue(makeFullMemory({ active_files }))

    const result = await buildDurableBlock({
      worktree: "/home/user/my-project",
      directory: "/home/user/my-project",
      client: mockClient,
    })

    for (const index of Array.from({ length: 8 }, (_, i) => i + 7)) {
      expect(result).toContain(`src/file-${index}.ts`)
    }
    for (const index of Array.from({ length: 7 }, (_, i) => i)) {
      expect(result).not.toContain(`src/file-${index}.ts`)
    }
  })

  it("omits Active files section when active_files is empty", async () => {
    vi.mocked(readMemory).mockResolvedValue(
      makeFullMemory({ active_files: [] }),
    )

    const result = await buildDurableBlock({
      worktree: "/home/user/my-project",
      directory: "/home/user/my-project",
      client: mockClient,
    })

    expect(result).not.toContain("Active files:")
    expect(result).not.toContain("Older decisions:")
  })

  it("omits Current task line when current_task is undefined", async () => {
    vi.mocked(readMemory).mockResolvedValue(
      makeFullMemory({ current_task: undefined }),
    )

    const result = await buildDurableBlock({
      worktree: "/home/user/my-project",
      directory: "/home/user/my-project",
      client: mockClient,
    })

    expect(result).not.toContain("Current task:")
  })

  it("omits Valid decisions section when all decisions are invalid or empty", async () => {
    vi.mocked(readMemory).mockResolvedValue(
      makeFullMemory({
        decisions: [
          {
            id: "d1",
            topic: "old-decision",
            decision: "old",
            timestamp: "2026-01-01T00:00:00.000Z",
            session_id: "old",
            still_valid: false,
            foundational: false,
          },
        ],
      }),
    )

    const result = await buildDurableBlock({
      worktree: "/home/user/my-project",
      directory: "/home/user/my-project",
      client: mockClient,
    })

    expect(result).not.toContain("Valid decisions:")
    expect(result).not.toContain("Older decisions:")
  })

  it('returns "(memory unavailable)" when readMemory throws, without re-throwing', async () => {
    vi.mocked(readMemory).mockRejectedValue(new Error("disk failure"))

    const result = await buildDurableBlock({
      worktree: "/some/worktree",
      directory: "/some/worktree",
      client: mockClient,
    })

    expect(result).toBe("(memory unavailable)")
    // Verify that log was called with the error
    expect(log).toHaveBeenCalledWith(
      mockClient,
      "warn",
      "buildDurableBlock failed",
      { error: "Error: disk failure" },
    )
  })

  it("handles non-Error throwables gracefully", async () => {
    vi.mocked(readMemory).mockRejectedValue("some string error")

    const result = await buildDurableBlock({
      worktree: "/some/worktree",
      directory: "/some/worktree",
      client: mockClient,
    })

    expect(result).toBe("(memory unavailable)")
    expect(log).toHaveBeenCalledWith(
      mockClient,
      "warn",
      "buildDurableBlock failed",
      { error: "some string error" },
    )
  })
})
