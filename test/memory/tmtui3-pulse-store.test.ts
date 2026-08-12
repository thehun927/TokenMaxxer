/**
 * TMTUI-3 post-PR8 pulse semantics — store boundary
 * (docs/TMTUI/implementation-plan.md §2.10).
 *
 * The pulse must be causally downstream of actual durable STATE persistence:
 *
 *   - exactly one marker write is attempted per successful logical commit,
 *     whether that commit lands project-locally or through the global
 *     fallback;
 *   - no marker for noop, budget rejection, validation failure, size-cap
 *     rejection, commit failure (both destinations), lock timeout, an
 *     unavailable authoritative read, or an aborted mutation callback;
 *   - telemetry I/O failure can never change a successful commit's result,
 *     revision, or persisted state content;
 *   - the marker lives in the global per-project namespace and carries only
 *     `{"committed_at": <now>}` — never revision, STATE, or memory data.
 *
 * These tests spy on `recordMemoryCommit()` (pass-through) so they observe
 * the canonical success boundary exactly. Both project-local and
 * global-fallback success paths must emit one pulse; every negative assertion
 * must remain pulse-free.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

import {
  mutateMemory,
  readMemory,
  readMemoryState,
  writeMemory,
} from "../../src/memory/store"
import {
  globalMemoryPath,
  globalProjectStorageDir,
  projectMemoryPath,
} from "../../src/memory/paths"
import {
  emptyMemory,
  MEMORY_PERSISTENCE_CEILINGS,
  type MemoryFile,
} from "../../src/memory/schema"
import { MEMORY_MAX_BYTES, memorySizeBytes } from "../../src/memory/memory-size"
import { memoryCommitPulsePath } from "../../src/memory/commit-pulse"
import * as commitPulse from "../../src/memory/commit-pulse"
import { atomicWrite } from "../../src/util/fs"

const WORKER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "transaction-worker.ts",
)

const worktrees: string[] = []
let homeDir: string
let pulseSpy: ReturnType<typeof vi.spyOn>

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

async function makeWorktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tokenmaxxer-tmtui3-store-"))
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

/** Block the pulse marker path so `recordMemoryCommit()`'s write must fail. */
async function blockMarkerWrite(project: string): Promise<void> {
  await mkdir(memoryCommitPulsePath(project), { recursive: true })
}

/**
 * Schema-valid memory whose serialized size is driven by a single broad
 * persistence-ceiling field (decision.topic, up to 8192 chars).
 */
function sizeProbeMemory(project: string, topic: string): MemoryFile {
  return {
    ...emptyMemory(project),
    decisions: [{
      id: "size-probe",
      topic,
      decision: "probe",
      timestamp: "2026-08-09T00:00:00.000Z",
      session_id: "source",
      still_valid: true,
      foundational: false,
      foundational_requested: false,
      human_conflict_quarantined: false,
      provenance: {
        extractor: "heuristic",
        source_session_id: "source",
        confidence: "heuristic",
        evidence: [],
      },
    }],
  }
}

beforeEach(async () => {
  // Isolate the global fallback + pulse namespace from the developer's home.
  homeDir = await mkdtemp(join(tmpdir(), "tokenmaxxer-tmtui3-store-home-"))
  vi.stubEnv("HOME", homeDir)
  // Pass-through spy: observes the canonical success boundary while the real
  // marker write still happens (used by the marker-isolation assertions).
  pulseSpy = vi.spyOn(commitPulse, "recordMemoryCommit")
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await rm(homeDir, { recursive: true, force: true })
  await Promise.all(
    worktrees.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe("TMTUI-3 — project-local committed pulse", () => {
  it("a committed mutateMemory records exactly one pulse after the local STATE write", async () => {
    const project = await makeWorktree()

    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("committed")

    // The pulse is fired exactly once, from the canonical success boundary,
    // keyed by the resolved project path.
    expect(pulseSpy).toHaveBeenCalledTimes(1)
    expect(pulseSpy).toHaveBeenCalledWith(project)

    const read = await readMemoryState({ worktree: project, directory: project })
    expect(read.status).toBe("ok")
    if (read.status === "ok") expect(read.source).toBe("project")
  })

  it("a direct writeMemory success records exactly one pulse", async () => {
    const project = await makeWorktree()

    expect(await writeMemory({ worktree: project, directory: project }, emptyMemory(project))).toBe(true)

    expect(pulseSpy).toHaveBeenCalledTimes(1)
    expect(pulseSpy).toHaveBeenCalledWith(project)
  })
})

describe("TMTUI-3 — global fallback committed pulse", () => {
  it("a committed mutation through the global fallback records exactly one pulse", async () => {
    const project = await makeWorktree()
    const localPath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)
    await writeState(localPath, memoryJson(project, 0))

    // Force the local write to fail so the commit falls through to the global
    // path: the existing STATE stays readable (transaction read succeeds), but
    // atomicWrite cannot create its temp sibling (EACCES).
    const localDir = dirname(localPath)
    await chmod(localDir, 0o555)
    try {
      const result = await mutateMemory(
        { worktree: project, directory: project },
        (memory) => ({ kind: "commit", memory, value: null }),
      )
      expect(result.status).toBe("committed")

      // The durable STATE landed in the global fallback namespace.
      const read = await readMemoryState({ worktree: project, directory: project })
      expect(read.status).toBe("ok")
      if (read.status === "ok") {
        expect(read.source).toBe("global")
        expect(read.path).toBe(globalPath)
        expect(read.revision).toBe(1)
      }

      // Exactly one pulse even though the write path differs from local.
      expect(pulseSpy).toHaveBeenCalledTimes(1)
      expect(pulseSpy).toHaveBeenCalledWith(project)
    } finally {
      await chmod(localDir, 0o755)
    }
  })
})

describe("TMTUI-3 — telemetry failure isolation", () => {
  it("a telemetry I/O failure never changes a successful commit result or revision", async () => {
    const project = await makeWorktree()
    // The marker path is a directory: `recordMemoryCommit()`'s atomic rename
    // fails and is swallowed internally. The STATE commit is untouched.
    await blockMarkerWrite(project)

    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )

    expect(result.status).toBe("committed")
    if (result.status === "committed") {
      expect(result.revision).toBe(1)
      expect(result.memory.revision).toBe(1)
    }

    // The pulse was still attempted exactly once at the canonical boundary;
    // only the marker write itself failed (and was swallowed).
    expect(pulseSpy).toHaveBeenCalledTimes(1)
    expect(pulseSpy).toHaveBeenCalledWith(project)

    const read = await readMemoryState({ worktree: project, directory: project })
    expect(read.status).toBe("ok")
    if (read.status === "ok") {
      expect(read.revision).toBe(1)
      // The persisted state is byte-equivalent to the committed memory the
      // transaction exposed: telemetry did not alter what was written.
      expect(read.memory).toEqual(result.status === "committed" ? result.memory : null)
    }
  })

  it("a telemetry failure while telemetry is otherwise healthy leaves STATE unchanged", async () => {
    const project = await makeWorktree()
    // Seed revision 0 (telemetry healthy), then make the marker write fail on
    // the next commit.
    expect(await writeMemory({ worktree: project, directory: project }, emptyMemory(project))).toBe(true)

    await blockMarkerWrite(project)
    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("committed")

    // The durable commit advanced 0 -> 1 despite the blocked marker write.
    const read = await readMemoryState({ worktree: project, directory: project })
    expect(read.status).toBe("ok")
    if (read.status === "ok") expect(read.revision).toBe(1)
  })
})

describe("TMTUI-3 — no pulse without a successful commit", () => {
  it("noop mutation records no pulse", async () => {
    const project = await makeWorktree()
    // Seed directly through atomicWrite so the seed itself cannot count as a
    // telemetry pulse (writeMemory success is itself a pulse boundary).
    await writeState(projectMemoryPath(project), memoryJson(project, 0))

    const result = await mutateMemory(
      { worktree: project, directory: project },
      () => ({ kind: "noop", value: "noop" }),
    )
    expect(result.status).toBe("noop")

    expect(pulseSpy).not.toHaveBeenCalled()
  })

  it("budget-rejected mutation records no pulse and no STATE write", async () => {
    const project = await makeWorktree()
    const path = projectMemoryPath(project)
    await writeState(path, memoryJson(project, 0))

    // A single foundational decision whose serialized form alone pushes the
    // protected minimal legal state past the 8192-byte cap, so
    // fitMemoryToBudget must refuse before any commit boundary.
    const overCap: MemoryFile = {
      ...emptyMemory(project),
      revision: 0,
      decisions: [{
        id: "foundational-huge",
        topic: "x".repeat(8_000),
        decision: "keep",
        timestamp: "2026-08-01T00:00:00.000Z",
        session_id: "source",
        still_valid: true,
        foundational: true,
        foundational_requested: false,
        human_conflict_quarantined: false,
        provenance: {
          extractor: "heuristic",
          source_session_id: "source",
          confidence: "heuristic",
          evidence: [],
        },
      }],
    }
    expect(memorySizeBytes(overCap)).toBeGreaterThan(MEMORY_MAX_BYTES)

    const result = await mutateMemory(
      { worktree: project, directory: project },
      () => ({ kind: "commit", memory: overCap, value: null }),
    )
    expect(result.status).toBe("budget-rejected")
    if (result.status === "budget-rejected") {
      expect(result.reason).toBe("foundational-state-exceeds-budget")
    }

    // Budget refusal short-circuits before the canonical commit boundary.
    expect(pulseSpy).not.toHaveBeenCalled()

    const after = await readMemoryState({ worktree: project, directory: project })
    expect(after.status).toBe("ok")
    if (after.status === "ok") expect(after.revision).toBe(0)
  })

  it("validation failure records no pulse", async () => {
    const project = await makeWorktree()
    const invalid = { ...emptyMemory(project), version: 99 } as unknown as MemoryFile

    expect(await writeMemory({ worktree: project, directory: project }, invalid)).toBe(false)
    expect(pulseSpy).not.toHaveBeenCalled()
    expect(await readMemory({ worktree: project, directory: project })).toBeNull()
  })

  it("size-cap-exceeded write records no pulse", async () => {
    const project = await makeWorktree()
    const oversized = sizeProbeMemory(
      project,
      "x".repeat(MEMORY_PERSISTENCE_CEILINGS.decisionTopicChars),
    )
    expect(memorySizeBytes(oversized)).toBeGreaterThan(MEMORY_MAX_BYTES)

    expect(await writeMemory({ worktree: project, directory: project }, oversized)).toBe(false)
    expect(pulseSpy).not.toHaveBeenCalled()
    expect(await readMemory({ worktree: project, directory: project })).toBeNull()
  })

  it("commit failure with both destinations unwritable records no pulse", async () => {
    const project = await makeWorktree()
    const localPath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)
    await writeState(localPath, memoryJson(project, 0))

    // Local: read-only parent so the temp-sibling write fails (EACCES).
    // Global: a directory at the STATE path so the fallback rename fails.
    const localDir = dirname(localPath)
    await chmod(localDir, 0o555)
    await mkdir(globalPath, { recursive: true })
    try {
      const result = await mutateMemory(
        { worktree: project, directory: project },
        (memory) => ({ kind: "commit", memory, value: null }),
      )
      expect(result.status).toBe("commit-failed")
      expect(pulseSpy).not.toHaveBeenCalled()
    } finally {
      await chmod(localDir, 0o755)
      await rm(globalPath, { recursive: true, force: true })
    }
  })

  it("lock-timeout records no pulse and writes no STATE", async () => {
    const project = await makeWorktree()
    const barrier = join(homeDir, "tmtui3-store-lock-barrier")
    const release = `${barrier}.release`

    const child = spawn(
      process.execPath,
      ["--import", "tsx", WORKER, project, "hold-lock", barrier],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    )
    await waitFor(barrier)

    const result = await mutateMemory(
      {
        worktree: project,
        directory: project,
        lockOptions: { acquireTimeoutMs: 50, initialBackoffMs: 5, maxBackoffMs: 20 },
      },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("lock-timeout")
    expect(pulseSpy).not.toHaveBeenCalled()

    const read = await readMemoryState({ worktree: project, directory: project })
    expect(read.status).toBe("missing")

    await writeFile(release, "go", "utf-8")
    await new Promise<void>((resolve, reject) => {
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))))
      child.on("error", reject)
    })
  })

  it("unavailable authoritative state records no pulse", async () => {
    const project = await makeWorktree()
    // Both candidates unreadable → the authoritative read is "unavailable"
    // and the transaction must fail closed before any commit boundary.
    await mkdir(projectMemoryPath(project), { recursive: true })
    await mkdir(globalMemoryPath(project), { recursive: true })

    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("unavailable")
    expect(pulseSpy).not.toHaveBeenCalled()
  })

  it("a thrown mutation callback records no pulse, propagates, and does not commit", async () => {
    const project = await makeWorktree()
    const path = projectMemoryPath(project)
    await writeState(path, memoryJson(project, 3))

    await expect(
      mutateMemory(
        { worktree: project, directory: project },
        () => {
          throw new Error("boom")
        },
      ),
    ).rejects.toThrow("boom")

    expect(pulseSpy).not.toHaveBeenCalled()

    const onDisk = JSON.parse(await readFile(path, "utf-8")) as { revision: number }
    expect(onDisk.revision).toBe(3)
  })
})

describe("TMTUI-3 — exact-once logical commit", () => {
  it("two logical commits produce exactly two pulses", async () => {
    const project = await makeWorktree()

    const first = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(first.status).toBe("committed")

    const second = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(second.status).toBe("committed")

    // One pulse per successful logical commit — never two for one commit and
    // never zero for a durable one.
    expect(pulseSpy).toHaveBeenCalledTimes(2)
    expect(pulseSpy).toHaveBeenNthCalledWith(1, project)
    expect(pulseSpy).toHaveBeenNthCalledWith(2, project)
  })

  it("a local commit does not emit a second pulse through the global fallback", async () => {
    const project = await makeWorktree()

    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("committed")

    // The project-local success path writes the marker exactly once; the
    // unexercised fallback path must not contribute an extra emission.
    expect(pulseSpy).toHaveBeenCalledTimes(1)
  })
})

describe("TMTUI-3 — revision/state unchanged by telemetry", () => {
  it("commit revision and persisted content are identical with and without telemetry", async () => {
    const projectHealthy = await makeWorktree()
    const projectBlocked = await makeWorktree()
    await blockMarkerWrite(projectBlocked)

    const healthy = await mutateMemory(
      { worktree: projectHealthy, directory: projectHealthy },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    const blocked = await mutateMemory(
      { worktree: projectBlocked, directory: projectBlocked },
      (memory) => ({ kind: "commit", memory, value: null }),
    )

    expect(healthy.status).toBe("committed")
    expect(blocked.status).toBe("committed")
    if (healthy.status === "committed" && blocked.status === "committed") {
      // Telemetry cannot change the durable outcome: same revision, same
      // decisions/active-files/blockers/next-steps, and the blocked marker
      // never leaks into the state.
      expect(blocked.revision).toBe(healthy.revision)
      expect(blocked.memory.decisions).toEqual(healthy.memory.decisions)
      expect(blocked.memory.active_files).toEqual(healthy.memory.active_files)
      expect(blocked.memory.blockers).toEqual(healthy.memory.blockers)
      expect(blocked.memory.next_steps).toEqual(healthy.memory.next_steps)
    }
  })
})

describe("TMTUI-3 — marker isolation", () => {
  it("the pulse marker derives from the global per-project namespace, never the worktree", () => {
    const project = "/worktree/project"

    expect(memoryCommitPulsePath(project)).toBe(
      join(globalProjectStorageDir(project), ".commit-pulse"),
    )
    expect(memoryCommitPulsePath(project)).toContain(join(".config", "opencode", "memory"))
    expect(memoryCommitPulsePath(project).startsWith(project)).toBe(false)
  })

  it("a successful commit writes a marker carrying only committed_at", async () => {
    const project = await makeWorktree()

    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("committed")

    // `recordMemoryCommit` is fire-and-forget at the canonical boundary, so
    // wait for the marker to land.
    await waitFor(memoryCommitPulsePath(project))
    const raw = await readFile(memoryCommitPulsePath(project), "utf-8")
    const parsed = JSON.parse(raw) as Record<string, unknown>

    // Payload minimality: only the timestamp, never revision/STATE/memory data.
    expect(Object.keys(parsed)).toEqual(["committed_at"])
    expect(typeof parsed.committed_at).toBe("number")
    expect(Number.isFinite(parsed.committed_at as number)).toBe(true)
    expect("revision" in parsed).toBe(false)
    expect("decisions" in parsed).toBe(false)
    expect("project_path" in parsed).toBe(false)
  })

  it("different projects never share a pulse marker path", async () => {
    const projectA = await makeWorktree()
    const projectB = await makeWorktree()

    expect(memoryCommitPulsePath(projectA)).not.toBe(memoryCommitPulsePath(projectB))

    const a = await mutateMemory(
      { worktree: projectA, directory: projectA },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    const b = await mutateMemory(
      { worktree: projectB, directory: projectB },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(a.status).toBe("committed")
    expect(b.status).toBe("committed")

    await waitFor(memoryCommitPulsePath(projectA))
    // B's marker is in B's own hashed namespace; A's marker is untouched.
    await waitFor(memoryCommitPulsePath(projectB))
    expect(memoryCommitPulsePath(projectA)).not.toBe(memoryCommitPulsePath(projectB))
  })
})
