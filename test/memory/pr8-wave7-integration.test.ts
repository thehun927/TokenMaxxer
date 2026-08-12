/**
 * PR-8 Wave 7 — integration contracts.
 *
 * High-value integration contracts not already covered by the existing wave
 * tests (pr8-storage-budget, writer-llm, transaction, recall, cli). Each test
 * drives the public API (mutateMemory / finalLLMMerge / _recallPromote) and
 * asserts the typed budget contract end-to-end: the exact failure reason, the
 * no-write/no-revision invariant, and the byte-identical preservation of prior
 * STATE on refusal.
 *
 * Coverage:
 *   1. Protected foundational overflow with explicit preserveDecisionIDs
 *      returns foundational-state-exceeds-budget, no write / no revision.
 *   2. Protected ephemeral overflow (blockers + cache entries, no decisions)
 *      returns required-state-exceeds-budget, no write.
 *   3. Same-project concurrent near-cap mutations preserve both facts and
 *      advance revision exactly twice.
 *   4. Final LLM protected refusal leaves the source retryable (no completion
 *      marker) and preserves prior STATE / revision.
 *   5. recall_promote budget-rejected maps to promotion-write-failed and
 *      preserves byte-identical prior STATE.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import {
  access,
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
  readMemoryState,
  writeMemory,
  readMemory,
  type MemoryBudgetProtection,
} from "../../src/memory/store"
import { atomicWrite } from "../../src/util/fs"
import {
  emptyMemory,
  type MemoryFile,
  type Decision,
  type LLMExtractionCacheEntry,
} from "../../src/memory/schema"
import { projectMemoryPath } from "../../src/memory/paths"
import {
  MEMORY_MAX_BYTES,
  memorySizeBytes,
  serializeMemory,
} from "../../src/memory/memory-size"
import { fitMemoryToBudget } from "../../src/memory/budget"
import { finalLLMMerge } from "../../src/memory/writer"
import {
  buildCanonicalInput,
  buildTranscriptEvidenceCandidateMap,
} from "../../src/memory/extract-prompt"
import { _recallPromote } from "../../src/tools/recall"
import { resetProjectQueues } from "../../src/memory/lock"

const WORKER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "transaction-worker.ts",
)

const barrierFiles: string[] = []

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(path: string, timeoutMs = 8000): Promise<void> {
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

/**
 * Deterministic decision factory. Produces schema-valid decisions with
 * predictable sizes for byte accounting. All decisions are heuristic-backed
 * unless overridden.
 */
function makeDecision(
  id: string,
  topic: string,
  decisionText: string,
  overrides: Partial<Decision> = {},
): Decision {
  return {
    id,
    topic,
    decision: decisionText,
    timestamp: "2026-08-10T00:00:00.000Z",
    session_id: "session-0",
    still_valid: true,
    foundational: false,
    foundational_requested: false,
    provenance: {
      extractor: "heuristic",
      source_session_id: "session-0",
      confidence: "heuristic",
      evidence: [],
    },
    ...overrides,
  }
}

/**
 * Build a valid LLM-extraction cache entry with evidence-backed provenance.
 * Each entry is roughly 500 bytes serialized.
 */
function makeCacheEntry(index: number): LLMExtractionCacheEntry {
  return {
    cache_key: `cache-key-${index.toString().padStart(4, "0")}`,
    source_session_id: `source-${index}`,
    canonical_input_sha256: "a".repeat(64),
    provider_id: "provider",
    model_id: "model",
    completed_at: "2026-08-10T00:00:00.000Z",
    provenance: {
      extractor: "llm",
      source_session_id: `source-${index}`,
      source_audit_session_id: `audit-${index}`,
      confidence: "llm-corroborated",
      evidence: [{ kind: "transcript", ref: `tr-${index}`, digest: "b".repeat(64) }],
    },
    facts: { decisions: [] },
  }
}

/**
 * Seed a STATE.json directly on disk, bypassing writeMemory's size cap so an
 * over-cap base state can be installed for refusal tests.
 */
async function seedOverCapState(path: string, mem: MemoryFile): Promise<void> {
  await atomicWrite(path, serializeMemory(mem))
}

describe("PR-8 Wave 7 — integration contracts", () => {
  let worktree: string

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "tokenmaxxer-pr8w7-"))
    resetProjectQueues()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await Promise.all(
      barrierFiles.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})),
    )
    barrierFiles.length = 0
    await rm(worktree, { recursive: true, force: true }).catch(() => {})
  })

  // ─── (1) Protected foundational overflow ─────────────────────────────────
  describe("protected foundational overflow with explicit preserveDecisionIDs", () => {
    it("returns foundational-state-exceeds-budget with no write and no revision bump", async () => {
      const project = worktree
      const path = projectMemoryPath(project)

      // Seed at revision 0 (empty, fits).
      await atomicWrite(path, serializeMemory(emptyMemory(project)))
      const before = await readMemoryState({ worktree: project, directory: project })
      expect(before.status).toBe("ok")
      if (before.status !== "ok") return
      expect(before.revision).toBe(0)

      // Build an over-cap candidate: 25 non-foundational decisions, each
      // ~420 bytes serialized. Total decisions payload ≈ 10.5KB, well over
      // the 8192-byte cap. None are foundational on their own.
      const decisions: Decision[] = []
      for (let i = 0; i < 25; i++) {
        decisions.push(
          makeDecision(
            `dec-${i.toString().padStart(3, "0")}`,
            `topic-${i}`,
            `Decision content ${i} ${"x".repeat(300)}`,
          ),
        )
      }
      const overCap: MemoryFile = {
        ...emptyMemory(project),
        revision: 0,
        decisions,
      }
      expect(memorySizeBytes(overCap)).toBeGreaterThan(MEMORY_MAX_BYTES)

      // Protect ALL non-foundational decisions via preserveDecisionIDs.
      // The minimal legal state is therefore the full set, which exceeds the
      // budget → foundational-state-exceeds-budget.
      const protection: MemoryBudgetProtection = {
        preserveDecisionIDs: decisions.map((d) => d.id),
      }

      const result = await mutateMemory(
        { worktree: project, directory: project },
        () => ({ kind: "commit", memory: overCap, value: null, budgetProtection: protection }),
      )

      expect(result.status).toBe("budget-rejected")
      if (result.status !== "budget-rejected") return
      expect(result.reason).toBe("foundational-state-exceeds-budget")
      expect(result.revision).toBe(0) // no revision bump
      expect(result.requiredBytes).toBeGreaterThan(MEMORY_MAX_BYTES)
      expect(result.maxBytes).toBe(MEMORY_MAX_BYTES)

      // No write occurred: on-disk STATE is still the empty seed at revision 0.
      const after = await readMemoryState({ worktree: project, directory: project })
      expect(after.status).toBe("ok")
      if (after.status === "ok") {
        expect(after.revision).toBe(0)
        expect(after.memory.decisions).toHaveLength(0)
      }
    })
  })

  // ─── (2) Protected ephemeral overflow → required-state-exceeds-budget ─────
  describe("protected ephemeral overflow returns required-state-exceeds-budget", () => {
    it("rejects with required-state-exceeds-budget when blockers + cache survive pruning but no decisions exist", async () => {
      const project = worktree

      // Build a schema-valid over-cap state with NO decisions. Stage 9 cannot
      // prune decisions (none exist); stage 8/10 truncate blockers to 8 × 512B
      // and keep 10 cache entries. The minimal legal state (no decisions, no
      // protected sources/audits) is tiny and fits, so the refusal reason is
      // required-state-exceeds-budget rather than foundational.
      const blockers: string[] = []
      for (let i = 0; i < 8; i++) {
        blockers.push(`Blocker number ${i} ${"y".repeat(450)}`)
      }
      const cache: LLMExtractionCacheEntry[] = []
      for (let i = 0; i < 10; i++) {
        cache.push(makeCacheEntry(i))
      }
      const overCap: MemoryFile = {
        ...emptyMemory(project),
        revision: 0,
        blockers,
        llm_extraction_cache: cache,
      }
      expect(memorySizeBytes(overCap)).toBeGreaterThan(MEMORY_MAX_BYTES)

      // Drive the budget authority directly to assert the typed reason.
      const fit = fitMemoryToBudget(overCap)
      expect(fit.ok).toBe(false)
      if (fit.ok) return
      expect(fit.reason).toBe("required-state-exceeds-budget")
      expect(fit.requiredBytes).toBeGreaterThan(MEMORY_MAX_BYTES)
      expect(fit.maxBytes).toBe(MEMORY_MAX_BYTES)

      // Now drive through mutateMemory and assert the same contract end-to-end
      // with the no-write/no-revision invariant.
      const path = projectMemoryPath(project)
      await atomicWrite(path, serializeMemory(emptyMemory(project)))

      const result = await mutateMemory(
        { worktree: project, directory: project },
        () => ({ kind: "commit", memory: overCap, value: null }),
      )
      expect(result.status).toBe("budget-rejected")
      if (result.status !== "budget-rejected") return
      expect(result.reason).toBe("required-state-exceeds-budget")
      expect(result.revision).toBe(0)

      // No write occurred.
      const after = await readMemoryState({ worktree: project, directory: project })
      expect(after.status).toBe("ok")
      if (after.status === "ok") {
        expect(after.revision).toBe(0)
        expect(after.memory.decisions).toHaveLength(0)
        expect(after.memory.blockers).toHaveLength(0)
      }
    })
  })

  // ─── (3) Concurrent near-cap mutations ───────────────────────────────────
  describe("same-project concurrent near-cap mutations preserve both facts and revisions", () => {
    it("two child mutations near the cap both survive; revision advances exactly twice", async () => {
      const project = worktree
      const path = projectMemoryPath(project)

      // Build a near-cap base: decisions totaling ~7000 bytes (under 8192).
      const base = emptyMemory(project)
      base.revision = 0
      let i = 0
      while (memorySizeBytes(base) < 7000 && i < 100) {
        base.decisions.push(
          makeDecision(
            `base-${i.toString().padStart(3, "0")}`,
            `base-topic-${i}`,
            `Base decision ${i} ${"z".repeat(200)}`,
          ),
        )
        i++
      }
      expect(memorySizeBytes(base)).toBeLessThan(MEMORY_MAX_BYTES)
      expect(memorySizeBytes(base)).toBeGreaterThan(6000)
      await atomicWrite(path, serializeMemory(base))

      const readyA = join(worktree, "w7-a")
      const readyB = join(worktree, "w7-b")
      barrierFiles.push(readyA, `${readyA}.release`, readyB)

      // Child A holds the lock, signals, then mutates while holding it.
      const a = runWorker([project, "hold-write", readyA, "A"])
      await waitFor(readyA) // A holds the lock.

      // Child B waits for A's pre-mutation barrier, then mutates (contends).
      const b = runWorker([project, "barrier-write", readyA, "B", readyB])
      await waitFor(readyB) // B reached its pre-mutation barrier (about to block).

      // Release A; A mutates (+1) and releases; B acquires and mutates (+1).
      await writeFile(`${readyA}.release`, "go", "utf-8")

      const [ra, rb] = await Promise.all([a, b])
      expect(ra.code).toBe(0)
      expect(rb.code).toBe(0)
      expect(JSON.parse(ra.stdout)).toMatchObject({ status: "ok" })
      expect(JSON.parse(rb.stdout)).toMatchObject({ status: "ok" })

      // Both facts survive and revision advanced exactly twice (0 → 2).
      const raw = await readFile(path, "utf-8")
      const onDisk = JSON.parse(raw) as { revision: number; decisions: Array<{ id: string }> }
      expect(onDisk.revision).toBe(2)
      const ids = onDisk.decisions.map((d) => d.id)
      expect(ids).toContain("fact-A")
      expect(ids).toContain("fact-B")
      // Base decisions are preserved (budget fitting did not evict them).
      expect(ids).toContain("base-000")
      // Final on-disk state still respects the cap.
      expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(MEMORY_MAX_BYTES)
    })
  })

  // ─── (4) Final LLM protected refusal ─────────────────────────────────────
  describe("final LLM protected refusal leaves source retryable and preserves prior state", () => {
    it("budget-rejected finalLLMMerge writes no completion marker and bumps no revision", async () => {
      const project = worktree
      const path = projectMemoryPath(project)

      // Seed an over-cap base of foundational decisions directly on disk.
      // 12 foundational decisions × ~620 bytes ≈ 7.4KB, over the cap.
      const base = emptyMemory(project)
      base.revision = 0
      for (let i = 0; i < 12; i++) {
        base.decisions.push(
          makeDecision(
            `found-${i.toString().padStart(3, "0")}`,
            `foundational-topic-${i}`,
            `Foundational decision ${i} ${"f".repeat(400)}`,
            {
              foundational: true,
              provenance: {
                extractor: "human",
                source_session_id: `human-${i}`,
                confidence: "human-reviewed",
                evidence: [],
              },
              human_review: {
                channel: "interactive-cli",
                reviewed_at: "2026-08-01T00:00:00.000Z",
              },
            },
          ),
        )
      }
      expect(memorySizeBytes(base)).toBeGreaterThan(MEMORY_MAX_BYTES)
      await seedOverCapState(path, base)
      const beforeRaw = await readFile(path, "utf-8")

      const sourceVersionKey = `v2s:${"e".repeat(64)}`
      const result = await finalLLMMerge(
        { client: {}, worktree: project, directory: project },
        {
          sessionId: "source-wave7",
          gitSha: null,
          canonicalInput: buildCanonicalInput([], base),
          selectedModel: { providerID: "provider", modelID: "model" },
          selectedCacheKey: `v2e:${"d".repeat(64)}`,
          sourceVersionKey,
          sourceInputSha256: "1".repeat(64),
          promptInputSha256: "2".repeat(64),
          llmFacts: { decisions: [] },
          extractionAuditSessionID: "audit-wave7",
          candidates: buildTranscriptEvidenceCandidateMap([]),
          digests: {},
        },
      )

      // The protected foundational state cannot fit → budget-rejected.
      expect(result.status).toBe("budget-rejected")

      // No completion marker: the source remains retryable.
      const onDisk = await readMemory({ worktree: project, directory: project })
      expect(onDisk).not.toBeNull()
      expect(onDisk?.processed_sources.some((s) => s.source_key === sourceVersionKey)).toBe(false)

      // Prior STATE is preserved byte-for-byte (no partial write, no revision bump).
      const afterRaw = await readFile(path, "utf-8")
      expect(afterRaw).toBe(beforeRaw)
    })
  })

  // ─── (5) recall_promote budget-rejected → promotion-write-failed ─────────
  describe("recall_promote budget-rejected preserves byte-identical prior STATE", () => {
    it("maps budget-rejected to promotion-write-failed and writes nothing", async () => {
      const project = worktree
      const path = projectMemoryPath(project)

      // Seed an over-cap base: 14 foundational decisions (~8.7KB) plus one
      // non-foundational target with a unique topic so it is an authority.
      const base = emptyMemory(project)
      base.revision = 0
      for (let i = 0; i < 14; i++) {
        base.decisions.push(
          makeDecision(
            `found-${i.toString().padStart(3, "0")}`,
            `foundational-topic-${i}`,
            `Foundational decision ${i} ${"f".repeat(400)}`,
            {
              foundational: true,
              provenance: {
                extractor: "human",
                source_session_id: `human-${i}`,
                confidence: "human-reviewed",
                evidence: [],
              },
              human_review: {
                channel: "interactive-cli",
                reviewed_at: "2026-08-01T00:00:00.000Z",
              },
            },
          ),
        )
      }
      // The target: a non-foundational authority for its own topic.
      base.decisions.push(
        makeDecision(
          "target-001",
          "target-topic-wave7",
          `Target decision ${"t".repeat(200)}`,
        ),
      )
      expect(memorySizeBytes(base)).toBeGreaterThan(MEMORY_MAX_BYTES)
      await seedOverCapState(path, base)
      const beforeRaw = await readFile(path, "utf-8")

      // _recallPromote acquires the project lock, runs requestFoundationalReview
      // (which returns "requested" for the eligible target), then mutateMemory
      // applies the mutation and calls fitMemoryToBudget. The protected
      // foundational set exceeds the budget → budget-rejected, which
      // formatRecallPromoteResult maps to "promotion-write-failed".
      const result = await _recallPromote(
        { decision_id: "target-001" },
        { worktree: project, directory: project, sessionID: "review-wave7" },
      )

      expect(result).toBe("promotion-write-failed")

      // Byte-identical preservation: no write occurred.
      const afterRaw = await readFile(path, "utf-8")
      expect(afterRaw).toBe(beforeRaw)

      // The target was never muted: foundational_requested is still false on disk.
      const onDisk = await readMemory({ worktree: project, directory: project })
      const target = onDisk?.decisions.find((d) => d.id === "target-001")
      expect(target?.foundational_requested).toBe(false)
      expect(target?.foundational).toBe(false)
    })
  })
})
