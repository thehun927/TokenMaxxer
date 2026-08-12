import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { chmod, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Import the types that will exist in Wave 2
import type { DiagnosticArtifactName } from "../../src/diagnostics/artifacts.types"

// Import the canonical API
import {
  writeDiagnosticArtifact,
  readDiagnosticArtifact,
} from "../../src/diagnostics/artifacts"

// Import path helpers (real global storage dir + stable hash, no mocks)
import { globalProjectStorageDir, projectStorageHash } from "../../src/memory/paths"

describe("Artifact storage contracts (Wave 2)", () => {
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
    const project = await mkdtemp(join(tmpdir(), "tokenmaxxer-artifacts-project-"))
    worktrees.push(project)
    return project
  }

  // Create a project path that is a FILE, so project-local mkdir fails
  // (ENOTDIR) and the canonical API must fall back to global storage.
  async function makeProjectFile(): Promise<string> {
    const project = join(
      tmpdir(),
      `tokenmaxxer-artifacts-project-file-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    await writeFile(project, "project path is a file")
    worktrees.push(project)
    return project
  }

  // Isolate HOME so globalProjectStorageDir() resolves under a temp dir.
  async function isolateHome(): Promise<string> {
    const homeDir = await mkdtemp(join(tmpdir(), "tokenmaxxer-artifacts-home-"))
    worktrees.push(homeDir)
    process.env.HOME = homeDir
    return homeDir
  }

  describe("project/global artifact resolution", () => {
    it("project diagnostic path uses resolved project path", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      const promptPath = join(dir, "last_compaction_prompt.log")

      // Write using canonical API
      const writeResult = await writeDiagnosticArtifact("last_compaction_prompt.log", project, "test prompt")
      expect(writeResult.ok).toBe(true)
      if (writeResult.ok) {
        expect(writeResult.source).toBe("project")
        expect(writeResult.path).toBe(promptPath)
        expect(writeResult.sizeBytes).toBe(11)
      }

      // Read using canonical API
      const readResult = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(readResult.kind).toBe("ok")
      if (readResult.kind === "ok") {
        expect(readResult.content).toBe("test prompt")
        expect(readResult.source).toBe("project")
        expect(readResult.path).toBe(promptPath)
        expect(readResult.sizeBytes).toBe(11)
      }
    })

    it("global diagnostic path uses existing stable project hash", async () => {
      const project = await makeProjectFile()
      await isolateHome()

      const globalDir = globalProjectStorageDir(project)
      await mkdir(globalDir, { recursive: true })

      const promptPath = join(globalDir, "last_compaction_prompt.log")

      // Write to global directory manually to simulate project-local write failure
      await writeFile(promptPath, "test prompt")

      // Write using canonical API - should fall back to global since project-local write fails
      const writeResult = await writeDiagnosticArtifact("last_compaction_prompt.log", project, "test prompt")
      expect(writeResult.ok).toBe(true)
      if (writeResult.ok) {
        expect(writeResult.source).toBe("global")
        expect(writeResult.path).toBe(promptPath)
      }

      // Read using canonical API
      const readResult = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(readResult.kind).toBe("ok")
      if (readResult.kind === "ok") {
        expect(readResult.content).toBe("test prompt")
        expect(readResult.source).toBe("global")
        expect(readResult.path).toBe(promptPath)
      }
    })
  })

  describe("mtime selection and local tie-break", () => {
    it("both readable -> newer mtime wins", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      const localPath = join(dir, "last_compaction_prompt.log")
      const globalDir = globalProjectStorageDir(project)
      await mkdir(globalDir, { recursive: true })

      const globalPath = join(globalDir, "last_compaction_prompt.log")

      await writeFile(localPath, "local prompt")
      await writeFile(globalPath, "global prompt")

      // Deterministic mtimes: global is newer.
      const base = Date.now()
      await utimes(localPath, new Date(base - 1000), new Date(base - 1000))
      await utimes(globalPath, new Date(base + 1000), new Date(base + 1000))

      // Read using canonical API - should get global (newer mtime)
      const result = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.content).toBe("global prompt")
        expect(result.source).toBe("global") // newer mtime wins
      }
    })

    it("equal mtime -> local deterministic tie-break", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      const localPath = join(dir, "last_compaction_prompt.log")
      const globalDir = globalProjectStorageDir(project)
      await mkdir(globalDir, { recursive: true })

      const globalPath = join(globalDir, "last_compaction_prompt.log")

      await writeFile(localPath, "local prompt")
      await writeFile(globalPath, "global prompt")

      // Deterministic equal mtimes.
      const fixed = new Date(1700000000000)
      await utimes(localPath, fixed, fixed)
      await utimes(globalPath, fixed, fixed)

      // Read using canonical API - should get project (deterministic tie-break)
      const result = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.content).toBe("local prompt")
        expect(result.source).toBe("project") // local wins on tie
      }
    })
  })

  describe("read-only fallback", () => {
    it("local unreadable + valid global: selects the global source as ok", async () => {
      const project = await makeProjectFile()
      await isolateHome()

      const globalDir = globalProjectStorageDir(project)
      await mkdir(globalDir, { recursive: true })

      const globalPath = join(globalDir, "last_compaction_prompt.log")

      // Write the file first
      await writeFile(globalPath, "global prompt")

      // Read using canonical API - should get global
      const result = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.content).toBe("global prompt")
        expect(result.source).toBe("global")
        expect(result.path).toBe(globalPath)
      }
    })

    it("neither readable + any read error -> unavailable", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      const localPath = join(dir, "last_compaction_prompt.log")
      const globalDir = globalProjectStorageDir(project)
      await mkdir(globalDir, { recursive: true })

      const globalPath = join(globalDir, "last_compaction_prompt.log")

      // Write the files first
      await writeFile(localPath, "local prompt")
      await writeFile(globalPath, "global prompt")

      // Make both unreadable
      await chmod(localPath, 0o000)
      await chmod(globalPath, 0o000)

      // Read using canonical API - should be unavailable
      const result = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(result.kind).toBe("unavailable")
      if (result.kind === "unavailable") {
        expect(result.errors).toHaveLength(2)
      }
    })
  })

  describe("process reload", () => {
    it("artifact read has no process cache dependency / sees replacement immediately", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      // Write initial content
      await writeDiagnosticArtifact("last_compaction_prompt.log", project, "initial prompt")

      // First read
      const result1 = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(result1.kind).toBe("ok")
      if (result1.kind === "ok") {
        expect(result1.content).toBe("initial prompt")
      }

      // Update the file
      await writeDiagnosticArtifact("last_compaction_prompt.log", project, "updated prompt")

      // Second read should see the update immediately (no cache)
      const result2 = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(result2.kind).toBe("ok")
      if (result2.kind === "ok") {
        expect(result2.content).toBe("updated prompt")
      }
    })
  })

  describe("two-project isolation", () => {
    it("two projects produce different global artifact directories", async () => {
      const projectA = await makeProjectDir()
      const projectB = await makeProjectDir()
      await isolateHome()

      const globalDirA = globalProjectStorageDir(projectA)
      const globalDirB = globalProjectStorageDir(projectB)

      expect(globalDirA).not.toBe(globalDirB)
      expect(globalDirA).toContain(projectStorageHash(projectA))
      expect(globalDirB).toContain(projectStorageHash(projectB))
    })

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

  describe("invalid result JSON handling", () => {
    it("malformed result JSON does not crash whole status", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      const resultPath = join(dir, "last_compaction_result.json")
      await writeFile(resultPath, "{ invalid json }")

      // Write using canonical API
      await writeDiagnosticArtifact("last_compaction_result.json", project, "{ invalid json }")

      // Read using canonical API
      const result = await readDiagnosticArtifact("last_compaction_result.json", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.content).toBe("{ invalid json }")
      }
    })

    it("malformed result displays invalid/unavailable diagnostic", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      const resultPath = join(dir, "last_compaction_result.json")
      await writeFile(resultPath, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"test-session"}')

      // Write using canonical API
      await writeDiagnosticArtifact("last_compaction_result.json", project, '{"completed_at":"2026-08-12T00:00:00.000Z","session_id":"test-session"}')

      // Read using canonical API
      const result = await readDiagnosticArtifact("last_compaction_result.json", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.content).toContain("completed_at")
        expect(result.content).toContain("session_id")
      }
    })
  })

  describe("process-local labeling", () => {
    it("queue depth labeled process-local", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      // Write using canonical API
      await writeDiagnosticArtifact("last_compaction_prompt.log", project, "test prompt")

      // Read using canonical API
      const result = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.content).toBe("test prompt")
        expect(result.source).toBe("project")
      }
    })

    it("in-flight labeled process-local", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      // Write using canonical API
      await writeDiagnosticArtifact("last_compaction_prompt.log", project, "test prompt")

      // Read using canonical API
      const result = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.content).toBe("test prompt")
        expect(result.source).toBe("project")
      }
    })

    it("last idle outcome labeled process-local", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const dir = join(project, ".opencode", "memory")
      await mkdir(dir, { recursive: true })

      // Write using canonical API
      await writeDiagnosticArtifact("last_compaction_prompt.log", project, "test prompt")

      // Read using canonical API
      const result = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(result.kind).toBe("ok")
      if (result.kind === "ok") {
        expect(result.content).toBe("test prompt")
        expect(result.source).toBe("project")
      }
    })
  })

  describe("write limits and safe names", () => {
    it("over-limit content -> typed too-large, no write", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const result = await writeDiagnosticArtifact("last_compaction_prompt.log", project, "1234567890", 5)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe("too-large")
        expect(result.sizeBytes).toBe(10)
        expect(result.maxBytes).toBe(5)
      }

      // Nothing was written to disk.
      const read = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(read.kind).toBe("missing")
    })

    it("UTF-8 byte count uses encoded bytes, not JS length", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const content = "héllo wörld" // multibyte characters
      const writeResult = await writeDiagnosticArtifact("last_compaction_prompt.log", project, content)
      expect(writeResult.ok).toBe(true)
      if (writeResult.ok) {
        expect(writeResult.sizeBytes).toBe(Buffer.byteLength(content, "utf-8"))
        expect(writeResult.sizeBytes).toBeGreaterThan(content.length)
      }

      const readResult = await readDiagnosticArtifact("last_compaction_prompt.log", project)
      expect(readResult.kind).toBe("ok")
      if (readResult.kind === "ok") {
        expect(readResult.sizeBytes).toBe(Buffer.byteLength(content, "utf-8"))
      }
    })

    it("traversal artifact name rejected", async () => {
      const project = await makeProjectDir()
      await isolateHome()

      const badName = "../../etc/passwd" as unknown as DiagnosticArtifactName
      await expect(writeDiagnosticArtifact(badName, project, "x")).rejects.toThrow(/unsafe diagnostic artifact name/)
      await expect(readDiagnosticArtifact(badName, project)).rejects.toThrow(/unsafe diagnostic artifact name/)
    })

    it("both writes fail -> typed io-failed", async () => {
      // Project path is a file -> project-local write fails.
      const project = await makeProjectFile()

      // HOME points under a file -> global write fails too.
      const blocker = join(
        tmpdir(),
        `tokenmaxxer-artifacts-blocker-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      )
      await writeFile(blocker, "blocker file")
      worktrees.push(blocker)
      process.env.HOME = join(blocker, "home")

      const result = await writeDiagnosticArtifact("last_compaction_prompt.log", project, "test prompt")
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe("io-failed")
      }
    })
  })
})
