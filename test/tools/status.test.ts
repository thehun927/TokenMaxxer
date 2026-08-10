import { describe, it, expect, vi, beforeEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

vi.mock("../../src/memory/store", () => ({
  readMemoryState: vi.fn(),
  resolveProjectPath: vi.fn((worktree: string, directory: string) => directory),
}))

import { readMemoryState } from "../../src/memory/store"
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

// Build a MemoryReadResult for the mocked readMemoryState.
function statusResult(
  memory: Record<string, unknown> | null,
  overrides: Record<string, unknown> = {},
) {
  const statePath = join(mockContext.directory, ".opencode", "memory", "STATE.json")
  return {
    memory,
    source: memory ? "project" : null,
    path: memory ? statePath : null,
    sizeBytes: 0,
    revision: 0,
    ...overrides,
  }
}

describe("_tokenmaxxerStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    // Reset the module-level variable between tests
    ;(setLastCompaction as (ts: string | null) => void)(null as unknown as string)
  })

  it("with memory: returns formatted status with counts", async () => {
    vi.mocked(readMemoryState).mockResolvedValue(statusResult(makeMemory(), { sizeBytes: 13 }))
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

  it("reports STATE.json size using UTF-8 bytes", async () => {
    const content = '{"note":"café"}'
    vi.mocked(readMemoryState).mockResolvedValue(statusResult(makeMemory(), {
      sizeBytes: Buffer.byteLength(content, "utf8"),
    }))

    const result = await _tokenmaxxerStatus({}, mockContext)

    expect(result).toContain(`STATE.json (${Buffer.byteLength(content, "utf8")} bytes)`)
    expect(result).not.toContain(`STATE.json (${content.length} bytes)`)
  })

  it("without memory: returns 'none' for fields", async () => {
    vi.mocked(readMemoryState).mockResolvedValue(statusResult(null))

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
    vi.mocked(readMemoryState).mockResolvedValue(statusResult(makeMemory(), { sizeBytes: 2 }))
    // lastCompactionTimestamp was reset to null in beforeEach

    const result = await _tokenmaxxerStatus({}, mockContext)

    expect(result).toContain("Last compaction: none")
  })

  it("shows bounded provenance summaries without evidence text", async () => {
    const evidence = [{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }]
    vi.mocked(readMemoryState).mockResolvedValue(statusResult(makeMemory({
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
    }), { sizeBytes: 2 }))

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
    vi.mocked(readMemoryState).mockResolvedValue(statusResult(makeMemory({ model_health: [{
      provider_id: "provider",
      model_id: "model",
      last_outcome: "timeout",
      failure_streak: 2,
      last_outcome_at: "2026-08-08T12:00:00.000Z",
      cooldown_until: "2026-08-08T12:30:00.000Z",
      failure_reason: "timeout",
    }] }), { sizeBytes: 2 }))

    const result = await _tokenmaxxerStatus({}, mockContext)

    expect(result).toContain("LLM candidates (process-wide): 1")
    expect(result).toContain("LLM selected: provider/model (durable-health)")
    expect(result).toContain("LLM variant (process-wide): none")
    expect(result).toContain("LLM health: timeout")
    expect(result).toContain("reason=timeout")
  })

  it("uses only each temporary project's durable model health", async () => {
    const projectA = await mkdtemp(join(tmpdir(), "tokenmaxxer-status-a-"))
    const projectB = await mkdtemp(join(tmpdir(), "tokenmaxxer-status-b-"))
    try {
      vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
      await getLLMConfig({
        config: { get: vi.fn(async () => ({ data: { small_model: "global/model" } })) },
        provider: { list: vi.fn(async () => ({ data: {
          all: [{ id: "global", models: {
            model: { tool_call: true, cost: { input: 0, output: 0 } },
          } }],
          connected: ["global"],
        } })) },
      }, projectA)

      const memories = new Map([
        [projectA, makeMemory({
          project_path: projectA,
          model_health: [{
            provider_id: "project-a-provider",
            model_id: "project-a-model",
            last_outcome: "timeout",
            failure_streak: 2,
            last_outcome_at: "2026-08-08T12:00:00.000Z",
            cooldown_until: "2026-08-08T12:30:00.000Z",
            failure_reason: "project-a-timeout",
          }],
        })],
        [projectB, makeMemory({
          project_path: projectB,
          model_health: [{
            provider_id: "project-b-provider",
            model_id: "project-b-model",
            last_outcome: "validation-failure",
            failure_streak: 1,
            last_outcome_at: "2026-08-08T13:00:00.000Z",
            failure_reason: "project-b-validation",
          }],
        })],
      ])
      vi.mocked(readMemoryState).mockImplementation(async ({ directory }) =>
        statusResult(memories.get(directory) ?? null)
      )

      const statusA = await _tokenmaxxerStatus({}, {
        worktree: projectA,
        directory: projectA,
      })
      const statusB = await _tokenmaxxerStatus({}, {
        worktree: projectB,
        directory: projectB,
      })

      expect(statusA).toContain("LLM selected: project-a-provider/project-a-model (durable-health)")
      expect(statusA).toContain("LLM health: timeout")
      expect(statusA).toContain("reason=project-a-timeout")
      expect(statusA).not.toContain("global/model")
      expect(statusA).not.toContain("project-b-provider/project-b-model")
      expect(statusA).not.toContain("project-b-validation")

      expect(statusB).toContain("LLM selected: project-b-provider/project-b-model (durable-health)")
      expect(statusB).toContain("LLM health: validation-failure")
      expect(statusB).toContain("reason=project-b-validation")
      expect(statusB).not.toContain("global/model")
      expect(statusB).not.toContain("project-a-provider/project-a-model")
      expect(statusB).not.toContain("project-a-timeout")

      expect(statusA).toContain("LLM candidates (process-wide): 1")
      expect(statusB).toContain("LLM candidates (process-wide): 1")
    } finally {
      await Promise.all([
        rm(projectA, { recursive: true, force: true }),
        rm(projectB, { recursive: true, force: true }),
      ])
    }
  })

  it("catches errors and returns error string", async () => {
    vi.mocked(readMemoryState).mockRejectedValue(new Error("disk failure"))

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
