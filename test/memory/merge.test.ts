import { describe, it, expect } from "vitest"
import { mergeMemory } from "../../src/memory/writer"
import { mergeDecisions, mergeLLMDecisionFacts } from "../../src/memory/merge"
import { emptyMemory } from "../../src/memory/schema"
import type { MemoryFile, Decision } from "../../src/memory/schema"
import { loadAndMigrate } from "../../src/memory/migrate"
import { resolveDecisionAuthorities } from "../../src/memory/decision-authority"
import type { ExtractedFacts } from "../../src/types"

const meta = {
  sessionId: "session-1",
  gitSha: "abc123def4567890",
  timestamp: new Date("2026-08-08T12:00:00Z").toISOString(),
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "d1",
    topic: "database",
    decision: "Use Postgres",
    rationale: "Better JSON support",
    timestamp: new Date("2026-08-01T00:00:00Z").toISOString(),
    session_id: "session-0",
    still_valid: true,
    foundational: false,
    ...overrides,
  }
}

function makeExtracted(overrides: Partial<ExtractedFacts> = {}): ExtractedFacts {
  return {
    current_task: null,
    active_files: [],
    decisions: [],
    blockers: [],
    next_steps: [],
    ...overrides,
  }
}

describe("mergeMemory", () => {
  it("LLM decisions-only merge does not alter other top-level fields", () => {
    const existing = {
      ...emptyMemory("/test"),
      current_task: "Existing task",
      active_files: [{ path: "src/main.ts", reason: "edit", last_touched: "2026-08-01T00:00:00Z" }],
      blockers: ["blocker1"],
      next_steps: ["step1"],
      decisions: [],
    };
    const extracted = {
      ...makeExtracted({ decisions: [{ topic: "db", decision: "Use MySQL", evidence_refs: ["tr-1"] }] }),
    };
    const meta = {
      sessionId: "session-1",
      gitSha: "abc123",
      timestamp: new Date().toISOString(),
      origin: "llm" as const,
      auditSessionID: "audit-1",
      evidenceCandidates: {
        "tr-1": {
          kind: "transcript",
          ref: "tr-1",
          digest: "a".repeat(64),
          text: "dummy transcript",
          role: "assistant",
        },
      },
    };
    const result = mergeMemory(existing, extracted, meta);
    expect(result.current_task).toBe(existing.current_task);
    expect(result.active_files).toEqual(existing.active_files);
    expect(result.blockers).toEqual(existing.blockers);
    expect(result.next_steps).toEqual(existing.next_steps);
    expect(result.decisions).toHaveLength(1);
  });
  it("exact topic match (not substring): 'auth' does NOT supersede 'authentication'", () => {
    const existing = {
      ...emptyMemory("/test"),
      decisions: [
        makeDecision({ id: "d-auth", topic: "auth", decision: "Use JWT auth" }),
        makeDecision({ id: "d-authn", topic: "authentication", decision: "Use OAuth2" }),
      ],
    }

    const extracted = makeExtracted({
      decisions: [
        { topic: "auth", decision: "Actually use sessions instead" },
      ],
    })

    const result = mergeMemory(existing, extracted, meta)

    // "auth" should supersede the "auth" decision, but NOT "authentication"
    const authDecisions = result.decisions.filter((d) => d.topic === "auth")
    const authnDecisions = result.decisions.filter((d) => d.topic === "authentication")

    expect(authDecisions).toHaveLength(2) // old + new
    expect(authDecisions.find((d) => d.still_valid)?.decision).toBe("Actually use sessions instead")
    expect(authDecisions.find((d) => !d.still_valid)?.decision).toBe("Use JWT auth")

    // "authentication" should be untouched
    expect(authnDecisions).toHaveLength(1)
    expect(authnDecisions[0]!.still_valid).toBe(true)
    expect(authnDecisions[0]!.decision).toBe("Use OAuth2")
  })

  it("supersession: same topic → old still_valid=false, new still_valid=true", () => {
    const existing = {
      ...emptyMemory("/test"),
      decisions: [
        makeDecision({
          id: "d1",
          topic: "database",
          decision: "Use Postgres",
          still_valid: true,
        }),
      ],
    }

    const extracted = makeExtracted({
      decisions: [
        { topic: "database", decision: "Use MySQL instead" },
      ],
    })

    const result = mergeMemory(existing, extracted, meta)

    expect(result.decisions).toHaveLength(2)

    const old = result.decisions.find((d) => d.id === "d1")
    const current = result.decisions.filter((d) => d.still_valid)

    expect(old!.still_valid).toBe(false)
    expect(current).toHaveLength(1)
    expect(current[0]!.decision).toBe("Use MySQL instead")
    expect(current[0]!.session_id).toBe("session-1")
  })

  it("current_task: overwrite if extracted has one", () => {
    const existing = {
      ...emptyMemory("/test"),
      current_task: "Old task",
    }

    const extracted = makeExtracted({
      current_task: "New task: build REST API",
    })

    const result = mergeMemory(existing, extracted, meta)
    expect(result.current_task).toBe("New task: build REST API")
  })

  it("current_task: keep existing if extracted is null", () => {
    const existing = {
      ...emptyMemory("/test"),
      current_task: "Old task",
    }

    const extracted = makeExtracted({
      current_task: null,
    })

    const result = mergeMemory(existing, extracted, meta)
    expect(result.current_task).toBe("Old task")
  })

  it("active_files: replace with reason preservation for files in both", () => {
    const existing = {
      ...emptyMemory("/test"),
      active_files: [
        { path: "src/main.ts", reason: "entry point, contains startup logic", last_touched: "2026-08-01T00:00:00Z" },
        { path: "src/auth.ts", reason: "complex auth logic", last_touched: "2026-08-01T00:00:00Z" },
      ],
    }

    const extracted = makeExtracted({
      active_files: [
        { path: "src/main.ts", reason: "read once" },
        { path: "src/auth.ts", reason: "edited 5 times" },
        { path: "src/new.ts", reason: "read once" },
      ],
    })

    const result = mergeMemory(existing, extracted, meta)

    expect(result.active_files).toHaveLength(3)

    // src/main.ts: new reason is generic "read once", should preserve old
    const mainFile = result.active_files.find((f) => f.path === "src/main.ts")
    expect(mainFile!.reason).toBe("entry point, contains startup logic")

    // src/auth.ts: new reason is specific "edited 5 times", should use new
    const authFile = result.active_files.find((f) => f.path === "src/auth.ts")
    expect(authFile!.reason).toBe("complex auth logic") // old reason beats generic non-"read once" / non-"edited N"

    // src/new.ts: new file, should have its reason
    const newFile = result.active_files.find((f) => f.path === "src/new.ts")
    expect(newFile!.reason).toBe("read once")
  })

  it("blockers and next_steps are overwritten", () => {
    const existing = {
      ...emptyMemory("/test"),
      blockers: ["old blocker"],
      next_steps: ["old step"],
    }

    const extracted = makeExtracted({
      blockers: ["new blocker: waiting on API key"],
      next_steps: ["1. Set up CI", "2. Write tests"],
    })

    const result = mergeMemory(existing, extracted, meta)

    expect(result.blockers).toEqual(["new blocker: waiting on API key"])
    expect(result.next_steps).toEqual(["1. Set up CI", "2. Write tests"])
  })

  it("metadata: sets last_updated, last_session_id, last_git_sha", () => {
    const existing = emptyMemory("/test")
    const extracted = makeExtracted({
      current_task: "New task",
    })

    const result = mergeMemory(existing, extracted, meta)

    expect(result.last_updated).toBe(meta.timestamp)
    expect(result.last_session_id).toBe(meta.sessionId)
    expect(result.last_git_sha).toBe(meta.gitSha)
  })

  it("preserves git_sha from existing if new is null", () => {
    const existing = {
      ...emptyMemory("/test"),
      last_git_sha: "existing-sha",
    }

    const extracted = makeExtracted({ current_task: "Something" })

    const result = mergeMemory(existing, extracted, {
      ...meta,
      gitSha: null,
    })

    expect(result.last_git_sha).toBe("existing-sha")
  })

  it("property test: merge never loses a decision that wasn't superseded", () => {
    const existing = {
      ...emptyMemory("/test"),
      decisions: [
        makeDecision({ id: "d1", topic: "database", decision: "Use Postgres" }),
        makeDecision({ id: "d2", topic: "framework", decision: "Use Express" }),
        makeDecision({ id: "d3", topic: "testing", decision: "Use Vitest" }),
      ],
    }

    const extracted = makeExtracted({
      decisions: [
        { topic: "database", decision: "Use MySQL instead" },
      ],
    })

    const result = mergeMemory(existing, extracted, meta)

    // d1 superseded → still_valid=false, d2 and d3 untouched
    const d1 = result.decisions.find((d) => d.id === "d1")
    const d2 = result.decisions.find((d) => d.id === "d2")
    const d3 = result.decisions.find((d) => d.id === "d3")

    expect(d1!.still_valid).toBe(false)
    expect(d2!.still_valid).toBe(true)
    expect(d2!.decision).toBe("Use Express")
    expect(d3!.still_valid).toBe(true)
    expect(d3!.decision).toBe("Use Vitest")
  })

  it("does not let an LLM conflict displace a corroborated heuristic decision", () => {
    const heuristic = makeDecision({
      id: "heuristic-1",
      provenance: {
        extractor: "heuristic",
        source_session_id: "session-heuristic",
        confidence: "heuristic",
        evidence: [{ kind: "heuristic-candidate", ref: "hc-1", digest: "a".repeat(64) }],
      },
    })
    const existing = { ...emptyMemory("/test"), decisions: [heuristic] }
    const extracted = makeExtracted({
      decisions: [{
        topic: "database",
        decision: "Use MySQL instead",
        evidence_refs: ["tr-1"],
      } as never],
    })

    const result = mergeMemory(existing, extracted, {
      ...meta,
      origin: "llm",
      auditSessionID: "audit-1",
      evidenceCandidates: {
        "tr-1": { kind: "transcript", ref: "tr-1", digest: "b".repeat(64) },
      },
    })

    expect(result.decisions.find((d) => d.id === "heuristic-1")).toMatchObject({
      still_valid: true,
      provenance: { extractor: "heuristic" },
    })
    expect(result.decisions.find((d) => d.decision === "Use MySQL instead")).toMatchObject({
      still_valid: false,
      provenance: {
        extractor: "llm",
        source_audit_session_id: "audit-1",
        confidence: "llm-corroborated",
      },
    })
  })
})

// ─── PR 3 §7 merge semantics ─────────────────────────────────────────────────
// These release-gate tests (implementation-plan §15 items 11-18) fail on the
// current mergeMemory because it reasons over a one-index topic map and appends
// a second valid row on corroboration instead of enriching one stable ID. Wave 4
// extracts mergeDecisions() and implements the rules these tests pin down.
describe("PR 3 §7 merge semantics", () => {
  const heuristicProvenance = {
    extractor: "heuristic" as const,
    source_session_id: "session-heuristic",
    confidence: "heuristic" as const,
    evidence: [] as never[],
  }

  // Allows seeding the not-yet-shipped PR 3 fields (superseded_by,
  // conflicts_with, human_review) without TypeScript rejecting them.
  function pr3Decision(overrides: Record<string, unknown> & Partial<Decision> = {}): Decision {
    return makeDecision(overrides) as Decision
  }

  function lineageOf(d: Decision | undefined): { superseded_by?: string; conflicts_with?: string[] } {
    return (d ?? {}) as { superseded_by?: string; conflicts_with?: string[] }
  }

  const llmMeta = {
    ...meta,
    origin: "llm" as const,
    auditSessionID: "audit-1",
    evidenceCandidates: {
      "tr-1": { kind: "transcript" as const, ref: "tr-1", digest: "b".repeat(64) },
    },
  }

  it("11. heuristic equivalent observation does not create a duplicate authority", () => {
    const existing = {
      ...emptyMemory("/test"),
      decisions: [
        pr3Decision({
          id: "h1",
          topic: "database",
          decision: "Use Postgres",
          provenance: heuristicProvenance,
          foundational_requested: false,
        }),
      ],
    }

    const result = mergeMemory(existing, makeExtracted({
      decisions: [{ topic: "database", decision: "Use Postgres" }],
    }), meta)

    const valid = result.decisions.filter((d) => d.topic === "database" && d.still_valid)
    expect(valid).toHaveLength(1)
    // The prior row's stable ID is preserved; corroboration does not churn it.
    expect(valid[0]!.id).toBe("h1")
  })

  it("12. heuristic conflict supersedes all prior valid non-human same-topic rows", () => {
    const existing = {
      ...emptyMemory("/test"),
      decisions: [
        pr3Decision({ id: "legacy-a", topic: "database", decision: "Use Postgres", provenance: heuristicProvenance }),
        pr3Decision({ id: "legacy-b", topic: "database", decision: "Use MySQL", provenance: heuristicProvenance }),
      ],
    }

    const result = mergeMemory(existing, makeExtracted({
      decisions: [{ topic: "database", decision: "Use DynamoDB" }],
    }), meta)

    const db = result.decisions.filter((d) => d.topic === "database")
    const valid = db.filter((d) => d.still_valid)
    // A later heuristic conflict must supersede BOTH prior valid rows, not
    // only the one mapped index that the current one-entry topic map keeps.
    expect(valid).toHaveLength(1)
    const newId = valid[0]!.id
    expect(newId).not.toBe("legacy-a")
    expect(newId).not.toBe("legacy-b")
    const priors = db.filter((d) => d.id !== newId)
    expect(priors).toHaveLength(2)
    for (const prior of priors) {
      expect(prior.still_valid).toBe(false)
      expect(lineageOf(prior).superseded_by).toBe(newId)
    }
  })

  it("13. heuristic conflict with trusted human authority creates an invalid candidate", () => {
    const existing = {
      ...emptyMemory("/test"),
      decisions: [
        pr3Decision({
          id: "human-1",
          topic: "database",
          decision: "Use Postgres",
          still_valid: true,
          foundational: true,
          foundational_requested: false,
          human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
          provenance: {
            extractor: "human",
            source_session_id: "s-human",
            confidence: "human-reviewed",
            evidence: [],
          },
        }),
      ],
    }

    const result = mergeMemory(existing, makeExtracted({
      decisions: [{ topic: "database", decision: "Use DynamoDB" }],
    }), meta)

    const human = result.decisions.find((d) => d.id === "human-1")!
    expect(human.still_valid).toBe(true)
    expect(human.foundational).toBe(true)

    const candidate = result.decisions.find((d) => d.decision === "Use DynamoDB")!
    expect(candidate.still_valid).toBe(false)
    expect(candidate.foundational).toBe(false)
    expect(lineageOf(candidate).conflicts_with).toEqual(["human-1"])
  })

  it("14. evidence-backed LLM equivalent observation upgrades the same authority in place", () => {
    const existing = {
      ...emptyMemory("/test"),
      decisions: [
        pr3Decision({ id: "h1", topic: "database", decision: "Use Postgres", provenance: heuristicProvenance }),
      ],
    }

    const result = mergeMemory(existing, makeExtracted({
      decisions: [{ topic: "database", decision: "Use Postgres", evidence_refs: ["tr-1"] } as never],
    }), llmMeta)

    const valid = result.decisions.filter((d) => d.topic === "database" && d.still_valid)
    // Corroboration enriches the one stable authority instead of appending a
    // second valid LLM row beside the still-valid heuristic.
    expect(valid).toHaveLength(1)
    expect(valid[0]!.id).toBe("h1")
    expect(valid[0]!.provenance?.extractor).toBe("llm")
    expect(valid[0]!.provenance?.confidence).toBe("llm-corroborated")
  })

  it("15. LLM conflict with heuristic authority remains an invalid conflict candidate", () => {
    const existing = {
      ...emptyMemory("/test"),
      decisions: [
        pr3Decision({ id: "h1", topic: "database", decision: "Use Postgres", provenance: heuristicProvenance }),
      ],
    }

    const result = mergeMemory(existing, makeExtracted({
      decisions: [{ topic: "database", decision: "Use MySQL", evidence_refs: ["tr-1"] } as never],
    }), llmMeta)

    const h = result.decisions.find((d) => d.id === "h1")!
    expect(h.still_valid).toBe(true)

    const llmRow = result.decisions.find((d) => d.provenance?.extractor === "llm")!
    expect(llmRow.still_valid).toBe(false)
    expect(lineageOf(llmRow).conflicts_with).toEqual(["h1"])
  })

  it("16. LLM conflict with trusted human authority remains an invalid conflict candidate", () => {
    const existing = {
      ...emptyMemory("/test"),
      decisions: [
        pr3Decision({
          id: "human-1",
          topic: "database",
          decision: "Use Postgres",
          still_valid: true,
          foundational: true,
          foundational_requested: false,
          human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
          provenance: {
            extractor: "human",
            source_session_id: "s-human",
            confidence: "human-reviewed",
            evidence: [],
          },
        }),
      ],
    }

    const result = mergeMemory(existing, makeExtracted({
      decisions: [{ topic: "database", decision: "Use MySQL", evidence_refs: ["tr-1"] } as never],
    }), llmMeta)

    const human = result.decisions.find((d) => d.id === "human-1")!
    expect(human.still_valid).toBe(true)
    expect(human.foundational).toBe(true)

    const llmRow = result.decisions.find((d) => d.provenance?.extractor === "llm")!
    expect(llmRow.still_valid).toBe(false)
    expect(lineageOf(llmRow).conflicts_with).toEqual(["human-1"])
  })

  it("17. evidence-backed LLM conflict may supersede legacy-only authority", () => {
    const existing = {
      ...emptyMemory("/test"),
      decisions: [
        pr3Decision({
          id: "legacy-1",
          topic: "database",
          decision: "Use Postgres",
          provenance: {
            extractor: "legacy",
            source_session_id: "s-legacy",
            confidence: "legacy",
            evidence: [],
          },
        }),
      ],
    }

    const result = mergeMemory(existing, makeExtracted({
      decisions: [{ topic: "database", decision: "Use DynamoDB", evidence_refs: ["tr-1"] } as never],
    }), llmMeta)

    const legacy = result.decisions.find((d) => d.id === "legacy-1")!
    expect(legacy.still_valid).toBe(false)

    const llmRow = result.decisions.find((d) => d.provenance?.extractor === "llm")!
    expect(llmRow.still_valid).toBe(true)
    expect(lineageOf(legacy).superseded_by).toBe(llmRow.id)
  })

  it("18. extraction foundational signal only sets foundational_requested", () => {
    const result = mergeMemory(emptyMemory("/test"), makeExtracted({
      decisions: [{ topic: "database", decision: "Use Postgres", foundational: true }],
    }), meta)

    const target = result.decisions[0]!
    expect(target.foundational_requested).toBe(true)
    expect(target.foundational).toBe(false)
    expect(target.provenance?.extractor).not.toBe("human")
  })
})

// ─── PR 3 wave-9 — durable human conflict quarantine (Blocker 1) ─────────────
// The oracle Block verdict's first blocker: `mergeDecisions()` discarded the
// initial `resolveDecisionAuthorities` conflicts, so an unresolved
// conflicting-human topic lost its quarantine on the next write and automation
// could mint a new authority for it. These tests pin the durable quarantine:
// the conflict survives empty merges, heuristic and LLM automation cannot
// create an authority, and persist/reload cycles never evaporate it.
describe("PR 3 wave-9 — durable human conflict quarantine", () => {
  const heuristicProvenance = {
    extractor: "heuristic" as const,
    source_session_id: "session-heuristic",
    confidence: "heuristic" as const,
    evidence: [] as never[],
  }
  const llmProvenance = {
    extractor: "llm" as const,
    source_session_id: "session-llm",
    source_audit_session_id: "audit-llm",
    confidence: "llm-corroborated" as const,
    evidence: [] as never[],
  }
  const humanProvenance = {
    extractor: "human" as const,
    source_session_id: "s-human",
    confidence: "human-reviewed" as const,
    evidence: [] as never[],
  }

  const llmMeta = {
    ...meta,
    origin: "llm" as const,
    auditSessionID: "audit-1",
    evidenceCandidates: {
      "tr-1": { kind: "transcript" as const, ref: "tr-1", digest: "b".repeat(64) },
    },
  }

  function humanAuthority(id: string, decision: string, timestamp: string): Decision {
    return makeDecision({
      id,
      topic: "database",
      decision,
      timestamp,
      still_valid: true,
      foundational: true,
      foundational_requested: false,
      human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
      provenance: humanProvenance,
    })
  }

  function assertConflictState(decisions: readonly Decision[]): void {
    const res = resolveDecisionAuthorities(decisions)
    expect(res.authorities).toHaveLength(0)
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0]!.kind).toBe("conflicting-human-foundational")
    expect(res.conflicts[0]!.normalized_topic).toBe("database")
    expect([...res.conflicts[0]!.decision_ids].sort()).toEqual(["human-a", "human-b"])
    const quarantined = res.decisions.filter((d) => d.human_conflict_quarantined === true)
    expect(quarantined.map((d) => d.id).sort()).toEqual(["human-a", "human-b"])
  }

  function persistAndReload(decisions: readonly Decision[]): MemoryFile {
    const mem: MemoryFile = { ...emptyMemory("/test"), decisions: decisions as Decision[] }
    const reloaded = loadAndMigrate(JSON.parse(JSON.stringify(mem)))
    expect(reloaded).not.toBeNull()
    return reloaded!
  }

  it("an empty incoming list preserves the durable conflict through persist/reload cycles", () => {
    const existing = [
      humanAuthority("human-a", "Use Postgres", "2026-08-01T00:00:00Z"),
      humanAuthority("human-b", "Use MySQL", "2026-08-02T00:00:00Z"),
    ]
    let state = mergeDecisions(existing, [], meta)
    assertConflictState(state)

    // Repeated write/reload/write/reload cycles must never evaporate the
    // quarantine or mint an authority.
    for (let cycle = 0; cycle < 3; cycle++) {
      const reloaded = persistAndReload(state)
      assertConflictState(reloaded.decisions)
      // The durable flag survives the round trip, so the next read still sees
      // one conflict and zero authorities.
      expect(reloaded.decisions.filter((d) => d.human_conflict_quarantined === true)).toHaveLength(2)
      state = mergeDecisions(reloaded.decisions, [], meta)
      assertConflictState(state)
    }
  })

  it("an incoming heuristic observation cannot create an automated authority for a quarantined topic", () => {
    const existing = [
      humanAuthority("human-a", "Use Postgres", "2026-08-01T00:00:00Z"),
      humanAuthority("human-b", "Use MySQL", "2026-08-02T00:00:00Z"),
    ]
    const merged = mergeDecisions(existing, [{ topic: "database", decision: "Use SQLite" }], meta)
    assertConflictState(merged)

    const sqlite = merged.find((d) => d.decision === "Use SQLite")
    expect(sqlite).toBeDefined()
    expect(sqlite!.still_valid).toBe(false)
    expect(sqlite!.foundational).toBe(false)
    expect([...(sqlite!.conflicts_with ?? [])].sort()).toEqual(["human-a", "human-b"])
  })

  it("an incoming evidence-backed LLM observation cannot create an automated authority for a quarantined topic", () => {
    const existing = [
      humanAuthority("human-a", "Use Postgres", "2026-08-01T00:00:00Z"),
      humanAuthority("human-b", "Use MySQL", "2026-08-02T00:00:00Z"),
    ]
    const merged = mergeDecisions(
      existing,
      [{ topic: "database", decision: "Use SQLite", evidence_refs: ["tr-1"] } as never],
      llmMeta,
    )
    assertConflictState(merged)

    const sqlite = merged.find((d) => d.decision === "Use SQLite")
    expect(sqlite).toBeDefined()
    expect(sqlite!.still_valid).toBe(false)
    expect(sqlite!.provenance?.extractor).toBe("llm")
    expect([...(sqlite!.conflicts_with ?? [])].sort()).toEqual(["human-a", "human-b"])
  })

  it("a heuristic conflict rewrites only prior valid authorities, leaving a pre-existing LLM conflict candidate unchanged (Concern B)", () => {
    const authority = makeDecision({
      id: "h1",
      topic: "database",
      decision: "Use Postgres",
      timestamp: "2026-08-01T00:00:00Z",
      provenance: heuristicProvenance,
    })
    const llmCandidate = makeDecision({
      id: "c1",
      topic: "database",
      decision: "Use MySQL",
      timestamp: "2026-08-02T00:00:00Z",
      still_valid: false,
      foundational: false,
      provenance: llmProvenance,
      conflicts_with: ["h1"],
    })
    const existing = { ...emptyMemory("/test"), decisions: [authority, llmCandidate] }

    const result = mergeMemory(existing, makeExtracted({
      decisions: [{ topic: "database", decision: "Use DynamoDB" }],
    }), meta)

    const h = result.decisions.find((d) => d.id === "h1")!
    const cand = result.decisions.find((d) => d.id === "c1")!
    const incoming = result.decisions.find((d) => d.decision === "Use DynamoDB")!

    // Only the prior VALID non-human authority is rewritten by the heuristic
    // conflict; it is superseded by the new ID.
    expect(h.still_valid).toBe(false)
    expect((h as { superseded_by?: string }).superseded_by).toBe(incoming.id)
    // The pre-existing invalid LLM conflict candidate keeps its original
    // lineage untouched: no superseded_by is added, conflicts_with is intact.
    expect(cand.still_valid).toBe(false)
    expect((cand as { superseded_by?: string }).superseded_by).toBeUndefined()
    expect(cand.conflicts_with).toEqual(["h1"])
    expect(cand.provenance?.extractor).toBe("llm")
  })

  it("write-path enrichment: an agreeing LLM observation upgrades the persisted row's provenance (Concern A)", () => {
    const existing = [makeDecision({
      id: "h1",
      topic: "database",
      decision: "Use Postgres",
      provenance: heuristicProvenance,
    })]
    const merged = mergeDecisions(
      existing,
      [{ topic: "database", decision: "Use Postgres", evidence_refs: ["tr-1"] } as never],
      llmMeta,
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]!.id).toBe("h1")
    // The WRITE path performs the strongest-provenance enrichment in place.
    expect(merged[0]!.provenance?.extractor).toBe("llm")
    expect(merged[0]!.provenance?.confidence).toBe("llm-corroborated")
    expect(merged[0]!.provenance?.source_audit_session_id).toBe("audit-1")
  })
})

// ─── PR 6 Wave 1 — LLM decisions-only trust boundary ─────────────────────────
// The PR-6 trust boundary says the LLM path in mergeMemory is decisions-only:
// it must not mutate current_task, active_files, blockers, or next_steps.
// These tests document the boundary. Tests that fail against current production
// code reveal where the boundary is not yet enforced.
describe("PR 6 Wave 1 — LLM decisions-only trust boundary", () => {
  const llmMeta = {
    ...meta,
    origin: "llm" as const,
    auditSessionID: "audit-1",
    evidenceCandidates: {
      "tr-1": {
        kind: "transcript" as const,
        ref: "tr-1",
        digest: "a".repeat(64),
        text: "dummy transcript",
        role: "assistant",
      },
    },
  }

  it("LLM merge cannot mutate current_task when extracted task is non-null and existing has heuristic provenance", () => {
    const existing = {
      ...emptyMemory("/test"),
      current_task: "Existing heuristic task",
      current_task_provenance: {
        extractor: "heuristic" as const,
        source_session_id: "session-heuristic",
        confidence: "heuristic" as const,
        evidence: [],
      },
    }
    const extracted = makeExtracted({
      current_task: "LLM-injected task override",
      decisions: [{ topic: "db", decision: "Use Postgres" }],
    })
    const result = mergeMemory(existing, extracted, llmMeta)
    // PR-6: LLM decisions-only merge must not overwrite an existing heuristic task
    expect(result.current_task).toBe("Existing heuristic task")
    expect(result.current_task_provenance?.extractor).toBe("heuristic")
  })

  it("LLM merge preserves active_files byte-for-semantic-value", () => {
    const existing = {
      ...emptyMemory("/test"),
      active_files: [
        { path: "src/main.ts", reason: "entry point", last_touched: "2026-08-01T00:00:00Z" },
      ],
    }
    const extracted = makeExtracted({
      active_files: [{ path: "src/llm-file.ts", reason: "LLM claim" }],
      decisions: [{ topic: "db", decision: "Use Postgres" }],
    })
    const result = mergeMemory(existing, extracted, llmMeta)
    // PR-6: LLM decisions-only merge cannot add, replace, or erase files.
    expect(result.active_files).toEqual(existing.active_files)
    expect(result.active_files.some(f => f.path === "src/main.ts")).toBe(true)
  })

  it("LLM merge cannot mutate blockers — existing blockers must survive an LLM pass", () => {
    const existing = {
      ...emptyMemory("/test"),
      blockers: ["Existing blocker: awaiting review"],
    }
    const extracted = makeExtracted({
      blockers: ["LLM-injected blocker"],
      decisions: [{ topic: "db", decision: "Use Postgres" }],
    })
    const result = mergeMemory(existing, extracted, llmMeta)
    // PR-6 boundary: LLM decisions-only merge must never overwrite blockers.
    // This currently FAILS because mergeMemory unconditionally sets
    // `blockers: extracted.blockers` regardless of origin.
    expect(result.blockers).toEqual(["Existing blocker: awaiting review"])
  })

  it("LLM merge cannot mutate next_steps — existing next_steps must survive an LLM pass", () => {
    const existing = {
      ...emptyMemory("/test"),
      next_steps: ["Existing step: run integration tests"],
    }
    const extracted = makeExtracted({
      next_steps: ["LLM-injected next step"],
      decisions: [{ topic: "db", decision: "Use Postgres" }],
    })
    const result = mergeMemory(existing, extracted, llmMeta)
    // PR-6 boundary: LLM decisions-only merge must never overwrite next_steps.
    // This currently FAILS because mergeMemory unconditionally sets
    // `next_steps: extracted.next_steps` regardless of origin.
    expect(result.next_steps).toEqual(["Existing step: run integration tests"])
  })
})

// ─── PR 6 Wave 1 — extractor/confidence pairing ──────────────────────────────
describe("PR 6 Wave 1 — extractor/confidence pairing", () => {
  const llmMeta = {
    ...meta,
    origin: "llm" as const,
    auditSessionID: "audit-1",
    evidenceCandidates: {
      "tr-1": {
        kind: "transcript" as const,
        ref: "tr-1",
        digest: "a".repeat(64),
        text: "dummy transcript",
        role: "assistant",
      },
    },
  }

  it("heuristic origin produces extractor=heuristic + confidence=heuristic, no audit session", () => {
    const existing = emptyMemory("/test")
    const extracted = makeExtracted({
      decisions: [{ topic: "db", decision: "Use Postgres" }],
    })
    const result = mergeMemory(existing, extracted, meta)
    const provenance = result.decisions[0]?.provenance
    expect(provenance?.extractor).toBe("heuristic")
    expect(provenance?.confidence).toBe("heuristic")
    expect(provenance?.source_audit_session_id).toBeUndefined()
  })

  it("LLM origin produces extractor=llm + confidence=llm-corroborated with audit session ID and 1-3 transcript evidence", () => {
    const existing = emptyMemory("/test")
    const extracted = makeExtracted({
      decisions: [{ topic: "db", decision: "Use Postgres", evidence_refs: ["tr-1"] } as never],
    })
    const result = mergeMemory(existing, extracted, llmMeta)
    const provenance = result.decisions[0]?.provenance
    expect(provenance?.extractor).toBe("llm")
    expect(provenance?.confidence).toBe("llm-corroborated")
    expect(provenance?.source_audit_session_id).toBe("audit-1")
    expect(provenance?.evidence.length).toBeGreaterThanOrEqual(1)
    expect(provenance?.evidence.length).toBeLessThanOrEqual(3)
  })
})

describe("PR 6 Wave 4 — typed decisions-only LLM merge", () => {
  const llmMeta = {
    ...meta,
    origin: "llm" as const,
    auditSessionID: "audit-wave4",
    evidenceCandidates: {
      "tr-wave4": {
        kind: "transcript" as const,
        ref: "tr-wave4",
        digest: "c".repeat(64),
      },
    },
  }

  it("preserves every non-decision semantic field byte-for-semantic-value", () => {
    const existing = {
      ...emptyMemory("/test"),
      current_task: "Heuristic task",
      current_task_provenance: {
        extractor: "heuristic" as const,
        source_session_id: "heuristic-session",
        confidence: "heuristic" as const,
        evidence: [],
      },
      active_files: [{
        path: "src/existing.ts",
        reason: "existing reason",
        last_touched: "2026-08-01T00:00:00Z",
        provenance: {
          extractor: "heuristic" as const,
          source_session_id: "heuristic-session",
          confidence: "heuristic" as const,
          evidence: [],
        },
      }],
      blockers: ["existing blocker"],
      next_steps: ["existing step"],
    }
    const merged = mergeLLMDecisionFacts(existing, {
      decisions: [{ topic: "database", decision: "Use Postgres", evidence_refs: ["tr-wave4"] }],
    }, llmMeta)

    expect(merged.current_task).toBe(existing.current_task)
    expect(merged.current_task_provenance).toEqual(existing.current_task_provenance)
    expect(merged.active_files).toEqual(existing.active_files)
    expect(merged.blockers).toEqual(existing.blockers)
    expect(merged.next_steps).toEqual(existing.next_steps)
    expect(merged.decisions).toHaveLength(1)
  })

  it("corroborates equivalent non-human decisions in place and creates new topics", () => {
    const existing = {
      ...emptyMemory("/test"),
      decisions: [makeDecision({ id: "stable-id", topic: "database", decision: "Use Postgres" })],
    }
    const merged = mergeLLMDecisionFacts(existing, {
      decisions: [
        { topic: "database", decision: "Use Postgres", evidence_refs: ["tr-wave4"] },
        { topic: "runtime", decision: "Use Node", evidence_refs: ["tr-wave4"] },
      ],
    }, llmMeta)

    expect(merged.decisions.filter((decision) => decision.still_valid)).toHaveLength(2)
    expect(merged.decisions.find((decision) => decision.topic === "database")?.id).toBe("stable-id")
    expect(merged.decisions.find((decision) => decision.topic === "database")?.provenance?.extractor).toBe("llm")
    expect(merged.decisions.find((decision) => decision.topic === "runtime")?.provenance?.confidence).toBe("llm-corroborated")
  })

  it("keeps heuristic and human conflicts invalid without accepting model authority signals", () => {
    const existing = {
      ...emptyMemory("/test"),
      decisions: [makeDecision({
        id: "human-id",
        topic: "database",
        decision: "Use Postgres",
        foundational: true,
        human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" },
        provenance: {
          extractor: "human" as const,
          source_session_id: "human-session",
          confidence: "human-reviewed" as const,
          evidence: [],
        },
      })],
    }
    const merged = mergeLLMDecisionFacts(existing, {
      decisions: [{
        topic: "database",
        decision: "Use MySQL",
        evidence_refs: ["tr-wave4"],
        foundational: true,
      } as never],
    }, llmMeta)
    const human = merged.decisions.find((decision) => decision.id === "human-id")!
    const candidate = merged.decisions.find((decision) => decision.decision === "Use MySQL")!
    expect(human.still_valid).toBe(true)
    expect(candidate.still_valid).toBe(false)
    expect(candidate.foundational).toBe(false)
    expect(candidate.foundational_requested).toBe(false)
    expect(candidate.conflicts_with).toEqual(["human-id"])
  })
})
