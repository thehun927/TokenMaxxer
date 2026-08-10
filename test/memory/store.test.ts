import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

import { readMemory, readMemoryState, writeMemory, mutateMemory } from "../../src/memory/store"
import {
  globalMemoryPath,
  projectMemoryPath,
} from "../../src/memory/paths"
import { emptyMemory } from "../../src/memory/schema"
import { pruneOld } from "../../src/memory/writer"
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
  const dir = await mkdtemp(join(tmpdir(), "tokenmaxxer-store-"))
  worktrees.push(dir)
  return dir
}

/** A minimal valid STATE.json document for a project at the given revision. */
function memoryJson(project: string, revision: number): string {
  return JSON.stringify({ ...emptyMemory(project), revision }, null, 2)
}

/** A legacy pre-revision STATE.json document (no `revision` key on disk). */
function legacyMemoryJson(project: string): string {
  const { revision: _revision, ...legacy } = emptyMemory(project)
  return JSON.stringify(legacy, null, 2)
}

async function writeState(path: string, content: string): Promise<void> {
  await atomicWrite(path, content)
}

/** Pin a file's mtime to an explicit instant (filesystem-clock independent). */
async function pinMtime(path: string, iso: string): Promise<void> {
  const at = new Date(iso)
  await utimes(path, at, at)
}

/** Make the given STATE path an unreadable target by placing a directory there. */
async function makeUnreadable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await mkdir(path)
}

beforeEach(async () => {
  // Isolate the global fallback namespace from the developer's real home.
  homeDir = await mkdtemp(join(tmpdir(), "tokenmaxxer-store-home-"))
  vi.stubEnv("HOME", homeDir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(homeDir, { recursive: true, force: true })
  await Promise.all(
    worktrees.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe("readMemoryState selection", () => {
  it("local-only: selects the project source with revision and byte size", async () => {
    const project = await makeWorktree()
    const path = projectMemoryPath(project)
    await writeState(path, memoryJson(project, 0))

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result.source).toBe("project")
    expect(result.path).toBe(path)
    expect(result.revision).toBe(0)
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(result.memory).not.toBeNull()
    expect(result.memory?.project_path).toBe(project)
  })

  it("global-only: selects the global source when no local file exists", async () => {
    const project = await makeWorktree()
    const path = globalMemoryPath(project)
    await writeState(path, memoryJson(project, 0))

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result.source).toBe("global")
    expect(result.path).toBe(path)
    expect(result.memory).not.toBeNull()
  })

  it("local higher revision wins over global", async () => {
    const project = await makeWorktree()
    await writeState(projectMemoryPath(project), memoryJson(project, 5))
    await writeState(globalMemoryPath(project), memoryJson(project, 3))

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result.source).toBe("project")
    expect(result.revision).toBe(5)
    expect(result.path).toBe(projectMemoryPath(project))
  })

  it("global higher revision wins over local", async () => {
    const project = await makeWorktree()
    await writeState(projectMemoryPath(project), memoryJson(project, 2))
    await writeState(globalMemoryPath(project), memoryJson(project, 8))

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result.source).toBe("global")
    expect(result.revision).toBe(8)
    expect(result.path).toBe(globalMemoryPath(project))
  })

  it("equal revision: project-local wins deterministically", async () => {
    const project = await makeWorktree()
    const localPath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)
    await writeState(localPath, memoryJson(project, 1))
    await writeState(globalPath, memoryJson(project, 1))
    // Pin BOTH mtimes to the same instant so the equal-revision + equal-mtime
    // tie-break is exercised exactly.
    await pinMtime(localPath, "2026-01-01T00:00:00.000Z")
    await pinMtime(globalPath, "2026-01-01T00:00:00.000Z")

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result.status).toBe("ok")
    expect(result.source).toBe("project")
    expect(result.revision).toBe(1)
  })

  it("local unreadable + no global: unavailable, never a silent empty initialization", async () => {
    const project = await makeWorktree()
    await makeUnreadable(projectMemoryPath(project))

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result.status).toBe("unavailable")
    expect(result.memory).toBeNull()
    expect(result.errors).toEqual([
      expect.objectContaining({ source: "project", path: projectMemoryPath(project) }),
    ])
  })

  it("local unreadable + valid global: selects the global source as ok", async () => {
    const project = await makeWorktree()
    await makeUnreadable(projectMemoryPath(project))
    await writeState(globalMemoryPath(project), memoryJson(project, 1))

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result.status).toBe("ok")
    expect(result.source).toBe("global")
    expect(result.path).toBe(globalMemoryPath(project))
    expect(result.revision).toBe(1)
    expect(result.memory).not.toBeNull()
  })

  it("global fallback round trip", async () => {
    const project = await makeWorktree()
    await writeState(globalMemoryPath(project), memoryJson(project, 2))

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result.source).toBe("global")
    expect(result.memory?.revision).toBe(2)
  })

  it("selected source changes after cache fill when the other candidate changes", async () => {
    const project = await makeWorktree()
    await writeState(projectMemoryPath(project), memoryJson(project, 1))

    const first = await readMemoryState({ worktree: project, directory: project })
    expect(first.source).toBe("project")

    // Writing a higher-revision global candidate changes the global mtime, so
    // the next non-bypassing read must re-read both candidates and re-select.
    await writeState(globalMemoryPath(project), memoryJson(project, 10))
    const second = await readMemoryState({
      worktree: project,
      directory: project,
      bypassCache: false,
    })

    expect(second.source).toBe("global")
    expect(second.revision).toBe(10)
    expect(second.path).toBe(globalMemoryPath(project))
  })

  it("non-git worktree: builds paths from the real directory, not '/'", async () => {
    const directory = await makeWorktree()
    await writeState(projectMemoryPath(directory), memoryJson(directory, 1))

    const result = await readMemoryState({ worktree: "/", directory })

    expect(result.source).toBe("project")
    expect(result.path).toBe(projectMemoryPath(directory))
    expect(result.path).not.toBe(projectMemoryPath("/"))
    expect(result.memory?.project_path).toBe(directory)
  })
})

describe("revision monotonicity (PR 1 Blocker 1)", () => {
  it("mutateMemory advances revision 0 → 1 → 2", async () => {
    const project = await makeWorktree()

    const first = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(first.status).toBe("committed")
    expect(first.revision).toBe(1)

    const second = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(second.status).toBe("committed")
    expect(second.revision).toBe(2)

    const read = await readMemory({ worktree: project, directory: project })
    expect(read?.revision).toBe(2)
  })

  it("writeMemory persists the supplied revision exactly (no advancement)", async () => {
    const project = await makeWorktree()
    const seeded = { ...emptyMemory(project), revision: 5 }

    expect(await writeMemory({ worktree: project, directory: project }, seeded)).toBe(true)
    const read = await readMemory({ worktree: project, directory: project })
    expect(read?.revision).toBe(5)
  })

  it("pruneOld preserves a non-zero revision even when other fields are reduced", () => {
    const memory = {
      ...emptyMemory("/worktree"),
      revision: 7,
      next_steps: ["x".repeat(10_000)],
    }

    const result = pruneOld(memory)

    expect(result.revision).toBe(7)
    expect(result.next_steps).toHaveLength(0)
  })

  it("readMemory collapses an unavailable state to null for non-mutation callers", async () => {
    const project = await makeWorktree()
    await makeUnreadable(projectMemoryPath(project))

    expect(await readMemory({ worktree: project, directory: project })).toBeNull()
  })
})

describe("equal-revision mtime resolution (PR 1 Blocker 2)", () => {
  it("equal revision, global has newer mtime → global wins", async () => {
    const project = await makeWorktree()
    const localPath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)
    await writeState(localPath, memoryJson(project, 1))
    await writeState(globalPath, memoryJson(project, 1))
    await pinMtime(localPath, "2026-01-01T00:00:00.000Z")
    await pinMtime(globalPath, "2026-01-02T00:00:00.000Z")

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result.status).toBe("ok")
    expect(result.source).toBe("global")
    expect(result.path).toBe(globalPath)
  })

  it("equal revision, local has newer mtime → local wins", async () => {
    const project = await makeWorktree()
    const localPath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)
    await writeState(localPath, memoryJson(project, 1))
    await writeState(globalPath, memoryJson(project, 1))
    await pinMtime(localPath, "2026-01-02T00:00:00.000Z")
    await pinMtime(globalPath, "2026-01-01T00:00:00.000Z")

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result.status).toBe("ok")
    expect(result.source).toBe("project")
    expect(result.path).toBe(localPath)
  })

  it("equal revision and exact mtime tie → local wins", async () => {
    const project = await makeWorktree()
    const localPath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)
    await writeState(localPath, memoryJson(project, 1))
    await writeState(globalPath, memoryJson(project, 1))
    await pinMtime(localPath, "2026-01-01T00:00:00.000Z")
    await pinMtime(globalPath, "2026-01-01T00:00:00.000Z")

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result.status).toBe("ok")
    expect(result.source).toBe("project")
  })

  it("legacy dual-file states (both defaulted to revision 0) resolve by mtime: newer global wins", async () => {
    const project = await makeWorktree()
    const localPath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)
    // Neither file carries a `revision` key; zod defaults both to 0.
    await writeState(localPath, legacyMemoryJson(project))
    await writeState(globalPath, legacyMemoryJson(project))
    await pinMtime(localPath, "2026-01-01T00:00:00.000Z")
    await pinMtime(globalPath, "2026-01-02T00:00:00.000Z")

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result.status).toBe("ok")
    expect(result.revision).toBe(0)
    expect(result.source).toBe("global")
    expect(result.path).toBe(globalPath)
  })

  it("higher revision still wins regardless of mtime", async () => {
    const project = await makeWorktree()
    const localPath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)
    await writeState(localPath, memoryJson(project, 5))
    await writeState(globalPath, memoryJson(project, 3))
    await pinMtime(localPath, "2026-01-01T00:00:00.000Z")
    await pinMtime(globalPath, "2026-01-02T00:00:00.000Z")

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result.status).toBe("ok")
    expect(result.source).toBe("project")
    expect(result.revision).toBe(5)
  })
})

describe("unavailable-state safety (PR 1 Blocker 3)", () => {
  it("re-reads an unreadable candidate after permission is restored without an mtime change", async () => {
    const project = await makeWorktree()
    const path = projectMemoryPath(project)
    await writeState(path, memoryJson(project, 3))

    // chmod changes ctime, not mtime, so the cached mtime pair is identical
    // after the permission flip. Only the error-derived cache skip can force
    // a re-read on the next access.
    await chmod(path, 0o000)
    const before = await readMemoryState({ worktree: project, directory: project })
    expect(before.status).toBe("unavailable")
    expect(before.errors).toEqual([
      expect.objectContaining({ source: "project", path }),
    ])

    await chmod(path, 0o644)
    const after = await readMemoryState({ worktree: project, directory: project })
    expect(after.status).toBe("ok")
    expect(after.revision).toBe(3)
  })

  it("does not cache a directory-derived unavailable selection", async () => {
    const project = await makeWorktree()
    const path = projectMemoryPath(project)
    await makeUnreadable(path)

    const before = await readMemoryState({ worktree: project, directory: project })
    expect(before.status).toBe("unavailable")

    // Restore readability: replace the directory with a valid STATE file.
    await rm(path, { recursive: true, force: true })
    await writeState(path, memoryJson(project, 4))

    // No bypassCache: the cached "unavailable" selection must not be reused.
    const after = await readMemoryState({ worktree: project, directory: project })
    expect(after.status).toBe("ok")
    expect(after.revision).toBe(4)
  })
})

describe("mutateMemory (PR 2 §8)", () => {
  it("commits revision N -> N+1 and persists the new revision", async () => {
    const project = await makeWorktree()
    // Seed at revision 0 via the raw exact-commit primitive (writeMemory).
    expect(await writeMemory({ worktree: project, directory: project }, emptyMemory(project))).toBe(true)
    expect((await readMemoryState({ worktree: project, directory: project })).revision).toBe(0)

    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({
        kind: "commit",
        memory: {
          ...memory,
          decisions: [
            ...memory.decisions,
            {
              id: "d1",
              topic: "topic",
              decision: "decision",
              timestamp: new Date().toISOString(),
              session_id: "source",
              still_valid: true,
              foundational: false,
              provenance: {
                extractor: "heuristic",
                source_session_id: "source",
                confidence: "heuristic",
                evidence: [],
              },
            },
          ],
        },
        value: "done",
      }),
    )

    expect(result.status).toBe("committed")
    if (result.status === "committed") {
      expect(result.value).toBe("done")
      expect(result.revision).toBe(1)
    }
    const read = await readMemoryState({ worktree: project, directory: project })
    expect(read.status).toBe("ok")
    if (read.status === "ok") expect(read.revision).toBe(1)
  })

  it("noop does not bump revision", async () => {
    const project = await makeWorktree()
    expect(await writeMemory({ worktree: project, directory: project }, emptyMemory(project))).toBe(true)

    const result = await mutateMemory(
      { worktree: project, directory: project },
      () => ({ kind: "noop", value: "noop-value" }),
    )

    expect(result.status).toBe("noop")
    if (result.status === "noop") {
      expect(result.value).toBe("noop-value")
      expect(result.revision).toBe(0)
    }
    const read = await readMemoryState({ worktree: project, directory: project })
    expect(read.status).toBe("ok")
    if (read.status === "ok") expect(read.revision).toBe(0)
  })

  it("returns lock-timeout against a held lock and writes no STATE", async () => {
    const project = await makeWorktree()
    const barrier = join(homeDir, "store-lock-barrier")
    const release = `${barrier}.release`

    const child = spawn(
      process.execPath,
      ["--import", "tsx", WORKER, project, "hold-lock", barrier],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    )
    await waitFor(barrier)

    const result = await mutateMemory(
      { worktree: project, directory: project, lockOptions: { acquireTimeoutMs: 50, initialBackoffMs: 5, maxBackoffMs: 20 } },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("lock-timeout")

    // No STATE was written.
    const read = await readMemoryState({ worktree: project, directory: project })
    expect(read.status).toBe("missing")

    await writeFile(release, "go", "utf-8")
    await new Promise<void>((resolve, reject) => {
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))))
      child.on("error", reject)
    })
  })

  it("transaction reads bypass the process cache", async () => {
    const project = await makeWorktree()
    const path = projectMemoryPath(project)
    // Seed at revision 0 and preload the cache.
    await writeState(path, memoryJson(project, 0))
    const cached = await readMemoryState({ worktree: project, directory: project })
    expect(cached.status).toBe("ok")
    if (cached.status === "ok") expect(cached.revision).toBe(0)

    // Record the mtime the cache observed, then externally replace STATE at
    // revision 5 while pinning the new file to that same mtime. A non-bypassing
    // read would reuse the stale cached revision 0; the transaction must not.
    const originalMtime = (await stat(path)).mtimeMs
    await writeState(path, memoryJson(project, 5))
    await utimes(path, new Date(originalMtime), new Date(originalMtime))

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
    const read = await readMemoryState({ worktree: project, directory: project })
    expect(read.status).toBe("ok")
    if (read.status === "ok") expect(read.revision).toBe(6)
  })
})
