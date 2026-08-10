import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

import {
  ProjectLockTimeoutError,
  tryAcquireProjectLock,
  withProjectLock,
} from "../../src/memory/project-lock"
import {
  globalProjectStorageDir,
  projectLockDir,
} from "../../src/memory/paths"

const WORKER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "project-lock-worker.ts",
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
function runWorker(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    let stderr = ""
    child.stderr.on("data", (d) => {
      stderr += String(d)
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`worker exited ${code}: ${stderr}`))
        return
      }
      resolve(code)
    })
  })
}

async function writeOwner(lockDir: string, owner: unknown): Promise<void> {
  await mkdir(lockDir, { recursive: true })
  await writeFile(
    join(lockDir, "owner.json"),
    JSON.stringify(owner, null, 2),
    "utf-8",
  )
}

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "tokenmaxxer-lock-home-"))
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

describe("projectLockDir", () => {
  it("lives under the global hashed namespace", () => {
    const project = "/some/project"
    expect(projectLockDir(project)).toBe(
      join(globalProjectStorageDir(project), ".state-lock"),
    )
  })
})

describe("withProjectLock", () => {
  it("acquires and releases a single-process lock", async () => {
    const project = "/p/single"
    await withProjectLock(project, async () => {
      // Lock is held here.
      await access(projectLockDir(project))
    })
    // Lock directory is gone after release.
    await expect(access(projectLockDir(project))).rejects.toThrow()
  })

  it("serializes concurrent same-process acquisitions", async () => {
    const project = "/p/serialize"
    let active = 0
    let maxActive = 0
    const op = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await sleep(30)
      active -= 1
    }
    await Promise.all([
      withProjectLock(project, op),
      withProjectLock(project, op),
    ])
    expect(maxActive).toBe(1)
  })

  it("does not block different projects", async () => {
    const projectA = "/p/a"
    const projectB = "/p/b"
    const handleA = await tryAcquireProjectLock(projectA)
    expect(handleA).not.toBeNull()
    try {
      // B acquires and finishes while A is still held.
      await withProjectLock(projectB, async () => {
        await access(projectLockDir(projectB))
      })
      // A's lock is still held.
      await access(projectLockDir(projectA))
    } finally {
      await handleA!.release()
    }
  })

  it("throws ProjectLockTimeoutError on acquisition timeout", async () => {
    const project = "/p/timeout"
    const handle = await tryAcquireProjectLock(project)
    expect(handle).not.toBeNull()
    try {
      await expect(
        withProjectLock(project, async () => {}, {
          acquireTimeoutMs: 100,
          initialBackoffMs: 5,
          maxBackoffMs: 20,
        }),
      ).rejects.toBeInstanceOf(ProjectLockTimeoutError)
    } finally {
      await handle!.release()
    }
  })

  it("releases the lock when the operation throws", async () => {
    const project = "/p/throw"
    await expect(
      withProjectLock(project, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    await expect(access(projectLockDir(project))).rejects.toThrow()
  })
})

describe("release with mismatched nonce", () => {
  it("is a no-op and leaves the lock directory intact", async () => {
    const project = "/p/nonce"
    const handle = await tryAcquireProjectLock(project)
    expect(handle).not.toBeNull()
    // Simulate a foreign acquisition replacing the owner with a different nonce.
    await writeOwner(projectLockDir(project), {
      ...handle!.owner,
      nonce: "different-nonce",
    })
    const released = await handle!.release()
    expect(released).toBe(false)
    // Lock directory still exists.
    await access(projectLockDir(project))
  })
})

describe("live same-host owner is not stolen (child process)", () => {
  it("times out while a child holds the lock, then releases cleanly", async () => {
    const project = "/p/live"
    const barrier = join(homeDir, "live-barrier")
    barrierFiles.push(barrier, `${barrier}.release`)

    const childPromise = runWorker([project, "hold-lock", barrier])
    await waitFor(barrier)

    await expect(
      withProjectLock(project, async () => {}, {
        acquireTimeoutMs: 200,
        initialBackoffMs: 5,
        maxBackoffMs: 20,
      }),
    ).rejects.toBeInstanceOf(ProjectLockTimeoutError)

    // Signal release; the child releases and exits 0.
    await writeFile(`${barrier}.release`, "go", "utf-8")
    await childPromise
    await expect(access(projectLockDir(project))).rejects.toThrow()
  })
})

describe("dead same-host owner is recovered (child process)", () => {
  it("acquires after quarantining a crashed owner", async () => {
    const project = "/p/dead"
    const ready = join(homeDir, "dead-ready")
    barrierFiles.push(ready)

    const childPromise = runWorker([project, "crash-with-lock", ready])
    await waitFor(ready)
    await childPromise

    // The child crashed without releasing; we must recover and acquire.
    await withProjectLock(project, async () => {
      await access(projectLockDir(project))
    }, {
      acquireTimeoutMs: 3000,
      initialBackoffMs: 5,
      maxBackoffMs: 50,
    })
    await expect(access(projectLockDir(project))).rejects.toThrow()
  })
})

describe("foreign host is not stolen", () => {
  it("times out without modifying the lock", async () => {
    const project = "/p/foreign"
    const lockDir = projectLockDir(project)
    const owner = {
      version: 1,
      pid: 999999,
      hostname: "some-other-host",
      acquired_at: new Date().toISOString(),
      nonce: "foreign-nonce",
    }
    await writeOwner(lockDir, owner)

    await expect(
      withProjectLock(project, async () => {}, {
        acquireTimeoutMs: 150,
        initialBackoffMs: 5,
        maxBackoffMs: 20,
      }),
    ).rejects.toBeInstanceOf(ProjectLockTimeoutError)

    // Lock remains intact and unmodified.
    const raw = await readFile(join(lockDir, "owner.json"), "utf-8")
    expect(JSON.parse(raw)).toEqual(owner)
  })
})

describe("malformed owner is not stolen", () => {
  it("times out without modifying the lock", async () => {
    const project = "/p/malformed"
    const lockDir = projectLockDir(project)
    await mkdir(lockDir, { recursive: true })
    await writeFile(join(lockDir, "owner.json"), "{ not valid json", "utf-8")

    await expect(
      withProjectLock(project, async () => {}, {
        acquireTimeoutMs: 150,
        initialBackoffMs: 5,
        maxBackoffMs: 20,
      }),
    ).rejects.toBeInstanceOf(ProjectLockTimeoutError)

    await access(lockDir)
  })
})

describe("unknown owner (read error) is not stolen", () => {
  it("times out when owner.json is unreadable", async () => {
    const project = "/p/unreadable"
    const lockDir = projectLockDir(project)
    await mkdir(lockDir, { recursive: true })
    // Place a directory at the owner.json path so readFile fails (EISDIR).
    await mkdir(join(lockDir, "owner.json"))

    await expect(
      withProjectLock(project, async () => {}, {
        acquireTimeoutMs: 150,
        initialBackoffMs: 5,
        maxBackoffMs: 20,
      }),
    ).rejects.toBeInstanceOf(ProjectLockTimeoutError)

    await access(lockDir)
  })
})

describe("ABA-safe stale recovery", () => {
  it("two contenders recover a dead lock without deleting a replacement", async () => {
    const project = "/p/aba"
    const ready = join(homeDir, "aba-ready")
    barrierFiles.push(ready)

    // Create a dead lock via a crashed child.
    const crash = runWorker([project, "crash-with-lock", ready])
    await waitFor(ready)
    await crash

    // Two contenders attempt recovery simultaneously.
    const readyA = join(homeDir, "aba-a")
    const readyB = join(homeDir, "aba-b")
    barrierFiles.push(readyA, readyB)

    const [codeA, codeB] = await Promise.all([
      runWorker([project, "recover-lock", readyA]),
      runWorker([project, "recover-lock", readyB]),
    ])

    // Both must succeed (one quarantines, the other re-acquires cleanly).
    expect(codeA).toBe(0)
    expect(codeB).toBe(0)
    await expect(access(projectLockDir(project))).rejects.toThrow()
  })
})
