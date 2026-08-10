import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { writeMemoryOnIdle } from "../../src/memory/writer"
import { readMemory, resolveProjectPath } from "../../src/memory/store"
import { resetProjectQueues } from "../../src/memory/lock"
import { resetHostStructuredContractGate } from "../../src/memory/llm-adapter"
import type { TranscriptMessage } from "../../src/types"

const directories: string[] = []

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

async function worktree(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tokenmaxxer-nongit-"))
  directories.push(directory)
  return directory
}

function clientFor(sessionMap: Record<string, TranscriptMessage[]>) {
  return {
    app: { log: vi.fn() },
    config: { get: vi.fn(async () => ({ data: { small_model: "provider/model" } })) },
    session: {
      messages: vi.fn(async ({ path }: { path: { id: string } }) => ({ data: sessionMap[path.id] })),
    },
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  resetHostStructuredContractGate()
  resetProjectQueues()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("non-git identity", () => {
  it("records the real directory as project_path when worktree is /", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const directory = await worktree()
    const client = clientFor({ source: messages() })

    const outcome = await writeMemoryOnIdle({ client, worktree: "/", directory, sessionId: "source" })
    expect(outcome).toBe("heuristic-only")

    const memory = await readMemory({ worktree: "/", directory })
    expect(memory?.project_path).toBe(directory)
    expect(memory?.project_path).not.toBe("/")
  })

  it("read-back project_path matches the resolved directory", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const directory = await worktree()
    const client = clientFor({ source: messages() })

    await writeMemoryOnIdle({ client, worktree: "/", directory, sessionId: "source" })
    const memory = await readMemory({ worktree: "/", directory })
    expect(memory?.project_path).toBe(resolveProjectPath("/", directory))
  })

  it("uses the worktree as project_path when worktree is valid", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const directory = await worktree()
    const client = clientFor({ source: messages() })

    await writeMemoryOnIdle({ client, worktree: directory, directory, sessionId: "source" })
    const memory = await readMemory({ worktree: directory, directory })
    expect(memory?.project_path).toBe(directory)
  })
})
