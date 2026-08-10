import { afterEach, describe, it, expect, vi } from "vitest"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { pruneOld } from "../../src/memory/writer"
import { emptyMemory, MemoryFileSchema } from "../../src/memory/schema"
import { LLM_REQUEST_TIMEOUT_MS } from "../../src/memory/extract-llm"
import { writeMemory } from "../../src/memory/store"
import { projectMemoryPath } from "../../src/memory/paths"
import { MEMORY_MAX_BYTES, memorySizeBytes } from "../../src/memory/memory-size"
import type { MemoryFile, Decision, LLMAuditMetadata } from "../../src/memory/schema"

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: `d-${Math.random().toString(36).slice(2, 8)}`,
    topic: "some-topic",
    decision: "Some decision text that takes up a bit of space",
    timestamp: new Date().toISOString(),
    session_id: "session-0",
    still_valid: true,
    foundational: false,
    ...overrides,
  }
}

function makeActiveFile(path: string): { path: string; reason: string; last_touched: string } {
  return {
    path,
    reason: "important file for the project work",
    last_touched: new Date().toISOString(),
  }
}

describe("pruneOld", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("does not mutate input", () => {
    const orig = emptyMemory("/test")
    const input: MemoryFile = {
      ...orig,
      decisions: [makeDecision({ topic: "db", decision: "Use Postgres" })],
      blockers: ["blocked on API key"],
      active_files: [makeActiveFile("src/main.ts")],
    }

    const snapshot = JSON.stringify(input)
    pruneOld(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it("returns input unchanged if under 8KB", () => {
    const mem = emptyMemory("/test")
    const result = pruneOld(mem)
    expect(result.project_path).toBe("/test")
    // Should be a clone, not the same reference
    expect(result).not.toBe(mem)
  })

  it("reclassifies a pending audit older than two request windows as failed", () => {
    const now = Date.parse("2026-08-09T00:00:00.000Z")
    const audit: LLMAuditMetadata = {
      audit_session_id: "audit-stale",
      source_session_id: "source-stale",
      cache_key: "cache-stale",
      provider_id: "provider",
      model_id: "model",
      created_at: new Date(now - (2 * LLM_REQUEST_TIMEOUT_MS + 1)).toISOString(),
      terminal_outcome: "pending",
    }

    const result = pruneOld({
      ...emptyMemory("/test"),
      llm_extraction_audits: [audit],
    }, undefined, now)

    expect(result.llm_extraction_audits).toMatchObject([{
      audit_session_id: "audit-stale",
      terminal_outcome: "failed",
    }])
  })

  it("drops still_valid: false decisions first", () => {
    const mem: MemoryFile = {
      ...emptyMemory("/test"),
      decisions: [],
    }

    // Add 500 invalid decisions to push it over 8KB
    for (let i = 0; i < 500; i++) {
      mem.decisions.push(
        makeDecision({
          id: `invalid-${i}`,
          topic: `topic-invalid-${i}`,
          decision: `Decision ${i} that is no longer valid xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
          still_valid: false,
        }),
      )
    }

    // Add one valid decision
    mem.decisions.push(
      makeDecision({
        id: "valid-1",
        topic: "keep-me",
        decision: "This decision should survive pruning",
        still_valid: true,
      }),
    )

    const result = pruneOld(mem)
    const stillValid = result.decisions.filter((d) => d.still_valid)
    const stillInvalid = result.decisions.filter((d) => !d.still_valid)

    // All invalid decisions should be gone
    expect(stillInvalid).toHaveLength(0)
    // The valid decision should still be there
    expect(stillValid).toHaveLength(1)
    expect(stillValid[0]!.id).toBe("valid-1")
  })

  it("caps active_files at 8", () => {
    const mem: MemoryFile = {
      ...emptyMemory("/test"),
      active_files: [],
      decisions: [],
    }

    // Add 20 active files
    for (let i = 0; i < 20; i++) {
      mem.active_files.push({
        ...makeActiveFile(`src/file-${i}.ts`),
        last_touched: new Date(Date.now() - (20 - i) * 1000).toISOString(),
      })
    }

    // Add enough VALID decisions with large text to push over 8KB even after
    // still_valid:false decisions are dropped (step 2).
    for (let i = 0; i < 100; i++) {
      mem.decisions.push(
        makeDecision({
          id: `big-${i}`,
          topic: `topic-${i}-very-long-name-for-bloat`,
          decision: `x`.repeat(500),
          still_valid: true,
          timestamp: new Date().toISOString(),
        }),
      )
    }

    const result = pruneOld(mem)
    expect(result.active_files.length).toBeLessThanOrEqual(8)

    // Should keep the most recently touched files
    if (result.active_files.length > 0) {
      const keptPaths = result.active_files.map((f) => f.path)
      // Later files have more recent timestamps
      expect(keptPaths.includes("src/file-19.ts")).toBe(true)
      expect(keptPaths.includes("src/file-18.ts")).toBe(true)
    }
  })

  it("uses structured logging for the ten-decision pruning diagnostic", () => {
    const warn = vi.spyOn(console, "warn")
    const error = vi.spyOn(console, "error")
    const appLog = vi.fn()
    const mem: MemoryFile = {
      ...emptyMemory("/test"),
      decisions: [],
      active_files: [],
    }

    for (let i = 0; i < 100; i++) {
      mem.decisions.push(makeDecision({
        id: `big-${i}`,
        decision: "x".repeat(500),
        timestamp: new Date().toISOString(),
      }))
    }

    const result = pruneOld(mem, { app: { log: appLog } })

    expect(result.decisions).toHaveLength(10)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(appLog).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        level: "warn",
        message: "tokenmaxxer: pruned decisions to 10 most recent to fit 8KB cap",
      }),
    }))
  })

  it("drops decisions older than 30 days", () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    const recentDate = new Date().toISOString()

    const mem: MemoryFile = {
      ...emptyMemory("/test"),
      decisions: [],
      active_files: [],
    }

    // Add one old decision
    mem.decisions.push(
      makeDecision({
        id: "old-1",
        topic: "old-topic",
        decision: "An old decision",
        timestamp: oldDate,
        still_valid: true,
      }),
    )

    // Add one recent decision
    mem.decisions.push(
      makeDecision({
        id: "recent-1",
        topic: "recent-topic",
        decision: "A recent decision",
        timestamp: recentDate,
        still_valid: true,
      }),
    )

    // Push it way over 8KB with a lot of text
    mem.next_steps = ["x".repeat(10000)]

    const result = pruneOld(mem)

    // The old decision should be dropped by the >30 days step (step 4)
    // But the pruning goes through multiple stages. First drops still_valid:false,
    // then caps active_files, then drops >30 days.
    // The old decision should be gone since >30 days
    expect(result.decisions.find((d) => d.id === "old-1")).toBeUndefined()
    expect(result.decisions.find((d) => d.id === "recent-1")).toBeDefined()
  })

  it("last resort truncation keeps only current_task + 5 decisions", () => {
    const warn = vi.spyOn(console, "warn")
    const error = vi.spyOn(console, "error")
    const appLog = vi.fn()
    const mem: MemoryFile = {
      ...emptyMemory("/test"),
      decisions: [],
      active_files: [],
      blockers: [],
      next_steps: [],
    }

    // Add a lot of valid recent decisions with very large text.
    // Each decision ~500 chars of text ≈ 500 bytes. 50 × 500 = 25000 bytes.
    // The 8KB cap = 8192 bytes. 10 decisions at 500 chars each is ~5000 bytes
    // for the decision text alone, plus JSON overhead → closer to 7-8KB.
    // So 10 decisions may still fit. We need to use larger decisions.
    for (let i = 0; i < 50; i++) {
      mem.decisions.push(
        makeDecision({
          id: `decision-${i}`,
          topic: `topic-${i}-with-very-long-description-for-bloat-purposes`,
          decision: `Decision number ${i} that contains a very long description to ensure each entry is very large ${"x".repeat(2000 + i)}`,
          rationale: `y`.repeat(200),
          timestamp: new Date(Date.now() - (50 - i) * 10000).toISOString(),
          still_valid: true,
        }),
      )
    }

    const result = pruneOld(mem, { app: { log: appLog } })

    // All pruning steps should have been triggered.
    // After step 2 (drop still_valid:false), step 3 (cap active_files),
    // step 4 (drop >30 days), step 5 (truncate), and step 6 (10 most recent),
    // if still over 8KB → step 7 last resort: 5 decisions only.
    // With our large decisions, 10 should still be >8KB.
    expect(result.decisions.length).toBeLessThanOrEqual(5)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(appLog).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        level: "error",
        message: "tokenmaxxer: STILL over 8KB after all pruning — truncating to current_task + 5 decisions",
      }),
    }))
  })
})

// ─── PR 3 §13 foundational retention ─────────────────────────────────────────
// These release-gate tests (implementation-plan §15 items 41-45) fail on the
// current pruneOld because none of its stages protects `foundational` rows:
// step 4 age-prunes them and steps 6/7 drop them under count pressure. Wave 7
// changes the stages to protected-first selection. Test 45 is a whole-pipeline
// test (pruneOld + the commit size guard in commitMemoryExact via writeMemory).
describe("PR 3 §13 foundational retention", () => {
  it("41. 31-day-old confirmed foundational decision survives age pruning", () => {
    const now = Date.parse("2026-09-01T00:00:00.000Z")
    const oldTs = new Date(now - (31 * 24 * 60 * 60 * 1000 + 1000)).toISOString()
    const mem: MemoryFile = {
      ...emptyMemory("/test"),
      decisions: [
        makeDecision({
          id: "found-1",
          topic: "database",
          decision: "Use Postgres",
          timestamp: oldTs,
          still_valid: true,
          foundational: true,
        }),
      ],
      active_files: [],
      next_steps: ["x".repeat(10000)],
    }

    const result = pruneOld(mem, undefined, now)

    expect(result.decisions.find((d) => d.id === "found-1")).toBeDefined()
  })

  it("42. 10-decision pressure keeps all foundational decisions before recent non-foundational rows", () => {
    const now = Date.parse("2026-08-09T00:00:00.000Z")
    const mem: MemoryFile = { ...emptyMemory("/test"), decisions: [], active_files: [] }

    // 10 old foundational decisions.
    for (let i = 0; i < 10; i++) {
      mem.decisions.push(makeDecision({
        id: `found-${i}`,
        topic: `topic-found-${i}`,
        decision: `Foundational architectural decision ${i} ${"x".repeat(170)}`,
        timestamp: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
        still_valid: true,
        foundational: true,
      }))
    }
    // 10 recent non-foundational decisions.
    for (let i = 0; i < 10; i++) {
      mem.decisions.push(makeDecision({
        id: `recent-${i}`,
        topic: `topic-recent-${i}`,
        decision: `Recent non-foundational observation number ${i} ${"y".repeat(190)}`,
        timestamp: new Date(now - i * 600_000).toISOString(),
        still_valid: true,
        foundational: false,
      }))
    }

    // Setup sanity: the 20-decision input must exceed the 8KB cap so the
    // count-pressure stage actually runs instead of returning early.
    expect(memorySizeBytes(mem)).toBeGreaterThan(MEMORY_MAX_BYTES)

    const result = pruneOld(mem, undefined, now)

    // Protected-first selection: every foundational decision survives even
    // though it is older than the disposable recent rows.
    for (let i = 0; i < 10; i++) {
      expect(result.decisions.find((d) => d.id === `found-${i}`)).toBeDefined()
    }
    // The newest non-foundational rows are retained ahead of older disposable
    // rows, subject to the 8KB cap (the seeded non-foundational set is larger
    // than the cap lets the protected-first selection keep in full).
    expect(result.decisions.find((d) => d.id === "recent-0")).toBeDefined()
  })

  it("43. 5-decision last-resort pressure keeps all foundational decisions", () => {
    const now = Date.parse("2026-08-09T00:00:00.000Z")
    const mem: MemoryFile = { ...emptyMemory("/test"), decisions: [], active_files: [] }

    for (let i = 0; i < 10; i++) {
      mem.decisions.push(makeDecision({
        id: `found-${i}`,
        topic: `topic-found-${i}`,
        decision: `Foundational architectural decision ${i} ${"x".repeat(120)}`,
        timestamp: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
        still_valid: true,
        foundational: true,
      }))
    }
    for (let i = 0; i < 50; i++) {
      mem.decisions.push(makeDecision({
        id: `big-${i}`,
        topic: `topic-big-${i}`,
        decision: `Very large recent non-foundational observation ${i} ${"z".repeat(600)}`,
        timestamp: new Date(now - i * 1000).toISOString(),
        still_valid: true,
        foundational: false,
      }))
    }

    const result = pruneOld(mem, undefined, now)

    // Even at the 5-decision last resort, foundational rows are retained and
    // disposable rows are dropped instead.
    for (let i = 0; i < 10; i++) {
      expect(result.decisions.find((d) => d.id === `found-${i}`)).toBeDefined()
    }
  })

  it("44. explicitly superseded old human authority becomes normally prunable", () => {
    const now = Date.parse("2026-08-09T00:00:00.000Z")
    const superseded = makeDecision({
      id: "old-authority",
      topic: "database",
      decision: "Use Postgres",
      timestamp: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
      still_valid: false,
      foundational: false,
    }) as Decision & { superseded_by: string }
    superseded.superseded_by = "new-authority-9"

    const mem: MemoryFile = {
      ...emptyMemory("/test"),
      decisions: [superseded],
      active_files: [],
      next_steps: ["x".repeat(10000)],
    }

    const result = pruneOld(mem, undefined, now)

    // Explicit human supersession clears `foundational`, so the old authority
    // is no longer protected and ordinary invalid/count pruning may drop it.
    expect(result.decisions.find((d) => d.id === "old-authority")).toBeUndefined()
  })

  it("45. irreducible protected state over 8KB causes commit failure and leaves prior STATE intact", async () => {
    const now = Date.parse("2026-08-09T00:00:00.000Z")
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxer-prune-irreducible-"))
    try {
      const mem: MemoryFile = { ...emptyMemory(dir), decisions: [], active_files: [] }
      // 20 confirmed foundational decisions (schema-valid, with provenance)
      // whose protected rows alone exceed the 8KB cap.
      for (let i = 0; i < 20; i++) {
        mem.decisions.push({
          id: `bf-${i}`,
          topic: `topic-f-${i}`,
          decision: `Foundational decision ${i} ${"x".repeat(60)}`,
          rationale: "architecture-level retention intent",
          timestamp: new Date(now - i * 1000).toISOString(),
          session_id: "session-0",
          still_valid: true,
          foundational: true,
          foundational_requested: false,
          provenance: {
            extractor: "heuristic",
            source_session_id: "session-0",
            confidence: "heuristic",
            evidence: [],
          },
        } as Decision)
      }
      // Setup sanity: protected rows alone exceed the cap, so pruning cannot
      // make the state representable without deleting protected state.
      expect(memorySizeBytes(mem)).toBeGreaterThan(MEMORY_MAX_BYTES)

      const priorPath = projectMemoryPath(dir)
      await mkdir(dirname(priorPath), { recursive: true })
      const priorJson = JSON.stringify({
        ...emptyMemory(dir),
        current_task: "PRIOR-STATE-MARKER",
      }, null, 2)
      await writeFile(priorPath, priorJson)

      const pruned = pruneOld(mem, undefined, now)
      // Wave 7 must return the intentionally irreducible over-cap state rather
      // than silently deleting a confirmed foundational decision.
      expect(memorySizeBytes(pruned)).toBeGreaterThan(MEMORY_MAX_BYTES)

      // The over-cap state is schema-valid, so the only possible commit
      // rejection reason is the commitMemoryExact size guard (size-cap-exceeded),
      // not a validation failure.
      expect(MemoryFileSchema.safeParse(pruned).success).toBe(true)

      const committed = await writeMemory({ worktree: dir, directory: dir }, pruned)
      expect(committed).toBe(false)

      const after = await readFile(priorPath, "utf8")
      expect(after).toBe(priorJson)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
