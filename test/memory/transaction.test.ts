/**
 * Cross-process transaction correctness tests (PR 2 §14, §15).
 *
 * These tests prove the `mutateMemory` / `withProjectLock` transaction
 * protocol works across actual OS child processes, not just two Promises in
 * one Vitest process. Each test isolates the global fallback namespace via
 * `vi.stubEnv("HOME", tempHome)`.
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
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

import {
  mutateMemory,
  readMemoryState,
  writeMemory,
} from "../../src/memory/store"
import {
  globalMemoryPath,
  globalProjectStorageDir,
  projectMemoryPath,
  projectLockDir,
} from "../../src/memory/paths"
import { emptyMemory } from "../../src/memory/schema"
import { withProjectLock } from "../../src/memory/project-lock"
import { atomicWrite } from "../../src/util/fs"
import { _recallPromote } from "../../src/tools/recall"
import {
  persistAuditGuard,
  persistModelHealth,
  finalLLMMerge,
} from "../../src/memory/writer"
import { buildCanonicalInput, buildTranscriptEvidenceCandidateMap, makeTranscriptEvidenceRef } from "../../src/memory/extract-prompt"

const WORKER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "transaction-worker.ts",
)

let homeDir: string
const barrierFiles: string[] = []

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

/** Spawn the worker fixture and resolve with its stdout + exit code. */
function runWorker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => {
      stdout += String(d)
    })
    child.stderr.on("data", (d) => {
      stderr += String(d)
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** A minimal valid STATE.json document for a project at the given revision. */
function memoryJson(project: string, revision: number): string {
  return JSON.stringify({ ...emptyMemory(project), revision }, null, 2)
}

async function writeState(path: string, content: string): Promise<void> {
  await atomicWrite(path, content)
}

async function readOnDisk(path: string): Promise<{ revision: number; decisions: Array<{ id: string }> }> {
  const raw = await readFile(path, "utf-8")
  return JSON.parse(raw)
}

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "tokenmaxxer-txn-home-"))
  vi.stubEnv("HOME", homeDir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    barrierFiles.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})),
  )
  barrierFiles.length = 0
  await rm(homeDir, { recursive: true, force: true }).catch(() => {})
})

describe("two child processes, same project, different facts", () => {
  it("both mutations survive; final revision is N+2; one child is blocked on the lock", async () => {
    const project = join(homeDir, "proj")
    const statePath = projectMemoryPath(project)
    await writeState(statePath, memoryJson(project, 10))

    // Child A acquires the lock, signals readyA, and holds it until released.
    // Child B waits for readyA (its pre-mutation barrier) before mutating, so
    // B is guaranteed to contend for the lock while A holds it — not run
    // sequentially.
    const readyA = join(homeDir, "txn-a")
    const readyB = join(homeDir, "txn-b")
    barrierFiles.push(readyA, `${readyA}.release`, readyB)

    const a = runWorker([project, "hold-write", readyA, "A"])
    await waitFor(readyA) // A holds the lock.

    const b = runWorker([project, "barrier-write", readyA, "B", readyB])
    await waitFor(readyB) // B reached its pre-mutation barrier (about to block).

    // B must be blocked on the lock while A holds it: B cannot have finished.
    // Release A; A mutates (revision +1) and releases, then B acquires and
    // mutates (revision +1).
    await writeFile(`${readyA}.release`, "go", "utf-8")

    const [ra, rb] = await Promise.all([a, b])
    expect(ra.code).toBe(0)
    expect(rb.code).toBe(0)
    expect(JSON.parse(ra.stdout)).toMatchObject({ status: "ok" })
    expect(JSON.parse(rb.stdout)).toMatchObject({ status: "ok" })

    const onDisk = await readOnDisk(statePath)
    expect(onDisk.revision).toBe(12)
    const ids = onDisk.decisions.map((d) => d.id)
    expect(ids).toContain("fact-A")
    expect(ids).toContain("fact-B")
  })
})

describe("no-op child does not bump revision", () => {
  it("revision is unchanged before and after", async () => {
    const project = join(homeDir, "proj")
    const statePath = projectMemoryPath(project)
    await writeState(statePath, memoryJson(project, 4))

    const { code, stdout } = await runWorker([project, "noop-write"])
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toMatchObject({ status: "noop", revision: 4 })

    const onDisk = await readOnDisk(statePath)
    expect(onDisk.revision).toBe(4)
  })
})

describe("exactly one revision per mutateMemory", () => {
  it("one commit advances N -> N+1, never N+2", async () => {
    const project = join(homeDir, "proj")
    const statePath = projectMemoryPath(project)
    await writeState(statePath, memoryJson(project, 7))

    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("committed")
    if (result.status === "committed") expect(result.revision).toBe(8)

    const onDisk = await readOnDisk(statePath)
    expect(onDisk.revision).toBe(8)
  })
})

describe("transaction bypasses cache", () => {
  it("builds on the newer durable revision, not the stale cache", async () => {
    const project = join(homeDir, "proj")
    const statePath = projectMemoryPath(project)
    await writeState(statePath, memoryJson(project, 1))

    // Preload the process cache with revision 1.
    const cached = await readMemoryState({ worktree: project, directory: project })
    expect(cached.status).toBe("ok")
    if (cached.status === "ok") expect(cached.revision).toBe(1)

    // Externally replace STATE at revision 5, pinning the same mtime so a
    // non-bypassing read would reuse the stale cache.
    const originalMtime = (await stat(statePath)).mtimeMs
    await writeState(statePath, memoryJson(project, 5))
    await utimes(statePath, new Date(originalMtime), new Date(originalMtime))

    let observedRevision: number | null = null
    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => {
        observedRevision = memory.revision
        return { kind: "commit", memory, value: null }
      },
    )

    expect(observedRevision).toBe(5)
    expect(result.status).toBe("committed")
    if (result.status === "committed") expect(result.revision).toBe(6)
    const onDisk = await readOnDisk(statePath)
    expect(onDisk.revision).toBe(6)
  })
})

describe("commit failure releases lock", () => {
  it("a failed commit does not leak the project lock", async () => {
    const project = join(homeDir, "proj")
    const statePath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)
    await writeState(statePath, memoryJson(project, 0))

    // Make both STATE destinations unwritable while keeping the local STATE
    // readable so the transaction read succeeds (status "ok") and the commit
    // is what fails.
    //  - Local: chmod the `.opencode/memory` parent to 0o555 (r-x, no write).
    //    The existing STATE file stays readable, but `atomicWrite` cannot
    //    create its temp sibling (EACCES).
    //  - Global: place a directory at the global STATE path so the fallback
    //    atomic rename fails (EISDIR/ENOTEMPTY). The project lock lives at
    //    `<globalDir>/.state-lock`, a sibling, so lock acquisition is
    //    unaffected.
    const localDir = dirname(statePath)
    await chmod(localDir, 0o555)
    await mkdir(globalPath, { recursive: true })

    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("commit-failed")

    // Restore writability so the next transaction can write.
    await chmod(localDir, 0o755)
    await rm(globalPath, { recursive: true, force: true })

    // The lock must be acquirable immediately (not leaked by the failed commit).
    const second = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(second.status).toBe("committed")
  })
})

describe("thrown mutation callback releases lock and does not commit", () => {
  it("propagates the throw and leaves the lock acquirable", async () => {
    const project = join(homeDir, "proj")
    const statePath = projectMemoryPath(project)
    await writeState(statePath, memoryJson(project, 3))

    await expect(
      mutateMemory(
        { worktree: project, directory: project },
        () => {
          throw new Error("boom")
        },
      ),
    ).rejects.toThrow("boom")

    // The lock is not held by this process: a fresh acquisition succeeds.
    await withProjectLock(project, async () => {
      await access(projectLockDir(project))
    })
    await expect(access(projectLockDir(project))).rejects.toThrow()

    // No commit happened.
    const onDisk = await readOnDisk(statePath)
    expect(onDisk.revision).toBe(3)
  })
})

describe("different projects do not block", () => {
  it("project B commits while project A's lock is held", async () => {
    const projectA = join(homeDir, "projA")
    const projectB = join(homeDir, "projB")
    const barrier = join(homeDir, "hold-a")
    barrierFiles.push(barrier, `${barrier}.release`)

    const child = runWorker([projectA, "hold-lock", barrier])
    await waitFor(barrier)

    // B commits while A holds its lock.
    const result = await mutateMemory(
      { worktree: projectB, directory: projectB },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("committed")

    // Release A; the child exits cleanly.
    await writeFile(`${barrier}.release`, "go", "utf-8")
    const { code } = await child
    expect(code).toBe(0)
  })
})

describe("local/global fallback uses the same lock key", () => {
  it("a global-fallback commit serializes with a concurrent child mutation", async () => {
    const project = join(homeDir, "proj")
    const localPath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)

    // Seed STATE at the local path at revision 0.
    await writeState(localPath, memoryJson(project, 0))

    // Force the local write to fail (so the commit falls through to the global
    // path) by making the local `.opencode/memory` parent read-only. The
    // existing STATE file stays readable, so the transaction read still
    // succeeds from the local path; only `atomicWrite`'s temp-sibling creation
    // fails (EACCES), routing the commit to the global fallback.
    const localDir = dirname(localPath)
    await chmod(localDir, 0o555)

    // Fork a child that also mutates the same project (its commit will also
    // fall through to the global path, sharing the same project lock).
    const child = runWorker([project, "idle-write", "child"])

    // The test process commits to the same project via the global fallback.
    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({
        kind: "commit",
        memory: {
          ...memory,
          decisions: [
            ...memory.decisions,
            {
              id: "fact-parent",
              topic: "topic-parent",
              decision: "decision-parent",
              timestamp: new Date().toISOString(),
              session_id: "parent",
              still_valid: true,
              foundational: false,
              provenance: {
                extractor: "heuristic",
                source_session_id: "parent",
                confidence: "heuristic",
                evidence: [],
              },
            },
          ],
        },
        value: null,
      }),
    )
    expect(result.status).toBe("committed")

    const { code } = await child
    expect(code).toBe(0)

    // Both mutations serialized through the same lock key: the global STATE
    // carries both facts and the revision advanced exactly twice.
    const onDisk = await readOnDisk(globalPath)
    expect(onDisk.revision).toBe(2)
    const ids = onDisk.decisions.map((d) => d.id)
    expect(ids).toContain("fact-parent")
    expect(ids).toContain("fact-child")
  })
})

// ─── Additional release-gate tests (PR 2 §15.16–18, §15.20) ─────────────────

/** Seed a STATE.json with one promotable decision at the given revision. */
function seedDecisionJson(project: string, revision: number): string {
  return JSON.stringify(
    {
      ...emptyMemory(project),
      revision,
      decisions: [
        {
          id: "d-db",
          topic: "database",
          decision: "Use PostgreSQL",
          timestamp: "2026-08-07T10:00:00.000Z",
          session_id: "sess-001",
          still_valid: true,
          foundational: false,
          provenance: {
            extractor: "heuristic",
            source_session_id: "sess-001",
            confidence: "heuristic",
            evidence: [],
          },
        },
      ],
    },
    null,
    2,
  )
}

function auditRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    audit_session_id: "audit-16",
    source_session_id: "source-16",
    cache_key: "cache-key-16",
    provider_id: "provider",
    model_id: "model",
    created_at: new Date().toISOString(),
    terminal_outcome: "pending",
    ...overrides,
  }
}

function healthReport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    providerID: "provider",
    modelID: "model",
    outcome: "success",
    reason: "accepted-extraction",
    ...overrides,
  }
}

function llmFacts(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    current_task: "LLM task",
    active_files: [],
    decisions: [],
    blockers: [],
    next_steps: [],
    ...overrides,
  }
}

describe("audit guard cannot overwrite a concurrent heuristic mutation (PR 2 §15.16)", () => {
  it("final STATE contains both the new decision and the new audit row", async () => {
    const project = join(homeDir, "proj16")
    const statePath = projectMemoryPath(project)
    await writeState(statePath, seedDecisionJson(project, 10))

    // Fork an idle-write worker for the same project; it contends for the same
    // project lock as the in-process audit-guard transaction.
    const child = runWorker([project, "idle-write", "child16"])

    // Drive the audit-guard transaction in this process concurrently.
    const persisted = await persistAuditGuard(
      { client: {}, worktree: project, directory: project },
      auditRecord() as never,
    )
    expect(persisted).toBe(true)

    const { code } = await child
    expect(code).toBe(0)

    // Final STATE: revision advanced exactly twice (idle write + audit guard),
    // and both the new decision and the new audit row are present.
    const onDisk = await readOnDisk(statePath)
    expect(onDisk.revision).toBe(12)
    const ids = onDisk.decisions.map((d) => d.id)
    expect(ids).toContain("fact-child16")
    const raw = await readFile(statePath, "utf-8")
    const parsed = JSON.parse(raw) as { llm_extraction_audits?: Array<{ audit_session_id: string }> }
    expect(parsed.llm_extraction_audits?.some((a) => a.audit_session_id === "audit-16")).toBe(true)
  })
})

describe("model-health update cannot overwrite a concurrent durable mutation (PR 2 §15.17)", () => {
  it("final STATE contains both the health row and the idle-write fact", async () => {
    const project = join(homeDir, "proj17")
    const statePath = projectMemoryPath(project)
    await writeState(statePath, memoryJson(project, 0))

    const child = runWorker([project, "idle-write", "child17"])

    await persistModelHealth(
      { client: {}, worktree: project, directory: project },
      healthReport() as never,
    )

    const { code } = await child
    expect(code).toBe(0)

    const onDisk = await readOnDisk(statePath)
    expect(onDisk.revision).toBe(2)
    const ids = onDisk.decisions.map((d) => d.id)
    expect(ids).toContain("fact-child17")
    const raw = await readFile(statePath, "utf-8")
    const parsed = JSON.parse(raw) as { model_health?: Array<{ provider_id: string }> }
    expect(parsed.model_health?.some((h) => h.provider_id === "provider")).toBe(true)
  })
})

describe("final LLM merge cannot overwrite a mutation committed while the prompt was running (PR 2 §15.18)", () => {
  it("final STATE contains both the idle-write fact and the LLM merge", async () => {
    const project = join(homeDir, "proj18")
    const statePath = projectMemoryPath(project)
    const messages = [
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "Implement the extraction integration." }] },
      { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "We will use SDK v2 for structured output." }] },
    ]
    const model = { providerID: "provider", modelID: "model" }
    const prior = emptyMemory(project)
    prior.revision = 0
    await writeState(statePath, JSON.stringify(prior, null, 2))

    // Fork an idle-write worker that commits while the "prompt" is pending.
    const child = runWorker([project, "idle-write", "child18"])

    // The final-LLM transaction runs after the child commits; it must rebase on
    // the locked read and preserve the child's fact.
    const candidates = buildTranscriptEvidenceCandidateMap(messages)
    const transcriptCandidates: Record<string, { kind: "transcript"; ref: string; digest: string }> = {}
    const digests: Record<string, string> = {}
    for (const [ref, candidate] of Object.entries(candidates)) {
      transcriptCandidates[ref] = { kind: "transcript", ref, digest: candidate.digest }
      digests[ref] = candidate.digest
    }
    const result = await finalLLMMerge(
      { client: {}, worktree: project, directory: project },
      {
        sessionId: "source-final18",
        gitSha: null,
        canonicalInput: buildCanonicalInput(messages, prior),
        selectedModel: model,
        selectedCacheKey: "cache-key-18",
        llmFacts: llmFacts({ current_task: "task-final18" }) as never,
        extractionAuditSessionID: "audit-18",
        candidates: transcriptCandidates,
        digests,
      },
    )
    expect(result.status).toBe("committed")

    const { code } = await child
    expect(code).toBe(0)

    const onDisk = await readOnDisk(statePath)
    const ids = onDisk.decisions.map((d) => d.id)
    expect(ids).toContain("fact-child18")
    const raw = await readFile(statePath, "utf-8")
    const parsed = JSON.parse(raw) as { current_task?: string }
    expect(parsed.current_task).toBe("task-final18")
  })
})

describe("unavailable STATE fails closed under transaction (PR 2 §15.20)", () => {
  it("no unlocked fallback write happens when the transaction returns unavailable", async () => {
    const project = join(homeDir, "proj20")
    const statePath = projectMemoryPath(project)
    const globalPath = globalMemoryPath(project)
    // Make both candidates unreadable so the authoritative read is "unavailable".
    await mkdir(statePath, { recursive: true })
    await mkdir(globalPath, { recursive: true })

    const writeSpy = vi.spyOn(await import("../../src/memory/store"), "writeMemory")

    const result = await mutateMemory(
      { worktree: project, directory: project },
      (memory) => ({ kind: "commit", memory, value: null }),
    )
    expect(result.status).toBe("unavailable")

    // No unlocked fallback writeMemory for STATE.
    expect(writeSpy).not.toHaveBeenCalled()
  })
})

describe("recall_promote review request serializes with a concurrent idle write (PR 3 §9)", () => {
  it("final STATE carries both the review request and the idle-write fact", async () => {
    const project = join(homeDir, "proj-rev")
    const statePath = projectMemoryPath(project)
    await writeState(statePath, seedDecisionJson(project, 10))

    const preBarrier = join(homeDir, "rev-pre")
    const armed = join(homeDir, "rev-armed")
    barrierFiles.push(preBarrier, armed)

    // The child reaches its pre-mutation barrier (armed) and only then commits.
    // The parent's review request therefore commits FIRST; the child's
    // mutateMemory rebases on the request's revision and must preserve it.
    const child = runWorker([project, "barrier-write", preBarrier, "rev", armed])
    await waitFor(armed)

    const result = await _recallPromote(
      { decision_id: "d-db" },
      { worktree: project, directory: project, sessionID: "review-session" },
    )
    expect(result).toContain("Foundational review requested for d-db")

    await writeFile(preBarrier, "go", "utf-8")
    const { code } = await child
    expect(code).toBe(0)

    const onDisk = await readOnDisk(statePath)
    expect(onDisk.revision).toBe(12)
    const ids = onDisk.decisions.map((d) => d.id)
    expect(ids).toContain("fact-rev")
    const raw = await readFile(statePath, "utf-8")
    const parsed = JSON.parse(raw) as {
      decisions: Array<{
        id: string
        foundational_requested?: boolean
        foundational?: boolean
        provenance?: { confidence?: string; extractor?: string }
        human_review?: unknown
      }>
    }
    const target = parsed.decisions.find((d) => d.id === "d-db")!
    // The idle write preserved the review request: no trust was minted.
    expect(target.foundational_requested).toBe(true)
    expect(target.foundational).toBe(false)
    expect(target.provenance?.confidence).toBe("heuristic")
    expect(target.provenance?.extractor).toBe("heuristic")
    expect(target.human_review).toBeUndefined()
  })
})
