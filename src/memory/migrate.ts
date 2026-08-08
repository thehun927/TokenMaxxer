/**
 * Schema migration for MemoryFile.
 * Handles loading raw data from disk and migrating to the current version.
 */
import { MemoryFileSchema, type MemoryFile } from "./schema"

/**
 * Migration functions keyed by *from* version.
 * v1 is identity — no migration needed yet, but the pattern is established.
 * To add a v1→v2 migration: add an entry at key 1.
 */
const migrations: Record<number, (data: Record<string, unknown>) => Record<string, unknown>> = {
  // 1: (d) => d,  // v1 is identity — no migration needed
}

/**
 * Load a raw parsed JSON value and migrate it to the current MemoryFile schema.
 * Returns null for invalid/corrupt data, unknown versions, or missing version.
 */
export function loadAndMigrate(raw: unknown): MemoryFile | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== "object") return null

  const obj = raw as Record<string, unknown>
  const version = (typeof obj.version === "number" ? obj.version : 0) as number

  let data = obj
  for (let v = version; v < 1; v++) {
    const fn = migrations[v]
    if (!fn) {
      // Unknown version — can't migrate
      return null
    }
    data = fn(data)
  }

  const parsed = MemoryFileSchema.safeParse(data)
  if (!parsed.success) {
    // Corrupt or invalid shape — return null, caller handles
    return null
  }
  return parsed.data
}
