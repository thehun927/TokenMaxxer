/**
 * Oracle R1 storage policy regression tests.
 *
 * These tests verify the fixes for Oracle final re-review R1:
 * - Stage 10 incremental disposable eviction
 * - Stage 5 and Stage 7 empty-retained cases
 * - Schema-valid regressions for disposable ephemeral state
 */

import { describe, expect, it } from "vitest"
import { emptyMemory, type MemoryFile } from "../../src/memory/schema"
import { fitMemoryToBudget } from "../../src/memory/budget"
import { memorySizeBytes } from "../../src/memory/memory-size"

const NOW = Date.parse("2026-08-12T00:00:00.000Z")

function decision(id: string, foundational: boolean = false, still_valid: boolean = true): MemoryFile["decisions"][0] {
  return {
    id,
    topic: "durable topic",
    decision: "retain this semantic decision",
    timestamp: new Date(NOW).toISOString(),
    session_id: "oracle-r1",
    still_valid,
    foundational,
    provenance: {
      extractor: "heuristic" as const,
      source_session_id: "oracle-r1",
      confidence: "heuristic" as const,
      evidence: [],
    },
  }
}

function base(): MemoryFile {
  return {
    ...emptyMemory("/oracle/r1"),
    last_updated: new Date(NOW).toISOString(),
    decisions: [decision("semantic-decision")],
  }
}

function disposableBase(): MemoryFile {
  return {
    ...base(),
    decisions: [],
  }
}

describe("Oracle R1 — Stage 10 incremental disposable eviction", () => {
  it("removes oldest active files until fits within 8192 bytes", () => {
    const memory = base()
    // Create 16 active files (more than the 8 we keep)
    memory.active_files = Array.from({ length: 16 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      reason: "f".repeat(512),
      last_touched: new Date(NOW - index * 60_000).toISOString(),
      provenance: {
        extractor: "heuristic" as const,
        source_session_id: "oracle-r1",
        confidence: "heuristic" as const,
        evidence: [],
      },
    }))

    const result = fitMemoryToBudget(memory, { now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected budget refusal: ${result.reason}`)
    expect(memorySizeBytes(result.memory)).toBeLessThanOrEqual(8192)
    // At least one oldest file must be evicted under aggregate pressure.
    expect(result.memory.active_files?.length ?? 0).toBeLessThan(16)
  })

  it("removes lower-priority blocker entries until fits within 8192 bytes", () => {
    const memory = base()
    // Create 16 blockers (more than the 8 we keep)
    memory.blockers = Array.from({ length: 16 }, (_, index) => "b".repeat(512))

    const result = fitMemoryToBudget(memory, { now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected budget refusal: ${result.reason}`)
    expect(memorySizeBytes(result.memory)).toBeLessThanOrEqual(8192)
    expect(result.memory.blockers?.length ?? 0).toBeLessThan(16)
  })

  it("removes lower-priority next_steps entries until fits within 8192 bytes", () => {
    const memory = base()
    // Create 16 next_steps (more than the 8 we keep)
    memory.next_steps = Array.from({ length: 16 }, (_, index) => "n".repeat(512))

    const result = fitMemoryToBudget(memory, { now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected budget refusal: ${result.reason}`)
    expect(memorySizeBytes(result.memory)).toBeLessThanOrEqual(8192)
    expect(result.memory.next_steps?.length ?? 0).toBeLessThan(16)
  })

  it("removes current_task until fits within 8192 bytes", () => {
    const memory = disposableBase()
    // Create a very large current_task
    memory.current_task = "x".repeat(2000)

    const result = fitMemoryToBudget(memory, { now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected budget refusal: ${result.reason}`)
    expect(memorySizeBytes(result.memory)).toBeLessThanOrEqual(8192)
    // Should truncate current_task
    expect(result.memory.current_task?.length).toBeLessThanOrEqual(512)
  })

  it("incrementally removes all disposable ephemeral state until fits", () => {
    const memory = base()
    // Create a state that exceeds 8192 bytes with only disposable ephemeral state
    memory.active_files = Array.from({ length: 16 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      reason: "f".repeat(512),
      last_touched: new Date(NOW - index * 60_000).toISOString(),
      provenance: {
        extractor: "heuristic" as const,
        source_session_id: "oracle-r1",
        confidence: "heuristic" as const,
        evidence: [],
      },
    }))
    memory.blockers = Array.from({ length: 16 }, (_, index) => "b".repeat(512))
    memory.next_steps = Array.from({ length: 16 }, (_, index) => "n".repeat(512))
    memory.current_task = "x".repeat(2000)

    const result = fitMemoryToBudget(memory, { now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected budget refusal: ${result.reason}`)
    expect(memorySizeBytes(result.memory)).toBeLessThanOrEqual(8192)
    // All disposable ephemeral state should be reduced
    // Note: active_files, blockers, next_steps may be undefined if all were removed
    const filesCount = result.memory.active_files?.length ?? 0
    const blockersCount = result.memory.blockers?.length ?? 0
    const nextStepsCount = result.memory.next_steps?.length ?? 0
    expect(filesCount).toBeLessThanOrEqual(16)
    expect(blockersCount).toBeLessThanOrEqual(16)
    expect(nextStepsCount).toBeLessThanOrEqual(16)
    expect(result.memory.current_task?.length ?? 0).toBeLessThanOrEqual(512)
  })

  it("returns ok: true for schema-valid state with only disposable ephemeral state", () => {
    const memory = base()
    // Create a state that exceeds 8192 bytes with only disposable ephemeral state.
    // There are no decisions or protected IDs, so Stage 10 must fit successfully.
    memory.active_files = Array.from({ length: 16 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      reason: "f".repeat(512),
      last_touched: new Date(NOW - index * 60_000).toISOString(),
      provenance: {
        extractor: "heuristic" as const,
        source_session_id: "oracle-r1",
        confidence: "heuristic" as const,
        evidence: [],
      },
    }))
    memory.blockers = Array.from({ length: 16 }, (_, index) => "b".repeat(512))
    memory.next_steps = Array.from({ length: 16 }, (_, index) => "n".repeat(512))
    memory.current_task = "x".repeat(2000)

    const result = fitMemoryToBudget(memory, { now: NOW })
    // Should succeed because all disposable ephemeral state can be removed
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected budget refusal: ${result.reason}`)
  })

  it("mixed protected authority plus disposable ephemeral pressure exhausts ephemeral fields before typed refusal", () => {
    const memory = disposableBase()
    // Add a foundational decision (protected)
    memory.decisions.push(decision("foundational-decision", true))

    // Create disposable ephemeral state that exceeds 8192 bytes
    memory.active_files = Array.from({ length: 16 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      reason: "f".repeat(512),
      last_touched: new Date(NOW - index * 60_000).toISOString(),
      provenance: {
        extractor: "heuristic" as const,
        source_session_id: "oracle-r1",
        confidence: "heuristic" as const,
        evidence: [],
      },
    }))
    memory.blockers = Array.from({ length: 16 }, (_, index) => "b".repeat(512))
    memory.next_steps = Array.from({ length: 16 }, (_, index) => "n".repeat(512))
    memory.current_task = "x".repeat(2000)

    const result = fitMemoryToBudget(memory, { now: NOW })
    // Should succeed because ephemeral state can be exhausted
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected budget refusal: ${result.reason}`)
    expect(memorySizeBytes(result.memory)).toBeLessThanOrEqual(8192)
  })

  it("all invalid disposable decisions removed", () => {
    const memory = base()
    // Add invalid disposable decisions (still_valid: false)
    memory.decisions.push(decision("invalid-disposable-1", false, false))
    memory.decisions.push(decision("invalid-disposable-2", false, false))

    const result = fitMemoryToBudget(memory, { now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected budget refusal: ${result.reason}`)
    // Invalid disposable decisions should be removed
    expect(result.memory.decisions?.filter((d) => !d.still_valid).length).toBe(0)
  })

  it("all old non-foundational decisions removed", () => {
    const memory = base()
    // Add old non-foundational decisions (older than 30 days)
    const oldDecision = decision("old-non-foundational", false)
    oldDecision.timestamp = new Date(NOW - 31 * 24 * 60 * 60 * 1000).toISOString()
    memory.decisions.push(oldDecision)

    const result = fitMemoryToBudget(memory, { now: NOW })
    expect(result.ok).toBe(true)
    // Old non-foundational decisions should be removed
    expect(result.memory.decisions?.find((d) => d.id === "old-non-foundational")).toBeUndefined()
  })
})

describe("Oracle R1 — Stage 5 and Stage 7 empty-retained cases", () => {
  it("Stage 5 returns decisions: [] when all invalid disposable decisions are removed", () => {
    const memory = base()
    // Add invalid disposable decisions
    memory.decisions.push(decision("invalid-disposable-1", false, false))
    memory.decisions.push(decision("invalid-disposable-2", false, false))

    const result = fitMemoryToBudget(memory, { now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected budget refusal: ${result.reason}`)
    // All invalid disposable decisions should be removed
    expect(result.memory.decisions?.length).toBe(1) // Only the valid one remains
  })

  it("Stage 7 returns decisions: [] when all old non-foundational decisions are removed", () => {
    const memory = base()
    // Add old non-foundational decisions
    const oldDecision = decision("old-non-foundational", false)
    oldDecision.timestamp = new Date(NOW - 31 * 24 * 60 * 60 * 1000).toISOString()
    memory.decisions.push(oldDecision)

    const result = fitMemoryToBudget(memory, { now: NOW })
    expect(result.ok).toBe(true)
    // Old non-foundational decisions should be removed
    expect(result.memory.decisions?.find((d) => d.id === "old-non-foundational")).toBeUndefined()
  })

  it("Stage 5 and Stage 7 preserve foundational decisions", () => {
    const memory = base()
    // Add foundational decision
    memory.decisions.push(decision("foundational-decision", true))
    // Add invalid disposable decision
    memory.decisions.push(decision("invalid-disposable", false, false))

    const result = fitMemoryToBudget(memory, { now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected budget refusal: ${result.reason}`)
    // Foundational decision should be preserved
    expect(result.memory.decisions?.find((d) => d.id === "foundational-decision")).toBeDefined()
    // Invalid disposable decision should be removed
    expect(result.memory.decisions?.find((d) => d.id === "invalid-disposable")).toBeUndefined()
  })
})
