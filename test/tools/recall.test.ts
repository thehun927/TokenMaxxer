import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../src/memory/store", () => ({
  readMemory: vi.fn(),
  writeMemory: vi.fn(),
  mutateMemory: vi.fn(),
  resolveProjectPath: vi.fn((worktree: string, directory: string) => directory || worktree),
}))

vi.mock("../../src/memory/reader", () => ({
  queryDecisions: vi.fn(),
  getActiveFiles: vi.fn(),
  getProjectState: vi.fn(),
}))

import { readMemory, writeMemory, mutateMemory, resolveProjectPath } from "../../src/memory/store"
import { queryDecisions, getActiveFiles, getProjectState } from "../../src/memory/reader"
import { enqueueProjectJob, resetProjectQueues } from "../../src/memory/lock"
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
    resetProjectQueues()
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

describe("read-only recall does NOT acquire the lock (PR 2 §11.F)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetProjectQueues()
  })

  it("recall_decision never calls mutateMemory", async () => {
    const mem = makeMemory()
    vi.mocked(readMemory).mockResolvedValue(mem)
    vi.mocked(queryDecisions).mockReturnValue(mem.decisions)

    await _recallDecision({ query: "database", limit: 10 }, mockContext)

    expect(mutateMemory).not.toHaveBeenCalled()
    expect(writeMemory).not.toHaveBeenCalled()
  })

  it("get_active_files never calls mutateMemory", async () => {
    const mem = makeMemory()
    vi.mocked(readMemory).mockResolvedValue(mem)
    vi.mocked(getActiveFiles).mockReturnValue(mem.active_files)

    await _getActiveFiles({}, mockContext)

    expect(mutateMemory).not.toHaveBeenCalled()
    expect(writeMemory).not.toHaveBeenCalled()
  })

  it("get_project_state never calls mutateMemory", async () => {
    const mem = makeMemory()
    vi.mocked(readMemory).mockResolvedValue(mem)
    vi.mocked(getProjectState).mockReturnValue("Project: /home/user/my-project")

    await _getProjectState({}, mockContext)

    expect(mutateMemory).not.toHaveBeenCalled()
    expect(writeMemory).not.toHaveBeenCalled()
  })
})

describe("unavailable STATE in a recall tool fails closed (PR 2 §11.F)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetProjectQueues()
  })

  it("recall_decision with unreadable STATE returns no-memory and writes nothing", async () => {
    // readMemory collapses "unavailable" to null for the read-only wrapper.
    vi.mocked(readMemory).mockResolvedValue(null)

    const result = await _recallDecision({ query: "database", limit: 10 }, mockContext)

    expect(result).toBe("No project memory yet.")
    expect(mutateMemory).not.toHaveBeenCalled()
    expect(writeMemory).not.toHaveBeenCalled()
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
    resetProjectQueues()
  })

  // Drive the real mutateMemory callback against a base memory and return the
  // committed result, mirroring how the production transaction applies it.
  // After commit, readMemory returns the promoted memory so the tool's label
  // reflects the human-reviewed provenance.
  function mockMutateCommitted(base: ReturnType<typeof makeMemory>) {
    vi.mocked(mutateMemory).mockImplementation(async (_args, mutate) => {
      const action = mutate(structuredClone(base), {
        status: "ok",
        memory: base,
        source: "project",
        path: "/state.json",
        sizeBytes: 0,
        revision: base.revision ?? 0,
      })
      if (action.kind === "noop") {
        return { status: "noop", value: action.value, revision: base.revision ?? 0 }
      }
      vi.mocked(readMemory).mockResolvedValue(action.memory)
      return { status: "committed", value: action.value, revision: (base.revision ?? 0) + 1 }
    })
  }

  it("with existing topic: sets foundational=true via mutateMemory", async () => {
    const mem = makeMemory({
      decisions: [
        makeDecision({
          topic: "database",
          decision: "Use PostgreSQL",
          foundational: false,
        }),
      ],
    })
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ topic: "database" }, mockContext)

    expect(mutateMemory).toHaveBeenCalledTimes(1)
    expect(writeMemory).not.toHaveBeenCalled()
    expect(result).toContain("Promoted: database: Use PostgreSQL")
    expect(result).toContain("confidence=human-reviewed")
  })

  it("uses the shared resolved project path for promotion", async () => {
    const mem = makeMemory()
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)
    const context = { worktree: "/", directory: "/home/user/non-git-project" }

    await _recallPromote({ topic: "database" }, context)

    expect(resolveProjectPath).toHaveBeenCalledWith("/", "/home/user/non-git-project")
  })

  it("with missing topic: returns error string and does not commit", async () => {
    const mem = makeMemory()
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ topic: "nonexistent" }, mockContext)

    expect(result).toBe('No decision with topic "nonexistent".')
    expect(writeMemory).not.toHaveBeenCalled()
  })

  it("when no memory: returns 'No project memory.'", async () => {
    vi.mocked(readMemory).mockResolvedValue(null)
    vi.mocked(mutateMemory).mockResolvedValue({ status: "noop", value: { outcome: "noop" }, revision: 0 })

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
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ topic: "database" }, mockContext)

    expect(result).toContain("Promoted: Database: Use PostgreSQL")
    expect(result).toContain("confidence=human-reviewed")
  })

  it("records explicit human-review provenance and clears the request flag", async () => {
    const mem = makeMemory({
      decisions: [makeDecision({
        foundational: false,
        foundational_requested: true,
        provenance: {
          extractor: "llm",
          source_session_id: "source-llm",
          source_audit_session_id: "audit-llm",
          confidence: "llm-corroborated",
          evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
        },
      })],
    })
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote(
      { topic: "database" },
      { ...mockContext, sessionID: "human-review-session" },
    )

    // The mutation applied to the base must carry the human-review provenance.
    const action = vi.mocked(mutateMemory).mock.calls[0][1](structuredClone(mem), {
      status: "ok",
      memory: mem,
      source: "project",
      path: "/state.json",
      sizeBytes: 0,
      revision: 0,
    })
    if (action.kind !== "commit") throw new Error("expected commit")
    expect(action.memory.decisions[0]).toMatchObject({
      foundational: true,
      foundational_requested: false,
      provenance: {
        extractor: "human",
        source_session_id: "human-review-session",
        source_audit_session_id: "audit-llm",
        confidence: "human-reviewed",
      },
    })
    expect(result).toContain("audit=audit-llm")
    expect(result).toContain("evidence=1")
  })

  it("catches errors and returns error string", async () => {
    vi.mocked(mutateMemory).mockRejectedValue(new Error("disk failure"))

    const result = await _recallPromote({ topic: "database" }, mockContext)

    expect(result).toContain("Error promoting decision: Error: disk failure")
  })

  it("returns a bounded failure string on lock-timeout instead of throwing", async () => {
    const mem = makeMemory()
    vi.mocked(mutateMemory).mockResolvedValue({ status: "lock-timeout" })
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ topic: "database" }, mockContext)

    expect(result).toBe("promotion-write-failed")
    expect(writeMemory).not.toHaveBeenCalled()
  })

  it("returns a bounded failure string on unavailable STATE", async () => {
    const mem = makeMemory()
    vi.mocked(mutateMemory).mockResolvedValue({ status: "unavailable" })
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ topic: "database" }, mockContext)

    expect(result).toBe("promotion-write-failed")
    expect(writeMemory).not.toHaveBeenCalled()
  })

  it("serializes promotion after a concurrent idle write", async () => {
    let stored = makeMemory()
    vi.mocked(readMemory).mockImplementation(async () => structuredClone(stored))
    vi.mocked(mutateMemory).mockImplementation(async (_args, mutate) => {
      const action = mutate(structuredClone(stored), {
        status: "ok",
        memory: stored,
        source: "project",
        path: "/state.json",
        sizeBytes: 0,
        revision: 0,
      })
      if (action.kind === "noop") {
        return { status: "noop", value: action.value, revision: 0 }
      }
      stored = structuredClone(action.memory)
      return { status: "committed", value: action.value, revision: 1 }
    })

    let markIdleStarted!: () => void
    let releaseIdle!: () => void
    const idleStarted = new Promise<void>((resolve) => { markIdleStarted = resolve })
    const idleRelease = new Promise<void>((resolve) => { releaseIdle = resolve })
    const staleIdleSnapshot = structuredClone(stored)
    const idle = enqueueProjectJob(
      mockContext.worktree,
      "idle-session-serialization",
      async () => {
        markIdleStarted()
        await idleRelease
        await writeMemory(mockContext, {
          ...staleIdleSnapshot,
          current_task: "idle update",
        })
      },
    )
    await idleStarted

    const promotion = _recallPromote(
      { topic: "database" },
      { ...mockContext, sessionID: "human-review-session" },
    )
    releaseIdle()
    await Promise.all([idle, promotion])

    expect(stored.decisions[0]).toMatchObject({
      foundational: true,
      foundational_requested: false,
      provenance: {
        extractor: "human",
        source_session_id: "human-review-session",
        confidence: "human-reviewed",
      },
    })
  })
})
