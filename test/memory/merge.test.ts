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
