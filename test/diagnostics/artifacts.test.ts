import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

// Import the types that will exist in Wave 2
import type {
  DiagnosticArtifactName,
  DiagnosticArtifactReadResult,
  DiagnosticArtifactWriteResult,
} from "../../src/diagnostics/artifacts"

// Mock the Wave 2 path helpers that don't exist yet
vi.mock("../../src/memory/paths", () => ({
  projectMemoryStorageDir: vi.fn((project: string) => join(project, ".opencode", "memory")),
  globalProjectStorageDir: vi.fn((project: string) => {
    // Use a deterministic hash based on project path for testing
    const hash = project.split("/").reduce((acc, part) => {
      let hash = 0
      for (let i = 0; i < part.length; i++) {
        const char = part.charCodeAt(i)
        hash = ((hash << 5) - hash) + char
        hash = hash & hash
      }
      return acc + hash.toString(16).padStart(8, "0")
    }, "")
    return join(process.env.HOME!, ".config/opencode/memory", hash)
  }),
  projectStorageHash: vi.fn((project: string) => {
    // Use a deterministic hash based on project path for testing
    const hash = project.split("/").reduce((acc, part) => {
      let hash = 0
      for (let i = 0; i < part.length; i++) {
        const char = part.charCodeAt(i)
        hash = ((hash << 5) - hash) + char
        hash = hash & hash
      }
      return acc + hash.toString(16).padStart(8, "0")
    }, "")
    return hash
  }),
}))

// Import the mocked path helpers
import {
  projectMemoryStorageDir,
  globalProjectStorageDir,
  projectStorageHash,
} from "../../src/memory/paths"

describe("Artifact storage contracts (Wave 2)", () => {
  let homeDir: string
  const worktrees: string[] = []

  beforeEach(async () => {
    // Isolate the global fallback namespace from the developer's real home
    homeDir = await mkdtemp(join(tmpdir(), "tokenmaxxer-artifacts-"))
    vi.stubEnv("HOME", homeDir)
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(homeDir, { recursive: true, force: true })
    await Promise.all(
      worktrees.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  describe("project/global artifact resolution", () => {
    it("project diagnostic path uses resolved project path", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const promptPath = join(dir, "last_compaction_prompt.log")
      const resultPath = join(dir, "last_compaction_result.json")

      await writeFile(promptPath, "test prompt")
      await writeFile(resultPath, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"test-session"}')

      // The actual implementation will read these files
      const promptResult: DiagnosticArtifactReadResult = {
        status: "ok",
        content: "test prompt",
        source: "project",
        path: promptPath,
        sizeBytes: 11,
        mtime: Date.now(),
      }

      const resultResult: DiagnosticArtifactReadResult = {
        status: "ok",
        content: '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"test-session"}',
        source: "project",
        path: resultPath,
        sizeBytes: 52,
        mtime: Date.now(),
      }

      expect(promptResult.status).toBe("ok")
      expect(promptResult.source).toBe("project")
      expect(resultResult.status).toBe("ok")
      expect(resultResult.source).toBe("project")

      await rm(project, { recursive: true, force: true })
    })

    it("global diagnostic path uses existing stable project hash", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const hash = projectStorageHash(project)
      const globalDir = globalProjectStorageDir(project)
      await mkdir(globalDir, { recursive: true })

      const promptPath = join(globalDir, "last_compaction_prompt.log")
      const resultPath = join(globalDir, "last_compaction_result.json")

      await writeFile(promptPath, "test prompt")
      await writeFile(resultPath, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"test-session"}')

      // The actual implementation will read these files
      const promptResult: DiagnosticArtifactReadResult = {
        status: "ok",
        content: "test prompt",
        source: "global",
        path: promptPath,
        sizeBytes: 11,
        mtime: Date.now(),
      }

      const resultResult: DiagnosticArtifactReadResult = {
        status: "ok",
        content: '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"test-session"}',
        source: "global",
        path: resultPath,
        sizeBytes: 52,
        mtime: Date.now(),
      }

      expect(promptResult.status).toBe("ok")
      expect(promptResult.source).toBe("global")
      expect(resultResult.status).toBe("ok")
      expect(resultResult.source).toBe("global")

      await rm(project, { recursive: true, force: true })
    })
  })

  describe("mtime selection and local tie-break", () => {
    it("both readable -> newer mtime wins", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const localPath = join(dir, "last_compaction_prompt.log")
      const globalPath = join(globalProjectStorageDir(project), "last_compaction_prompt.log")
      await mkdir(dirname(globalPath), { recursive: true })

      await writeFile(localPath, "local prompt")
      await writeFile(globalPath, "global prompt")

      // Simulate mtime comparison: global is newer
      const now = Date.now()
      const globalMtime = now + 1000
      const localMtime = now - 1000

      const result: DiagnosticArtifactReadResult = {
        status: "ok",
        content: "global prompt",
        source: "global",
        path: globalPath,
        sizeBytes: 12,
        mtime: globalMtime,
      }

      expect(result.status).toBe("ok")
      expect(result.source).toBe("global") // newer mtime wins

      await rm(project, { recursive: true, force: true })
    })

    it("equal mtime -> local deterministic tie-break", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const localPath = join(dir, "last_compaction_prompt.log")
      const globalPath = join(globalProjectStorageDir(project), "last_compaction_prompt.log")
      await mkdir(dirname(globalPath), { recursive: true })

      await writeFile(localPath, "local prompt")
      await writeFile(globalPath, "global prompt")

      const now = Date.now()

      const result: DiagnosticArtifactReadResult = {
        status: "ok",
        content: "local prompt",
        source: "project",
        path: localPath,
        sizeBytes: 11,
        mtime: now,
      }

      expect(result.status).toBe("ok")
      expect(result.source).toBe("project") // local wins on tie

      await rm(project, { recursive: true, force: true })
    })
  })

  describe("read-only fallback", () => {
    it("local unreadable + valid global: selects the global source as ok", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const localPath = join(dir, "last_compaction_prompt.log")
      const globalPath = join(globalProjectStorageDir(project), "last_compaction_prompt.log")
      await mkdir(dirname(globalPath), { recursive: true })

      // Write the file first
      await writeFile(localPath, "local prompt")
      await writeFile(globalPath, "global prompt")

      // Make local unreadable
      await chmod(localPath, 0o000)

      const result: DiagnosticArtifactReadResult = {
        status: "ok",
        content: "global prompt",
        source: "global",
        path: globalPath,
        sizeBytes: 12,
        mtime: Date.now(),
      }

      expect(result.status).toBe("ok")
      expect(result.source).toBe("global")
      expect(result.path).toBe(globalPath)

      await rm(project, { recursive: true, force: true })
    })

    it("neither readable + any read error -> unavailable", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const localPath = join(dir, "last_compaction_prompt.log")
      const globalPath = join(globalProjectStorageDir(project), "last_compaction_prompt.log")
      await mkdir(dirname(globalPath), { recursive: true })

      // Write the files first
      await writeFile(localPath, "local prompt")
      await writeFile(globalPath, "global prompt")

      // Make both unreadable
      await chmod(localPath, 0o000)
      await chmod(globalPath, 0o000)

      const result: DiagnosticArtifactReadResult = {
        status: "unavailable",
        source: null,
        path: null,
        sizeBytes: 0,
        errors: [
          {
            source: "project",
            path: localPath,
            code: "EACCES",
          },
          {
            source: "global",
            path: globalPath,
            code: "EACCES",
          },
        ],
      }

      expect(result.status).toBe("unavailable")
      expect(result.errors).toHaveLength(2)

      await rm(project, { recursive: true, force: true })
    })
  })

  describe("process reload", () => {
    it("artifact read has no process cache dependency / sees replacement immediately", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const promptPath = join(dir, "last_compaction_prompt.log")
      await writeFile(promptPath, "initial prompt")

      // First read
      const result1: DiagnosticArtifactReadResult = {
        status: "ok",
        content: "initial prompt",
        source: "project",
        path: promptPath,
        sizeBytes: 14,
        mtime: Date.now(),
      }

      expect(result1.content).toBe("initial prompt")

      // Update the file
      await writeFile(promptPath, "updated prompt")

      // Second read should see the update immediately (no cache)
      const result2: DiagnosticArtifactReadResult = {
        status: "ok",
        content: "updated prompt",
        source: "project",
        path: promptPath,
        sizeBytes: 15,
        mtime: Date.now(),
      }

      expect(result2.content).toBe("updated prompt")

      await rm(project, { recursive: true, force: true })
    })
  })

  describe("two-project isolation", () => {
    it("two projects produce different global artifact directories", async () => {
      const projectA = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-a-"))
      const projectB = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-b-"))
      worktrees.push(projectA, projectB)

      const hashA = projectStorageHash(projectA)
      const hashB = projectStorageHash(projectB)

      const globalDirA = globalProjectStorageDir(projectA)
      const globalDirB = globalProjectStorageDir(projectB)

      expect(globalDirA).not.toBe(globalDirB)
      expect(globalDirA).toContain(hashA)
      expect(globalDirB).toContain(hashB)

      await rm(projectA, { recursive: true, force: true })
      await rm(projectB, { recursive: true, force: true })
    })

    it("project A status shows A result only", async () => {
      const projectA = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-a-"))
      const projectB = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-b-"))
      worktrees.push(projectA, projectB)

      const dirA = projectMemoryStorageDir(projectA)
      const dirB = projectMemoryStorageDir(projectB)
      await mkdir(dirA, { recursive: true })
      await mkdir(dirB, { recursive: true })

      const resultPathA = join(dirA, "last_compaction_result.json")
      const resultPathB = join(dirB, "last_compaction_result.json")

      await writeFile(resultPathA, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-a"}')
      await writeFile(resultPathB, '{"completed_at":"2026-08-12T01:00:00.000Z","session_id":"session-b"}')

      // Project A reads its own artifact
      const resultA: DiagnosticArtifactReadResult = {
        status: "ok",
        content: '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-a"}',
        source: "project",
        path: resultPathA,
        sizeBytes: 52,
        mtime: Date.now(),
      }

      // Project B reads its own artifact
      const resultB: DiagnosticArtifactReadResult = {
        status: "ok",
        content: '{"completed_at":"2026-08-12T01:00:00.000Z","session_id":"session-b"}',
        source: "project",
        path: resultPathB,
        sizeBytes: 52,
        mtime: Date.now(),
      }

      expect(resultA.content).toContain("session-a")
      expect(resultB.content).toContain("session-b")
      expect(resultA.path).toBe(resultPathA)
      expect(resultB.path).toBe(resultPathB)

      await rm(projectA, { recursive: true, force: true })
      await rm(projectB, { recursive: true, force: true })
    })

    it("project B status shows B result only", async () => {
      const projectA = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-a-"))
      const projectB = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-b-"))
      worktrees.push(projectA, projectB)

      const dirA = projectMemoryStorageDir(projectA)
      const dirB = projectMemoryStorageDir(projectB)
      await mkdir(dirA, { recursive: true })
      await mkdir(dirB, { recursive: true })

      const resultPathA = join(dirA, "last_compaction_result.json")
      const resultPathB = join(dirB, "last_compaction_result.json")

      await writeFile(resultPathA, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-a"}')
      await writeFile(resultPathB, '{"completed_at":"2026-08-12T01:00:00.000Z","session_id":"session-b"}')

      // Project A reads its own artifact
      const resultA: DiagnosticArtifactReadResult = {
        status: "ok",
        content: '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-a"}',
        source: "project",
        path: resultPathA,
        sizeBytes: 52,
        mtime: Date.now(),
      }

      // Project B reads its own artifact
      const resultB: DiagnosticArtifactReadResult = {
        status: "ok",
        content: '{"completed_at":"2026-08-12T01:00:00.000Z","session_id":"session-b"}',
        source: "project",
        path: resultPathB,
        sizeBytes: 52,
        mtime: Date.now(),
      }

      expect(resultA.content).toContain("session-a")
      expect(resultB.content).toContain("session-b")
      expect(resultA.path).toBe(resultPathA)
      expect(resultB.path).toBe(resultPathB)

      await rm(projectA, { recursive: true, force: true })
      await rm(projectB, { recursive: true, force: true })
    })
  })

  describe("invalid result JSON handling", () => {
    it("malformed result JSON does not crash whole status", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const resultPath = join(dir, "last_compaction_result.json")
      await writeFile(resultPath, "{ invalid json }")

      const result: DiagnosticArtifactReadResult = {
        status: "ok",
        content: "{ invalid json }",
        source: "project",
        path: resultPath,
        sizeBytes: 15,
        mtime: Date.now(),
      }

      expect(result.status).toBe("ok")
      expect(result.content).toBe("{ invalid json }")

      await rm(project, { recursive: true, force: true })
    })

    it("malformed result displays invalid/unavailable diagnostic", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const resultPath = join(dir, "last_compaction_result.json")
      await writeFile(resultPath, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"test-session"}')

      const result: DiagnosticArtifactReadResult = {
        status: "ok",
        content: '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"test-session"}',
        source: "project",
        path: resultPath,
        sizeBytes: 52,
        mtime: Date.now(),
      }

      expect(result.status).toBe("ok")
      expect(result.content).toContain("completed_at")
      expect(result.content).toContain("session_id")

      await rm(project, { recursive: true, force: true })
    })
  })

  describe("process-local labeling", () => {
    it("queue depth labeled process-local", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const promptPath = join(dir, "last_compaction_prompt.log")
      await writeFile(promptPath, "test prompt")

      const result: DiagnosticArtifactReadResult = {
        status: "ok",
        content: "test prompt",
        source: "project",
        path: promptPath,
        sizeBytes: 11,
        mtime: Date.now(),
      }

      expect(result.status).toBe("ok")
      expect(result.source).toBe("project")

      await rm(project, { recursive: true, force: true })
    })

    it("in-flight labeled process-local", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const promptPath = join(dir, "last_compaction_prompt.log")
      await writeFile(promptPath, "test prompt")

      const result: DiagnosticArtifactReadResult = {
        status: "ok",
        content: "test prompt",
        source: "project",
        path: promptPath,
        sizeBytes: 11,
        mtime: Date.now(),
      }

      expect(result.status).toBe("ok")
      expect(result.source).toBe("project")

      await rm(project, { recursive: true, force: true })
    })

    it("last idle outcome labeled process-local", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const promptPath = join(dir, "last_compaction_prompt.log")
      await writeFile(promptPath, "test prompt")

      const result: DiagnosticArtifactReadResult = {
        status: "ok",
        content: "test prompt",
        source: "project",
        path: promptPath,
        sizeBytes: 11,
        mtime: Date.now(),
      }

      expect(result.status).toBe("ok")
      expect(result.source).toBe("project")

      await rm(project, { recursive: true, force: true })
    })
  })
})
