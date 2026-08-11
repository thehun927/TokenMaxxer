/**
 * Processed-source completion ledger operations.
 * Provides find, upsert, and prune operations for the processed_sources array.
 */
import type { MemoryFile, ProcessedSource } from "./schema"
import { MAX_PROCESSED_SOURCES, ProcessedSourceSchema } from "./schema"

/**
 * Find a processed source record by its source_key.
 * Returns null if not found.
 */
export function findProcessedSource(
  memory: MemoryFile,
  sourceVersionKey: string,
): ProcessedSource | null {
  const sources = memory.processed_sources ?? []
  for (const record of sources) {
    if (record.source_key === sourceVersionKey) {
      return record
    }
  }
  return null
}

/**
 * Upsert a processed source record.
 * If a record with the same source_key exists, it is replaced.
 * Otherwise, the record is appended.
 * If the array length exceeds MAX_PROCESSED_SOURCES after append,
 * the OLDEST entry is removed (by completed_at ascending, then original order).
 */
export function upsertProcessedSource(
  memory: MemoryFile,
  record: ProcessedSource,
): MemoryFile {
  // Validate the record first
  const parsed = ProcessedSourceSchema.safeParse(record)
  if (!parsed.success) {
    // Return unchanged if the record is invalid
    return memory
  }

  let sources = [...(memory.processed_sources ?? [])]

  // Check if a record with the same source_key exists
  const existingIndex = sources.findIndex((s) => s.source_key === record.source_key)

  if (existingIndex >= 0) {
    // Replace existing record
    sources[existingIndex] = record
  } else {
    // Append new record
    sources.push(record)

    // If we exceed MAX_PROCESSED_SOURCES, remove the oldest
    if (sources.length > MAX_PROCESSED_SOURCES) {
      // Sort by completed_at ascending (oldest first), preserving original order for ties
      const indexed = sources.map((s, i) => ({ s, originalIndex: i }))
      indexed.sort((a, b) => {
        const timeCompare = a.s.completed_at.localeCompare(b.s.completed_at)
        if (timeCompare !== 0) return timeCompare
        // For equal timestamps, preserve original order (lower index first)
        return a.originalIndex - b.originalIndex
      })
      // Remove the oldest (first after sort)
      sources = indexed.slice(1).map(({ s }) => s)
    }
  }

  return {
    ...memory,
    processed_sources: sources,
  }
}

/**
 * Remove the oldest processed source records, keeping only the most recent keepCount.
 * Records are sorted by completed_at ascending, then original order is preserved
 * for equal timestamps.
 */
export function removeOldestProcessedSource(
  memory: MemoryFile,
  keepCount: number,
): MemoryFile {
  const sources = memory.processed_sources ?? []

  if (sources.length <= keepCount) {
    return memory
  }

  // Sort by completed_at ascending (oldest first), preserving original order for ties
  // For equal timestamps, lower original index comes first (stable sort)
  const indexed = sources.map((s, i) => ({ s, originalIndex: i }))
  indexed.sort((a, b) => {
    const timeCompare = a.s.completed_at.localeCompare(b.s.completed_at)
    if (timeCompare !== 0) return timeCompare
    // For equal timestamps, preserve original order (lower index first)
    return a.originalIndex - b.originalIndex
  })

  // Remove the oldest entries (from the beginning after sort)
  // Keep the newest keepCount entries (from the end after sort)
  // For equal timestamps, the entry with lower original index is "older" (comes first in sort)
  // So we remove from the beginning and keep from the end
  const toRemove = sources.length - keepCount
  const kept = indexed.slice(toRemove).map(({ s }) => s)

  return {
    ...memory,
    processed_sources: kept,
  }
}