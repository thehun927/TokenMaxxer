import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../src/memory/store", () => ({
  readMemory: vi.fn(),
  writeMemory: vi.fn(),
}))

vi.mock("../../src/memory/reader", () => ({
  queryDecisions: vi.fn(),
  getActiveFiles: vi.fn(),
  getProjectState: vi.fn(),
}))

import { readMemory, writeMemory } from "../../src/memory/store"
import { queryDecisions, getActiveFiles, getProjectState } from "../../src/memory/reader"
import {
  _recallDecision,
  _getActiveFiles,
  _getProjectState,
  _recallPromote,
} from "../../src/tools/recall"

// Helpers for building test data
function makeDecision(overrides?: Record<string, unknown>) {
  return {
    id: "d1",
    topic: "database",
    decision: "Use PostgreSQL",
    timestamp: "2026-08-07T10:00:00.000Z",
    git_sha: "abc1234",
    session_id: "sess-001",
    still_valid: true,
    foundational: false,
    ...overrides,
  }
}

function makeMemory(overrides?: Record<string, unknown>) {
  return {
    version: 1 as const,
    project_path: "/home/user/my-project",
    last_updated: "2026-08-08T12:00:00.000Z",
    last_git_sha: "abc1234",
    current_task: "Building the tools module",
    active_files: [
      {
        path: "src/tools/recall.ts",
        reason: "main tool file",
        last_touched: "2026-08-08T12:00:00.000Z",
      },
    ],
    decisions: [makeDecision()],
    blockers: [],
    next_steps: [],
    ...overrides,
  }
}

const mockContext = { worktree: "/home/user/my-project", directory: "/home/user/my-project" }

describe("_recallDecision", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("with empty query: calls queryDecisions with undefined query, limit 10", async () => {
    const mem = makeMemory()
    vi.mocked(readMemory).mockResolvedValue(mem)
    vi.mocked(queryDecisions).mockReturnValue(mem.decisions)

    await _recallDecision({ query: undefined, limit: 10 }, mockContext)

    expect(queryDecisions).toHaveBeenCalledWith(mem, undefined, 10)
  })

  it("with query 'database': calls queryDecisions with 'database'", async () => {
    const mem = makeMemory()
    vi.mocked(readMemory).mockResolvedValue(mem)
    vi.mocked(queryDecisions).mockReturnValue(mem.decisions)

    await _recallDecision({ query: "database", limit: 10 }, mockContext)

    expect(queryDecisions).toHaveBeenCalledWith(mem, "database", 10)
  })

  it("returns formatted decisions when hits found", async () => {
    const mem = makeMemory()
    vi.mocked(readMemory).mockResolvedValue(mem)
    vi.mocked(queryDecisions).mockReturnValue([
      makeDecision({
        topic: "database",
        decision: "Use PostgreSQL",
        git_sha: "abc1234",
        timestamp: "2026-08-07T10:00:00.000Z",
      }),
    ])

    const result = await _recallDecision({ query: "database", limit: 10 }, mockContext)

    expect(result).toContain("Project: /home/user/my-project")
    expect(result).toContain(
      "database: Use PostgreSQL (SHA abc1234, 2026-08-07T10:00:00.000Z)",
    )
  })

  it("when no memory: returns 'No project memory yet.'", async () => {
    vi.mocked(readMemory).mockResolvedValue(null)

    const result = await _recallDecision({ query: undefined, limit: 10 }, mockContext)

    expect(result).toBe("No project memory yet.")
  })

  it("when no hits: returns info with query", async () => {
    const mem = makeMemory()
    vi.mocked(readMemory).mockResolvedValue(mem)
    vi.mocked(queryDecisions).mockReturnValue([])

    const result = await _recallDecision({ query: "nonexistent", limit: 10 }, mockContext)

    expect(result).toContain('No valid decisions matching "nonexistent".')
  })

  it("catches errors and returns error string", async () => {
    vi.mocked(readMemory).mockRejectedValue(new Error("disk failure"))

    const result = await _recallDecision({ query: undefined, limit: 10 }, mockContext)

    expect(result).toContain("Error recalling decisions: Error: disk failure")
  })
})

describe("_getActiveFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("when no memory: returns 'No active files recorded.'", async () => {
    vi.mocked(readMemory).mockResolvedValue(null)

    const result = await _getActiveFiles({}, mockContext)

    expect(result).toBe("No active files recorded.")
  })

  it("when empty active_files: returns 'No active files recorded.'", async () => {
    vi.mocked(readMemory).mockResolvedValue(makeMemory({ active_files: [] }))
    vi.mocked(getActiveFiles).mockReturnValue([])

    const result = await _getActiveFiles({}, mockContext)

    expect(result).toBe("No active files recorded.")
  })

  it("with files: returns formatted list with project path", async () => {
    const mem = makeMemory()
    vi.mocked(readMemory).mockResolvedValue(mem)
    vi.mocked(getActiveFiles).mockReturnValue(mem.active_files)

    const result = await _getActiveFiles({}, mockContext)

    expect(result).toContain("Project: /home/user/my-project")
    expect(result).toContain("src/tools/recall.ts — main tool file")
  })

  it("catches errors and returns error string", async () => {
    vi.mocked(readMemory).mockRejectedValue(new Error("disk failure"))

    const result = await _getActiveFiles({}, mockContext)

    expect(result).toContain("Error getting active files: Error: disk failure")
  })
})

describe("_getProjectState", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("when no memory: returns 'No project memory. This looks like a fresh start.'", async () => {
    vi.mocked(readMemory).mockResolvedValue(null)

    const result = await _getProjectState({}, mockContext)

    expect(result).toBe("No project memory. This looks like a fresh start.")
  })

  it("with memory: returns formatted state from getProjectState", async () => {
    const mem = makeMemory()
    vi.mocked(readMemory).mockResolvedValue(mem)
    vi.mocked(getProjectState).mockReturnValue(
      "Project: /home/user/my-project\nLast: 2026-08-08T12:00:00.000Z (SHA abc1234)",
    )

    const result = await _getProjectState({}, mockContext)

    expect(result).toContain("Project: /home/user/my-project")
    expect(getProjectState).toHaveBeenCalledWith(mem)
  })

  it("catches errors and returns error string", async () => {
    vi.mocked(readMemory).mockRejectedValue(new Error("disk failure"))

    const result = await _getProjectState({}, mockContext)

    expect(result).toContain("Error getting project state: Error: disk failure")
  })
})

describe("_recallPromote", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("with existing topic: sets foundational=true, calls writeMemory", async () => {
    const mem = makeMemory({
      decisions: [
        makeDecision({
          topic: "database",
          decision: "Use PostgreSQL",
          foundational: false,
        }),
      ],
    })
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ topic: "database" }, mockContext)

    expect(mem.decisions[0].foundational).toBe(true)
    expect(writeMemory).toHaveBeenCalledWith(mockContext, mem)
    expect(result).toBe("Promoted: database: Use PostgreSQL")
  })

  it("with missing topic: returns error string", async () => {
    const mem = makeMemory()
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ topic: "nonexistent" }, mockContext)

    expect(result).toBe('No decision with topic "nonexistent".')
    expect(writeMemory).not.toHaveBeenCalled()
  })

  it("when no memory: returns 'No project memory.'", async () => {
    vi.mocked(readMemory).mockResolvedValue(null)

    const result = await _recallPromote({ topic: "database" }, mockContext)

    expect(result).toBe("No project memory.")
  })

  it("case-insensitive topic match", async () => {
    const mem = makeMemory({
      decisions: [
        makeDecision({
          topic: "Database",
          decision: "Use PostgreSQL",
          foundational: false,
        }),
      ],
    })
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ topic: "database" }, mockContext)

    expect(mem.decisions[0].foundational).toBe(true)
    expect(result).toBe("Promoted: Database: Use PostgreSQL")
  })

  it("catches errors and returns error string", async () => {
    vi.mocked(readMemory).mockRejectedValue(new Error("disk failure"))

    const result = await _recallPromote({ topic: "database" }, mockContext)

    expect(result).toContain("Error promoting decision: Error: disk failure")
  })
})
