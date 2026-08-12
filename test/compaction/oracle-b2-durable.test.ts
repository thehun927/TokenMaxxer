/**
 * Oracle B2 — mandatory durable-block prefix must fit the injection ceiling.
 *
 * Freezes the remediation for PR-8 blocker B2 (§§72–105 of
 * `docs/CRIP/PR-8/oracle-findings.md`):
 *
 *  - the mandatory prefix (opening delimiter + `DATA Project: ...` +
 *    `DATA Memory freshness: ...` + closing delimiter) is budgeted exactly
 *    like optional candidates, so every returned durable block is
 *    <= DURABLE_BLOCK_MAX_BYTES even for a 1,024-code-point four-byte
 *    project path;
 *  - project identity uses existing `sanitizeDurableValue` plus UTF-8-safe
 *    byte truncation (`truncateUtf8` imported from `src/memory/budget`);
 *  - the strict prefix rule for optional candidates stays intact after
 *    mandatory prefix fitting (no skip-and-fill, closing delimiter reserved);
 *  - rendering never mutates STATE and PR-7 data-only semantics hold;
 *  - missing / unavailable sentinels are preserved.
 *
 * `truncateUtf8` itself is not modified here — it is exercised at tiny
 * budgets (0, 1, 2, 3) to assert it never exceeds the requested byte budget.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the memory store module BEFORE importing it or the module under test
vi.mock("../../src/memory/store", () => ({
  readMemory: vi.fn(),
  readMemoryState: vi.fn(),
}))

// Mock the log module to prevent actual log calls and allow verification
vi.mock("../../src/util/log", () => ({
  log: vi.fn(),
}))

// Mock the git utility to control freshness labels without real git
vi.mock("../../src/util/git", () => ({
  getCurrentGitSha: vi.fn(),
}))

import { readMemoryState } from "../../src/memory/store"
import { buildDurableBlock, DURABLE_BLOCK_MAX_BYTES } from "../../src/compaction/durable"
import { log } from "../../src/util/log"
import { getCurrentGitSha } from "../../src/util/git"
import { truncateUtf8, utf8Bytes } from "../../src/memory/budget"
import { emptyMemory } from "../../src/memory/schema"
import type { MemoryFile, MemoryReadResult } from "../../src/memory/store"

const mockClient = {} as unknown

// ---- Helpers ----

const DELIM_OPEN = "<<<TOKENMAXXER_DURABLE_CONTEXT_DATA>>>"
const DELIM_CLOSE = "<<<END_TOKENMAXXER_DURABLE_CONTEXT_DATA>>>"

function okResult(mem: MemoryFile): MemoryReadResult {
  return {
    status: "ok",
    memory: mem,
    source: "project",
    path: "/project/.opencode/memory/STATE.json",
    sizeBytes: 1000,
    revision: mem.revision ?? 0,
  }
}

function missingResult(): MemoryReadResult {
  return {
    status: "missing",
    memory: null,
    source: null,
    path: null,
    sizeBytes: 0,
    revision: 0,
  }
}

function unavailableResult(): MemoryReadResult {
  return {
    status: "unavailable",
    memory: null,
    source: null,
    path: null,
    sizeBytes: 0,
    revision: 0,
    errors: [{ source: "project", path: "/project/.opencode/memory/STATE.json" }],
  }
}

/** Memory with a project identity and optional renderable content. */
function makeMemory(overrides?: Partial<MemoryFile>): MemoryFile {
  return {
    ...emptyMemory("/home/user/my-project"),
    last_git_sha: "abc1234",
    last_session_id: "sess-001",
    ...overrides,
  }
}

async function render(mem: MemoryFile): Promise<string> {
  return buildDurableBlock({
    worktree: "/home/user/my-project",
    directory: "/home/user/my-project",
    client: mockClient,
  })
}

// ============================================================================
// B2 — mandatory prefix fits the 4,096-byte injection ceiling
// ============================================================================

describe("B2 — mandatory durable prefix is byte-budgeted", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCurrentGitSha).mockResolvedValue(null)
  })

  it("returns a <=4096-byte block for a 1,024-code-point four-byte emoji project path", async () => {
    const emojiPath = "😀".repeat(1024) // 1024 code points, 4096 UTF-8 bytes
    const mem = makeMemory({
      project_path: emojiPath,
      current_task: "Small task",
      blockers: ["small blocker"],
    })
    const snapshot = JSON.stringify(mem)
    vi.mocked(readMemoryState).mockResolvedValue(okResult(mem))

    const result = await render(mem)

    // Whole block — delimiters, DATA prefixes, newlines — fits the ceiling.
    const bytes = Buffer.byteLength(result, "utf8")
    expect(bytes).toBeLessThanOrEqual(DURABLE_BLOCK_MAX_BYTES)
    expect(result.startsWith(DELIM_OPEN)).toBe(true)
    expect(result.endsWith(DELIM_CLOSE)).toBe(true)

    // The project line is present and bounded; the full 4,096-byte path is not.
    expect(result).toContain("DATA Project: ")
    expect(result).not.toContain(emojiPath)
    // UTF-8-safe truncation marker from truncateUtf8 is present.
    expect(result).toContain("...")

    // PR-7 data-only semantics: every line between the delimiters is a DATA line.
    const lines = result.split("\n")
    let between = false
    for (const line of lines) {
      if (line === DELIM_OPEN) { between = true; continue }
      if (line === DELIM_CLOSE) { between = false; continue }
      if (!between || line.trim().length === 0) continue
      expect(line).toMatch(/^DATA /)
    }

    // Rendering never mutates STATE.
    expect(JSON.stringify(mem)).toBe(snapshot)
  })

  it("preserves a multibyte CJK project identity plus the normal freshness line", async () => {
    const cjkPath = "本".repeat(1024) // 1024 code points, 3072 UTF-8 bytes
    vi.mocked(readMemoryState).mockResolvedValue(
      okResult(makeMemory({ project_path: cjkPath })),
    )

    const result = await render(makeMemory({ project_path: cjkPath }))

    const bytes = Buffer.byteLength(result, "utf8")
    expect(bytes).toBeLessThanOrEqual(DURABLE_BLOCK_MAX_BYTES)
    // The full identity survives byte-budgeted rendering (3072 < path budget).
    expect(result).toContain(cjkPath)
    // The normal freshness line is present and untouched.
    expect(result).toContain("DATA Memory freshness: unknown")
    // Multibyte accounting: bytes exceed JS code-point count.
    expect(bytes).toBeGreaterThan([...result].length)
    // No split code points / lone surrogates.
    expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result)
  })

  it("lands the mandatory prefix on the exact 4,096-byte boundary", async () => {
    // Reserve every fixed framing byte; the remaining budget is the path.
    const openBytes = Buffer.byteLength(DELIM_OPEN, "utf8")
    const closeBytes = Buffer.byteLength(DELIM_CLOSE, "utf8")
    const labelBytes = Buffer.byteLength("DATA Project: ", "utf8")
    const freshLineBytes = Buffer.byteLength("DATA Memory freshness: unknown", "utf8")
    const pathBytes =
      DURABLE_BLOCK_MAX_BYTES -
      openBytes - 1 - labelBytes - 1 - freshLineBytes - 1 - closeBytes
    expect(pathBytes).toBeGreaterThan(0)

    // 992 four-byte emoji + 1 ASCII char = exactly pathBytes, under the
    // 1,024 code-point character cap so sanitization adds no marker.
    const path = "😀".repeat(Math.floor(pathBytes / 4)) + "a".repeat(pathBytes % 4)
    expect(Buffer.byteLength(path, "utf8")).toBe(pathBytes)
    expect([...path].length).toBeLessThanOrEqual(1024)

    vi.mocked(readMemoryState).mockResolvedValue(
      okResult(makeMemory({ project_path: path })),
    )

    const result = await render(makeMemory({ project_path: path }))

    // No optional candidates exist; the mandatory prefix fills exactly 4096.
    expect(Buffer.byteLength(result, "utf8")).toBe(DURABLE_BLOCK_MAX_BYTES)
    expect(result).toContain(path)
    expect(result).toContain("DATA Memory freshness: unknown")
  })

  it("keeps strict prefix ordering intact after mandatory prefix fitting", async () => {
    // A large-but-legal multibyte path (975 four-byte emoji, 3900 bytes)
    // consumes most of the budget.  The priority-2 current task still fits;
    // the priority-3 blocker does NOT fit; the priority-5 decision line is
    // smaller than the blocker but must still be omitted (no skip-and-fill).
    const bigPath = "😀".repeat(975)
    const mem = makeMemory({
      project_path: bigPath,
      current_task: "t".repeat(10),
      blockers: ["b".repeat(100)],
      decisions: [
        {
          id: "d1",
          topic: "topic",
          decision: "decision",
          timestamp: "2026-08-07T10:00:00.000Z",
          session_id: "sess-001",
          still_valid: true,
          foundational: false,
          last_used_in_session: "sess-001",
          provenance: {
            extractor: "heuristic",
            source_session_id: "sess-001",
            confidence: "heuristic",
          },
        },
      ],
      recent_sessions: ["sess-001"],
    })
    const snapshot = JSON.stringify(mem)
    vi.mocked(readMemoryState).mockResolvedValue(okResult(mem))

    const result = await render(mem)

    const bytes = Buffer.byteLength(result, "utf8")
    expect(bytes).toBeLessThanOrEqual(DURABLE_BLOCK_MAX_BYTES)

    // The full identity survives (3900 <= 3969 path budget).
    expect(result).toContain(bigPath)
    // Priority-2 current task is retained, in order after the project line.
    expect(result).toContain("DATA Current task [unknown]: tttttttttt")
    const posProject = result.indexOf("DATA Project:")
    const posTask = result.indexOf("DATA Current task")
    const posClose = result.indexOf(DELIM_CLOSE)
    expect(posTask).toBeGreaterThan(posProject)
    expect(posTask).toBeLessThan(posClose)
    // Lower-priority candidates (blocker and decision) are NOT backfilled
    // after the priority-2 cut — the retained tail stays a strict prefix.
    expect(result).not.toContain("DATA Blocker")
    expect(result).not.toContain("DATA Decision")

    // STATE is untouched by the mandatory-prefix fitting.
    expect(JSON.stringify(mem)).toBe(snapshot)
  })

  it("renders an ordinary ASCII project identity unchanged", async () => {
    vi.mocked(readMemoryState).mockResolvedValue(
      okResult(makeMemory({ project_path: "/home/user/my-project" })),
    )

    const result = await render(makeMemory({ project_path: "/home/user/my-project" }))

    expect(result).toContain("DATA Project: /home/user/my-project")
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(DURABLE_BLOCK_MAX_BYTES)
  })
})

// ============================================================================
// B2 — truncateUtf8 tiny-budget contract (helper imported, not edited)
// ============================================================================

describe("B2 — truncateUtf8 never exceeds the requested byte budget", () => {
  it("returns <= budget bytes for budgets 0, 1, 2, and 3", () => {
    const values = ["hello", "a", "😀", "日本", ""]
    for (const budget of [0, 1, 2, 3]) {
      for (const value of values) {
        const result = truncateUtf8(value, budget)
        expect(utf8Bytes(result)).toBeLessThanOrEqual(budget)
      }
    }
  })

  it("returns the empty string for budget 0", () => {
    expect(truncateUtf8("a", 0)).toBe("")
    expect(utf8Bytes(truncateUtf8("😀", 0))).toBe(0)
  })

  it("never emits a marker larger than the budget (0/1/2)", () => {
    // The "..." marker is 3 bytes; for budgets 0-2 the only legal output is "".
    for (const budget of [0, 1, 2]) {
      expect(truncateUtf8("abcdef", budget)).toBe("")
    }
  })
})

// ============================================================================
// B2 — sentinels preserved
// ============================================================================

describe("B2 — missing/unavailable sentinels are preserved", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCurrentGitSha).mockResolvedValue(null)
  })

  it("returns the missing-memory sentinel intact and within budget", async () => {
    vi.mocked(readMemoryState).mockResolvedValue(missingResult())

    const result = await buildDurableBlock({
      worktree: "/some/worktree",
      directory: "/some/worktree",
      client: mockClient,
    })

    expect(result).toBe("(no prior project memory)")
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(DURABLE_BLOCK_MAX_BYTES)
  })

  it("returns the unavailable-memory sentinel intact and within budget", async () => {
    vi.mocked(readMemoryState).mockResolvedValue(unavailableResult())

    const result = await buildDurableBlock({
      worktree: "/some/worktree",
      directory: "/some/worktree",
      client: mockClient,
    })

    expect(result).toBe("(memory unavailable)")
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(DURABLE_BLOCK_MAX_BYTES)
  })

  it("falls back to the unavailable sentinel when the store throws", async () => {
    vi.mocked(readMemoryState).mockRejectedValue(new Error("disk failure"))

    const result = await buildDurableBlock({
      worktree: "/some/worktree",
      directory: "/some/worktree",
      client: mockClient,
    })

    expect(result).toBe("(memory unavailable)")
    expect(log).toHaveBeenCalledWith(
      mockClient,
      "warn",
      "buildDurableBlock failed",
      { error: "Error: disk failure" },
    )
  })
})
