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
 *     Acquire the lock, write `<ready-path>`, then wait FOREVER inside the
 *     `withProjectLock` callback. The parent test process observes the ready
 *     barrier and sends SIGKILL to this child while it is still holding the
 *     lock, so the lock is genuinely left behind (a real crash mid-transaction).
 *     The dead PID is then detected via `process.kill(pid, 0)` returning ESRCH.
 *
 *   acquire-and-hold <project> <ready-path>
 *     Same acquire-and-wait-forever pattern as `crash-with-lock`, but the
 *     parent does NOT kill it. It is released cleanly when the test ends (the
 *     parent writes `<ready-path>.release`). Use this for tests that need a
 *     real held lock (not a crashed one).
 *
 *   recover-lock <project> <ready-path>
 *     Attempt to acquire a (possibly dead) lock. If it is dead-same-host, the
 *     real implementation quarantines it and re-acquires. Signal readiness once
 *     acquired, then release cleanly. Uses withProjectLock so a contender that
 *     loses the quarantine race retries until the winner releases.
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
    // Acquire the lock and wait forever inside the callback. The parent test
    // process SIGKILLs this child once the ready barrier is observed, leaving
    // the lock genuinely behind (a real crash mid-transaction). A bare
    // `new Promise(() => {})` would let the event loop drain and exit 0, so we
    // keep a timer alive to hold the process (and the lock) until SIGKILL.
    await withProjectLock(project, async () => {
      await writeFile(readyPath, "ready", "utf-8")
      await new Promise<void>(() => {
        setInterval(() => {}, 1000)
      })
    })
    // Unreachable unless the parent releases us cleanly.
    process.exit(0)
  }

  if (command === "acquire-and-hold") {
    const readyPath = args[0]
    if (!readyPath) {
      console.error("acquire-and-hold requires <ready-path>")
      process.exit(2)
    }
    // Acquire and hold until the parent writes `<ready-path>.release`, then
    // release cleanly. Used for tests that need a real held lock (not a crash).
    await withProjectLock(project, async () => {
      await writeFile(readyPath, "ready", "utf-8")
      await waitFor(`${readyPath}.release`)
    })
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
