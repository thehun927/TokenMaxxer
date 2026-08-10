import { describe, it, expect } from "vitest"
import { mergeMemory } from "../../src/memory/writer"
import { emptyMemory } from "../../src/memory/schema"
import type { MemoryFile, Decision } from "../../src/memory/schema"
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
