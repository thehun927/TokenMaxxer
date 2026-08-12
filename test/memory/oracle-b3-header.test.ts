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
 * The pressure boundary is constructed deterministically from actual
 * serialized byte measurements rather than fixed decision count/length
 * assumptions. The persisted base and the merged candidate both embed the
 * project path (a random temp dir), whose length varies across environments;
 * a boundary chosen by arithmetic can therefore land on either side of the
 * 8KB cap in CI. Both fixtures therefore measure `memorySizeBytes` of the real
 * candidate and add/adjust legal disposable seed decisions until the candidate
 * is just over the cap but can still be fitted by the intended current_task
 * truncation, then assert the pre-fit/post-fit byte bounds explicitly.
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
import {
  writeMemoryOnIdle,
  extractFactsHeuristic,
  mergeHeuristicMemory,
  markReferencedDecisions,
  recordRecentSession,
  buildHeuristicEvidenceCandidateMap,
} from "../../src/memory/writer"
import { writeMemory, readMemoryState } from "../../src/memory/store"
import { emptyMemory, MEMORY_CREATION_LIMITS, MemoryFileSchema } from "../../src/memory/schema"
import type { MemoryFile } from "../../src/memory/schema"
import { memorySizeBytes, MEMORY_MAX_BYTES } from "../../src/memory/memory-size"
import { fitMemoryToBudget } from "../../src/memory/budget"
import { makeTranscriptEvidenceRef, buildTranscriptEvidenceCandidateMap } from "../../src/memory/extract-prompt"
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
/** Deterministic merge timestamp; only its fixed 24-char length affects bytes. */
const MERGE_TIMESTAMP = "2026-08-12T00:00:00.000Z"

/** current_task: above the 512-char automatic creation bound, within the 2048-char persistence ceiling. */
const CURRENT_TASK_LEN = 1_800
const DECISION_COUNT = 4

/**
 * Build a schema-valid base STATE with an over-bound `current_task` and a
 * tunable number of disposable (non-foundational) seed decisions.
 */
function buildBase(
  project: string,
  decisionCount: number,
  decisionLen: number,
): MemoryFile {
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
    current_task: "t".repeat(CURRENT_TASK_LEN),
    current_task_provenance: HEURISTIC_PROVENANCE,
    decisions,
  } as MemoryFile
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

/**
 * Replicate the writer's heuristic transaction byte-for-byte.
 *
 * The candidate the central fitter will see is built with the exact same
 * exported writer/merge helpers and evidence maps the writer uses internally:
 * `extractFactsHeuristic` -> merged transcript+heuristic candidate map ->
 * `markReferencedDecisions` -> `mergeHeuristicMemory` -> `recordRecentSession`.
 * With deterministic IDs and a fixed-length merge timestamp this serializes to
 * exactly the bytes `mutateMemory` hands to `fitMemoryToBudget` (verified
 * against the real pipeline, including the fitted commit).
 */
function computeHeuristicCandidate(
  base: MemoryFile,
  sessionId: string,
  timestamp: string,
): MemoryFile {
  const transcript = assistantOnlyTranscript()
  const extracted = extractFactsHeuristic(transcript)

  // Mirrors the writer's `transcriptCandidateMap`: transcript evidence
  // candidates carry `kind: "transcript"` and are merged before the heuristic
  // candidates so evidence matching behaves identically to the real pipeline.
  const sourceTranscriptCandidates = buildTranscriptEvidenceCandidateMap(transcript)
  const transcriptCandidates: Record<string, unknown> = {}
  for (const [ref, candidate] of Object.entries(sourceTranscriptCandidates)) {
    transcriptCandidates[ref] = {
      kind: "transcript",
      ref,
      digest: candidate.digest,
      text: candidate.text,
      role: candidate.role,
    }
  }
  const heuristicCandidates = buildHeuristicEvidenceCandidateMap(extracted)
  const mergedCandidates: Record<string, unknown> = {}
  for (const map of [transcriptCandidates, heuristicCandidates]) {
    for (const [ref, candidate] of Object.entries(map)) {
      if (!mergedCandidates[ref]) mergedCandidates[ref] = candidate
    }
  }

  const referenced = markReferencedDecisions(base, transcript, sessionId)
  const merged = mergeHeuristicMemory(referenced, extracted, {
    sessionId,
    gitSha: null,
    timestamp,
    evidenceCandidates: mergedCandidates,
  })
  return recordRecentSession(merged, sessionId)
}

/**
 * Deterministic near-cap base for the heuristic path.
 *
 * The fitter removes disposable operational metadata (the recent-session entry
 * and the active-file observation, ≈520 bytes for the controlled transcript)
 * before stage 8, which truncates current_task 1800 -> 512 bytes. The exact
 * candidate bytes are therefore tuned into a band where:
 *  - it exceeds the cap by more than the pre-stage-8 disposables, so the fit
 *    is forced to stage 8 and truncates current_task; and
 *  - it stays below cap + stage-8 savings minus the zod commit re-validation
 *    delta, so the fitted state persists comfortably under the cap.
 *
 * The band is verified here against the real fitter AND the real commit schema
 * (`MemoryFileSchema.safeParse`), so every accepted base is provably safe.
 */
const HEURISTIC_PRE_FIT_MIN = MEMORY_MAX_BYTES + 800
const HEURISTIC_PRE_FIT_MAX = MEMORY_MAX_BYTES + 1_000

function buildDeterministicHeuristicBase(project: string): MemoryFile {
  const candidateBytes = (base: MemoryFile) =>
    memorySizeBytes(computeHeuristicCandidate(base, "b3-heuristic", MERGE_TIMESTAMP))
  const baseAt = (decisionLen: number) => buildBase(project, DECISION_COUNT, decisionLen)

  // Each disposable seed decision adds exactly DECISION_COUNT serialized bytes
  // per decision-text character, so solve for the decision length directly.
  const perChar = candidateBytes(baseAt(1)) - candidateBytes(baseAt(0))
  const target = Math.round((HEURISTIC_PRE_FIT_MIN + HEURISTIC_PRE_FIT_MAX) / 2)
  const guess = Math.max(0, Math.round((target - candidateBytes(baseAt(0))) / perChar))

  for (let decisionLen = Math.max(0, guess - 2); decisionLen <= guess + 2; decisionLen += 1) {
    const base = baseAt(decisionLen)
    if (memorySizeBytes(base) >= MEMORY_MAX_BYTES) continue

    const candidate = computeHeuristicCandidate(base, "b3-heuristic", MERGE_TIMESTAMP)
    const candidateBytesNow = memorySizeBytes(candidate)
    if (candidateBytesNow < HEURISTIC_PRE_FIT_MIN || candidateBytesNow > HEURISTIC_PRE_FIT_MAX) {
      continue
    }

    // The accepted base must provably survive the real fitter AND the real
    // commit re-validation, not merely sit above the byte cap by arithmetic.
    const fit = fitMemoryToBudget(candidate)
    if (!fit.ok) continue
    if (fit.memory.current_task?.length !== 512) continue
    const validated = MemoryFileSchema.safeParse(fit.memory)
    if (!validated.success) continue
    if (memorySizeBytes(validated.data) > MEMORY_MAX_BYTES - 100) continue
    return base
  }

  throw new Error("could not construct a deterministic near-cap base for the heuristic path")
}

/** Mocked final-LLM client: deterministic session id, audit id and structured response. */
function finalLlmClient(transcript: TranscriptMessage[]) {
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
  return {
    app: { log: vi.fn() },
    config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
    session: {
      messages: vi.fn(async () => ({ data: transcript })),
      create,
      prompt,
    },
  }
}

/**
 * Probe-verify a final-LLM base: run the full pipeline once in a throwaway
 * worktree whose path has exactly the same length (mkdtemp suffixes always do),
 * so the serialized bytes are identical to the real project path. Returns true
 * only when every intermediate transaction succeeds, the final merge forces the
 * fitter to truncate current_task, and the persisted fitted STATE stays
 * comfortably under the cap.
 */
async function probeFinalLlmOutcomeSafe(base: MemoryFile): Promise<boolean> {
  const probeProject = await worktree()
  if (probeProject.length !== (base.project_path?.length ?? -1)) {
    throw new Error("probe worktree path length differs from the real project path")
  }
  const probeBase = { ...base, project_path: probeProject } as MemoryFile
  await writeMemory({ worktree: probeProject, directory: probeProject, client: undefined }, probeBase)

  const outcome = await writeMemoryOnIdle({
    client: finalLlmClient(assistantOnlyTranscript()),
    worktree: probeProject,
    directory: probeProject,
    sessionId: "b3-final",
  })
  if (outcome !== "llm-success") return false

  const state = await readMemoryState({ worktree: probeProject, directory: probeProject })
  if (state.status !== "ok") return false
  if (state.memory.current_task?.length !== 512) return false
  return memorySizeBytes(state.memory) <= MEMORY_MAX_BYTES - 150
}

/**
 * Deterministic near-cap base for the final-LLM path.
 *
 * The final merge adds a bounded LLM decision, a result-cache row and a
 * protected processed-source proof. Intermediate transactions (heuristic
 * commit, audit guard, model health) must each fit without touching
 * current_task; the final candidate must then push past the cap far enough
 * that the fitter reaches the current_task truncation stage and the fitted
 * state persists comfortably under the cap. Grow disposable seed decisions and
 * probe-verify the complete chain rather than assuming fixed counts/lengths.
 */
async function buildDeterministicFinalLlmBase(project: string): Promise<MemoryFile> {
  for (let decisionLen = 240; decisionLen <= 560; decisionLen += 20) {
    const base = buildBase(project, DECISION_COUNT, decisionLen)
    if (memorySizeBytes(base) >= MEMORY_MAX_BYTES) break
    if (await probeFinalLlmOutcomeSafe(base)) return base
  }
  throw new Error("could not construct a deterministic near-cap base for the final-LLM path")
}

describe("Oracle B3 — HEADER consumes the committed fitted STATE (never value.memory)", () => {
  it("heuristic path: HEADER matches the persisted fitted STATE when the fitter truncates current_task", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()

    // Schema-valid base, just under the cap, with a current_task longer than
    // the creation bound (1800 chars). The candidate produced by the heuristic
    // transaction pushes it over the cap, so the central fitter truncates
    // current_task to 512 before persistence.
    const base = buildDeterministicHeuristicBase(project)
    expect(memorySizeBytes(base)).toBeLessThan(MEMORY_MAX_BYTES)
    await writeMemory({ worktree: project, directory: project, client: undefined }, base)

    // Pre-fit: the exact candidate the fitter will see exceeds the cap.
    const candidate = computeHeuristicCandidate(base, "b3-heuristic", MERGE_TIMESTAMP)
    const preFitBytes = memorySizeBytes(candidate)
    expect(preFitBytes).toBeGreaterThan(MEMORY_MAX_BYTES)

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

    // Post-fit: the persisted fitted STATE stays within the storage cap.
    expect(memorySizeBytes(state.memory)).toBeLessThanOrEqual(MEMORY_MAX_BYTES)

    // The fitter changed current_task: the committed state no longer carries
    // the 1800-char pre-fit candidate.
    expect(state.memory.current_task).not.toBe("t".repeat(CURRENT_TASK_LEN))
    expect(state.memory.current_task?.length).toBe(512)

    // A header must have been generated from the actual fitted committed
    // memory, matching the persisted fitted STATE exactly.
    expect(headerSpy).toHaveBeenCalled()
    const headerMem = headerSpy.mock.calls.at(-1)![2]
    expect(headerMem.current_task).toBe(state.memory.current_task)
    expect(headerMem.current_task).not.toBe("t".repeat(CURRENT_TASK_LEN))
  })

  it("final-LLM path: last HEADER matches the persisted fitted STATE under pressure", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "1")
    const project = await worktree()

    // Base verified by a full-pipeline probe so every intermediate transaction
    // (heuristic commit, audit guard, model health) fits without touching
    // current_task, leaving the pressure that truncates current_task to the
    // final LLM merge.
    const base = await buildDeterministicFinalLlmBase(project)
    expect(memorySizeBytes(base)).toBeLessThan(MEMORY_MAX_BYTES)
    await writeMemory({ worktree: project, directory: project, client: undefined }, base)

    const headerSpy = vi.spyOn(writer, "generateHeader")
    const outcome = await writeMemoryOnIdle({
      client: finalLlmClient(assistantOnlyTranscript()),
      worktree: project,
      directory: project,
      sessionId: "b3-final",
    })

    expect(outcome).toBe("llm-success")

    const state = await readMemoryState({ worktree: project, directory: project })
    expect(state.status).toBe("ok")
    if (state.status !== "ok") throw new Error("expected persisted ok state")

    // Post-fit: the persisted fitted STATE stays within the storage cap.
    expect(memorySizeBytes(state.memory)).toBeLessThanOrEqual(MEMORY_MAX_BYTES)

    // The final merge applied real byte pressure that changed current_task.
    expect(state.memory.current_task).not.toBe("t".repeat(CURRENT_TASK_LEN))
    expect(state.memory.current_task?.length).toBe(512)

    // The last HEADER (the final-LLM one) must be generated from the fitted
    // committed memory and match the persisted fitted STATE.
    expect(headerSpy).toHaveBeenCalled()
    const lastHeaderMem = headerSpy.mock.calls.at(-1)![2]
    expect(lastHeaderMem.current_task).toBe(state.memory.current_task)
    expect(lastHeaderMem.current_task).not.toBe("t".repeat(CURRENT_TASK_LEN))
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
    for (const step of mem.next_steps) {
      expect(step.length).toBeLessThanOrEqual(L.nextStepChars)
    }
    for (const decision of mem.decisions) {
      expect(decision.topic.length).toBeLessThanOrEqual(L.decisionTopicChars)
      expect(decision.decision.length).toBeLessThanOrEqual(L.decisionTextChars)
    }
  })
})
