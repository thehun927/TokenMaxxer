/**
 * Cross-process recall/promotion transaction tests (PR 2 §11.F, §11.G, §15.14).
 *
 * These tests prove the `recall_promote` tool's mutation is transactional
 * against a real OS child process running the real `mutateMemory`/lock
 * implementation. A concurrent idle write must not erase the promotion.
 *
 * Promotion authority/human-review semantics are intentionally UNCHANGED
 * (PR 3 will redesign them); only the persistence mechanism is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

import { readMemoryState } from "../../src/memory/store"
import { globalMemoryPath, projectMemoryPath } from "../../src/memory/paths"
import { emptyMemory } from "../../src/memory/schema"
import { atomicWrite } from "../../src/util/fs"
import { _recallPromote } from "../../src/tools/recall"

const WORKER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "transaction-worker.ts",
)

let homeDir: string
const barrierFiles: string[] = []

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

/** Spawn the worker fixture and resolve with its exit code. */
function runWorker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => {
      stdout += String(d)
    })
    child.stderr.on("data", (d) => {
      stderr += String(d)
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Seed a STATE.json with one promotable decision at the given revision. */
function seedMemoryJson(project: string, revision: number): string {
  return JSON.stringify(
    {
      ...emptyMemory(project),
      revision,
      decisions: [
        {
          id: "d-db",
          topic: "database",
          decision: "Use PostgreSQL",
          timestamp: "2026-08-07T10:00:00.000Z",
          session_id: "sess-001",
          still_valid: true,
          foundational: false,
          provenance: {
            extractor: "heuristic",
            source_session_id: "sess-001",
            confidence: "heuristic",
            evidence: [],
          },
        },
      ],
    },
    null,
    2,
  )
}

async function readOnDisk(path: string): Promise<{
  revision: number
  decisions: Array<{ id: string; topic: string; foundational: boolean }>
}> {
  const raw = await readFile(path, "utf-8")
  return JSON.parse(raw)
}

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "tokenmaxxer-recall-home-"))
  vi.stubEnv("HOME", homeDir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    barrierFiles.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})),
  )
  barrierFiles.length = 0
  await rm(homeDir, { recursive: true, force: true }).catch(() => {})
})

describe("recall_promote is transactional against a concurrent idle write (PR 2 §11.G, §15.14)", () => {
  it("both the promotion and the idle write survive; neither is erased", async () => {
    const project = join(homeDir, "proj")
    const statePath = projectMemoryPath(project)
    await atomicWrite(statePath, seedMemoryJson(project, 10))

    // Fork a child idle-write worker for the same project. It contends for the
    // same filesystem project lock as the promotion in this process.
    const child = runWorker([project, "idle-write", "child"])

    // Drive the real recall_promote tool in this process for the same project.
    const result = await _recallPromote(
      { topic: "database" },
      { worktree: project, directory: project, sessionID: "human-review-session" },
    )

    const { code } = await child
    expect(code).toBe(0)
    expect(result).toContain("Promoted: database: Use PostgreSQL")
    expect(result).toContain("confidence=human-reviewed")

    // Final STATE must contain BOTH the promotion's effect (foundational=true,
    // human provenance) AND the idle write's appended fact. The promotion was
    // not erased by the concurrent idle write.
    const onDisk = await readOnDisk(statePath)
    const db = onDisk.decisions.find((d) => d.topic === "database")
    expect(db).toBeDefined()
    expect(db?.foundational).toBe(true)
    const ids = onDisk.decisions.map((d) => d.id)
    expect(ids).toContain("fact-child")
    // Two logical mutations (promotion + idle write) advanced revision twice.
    expect(onDisk.revision).toBe(12)
  })
})

describe("recall_promote fails closed on unavailable STATE (PR 2 §11.F)", () => {
  it("returns a bounded failure and writes no STATE", async () => {
    const project = join(homeDir, "proj")
    const statePath = projectMemoryPath(project)
    // Make the STATE unreadable by placing a directory at the project path so
    // the authoritative read is "unavailable" (never empty-init).
    await rm(statePath, { recursive: true, force: true }).catch(() => {})
    await mkdir(statePath, { recursive: true })
    // A directory at the global fallback path also forces "unavailable".
    const globalPath = globalMemoryPath(project)
    await mkdir(globalPath, { recursive: true })

    const result = await _recallPromote(
      { topic: "database" },
      { worktree: project, directory: project },
    )

    // Fail closed: the read-only wrapper collapses "unavailable" to null, so
    // the tool reports no memory and never attempts a write. No STATE is
    // created and no empty-memory initialization occurs.
    expect(result).toBe("No project memory.")
    const state = await readMemoryState({ worktree: project, directory: project })
    expect(state.status).toBe("unavailable")
  })
})
