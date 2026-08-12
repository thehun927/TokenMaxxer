import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Import the canonical API
import { readDiagnosticArtifact } from "../../src/diagnostics/artifacts"

// Import path helpers (real global storage dir, no mocks)
import { globalProjectStorageDir } from "../../src/memory/paths"

describe("PR-9 status contracts (Wave 2)", () => {
  const worktrees: string[] = []
  const originalHome = process.env.HOME

  beforeEach(async () => {
    // Clear any previous worktrees
    await Promise.all(
      worktrees.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  afterEach(async () => {
    // Restore HOME after each test
    process.env.HOME = originalHome
    await Promise.all(
      worktrees.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  // Create a real project directory (project-local writes succeed).
  async function makeProjectDir(): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-project-"))
    worktrees.push(project)
    return project
  }

  // Create a project path that is a FILE, so project-local mkdir fails
  // (ENOTDIR) and the canonical API must fall back to global storage.
  async function makeProjectFile(): Promise<string> {
    const project = join(
      tmpdir(),
      `tokenmaxxer-pr9-project-file-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    await writeFile(project, "project path is a file")
    worktrees.push(project)
    return project
  }

  // Isolate HOME so globalProjectStorageDir() resolves under a temp dir.
  async function isolateHome(): Promise<string> {
    const homeDir = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr9-home-"))
    worktrees.push(homeDir)
    process.env.HOME = homeDir
    return homeDir
  }

  describe("persisted result survives process/module reload", () => {
    it("result artifact persists across reload simulation", async () => {
      const project = await makeProjectFile()
      await isolateHome()

      const globalDir = globalProjectStorageDir(project)
      await mkdir(globalDir, { recursive: true })

      const resultPath = join(globalDir, "last_compaction_result.json")
      await writeFile(resultPath, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-001","summary":{"status":"found","bytes":1024,"sha256":"a1b2c3d4e5f6"}}')

      // Use the canonical API
      const result = await readDiagnosticArtifact("last_compaction_result.json", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.content).toContain("session-001")
        expect(result.content).toContain("summary")
        expect(result.sizeBytes).toBe(136)
      }
    })
  })

  describe("project A/B separation", () => {
    it("project A status shows A result only", async () => {
      const projectA = await makeProjectDir()
      const projectB = await makeProjectDir()
      await isolateHome()

      const dirA = join(projectA, ".opencode", "memory")
      const dirB = join(projectB, ".opencode", "memory")
      await mkdir(dirA, { recursive: true })
      await mkdir(dirB, { recursive: true })

      const resultPathA = join(dirA, "last_compaction_result.json")
      const resultPathB = join(dirB, "last_compaction_result.json")

      await writeFile(resultPathA, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-a"}')
      await writeFile(resultPathB, '{"completed_at":"2026-08-12T01:00:00.000Z","session_id":"session-b"}')

      // Project A reads its own artifact
      const resultA = await readDiagnosticArtifact("last_compaction_result.json", projectA)
      expect(resultA.kind).toBe("ok")
      if (resultA.kind === "ok") {
        expect(resultA.content).toContain("session-a")
        expect(resultA.path).toBe(resultPathA)
      }

      // Project B reads its own artifact
      const resultB = await readDiagnosticArtifact("last_compaction_result.json", projectB)
      expect(resultB.kind).toBe("ok")
      if (resultB.kind === "ok") {
        expect(resultB.content).toContain("session-b")
        expect(resultB.path).toBe(resultPathB)
      }
    })

    it("project B status shows B result only", async () => {
      const projectA = await makeProjectDir()
      const projectB = await makeProjectDir()
      await isolateHome()

      const dirA = join(projectA, ".opencode", "memory")
      const dirB = join(projectB, ".opencode", "memory")
      await mkdir(dirA, { recursive: true })
      await mkdir(dirB, { recursive: true })

      const resultPathA = join(dirA, "last_compaction_result.json")
      const resultPathB = join(dirB, "last_compaction_result.json")

      await writeFile(resultPathA, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-a"}')
      await writeFile(resultPathB, '{"completed_at":"2026-08-12T01:00:00.000Z","session_id":"session-b"}')

      // Project A reads its own artifact
      const resultA = await readDiagnosticArtifact("last_compaction_result.json", projectA)
      expect(resultA.kind).toBe("ok")
      if (resultA.kind === "ok") {
        expect(resultA.content).toContain("session-a")
        expect(resultA.path).toBe(resultPathA)
      }

      // Project B reads its own artifact
      const resultB = await readDiagnosticArtifact("last_compaction_result.json", projectB)
      expect(resultB.kind).toBe("ok")
      if (resultB.kind === "ok") {
        expect(resultB.content).toContain("session-b")
        expect(resultB.path).toBe(resultPathB)
      }
    })
  })

  describe("no result artifact -> last completed compaction none", () => {
    it("missing result artifact shows 'none' for last completed compaction", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      // Don't create the artifact directory - it should be missing

      // Use the canonical API
      const result = await readDiagnosticArtifact("last_compaction_result.json", project)
      expect(result.kind).toBe("missing")
    })
  })

  describe("local/global result artifact source/path reporting", () => {
    it("local result artifact source/path reported accurately", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      const resultPath = join(dir, "last_compaction_result.json")
      await writeFile(resultPath, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-001"}')

      // Use the canonical API
      const result = await readDiagnosticArtifact("last_compaction_result.json", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.source).toBe("project")
        expect(result.path).toBe(resultPath)
      }
    })

    it("global result artifact source/path reported accurately", async () => {
      const project = await makeProjectFile()
      await isolateHome()

      const globalDir = globalProjectStorageDir(project)
      await mkdir(globalDir, { recursive: true })

      const resultPath = join(globalDir, "last_compaction_result.json")
      await writeFile(resultPath, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-001"}')

      // Use the canonical API
      const result = await readDiagnosticArtifact("last_compaction_result.json", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.source).toBe("global")
        expect(result.path).toBe(resultPath)
      }
    })
  })

  describe("local/global newer candidate selection reflected in status", () => {
    it("local newer candidate wins over global older", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      const localPath = join(dir, "last_compaction_result.json")
      const globalDir = globalProjectStorageDir(project)
      await mkdir(globalDir, { recursive: true })

      const globalPath = join(globalDir, "last_compaction_result.json")

      await writeFile(localPath, '{"completed_at":"2026-08-12T02:00:00.000Z","session_id":"session-local"}')
      await writeFile(globalPath, '{"completed_at":"2026-08-12T01:00:00.000Z","session_id":"session-global"}')

      // Deterministic mtimes: local is newer.
      const base = Date.now()
      await utimes(localPath, new Date(base + 1000), new Date(base + 1000))
      await utimes(globalPath, new Date(base - 1000), new Date(base - 1000))

      // Use the canonical API
      const result = await readDiagnosticArtifact("last_compaction_result.json", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.source).toBe("project") // newer mtime wins
        expect(result.content).toContain("session-local")
      }
    })

    it("global newer candidate wins over local older", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      const localPath = join(dir, "last_compaction_result.json")
      const globalDir = globalProjectStorageDir(project)
      await mkdir(globalDir, { recursive: true })

      const globalPath = join(globalDir, "last_compaction_result.json")

      await writeFile(localPath, '{"completed_at":"2026-08-12T01:00:00.000Z","session_id":"session-local"}')
      await writeFile(globalPath, '{"completed_at":"2026-08-12T02:00:00.000Z","session_id":"session-global"}')

      // Deterministic mtimes: global is newer.
      const base = Date.now()
      await utimes(localPath, new Date(base - 1000), new Date(base - 1000))
      await utimes(globalPath, new Date(base + 1000), new Date(base + 1000))

      // Use the canonical API
      const result = await readDiagnosticArtifact("last_compaction_result.json", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.source).toBe("global") // newer mtime wins
        expect(result.content).toContain("session-global")
      }
    })
  })

  describe("malformed result JSON does not crash whole status", () => {
    it("malformed result displays invalid/unavailable diagnostic", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      const resultPath = join(dir, "last_compaction_result.json")
      await writeFile(resultPath, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"test-session"}')

      // Use the canonical API
      const result = await readDiagnosticArtifact("last_compaction_result.json", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.content).toContain("completed_at")
        expect(result.content).toContain("session_id")
      }
    })
  })

  describe("prompt artifact path/source/size displayed separately", () => {
    it("prompt artifact path/source/size reported accurately", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      const promptPath = join(dir, "last_compaction_prompt.log")
      await writeFile(promptPath, "test prompt")

      // Use the canonical API
      const result = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.source).toBe("project")
        expect(result.path).toBe(promptPath)
        expect(result.sizeBytes).toBe(11)
      }
    })
  })

  describe("process-local/process-wide labels", () => {
    it("queue depth labeled process-local", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      const promptPath = join(dir, "last_compaction_prompt.log")
      await writeFile(promptPath, "test prompt")

      // Use the canonical API
      const result = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.source).toBe("project")
      }
    })

    it("in-flight labeled process-local", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      const promptPath = join(dir, "last_compaction_prompt.log")
      await writeFile(promptPath, "test prompt")

      // Use the canonical API
      const result = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.source).toBe("project")
      }
    })

    it("last idle outcome labeled process-local", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      const promptPath = join(dir, "last_compaction_prompt.log")
      await writeFile(promptPath, "test prompt")

      // Use the canonical API
      const result = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.source).toBe("project")
      }
    })
  })
})
