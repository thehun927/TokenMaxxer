/**
 * PR-9 Wave 1 Agent 1C — accurate file-activity classification.
 *
 * Test-only freeze of implementation-plan §8 and §11 "Wave 1 Agent 1C" plus
 * the semantic release matrix §13 F (cases 69–80). These tests document the
 * contract that Wave 6 production work must satisfy. Several intentionally
 * fail against the pre-PR-9 baseline, which collapses every tool reference
 * into a single "edited N times" / "read once" counter (Luna reconciles
 * expected failures in docs/CRIP/PR-9/blockers.md).
 *
 * Frozen contracts:
 *   69.  completed read -> reason `reads=1`
 *   70.  repeated reads -> accurate read count, never edit wording
 *   71.  completed edit -> `edits=1`
 *   72.  completed write -> `writes=1` (never collapsed into an edit)
 *   73.  grep -> `searches=1`
 *   74.  glob -> `searches=1`
 *   75.  bash path reference -> `shell_refs=1` only (never read/edit/write)
 *   76.  mixed categories render each nonzero category accurately
 *   77.  errored/pending tool calls never count as completed activity
 *   78.  stable total-count ranking preserves the top-N contract
 *   79.  current-session observed activity replaces stale old reasons
 *   80.  no transient activity object enters durable STATE
 *
 * No production source, package manifest, or documentation is modified.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  extractFactsHeuristic,
  mergeHeuristicMemory,
  writeMemoryOnIdle,
} from "../../src/memory/writer"
import { emptyMemory, ActiveFileSchema } from "../../src/memory/schema"
import { serializeMemory } from "../../src/memory/memory-size"
import { projectMemoryPath } from "../../src/memory/paths"
import { resetProjectQueues } from "../../src/memory/lock"
import type { TranscriptMessage } from "../../src/types"

const directories: string[] = []

const mergeMeta = {
  sessionId: "session-pr9",
  gitSha: "abc123def4567890",
  timestamp: new Date("2026-08-12T12:00:00Z").toISOString(),
}

/** Build one assistant message containing a single tool part. */
function toolMessage(
  id: string,
  tool: string,
  status: string,
  input: Record<string, unknown>,
): TranscriptMessage {
  return {
    info: { id, role: "assistant" },
    parts: [{ type: "tool", tool, state: { status, input } }],
  }
}

function readMsg(id: string, path: string, status = "completed"): TranscriptMessage {
  return toolMessage(id, "read", status, { filePath: path })
}

function editMsg(id: string, path: string, status = "completed"): TranscriptMessage {
  return toolMessage(id, "edit", status, { filePath: path })
}

function writeMsg(id: string, path: string, status = "completed"): TranscriptMessage {
  return toolMessage(id, "write", status, { filePath: path })
}

function grepMsg(id: string, path: string, status = "completed"): TranscriptMessage {
  return toolMessage(id, "grep", status, { pattern: "TODO", path })
}

function globMsg(id: string, pattern: string, status = "completed"): TranscriptMessage {
  return toolMessage(id, "glob", status, { pattern })
}

function bashMsg(id: string, command: string, status = "completed"): TranscriptMessage {
  return toolMessage(id, "bash", status, { command, workdir: "/proj" })
}

/** Find the single active file for one path, or fail the test. */
function singleFile(facts: { active_files: { path: string; reason: string }[] }, path: string) {
  const file = facts.active_files.find((f) => f.path === path)
  expect(file, `expected active file ${path}`).toBeDefined()
  return file!
}

async function makeWorktree(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-fa-"))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetProjectQueues()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("PR-9 file-activity classification (cases 69–78)", () => {
  it("classifies a completed read as reads=1 and never as an edit (case 69)", () => {
    const facts = extractFactsHeuristic([readMsg("r1", "src/api.ts")])
    expect(facts.active_files).toHaveLength(1)
    const file = singleFile(facts, "src/api.ts")
    expect(file.reason).toBe("reads=1")
    expect(file.reason).not.toMatch(/edit/i)
  })

  it("counts repeated reads accurately without edit wording (case 70)", () => {
    const facts = extractFactsHeuristic([
      readMsg("r1", "src/api.ts"),
      readMsg("r2", "src/api.ts"),
      readMsg("r3", "src/api.ts"),
    ])
    const file = singleFile(facts, "src/api.ts")
    expect(file.reason).toBe("reads=3")
    expect(file.reason).not.toContain("edit")
  })

  it("classifies a completed edit as edits=1 (case 71)", () => {
    const facts = extractFactsHeuristic([editMsg("e1", "src/api.ts")])
    const file = singleFile(facts, "src/api.ts")
    expect(file.reason).toBe("edits=1")
  })

  it("classifies a completed write as writes=1, never collapsed into an edit (case 72)", () => {
    const facts = extractFactsHeuristic([writeMsg("w1", "src/util.ts")])
    const file = singleFile(facts, "src/util.ts")
    expect(file.reason).toBe("writes=1")
    expect(file.reason).not.toContain("edit")
  })

  it("classifies a grep result as searches=1 (case 73)", () => {
    const facts = extractFactsHeuristic([grepMsg("g1", "src/api.ts")])
    const file = singleFile(facts, "src/api.ts")
    expect(file.reason).toBe("searches=1")
    expect(file.reason).not.toMatch(/edit/i)
  })

  it("classifies a glob result as searches=1 (case 74)", () => {
    const facts = extractFactsHeuristic([globMsg("gl1", "src/**/api.ts")])
    expect(facts.active_files).toHaveLength(1)
    const file = facts.active_files[0]!
    expect(file.reason).toBe("searches=1")
    expect(file.reason).not.toMatch(/edit/i)
  })

  it("classifies a bash path reference as shell_refs=1 only (case 75)", () => {
    const facts = extractFactsHeuristic([bashMsg("b1", "cat src/api.ts && npm run build")])
    const file = singleFile(facts, "src/api.ts")
    expect(file.reason).toBe("shell_refs=1")
    // A shell mention proves only a shell reference — never a read/edit/write.
    expect(file.reason).not.toContain("reads")
    expect(file.reason).not.toContain("edits")
    expect(file.reason).not.toContain("writes")
    expect(file.reason).not.toContain("searches")
  })

  it("renders every nonzero category in a mixed transcript accurately (case 76)", () => {
    const facts = extractFactsHeuristic([
      readMsg("r1", "src/api.ts"),
      readMsg("r2", "src/api.ts"),
      editMsg("e1", "src/api.ts"),
      writeMsg("w1", "src/api.ts"),
      grepMsg("g1", "src/api.ts"),
      globMsg("gl1", "src/api.ts"),
      bashMsg("b1", "cat src/api.ts"),
    ])
    const file = singleFile(facts, "src/api.ts")
    expect(file.reason).toBe("reads=2 edits=1 writes=1 searches=2 shell_refs=1")
  })

  it("does not count errored or pending tool calls as completed activity (case 77)", () => {
    const facts = extractFactsHeuristic([
      readMsg("r1", "src/api.ts"),
      editMsg("e1", "src/api.ts", "error"),
      editMsg("e2", "src/api.ts", "pending"),
      writeMsg("w1", "src/api.ts", "error"),
      grepMsg("g1", "src/api.ts"),
      bashMsg("b1", "cat src/api.ts", "error"),
      globMsg("gl1", "src/api.ts", "pending"),
    ])
    const file = singleFile(facts, "src/api.ts")
    // Only the completed read and completed grep count.
    expect(file.reason).toBe("reads=1 searches=1")
  })

  it("ranks by total observed count with stable first-seen tie-break (case 78)", () => {
    // Six files observed once each: equal total counts, first-seen order must
    // select the first five deterministically.
    const facts = extractFactsHeuristic([
      readMsg("a", "src/a.ts"),
      readMsg("b", "src/b.ts"),
      readMsg("c", "src/c.ts"),
      readMsg("d", "src/d.ts"),
      readMsg("e", "src/e.ts"),
      readMsg("f", "src/f.ts"),
    ])
    expect(facts.active_files).toHaveLength(5)
    expect(facts.active_files.map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
    ])

    // A file with a higher total observed count must outrank a lower one.
    const ranked = extractFactsHeuristic([
      readMsg("r1", "src/hot.ts"),
      readMsg("r2", "src/hot.ts"),
      readMsg("r3", "src/hot.ts"),
      readMsg("a", "src/cold.ts"),
    ])
    expect(ranked.active_files[0]?.path).toBe("src/hot.ts")
    expect(ranked.active_files[1]?.path).toBe("src/cold.ts")
  })
})

describe("PR-9 stale reason replacement (case 79)", () => {
  it("a current-session grep observation replaces a stale 'edited 3 times' reason", () => {
    const existing = {
      ...emptyMemory("/proj"),
      active_files: [{
        path: "src/api.ts",
        reason: "edited 3 times",
        last_touched: "2026-01-01T00:00:00.000Z",
        provenance: {
          extractor: "heuristic" as const,
          source_session_id: "stale-session",
          confidence: "heuristic" as const,
          evidence: [],
        },
      }],
    }
    // Current session: one completed grep on the same file.
    const current = extractFactsHeuristic([grepMsg("g1", "src/api.ts")])
    expect(current.active_files).toHaveLength(1)

    const merged = mergeHeuristicMemory(existing, current, mergeMeta)
    const apiFile = merged.active_files.find((f) => f.path === "src/api.ts")
    expect(apiFile).toBeDefined()
    // The current-session observed activity wins; the stale generic reason
    // must never override current evidence.
    expect(apiFile!.reason).toBe("searches=1")
    expect(apiFile!.reason).not.toContain("edited")
  })

  it("persists the current-session derived reason even when a stale reason exists", () => {
    const existing = {
      ...emptyMemory("/proj"),
      active_files: [{
        path: "src/util.ts",
        reason: "read once",
        last_touched: "2026-01-01T00:00:00.000Z",
        provenance: {
          extractor: "heuristic" as const,
          source_session_id: "stale-session",
          confidence: "heuristic" as const,
          evidence: [],
        },
      }],
    }
    const current = extractFactsHeuristic([editMsg("e1", "src/util.ts")])
    const merged = mergeHeuristicMemory(existing, current, mergeMeta)
    const utilFile = merged.active_files.find((f) => f.path === "src/util.ts")
    expect(utilFile).toBeDefined()
    expect(utilFile!.reason).toBe("edits=1")
    expect(utilFile!.reason).not.toContain("read once")
  })
})

describe("PR-9 transient activity never enters durable STATE (case 80)", () => {
  it("merged active_files carry only the durable schema keys, never an activity object", () => {
    const facts = extractFactsHeuristic([
      readMsg("r1", "src/api.ts"),
      readMsg("r2", "src/api.ts"),
      editMsg("e1", "src/api.ts"),
      writeMsg("w1", "src/util.ts"),
      grepMsg("g1", "src/api.ts"),
      bashMsg("b1", "cat src/util.ts"),
    ])
    expect(facts.active_files.length).toBeGreaterThan(0)

    const merged = mergeHeuristicMemory(emptyMemory("/proj"), facts, mergeMeta)
    const raw = serializeMemory(merged)

    const durableKeys = new Set(["path", "reason", "last_touched", "provenance"])
    for (const file of merged.active_files) {
      // The durable entry is the schema shape, not the transient FileActivity.
      for (const key of Object.keys(file)) {
        expect(durableKeys.has(key), `unexpected durable key ${key}`).toBe(true)
      }
      expect(ActiveFileSchema.safeParse(file).success).toBe(true)
    }

    // No activity/count object key may appear anywhere in the serialized state.
    for (const forbidden of [
      "activity",
      "reads",
      "edits",
      "writes",
      "searches",
      "shellRefs",
      "shell_refs",
    ]) {
      expect(raw).not.toContain(`"${forbidden}"`)
    }
  })

  it("persists only path/reason/last_touched/provenance to STATE.json on disk", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const worktree = await makeWorktree()
    const client = {
      app: { log: vi.fn() },
      session: {
        messages: vi.fn(async () => ({
          data: [
            {
              info: { id: "m1", role: "user" },
              parts: [{ type: "text", text: "Inspect the API module." }],
            },
            readMsg("r1", "src/api.ts"),
            editMsg("e1", "src/api.ts"),
            grepMsg("g1", "src/api.ts"),
          ],
        })),
      },
    }

    const outcome = await writeMemoryOnIdle({
      client,
      worktree,
      directory: worktree,
      sessionId: "source-activity",
    })
    expect(outcome).toBe("heuristic-only")

    const raw = await readFile(projectMemoryPath(worktree), "utf-8")
    const parsed = JSON.parse(raw) as {
      active_files: Array<Record<string, unknown>>
    }
    expect(parsed.active_files.length).toBeGreaterThan(0)
    for (const file of parsed.active_files) {
      for (const forbidden of [
        "activity",
        "reads",
        "edits",
        "writes",
        "searches",
        "shellRefs",
        "shell_refs",
      ]) {
        expect(Object.keys(file)).not.toContain(forbidden)
      }
      // On-disk reasons are the deterministic category strings, never counts
      // embedded in a structured object.
      expect(typeof file.reason).toBe("string")
    }
  })
})
