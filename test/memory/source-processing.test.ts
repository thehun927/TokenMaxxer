import { describe, expect, it } from "vitest"
import {
  findProcessedSource,
  upsertProcessedSource,
  removeOldestProcessedSource,
} from "../../src/memory/source-processing"
import { emptyMemory, ProcessedSourceSchema } from "../../src/memory/schema"
import { MAX_PROCESSED_SOURCES } from "../../src/memory/schema"

function makeProcessedSource(overrides: Record<string, unknown> = {}): Parameters<typeof ProcessedSourceSchema.parse>[0] {
  return {
    source_key: "v2s:" + "a".repeat(64),
    extraction_key: "v2e:" + "b".repeat(64),
    extraction_contract_version: 2,
    completed_at: "2026-08-11T00:00:00.000Z",
    ...overrides,
  }
}

describe("findProcessedSource", () => {
  it("returns null for empty memory", () => {
    const memory = emptyMemory("/project")
    const result = findProcessedSource(memory, "v2s:" + "a".repeat(64))
    expect(result).toBeNull()
  })

  it("returns null when source_key not found", () => {
    const memory = {
      ...emptyMemory("/project"),
      processed_sources: [makeProcessedSource({ source_key: "v2s:" + "c".repeat(64) })],
    }
    const result = findProcessedSource(memory, "v2s:" + "a".repeat(64))
    expect(result).toBeNull()
  })

  it("returns the record when source_key matches", () => {
    const sourceKey = "v2s:" + "a".repeat(64)
    const memory = {
      ...emptyMemory("/project"),
      processed_sources: [makeProcessedSource({ source_key: sourceKey })],
    }
    const result = findProcessedSource(memory, sourceKey)
    expect(result).not.toBeNull()
    expect(result?.source_key).toBe(sourceKey)
  })
})

describe("upsertProcessedSource", () => {
  it("appends a new record when source_key is new", () => {
    const memory = emptyMemory("/project")
    const record = makeProcessedSource()
    const result = upsertProcessedSource(memory, record)
    expect(result.processed_sources).toHaveLength(1)
    expect(result.processed_sources[0]?.source_key).toBe(record.source_key)
  })

  it("replaces existing record when source_key matches", () => {
    const sourceKey = "v2s:" + "a".repeat(64)
    const memory = {
      ...emptyMemory("/project"),
      processed_sources: [makeProcessedSource({ source_key: sourceKey, extraction_contract_version: 1 })],
    }
    const newRecord = makeProcessedSource({ source_key: sourceKey, extraction_contract_version: 2 })
    const result = upsertProcessedSource(memory, newRecord)
    expect(result.processed_sources).toHaveLength(1)
    expect(result.processed_sources[0]?.extraction_contract_version).toBe(2)
  })

  it("removes oldest when appending exceeds MAX_PROCESSED_SOURCES", () => {
    const memory = {
      ...emptyMemory("/project"),
      processed_sources: Array.from({ length: MAX_PROCESSED_SOURCES }, (_, i) => {
        // Create valid 64-char hex keys: use 'a' for first 63 chars, then digit for last
        const lastChar = i.toString().slice(-1)
        const sourceKey = "v2s:" + "a".repeat(63) + lastChar
        return makeProcessedSource({
          source_key: sourceKey,
          completed_at: `2026-08-1${i}T00:00:00.000Z`,
        })
      }),
    }
    const newRecord = makeProcessedSource({
      source_key: "v2s:" + "f".repeat(64), // 'f' is valid hex
      completed_at: "2026-08-12T00:00:00.000Z",
    })
    const result = upsertProcessedSource(memory, newRecord)
    expect(result.processed_sources).toHaveLength(MAX_PROCESSED_SOURCES)
    // The oldest (earliest completed_at) should be removed
    const sourceKeys = result.processed_sources.map(s => s.source_key)
    // The oldest entry (i=0, completed_at 2026-08-10) should be removed
    expect(sourceKeys).not.toContain("v2s:" + "a".repeat(63) + "0")
  })

  it("does not mutate the original memory", () => {
    const memory = emptyMemory("/project")
    const record = makeProcessedSource()
    const result = upsertProcessedSource(memory, record)
    expect(memory.processed_sources).toHaveLength(0)
    expect(result.processed_sources).toHaveLength(1)
  })
})

describe("removeOldestProcessedSource", () => {
  it("returns unchanged memory when empty", () => {
    const memory = emptyMemory("/project")
    const result = removeOldestProcessedSource(memory, 5)
    expect(result.processed_sources).toEqual([])
  })

  it("returns unchanged memory when count >= length", () => {
    const memory = {
      ...emptyMemory("/project"),
      processed_sources: [makeProcessedSource()],
    }
    const result = removeOldestProcessedSource(memory, 5)
    expect(result.processed_sources).toHaveLength(1)
  })

  it("keeps the newest keepCount entries", () => {
    const memory = {
      ...emptyMemory("/project"),
      processed_sources: Array.from({ length: 5 }, (_, i) =>
        makeProcessedSource({
          source_key: "v2s:" + "a".repeat(63) + i.toString().slice(-1),
          completed_at: `2026-08-1${i}T00:00:00.000Z`,
        }),
      ),
    }
    const result = removeOldestProcessedSource(memory, 3)
    expect(result.processed_sources).toHaveLength(3)
    // Should keep the newest (highest index)
    const sourceKeys = result.processed_sources.map(s => s.source_key)
    expect(sourceKeys).toContain("v2s:" + "a".repeat(63) + "4")
    expect(sourceKeys).toContain("v2s:" + "a".repeat(63) + "3")
    expect(sourceKeys).toContain("v2s:" + "a".repeat(63) + "2")
  })

  it("removes oldest by completed_at ascending order", () => {
    const memory = {
      ...emptyMemory("/project"),
      processed_sources: [
        makeProcessedSource({
          source_key: "v2s:" + "a".repeat(63) + "0",
          completed_at: "2026-08-01T00:00:00.000Z",
        }),
        makeProcessedSource({
          source_key: "v2s:" + "a".repeat(63) + "1",
          completed_at: "2026-08-10T00:00:00.000Z",
        }),
      ],
    }
    const result = removeOldestProcessedSource(memory, 1)
    expect(result.processed_sources).toHaveLength(1)
    expect(result.processed_sources[0]?.source_key).toContain("1")
  })

  it("preserves original order for equal completed_at", () => {
    const memory = {
      ...emptyMemory("/project"),
      processed_sources: [
        makeProcessedSource({
          source_key: "v2s:" + "a".repeat(63) + "0",
          completed_at: "2026-08-11T00:00:00.000Z",
        }),
        makeProcessedSource({
          source_key: "v2s:" + "a".repeat(63) + "1",
          completed_at: "2026-08-11T00:00:00.000Z",
        }),
      ],
    }
    const result = removeOldestProcessedSource(memory, 1)
    expect(result.processed_sources).toHaveLength(1)
    // When timestamps are equal, stable sort preserves original order.
    // After sorting ascending, index 0 comes before index 1.
    // We keep the last entry (newest), which is index 1 (higher original index).
    expect(result.processed_sources[0]?.source_key).toContain("1")
  })
})