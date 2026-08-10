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

// ─── PR 3 §5 compatibility repair ────────────────────────────────────────────
// These release-gate tests (implementation-plan §15 item 9) fail on the current
// loadAndMigrate because it passes v3 rows with `extractor="human"` /
// `confidence="human-reviewed"` but no `human_review` record straight through.
// Wave 2 adds the conservative in-memory repair before v3 validation.
describe("PR 3 §5 compatibility repair", () => {
  function unverifiedHumanClaim(id: string, session: string, topic: string, decision: string) {
    return {
      id,
      topic,
      decision,
      rationale: "Best JSON support",
      timestamp: "2026-08-01T00:00:00.000Z",
      session_id: session,
      git_sha: "abc123",
      still_valid: true,
      foundational: true,
      foundational_requested: false,
      provenance: {
        extractor: "human",
        source_session_id: session,
        confidence: "human-reviewed",
        evidence: [{ kind: "transcript", ref: `tr-${id}`, digest: "a".repeat(64) }],
      },
    }
  }

  function v3StateWith(decisions: unknown[]): Record<string, unknown> {
    return {
      version: 3,
      project_path: "/test/project",
      last_updated: "2026-08-08T12:00:00.000Z",
      last_git_sha: "abc123",
      last_session_id: "session-v3",
      active_files: [],
      decisions,
      blockers: [],
      next_steps: [],
      recent_sessions: [],
    }
  }

  it("9. pre-PR3 human-reviewed row without human_review is reclassified on load", () => {
    const result = loadAndMigrate(v3StateWith([
      unverifiedHumanClaim("d-human", "sess-human", "database", "Use Postgres"),
    ]))

    expect(result).not.toBeNull()
    const d = result!.decisions[0]!
    // The unverified claim is conservatively reclassified for review.
    expect(d.foundational).toBe(false)
    expect(d.foundational_requested).toBe(true)
    expect(d.provenance?.extractor).toBe("legacy")
    expect(d.provenance?.confidence).toBe("legacy")
    // Preserved identity and source fields.
    expect(d.id).toBe("d-human")
    expect(d.topic).toBe("database")
    expect(d.decision).toBe("Use Postgres")
    expect(d.timestamp).toBe("2026-08-01T00:00:00.000Z")
    expect(d.session_id).toBe("sess-human")
    // Existing source/evidence references are preserved.
    expect(d.provenance?.evidence).toEqual([
      { kind: "transcript", ref: "tr-d-human", digest: "a".repeat(64) },
    ])
    // The repair must NOT leak transcript or command text.
    expect("transcript" in (d as unknown as Record<string, unknown>)).toBe(false)
    expect("command" in (d as unknown as Record<string, unknown>)).toBe(false)
  })

  it("repairs every pre-PR3 legacy unverified human claim on load", () => {
    const result = loadAndMigrate(v3StateWith([
      unverifiedHumanClaim("d-human-a", "sess-a", "database", "Use Postgres"),
      unverifiedHumanClaim("d-human-b", "sess-b", "auth", "Use JWT"),
    ]))

    expect(result).not.toBeNull()
    expect(result!.decisions).toHaveLength(2)
    for (const d of result!.decisions) {
      expect(d.foundational).toBe(false)
      expect(d.foundational_requested).toBe(true)
      expect(d.provenance?.extractor).toBe("legacy")
      expect(d.provenance?.confidence).toBe("legacy")
    }
    const [first, second] = result!.decisions
    expect(first!.id).toBe("d-human-a")
    expect(second!.id).toBe("d-human-b")
  })
})

// ─── PR 3 wave-9 — duplicate decision-ID migration repair (Blocker 2) ────────
// Pre-PR3 files could contain two rows sharing one id because uniqueness was
// never enforced. `loadAndMigrate` must repair such files deterministically
// BEFORE the v3 schema's uniqueness invariant rejects them: fresh UUIDs for
// every duplicate, lineage rewritten to the canonical (oldest) row, and any
// duplicate group with `human_review` demoted to re-confirmation.
describe("PR 3 wave-9 — duplicate decision-ID repair", () => {
  const llmProvision = (source: string) => ({
    extractor: "llm" as const,
    source_session_id: source,
    source_audit_session_id: `audit-${source}`,
    confidence: "llm-corroborated" as const,
    evidence: [] as never[],
  })

  function v3StateWith(decisions: unknown[]): Record<string, unknown> {
    return {
      version: 3,
      project_path: "/test/project",
      last_updated: "2026-08-08T12:00:00.000Z",
      last_git_sha: "abc123",
      last_session_id: "session-v3",
      active_files: [],
      decisions,
      blockers: [],
      next_steps: [],
      recent_sessions: [],
    }
  }

  it("assigns fresh UUIDs to every duplicate and updates all lineage references to the winner", () => {
    const result = loadAndMigrate(v3StateWith([
      {
        id: "dup", topic: "database", decision: "Use Postgres", timestamp: "2026-08-01T00:00:00.000Z",
        session_id: "s1", still_valid: false, foundational_requested: true, provenance: llmProvision("s1"),
      },
      {
        id: "dup", topic: "database", decision: "Use MySQL", timestamp: "2026-08-02T00:00:00.000Z",
        session_id: "s2", still_valid: true, provenance: llmProvision("s2"),
      },
      {
        id: "hist", topic: "auth", decision: "Use JWT", timestamp: "2026-08-03T00:00:00.000Z",
        session_id: "s3", still_valid: false,
        conflicts_with: ["dup"], superseded_by: "dup", derived_from_decision_id: "dup",
        provenance: llmProvision("s3"),
      },
    ]))

    expect(result).not.toBeNull()
    const ids = result!.decisions.map((d) => d.id)
    // All IDs are unique and the old shared ID is gone.
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain("dup")

    const dbRows = result!.decisions.filter((d) => d.topic === "database")
    expect(dbRows).toHaveLength(2)
    // The deterministically-oldest row ("Use Postgres", timestamp asc) is the
    // canonical winner and receives a fresh UUID.
    const winner = dbRows.find((d) => d.decision === "Use Postgres")!
    expect(winner.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(winner.topic).toBe("database")
    expect(winner.decision).toBe("Use Postgres")
    expect(winner.session_id).toBe("s1")
    // Semantic fields are preserved on the non-winner duplicate too.
    const loser = dbRows.find((d) => d.decision === "Use MySQL")!
    expect(loser.session_id).toBe("s2")
    expect(loser.still_valid).toBe(true)

    // Every lineage reference that pointed at the old shared ID now points at
    // the kept (winner) row's fresh ID.
    const hist = result!.decisions.find((d) => d.id === "hist")!
    expect(hist.conflicts_with).toEqual([winner.id])
    expect(hist.superseded_by).toBe(winner.id)
    expect(hist.derived_from_decision_id).toBe(winner.id)
  })

  it("demotes every duplicate to foundational=false + foundational_requested=true when any row has human_review", () => {
    const humanProvision = {
      extractor: "human" as const,
      source_session_id: "s-h",
      confidence: "human-reviewed" as const,
      evidence: [] as never[],
    }
    const result = loadAndMigrate(v3StateWith([
      {
        id: "dup", topic: "database", decision: "Use Postgres", timestamp: "2026-08-01T00:00:00.000Z",
        session_id: "s1", still_valid: true, foundational: true,
        human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00.000Z" },
        provenance: humanProvision,
      },
      {
        id: "dup", topic: "database", decision: "Use MySQL", timestamp: "2026-08-02T00:00:00.000Z",
        session_id: "s2", still_valid: true, provenance: llmProvision("s2"),
      },
      {
        id: "dup", topic: "database", decision: "Use DynamoDB", timestamp: "2026-08-03T00:00:00.000Z",
        session_id: "s3", still_valid: true, provenance: llmProvision("s3"),
      },
    ]))

    expect(result).not.toBeNull()
    const rows = result!.decisions.filter((d) => d.topic === "database")
    expect(rows).toHaveLength(3)
    const ids = result!.decisions.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    const humanRow = rows.find((d) => d.decision === "Use Postgres")!
    for (const d of rows) {
      // No duplicate may be silently treated as the confirmed human-review
      // target: the whole group must be re-confirmed.
      expect(d.foundational).toBe(false)
      expect(d.foundational_requested).toBe(true)
      expect((d as { human_review?: unknown }).human_review).toBeUndefined()
    }
    // The human trust claim is stripped (legacy downgrade) so the v3
    // human-trust invariant still holds with foundational=false.
    expect(humanRow.provenance?.extractor).toBe("legacy")
    expect(humanRow.provenance?.confidence).toBe("legacy")
    // Non-human duplicates keep their evidence-backed provenance.
    const llmRow = rows.find((d) => d.decision === "Use MySQL")!
    expect(llmRow.provenance?.extractor).toBe("llm")
    expect(llmRow.provenance?.confidence).toBe("llm-corroborated")
  })

  it("updates a duplicate-ID reference that appears inside conflicts_with", () => {
    const result = loadAndMigrate(v3StateWith([
      {
        id: "dup", topic: "database", decision: "Use Postgres", timestamp: "2026-08-01T00:00:00.000Z",
        session_id: "s1", still_valid: false, provenance: llmProvision("s1"),
      },
      {
        id: "dup", topic: "database", decision: "Use MySQL", timestamp: "2026-08-02T00:00:00.000Z",
        session_id: "s2", still_valid: true, provenance: llmProvision("s2"),
      },
      {
        id: "cand", topic: "database", decision: "Use SQLite", timestamp: "2026-08-03T00:00:00.000Z",
        session_id: "s3", still_valid: false, conflicts_with: ["dup", "other"],
        provenance: llmProvision("s3"),
      },
    ]))

    expect(result).not.toBeNull()
    const winner = result!.decisions.find((d) => d.decision === "Use Postgres")!
    const cand = result!.decisions.find((d) => d.id === "cand")!
    // The duplicate reference inside conflicts_with is rewritten to the winner;
    // unrelated references are preserved.
    expect(cand.conflicts_with).toEqual([winner.id, "other"])
  })
})
