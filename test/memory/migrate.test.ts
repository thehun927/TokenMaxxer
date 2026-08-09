import { describe, it, expect } from "vitest"
import { loadAndMigrate } from "../../src/memory/migrate"
import { emptyMemory } from "../../src/memory/schema"
import { readExtractionCache } from "../../src/memory/extract-llm"

describe("loadAndMigrate", () => {
  it("migrates valid v1 data to v3 and preserves its values", () => {
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
      version: 3,
      recent_sessions: [],
    })
  })

  it("passes v2 data through unchanged", () => {
    const mem = emptyMemory("/test/project")
    const result = loadAndMigrate(mem)
    expect(result).toEqual(mem)
  })

  it("migrates v2 facts and current-task state with legacy provenance", () => {
    const v2 = {
      version: 2,
      project_path: "/test/project",
      last_updated: "2026-08-08T12:00:00.000Z",
      last_session_id: "session-v2",
      current_task: "Read the old state",
      active_files: [{
        path: "src/old.ts",
        reason: "edited",
        last_touched: "2026-08-08T12:00:00.000Z",
      }],
      decisions: [{
        id: "d-v2",
        topic: "storage",
        decision: "Use Postgres",
        timestamp: "2026-08-08T12:00:00.000Z",
        session_id: "decision-session",
      }],
      blockers: ["none"],
      next_steps: ["verify"],
      recent_sessions: ["session-v2"],
    }

    const result = loadAndMigrate(v2)
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      version: 3,
      project_path: "/test/project",
      current_task: "Read the old state",
      blockers: ["none"],
      next_steps: ["verify"],
      recent_sessions: ["session-v2"],
    })
    expect(result!.active_files[0]!.provenance).toEqual({
      extractor: "legacy",
      source_session_id: "session-v2",
      confidence: "legacy",
      evidence: [],
    })
    expect(result!.decisions[0]!.provenance).toEqual({
      extractor: "legacy",
      source_session_id: "decision-session",
      confidence: "legacy",
      evidence: [],
    })
    expect(result!.current_task_provenance).toEqual({
      extractor: "legacy",
      source_session_id: "session-v2",
      confidence: "legacy",
      evidence: [],
    })
  })

  it("quarantines unproven v2 cache rows and preserves only bounded metadata", () => {
    const cacheEntry = (cacheKey: string) => ({
      cache_key: cacheKey,
      source_session_id: "source-session",
      canonical_input_sha256: "input-digest",
      provider_id: "provider",
      model_id: "model",
      completed_at: "2026-08-08T12:00:00.000Z",
      facts: {
        current_task: null,
        active_files: [],
        decisions: [],
        blockers: [],
        next_steps: [],
      },
    })
    const v2 = {
      version: 2,
      project_path: "/test/project",
      last_updated: "2026-08-08T12:00:00.000Z",
      active_files: [],
      decisions: [],
      blockers: [],
      next_steps: [],
      recent_sessions: [],
      llm_extraction_cache: [cacheEntry("one"), cacheEntry("two")],
    }

    const result = loadAndMigrate(v2)
    expect(result).not.toBeNull()
    expect(result!.llm_extraction_cache).toBeUndefined()
    expect(result!.llm_extraction_cache_quarantine).toEqual({
      count: 2,
      reason: "missing-evidence-backed-provenance",
    })
    expect(readExtractionCache(result, "one")).toBeNull()
  })

  it("retains a v2 cache row only when its provenance is evidence-backed", () => {
    const retained = {
      cache_key: "source:input:provider/model",
      source_session_id: "source-session",
      canonical_input_sha256: "input-digest",
      provider_id: "provider",
      model_id: "model",
      completed_at: "2026-08-08T12:00:00.000Z",
      provenance: {
        extractor: "llm",
        source_session_id: "source-session",
        source_audit_session_id: "audit-session",
        confidence: "llm-corroborated",
        evidence: [{
          kind: "transcript",
          ref: "tr-source",
          digest: "a".repeat(64),
        }],
      },
      facts: {
        current_task: null,
        active_files: [],
        decisions: [{
          topic: "storage",
          decision: "Use Postgres",
          evidence_refs: ["tr-source"],
        }],
        blockers: [],
        next_steps: [],
      },
    }
    const result = loadAndMigrate({
      version: 2,
      project_path: "/test/project",
      last_updated: "2026-08-08T12:00:00.000Z",
      active_files: [],
      decisions: [],
      blockers: [],
      next_steps: [],
      recent_sessions: [],
      llm_extraction_cache: [retained],
    })

    expect(result).not.toBeNull()
    expect(result!.llm_extraction_cache).toHaveLength(1)
    expect(result!.llm_extraction_cache![0]!.provenance).toEqual(retained.provenance)
    expect(result!.llm_extraction_cache_quarantine).toBeUndefined()
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
    expect(result!.version).toBe(3)
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
    expect(result!.version).toBe(3)
    expect(result!.recent_sessions).toEqual([])
    expect(result!.decisions).toHaveLength(1)
    expect(result!.decisions[0]!.topic).toBe("database")
    expect(result!.decisions[0]!.provenance).toEqual({
      extractor: "legacy",
      source_session_id: "s1",
      confidence: "legacy",
      evidence: [],
    })
    expect(result!.decisions[0]!.foundational_requested).toBe(false)
  })
})
