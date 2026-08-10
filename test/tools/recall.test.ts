import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../src/memory/store", () => ({
  readMemory: vi.fn(),
  writeMemory: vi.fn(),
  mutateMemory: vi.fn(),
  resolveProjectPath: vi.fn((worktree: string, directory: string) => directory || worktree),
}))

vi.mock("../../src/memory/reader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/memory/reader")>()
  return {
    queryDecisions: vi.fn(),
    getActiveFiles: vi.fn(),
    getProjectState: vi.fn(),
    getDecisionById: vi.fn(),
    // `_recallPromote` routes through `requestFoundationalReview`, which needs
    // the REAL exact-ID helper so the shared eligibility logic is exercised
    // (wave-9 Concern D).
    getExactDecisionById: actual.getExactDecisionById,
    getDecisionAuthorityConflicts: vi.fn(),
  }
})

import { readMemory, writeMemory, mutateMemory, resolveProjectPath } from "../../src/memory/store"
import { queryDecisions, getActiveFiles, getProjectState } from "../../src/memory/reader"
import { enqueueProjectJob, resetProjectQueues } from "../../src/memory/lock"
import { requestFoundationalReview } from "../../src/memory/decision-review"
import type { MemoryFile } from "../../src/memory/schema"
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
  // After commit, readMemory returns the mutated memory so the review-request
  // effect can be inspected.
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

  it("with existing topic: requests review via mutateMemory (sets only foundational_requested)", async () => {
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
    expect(result).toContain("Foundational review requested for d1")
    expect(result).toContain("tokenmaxxer promote d1")
    const post = await readMemory({ worktree: mockContext.worktree, directory: mockContext.directory })
    const target = post!.decisions.find((d) => d.id === "d1")!
    expect(target.foundational_requested).toBe(true)
    expect(target.foundational).toBe(false)
  })

  it("uses the shared resolved project path for promotion", async () => {
    const mem = makeMemory()
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)
    const context = { worktree: "/", directory: "/home/user/non-git-project" }

    await _recallPromote({ topic: "database" }, context)

    expect(resolveProjectPath).toHaveBeenCalledWith("/", "/home/user/non-git-project")
  })

  it("with missing topic: returns a bounded not-found message and does not commit", async () => {
    const mem = makeMemory()
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ topic: "nonexistent" }, mockContext)

    expect(result).toContain("nonexistent")
    expect(result).not.toContain("Foundational review requested")
    expect(writeMemory).not.toHaveBeenCalled()
  })

  it("requires exactly one selector (decision_id xor topic)", async () => {
    const mem = makeMemory()
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)

    const neither = await _recallPromote({}, mockContext)
    expect(neither).toMatch(/exactly one selector/i)
    expect(mutateMemory).not.toHaveBeenCalled()

    const both = await _recallPromote({ decision_id: "d1", topic: "database" }, mockContext)
    expect(both).toMatch(/exactly one selector/i)
    expect(mutateMemory).not.toHaveBeenCalled()
  })

  it("with no memory: returns a bounded not-found message and never mints trust", async () => {
    vi.mocked(mutateMemory).mockResolvedValue({
      status: "noop",
      value: { outcome: "not-found", topic: "database" },
      revision: 0,
    })

    const result = await _recallPromote({ topic: "database" }, mockContext)

    expect(result).toContain("No decision for topic 'database'")
    expect(writeMemory).not.toHaveBeenCalled()
  })

  it("case-insensitive topic match requests review of the authority", async () => {
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

    expect(result).toContain("Foundational review requested for d1")
    const post = await readMemory({ worktree: mockContext.worktree, directory: mockContext.directory })
    const target = post!.decisions.find((d) => d.id === "d1")!
    expect(target.foundational_requested).toBe(true)
    expect(target.foundational).toBe(false)
  })

  it("preserves provenance and sets only foundational_requested for a review request", async () => {
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

    // The mutation applied to the base must NOT touch trust/identity fields.
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
      foundational: false,
      foundational_requested: true,
      provenance: {
        extractor: "llm",
        source_session_id: "source-llm",
        source_audit_session_id: "audit-llm",
        confidence: "llm-corroborated",
      },
    })
    expect(result).toContain("Foundational review requested for d1")
    expect(result).not.toContain("confidence=human-reviewed")
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

  it("returns 'No project memory.' on unavailable STATE", async () => {
    const mem = makeMemory()
    vi.mocked(mutateMemory).mockResolvedValue({ status: "unavailable" })
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ topic: "database" }, mockContext)

    expect(result).toBe("No project memory.")
    expect(writeMemory).not.toHaveBeenCalled()
  })

  it("serializes the review request after a concurrent idle write", async () => {
    let stored = makeMemory()
    vi.mocked(readMemory).mockImplementation(async () => structuredClone(stored))
    vi.mocked(writeMemory).mockImplementation(async (_ctx, mem) => {
      stored = structuredClone(mem)
      return true
    })
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

    // Both logical mutations survive: the idle write's task and the review
    // request on the decision. No human trust was minted.
    expect(stored.current_task).toBe("idle update")
    expect(stored.decisions[0]).toMatchObject({
      foundational: false,
      foundational_requested: true,
    })
  })
})

// ─── PR 3 §8/§9 authority-aware reads and review request ────────────────────
// These release-gate tests (implementation-plan §15 items 19-28) fail on the
// current code: recall hides stable IDs, the reader can return two authorities
// from duplicate-valid raw memory, project state never reports human conflicts,
// and `_recallPromote` mints human provenance by topic. Wave 5 makes readers
// authority-aware and redesigns `_recallPromote` as a review-request tool with
// a `{ decision_id }` selector.
describe("PR 3 §8/§9 authority-aware reads and review request", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetProjectQueues()
  })

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

  /**
   * Wave 5 ships the exact-ID API `{ decision_id?; topic? }`; the Wave 1B
   * adapter shim is removed and tests drive `_recallPromote` directly.
   */

  it("19. recall_decision exposes stable decision IDs", async () => {
    const mem = makeMemory({
      decisions: [
        makeDecision({ id: "dec-stable-42", topic: "database", decision: "Use PostgreSQL" }),
      ],
    })
    vi.mocked(readMemory).mockResolvedValue(mem)
    vi.mocked(queryDecisions).mockReturnValue(mem.decisions)

    const result = await _recallDecision({ query: "database", limit: 10 }, mockContext)

    expect(result).toContain("dec-stable-42")
  })

  it("20. reader never returns two authorities for one normalized topic, even from duplicate-valid raw memory", async () => {
    // Delegate the mocked reader to the real queryDecisions so this test
    // exercises the actual authority filtering, not a hand-fed mock result.
    const realReader = await vi.importActual<typeof import("../../src/memory/reader")>("../../src/memory/reader")
    vi.mocked(queryDecisions).mockImplementation((mem, query, limit) =>
      realReader.queryDecisions(mem, query, limit),
    )

    const mem = makeMemory({
      decisions: [
        makeDecision({ id: "authority-1", topic: "database", decision: "Use PostgreSQL", timestamp: "2026-08-01T10:00:00.000Z" }),
        makeDecision({ id: "duplicate-2", topic: "database", decision: "Use PostgreSQL", timestamp: "2026-08-07T10:00:00.000Z" }),
      ],
    })
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallDecision({ query: "database", limit: 10 }, mockContext)

    const authorityLines = result.match(/database: /g)
    expect(authorityLines).toHaveLength(1)
    expect(result).toContain("id=authority-1")
  })

  it("21. get_project_state surfaces unresolved human authority conflict without dumping all history", async () => {
    const realReader = await vi.importActual<typeof import("../../src/memory/reader")>("../../src/memory/reader")
    vi.mocked(getProjectState).mockImplementation((mem) => realReader.getProjectState(mem))

    const mem = makeMemory({
      decisions: [
        makeDecision({
          id: "human-a",
          topic: "database",
          decision: "Use Postgres",
          foundational: true,
          foundational_requested: false,
          human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
          provenance: { extractor: "human", source_session_id: "s-a", confidence: "human-reviewed", evidence: [] },
        }),
        makeDecision({
          id: "human-b",
          topic: "database",
          decision: "Use MySQL",
          foundational: true,
          foundational_requested: false,
          human_review: { channel: "interactive-cli", reviewed_at: "2026-08-02T00:00:00Z" },
          provenance: { extractor: "human", source_session_id: "s-b", confidence: "human-reviewed", evidence: [] },
        }),
        makeDecision({ id: "stale-3", topic: "old-topic", decision: "Stale hidden history", still_valid: false }),
      ],
    })
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _getProjectState({}, mockContext)

    expect(result).toContain("Decision conflicts")
    expect(result).toContain("human-foundational conflict")
    expect(result).toContain("human-a")
    expect(result).toContain("human-b")
    // Bounded output: historical invalid rows are not dumped into project state.
    expect(result).not.toContain("Stale hidden history")
  })

  it("22. recall_promote({decision_id}) sets only foundational_requested=true", async () => {
    const mem = makeMemory({
      decisions: [
        makeDecision({
          id: "llm-1",
          topic: "database",
          decision: "Use PostgreSQL",
          foundational: false,
          foundational_requested: false,
          provenance: {
            extractor: "llm",
            source_session_id: "source-llm",
            source_audit_session_id: "audit-llm",
            confidence: "llm-corroborated",
            evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
          },
        }),
      ],
    })
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ decision_id: "llm-1" }, mockContext)

    const post = await readMemory({ worktree: mockContext.worktree, directory: mockContext.directory })
    const target = post!.decisions.find((d) => d.id === "llm-1")!
    expect(target.foundational_requested).toBe(true)
    // Trust/identity fields are UNCHANGED by a model review request.
    expect(target.foundational).toBe(false)
    expect(target.provenance?.extractor).toBe("llm")
    expect(target.provenance?.confidence).toBe("llm-corroborated")
    expect((target as { human_review?: unknown }).human_review).toBeUndefined()
    expect(result).toContain("review")
  })

  it("23. invalid exact ID cannot request promotion", async () => {
    const mem = makeMemory({
      decisions: [
        makeDecision({
          id: "llm-1",
          topic: "database",
          decision: "Use PostgreSQL",
          foundational: false,
          foundational_requested: false,
        }),
      ],
    })
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ decision_id: "nonexistent" }, mockContext)

    expect(result).not.toContain("Promoted:")
    expect(result).toMatch(/no decision|not found|not-found|refus/i)
    const post = await readMemory({ worktree: mockContext.worktree, directory: mockContext.directory })
    const target = post!.decisions.find((d) => d.id === "llm-1")!
    expect(target.foundational).toBe(false)
    expect(target.foundational_requested).toBe(false)
  })

  it("24. existing but non-authoritative duplicate ID cannot request promotion", async () => {
    const mem = makeMemory({
      decisions: [
        makeDecision({
          id: "authority-1",
          topic: "database",
          decision: "Use PostgreSQL",
          timestamp: "2026-08-01T10:00:00.000Z",
          foundational: false,
          foundational_requested: false,
        }),
        makeDecision({
          id: "duplicate-2",
          topic: "database",
          decision: "Use PostgreSQL",
          timestamp: "2026-08-07T10:00:00.000Z",
          foundational: false,
          foundational_requested: false,
        }),
      ],
    })
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ decision_id: "duplicate-2" }, mockContext)

    expect(result).not.toContain("Promoted:")
    expect(result).toMatch(/refus|ambiguous|not-authoritative|not authoritative|conflict|decision_id/i)
    const post = await readMemory({ worktree: mockContext.worktree, directory: mockContext.directory })
    const target = post!.decisions.find((d) => d.id === "duplicate-2")!
    expect(target.foundational_requested).toBe(false)
    expect(target.foundational).toBe(false)
  })

  it("25. already trusted human foundational target is a no-op", async () => {
    const mem = makeMemory({
      decisions: [
        makeDecision({
          id: "human-1",
          topic: "database",
          decision: "Use PostgreSQL",
          still_valid: true,
          foundational: true,
          foundational_requested: false,
          human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
          provenance: { extractor: "human", source_session_id: "s-human", confidence: "human-reviewed", evidence: [] },
        }),
      ],
    })
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ decision_id: "human-1" }, mockContext)

    expect(result).not.toContain("Promoted:")
    expect(result).toMatch(/already|no-op|noop|foundational|review/i)
    const post = await readMemory({ worktree: mockContext.worktree, directory: mockContext.directory })
    const target = post!.decisions.find((d) => d.id === "human-1")!
    expect(target.foundational).toBe(true)
    expect(target.provenance?.extractor).toBe("human")
    expect((target as { human_review?: unknown }).human_review).toBeDefined()
  })

  it("26. topic compatibility succeeds only for one unambiguous exact normalized authority", async () => {
    const mem = makeMemory({
      decisions: [
        makeDecision({ id: "auth-1", topic: "auth", decision: "Use JWT", foundational: false, foundational_requested: false }),
      ],
    })
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ topic: "Auth" }, mockContext)

    expect(result).not.toMatch(/refus|ambiguous|not-authoritative|not authoritative|conflict/i)
    const post = await readMemory({ worktree: mockContext.worktree, directory: mockContext.directory })
    const target = post!.decisions.find((d) => d.id === "auth-1")!
    expect(target.foundational_requested).toBe(true)
    expect(target.foundational).toBe(false)
  })

  it("27. topic compatibility refuses ambiguous/unresolved state", async () => {
    const mem = makeMemory({
      decisions: [
        makeDecision({ id: "auth-1", topic: "auth", decision: "Use JWT", timestamp: "2026-08-01T10:00:00.000Z", foundational: false }),
        makeDecision({ id: "auth-2", topic: "auth", decision: "Use OAuth2", timestamp: "2026-08-07T10:00:00.000Z", foundational: false }),
      ],
    })
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ topic: "auth" }, mockContext)

    expect(result).not.toContain("Promoted:")
    expect(result).toMatch(/refus|ambiguous|not-authoritative|not authoritative|conflict|decision_id/i)
  })

  it("28. model tool cannot produce extractor=human, confidence=human-reviewed, or human_review", async () => {
    const mem = makeMemory({
      decisions: [
        makeDecision({
          id: "llm-1",
          topic: "database",
          decision: "Use PostgreSQL",
          foundational: false,
          foundational_requested: false,
          provenance: {
            extractor: "llm",
            source_session_id: "source-llm",
            source_audit_session_id: "audit-llm",
            confidence: "llm-corroborated",
            evidence: [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }],
          },
        }),
      ],
    })
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ decision_id: "llm-1" }, mockContext)

    const post = await readMemory({ worktree: mockContext.worktree, directory: mockContext.directory })
    const target = post!.decisions.find((d) => d.id === "llm-1")!
    expect(target.provenance?.extractor).not.toBe("human")
    expect(target.provenance?.confidence).not.toBe("human-reviewed")
    expect((target as { human_review?: unknown }).human_review).toBeUndefined()
    expect(result).not.toContain("confidence=human-reviewed")
  })
})

// ─── PR 3 wave-9 — duplicate-ID refusal + shared-helper routing ─────────────
describe("PR 3 wave-9 — review-request duplicate-ID refusal and shared helper routing", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetProjectQueues()
  })

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

  it("29. _recallPromote({decision_id}) refuses a duplicate-ID state with no mutation", async () => {
    const mem = makeMemory({
      decisions: [
        makeDecision({
          id: "dup-id",
          topic: "database",
          decision: "Use PostgreSQL",
          timestamp: "2026-08-01T10:00:00.000Z",
          foundational: false,
          foundational_requested: true,
        }),
        makeDecision({
          id: "dup-id",
          topic: "database",
          decision: "Use PostgreSQL",
          timestamp: "2026-08-07T10:00:00.000Z",
          foundational: false,
          foundational_requested: false,
        }),
      ],
    })
    mockMutateCommitted(mem)
    vi.mocked(readMemory).mockResolvedValue(mem)

    const result = await _recallPromote({ decision_id: "dup-id" }, mockContext)

    // Explicit ambiguous refusal, never a promotion or review request.
    expect(result).not.toContain("Foundational review requested")
    expect(result).toMatch(/ambiguous|duplicate|share this ID/i)
    expect(writeMemory).not.toHaveBeenCalled()
    // No mutation: both rows keep their original foundational_requested state.
    const post = await readMemory({ worktree: mockContext.worktree, directory: mockContext.directory })
    const rows = post!.decisions.filter((d) => d.id === "dup-id")
    expect(rows).toHaveLength(2)
    expect(rows.every((d) => d.foundational === false)).toBe(true)
    const requestedCount = rows.filter((d) => d.foundational_requested === true).length
    expect(requestedCount).toBe(1) // unchanged from the seed
  })

  it("30. _recallPromote({decision_id}) returns the same outcomes as requestFoundationalReview for the same locked state", async () => {
    const cases: Array<{
      name: string
      decisions: ReturnType<typeof makeMemory>["decisions"]
      decisionId: string
      assertTool: (msg: string) => void
      assertHelper: (kind: ReturnType<typeof requestFoundationalReview>["kind"]) => void
    }> = [
      {
        name: "eligible authority",
        decisions: [
          makeDecision({ id: "llm-1", topic: "database", decision: "Use PostgreSQL", foundational: false, foundational_requested: false }),
        ],
        decisionId: "llm-1",
        assertTool: (msg) => expect(msg).toContain("Foundational review requested for llm-1"),
        assertHelper: (kind) => expect(kind).toBe("requested"),
      },
      {
        name: "non-authoritative ID",
        decisions: [
          makeDecision({ id: "authority-1", topic: "database", decision: "Use PostgreSQL", timestamp: "2026-08-01T10:00:00.000Z", foundational: false }),
          makeDecision({ id: "duplicate-2", topic: "database", decision: "Use PostgreSQL", timestamp: "2026-08-07T10:00:00.000Z", foundational: false }),
        ],
        decisionId: "duplicate-2",
        assertTool: (msg) => expect(msg).toMatch(/not-authoritative|not authoritative/i),
        assertHelper: (kind) => expect(kind).toBe("not-authoritative"),
      },
      {
        name: "conflicting human topic",
        decisions: [
          makeDecision({
            id: "human-a", topic: "database", decision: "Use Postgres",
            foundational: true, foundational_requested: false,
            human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
            provenance: { extractor: "human", source_session_id: "s-a", confidence: "human-reviewed", evidence: [] },
          }),
          makeDecision({
            id: "human-b", topic: "database", decision: "Use MySQL",
            foundational: true, foundational_requested: false,
            human_review: { channel: "interactive-cli", reviewed_at: "2026-08-02T00:00:00Z" },
            provenance: { extractor: "human", source_session_id: "s-b", confidence: "human-reviewed", evidence: [] },
          }),
        ],
        decisionId: "human-a",
        assertTool: (msg) => expect(msg).toMatch(/conflict/i),
        assertHelper: (kind) => expect(kind).toBe("conflict"),
      },
      {
        name: "duplicate-ID state",
        decisions: [
          makeDecision({ id: "dup-id", topic: "database", decision: "Use PostgreSQL", foundational: false }),
          makeDecision({ id: "dup-id", topic: "database", decision: "Use PostgreSQL", timestamp: "2026-08-07T10:00:00.000Z", foundational: false }),
        ],
        decisionId: "dup-id",
        assertTool: (msg) => expect(msg).toMatch(/ambiguous|share this ID/i),
        assertHelper: (kind) => expect(kind).toBe("duplicate-id"),
      },
      {
        name: "already-reviewed",
        decisions: [
          makeDecision({
            id: "human-1", topic: "database", decision: "Use PostgreSQL",
            foundational: true, foundational_requested: false,
            human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
            provenance: { extractor: "human", source_session_id: "s-h", confidence: "human-reviewed", evidence: [] },
          }),
        ],
        decisionId: "human-1",
        assertTool: (msg) => expect(msg).toMatch(/already/i),
        assertHelper: (kind) => expect(kind).toBe("already-reviewed"),
      },
    ]

    for (const scenario of cases) {
      const mem = makeMemory({ decisions: scenario.decisions as never[] })
      mockMutateCommitted(mem)
      vi.mocked(readMemory).mockResolvedValue(mem)

      const toolResult = await _recallPromote({ decision_id: scenario.decisionId }, mockContext)
      scenario.assertTool(toolResult)

      // The shared helper decides the same outcome for the same locked state.
      const helperResult = requestFoundationalReview(mem as unknown as MemoryFile, {
        decision_id: scenario.decisionId,
      })
      scenario.assertHelper(helperResult.kind)
    }
  })
})
