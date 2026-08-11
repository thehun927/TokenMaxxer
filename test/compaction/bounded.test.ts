import { describe, expect, it, vi, beforeEach } from "vitest"
import type { Decision, MemoryFile } from "../../src/memory/schema"

vi.mock("../../src/memory/store", () => ({
  readMemory: vi.fn(),
}))

vi.mock("../../src/util/log", () => ({
  log: vi.fn(),
}))

import { readMemory } from "../../src/memory/store"
import { buildDurableBlock } from "../../src/compaction/durable"

/**
 * PR-7 Wave 1 note — these tests freeze the semantic selection/count policy
 * from the existing bounded decision selection (foundational, recent, older
 * caps).  They are NOT tests for PR-8 total byte budgeting.
 *
 * PR 7 adds per-field render-only character caps (in durable.test.ts) that
 * are applied during rendering without mutating STATE.  PR 8 will later
 * define the hard total injection byte budget separately.  Do not weaken
 * these selection/count assertions.
 */

const currentSession = "session-current"

function makeDecision(
  index: number,
  options: { foundational?: boolean; recent?: boolean; valid?: boolean } = {},
): Decision {
  return {
    id: `decision-${index}`,
    topic: `topic-${index}`,
    decision: `decision text ${index}`,
    timestamp: new Date(Date.UTC(2026, 0, index + 1, 12)).toISOString(),
    git_sha: `sha-${index}`,
    session_id: `session-${index}`,
    still_valid: options.valid ?? true,
    foundational: options.foundational ?? false,
    ...(options.recent ? { last_used_in_session: currentSession } : {}),
  }
}

function makeMemory(decisions: Decision[]): MemoryFile {
  return {
    version: 1,
    project_path: "/project",
    last_updated: "2026-08-08T12:00:00.000Z",
    last_git_sha: "head-sha",
    last_session_id: currentSession,
    current_task: "Keep the project moving",
    active_files: [],
    decisions,
    blockers: [],
    next_steps: [],
  }
}

async function build(decisions: Decision[]): Promise<string> {
  vi.mocked(readMemory).mockResolvedValue(makeMemory(decisions))
  return buildDurableBlock({
    worktree: "/project",
    directory: "/project",
    client: {},
  })
}

describe("bounded durable block", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("keeps foundational and recent decisions in full fidelity and caps older decisions", async () => {
    const decisions = [
      ...Array.from({ length: 2 }, (_, index) =>
        makeDecision(index, { foundational: true }),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        makeDecision(index + 2, { recent: true }),
      ),
      ...Array.from({ length: 45 }, (_, index) => makeDecision(index + 5)),
    ]

    const result = await build(decisions)

    expect(result.length).toBeLessThan(2_000)
    expect(result).toContain("Valid decisions:")
    for (let index = 0; index < 5; index++) {
      expect(result).toContain(`topic-${index}: decision text ${index}`)
      expect(result).toContain(
        `2026-01-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
      )
    }

    expect(result).toContain("Older decisions:")
    for (const index of [49, 48, 47, 46, 45]) {
      expect(result).toContain(`topic-${index}: decision text ${index}`)
      expect(result).toContain(
        `(SHA sha-${index}, 2026-02-${String(index - 30).padStart(2, "0")})`,
      )
    }
    for (const index of Array.from({ length: 40 }, (_, offset) => offset + 5)) {
      if (index <= 44) expect(result).not.toContain(`topic-${index}:`)
    }
  })

  it("includes every valid foundational decision in full fidelity", async () => {
    const result = await build(
      Array.from({ length: 12 }, (_, index) =>
        makeDecision(index, { foundational: true }),
      ),
    )

    expect(result).toContain("Valid decisions:")
    expect(result).not.toContain("Older decisions:")
    for (let index = 0; index < 12; index++) {
      expect(result).toContain(`topic-${index}: decision text ${index}`)
      expect(result).toContain(
        `2026-01-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
      )
    }
  })

  it("uses only the five most recent decisions when no priority tiers exist", async () => {
    const result = await build(
      Array.from({ length: 10 }, (_, index) => makeDecision(index)),
    )

    expect(result).not.toContain("Valid decisions:")
    expect(result).toContain("Older decisions:")
    for (const index of [9, 8, 7, 6, 5]) {
      expect(result).toContain(`topic-${index}: decision text ${index}`)
    }
    for (const index of [0, 1, 2, 3, 4]) {
      expect(result).not.toContain(`topic-${index}:`)
    }
  })

  it("assigns mixed decisions to exactly the correct section", async () => {
    const result = await build([
      makeDecision(0, { foundational: true }),
      makeDecision(1, { recent: true }),
      makeDecision(2),
      makeDecision(3, { valid: false, foundational: true }),
    ])

    expect(result).toContain("Valid decisions:")
    expect(result).toContain("topic-0: decision text 0")
    expect(result).toContain("topic-1: decision text 1")
    expect(result).toContain("2026-01-01T12:00:00.000Z")
    expect(result).toContain("2026-01-02T12:00:00.000Z")
    expect(result).toContain("Older decisions:")
    expect(result).toContain("topic-2: decision text 2")
    expect(result).not.toContain("topic-3:")
  })
})
