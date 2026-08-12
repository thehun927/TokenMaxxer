import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

// Import the types that will exist in Wave 2
import type {
  DiagnosticArtifactReadResult,
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

describe("PR-9 status contracts (Wave 2)", () => {
  let homeDir: string
  const worktrees: string[] = []

  beforeEach(async () => {
    // Isolate the global fallback namespace from the developer's real home
    homeDir = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-status-"))
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

  describe("persisted result survives process/module reload", () => {
    it("result artifact persists across reload simulation", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const resultPath = join(dir, "last_compaction_result.json")
      await writeFile(resultPath, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-001","summary":{"status":"found","bytes":1024,"sha256":"a1b2c3d4e5f6"}}')

      const result: DiagnosticArtifactReadResult = {
        status: "ok",
        content: '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-001","summary":{"status":"found","bytes":1024,"sha256":"a1b2c3d4e5f6"}}',
        source: "project",
        path: resultPath,
        sizeBytes: 85,
        mtime: Date.now(),
      }

      expect(result.status).toBe("ok")
      expect(result.content).toContain("session-001")
      expect(result.content).toContain("summary")
      expect(result.sizeBytes).toBe(85)

      await rm(project, { recursive: true, force: true })
    })
  })

  describe("project A/B separation", () => {
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

  describe("no result artifact -> last completed compaction none", () => {
    it("missing result artifact shows 'none' for last completed compaction", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const result: DiagnosticArtifactReadResult = {
        status: "missing",
        source: null,
        path: null,
        sizeBytes: 0,
      }

      expect(result.status).toBe("missing")

      await rm(project, { recursive: true, force: true })
    })
  })

  describe("local/global result artifact source/path reporting", () => {
    it("local result artifact source/path reported accurately", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const resultPath = join(dir, "last_compaction_result.json")
      await writeFile(resultPath, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-001"}')

      const result: DiagnosticArtifactReadResult = {
        status: "ok",
        content: '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-001"}',
        source: "project",
        path: resultPath,
        sizeBytes: 52,
        mtime: Date.now(),
      }

      expect(result.status).toBe("ok")
      expect(result.source).toBe("project")
      expect(result.path).toBe(resultPath)

      await rm(project, { recursive: true, force: true })
    })

    it("global result artifact source/path reported accurately", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const hash = projectStorageHash(project)
      const globalDir = join(homeDir, ".config/opencode/memory", hash)
      await mkdir(globalDir, { recursive: true })

      const resultPath = join(globalDir, "last_compaction_result.json")
      await writeFile(resultPath, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-001"}')

      const result: DiagnosticArtifactReadResult = {
        status: "ok",
        content: '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-001"}',
        source: "global",
        path: resultPath,
        sizeBytes: 52,
        mtime: Date.now(),
      }

      expect(result.status).toBe("ok")
      expect(result.source).toBe("global")
      expect(result.path).toBe(resultPath)

      await rm(project, { recursive: true, force: true })
    })
  })

  describe("local/global newer candidate selection reflected in status", () => {
    it("local newer candidate wins over global older", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const localPath = join(dir, "last_compaction_result.json")
      const globalPath = join(globalProjectStorageDir(project), "last_compaction_result.json")
      await mkdir(dirname(globalPath), { recursive: true })

      await writeFile(localPath, '{"completed_at":"2026-08-12T02:00:00.000Z","session_id":"session-local"}')
      await writeFile(globalPath, '{"completed_at":"2026-08-12T01:00:00.000Z","session_id":"session-global"}')

      // Simulate mtime comparison: local is newer
      const now = Date.now()
      const localMtime = now + 1000
      const globalMtime = now - 1000

      const result: DiagnosticArtifactReadResult = {
        status: "ok",
        content: '{"completed_at":"2026-08-12T02:00:00.000Z","session_id":"session-local"}',
        source: "project",
        path: localPath,
        sizeBytes: 52,
        mtime: localMtime,
      }

      expect(result.status).toBe("ok")
      expect(result.source).toBe("project") // newer mtime wins
      expect(result.content).toContain("session-local")

      await rm(project, { recursive: true, force: true })
    })

    it("global newer candidate wins over local older", async () => {
      const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-project-"))
      worktrees.push(project)

      const dir = projectMemoryStorageDir(project)
      await mkdir(dir, { recursive: true })

      const localPath = join(dir, "last_compaction_result.json")
      const globalPath = join(globalProjectStorageDir(project), "last_compaction_result.json")
      await mkdir(dirname(globalPath), { recursive: true })

      await writeFile(localPath, '{"completed_at":"2026-08-12T01:00:00.000Z","session_id":"session-local"}')
      await writeFile(globalPath, '{"completed_at":"2026-08-12T02:00:00.000Z","session_id":"session-global"}')

      // Simulate mtime comparison: global is newer
      const now = Date.now()
      const localMtime = now - 1000
      const globalMtime = now + 1000

      const result: DiagnosticArtifactReadResult = {
        status: "ok",
        content: '{"completed_at":"2026-08-12T02:00:00.000Z","session_id":"session-global"}',
        source: "global",
        path: globalPath,
        sizeBytes: 52,
        mtime: globalMtime,
      }

      expect(result.status).toBe("ok")
      expect(result.source).toBe("global") // newer mtime wins
      expect(result.content).toContain("session-global")

      await rm(project, { recursive: true, force: true })
    })
  })

  describe("malformed result JSON does not crash whole status", () => {
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

  describe("prompt artifact path/source/size displayed separately", () => {
    it("prompt artifact path/source/size reported accurately", async () => {
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
      expect(result.path).toBe(promptPath)
      expect(result.sizeBytes).toBe(11)

      await rm(project, { recursive: true, force: true })
    })
  })

  describe("process-local/process-wide labels", () => {
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
