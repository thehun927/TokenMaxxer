/**
 * Cross-process transaction correctness tests (PR 2 §14, §15).
 *
 * These tests prove the `mutateMemory` / `withProjectLock` transaction
 * protocol works across actual OS child processes, not just two Promises in
 * one Vitest process. Each test isolates the global fallback namespace via
 * `vi.stubEnv("HOME", tempHome)`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

import {
  mutateMemory,
  readMemoryState,
  writeMemory,
} from "../../src/memory/store"
import {
  globalMemoryPath,
  globalProjectStorageDir,
  projectMemoryPath,
  projectLockDir,
} from "../../src/memory/paths"
import { emptyMemory } from "../../src/memory/schema"
import { withProjectLock } from "../../src/memory/project-lock"
import { atomicWrite } from "../../src/util/fs"

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

/** Spawn the worker fixture and resolve with its stdout + exit code. */
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

/** A minimal valid STATE.json document for a project at the given revision. */
function memoryJson(project: string, revision: number): string {
  return JSON.stringify({ ...emptyMemory(project), revision }, null, 2)
}

async function writeState(path: string, content: string): Promise<void> {
  await atomicWrite(path, content)
}

async function readOnDisk(path: string): Promise<{ revision: number; decisions: Array<{ id: string }> }> {
  const raw = await readFile(path, "utf-8")
  return JSON.parse(raw)
}

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "tokenmaxxer-txn-home-"))
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

describe("two child processes, same project, different facts", () => {
  it("both mutations survive; final revision is N+2", async () => {
    const project = join(homeDir, "proj")
    const statePath = projectMemoryPath(project)
    await writeState(statePath, memoryJson(project, 10))

    const barrierA = join(homeDir, "txn-a")
    const barrierB = join(homeDir, "txn-b")
    barrierFiles.push(barrierA, barrierB)

    // Fork both workers; they contend for the same project lock.
    const a = runWorker([project, "idle-write", "A"])
    const b = runWorker([project, "idle-write", "B"])

    const [ra, rb] = await Promise.all([a, b])
    expect(ra.code).toBe(0)
    expect(rb.code).toBe(0)
    expect(JSON.parse(ra.stdout)).toMatchObject({ status: "ok" })
    expect(JSON.parse(rb.stdout)).toMatchObject({ status: "ok" })

    const onDisk = await readOnDisk(statePath)
    expect(onDisk.revision).toBe(12)
    const ids = onDisk.decisions.map((d) => d.id)
    expect(ids).toContain("fact-A")
    expect(ids).toContain("fact-B")
  })
})

describe("no-op child does not bump revision", () => {
  it("revision is unchanged before and after", async () => {
    const project = join(homeDir, "proj")
    const statePath = projectMemoryPath(project)
    await writeState(statePath, memoryJson(project, 4))

    const { code, stdout } = await runWorker([project, "noop-write"])
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ status: "noop", revision: 4 })

    const onDisk = await readOnDisk(statePath)
    expect(onDisk.revision).toBe(4)
  })
})

describe("exactly one revision per mutateMemory", () => {
  it("one commit advances N -> N+1, never N+2", async () => {
    const project = join(homeDir, "proj")
    const statePath = projectMemoryPath(project)
    await writeState(statePath, memoryJson(project, 7))

    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("committed")
    if (result.status === "committed") expect(result.revision).toBe(8)

    const onDisk = await readOnDisk(statePath)
    expect(onDisk.revision).toBe(8)
  })
})

describe("transaction bypasses cache", () => {
  it("builds on the newer durable revision, not the stale cache", async () => {
    const project = join(homeDir, "proj")
    const statePath = projectMemoryPath(project)
    await writeState(statePath, memoryJson(project, 1))

    // Preload the process cache with revision 1.
    const cached = await readMemoryState({ worktree: project, directory: project })
    expect(cached.status).toBe("ok")
    if (cached.status === "ok") expect(cached.revision).toBe(1)

    // Externally replace STATE at revision 5, pinning the same mtime so a
    // non-bypassing read would reuse the stale cache.
    const originalMtime = (await stat(statePath)).mtimeMs
    await writeState(statePath, memoryJson(project, 5))
    await utimes(statePath, new Date(originalMtime), new Date(originalMtime))

    let observedRevision: number | null = null
    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => {
        observedRevision = memory.revision
        return { kind: "commit", memory, value: null }
      },
    )

    expect(observedRevision).toBe(5)
    expect(result.status).toBe("committed")
    if (result.status === "committed") expect(result.revision).toBe(6)
    const onDisk = await readOnDisk(statePath)
    expect(onDisk.revision).toBe(6)
  })
})

describe("commit failure releases lock", () => {
  it("a failed commit does not leak the project lock", async () => {
    const project = join(homeDir, "proj")
    const statePath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)
    await writeState(statePath, memoryJson(project, 0))

    // Make both STATE destinations unwritable while keeping the local STATE
    // readable so the transaction read succeeds (status "ok") and the commit
    // is what fails.
    //  - Local: chmod the `.opencode/memory` parent to 0o555 (r-x, no write).
    //    The existing STATE file stays readable, but `atomicWrite` cannot
    //    create its temp sibling (EACCES).
    //  - Global: place a directory at the global STATE path so the fallback
    //    atomic rename fails (EISDIR/ENOTEMPTY). The project lock lives at
    //    `<globalDir>/.state-lock`, a sibling, so lock acquisition is
    //    unaffected.
    const localDir = dirname(statePath)
    await chmod(localDir, 0o555)
    await mkdir(globalPath, { recursive: true })

    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("commit-failed")

    // Restore writability so the next transaction can write.
    await chmod(localDir, 0o755)
    await rm(globalPath, { recursive: true, force: true })

    // The lock must be acquirable immediately (not leaked by the failed commit).
    const second = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(second.status).toBe("committed")
  })
})

describe("thrown mutation callback releases lock and does not commit", () => {
  it("propagates the throw and leaves the lock acquirable", async () => {
    const project = join(homeDir, "proj")
    const statePath = projectMemoryPath(project)
    await writeState(statePath, memoryJson(project, 3))

    await expect(
      mutateMemory(
        { worktree: project, directory: project },
        () => {
          throw new Error("boom")
        },
      ),
    ).rejects.toThrow("boom")

    // The lock is not held by this process: a fresh acquisition succeeds.
    await withProjectLock(project, async () => {
      await access(projectLockDir(project))
    })
    await expect(access(projectLockDir(project))).rejects.toThrow()

    // No commit happened.
    const onDisk = await readOnDisk(statePath)
    expect(onDisk.revision).toBe(3)
  })
})

describe("different projects do not block", () => {
  it("project B commits while project A's lock is held", async () => {
    const projectA = join(homeDir, "projA")
    const projectB = join(homeDir, "projB")
    const barrier = join(homeDir, "hold-a")
    barrierFiles.push(barrier, `${barrier}.release`)

    const child = runWorker([projectA, "hold-lock", barrier])
    await waitFor(barrier)

    // B commits while A holds its lock.
    const result = await mutateMemory(
      { worktree: projectB, directory: projectB },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("committed")

    // Release A; the child exits cleanly.
    await writeFile(`${barrier}.release`, "go", "utf-8")
    const { code } = await child
    expect(code).toBe(0)
  })
})

describe("local/global fallback uses the same lock key", () => {
  it("a global-fallback commit serializes with a concurrent child mutation", async () => {
    const project = join(homeDir, "proj")
    const localPath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)

    // Seed STATE at the local path at revision 0.
    await writeState(localPath, memoryJson(project, 0))

    // Force the local write to fail (so the commit falls through to the global
    // path) by making the local `.opencode/memory` parent read-only. The
    // existing STATE file stays readable, so the transaction read still
    // succeeds from the local path; only `atomicWrite`'s temp-sibling creation
    // fails (EACCES), routing the commit to the global fallback.
    const localDir = dirname(localPath)
    await chmod(localDir, 0o555)

    // Fork a child that also mutates the same project (its commit will also
    // fall through to the global path, sharing the same project lock).
    const child = runWorker([project, "idle-write", "child"])

    // The test process commits to the same project via the global fallback.
    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({
        kind: "commit",
        memory: {
          ...memory,
          decisions: [
            ...memory.decisions,
            {
              id: "fact-parent",
              topic: "topic-parent",
              decision: "decision-parent",
              timestamp: new Date().toISOString(),
              session_id: "parent",
              still_valid: true,
              foundational: false,
              provenance: {
                extractor: "heuristic",
                source_session_id: "parent",
                confidence: "heuristic",
                evidence: [],
              },
            },
          ],
        },
        value: null,
      }),
    )
    expect(result.status).toBe("committed")

    const { code } = await child
    expect(code).toBe(0)

    // Both mutations serialized through the same lock key: the global STATE
    // carries both facts and the revision advanced exactly twice.
    const onDisk = await readOnDisk(globalPath)
    expect(onDisk.revision).toBe(2)
    const ids = onDisk.decisions.map((d) => d.id)
    expect(ids).toContain("fact-parent")
    expect(ids).toContain("fact-child")
  })
})
