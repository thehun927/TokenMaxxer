import { describe, it, expect } from "vitest"
import { loadAndMigrate } from "../../src/memory/migrate"
import { emptyMemory } from "../../src/memory/schema"

describe("loadAndMigrate", () => {
  it("migrates valid v1 data to v2 and preserves its values", () => {
    const v1 = {
      version: 1,
      project_path: "/test/project",
      last_updated: "2026-08-08T12:00:00.000Z",
      last_git_sha: "abc123",
      last_session_id: "session-1",
      current_task: "Implement migration",
      active_files: [],
      decisions: [],
      blockers: ["blocked"],
      next_steps: ["write tests"],
    }
    const result = loadAndMigrate(v1)
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      ...v1,
      version: 2,
      recent_sessions: [],
    })
  })

  it("passes v2 data through unchanged", () => {
    const mem = emptyMemory("/test/project")
    const result = loadAndMigrate(mem)
    expect(result).toEqual(mem)
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
    // Remove optional fields
    const minimal = {
      version: 1,
      project_path: "/test/project",
      last_updated: new Date().toISOString(),
      active_files: [],
      decisions: [],
      blockers: [],
      next_steps: [],
    }
    const result = loadAndMigrate(minimal)
    expect(result).not.toBeNull()
    expect(result!.version).toBe(2)
    expect(result!.recent_sessions).toEqual([])
  })

  it("accepts a v1 memory with full decision fields", () => {
    const mem = emptyMemory("/test/project")
    const full = {
      ...mem,
      version: 1 as const,
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
    expect(result!.version).toBe(2)
    expect(result!.recent_sessions).toEqual([])
    expect(result!.decisions).toHaveLength(1)
    expect(result!.decisions[0]!.topic).toBe("database")
  })
})
