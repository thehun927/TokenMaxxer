import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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

/** Spawn the worker fixture and return the child so the caller can SIGKILL it. */
function spawnWorker(args: string[]): {
  pid: number
  exit: Promise<number>
} {
  const child = spawn(process.execPath, ["--import", "tsx", WORKER, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  })
  let stderr = ""
  child.stderr.on("data", (d) => {
    stderr += String(d)
  })
  const exit = new Promise<number>((resolve, reject) => {
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      // A SIGKILLed crash fixture exits with code null + signal SIGKILL; that
      // is the expected outcome, not a failure.
      if (code === 0 || signal === "SIGKILL") {
        resolve(code ?? 0)
        return
      }
      reject(new Error(`worker exited ${code}: ${stderr}`))
    })
  })
  return { pid: child.pid!, exit }
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

describe("dead same-host owner is recovered (child process, SIGKILL)", () => {
  it("acquires after quarantining a genuinely crashed owner", async () => {
    const project = "/p/dead"
    const ready = join(homeDir, "dead-ready")
    barrierFiles.push(ready)

    // Fork a child that acquires the lock and waits forever inside the
    // callback. Once the ready barrier is observed, SIGKILL it while it is
    // still holding the lock — a genuine crash mid-transaction.
    const child = spawnWorker([project, "crash-with-lock", ready])
    await waitFor(ready)
    process.kill(child.pid, "SIGKILL")
    await child.exit

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

describe("empty canonical lock is not stolen (missing-metadata)", () => {
  it("tryAcquireProjectLock times out and leaves the empty lock intact", async () => {
    const project = "/p/empty"
    const lockDir = projectLockDir(project)
    // Pre-create an EMPTY `.state-lock` with no owner.json.
    await mkdir(lockDir, { recursive: true })

    const start = Date.now()
    let acquired = false
    while (Date.now() - start < 300) {
      const handle = await tryAcquireProjectLock(project, {
        initialBackoffMs: 5,
        maxBackoffMs: 20,
      })
      if (handle) {
        acquired = true
        await handle.release()
        break
      }
      await sleep(10)
    }

    // Must NOT have stolen the empty unknown lock.
    expect(acquired).toBe(false)
    // The `.state-lock` directory still exists.
    await access(lockDir)
    // No owner.json was written into it.
    await expect(access(join(lockDir, "owner.json"))).rejects.toThrow()
  })

  it("withProjectLock throws ProjectLockTimeoutError and leaves the lock unchanged", async () => {
    const project = "/p/empty2"
    const lockDir = projectLockDir(project)
    await mkdir(lockDir, { recursive: true })

    await expect(
      withProjectLock(project, async () => {}, {
        acquireTimeoutMs: 200,
        initialBackoffMs: 5,
        maxBackoffMs: 20,
      }),
    ).rejects.toBeInstanceOf(ProjectLockTimeoutError)

    // Lock directory is unchanged (still empty).
    await access(lockDir)
    const entries = await readdir(lockDir)
    expect(entries).toEqual([])
  })
})

describe("release/acquire handoff (retire-then-delete)", () => {
  it("owner A's cleanup does not touch owner B's lock after B acquires", async () => {
    const project = "/p/handoff"
    const lockDir = projectLockDir(project)

    // Owner A acquires and holds.
    const handleA = await tryAcquireProjectLock(project)
    expect(handleA).not.toBeNull()

    // Owner B starts acquiring, paused at the classification barrier. It will
    // observe A's live lock, pause, and wait for the release barrier.
    const barrier = join(homeDir, "handoff-barrier")
    barrierFiles.push(barrier, `${barrier}.release`)
    const bPromise = withProjectLock(
      project,
      async () => {
        // B holds the lock; verify B's owner.json is intact (A's cleanup did
        // NOT touch B's lock).
        const raw = await readFile(join(lockDir, "owner.json"), "utf-8")
        const owner = JSON.parse(raw)
        expect(typeof owner.nonce).toBe("string")
      },
      {
        acquireTimeoutMs: 5000,
        initialBackoffMs: 5,
        maxBackoffMs: 20,
        waitForClassificationBarrier: barrier,
      },
    )

    // Wait for B to classify A's live lock and pause at the barrier.
    await waitFor(barrier)

    // A releases (retire-then-delete). B resumes and acquires.
    await handleA!.release()
    await writeFile(`${barrier}.release`, "go", "utf-8")

    await bPromise
    // After B releases, the canonical lock is gone.
    await expect(access(lockDir)).rejects.toThrow()
  })
})

describe("release cleanup operates on a retired path", () => {
  it("removes a unique .state-lock.released.<nonce>.* path, not the canonical path", async () => {
    const project = "/p/retired"
    const lockDir = projectLockDir(project)
    const parentDir = globalProjectStorageDir(project)

    const handle = await tryAcquireProjectLock(project)
    expect(handle).not.toBeNull()

    // Before release, no retired path exists.
    const before = await readdir(parentDir)
    expect(before.some((e) => e.startsWith(".state-lock.released."))).toBe(false)

    const released = await handle!.release()
    expect(released).toBe(true)

    // After release, the canonical lock is gone.
    await expect(access(lockDir)).rejects.toThrow()
    // The retired path was cleaned up (best-effort recursive delete).
    const after = await readdir(parentDir)
    expect(after.some((e) => e.startsWith(".state-lock.released."))).toBe(false)
  })
})

describe("ABA-safe stale recovery", () => {
  it("two contenders recover a dead lock without deleting a replacement", async () => {
    const project = "/p/aba"
    const ready = join(homeDir, "aba-ready")
    barrierFiles.push(ready)

    // Create a genuinely dead lock via a SIGKILLed child.
    const crash = spawnWorker([project, "crash-with-lock", ready])
    await waitFor(ready)
    process.kill(crash.pid, "SIGKILL")
    await crash.exit

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

describe("replacement between classification and quarantine (recovery claim)", () => {
  it("C1 must not move/delete a live replacement B acquired after C1's classification", async () => {
    const project = "/p/replace"
    const lockDir = projectLockDir(project)

    // Create a genuinely dead lock via a SIGKILLed child.
    const ready = join(homeDir, "replace-ready")
    barrierFiles.push(ready)
    const crash = spawnWorker([project, "crash-with-lock", ready])
    await waitFor(ready)
    process.kill(crash.pid, "SIGKILL")
    await crash.exit

    // C1 starts acquiring, classifies dead owner A, and pauses at the
    // classification barrier (before any recovery claim / quarantine).
    const c1Barrier = join(homeDir, "replace-c1")
    barrierFiles.push(c1Barrier, `${c1Barrier}.release`)
    let c1Acquired = false
    const c1Promise = withProjectLock(
      project,
      async () => {
        c1Acquired = true
      },
      {
        acquireTimeoutMs: 5000,
        initialBackoffMs: 5,
        maxBackoffMs: 20,
        waitForClassificationBarrier: c1Barrier,
      },
    )

    // Wait for C1 to classify dead A and pause at the barrier.
    await waitFor(c1Barrier)

    // C2 (this process) recovers A, acquires a fresh live lock B, and holds it.
    const handleB = await tryAcquireProjectLock(project)
    expect(handleB).not.toBeNull()
    const bNonce = handleB!.owner.nonce

    // Verify B's canonical lock directory and nonce are intact while held.
    await access(lockDir)
    const rawB = await readFile(join(lockDir, "owner.json"), "utf-8")
    expect(JSON.parse(rawB).nonce).toBe(bNonce)

    // Resume C1. C1 must re-classify (seeing live owner B), back off, and NOT
    // move/delete B. It must remain contended until B releases.
    await writeFile(`${c1Barrier}.release`, "go", "utf-8")
    await sleep(200)

    // B's lock is still intact and untouched by C1.
    await access(lockDir)
    const rawB2 = await readFile(join(lockDir, "owner.json"), "utf-8")
    expect(JSON.parse(rawB2).nonce).toBe(bNonce)

    // Release B. Only now may C1 acquire.
    await handleB!.release()
    await c1Promise
    expect(c1Acquired).toBe(true)
    await expect(access(lockDir)).rejects.toThrow()
  })
})

describe("post-claim-revalidation barrier (canonical claim identity)", () => {
  it("a second recoverer cannot replace the stale lock while C1 holds the canonical claim", async () => {
    const project = "/p/postclaim"
    const lockDir = projectLockDir(project)

    // 1. Create a genuinely dead owner A via a SIGKILLed child.
    const ready = join(homeDir, "postclaim-ready")
    barrierFiles.push(ready)
    const crash = spawnWorker([project, "crash-with-lock", ready])
    await waitFor(ready)
    process.kill(crash.pid, "SIGKILL")
    await crash.exit

    // Verify the stale owner.json exists and its PID is dead.
    const rawA = await readFile(join(lockDir, "owner.json"), "utf-8")
    const ownerA = JSON.parse(rawA)
    expect(typeof ownerA.nonce).toBe("string")
    expect(() => process.kill(ownerA.pid, 0)).toThrow()

    // 2. C1 acquires, classifies dead A, acquires the canonical claim, and
    //    pauses AFTER claim revalidation but BEFORE quarantine.
    const postClaimBarrier = join(homeDir, "postclaim-c1")
    barrierFiles.push(postClaimBarrier, `${postClaimBarrier}.reached`)
    let c1Acquired = false
    const c1Promise = withProjectLock(
      project,
      async () => {
        c1Acquired = true
      },
      {
        acquireTimeoutMs: 5000,
        initialBackoffMs: 5,
        maxBackoffMs: 20,
        waitForPostClaimBarrier: postClaimBarrier,
      },
    )

    // Wait for C1 to reach the post-claim barrier (claim acquired + revalidated).
    await waitFor(`${postClaimBarrier}.reached`)

    // 3. While C1 is paused, a second caller attempts to acquire. It classifies
    //    dead A, tries to create the SAME canonical claim, hits EEXIST, and
    //    backs off until its bounded timeout.
    await expect(
      withProjectLock(project, async () => {}, {
        acquireTimeoutMs: 200,
        initialBackoffMs: 5,
        maxBackoffMs: 20,
      }),
    ).rejects.toBeInstanceOf(ProjectLockTimeoutError)

    // The stale lock is still intact and untouched by the second caller.
    await access(lockDir)
    const rawA2 = await readFile(join(lockDir, "owner.json"), "utf-8")
    expect(JSON.parse(rawA2).nonce).toBe(ownerA.nonce)

    // 4. Resume C1. It quarantines the stale lock, acquires a fresh lock, runs
    //    the op, and releases.
    await writeFile(postClaimBarrier, "go", "utf-8")
    await c1Promise
    expect(c1Acquired).toBe(true)

    // 5. Now the second caller may proceed. It acquires cleanly and the new
    //    owner is NOT the stale A.
    await withProjectLock(project, async () => {
      const raw = await readFile(join(lockDir, "owner.json"), "utf-8")
      const owner = JSON.parse(raw)
      expect(owner.nonce).not.toBe(ownerA.nonce)
      // Exactly one owner whose PID is alive.
      expect(() => process.kill(owner.pid, 0)).not.toThrow()
    })

    // 6. After release the canonical lock is gone.
    await expect(access(lockDir)).rejects.toThrow()
  })
})
