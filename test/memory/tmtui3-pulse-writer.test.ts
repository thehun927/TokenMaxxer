/**
 * TMTUI-3 post-PR8 pulse semantics — writer boundary
 * (docs/TMTUI/implementation-plan.md §2.11–2.12).
 *
 * `writeMemoryOnIdle()` is the session.idle entry point. Its pulse contract
 * mirrors the store boundary: a durable STATE commit anywhere in the pipeline
 * produces exactly one pulse, while every non-committing outcome (no-messages,
 * error, write-failed, cache-hit/noop) produces none.
 *
 * Also proves the legacy activity mechanism is no longer the status authority:
 * a successful idle write must never create the legacy local activity marker
 * file that used to drive the optimistic idle LED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { writeMemoryOnIdle } from "../../src/memory/writer"
import { readMemory } from "../../src/memory/store"
import { globalMemoryPath, projectMemoryPath } from "../../src/memory/paths"
import type { TranscriptMessage } from "../../src/types"
import { memoryCommitPulsePath } from "../../src/memory/commit-pulse"
import * as commitPulse from "../../src/memory/commit-pulse"
import { resetProjectQueues } from "../../src/memory/lock"
import { resetHostStructuredContractGate } from "../../src/memory/llm-adapter"

const directories: string[] = []
let pulseSpy: ReturnType<typeof vi.spyOn>

function messages(sessionID = "source"): TranscriptMessage[] {
  return [
    {
      info: { id: `${sessionID}-user`, role: "user" },
      parts: [{ type: "text", text: `Implement ${sessionID} extraction.` }],
    },
    {
      info: { id: `${sessionID}-assistant`, role: "assistant" },
      parts: [{ type: "text", text: "We will use a bounded queue for this project." }],
    },
  ]
}

function clientFor(sessionMap: Record<string, TranscriptMessage[]>) {
  return {
    app: { log: vi.fn() },
    session: {
      messages: vi.fn(async ({ path }: { path: { id: string } }) => ({ data: sessionMap[path.id] })),
    },
  }
}

async function worktree(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tokenmaxxer-tmtui3-writer-"))
  directories.push(directory)
  return directory
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
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${path}`)
      }
      await sleep(10)
    }
  }
}

beforeEach(() => {
  pulseSpy = vi.spyOn(commitPulse, "recordMemoryCommit")
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetProjectQueues()
  resetHostStructuredContractGate()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("TMTUI-3 — writer success pulse", () => {
  it("a heuristic-only idle write records exactly one pulse", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()
    const client = clientFor({ source: messages() })

    const outcome = await writeMemoryOnIdle({
      client,
      worktree: project,
      directory: project,
      sessionId: "source",
    })
    expect(outcome).toBe("heuristic-only")

    const memory = await readMemory({ worktree: project, directory: project })
    expect(memory?.revision).toBe(1)

    // Exactly one pulse for the one durable heuristic commit.
    expect(pulseSpy).toHaveBeenCalledTimes(1)
    expect(pulseSpy).toHaveBeenCalledWith(project)
  })
})

describe("TMTUI-3 — writer emits no pulse without a durable commit", () => {
  it("no-messages idle write records no pulse", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()
    const client = { app: { log: vi.fn() } } // no session.messages endpoint

    const outcome = await writeMemoryOnIdle({
      client,
      worktree: project,
      directory: project,
      sessionId: "source",
    })
    expect(outcome).toBe("no-messages")
    expect(pulseSpy).not.toHaveBeenCalled()
  })

  it("empty transcript idle write records no pulse", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()
    const client = clientFor({ source: [] })

    const outcome = await writeMemoryOnIdle({
      client,
      worktree: project,
      directory: project,
      sessionId: "source",
    })
    expect(outcome).toBe("no-messages")
    expect(pulseSpy).not.toHaveBeenCalled()
  })

  it("session.messages throwing records no pulse (error outcome)", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()
    const client = {
      app: { log: vi.fn() },
      session: {
        messages: vi.fn(async () => {
          throw new Error("session.messages failed")
        }),
      },
    }

    const outcome = await writeMemoryOnIdle({
      client,
      worktree: project,
      directory: project,
      sessionId: "source",
    })
    expect(outcome).toBe("error")
    expect(pulseSpy).not.toHaveBeenCalled()
  })

  it("unavailable authoritative read during preparation records no pulse (write-failed)", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()
    // Both STATE candidates unreadable → preparation fails closed with
    // write-failed before any transaction/commit can run.
    await mkdir(projectMemoryPath(project), { recursive: true })
    await mkdir(globalMemoryPath(project), { recursive: true })
    const client = clientFor({ source: messages() })

    const outcome = await writeMemoryOnIdle({
      client,
      worktree: project,
      directory: project,
      sessionId: "source",
    })
    expect(outcome).toBe("write-failed")
    expect(pulseSpy).not.toHaveBeenCalled()
  })
})

describe("TMTUI-3 — no legacy activity marker is created", () => {
  it("successful idle processing never creates the legacy activity marker file", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()
    const client = clientFor({ source: messages() })

    const outcome = await writeMemoryOnIdle({
      client,
      worktree: project,
      directory: project,
      sessionId: "source",
    })
    expect(outcome).toBe("heuristic-only")

    // The old optimistic idle LED was driven by a local activity marker at
    // `<project>/.opencode/.tokenmaxxer-memory-activity`. TMTUI-3 removed
    // that mechanism from the writer; processing must never recreate it, even
    // though the `.opencode` directory now exists for STATE.json.
    await expect(
      access(join(project, ".opencode", ".tokenmaxxer-memory-activity")),
    ).rejects.toThrow()
  })
})

describe("TMTUI-3 — writer marker isolation", () => {
  it("a successful idle write emits a pulse marker only in the global namespace", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()
    const client = clientFor({ source: messages() })

    const outcome = await writeMemoryOnIdle({
      client,
      worktree: project,
      directory: project,
      sessionId: "source",
    })
    expect(outcome).toBe("heuristic-only")

    // `recordMemoryCommit` is fire-and-forget at the canonical boundary, so
    // wait for the marker to land before reading it.
    await waitFor(memoryCommitPulsePath(project))

    const raw = await readFile(memoryCommitPulsePath(project), "utf-8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(["committed_at"])
    expect(typeof parsed.committed_at).toBe("number")
    expect(Number.isFinite(parsed.committed_at as number)).toBe(true)

    // Marker never lives inside the worktree.
    expect(memoryCommitPulsePath(project).startsWith(project)).toBe(false)
  })
})
