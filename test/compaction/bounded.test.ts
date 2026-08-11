import { describe, expect, it, vi, beforeEach } from "vitest"
import type { Decision, MemoryFile } from "../../src/memory/schema"

vi.mock("../../src/memory/store", () => ({
  readMemory: vi.fn(),
  readMemoryState: vi.fn(),
}))

vi.mock("../../src/util/log", () => ({
  log: vi.fn(),
}))

vi.mock("../../src/util/git", () => ({
  getCurrentGitSha: vi.fn(),
}))

import { readMemoryState } from "../../src/memory/store"
import { buildDurableBlock } from "../../src/compaction/durable"
import { getCurrentGitSha } from "../../src/util/git"

/**
 * PR-7 Wave 4 — These tests freeze the semantic selection/count policy
 * (foundational, recent, older caps) with PR-7's new rendering format.
 * They are NOT tests for PR-8 total byte budgeting.
 *
 * PR 7 adds per-field render-only character caps (tested in durable.test.ts).
 * PR 8 will later define the hard total injection byte budget separately.
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
  vi.mocked(readMemoryState).mockResolvedValue({
    status: "ok",
    memory: makeMemory(decisions),
    source: "project",
    path: "/project/.opencode/memory/STATE.json",
    sizeBytes: 500,
    revision: 0,
  })
  return buildDurableBlock({
    worktree: "/project",
    directory: "/project",
    client: {},
  })
}

describe("bounded durable block", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCurrentGitSha).mockResolvedValue(null)
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

    // Foundational + recent (index 0-4) must appear
    for (let index = 0; index < 5; index++) {
      expect(result).toContain(`topic-${index}`)
      expect(result).toContain(`decision text ${index}`)
    }

    // Older top-5 (by timestamp, descending): 49,48,47,46,45
    for (const index of [49, 48, 47, 46, 45]) {
      expect(result).toContain(`topic-${index}`)
      expect(result).toContain(`decision text ${index}`)
    }

    // Other older decisions must NOT appear
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

    // All 12 foundational decisions must appear, no older cap applies to them
    for (let index = 0; index < 12; index++) {
      expect(result).toContain(`topic-${index}`)
      expect(result).toContain(`decision text ${index}`)
    }
    // Non-foundational older cap doesn't affect them
  })

  it("uses only the five most recent decisions when no priority tiers exist", async () => {
    const result = await build(
      Array.from({ length: 10 }, (_, index) => makeDecision(index)),
    )

    // Only the 5 most recent (by timestamp, descending): 9,8,7,6,5
    for (const index of [9, 8, 7, 6, 5]) {
      expect(result).toContain(`topic-${index}`)
      expect(result).toContain(`decision text ${index}`)
    }
    // Older ones should NOT appear
    for (const index of [0, 1, 2, 3, 4]) {
      expect(result).not.toContain(`topic-${index}:`)
    }
  })

  it("assigns mixed decisions to exactly the correct selection", async () => {
    const result = await build([
      makeDecision(0, { foundational: true }),
      makeDecision(1, { recent: true }),
      makeDecision(2),
      makeDecision(3, { valid: false, foundational: true }),
    ])

    // Foundational (0) and recent (1) must appear
    expect(result).toContain("topic-0")
    expect(result).toContain("decision text 0")
    expect(result).toContain("topic-1")
    expect(result).toContain("decision text 1")
    // Older (2) must appear
    expect(result).toContain("topic-2")
    expect(result).toContain("decision text 2")
    // Invalid (3) must NOT appear
    expect(result).not.toContain("topic-3")
  })
})
