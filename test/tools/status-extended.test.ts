import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { _tokenmaxxerStatus, setLastCompaction } from "../../src/tools/status"
import { globalMemoryPath, projectMemoryPath } from "../../src/memory/paths"
import { emptyMemory } from "../../src/memory/schema"
import { atomicWrite } from "../../src/util/fs"

const worktrees: string[] = []
let homeDir: string

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tokenmaxxer-status-ext-"))
  worktrees.push(dir)
  return dir
}

/** A minimal valid STATE.json document for a project at the given revision. */
function memoryJson(project: string, revision: number): string {
  return JSON.stringify({ ...emptyMemory(project), revision }, null, 2)
}

beforeEach(async () => {
  // Isolate the global fallback namespace from the developer's real home.
  homeDir = await mkdtemp(join(tmpdir(), "tokenmaxxer-status-ext-home-"))
  vi.stubEnv("HOME", homeDir)
  ;(setLastCompaction as (ts: string | null) => void)(null as unknown as string)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(homeDir, { recursive: true, force: true })
  await Promise.all(
    worktrees.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe("tokenmaxxer_status reports the selected storage source", () => {
  it("reports the selected local source, path, byte size and revision", async () => {
    const project = await makeProject()
    const content = memoryJson(project, 3)
    await atomicWrite(projectMemoryPath(project), content)

    const status = await _tokenmaxxerStatus({}, { worktree: project, directory: project })

    expect(status).toContain(
      `Memory file: ${projectMemoryPath(project)} (${Buffer.byteLength(content, "utf8")} bytes)`,
    )
    expect(status).toContain("Memory source: project")
    expect(status).toContain("Memory revision: 3")
  })

  it("reports the global source when only a global STATE exists", async () => {
    const project = await makeProject()
    const content = memoryJson(project, 1)
    await atomicWrite(globalMemoryPath(project), content)

    const status = await _tokenmaxxerStatus({}, { worktree: project, directory: project })

    expect(status).toContain("Memory source: global")
    expect(status).toContain(
      `Memory file: ${globalMemoryPath(project)} (${Buffer.byteLength(content, "utf8")} bytes)`,
    )
  })

  it("reports no memory gracefully", async () => {
    const project = await makeProject()

    const status = await _tokenmaxxerStatus({}, { worktree: project, directory: project })

    expect(status).toContain("Memory file: none (0 bytes)")
    expect(status).toContain("Memory source: none")
    expect(status).toContain("Memory revision: 0")
  })

  it("keeps the existing diagnostic lines", async () => {
    const project = await makeProject()
    await atomicWrite(projectMemoryPath(project), memoryJson(project, 2))

    const status = await _tokenmaxxerStatus({}, { worktree: project, directory: project })

    expect(status).toContain(`Project: ${project}`)
    expect(status).toContain("Decisions: 0 (0 valid)")
    expect(status).toContain("Active files: 0")
    expect(status).toContain("Last updated:")
    expect(status).toContain("Last git SHA:")
    expect(status).toContain("Last compaction:")
    expect(status).toContain("Queue depth:")
    expect(status).toContain("In-flight:")
    expect(status).toContain("LLM evidence (process-wide):")
  })
})
