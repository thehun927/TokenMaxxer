/**
 * PR-9 Wave 1 Agent 1B — compaction prompt/result diagnostic contracts.
 *
 * Freezes the contracts from docs/CRIP/PR-9/implementation-plan.md §11
 * (Wave 1 Agent 1B) and the release-matrix cases B (prompt snapshot
 * truthfulness/bounds) and C (post-compaction result semantics):
 *
 *  - the prompt artifact remains prompt-only: it records the exact
 *    TokenMaxxer-supplied compaction payload and never a host-generated
 *    compaction summary or a result artifact;
 *  - the whole prompt artifact is bounded to 96 KiB UTF-8 bytes
 *    (`COMPACTION_PROMPT_ARTIFACT_MAX_BYTES`), including header + payload +
 *    newlines, with UTF-8-safe truncation of the stored diagnostic payload
 *    only (never the payload sent to the host);
 *  - `session.compacted` completion persistence: the result artifact is
 *    created only on the successful host event, never on hook invocation
 *    alone;
 *  - the summary body is never persisted — only bytes + sha256 metadata;
 *  - the result JSON is bounded to 4096 UTF-8 bytes;
 *  - summary missing/unavailable still records completion;
 *  - diagnostic failures (prompt/result artifact write failure) never change
 *    the compaction hook output.
 *
 * These tests intentionally FAIL on current main because the PR-9 production
 * behavior does not exist yet (no `src/diagnostics/compaction.ts`, no
 * `session.compacted` handler, no result artifact, no 96 KiB bound). Wave 3
 * implements the production behavior and this suite goes green. No production
 * file is modified by this test.
 */

import { describe, expect, it } from "vitest"
import { Buffer } from "node:buffer"

// ─── Contract constants (must be exported by src/diagnostics/compaction.ts) ──

const COMPACTION_PROMPT_ARTIFACT_MAX_BYTES = 96 * 1024
const COMPACTION_RESULT_ARTIFACT_MAX_BYTES = 4096

// ─── Pure helpers under test (imported from src/diagnostics/compaction.ts) ──

// These imports intentionally fail to resolve on current main. Wave 3 adds
// the production module. The tests below pin the exact contract surface.
import {
  buildCompactionPromptArtifact,
  COMPACTION_PROMPT_ARTIFACT_MAX_BYTES as PROMPT_MAX,
  COMPACTION_RESULT_ARTIFACT_MAX_BYTES as RESULT_MAX,
  buildCompactionResultDiagnostic,
  validateCompactionResultDiagnostic,
} from "../../src/diagnostics/compaction"

describe("PR-9 Agent 1B — compaction prompt/result diagnostic contracts", () => {
  describe("B — prompt snapshot truthfulness/bounds", () => {
    it("exports COMPACTION_PROMPT_ARTIFACT_MAX_BYTES equal to 96 KiB", () => {
      expect(PROMPT_MAX).toBe(96 * 1024)
      expect(PROMPT_MAX).toBe(COMPACTION_PROMPT_ARTIFACT_MAX_BYTES)
    })

    it("prompt artifact is named prompt, never result", () => {
      const artifact = buildCompactionPromptArtifact({
        sessionID: "session-1",
        requestedMode: "augment",
        effectiveMode: "augment",
        payload: "augmentation payload",
      })
      expect(artifact.name).toBe("last_compaction_prompt.log")
      expect(artifact.name).not.toBe("last_compaction_result.json")
    })

    it("augment snapshot stores the actual augmentation payload", () => {
      const artifact = buildCompactionPromptArtifact({
        sessionID: "session-1",
        requestedMode: "augment",
        effectiveMode: "augment",
        payload: "actual augmentation payload text",
      })
      expect(artifact.content).toContain("actual augmentation payload text")
      expect(artifact.content).toContain("kind=context-augmentation")
      expect(artifact.content).toContain("effective_mode=augment")
    })

    it("replace snapshot stores the actual replacement prompt", () => {
      const artifact = buildCompactionPromptArtifact({
        sessionID: "session-1",
        requestedMode: "replace",
        effectiveMode: "replace",
        payload: "actual replacement prompt text",
      })
      expect(artifact.content).toContain("actual replacement prompt text")
      expect(artifact.content).toContain("kind=replacement-prompt")
      expect(artifact.content).toContain("effective_mode=replace")
    })

    it("history-unavailable fallback stores actual augmentation, not attempted replacement", () => {
      const artifact = buildCompactionPromptArtifact({
        sessionID: "session-1",
        requestedMode: "replace",
        effectiveMode: "augment",
        fallbackReason: "session.messages unavailable",
        payload: "fallback augmentation payload",
      })
      expect(artifact.content).toContain("fallback augmentation payload")
      expect(artifact.content).toContain("effective_mode=augment")
      expect(artifact.content).toContain("kind=context-augmentation")
      expect(artifact.content).toContain("fallback_reason=session.messages unavailable")
    })

    it("requested/effective mode recorded separately", () => {
      const artifact = buildCompactionPromptArtifact({
        sessionID: "session-1",
        requestedMode: "replace",
        effectiveMode: "augment",
        fallbackReason: "history unavailable",
        payload: "payload",
      })
      expect(artifact.content).toContain("requested_mode=replace")
      expect(artifact.content).toContain("effective_mode=augment")
    })

    it("uses real newlines, not literal backslash-n separators", () => {
      const artifact = buildCompactionPromptArtifact({
        sessionID: "session-1",
        requestedMode: "augment",
        effectiveMode: "augment",
        payload: "payload",
      })
      expect(artifact.content).toContain("\n")
      expect(artifact.content).not.toMatch(/\\n(session|requested_mode|effective_mode|kind|fallback_reason)=/)
    })

    it("records original payload bytes and stored payload bytes", () => {
      const payload = "café payload"
      const artifact = buildCompactionPromptArtifact({
        sessionID: "session-1",
        requestedMode: "augment",
        effectiveMode: "augment",
        payload,
      })
      expect(artifact.payloadBytes).toBe(Buffer.byteLength(payload, "utf8"))
      expect(artifact.payloadStoredBytes).toBe(Buffer.byteLength(payload, "utf8"))
      expect(artifact.payloadTruncated).toBe(false)
    })

    it("ordinary payload stores an unmodified diagnostic copy", () => {
      const payload = "ordinary payload with multibyte café and emoji 😀"
      const artifact = buildCompactionPromptArtifact({
        sessionID: "session-1",
        requestedMode: "augment",
        effectiveMode: "augment",
        payload,
      })
      expect(artifact.content).toContain(payload)
      expect(artifact.payloadTruncated).toBe(false)
    })

    it("whole prompt artifact is <= 96 KiB UTF-8 bytes", () => {
      const payload = "x".repeat(90 * 1024)
      const artifact = buildCompactionPromptArtifact({
        sessionID: "session-1",
        requestedMode: "replace",
        effectiveMode: "replace",
        payload,
      })
      expect(Buffer.byteLength(artifact.content, "utf8")).toBeLessThanOrEqual(PROMPT_MAX)
      expect(Buffer.byteLength(artifact.content, "utf8")).toBeLessThanOrEqual(COMPACTION_PROMPT_ARTIFACT_MAX_BYTES)
    })

    it("over-limit diagnostic is UTF-8 safely truncated", () => {
      const payload = "é".repeat(60 * 1024) // 2 bytes each -> 120 KiB
      const artifact = buildCompactionPromptArtifact({
        sessionID: "session-1",
        requestedMode: "replace",
        effectiveMode: "replace",
        payload,
      })
      expect(Buffer.byteLength(artifact.content, "utf8")).toBeLessThanOrEqual(PROMPT_MAX)
      // No malformed UTF-8 replacement character from a split code point
      expect(artifact.content).not.toContain("\ufffd")
      expect(artifact.payloadTruncated).toBe(true)
      // Original payload bytes retained even when stored copy is truncated
      expect(artifact.payloadBytes).toBe(Buffer.byteLength(payload, "utf8"))
      expect(artifact.payloadStoredBytes).toBeLessThan(artifact.payloadBytes)
    })

    it("truncated diagnostic says payload_truncated=true", () => {
      const payload = "z".repeat(100 * 1024)
      const artifact = buildCompactionPromptArtifact({
        sessionID: "session-1",
        requestedMode: "replace",
        effectiveMode: "replace",
        payload,
      })
      expect(artifact.payloadTruncated).toBe(true)
      expect(artifact.content).toContain("payload_truncated=true")
    })

    it("fallback reason is bounded", () => {
      const longReason = "R".repeat(2000)
      const artifact = buildCompactionPromptArtifact({
        sessionID: "session-1",
        requestedMode: "replace",
        effectiveMode: "augment",
        fallbackReason: longReason,
        payload: "payload",
      })
      const reasonLine = artifact.content.split("\n").find((l) => l.startsWith("fallback_reason="))
      expect(reasonLine).toBeDefined()
      expect(reasonLine!.length).toBeLessThanOrEqual(550) // 500 cap + truncation suffix
    })
  })

  describe("C — post-compaction result semantics", () => {
    it("exports COMPACTION_RESULT_ARTIFACT_MAX_BYTES equal to 4096", () => {
      expect(RESULT_MAX).toBe(4096)
      expect(RESULT_MAX).toBe(COMPACTION_RESULT_ARTIFACT_MAX_BYTES)
    })

    it("result JSON has runtime-valid v1 schema", () => {
      const result = buildCompactionResultDiagnostic({
        completedAt: "2026-08-12T00:00:00.000Z",
        sessionID: "session-1",
        summary: { status: "found", bytes: 1024, sha256: "a".repeat(64) },
      })
      const parsed = validateCompactionResultDiagnostic(result.json)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.value.version).toBe(1)
        expect(parsed.value.host_event).toBe("session.compacted")
        expect(parsed.value.session_id).toBe("session-1")
      }
    })

    it("result artifact is named result, never prompt", () => {
      const result = buildCompactionResultDiagnostic({
        completedAt: "2026-08-12T00:00:00.000Z",
        sessionID: "session-1",
        summary: { status: "missing" },
      })
      expect(result.name).toBe("last_compaction_result.json")
      expect(result.name).not.toBe("last_compaction_prompt.log")
    })

    it("result artifact <= 4096 bytes", () => {
      const result = buildCompactionResultDiagnostic({
        completedAt: "2026-08-12T00:00:00.000Z",
        sessionID: "s".repeat(256),
        summary: { status: "unavailable", reason: "R".repeat(500) },
      })
      expect(Buffer.byteLength(result.json, "utf8")).toBeLessThanOrEqual(RESULT_MAX)
      expect(Buffer.byteLength(result.json, "utf8")).toBeLessThanOrEqual(COMPACTION_RESULT_ARTIFACT_MAX_BYTES)
    })

    it("summary found -> exact UTF-8 byte count recorded", () => {
      const summaryBody = "café summary body"
      const result = buildCompactionResultDiagnostic({
        completedAt: "2026-08-12T00:00:00.000Z",
        sessionID: "session-1",
        summary: {
          status: "found",
          bytes: Buffer.byteLength(summaryBody, "utf8"),
          sha256: "b".repeat(64),
        },
      })
      const parsed = validateCompactionResultDiagnostic(result.json)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.value.summary.status).toBe("found")
        expect(parsed.value.summary.bytes).toBe(Buffer.byteLength(summaryBody, "utf8"))
      }
    })

    it("summary found -> deterministic SHA-256 recorded", () => {
      const sha = "c".repeat(64)
      const result = buildCompactionResultDiagnostic({
        completedAt: "2026-08-12T00:00:00.000Z",
        sessionID: "session-1",
        summary: { status: "found", bytes: 10, sha256: sha },
      })
      const parsed = validateCompactionResultDiagnostic(result.json)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.value.summary.sha256).toBe(sha)
        expect(parsed.value.summary.sha256).toMatch(/^[0-9a-f]{64}$/)
      }
    })

    it("summary body is absent from JSON", () => {
      const summaryBody = "SECRET SUMMARY BODY THAT MUST NEVER BE PERSISTED"
      const result = buildCompactionResultDiagnostic({
        completedAt: "2026-08-12T00:00:00.000Z",
        sessionID: "session-1",
        summary: {
          status: "found",
          bytes: Buffer.byteLength(summaryBody, "utf8"),
          sha256: "d".repeat(64),
        },
      })
      expect(result.json).not.toContain(summaryBody)
      expect(result.json).not.toContain("SECRET SUMMARY BODY")
      // The JSON must not contain a body/text/content field at all
      expect(result.json).not.toMatch(/"body"/)
      expect(result.json).not.toMatch(/"text"/)
      expect(result.json).not.toMatch(/"content"/)
    })

    it("no summary after successful event -> summary.status=missing", () => {
      const result = buildCompactionResultDiagnostic({
        completedAt: "2026-08-12T00:00:00.000Z",
        sessionID: "session-1",
        summary: { status: "missing" },
      })
      const parsed = validateCompactionResultDiagnostic(result.json)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.value.summary.status).toBe("missing")
      }
    })

    it("session.messages unavailable -> completion still recorded with summary.status=unavailable", () => {
      const result = buildCompactionResultDiagnostic({
        completedAt: "2026-08-12T00:00:00.000Z",
        sessionID: "session-1",
        summary: { status: "unavailable", reason: "session.messages unavailable" },
      })
      const parsed = validateCompactionResultDiagnostic(result.json)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.value.summary.status).toBe("unavailable")
        expect(parsed.value.summary.reason).toBe("session.messages unavailable")
        // Completion is still recorded even though summary retrieval failed
        expect(parsed.value.host_event).toBe("session.compacted")
        expect(parsed.value.session_id).toBe("session-1")
      }
    })

    it("thrown history read -> bounded unavailable reason", () => {
      const longReason = "E".repeat(2000)
      const result = buildCompactionResultDiagnostic({
        completedAt: "2026-08-12T00:00:00.000Z",
        sessionID: "session-1",
        summary: { status: "unavailable", reason: longReason },
      })
      const parsed = validateCompactionResultDiagnostic(result.json)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.value.summary.status).toBe("unavailable")
        expect(parsed.value.summary.reason.length).toBeLessThanOrEqual(500)
      }
    })

    it("session_id is bounded to 256 chars", () => {
      const result = buildCompactionResultDiagnostic({
        completedAt: "2026-08-12T00:00:00.000Z",
        sessionID: "s".repeat(300),
        summary: { status: "missing" },
      })
      const parsed = validateCompactionResultDiagnostic(result.json)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.value.session_id.length).toBeLessThanOrEqual(256)
      }
    })
  })

  describe("B3 — read-side validator is authoritative for persisted bounds", () => {
    const completedAt = "2026-08-12T00:00:00.000Z"
    const validSha = "a".repeat(64)

    // Corrupt artifacts bypass the builder entirely (they model manually
    // damaged / legacy / externally modified persisted JSON) and are fed
    // straight to the runtime validator.
    function rawResult(overrides: Record<string, unknown>): string {
      return JSON.stringify({
        version: 1,
        completed_at: completedAt,
        session_id: "session-1",
        host_event: "session.compacted",
        summary: { status: "missing" },
        ...overrides,
      })
    }

    it("rejects raw result JSON larger than 4096 UTF-8 bytes before/while parse", () => {
      // Structurally valid but oversized whole JSON (padding field keeps the
      // schema valid so only the raw-size bound can reject it).
      const blob = JSON.stringify({
        version: 1,
        completed_at: completedAt,
        session_id: "session-1",
        host_event: "session.compacted",
        summary: { status: "missing" },
        padding: "x".repeat(5000),
      })
      expect(Buffer.byteLength(blob, "utf8")).toBeGreaterThan(RESULT_MAX)
      const parsed = validateCompactionResultDiagnostic(blob)
      expect(parsed.ok).toBe(false)
    })

    it("rejects session_id longer than 256 chars", () => {
      const parsed = validateCompactionResultDiagnostic(
        rawResult({ session_id: "s".repeat(257) }),
      )
      expect(parsed.ok).toBe(false)
    })

    it("rejects unavailable reason longer than 500 chars", () => {
      const parsed = validateCompactionResultDiagnostic(
        rawResult({ summary: { status: "unavailable", reason: "R".repeat(501) } }),
      )
      expect(parsed.ok).toBe(false)
    })

    it("rejects negative summary.bytes", () => {
      const parsed = validateCompactionResultDiagnostic(
        rawResult({ summary: { status: "found", bytes: -1, sha256: validSha } }),
      )
      expect(parsed.ok).toBe(false)
    })

    it("rejects fractional summary.bytes", () => {
      const parsed = validateCompactionResultDiagnostic(
        rawResult({ summary: { status: "found", bytes: 1.5, sha256: validSha } }),
      )
      expect(parsed.ok).toBe(false)
    })

    it("rejects unsafe summary.bytes beyond MAX_SAFE_INTEGER", () => {
      const parsed = validateCompactionResultDiagnostic(
        rawResult({
          summary: { status: "found", bytes: Number.MAX_SAFE_INTEGER + 1, sha256: validSha },
        }),
      )
      expect(parsed.ok).toBe(false)
    })

    it("rejects non-finite summary.bytes (Infinity via 1e999)", () => {
      // JSON.parse("1e999") -> Infinity, which is not a finite number.
      const blob =
        '{"version":1,"completed_at":"2026-08-12T00:00:00.000Z","session_id":"session-1","host_event":"session.compacted",' +
        `"summary":{"status":"found","bytes":1e999,"sha256":"${validSha}"}}`
      const parsed = validateCompactionResultDiagnostic(blob)
      expect(parsed.ok).toBe(false)
    })

    it("rejects malformed completed_at timestamps", () => {
      const malformed = [
        "not-a-timestamp",
        "2026-08-12",
        "2026-08-12T00:00:00",
        "2026-08-12T00:00:00.000",
        "2026-02-30T00:00:00.000Z", // impossible calendar day
        "2026-13-45T99:99:99.000Z", // impossible month/time
        "",
      ]
      for (const completedAtValue of malformed) {
        const parsed = validateCompactionResultDiagnostic(
          rawResult({ completed_at: completedAtValue }),
        )
        expect(parsed.ok).toBe(false)
      }
    })

    it("keeps exact 64-lowercase-hex sha256 validation", () => {
      const badShaValues = [
        "A".repeat(64), // uppercase is not allowed
        "a".repeat(63), // too short
        "a".repeat(65), // too long
        "g".repeat(64), // not hex
        "a".repeat(64).toUpperCase(),
      ]
      for (const sha256 of badShaValues) {
        const parsed = validateCompactionResultDiagnostic(
          rawResult({ summary: { status: "found", bytes: 10, sha256 } }),
        )
        expect(parsed.ok).toBe(false)
      }
      // The valid lowercase 64-hex form is still accepted.
      const parsed = validateCompactionResultDiagnostic(
        rawResult({ summary: { status: "found", bytes: 10, sha256: validSha } }),
      )
      expect(parsed.ok).toBe(true)
    })

    it("invalid artifact returns ok:false without throwing (status maps to unavailable)", () => {
      const hostileInputs = [
        "{ not valid json",
        "",
        "null",
        "42",
        '{"version":1}',
        JSON.stringify({
          version: 1,
          completed_at: completedAt,
          session_id: "s".repeat(4096), // also oversized whole JSON
          host_event: "session.compacted",
          summary: { status: "missing" },
        }),
      ]
      for (const hostile of hostileInputs) {
        let result
        expect(() => {
          result = validateCompactionResultDiagnostic(hostile)
        }).not.toThrow()
        expect(result!.ok).toBe(false)
      }
    })

    it("valid builder output still validates across all summary statuses", () => {
      const cases: Array<{ completedAt: string; sessionID: string; summary: CompactionResultSummary }> = [
        { completedAt, sessionID: "session-1", summary: { status: "missing" } },
        { completedAt, sessionID: "session-1", summary: { status: "unavailable", reason: "history unavailable" } },
        { completedAt, sessionID: "session-1", summary: { status: "found", bytes: 1024, sha256: validSha } },
        // Boundary-sized session/reason must still validate after builder bounding.
        { completedAt, sessionID: "s".repeat(256), summary: { status: "missing" } },
        { completedAt, sessionID: "session-1", summary: { status: "unavailable", reason: "R".repeat(500) } },
      ]
      for (const input of cases) {
        const artifact = buildCompactionResultDiagnostic(input)
        expect(Buffer.byteLength(artifact.json, "utf8")).toBeLessThanOrEqual(RESULT_MAX)
        const parsed = validateCompactionResultDiagnostic(artifact.json)
        expect(parsed.ok).toBe(true)
      }
    })

    it("valid ISO timestamps with numeric UTC offsets are accepted", () => {
      const parsed = validateCompactionResultDiagnostic(
        rawResult({ completed_at: "2026-08-12T00:00:00.000+02:00" }),
      )
      expect(parsed.ok).toBe(true)
    })
  })
})
