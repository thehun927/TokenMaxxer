import { describe, it, expect } from "vitest"
import { loadAndMigrate } from "../../src/memory/migrate"
import { emptyMemory } from "../../src/memory/schema"

describe("loadAndMigrate", () => {
  it("passes v1 data through (identity)", () => {
    const mem = emptyMemory("/test/project")
    const result = loadAndMigrate(mem)
    expect(result).not.toBeNull()
    expect(result!.version).toBe(1)
    expect(result!.project_path).toBe("/test/project")
  })

  it("returns null for null input", () => {
    expect(loadAndMigrate(null)).toBeNull()
  })

  it("returns null for undefined input", () => {
    expect(loadAndMigrate(undefined)).toBeNull()
  })

  it("returns null for non-object input", () => {
    expect(loadAndMigrate("string")).toBeNull()
    expect(loadAndMigrate(42)).toBeNull()
    expect(loadAndMigrate(true)).toBeNull()
  })

  it("returns null for corrupt data (valid JSON, wrong shape)", () => {
    expect(loadAndMigrate({ foo: "bar" })).toBeNull()
    expect(loadAndMigrate({ version: 1, project_path: 123 })).toBeNull()
    expect(loadAndMigrate({})).toBeNull()
  })

  it("returns null for missing version field (version 0 has no migration)", () => {
    // A well-formed object but with version missing — treated as version 0
    const data = {
      project_path: "/test",
      last_updated: new Date().toISOString(),
      active_files: [],
      decisions: [],
      blockers: [],
      next_steps: [],
    }
    expect(loadAndMigrate(data)).toBeNull()
  })

  it("returns null for unknown version", () => {
    const mem = emptyMemory("/test/project")
    const data = { ...mem, version: 99 }
    expect(loadAndMigrate(data)).toBeNull()
  })

  it("accepts a v1 memory with optional fields omitted", () => {
    const mem = emptyMemory("/test/project")
    // Remove optional fields
    const minimal = {
      version: 1,
      project_path: mem.project_path,
      last_updated: mem.last_updated,
      active_files: [],
      decisions: [],
      blockers: [],
      next_steps: [],
    }
    const result = loadAndMigrate(minimal)
    expect(result).not.toBeNull()
    expect(result!.version).toBe(1)
  })

  it("accepts a v1 memory with full decision fields", () => {
    const mem = emptyMemory("/test/project")
    const full = {
      ...mem,
      decisions: [{
        id: "d1",
        topic: "database",
        decision: "Use Postgres",
        rationale: "Better JSON support",
        timestamp: new Date().toISOString(),
        session_id: "s1",
        still_valid: true,
        foundational: false,
        last_used_in_session: "s1",
      }],
    }
    const result = loadAndMigrate(full)
    expect(result).not.toBeNull()
    expect(result!.decisions).toHaveLength(1)
    expect(result!.decisions[0]!.topic).toBe("database")
  })
})
