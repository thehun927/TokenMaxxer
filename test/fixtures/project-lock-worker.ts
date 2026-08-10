/**
 * Child-process fixture for cross-process project-lock tests.
 *
 * Invoked as:
 *   node --import tsx test/fixtures/project-lock-worker.ts <project> <command> [args...]
 *
 * Commands:
 *   hold-lock <project> <barrier-path>
 *     Acquire the lock via the real `withProjectLock`, signal readiness by
 *     writing `<barrier-path>`, then wait until `<barrier-path>.release`
 *     exists before releasing and exiting 0.
 *
 *   crash-with-lock <project> <ready-path>
 *     Acquire the lock, write `<ready-path>`, then exit abruptly WITHOUT
 *     releasing (simulating a crash that bypasses `finally`).
 *
 * This fixture exercises the real `withProjectLock` implementation, proving
 * the lock works through the actual code rather than a copy.
 */
import { writeFile, access } from "node:fs/promises"
import { withProjectLock } from "../../src/memory/project-lock"

const [, , project, command, ...args] = process.argv

async function waitFor(path: string): Promise<void> {
  for (;;) {
    try {
      await access(path)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}

async function main(): Promise<void> {
  if (!project || !command) {
    console.error("usage: project-lock-worker <project> <command> [args...]")
    process.exit(2)
  }

  if (command === "hold-lock") {
    const barrierPath = args[0]
    if (!barrierPath) {
      console.error("hold-lock requires <barrier-path>")
      process.exit(2)
    }
    await withProjectLock(project, async () => {
      await writeFile(barrierPath, "ready", "utf-8")
      await waitFor(`${barrierPath}.release`)
    })
    process.exit(0)
  }

  if (command === "crash-with-lock") {
    const readyPath = args[0]
    if (!readyPath) {
      console.error("crash-with-lock requires <ready-path>")
      process.exit(2)
    }
    await withProjectLock(project, async () => {
      await writeFile(readyPath, "ready", "utf-8")
      // Wait briefly so the parent observes the ready path before we exit.
      await new Promise((r) => setTimeout(r, 200))
    })
    // Exit abruptly WITHOUT releasing the lock (bypasses `finally`).
    process.exit(0)
  }

  if (command === "recover-lock") {
    const readyPath = args[0]
    if (!readyPath) {
      console.error("recover-lock requires <ready-path>")
      process.exit(2)
    }
    // Attempt to acquire a (possibly dead) lock. If it is dead-same-host, the
    // real implementation quarantines it and re-acquires. Signal readiness once
    // acquired, then release cleanly. Uses withProjectLock so a contender that
    // loses the quarantine race retries until the winner releases.
    await withProjectLock(
      project,
      async () => {
        await writeFile(readyPath, "acquired", "utf-8")
        await new Promise((r) => setTimeout(r, 150))
      },
      {
        acquireTimeoutMs: 3000,
        initialBackoffMs: 5,
        maxBackoffMs: 50,
      },
    )
    process.exit(0)
  }

  console.error(`unknown command: ${command}`)
  process.exit(2)
}

main().catch((error) => {
  console.error("project-lock-worker failed:", error)
  process.exit(1)
})
