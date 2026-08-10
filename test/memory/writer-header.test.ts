import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import * as writer from "../../src/memory/writer"
import { writeMemoryOnIdle } from "../../src/memory/writer"
import { readMemory } from "../../src/memory/store"
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
  const directory = await mkdtemp(join(tmpdir(), "tokenmaxxer-header-"))
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

describe("HEADER is derivative and best-effort", () => {
  it("keeps a successful heuristic STATE write successful when HEADER generation throws", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()
    const client = clientFor({ source: messages() })
    vi.spyOn(writer, "generateHeader").mockRejectedValue(new Error("boom"))

    const outcome = await writeMemoryOnIdle({ client, worktree: project, directory: project, sessionId: "source" })

    // The heuristic write succeeded, so the outcome must not be write-failed.
    expect(outcome).toBe("heuristic-only")
    const memory = await readMemory({ worktree: project, directory: project })
    expect(memory).not.toBeNull()
    expect(memory?.current_task).toBe("Implement source extraction.")
  })

  it("logs the header failure at warn level without throwing", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()
    const client = clientFor({ source: messages() })
    vi.spyOn(writer, "generateHeader").mockRejectedValue(new Error("boom"))

    await writeMemoryOnIdle({ client, worktree: project, directory: project, sessionId: "source" })

    expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        level: "warn",
        message: "header generation failed",
        extra: expect.objectContaining({ error: "Error: boom" }),
      }),
    }))
  })

  it("still records HEADER.md when HEADER generation succeeds (regression guard)", async () => {
    vi.stubEnv("TOKENMAXXER_LLM_EXTRACT", "0")
    const project = await worktree()
    const client = clientFor({ source: messages() })

    await writeMemoryOnIdle({ client, worktree: project, directory: project, sessionId: "source" })

    const headerPath = join(project, ".opencode", "memory", "HEADER.md")
    const content = await readFile(headerPath, "utf8")
    expect(content).toContain("# Project:")
  })
})
