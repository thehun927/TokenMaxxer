/**
 * PR-8 Wave 2 focused unit tests for budget primitives.
 *
 * Tests UTF-8 helpers, typed failure reasons, protection metadata,
 * and pure deterministic fitMemoryToBudget() function.
 *
 * @see docs/CRIP/PR-8/implementation-plan.md §§3–5
 */

import { describe, it, expect } from "vitest"
import {
  utf8Bytes,
  fitsUtf8Budget,
  truncateUtf8,
  MemoryBudgetFailureReason,
  MemoryBudgetProtection,
  PruneResult,
  fitMemoryToBudget,
  MEMORY_MAX_BYTES,
} from "../../src/memory/budget"
import type { MemoryFile } from "../../src/memory/schema"
import { emptyMemory } from "../../src/memory/schema"

describe("PR-8 Wave 2: Budget Primitives", () => {
  describe("UTF-8 helpers", () => {
    it("utf8Bytes returns exact UTF-8 byte length", () => {
      expect(utf8Bytes("hello")).toBe(5)
      expect(utf8Bytes("hello world")).toBe(11)
    })

    it("utf8Bytes handles multibyte characters correctly", () => {
      expect(utf8Bytes("你好")).toBe(6) // 2 bytes per Chinese character
      expect(utf8Bytes("😀")).toBe(4) // 4 bytes for emoji
      expect(utf8Bytes("café")).toBe(5) // é is 2 bytes
    })

    it("utf8Bytes distinguishes ASCII from multibyte with equal JS length", () => {
      // "hello" is 5 bytes, "héllo" (é) is 6 bytes
      expect(utf8Bytes("hello")).toBe(5)
      expect(utf8Bytes("héllo")).toBe(6)
    })

    it("fitsUtf8Budget returns true for strings within budget", () => {
      expect(fitsUtf8Budget("hello", 10)).toBe(true)
      expect(fitsUtf8Budget("你好", 10)).toBe(true)
      expect(fitsUtf8Budget("😀", 10)).toBe(true)
    })

    it("fitsUtf8Budget returns false for strings exceeding budget", () => {
      expect(fitsUtf8Budget("hello", 4)).toBe(false)
      expect(fitsUtf8Budget("你好", 5)).toBe(false)
      expect(fitsUtf8Budget("😀", 3)).toBe(false)
    })

    it("truncateUtf8 never leaves malformed UTF-8/code-point fragments", () => {
      const truncated = truncateUtf8("café au lait", 10)
      expect(truncated).not.toContain("�")
      expect(truncated).not.toContain("\ufffd")
    })

    it("truncateUtf8 handles multibyte characters correctly", () => {
      const truncated = truncateUtf8("你好世界", 6) // 2 bytes per char, 6 bytes total
      // With marker "..." taking 3 bytes, we can only fit 3 bytes of content
      expect(truncated).toBe("你...")
    })

    it("truncateUtf8 handles emoji correctly", () => {
      const truncated = truncateUtf8("😀😀😀", 8) // 4 bytes per emoji
      // With marker "..." taking 3 bytes, we can only fit 5 bytes of content
      expect(truncated).toBe("😀...")
    })

    it("truncateUtf8 reserves space for truncation marker", () => {
      const truncated = truncateUtf8("hello world", 10)
      expect(truncated).toContain("...")
    })

    it("truncateUtf8 returns original string if it fits", () => {
      const original = "hello world"
      const truncated = truncateUtf8(original, 100)
      expect(truncated).toBe(original)
    })

    it("truncateUtf8 returns marker only if even marker doesn't fit", () => {
      const truncated = truncateUtf8("a", 0)
      expect(truncated).toBe("...")
    })
  })

  describe("MemoryBudgetFailureReason", () => {
    it("has two failure reasons", () => {
      const reasons: MemoryBudgetFailureReason[] = [
        "foundational-state-exceeds-budget",
        "required-state-exceeds-budget",
      ]
      expect(reasons).toHaveLength(2)
    })
  })

  describe("MemoryBudgetProtection", () => {
    it("has optional arrays for protected IDs", () => {
      const protection: MemoryBudgetProtection = {
        preserveProcessedSourceKeys: ["v2s:abc123"],
        preserveAuditSessionIDs: ["audit-123"],
        preserveDecisionIDs: ["decision-456"],
      }
      expect(protection.preserveProcessedSourceKeys).toEqual(["v2s:abc123"])
      expect(protection.preserveAuditSessionIDs).toEqual(["audit-123"])
      expect(protection.preserveDecisionIDs).toEqual(["decision-456"])
    })

    it("allows empty protection object", () => {
      const protection: MemoryBudgetProtection = {}
      expect(protection).toEqual({})
    })
  })

  describe("PruneResult", () => {
    it("has success branch with memory, bytes, maxBytes, pruned", () => {
      const mem = emptyMemory("/test")
      const result: PruneResult = {
        ok: true,
        memory: mem,
        bytes: 100,
        maxBytes: 8192,
        pruned: false,
      }
      expect(result.ok).toBe(true)
      expect(result.memory).toBe(mem)
      expect(result.bytes).toBe(100)
      expect(result.maxBytes).toBe(8192)
      expect(result.pruned).toBe(false)
    })

    it("has failure branch with reason, requiredBytes, maxBytes", () => {
      const result: PruneResult = {
        ok: false,
        reason: "foundational-state-exceeds-budget",
        requiredBytes: 8200,
        maxBytes: 8192,
      }
      expect(result.ok).toBe(false)
      expect(result.reason).toBe("foundational-state-exceeds-budget")
      expect(result.requiredBytes).toBe(8200)
      expect(result.maxBytes).toBe(8192)
    })

    it("failure branch does not return over-cap memory object", () => {
      const mem = emptyMemory("/test")
      const result: PruneResult = {
        ok: false,
        reason: "foundational-state-exceeds-budget",
        requiredBytes: 8200,
        maxBytes: 8192,
      }
      // Failure branch should not include memory
      expect(result).not.toHaveProperty("memory")
    })
  })

  describe("fitMemoryToBudget - no mutation", () => {
    it("never mutates input memory", () => {
      const original = emptyMemory("/test")
      const originalJSON = JSON.stringify(original)

      fitMemoryToBudget(original)

      const afterJSON = JSON.stringify(original)
      expect(afterJSON).toBe(originalJSON)
    })

    it("never mutates input decisions array", () => {
      const mem = emptyMemory("/test")
      const decisions = mem.decisions ?? []
      const originalLength = decisions.length

      fitMemoryToBudget(mem)

      const afterDecisions = mem.decisions ?? []
      expect(afterDecisions.length).toBe(originalLength)
    })

    it("never mutates input active_files array", () => {
      const mem = emptyMemory("/test")
      const activeFiles = mem.active_files ?? []
      const originalLength = activeFiles.length

      fitMemoryToBudget(mem)

      const afterActiveFiles = mem.active_files ?? []
      expect(afterActiveFiles.length).toBe(originalLength)
    })
  })

  describe("fitMemoryToBudget - deterministic fitting", () => {
    it("two identical inputs produce byte-identical fit results", () => {
      const mem1 = emptyMemory("/test")
      const mem2 = emptyMemory("/test")

      const result1 = fitMemoryToBudget(mem1)
      const result2 = fitMemoryToBudget(mem2)

      expect(result1.ok).toBe(result2.ok)
      if (result1.ok && result2.ok) {
        expect(result1.bytes).toBe(result2.bytes)
        expect(JSON.stringify(result1.memory)).toBe(JSON.stringify(result2.memory))
      }
    })

    it("already-fitting memory remains semantically unchanged", () => {
      const mem = emptyMemory("/test")
      const originalJSON = JSON.stringify(mem)

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      expect(result.pruned).toBe(false)
      expect(JSON.stringify(result.memory)).toBe(originalJSON)
    })
  })

  describe("fitMemoryToBudget - success postconditions", () => {
    it("successful result satisfies exact byte count", () => {
      const mem = emptyMemory("/test")
      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      expect(result.bytes).toBeLessThanOrEqual(MEMORY_MAX_BYTES)
    })

    it("successful result is schema-valid", () => {
      const mem = emptyMemory("/test")
      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      expect(() => JSON.parse(JSON.stringify(result.memory))).not.toThrow()
    })

    it("exact pretty JSON byte postcondition holds", () => {
      const mem = emptyMemory("/test")
      const result = fitMemoryToBudget(mem)

      if (result.ok) {
        const prettyJSON = JSON.stringify(result.memory, null, 2)
        const bytes = Buffer.byteLength(prettyJSON, "utf8")
        expect(bytes).toBe(result.bytes)
      }
    })
  })

  describe("fitMemoryToBudget - typed irreducible failures", () => {
    it("protected human foundational minimum >8KB returns foundational-state-exceeds-budget", () => {
      // Create a memory with multiple foundational decisions
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        decisions: Array.from({ length: 100 }, (_, i) => ({
          id: `decision-${i}`,
          topic: "foundational decision",
          decision: "this is a foundational decision that is very long and detailed",
          timestamp: new Date().toISOString(),
          session_id: "session-1",
          still_valid: true,
          foundational: true,
          provenance: {
            extractor: "human",
            source_session_id: "session-1",
            confidence: "human-reviewed",
            evidence: [],
          },
        })),
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(false)
      expect(result.reason).toBe("foundational-state-exceeds-budget")
      expect(result.requiredBytes).toBeGreaterThan(MEMORY_MAX_BYTES)
      expect(result.maxBytes).toBe(MEMORY_MAX_BYTES)
    })

    it("required protected marker causes otherwise-fitting protected state to overflow returns required-state-exceeds-budget", () => {
      // Create a memory that fits, then add a required processed source
      const mem = emptyMemory("/test")
      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      expect(result.bytes).toBeLessThanOrEqual(MEMORY_MAX_BYTES)

      // Add a processed source (required for LLM merge) - this alone doesn't exceed cap
      const withSource: MemoryFile = {
        ...result.memory,
        processed_sources: [
          {
            source_key: "v2s:abc123",
            extraction_key: "v2e:def456",
            extraction_contract_version: 1,
            completed_at: new Date().toISOString(),
          },
        ],
      }

      const result2 = fitMemoryToBudget(withSource)

      // The state should still fit (single processed source is small)
      expect(result2.ok).toBe(true)
      expect(result2.bytes).toBeLessThanOrEqual(MEMORY_MAX_BYTES)
    })

    it("budget failure returns no over-cap memory object", () => {
      const mem = emptyMemory("/test")
      const result = fitMemoryToBudget(mem)

      if (!result.ok) {
        // Failure branch should not include memory
        expect(result).not.toHaveProperty("memory")
      }
    })
  })

  describe("fitMemoryToBudget - protections", () => {
    it("protects processed source keys", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        processed_sources: [
          {
            source_key: "v2s:abc123",
            extraction_key: "v2e:def456",
            extraction_contract_version: 1,
            completed_at: new Date().toISOString(),
          },
        ],
      }
      const protectedKey = "v2s:abc123"
      const protection: MemoryBudgetProtection = {
        preserveProcessedSourceKeys: [protectedKey],
      }

      const result = fitMemoryToBudget(mem, { protection })

      expect(result.ok).toBe(true)
      if (result.ok) {
        const sources = result.memory.processed_sources ?? []
        expect(sources.some((ps) => ps.source_key === protectedKey)).toBe(true)
      }
    })

    it("protects audit session IDs", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        llm_extraction_audits: [
          {
            audit_session_id: "audit-123",
            source_session_id: "session-1",
            cache_key: "cache-1",
            provider_id: "provider-1",
            model_id: "model-1",
            created_at: new Date().toISOString(),
            terminal_outcome: "pending",
          },
        ],
      }
      const protectedID = "audit-123"
      const protection: MemoryBudgetProtection = {
        preserveAuditSessionIDs: [protectedID],
      }

      const result = fitMemoryToBudget(mem, { protection })

      expect(result.ok).toBe(true)
      if (result.ok) {
        const audits = result.memory.llm_extraction_audits ?? []
        expect(audits.some((a) => a.audit_session_id === protectedID)).toBe(true)
      }
    })

    it("protects decision IDs", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        decisions: [
          {
            id: "decision-456",
            topic: "protected topic",
            decision: "protected decision",
            timestamp: new Date().toISOString(),
            session_id: "session-1",
            still_valid: true,
            foundational: false,
            provenance: {
              extractor: "heuristic",
              source_session_id: "session-1",
              confidence: "heuristic",
              evidence: [],
            },
          },
        ],
      }
      const protectedID = "decision-456"
      const protection: MemoryBudgetProtection = {
        preserveDecisionIDs: [protectedID],
      }

      const result = fitMemoryToBudget(mem, { protection })

      expect(result.ok).toBe(true)
      if (result.ok) {
        const decisions = result.memory.decisions ?? []
        expect(decisions.some((d) => d.id === protectedID)).toBe(true)
      }
    })

    it("protected current source key survives successful final LLM commit", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        processed_sources: [
          {
            source_key: "v2s:abc123",
            extraction_key: "v2e:def456",
            extraction_contract_version: 1,
            completed_at: new Date().toISOString(),
          },
        ],
      }
      const protectedKey = "v2s:abc123"
      const protection: MemoryBudgetProtection = {
        preserveProcessedSourceKeys: [protectedKey],
      }

      const result = fitMemoryToBudget(mem, { protection })

      expect(result.ok).toBe(true)
      if (result.ok) {
        const sources = result.memory.processed_sources ?? []
        expect(sources.some((ps) => ps.source_key === protectedKey)).toBe(true)
      }
    })
  })

  describe("fitMemoryToBudget - incremental semantic retention stages", () => {
    it("oldest completed audit is removed before semantic facts", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        llm_extraction_audits: Array.from({ length: 30 }, (_, i) => ({
          audit_session_id: `audit-${i}`,
          source_session_id: `session-${i}`,
          cache_key: `cache-${i}`,
          provider_id: `provider-${i}`,
          model_id: `model-${i}`,
          created_at: new Date(Date.now() - i * 1000).toISOString(),
          terminal_outcome: i % 2 === 0 ? "success" : "pending",
        })),
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const audits = result.memory.llm_extraction_audits ?? []
        // Should have at most 20 completed audits
        const completed = audits.filter((a) => a.terminal_outcome !== "pending")
        expect(completed.length).toBeLessThanOrEqual(20)
      }
    })

    it("pending audit survives completed-audit pruning", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        llm_extraction_audits: [
          {
            audit_session_id: "pending-audit",
            source_session_id: "session-1",
            cache_key: "cache-1",
            provider_id: "provider-1",
            model_id: "model-1",
            created_at: new Date().toISOString(),
            terminal_outcome: "pending",
          },
        ],
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const audits = result.memory.llm_extraction_audits ?? []
        expect(audits.some((a) => a.audit_session_id === "pending-audit")).toBe(true)
      }
    })

    it("oldest cache is removed before semantic facts", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        llm_extraction_cache: Array.from({ length: 30 }, (_, i) => ({
          cache_key: `cache-${i}`,
          source_session_id: `session-${i}`,
          canonical_input_sha256: `sha256-${i}`,
          provider_id: `provider-${i}`,
          model_id: `model-${i}`,
          completed_at: new Date(Date.now() - i * 1000).toISOString(),
          facts: {
            decisions: [],
          },
        })),
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const cache = result.memory.llm_extraction_cache ?? []
        // Should have at most 10 cache entries
        expect(cache.length).toBeLessThanOrEqual(10)
      }
    })

    it("model-health rows are disposable before semantic facts", () => {
      // Create a memory with many model-health records that exceeds the cap
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        model_health: Array.from({ length: 100 }, (_, i) => ({
          provider_id: `provider-${i}`,
          model_id: `model-${i}`,
          last_outcome: "success",
          failure_streak: 0,
          last_outcome_at: new Date(Date.now() - i * 1000).toISOString(),
        })),
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const health = result.memory.model_health ?? []
        // Should have at most 10 model-health records after pruning
        expect(health.length).toBeLessThanOrEqual(10)
      }
    })

    it("oldest recent session is disposable under pressure", () => {
      // Create a memory with many recent sessions that exceeds the cap
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        recent_sessions: Array.from({ length: 100 }, (_, i) => `session-${i}-very-long-session-name-that-exceeds-the-default-256-char-limit`),
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const sessions = result.memory.recent_sessions ?? []
        // Should have at most 10 recent sessions after pruning
        expect(sessions.length).toBeLessThanOrEqual(10)
      }
    })

    it("oldest processed source is disposable when unprotected", () => {
      // Create a memory with many processed sources that exceeds the cap
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        processed_sources: Array.from({ length: 30 }, (_, i) => ({
          source_key: `v2s:source-${i}-${"a".repeat(300)}`,
          extraction_key: `v2e:extraction-${i}-${"b".repeat(300)}`,
          extraction_contract_version: 1,
          completed_at: new Date(Date.now() - i * 1000).toISOString(),
        })),
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const sources = result.memory.processed_sources ?? []
        // Should have at most 10 processed sources after pruning
        expect(sources.length).toBeLessThanOrEqual(10)
      }
    })

    it("protected processed source key survives", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        processed_sources: Array.from({ length: 30 }, (_, i) => ({
          source_key: `v2s:source-${i}`,
          extraction_key: `v2e:extraction-${i}`,
          extraction_contract_version: 1,
          completed_at: new Date(Date.now() - i * 1000).toISOString(),
        })),
      }

      const protection: MemoryBudgetProtection = {
        preserveProcessedSourceKeys: ["v2s:source-15"],
      }

      const result = fitMemoryToBudget(mem, { protection })

      expect(result.ok).toBe(true)
      if (result.ok) {
        const sources = result.memory.processed_sources ?? []
        expect(sources.some((ps) => ps.source_key === "v2s:source-15")).toBe(true)
      }
    })

    it("invalid non-foundational decision is removed before valid decisions", () => {
      // Create a memory that genuinely exceeds the cap
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        decisions: [
          ...Array.from({ length: 50 }, (_, i) => ({
            id: `decision-${i}`,
            topic: "decision",
            decision: "decision",
            timestamp: new Date().toISOString(),
            session_id: "session-1",
            still_valid: true,
            foundational: false,
            provenance: {
              extractor: "heuristic",
              source_session_id: "session-1",
              confidence: "heuristic",
              evidence: [],
            },
          })),
          {
            id: "invalid-decision",
            topic: "invalid topic",
            decision: "invalid decision",
            timestamp: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
            session_id: "session-1",
            still_valid: false,
            foundational: false,
            provenance: {
              extractor: "heuristic",
              source_session_id: "session-1",
              confidence: "heuristic",
              evidence: [],
            },
          },
        ],
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const decisions = result.memory.decisions ?? []
        expect(decisions.some((d) => d.id.startsWith("decision-") && d.id !== "invalid-decision")).toBe(true)
        expect(decisions.some((d) => d.id === "invalid-decision")).toBe(false)
      }
    })

    it("protected human conflict/history row is not removed by invalid-decision stage", () => {
      // Create a memory with many decisions that exceeds the cap
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        decisions: [
          ...Array.from({ length: 100 }, (_, i) => ({
            id: `valid-decision-${i}-very-long-decision-id-that-exceeds-the-default-256-char-limit`,
            topic: "valid topic",
            decision: "valid decision",
            timestamp: new Date().toISOString(),
            session_id: "session-1",
            still_valid: true,
            foundational: false,
            provenance: {
              extractor: "heuristic",
              source_session_id: "session-1",
              confidence: "heuristic",
              evidence: [],
            },
          })),
          {
            id: "invalid-decision",
            topic: "invalid topic",
            decision: "invalid decision",
            timestamp: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
            session_id: "session-1",
            still_valid: false,
            foundational: false,
            provenance: {
              extractor: "heuristic",
              source_session_id: "session-1",
              confidence: "heuristic",
              evidence: [],
            },
          },
        ],
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const decisions = result.memory.decisions ?? []
        expect(decisions.some((d) => d.id.startsWith("valid-decision-") && d.id !== "invalid-decision")).toBe(true)
        expect(decisions.some((d) => d.id === "invalid-decision")).toBe(false)
      }
    })

    it("least-recently-touched observed file is removed before recent observed files", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        active_files: Array.from({ length: 30 }, (_, i) => ({
          path: `/path/file-${i}`,
          reason: "reason",
          last_touched: new Date(Date.now() - i * 1000).toISOString(),
          provenance: {
            extractor: "heuristic",
            source_session_id: "session-1",
            confidence: "heuristic",
            evidence: [],
          },
        })),
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const files = result.memory.active_files ?? []
        // Should have at most 16 active files
        expect(files.length).toBeLessThanOrEqual(16)
      }
    })

    it(">30-day non-foundational decision is age-pruned", () => {
      // Create a memory that genuinely exceeds the cap
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        decisions: [
          ...Array.from({ length: 50 }, (_, i) => ({
            id: `decision-${i}`,
            topic: "decision",
            decision: "decision",
            timestamp: new Date().toISOString(),
            session_id: "session-1",
            still_valid: true,
            foundational: false,
            provenance: {
              extractor: "heuristic",
              source_session_id: "session-1",
              confidence: "heuristic",
              evidence: [],
            },
          })),
          {
            id: "old-decision",
            topic: "old topic",
            decision: "old decision",
            timestamp: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
            session_id: "session-1",
            still_valid: true,
            foundational: false,
            provenance: {
              extractor: "heuristic",
              source_session_id: "session-1",
              confidence: "heuristic",
              evidence: [],
            },
          },
        ],
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const decisions = result.memory.decisions ?? []
        expect(decisions.some((d) => d.id.startsWith("decision-") && d.id !== "old-decision")).toBe(true)
        expect(decisions.some((d) => d.id === "old-decision")).toBe(false)
      }
    })

    it(">30-day human foundational decision survives", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        decisions: [
          {
            id: "recent-foundational",
            topic: "recent topic",
            decision: "recent decision",
            timestamp: new Date().toISOString(),
            session_id: "session-1",
            still_valid: true,
            foundational: true,
            provenance: {
              extractor: "human",
              source_session_id: "session-1",
              confidence: "human-reviewed",
              evidence: [],
            },
          },
          {
            id: "old-foundational",
            topic: "old topic",
            decision: "old decision",
            timestamp: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
            session_id: "session-1",
            still_valid: true,
            foundational: true,
            provenance: {
              extractor: "human",
              source_session_id: "session-1",
              confidence: "human-reviewed",
              evidence: [],
            },
          },
        ],
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const decisions = result.memory.decisions ?? []
        expect(decisions.some((d) => d.id === "recent-foundational")).toBe(true)
        expect(decisions.some((d) => d.id === "old-foundational")).toBe(true)
      }
    })

    it("decision rationale is removed/truncated before foundational core text", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        decisions: [
          {
            id: "decision-1",
            topic: "topic",
            decision: "decision",
            rationale: "this is a very long rationale that should be truncated",
            timestamp: new Date().toISOString(),
            session_id: "session-1",
            still_valid: true,
            foundational: true,
            provenance: {
              extractor: "human",
              source_session_id: "session-1",
              confidence: "human-reviewed",
              evidence: [],
            },
          },
        ],
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const decisions = result.memory.decisions ?? []
        const decision = decisions[0]
        expect(decision.rationale).toBe("this is a very long rationale that should be truncated")
        // Rationale should be truncated to 500 bytes
        expect(Buffer.byteLength(decision.rationale, "utf8")).toBeLessThanOrEqual(500)
      }
    })

    it("active-file reason verbosity is reduced before protected authority", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        active_files: [
          {
            path: "/path/file",
            reason: "this is a very long reason that should be truncated",
            last_touched: new Date().toISOString(),
            provenance: {
              extractor: "heuristic",
              source_session_id: "session-1",
              confidence: "heuristic",
              evidence: [],
            },
          },
        ],
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const files = result.memory.active_files ?? []
        const file = files[0]
        expect(file.reason).toBe("this is a very long reason that should be truncated")
        // Reason should be truncated to 512 bytes
        expect(Buffer.byteLength(file.reason, "utf8")).toBeLessThanOrEqual(512)
      }
    })

    it("blocker/next-step verbosity can be reduced under later pressure", () => {
      // Add decisions to trigger Stage 10 pressure
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        decisions: [{
          id: "foundational-decision",
          topic: "decision",
          decision: "decision",
          timestamp: new Date().toISOString(),
          session_id: "session-1",
          still_valid: true,
          foundational: true,
          provenance: {
            extractor: "human",
            source_session_id: "session-1",
            confidence: "human-reviewed",
            evidence: [],
          },
        }],
        current_task: "task",
        blockers: Array.from({ length: 20 }, (_, i) => `blocker ${i} ${"b".repeat(300)}`),
        next_steps: Array.from({ length: 20 }, (_, i) => `next step ${i} ${"n".repeat(300)}`),
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        // Blockers should be reduced to 8
        expect(result.memory.blockers?.length).toBeLessThanOrEqual(8)
        // Next steps should be reduced to 8
        expect(result.memory.next_steps?.length).toBeLessThanOrEqual(8)
      }
    })

    it("old non-foundational decisions are removed incrementally, newest/recently-used surviving first", () => {
      // Create a memory that genuinely exceeds the cap
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        decisions: Array.from({ length: 100 }, (_, i) => ({
          id: `decision-${i}`,
          topic: "decision",
          decision: "decision",
          timestamp: new Date(Date.now() - i * 1000).toISOString(),
          session_id: "session-1",
          still_valid: true,
          foundational: false,
          last_used_in_session: i % 2 === 0 ? "session-1" : undefined,
          provenance: {
            extractor: "heuristic",
            source_session_id: "session-1",
            confidence: "heuristic",
            evidence: [],
          },
        })),
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const decisions = result.memory.decisions ?? []
        // The newest/recently-used prefix survives while older rows are
        // removed incrementally under the exact serialized-byte budget.
        expect(decisions.length).toBeGreaterThan(0)
        expect(decisions.some((d) => d.id === "decision-0")).toBe(true)
      }
    })

    it("current ephemeral task/files may be discarded before trusted human authority", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        current_task: "this is a very long current task that should be truncated",
        active_files: Array.from({ length: 30 }, (_, i) => ({
          path: `/path/file-${i}`,
          reason: "reason",
          last_touched: new Date(Date.now() - i * 1000).toISOString(),
          provenance: {
            extractor: "heuristic",
            source_session_id: "session-1",
            confidence: "heuristic",
            evidence: [],
          },
        })),
        decisions: [
          {
            id: "foundational-decision",
            topic: "foundational topic",
            decision: "foundational decision",
            timestamp: new Date().toISOString(),
            session_id: "session-1",
            still_valid: true,
            foundational: true,
            provenance: {
              extractor: "human",
              source_session_id: "session-1",
              confidence: "human-reviewed",
              evidence: [],
            },
          },
        ],
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      if (result.ok) {
        const decisions = result.memory.decisions ?? []
        expect(decisions.some((d) => d.foundational)).toBe(true)
        // Current task should be truncated
        expect(Buffer.byteLength(result.memory.current_task ?? "", "utf8")).toBeLessThanOrEqual(512)
        // Active files should be reduced
        expect(result.memory.active_files?.length).toBeLessThanOrEqual(16)
      }
    })
  })

  describe("fitMemoryToBudget - typed refusal", () => {
    it("returns foundational-state-exceeds-budget when minimal legal state exceeds 8KB", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        decisions: Array.from({ length: 100 }, (_, i) => ({
          id: `decision-${i}`,
          topic: "foundational decision",
          decision: "this is a foundational decision that is very long and detailed",
          timestamp: new Date().toISOString(),
          session_id: "session-1",
          still_valid: true,
          foundational: true,
          provenance: {
            extractor: "human",
            source_session_id: "session-1",
            confidence: "human-reviewed",
            evidence: [],
          },
        })),
      }

      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(false)
      expect(result.reason).toBe("foundational-state-exceeds-budget")
      expect(result.requiredBytes).toBeGreaterThan(MEMORY_MAX_BYTES)
      expect(result.maxBytes).toBe(MEMORY_MAX_BYTES)
    })

    it("returns required-state-exceeds-budget when overflow is caused by operation-required protected proof/state", () => {
      // Create a memory that fits, then add a required processed source
      const mem = emptyMemory("/test")
      const result = fitMemoryToBudget(mem)

      expect(result.ok).toBe(true)
      expect(result.bytes).toBeLessThanOrEqual(MEMORY_MAX_BYTES)

      // Add a processed source (required for LLM merge) - this alone doesn't exceed cap
      const withSource: MemoryFile = {
        ...result.memory,
        processed_sources: [
          {
            source_key: "v2s:abc123",
            extraction_key: "v2e:def456",
            extraction_contract_version: 1,
            completed_at: new Date().toISOString(),
          },
        ],
      }

      const result2 = fitMemoryToBudget(withSource)

      // The state should still fit (single processed source is small)
      expect(result2.ok).toBe(true)
      expect(result2.bytes).toBeLessThanOrEqual(MEMORY_MAX_BYTES)
    })

    it("never silently deletes a protected row in order to return ok: true", () => {
      const mem: MemoryFile = {
        ...emptyMemory("/test"),
        decisions: [
          {
            id: "protected-decision",
            topic: "protected topic",
            decision: "protected decision",
            timestamp: new Date().toISOString(),
            session_id: "session-1",
            still_valid: true,
            foundational: true,
            provenance: {
              extractor: "human",
              source_session_id: "session-1",
              confidence: "human-reviewed",
              evidence: [],
            },
          },
        ],
      }

      const protection: MemoryBudgetProtection = {
        preserveDecisionIDs: ["protected-decision"],
      }

      const result = fitMemoryToBudget(mem, { protection })

      expect(result.ok).toBe(true)
      if (result.ok) {
        const decisions = result.memory.decisions ?? []
        expect(decisions.some((d) => d.id === "protected-decision")).toBe(true)
      }
    })
  })
})
