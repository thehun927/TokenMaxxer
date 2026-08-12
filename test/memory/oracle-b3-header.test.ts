/**
 * Oracle B3 (writer-side) — HEADER must be generated from the committed
 * fitted STATE, never from callback-carried `value.memory`, plus the
 * writer-side B4 automatic-creation-limit integration.
 *
 * B3: `processPreparedIdleSource` must consume `MemoryMutationResult.memory`
 * (the fitted state actually persisted by `mutateMemory`) for HEADER
 * generation and subsequent committed-state representation on both the
 * heuristic and final-LLM paths, with exhaustive status handling.
 *
 * The pressure regressions here seed a schema-valid, near-cap STATE whose
 * `current_task` is longer than the creation bound. When the heuristic/LLM
 * transaction pushes the candidate over the storage cap, the central fitter
 * truncates `current_task`. The captured `generateHeader` argument must then
 * equal the persisted fitted STATE — not the pre-fit candidate that the
 * callback carried in `value.memory`.
 *
 * B4: the real heuristic producer (`extractFactsHeuristic`) and the writer
 * merge path must emit automatic facts that obey MEMORY_CREATION_LIMITS even
 * when the transcript/tool inputs are over-limit.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import * as writer from "../../src/memory/writer"
import { writeMemoryOnIdle, extractFactsHeuristic } from "../../src/memory/writer"
import { writeMemory, readMemoryState } from "../../src/memory/store"
import { emptyMemory, MEMORY_CREATION_LIMITS } from "../../src/memory/schema"
import { memorySizeBytes } from "../../src/memory/memory-size"
import { makeTranscriptEvidenceRef } from "../../src/memory/extract-prompt"
import { resetHostStructuredContractGate } from "../../src/memory/llm-adapter"
import { resetProjectQueues } from "../../src/memory/lock"
import type { TranscriptMessage } from "../../src/types"

const directories: string[] = []

async function worktree(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tokenmaxxer-oracle-b3-"))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetHostStructuredContractGate()
  resetProjectQueues()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const HEURISTIC_PROVENANCE = {
  extractor: "heuristic" as const,
  source_session_id: "seed-session",
  confidence: "heuristic" as const,
  evidence: [] as never[],
}

const RECENT_TIMESTAMP = "2026-08-10T00:00:00.000Z"

/**
 * Build a schema-valid base STATE whose `current_task` (1800 chars) exceeds
 * the 512-char automatic creation bound but stays within the 2048-char
 * persistence ceiling, with `decisionCount` recent non-foundational decisions
 * used to tune the byte pressure.
 */
function buildNearCapBase(
  project: string,
  decisionCount: number,
  decisionLen: number,
): ReturnType<typeof emptyMemory> {
  const decisions = Array.from({ length: decisionCount }, (_, index) => ({
    id: `seed-d-${index}`,
    topic: `topic-${index}`,
    decision: "x".repeat(decisionLen),
    timestamp: RECENT_TIMESTAMP,
    session_id: "seed-session",
    still_valid: true,
    // Explicit schema-default fields so the raw serialized size equals the
    // validated size (zod otherwise adds these during commit validation).
    foundational: false,
    foundational_requested: false,
    human_conflict_quarantined: false,
    provenance: HEURISTIC_PROVENANCE,
  }))
  return {
    ...emptyMemory(project),
    project_path: project,
    last_updated: "2026-08-11T00:00:00.000Z",
    current_task: "t".repeat(1800),
    current_task_provenance: HEURISTIC_PROVENANCE,
    decisions,
  }
}

/** Assistant-only transcript: no user natural language, so current_task stays null. */
function assistantOnlyTranscript(): TranscriptMessage[] {
  return [
    {
      info: { id: "a1", role: "assistant" },
      parts: [{ type: "text", text: "We will use Postgres for storage." }],
    },
    {
      info: { id: "a2", role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { filePath: "src/calib.ts" } },
        },
      ],
    },
    {
      info: { id: "a3", role: "assistant" },
      parts: [{ type: "text", text: "Blocked on credentials.\n1. Wire the adapter\nNext: run tests" }],
    },
  ]
}

function heuristicClient(transcript: TranscriptMessage[]) {
  return {
    app: { log: vi.fn() },
    config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
    session: {
      messages: vi.fn(async () => ({ data: transcript })),
    },
  }
}

describe("Oracle B3 — HEADER consumes the committed fitted STATE (never value.memory)", () => {
  it("heuristic path: HEADER matches the persisted fitted STATE when the fitter truncates current_task", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()

    // Base STATE is schema-valid and just under the storage cap, with a
    // current_task longer than the creation bound (1800 chars). The heuristic
    // candidate produced by the transcript pushes it over the cap, so the
    // central fitter truncates current_task to 512 before persistence.
    const base = buildNearCapBase(project, 7, 260)
    expect(memorySizeBytes(base)).toBeLessThan(8_192)
    await writeMemory({ worktree: project, directory: project, client: undefined }, base)

    const headerSpy = vi.spyOn(writer, "generateHeader")
    const outcome = await writeMemoryOnIdle({
      client: heuristicClient(assistantOnlyTranscript()),
      worktree: project,
      directory: project,
      sessionId: "b3-heuristic",
    })

    // The heuristic commit must succeed (fitted) rather than be rejected.
    expect(outcome).toBe("heuristic-only")

    const state = await readMemoryState({ worktree: project, directory: project })
    expect(state.status).toBe("ok")
    if (state.status !== "ok") throw new Error("expected persisted ok state")

    // The fitter changed current_task: the committed state no longer carries
    // the 1800-char pre-fit candidate.
    expect(state.memory.current_task).not.toBe("t".repeat(1800))
    expect(state.memory.current_task?.length).toBe(512)

    // A header must have been generated from the actual fitted committed
    // memory, matching the persisted fitted STATE exactly.
    expect(headerSpy).toHaveBeenCalled()
    const headerMem = headerSpy.mock.calls.at(-1)![2]
    expect(headerMem.current_task).toBe(state.memory.current_task)
    expect(headerMem.current_task).not.toBe("t".repeat(1800))
  })

  it("final-LLM path: last HEADER matches the persisted fitted STATE under pressure", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const project = await worktree()

    // Smaller base so every intermediate transaction (heuristic commit, audit
    // guard, model health) fits without touching current_task, leaving the
    // pressure that truncates current_task to the final LLM merge.
    const base = buildNearCapBase(project, 4, 280)
    expect(memorySizeBytes(base)).toBeLessThan(8_192)
    await writeMemory({ worktree: project, directory: project, client: undefined }, base)

    const transcript = assistantOnlyTranscript()
    const ref = makeTranscriptEvidenceRef("a1")
    const create = vi.fn(async () => ({ data: { id: "audit-b3-final" } }))
    const prompt = vi.fn(async () => ({
      data: {
        info: {
          structured: {
            decisions: [{
              topic: "t".repeat(MEMORY_CREATION_LIMITS.decisionTopicChars),
              decision: "d".repeat(MEMORY_CREATION_LIMITS.decisionTextChars),
              rationale: "r".repeat(MEMORY_CREATION_LIMITS.decisionRationaleChars),
              evidence_refs: [ref],
            }],
          },
        },
      },
    }))
    const client = {
      app: { log: vi.fn() },
      config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
      session: {
        messages: vi.fn(async () => ({ data: transcript })),
        create,
        prompt,
      },
    }

    const headerSpy = vi.spyOn(writer, "generateHeader")
    const outcome = await writeMemoryOnIdle({
      client,
      worktree: project,
      directory: project,
      sessionId: "b3-final",
    })

    expect(outcome).toBe("llm-success")

    const state = await readMemoryState({ worktree: project, directory: project })
    expect(state.status).toBe("ok")
    if (state.status !== "ok") throw new Error("expected persisted ok state")

    // The final merge applied real byte pressure that changed current_task.
    expect(state.memory.current_task).not.toBe("t".repeat(1800))
    expect(state.memory.current_task?.length).toBe(512)

    // The last HEADER (the final-LLM one) must be generated from the fitted
    // committed memory and match the persisted fitted STATE.
    expect(headerSpy).toHaveBeenCalled()
    const lastHeaderMem = headerSpy.mock.calls.at(-1)![2]
    expect(lastHeaderMem.current_task).toBe(state.memory.current_task)
    expect(lastHeaderMem.current_task).not.toBe("t".repeat(1800))
  })
})

describe("Oracle B4 (writer side) — heuristic producers obey MEMORY_CREATION_LIMITS", () => {
  const L = MEMORY_CREATION_LIMITS

  it("extractFactsHeuristic caps/rejects over-limit automatic facts", () => {
    const blockerLines = Array.from(
      { length: 20 },
      (_, i) => `Blocked on item ${i} ${"b".repeat(600)}`,
    )
    const stepLines = Array.from(
      { length: 20 },
      (_, i) => `${i + 1}. do step ${"s".repeat(600)}`,
    )
    const transcript: TranscriptMessage[] = [
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: `Implement the thing ${"x".repeat(2000)}` }],
      },
      {
        info: { id: "t1", role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: `src/${"a".repeat(3000)}.ts` },
            },
          },
          {
            type: "tool",
            tool: "read",
            state: { status: "completed", input: { filePath: "src/legit.ts" } },
          },
        ],
      },
      {
        info: { id: "d1", role: "assistant" },
        parts: [{ type: "text", text: `Let's use ${"q".repeat(300)} for the database.` }],
      },
      {
        info: { id: "last", role: "assistant" },
        parts: [{ type: "text", text: [...blockerLines, ...stepLines].join("\n") }],
      },
    ]

    const facts = extractFactsHeuristic(transcript)

    // current_task capped at the creation bound, not the raw over-limit text.
    expect(facts.current_task).not.toBeNull()
    expect(facts.current_task!.length).toBeLessThanOrEqual(L.currentTaskChars)

    // Over-limit active-file paths are rejected, not truncated; valid paths
    // survive and their reasons obey the reason bound.
    expect(facts.active_files.some((f) => f.path.length > L.activeFilePathChars)).toBe(false)
    expect(facts.active_files.some((f) => f.path.startsWith(`src/${"a".repeat(3000)}`))).toBe(false)
    expect(facts.active_files.some((f) => f.path === "src/legit.ts")).toBe(true)
    for (const file of facts.active_files) {
      expect(file.reason.length).toBeLessThanOrEqual(L.activeFileReasonChars)
    }

    // Blocker/next-step strings and counts obey the creation contract.
    expect(facts.blockers.length).toBeLessThanOrEqual(L.blockersMax)
    for (const blocker of facts.blockers) {
      expect(blocker.length).toBeLessThanOrEqual(L.blockerChars)
    }
    expect(facts.next_steps.length).toBeLessThanOrEqual(L.nextStepsMax)
    for (const step of facts.next_steps) {
      expect(step.length).toBeLessThanOrEqual(L.nextStepChars)
    }

    // Heuristic decision topic/text/rationale obey the creation contract.
    for (const decision of facts.decisions) {
      expect(decision.topic.length).toBeLessThanOrEqual(L.decisionTopicChars)
      expect(decision.decision.length).toBeLessThanOrEqual(L.decisionTextChars)
      if (decision.rationale !== undefined) {
        expect(decision.rationale.length).toBeLessThanOrEqual(L.decisionRationaleChars)
      }
    }
  })

  it("writeMemoryOnIdle persists only bounded automatic content for over-limit inputs", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()

    const blockerLines = Array.from({ length: 12 }, (_, i) => `Blocked on creds ${i}`)
    const transcript: TranscriptMessage[] = [
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: `Refactor the auth module ${"z".repeat(1200)}` }],
      },
      {
        info: { id: "t1", role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "edit",
            state: {
              status: "completed",
              input: { filePath: `src/${"n".repeat(3000)}.ts` },
            },
          },
          {
            type: "tool",
            tool: "edit",
            state: { status: "completed", input: { filePath: "src/auth.ts" } },
          },
        ],
      },
      {
        info: { id: "d1", role: "assistant" },
        parts: [{ type: "text", text: "Let's use JWT for sessions." }],
      },
      {
        info: { id: "last", role: "assistant" },
        parts: [{ type: "text", text: blockerLines.join("\n") }],
      },
    ]

    const outcome = await writeMemoryOnIdle({
      client: heuristicClient(transcript),
      worktree: project,
      directory: project,
      sessionId: "b4-writer",
    })
    expect(outcome).toBe("heuristic-only")

    const state = await readMemoryState({ worktree: project, directory: project })
    expect(state.status).toBe("ok")
    if (state.status !== "ok") throw new Error("expected persisted ok state")
    const mem = state.memory

    expect(mem.current_task?.length).toBeLessThanOrEqual(L.currentTaskChars)
    // The 3000-char active path is rejected; only the valid path remains.
    expect(mem.active_files.some((f) => f.path.length > L.activeFilePathChars)).toBe(false)
    expect(mem.active_files.some((f) => f.path === "src/auth.ts")).toBe(true)
    for (const file of mem.active_files) {
      expect(file.reason.length).toBeLessThanOrEqual(L.activeFileReasonChars)
    }
    expect(mem.blockers.length).toBeLessThanOrEqual(L.blockersMax)
    for (const blocker of mem.blockers) {
      expect(blocker.length).toBeLessThanOrEqual(L.blockerChars)
    }
    expect(mem.next_steps.length).toBeLessThanOrEqual(L.nextStepsMax)
    for (const decision of mem.decisions) {
      expect(decision.topic.length).toBeLessThanOrEqual(L.decisionTopicChars)
      expect(decision.decision.length).toBeLessThanOrEqual(L.decisionTextChars)
    }
  })
})
