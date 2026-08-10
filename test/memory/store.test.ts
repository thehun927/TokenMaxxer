import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { readMemoryState } from "../../src/memory/store"
import {
  globalMemoryPath,
  projectMemoryPath,
} from "../../src/memory/paths"
import { emptyMemory } from "../../src/memory/schema"
import { atomicWrite } from "../../src/util/fs"

const worktrees: string[] = []
let homeDir: string

async function makeWorktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tokenmaxxer-store-"))
  worktrees.push(dir)
  return dir
}

/** A minimal valid STATE.json document for a project at the given revision. */
function memoryJson(project: string, revision: number): string {
  return JSON.stringify({ ...emptyMemory(project), revision }, null, 2)
}

async function writeState(path: string, content: string): Promise<void> {
  await atomicWrite(path, content)
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
    await writeState(projectMemoryPath(project), memoryJson(project, 1))
    await writeState(globalMemoryPath(project), memoryJson(project, 1))

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result.source).toBe("project")
    expect(result.revision).toBe(1)
  })

  it("local unreadable + no global: no silent empty initialization", async () => {
    const project = await makeWorktree()
    await makeUnreadable(projectMemoryPath(project))

    const result = await readMemoryState({ worktree: project, directory: project })

    expect(result).toEqual({
      memory: null,
      source: null,
      path: null,
      sizeBytes: 0,
      revision: 0,
    })
  })

  it("local unreadable + valid global: selects the global source", async () => {
    const project = await makeWorktree()
    await makeUnreadable(projectMemoryPath(project))
    await writeState(globalMemoryPath(project), memoryJson(project, 1))

    const result = await readMemoryState({ worktree: project, directory: project })

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
