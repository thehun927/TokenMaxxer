import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

import { readMemoryState, mutateMemory, writeMemory } from "../../src/memory/store"
import { globalMemoryPath, projectMemoryPath, globalProjectStorageDir } from "../../src/memory/paths"
import { emptyMemory, MEMORY_PERSISTENCE_CEILINGS } from "../../src/memory/schema"
import { recordMemoryCommit } from "../../src/memory/commit-pulse"
import { atomicWrite } from "../../src/util/fs"

const worktrees: string[] = []
let homeDir: string

const WORKER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "transaction-worker.ts",
)

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
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${path}`)
      }
      await sleep(10)
    }
  }
}

async function makeWorktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tokenmaxxer-commit-pulse-"))
  worktrees.push(dir)
  return dir
}

/** A minimal valid STATE.json document for a project at the given revision. */
function memoryJson(project: string, revision: number): string {
  return JSON.stringify({ ...emptyMemory(project), revision }, null, 2)
}

async function writeState(path: string, content: string): Promise<void> {
  await atomicWrite(path, content)
}

/** Make the given STATE path an unreadable target by placing a directory there. */
async function makeUnreadable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await mkdir(path)
}

beforeEach(async () => {
  // Isolate the global fallback namespace from the developer's real home.
  homeDir = await mkdtemp(join(tmpdir(), "tokenmaxxer-commit-pulse-home-"))
  vi.stubEnv("HOME", homeDir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(homeDir, { recursive: true, force: true })
  await Promise.all(
    worktrees.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe("recordMemoryCommit (TMTUI-3)", () => {
  it("records commit pulse after successful local write", async () => {
    const project = await makeWorktree()
    const path = projectMemoryPath(project)
    await writeState(path, memoryJson(project, 0))

    // First commit should record pulse
    await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )

    // The pulse is fire-and-forget at the canonical boundary, so wait for it.
    const pulsePath = join(globalProjectStorageDir(project), ".commit-pulse")
    await waitFor(pulsePath)
    const raw = await readFile(pulsePath, "utf-8")
    const pulse = JSON.parse(raw)
    expect(pulse.committed_at).toBeGreaterThan(0)
    expect(Number.isFinite(pulse.committed_at)).toBe(true)
  })

  it("records commit pulse after successful global fallback write", async () => {
    const project = await makeWorktree()
    const localPath = projectMemoryPath(project)
    await makeUnreadable(localPath)

    // Seed the global STATE so the authoritative read succeeds from the
    // global candidate while the local path is broken; the commit then falls
    // through to the global fallback write.
    await writeState(globalMemoryPath(project), memoryJson(project, 0))

    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("committed")

    // The pulse is fire-and-forget at the canonical boundary, so wait for it.
    const pulsePath = join(globalProjectStorageDir(project), ".commit-pulse")
    await waitFor(pulsePath)
    const raw = await readFile(pulsePath, "utf-8")
    const pulse = JSON.parse(raw)
    expect(pulse.committed_at).toBeGreaterThan(0)
    expect(Number.isFinite(pulse.committed_at)).toBe(true)
  })

  it("does not record commit pulse on noop", async () => {
    const project = await makeWorktree()
    await writeState(projectMemoryPath(project), memoryJson(project, 0))

    // Noop should not record pulse
    await mutateMemory(
      { worktree: project, directory: project },
      () => ({ kind: "noop", value: "noop-value" }),
    )

    const pulsePath = join(globalProjectStorageDir(project), ".commit-pulse")
    // Pulse should not exist after noop
    await expect(readFile(pulsePath, "utf-8")).rejects.toThrow()
  })

  it("does not record commit pulse on lock-timeout", async () => {
    const project = await makeWorktree()
    const barrier = join(homeDir, "store-lock-barrier")
    const release = `${barrier}.release`

    const child = await import("node:child_process")
    const worker = child.spawn(
      process.execPath,
      ["--import", "tsx", WORKER, project, "hold-lock", barrier],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    )
    await waitFor(barrier)

    // Lock timeout should not record pulse
    await mutateMemory(
      { worktree: project, directory: project, lockOptions: { acquireTimeoutMs: 50, initialBackoffMs: 5, maxBackoffMs: 20 } },
      (memory) => ({ kind: "commit", memory, value: null }),
    )

    const pulsePath = join(globalProjectStorageDir(project), ".commit-pulse")
    // Pulse should not exist after lock timeout
    await expect(readFile(pulsePath, "utf-8")).rejects.toThrow()

    await writeFile(release, "go", "utf-8")
    await new Promise<void>((resolve, reject) => {
      worker.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))))
      worker.on("error", reject)
    })
  })

  it("does not record commit pulse on budget rejection (protected foundational state > cap)", async () => {
    const project = await makeWorktree()
    await writeState(projectMemoryPath(project), memoryJson(project, 0))

    // A single foundational decision pushes the protected minimal legal state
    // past the 8192-byte cap, so fitMemoryToBudget must refuse before any
    // commit boundary is reached.
    const oversized = {
      ...emptyMemory(project),
      revision: 1,
      decisions: [{
        id: "foundational-huge",
        topic: "x".repeat(8_000),
        decision: "keep",
        timestamp: new Date().toISOString(),
        session_id: "source",
        still_valid: true,
        foundational: true,
        foundational_requested: false,
        human_conflict_quarantined: false,
        provenance: {
          extractor: "heuristic",
          source_session_id: "source",
          confidence: "heuristic",
          evidence: [],
        },
      }],
    }

    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory: oversized, value: null }),
    )

    expect(result.status).toBe("budget-rejected")
    if (result.status === "budget-rejected") {
      expect(result.reason).toBe("foundational-state-exceeds-budget")
    }

    // Budget refusal short-circuits before the canonical commit boundary: no
    // pulse file is ever created.
    const pulsePath = join(globalProjectStorageDir(project), ".commit-pulse")
    await expect(readFile(pulsePath, "utf-8")).rejects.toThrow()
  })

  it("does not record commit pulse on validation failure", async () => {
    const project = await makeWorktree()
    await writeState(projectMemoryPath(project), memoryJson(project, 0))

    // Invalid memory should not record pulse
    await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory: { ...memory, version: 999 }, value: null }),
    )

    const pulsePath = join(globalProjectStorageDir(project), ".commit-pulse")
    // Pulse should not exist after validation failure
    await expect(readFile(pulsePath, "utf-8")).rejects.toThrow()
  })

  it("does not record commit pulse on size-cap-exceeded (direct write path)", async () => {
    const project = await makeWorktree()
    await writeState(projectMemoryPath(project), memoryJson(project, 0))

    // Schema-valid (decision.topic sits at the 8192-char persistence ceiling)
    // but the serialized STATE exceeds the 8192-byte storage cap.
    const oversized = {
      ...emptyMemory(project),
      decisions: [{
        id: "size-probe",
        topic: "x".repeat(MEMORY_PERSISTENCE_CEILINGS.decisionTopicChars),
        decision: "probe",
        timestamp: new Date().toISOString(),
        session_id: "source",
        still_valid: true,
        foundational: false,
        foundational_requested: false,
        human_conflict_quarantined: false,
        provenance: {
          extractor: "heuristic",
          source_session_id: "source",
          confidence: "heuristic",
          evidence: [],
        },
      }],
    }

    // The direct write path enforces the byte cap before any durable write.
    const ok = await writeMemory({ worktree: project, directory: project }, oversized)
    expect(ok).toBe(false)

    const pulsePath = join(globalProjectStorageDir(project), ".commit-pulse")
    await expect(readFile(pulsePath, "utf-8")).rejects.toThrow()
  })

  it("does not record commit pulse on commit-failed (both destinations fail)", async () => {
    const project = await makeWorktree()
    const localPath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)
    await writeState(localPath, memoryJson(project, 0))

    // Local: read-only parent makes atomicWrite's temp-sibling write fail
    // (EACCES). Global: a directory at the STATE path makes the fallback
    // rename fail (EISDIR/ENOTEMPTY). The read still succeeds from the local
    // candidate, so the commit is what fails — not the authoritative read.
    const localDir = dirname(localPath)
    await chmod(localDir, 0o555)
    await mkdir(globalPath, { recursive: true })
    try {
      const result = await mutateMemory(
        { worktree: project, directory: project },
        (memory) => ({ kind: "commit", memory, value: null }),
      )
      expect(result.status).toBe("commit-failed")

      const pulsePath = join(globalProjectStorageDir(project), ".commit-pulse")
      await expect(readFile(pulsePath, "utf-8")).rejects.toThrow()
    } finally {
      await chmod(localDir, 0o755)
      await rm(globalPath, { recursive: true, force: true })
    }
  })

  it("records pulse on each successful commit (revision advancement)", async () => {
    const project = await makeWorktree()
    await writeState(projectMemoryPath(project), memoryJson(project, 0))

    const pulsePath = join(globalProjectStorageDir(project), ".commit-pulse")

    // First commit
    await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    await waitFor(pulsePath)
    const raw1 = await readFile(pulsePath, "utf-8")
    const pulse1 = JSON.parse(raw1)
    const timestamp1 = pulse1.committed_at

    // Second commit should update pulse
    await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    await waitFor(pulsePath)
    const raw2 = await readFile(pulsePath, "utf-8")
    const pulse2 = JSON.parse(raw2)
    const timestamp2 = pulse2.committed_at

    expect(timestamp2).toBeGreaterThan(timestamp1)
  })

  it("records pulse atomically (no stale pulse after concurrent commit)", async () => {
    const project = await makeWorktree()
    await writeState(projectMemoryPath(project), memoryJson(project, 0))

    const pulsePath = join(globalProjectStorageDir(project), ".commit-pulse")

    // First commit
    await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    await waitFor(pulsePath)
    const raw1 = await readFile(pulsePath, "utf-8")
    const pulse1 = JSON.parse(raw1)
    const timestamp1 = pulse1.committed_at

    // Second commit should atomically replace pulse
    await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    await waitFor(pulsePath)
    const raw2 = await readFile(pulsePath, "utf-8")
    const pulse2 = JSON.parse(raw2)
    const timestamp2 = pulse2.committed_at

    expect(timestamp2).toBeGreaterThan(timestamp1)
  })
})
