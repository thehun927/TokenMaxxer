import { describe, expect, it } from "vitest"
import { homedir } from "node:os"
import {
  globalMemoryPath,
  globalProjectStorageDir,
  projectMemoryPath,
  projectStorageHash,
  resolveProjectPath,
} from "../../src/memory/paths"

describe("resolveProjectPath", () => {
  it("returns the worktree when it is a valid path", () => {
    expect(resolveProjectPath("/worktree", "/cwd")).toBe("/worktree")
  })

  it("falls back to directory when worktree is root", () => {
    expect(resolveProjectPath("/", "/cwd")).toBe("/cwd")
  })

  it("falls back to directory when worktree is empty", () => {
    expect(resolveProjectPath("", "/cwd")).toBe("/cwd")
  })

  it("prefers a valid worktree even when directory is empty", () => {
    expect(resolveProjectPath("/worktree", "")).toBe("/worktree")
  })
})

describe("projectMemoryPath", () => {
  it("returns the project-local STATE.json path", () => {
    expect(projectMemoryPath("/p")).toBe("/p/.opencode/memory/STATE.json")
  })
})

describe("global fallback paths", () => {
  it("returns the hashed global storage directory", () => {
    const hash = projectStorageHash("/p")
    expect(globalProjectStorageDir("/p")).toBe(
      `${homedir()}/.config/opencode/memory/${hash}`,
    )
  })

  it("returns the hashed global STATE.json path", () => {
    const hash = projectStorageHash("/p")
    expect(globalMemoryPath("/p")).toBe(
      `${homedir()}/.config/opencode/memory/${hash}/STATE.json`,
    )
  })
})

describe("projectStorageHash", () => {
  it("is a deterministic 16-char hex string", () => {
    const hash = projectStorageHash("/p")
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it("returns the same hash for the same input", () => {
    expect(projectStorageHash("/p")).toBe(projectStorageHash("/p"))
  })

  it("returns different hashes for different inputs", () => {
    expect(projectStorageHash("/p")).not.toBe(projectStorageHash("/q"))
  })
})
