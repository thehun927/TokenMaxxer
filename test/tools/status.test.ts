import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../src/memory/store", () => ({
  readMemory: vi.fn(),
  resolveProjectPath: vi.fn((worktree: string, directory: string) => directory),
}))

vi.mock("../../src/util/fs", () => ({
  safeRead: vi.fn(),
}))

import { readMemory } from "../../src/memory/store"
import { safeRead } from "../../src/util/fs"
import {
  _tokenmaxxerStatus,
  lastCompactionTimestamp,
  setLastCompaction,
} from "../../src/tools/status"
import { getLLMConfig } from "../../src/memory/extract-llm"

function makeMemory(overrides?: Record<string, unknown>) {
  return {
    version: 1 as const,
    project_path: "/home/user/my-project",
    last_updated: "2026-08-08T12:00:00.000Z",
    last_git_sha: "abc1234",
    current_task: "Building the tools module",
    active_files: [
      {
        path: "src/tools/status.ts",
        reason: "status tool",
        last_touched: "2026-08-08T12:00:00.000Z",
      },
    ],
    decisions: [
      {
        id: "d1",
        topic: "database",
        decision: "Use PostgreSQL",
        timestamp: "2026-08-07T10:00:00.000Z",
        git_sha: "abc1234",
        session_id: "sess-001",
        still_valid: true,
        foundational: false,
      },
      {
        id: "d2",
        topic: "framework",
        decision: "Use Express",
        timestamp: "2026-08-06T10:00:00.000Z",
        session_id: "sess-000",
        still_valid: false,
        foundational: false,
      },
    ],
    blockers: [],
    next_steps: [],
    ...overrides,
  }
}

const mockContext = {
  worktree: "/home/user/my-project",
  directory: "/home/user/my-project",
}

describe("_tokenmaxxerStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    // Reset the module-level variable between tests
    ;(setLastCompaction as (ts: string | null) => void)(null as unknown as string)
  })

  it("with memory: returns formatted status with counts", async () => {
    vi.mocked(readMemory).mockResolvedValue(makeMemory())
    vi.mocked(safeRead).mockResolvedValue('{"version":1}')
    setLastCompaction("2026-08-08T11:00:00.000Z")

    const result = await _tokenmaxxerStatus({}, mockContext)

    expect(result).toContain("Project: /home/user/my-project")
    expect(result).toContain("Memory file:")
    expect(result).toContain("STATE.json")
    expect(result).toContain("(13 bytes)")
    expect(result).toContain("Decisions: 2 (1 valid)")
    expect(result).toContain("Active files: 1")
    expect(result).toContain("Last updated: 2026-08-08T12:00:00.000Z")
    expect(result).toContain("Last git SHA: abc1234")
    expect(result).toContain("Last compaction: 2026-08-08T11:00:00.000Z")
  })

  it("without memory: returns 'none' for fields", async () => {
    vi.mocked(readMemory).mockResolvedValue(null)
    vi.mocked(safeRead).mockResolvedValue(null)

    const result = await _tokenmaxxerStatus({}, mockContext)

    expect(result).toContain("Project: none")
    expect(result).toContain("Memory file:")
    expect(result).toContain("(0 bytes)")
    expect(result).toContain("Decisions: 0 (0 valid)")
    expect(result).toContain("Active files: 0")
    expect(result).toContain("Last updated: never")
    expect(result).toContain("Last git SHA: unknown")
  })

  it("lastCompactionTimestamp not set: shows 'none'", async () => {
    vi.mocked(readMemory).mockResolvedValue(makeMemory())
    vi.mocked(safeRead).mockResolvedValue("{}")
    // lastCompactionTimestamp was reset to null in beforeEach

    const result = await _tokenmaxxerStatus({}, mockContext)

    expect(result).toContain("Last compaction: none")
  })

  it("shows bounded provenance summaries without evidence text", async () => {
    const evidence = [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }]
    vi.mocked(readMemory).mockResolvedValue(makeMemory({
      current_task_provenance: {
        extractor: "llm",
        source_session_id: "source-1",
        source_audit_session_id: "audit-1",
        confidence: "llm-corroborated",
        evidence,
      },
      active_files: [{
        ...makeMemory().active_files[0],
        provenance: {
          extractor: "heuristic",
          source_session_id: "source-1",
          confidence: "heuristic",
          evidence,
        },
      }],
    }))
    vi.mocked(safeRead).mockResolvedValue("{}")

    const result = await _tokenmaxxerStatus({}, mockContext)

    expect(result).toContain("source=source-1")
    expect(result).toContain("confidence=llm-corroborated")
    expect(result).toContain("evidence=1")
    expect(result).not.toContain("must not be stored")
  })

  it("reports normalized selection and bounded model health", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    await getLLMConfig({
      config: { get: vi.fn(async () => ({ data: {} })) },
      provider: { list: vi.fn(async () => ({ data: {
        all: [{ id: "provider", models: {
          model: { tool_call: true, cost: { input: 0, output: 0 }, variants: { none: {} } },
        } }],
        connected: ["provider"],
      } })) },
    }, "/home/user/my-project")
    vi.mocked(readMemory).mockResolvedValue(makeMemory({ model_health: [{
      provider_id: "provider",
      model_id: "model",
      last_outcome: "timeout",
      failure_streak: 2,
      last_outcome_at: "2026-08-08T12:00:00.000Z",
      cooldown_until: "2026-08-08T12:30:00.000Z",
      failure_reason: "timeout",
    }] }))
    vi.mocked(safeRead).mockResolvedValue("{}")

    const result = await _tokenmaxxerStatus({}, mockContext)

    expect(result).toContain("LLM candidates: 1")
    expect(result).toContain("LLM selected: provider/model (automatic)")
    expect(result).toContain("LLM variant: none")
    expect(result).toContain("LLM health: timeout")
    expect(result).toContain("reason=timeout")
  })

  it("catches errors and returns error string", async () => {
    vi.mocked(readMemory).mockRejectedValue(new Error("disk failure"))

    const result = await _tokenmaxxerStatus({}, mockContext)

    expect(result).toContain("Error checking status: Error: disk failure")
  })
})

describe("setLastCompaction", () => {
  it("updates lastCompactionTimestamp", () => {
    setLastCompaction("2026-08-08T13:00:00.000Z")
    expect(lastCompactionTimestamp).toBe("2026-08-08T13:00:00.000Z")
  })

  it("sets to a new value", () => {
    setLastCompaction("first")
    expect(lastCompactionTimestamp).toBe("first")
    setLastCompaction("second")
    expect(lastCompactionTimestamp).toBe("second")
  })
})
