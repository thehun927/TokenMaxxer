/**
 * PR 3 §11 human CLI tests (implementation-plan §15 items 29-40).
 *
 * These are Wave 1 failing regression fixtures. They target the planned
 * `src/cli.ts` module, which does not exist yet on main. The import below
 * therefore fails to resolve until Wave 6 lands — that is the intended Wave 1
 * outcome.
 *
 * The CLI is driven through an injected I/O adapter (`CliIO`) so TTY
 * confirmation is exercised without weakening the production interactive
 * boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

import { runCli, type CliIO, type CliOptions } from "../src/cli"
import { emptyMemory } from "../src/memory/schema"
import type { MemoryFile, Decision } from "../src/memory/schema"
import { projectMemoryPath } from "../src/memory/paths"
import { writeMemory, readMemory, mutateMemory } from "../src/memory/store"

const WORKER = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "transaction-worker.ts",
)

// ─── helpers ────────────────────────────────────────────────────────────────

const llmProv = {
  extractor: "llm" as const,
  source_session_id: "s-l",
  source_audit_session_id: "audit-l",
  confidence: "llm-corroborated" as const,
  evidence: [{ kind: "transcript" as const, ref: "tr-1", digest: "a".repeat(64) }],
}
const heuristicProv = {
  extractor: "heuristic" as const,
  source_session_id: "s-h",
  confidence: "heuristic" as const,
  evidence: [] as never[],
}
const humanProv = {
  extractor: "human" as const,
  source_session_id: "s-human",
  confidence: "human-reviewed" as const,
  evidence: [] as never[],
}

function mkDecision(overrides: Record<string, unknown> & Partial<Decision> = {}): Decision {
  return {
    id: "d1",
    topic: "auth",
    decision: "Use JWT",
    timestamp: "2026-08-01T00:00:00Z",
    session_id: "session-0",
    still_valid: true,
    foundational: false,
    foundational_requested: false,
    ...overrides,
  } as Decision
}

function makeIo(readValue: string | null = null): CliIO {
  return {
    stdin: { isTTY: true, read: vi.fn().mockResolvedValue(readValue) },
    stdout: { write: vi.fn(), isTTY: true },
    stderr: { write: vi.fn(), isTTY: true },
  }
}

function stdoutOf(io: CliIO): string {
  return (io.stdout.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join("")
}
function stderrOf(io: CliIO): string {
  return (io.stderr.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join("")
}

let dir: string
let project: string
let statePath: string

async function seedState(mem: MemoryFile): Promise<void> {
  await writeMemory({ worktree: project, directory: project }, mem)
}

async function readState(): Promise<MemoryFile> {
  const raw = await readFile(statePath, "utf-8")
  return JSON.parse(raw) as MemoryFile
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(path: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      await access(path)
      return
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`)
      await sleep(10)
    }
  }
}

function runWorker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => { stdout += String(d) })
    child.stderr.on("data", (d) => { stderr += String(d) })
    child.on("error", reject)
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

const barrierFiles: string[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tokenmaxxer-cli-"))
  project = join(dir, "proj")
  statePath = projectMemoryPath(project)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    barrierFiles.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})),
  )
  barrierFiles.length = 0
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

// ─── §15 items 29-40 ────────────────────────────────────────────────────────

describe("PR 3 §11 human CLI", () => {
  it("29. decisions lists authoritative IDs and requested state", async () => {
    await seedState({
      ...emptyMemory(project),
      decisions: [
        mkDecision({ id: "auth-1", topic: "auth", decision: "Use JWT", provenance: llmProv, foundational_requested: true }),
        mkDecision({ id: "auth-2", topic: "db", decision: "Use PostgreSQL", timestamp: "2026-08-02T00:00:00Z", provenance: llmProv }),
      ],
    })
    const io = makeIo()
    await runCli(["decisions"], { project, io })
    const out = stdoutOf(io)
    expect(out).toContain("auth-1")
    expect(out).toContain("auth")
    expect(out).toContain("Use JWT")
    expect(out).toMatch(/\[id=auth-1[^\]]*foundational=false requested=true\]/)
  })

  it("30. decisions --all shows invalid conflict candidates and lineage", async () => {
    await seedState({
      ...emptyMemory(project),
      decisions: [
        mkDecision({ id: "winner", topic: "auth", decision: "Use JWT", timestamp: "2026-08-03T00:00:00Z", provenance: heuristicProv }),
        mkDecision({ id: "old-1", topic: "auth", decision: "Use JWT", timestamp: "2026-08-01T00:00:00Z", still_valid: false, provenance: heuristicProv, superseded_by: "winner" }),
        mkDecision({ id: "old-2", topic: "auth", decision: "Use JWT", timestamp: "2026-08-02T00:00:00Z", still_valid: false, provenance: heuristicProv, superseded_by: "winner" }),
      ],
    })
    const io = makeIo()
    await runCli(["decisions", "--all"], { project, io })
    const out = stdoutOf(io)
    expect(out).toContain("old-1")
    expect(out).toContain("old-2")
    expect(out).toContain("winner")
  })

  it("31. non-interactive tokenmaxxer promote refuses to mint human trust", async () => {
    await seedState({
      ...emptyMemory(project),
      decisions: [mkDecision({ id: "auth-1", topic: "auth", decision: "Use JWT", provenance: llmProv, foundational_requested: true })],
    })
    const io: CliIO = {
      stdin: { isTTY: false, read: vi.fn() },
      stdout: { write: vi.fn(), isTTY: false },
      stderr: { write: vi.fn(), isTTY: false },
    }
    await runCli(["promote", "auth-1"], { project, io })
    const out = stdoutOf(io) + stderrOf(io)
    expect(out).toMatch(/refus|interactive|tty|terminal/i)
    const state = await readState()
    const target = state.decisions.find((d) => d.id === "auth-1")!
    expect(target.foundational).toBe(false)
    expect(target.provenance?.extractor).not.toBe("human")
  })

  it("32. piped confirmation is refused", async () => {
    await seedState({
      ...emptyMemory(project),
      decisions: [mkDecision({ id: "auth-1", topic: "auth", decision: "Use JWT", provenance: llmProv, foundational_requested: true })],
    })
    // stdin isTTY true but read() returns the wrong ID (simulating a pipe).
    const io = makeIo("wrong-id")
    await runCli(["promote", "auth-1"], { project, io })
    const out = stdoutOf(io) + stderrOf(io)
    expect(out).toMatch(/refus|mismatch|wrong|cancel/i)
    const state = await readState()
    const target = state.decisions.find((d) => d.id === "auth-1")!
    expect(target.foundational).toBe(false)
  })

  it("33. interactive confirmation with wrong/cancelled ID leaves STATE byte-for-byte unchanged", async () => {
    const mem: MemoryFile = {
      ...emptyMemory(project),
      decisions: [mkDecision({ id: "auth-1", topic: "auth", decision: "Use JWT", provenance: llmProv, foundational_requested: true })],
    }
    await seedState(mem)
    const before = await readFile(statePath, "utf-8")

    const io = makeIo("") // empty / cancelled
    await runCli(["promote", "auth-1"], { project, io })

    const after = await readFile(statePath, "utf-8")
    expect(after).toBe(before)
  })

  it("34. interactive confirmation of the exact current authority creates human review + foundational state transactionally", async () => {
    await seedState({
      ...emptyMemory(project),
      revision: 5,
      decisions: [mkDecision({ id: "auth-1", topic: "auth", decision: "Use JWT", provenance: llmProv, foundational_requested: true })],
    })
    const io = makeIo("auth-1")
    await runCli(["promote", "auth-1"], { project, io })

    const state = await readState()
    expect(state.revision).toBe(6)
    const target = state.decisions.find((d) => d.id === "auth-1")!
    expect(target.foundational).toBe(true)
    expect(target.foundational_requested).toBe(false)
    expect(target.human_review).toMatchObject({ channel: "interactive-cli" })
    expect(target.provenance?.extractor).toBe("human")
    expect(target.provenance?.confidence).toBe("human-reviewed")
  })

  it("35. human promotion preserves underlying source/audit/evidence provenance", async () => {
    await seedState({
      ...emptyMemory(project),
      decisions: [mkDecision({
        id: "auth-1",
        topic: "auth",
        decision: "Use JWT",
        foundational_requested: true,
        provenance: llmProv,
      })],
    })
    const io = makeIo("auth-1")
    await runCli(["promote", "auth-1"], { project, io })

    const state = await readState()
    const target = state.decisions.find((d) => d.id === "auth-1")!
    expect(target.provenance?.source_session_id).toBe("s-l")
    expect(target.provenance?.source_audit_session_id).toBe("audit-l")
    expect(target.provenance?.evidence).toEqual([{ kind: "transcript", ref: "tr-1", digest: "a".repeat(64) }])
    expect(target.provenance?.extractor).toBe("human")
    expect(target.provenance?.confidence).toBe("human-reviewed")
  })

  it("36. if target is superseded between display and confirmation, transaction revalidation aborts without promoting stale ID", async () => {
    await seedState({
      ...emptyMemory(project),
      decisions: [mkDecision({ id: "auth-1", topic: "auth", decision: "Use JWT", provenance: llmProv, foundational_requested: true })],
    })
    // Test-only seam: the transaction revalidation detects the decision changed
    // during the confirmation window and fails closed.
    vi.spyOn(await import("../src/memory/store"), "mutateMemory").mockResolvedValue({
      status: "noop",
      value: { outcome: "decision-changed-during-review" },
      revision: 5,
    } as never)

    const io = makeIo("auth-1")
    await runCli(["promote", "auth-1"], { project, io })

    const state = await readState()
    const target = state.decisions.find((d) => d.id === "auth-1")!
    expect(target.foundational).toBe(false)
    expect(target.provenance?.extractor).not.toBe("human")
  })

  it("37. concurrent idle write + CLI promotion both survive", async () => {
    await seedState({ ...emptyMemory(project), revision: 10 })
    const ready = join(dir, "idle-ready")
    barrierFiles.push(ready, `${ready}.release`)

    // Fork an idle-write child that holds the lock, signals, then mutates.
    const child = runWorker([project, "hold-write", ready, "idle"])

    const io = makeIo("auth-1")
    // Seed the authority AFTER the child is forked so the CLI promotes it.
    await seedState({
      ...emptyMemory(project),
      revision: 10,
      decisions: [mkDecision({ id: "auth-1", topic: "auth", decision: "Use JWT", provenance: llmProv, foundational_requested: true })],
    })

    const promotion = runCli(["promote", "auth-1"], { project, io })
    await writeFile(`${ready}.release`, "go", "utf-8")
    await Promise.all([child, promotion])

    const state = await readState()
    // idle write (+1) and CLI promotion (+1) both survived.
    expect(state.revision).toBe(12)
    const ids = state.decisions.map((d) => d.id)
    expect(ids).toContain("fact-idle")
    const target = state.decisions.find((d) => d.id === "auth-1")!
    expect(target.foundational).toBe(true)
  })

  it("38. supersede refuses unrelated-topic candidate", async () => {
    await seedState({
      ...emptyMemory(project),
      decisions: [
        mkDecision({ id: "authority-1", topic: "auth", decision: "Use JWT", foundational: true, human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" }, provenance: humanProv }),
        mkDecision({ id: "candidate-1", topic: "db", decision: "Use Postgres", still_valid: false, provenance: llmProv, conflicts_with: ["authority-1"] }),
      ],
    })
    const io = makeIo("candidate-1")
    await runCli(["supersede", "candidate-1", "--replaces", "authority-1"], { project, io })
    const out = stdoutOf(io) + stderrOf(io)
    expect(out).toMatch(/refus|unrelated|topic/i)
    const state = await readState()
    expect(state.decisions.filter((d) => d.topic === "auth" && d.still_valid)).toHaveLength(1)
  })

  it("39. supersede refuses candidate not linked to current human authority", async () => {
    await seedState({
      ...emptyMemory(project),
      decisions: [
        mkDecision({ id: "authority-a", topic: "auth", decision: "Use JWT", foundational: true, human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" }, provenance: humanProv }),
        mkDecision({ id: "authority-b", topic: "db", decision: "Use Postgres", foundational: true, human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" }, provenance: humanProv }),
        mkDecision({ id: "candidate-a", topic: "auth", decision: "Use OAuth2", still_valid: false, provenance: llmProv, conflicts_with: ["authority-a"] }),
      ],
    })
    // candidate of topic A, authority of topic B → not linked.
    const io = makeIo("candidate-a")
    await runCli(["supersede", "candidate-a", "--replaces", "authority-b"], { project, io })
    const out = stdoutOf(io) + stderrOf(io)
    expect(out).toMatch(/refus|link|not-linked|unrelated/i)
  })

  it("40. successful human supersession creates new human authority and leaves exactly one authority for the topic", async () => {
    await seedState({
      ...emptyMemory(project),
      decisions: [
        mkDecision({ id: "authority-1", topic: "auth", decision: "Use JWT", foundational: true, human_review: { channel: "interactive-cli", reviewed_at: "2026-08-01T00:00:00Z" }, provenance: humanProv }),
        mkDecision({ id: "candidate-1", topic: "auth", decision: "Use OAuth2", still_valid: false, provenance: llmProv, conflicts_with: ["authority-1"] }),
      ],
    })
    const io = makeIo("candidate-1")
    await runCli(["supersede", "candidate-1", "--replaces", "authority-1"], { project, io })

    const state = await readState()
    const authorities = state.decisions.filter((d) => d.topic === "auth" && d.still_valid)
    expect(authorities).toHaveLength(1)
    const newAuthority = authorities[0]!
    expect(newAuthority.foundational).toBe(true)
    expect(newAuthority.decision).toBe("Use OAuth2")
    expect((newAuthority as { derived_from_decision_id?: string }).derived_from_decision_id).toBe("candidate-1")
    expect(newAuthority.provenance?.extractor).toBe("human")
    expect(newAuthority.provenance?.confidence).toBe("human-reviewed")
  })
})
