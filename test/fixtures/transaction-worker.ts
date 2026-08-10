/**
 * Child-process fixture for cross-process transaction tests.
 *
 * Invoked as:
 *   node --import tsx test/fixtures/transaction-worker.ts <project> <command> [args...]
 *
 * Commands:
 *   idle-write <project> <fact-id>
 *     Call the real `mutateMemory` with a synchronous callback that appends a
 *     decision containing `<fact-id>`, commit, and print a single JSON line
 *     `{ status, revision }` to stdout. Exit 0 on ok, 1 on failure.
 *
 *   hold-lock <project> <barrier-path>
 *     Acquire the lock via the real `withProjectLock`, signal readiness by
 *     writing `<barrier-path>`, then wait until `<barrier-path>.release`
 *     exists before releasing and exiting 0.
 *
 *   noop-write <project>
 *     Call `mutateMemory` with a no-op action; print `{ status: "noop",
 *     revision }` and exit 0.
 *
 * This fixture exercises the real `mutateMemory` / `withProjectLock`
 * implementations, proving cross-process correctness through the actual code.
 */
import { writeFile, access } from "node:fs/promises"
import { mutateMemory } from "../../src/memory/store"
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

function printResult(result: { status: string; revision?: number }): void {
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

async function main(): Promise<void> {
  if (!project || !command) {
    console.error("usage: transaction-worker <project> <command> [args...]")
    process.exit(2)
  }

  if (command === "idle-write") {
    const factId = args[0]
    if (!factId) {
      console.error("idle-write requires <fact-id>")
      process.exit(2)
    }
    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({
        kind: "commit",
        memory: {
          ...memory,
          decisions: [
            ...memory.decisions,
            {
              id: `fact-${factId}`,
              topic: `topic-${factId}`,
              decision: `decision-${factId}`,
              timestamp: new Date().toISOString(),
              session_id: `worker-${factId}`,
              still_valid: true,
              foundational: false,
              provenance: {
                extractor: "heuristic",
                source_session_id: `worker-${factId}`,
                confidence: "heuristic",
                evidence: [],
              },
            },
          ],
        },
        value: null,
      }),
    )
    if (result.status === "committed") {
      printResult({ status: "ok", revision: result.revision })
      process.exit(0)
    }
    printResult({ status: result.status })
    process.exit(1)
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

  if (command === "noop-write") {
    const result = await mutateMemory(
      { worktree: project, directory: project },
      () => ({ kind: "noop", value: null }),
    )
    if (result.status === "noop") {
      printResult({ status: "noop", revision: result.revision })
      process.exit(0)
    }
    printResult({ status: result.status })
    process.exit(1)
  }

  console.error(`unknown command: ${command}`)
  process.exit(2)
}

main().catch((error) => {
  console.error("transaction-worker failed:", error)
  process.exit(1)
})
