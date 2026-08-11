import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import {
  ExtractedFactsJsonSchema,
  ExtractedFactsSchema,
  validateStructuredResult,
} from "../../src/memory/extract-schema"
import * as extractSchema from "../../src/memory/extract-schema"
import {
  buildCanonicalInput,
  buildTranscriptEvidenceCandidateMap,
  buildTranscriptEvidenceCandidates,
  buildTranscriptEvidenceRefDigestMap,
  buildExtractionPrompt,
  compressTranscript,
  digestTranscriptEvidenceCandidate,
  makeTranscriptEvidenceRef,
  makeExtractionCacheKeyLegacy,
  serializeCanonicalInput,
  stableJson,
} from "../../src/memory/extract-prompt"
import { emptyMemory } from "../../src/memory/schema"
import type { TranscriptMessage } from "../../src/types"
import * as prompt from "../../src/memory/extract-prompt"

const validFacts = {
  current_task: "Build the API",
  active_files: [{ path: "src/api.ts", reason: "edited" }],
  decisions: [{ topic: "database", decision: "Use Postgres", evidence_refs: ["tr-evidence"] }],
  blockers: [],
  next_steps: ["Add tests"],
}

function textMessage(id: string, text: string, role = "user"): TranscriptMessage {
  return {
    info: { id, role },
    parts: [{ type: "text", text }],
  }
}

describe("LLM extraction schema", () => {
  it("accepts the existing ExtractedFacts shape", () => {
    expect(ExtractedFactsSchema.safeParse(validFacts).success).toBe(true)
    expect(validateStructuredResult(validFacts)).toEqual(validFacts)
    expect(ExtractedFactsJsonSchema.required).toEqual([
      "current_task",
      "active_files",
      "decisions",
      "blockers",
      "next_steps",
    ])
  })

  it("rejects malformed fields and unknown output fields", () => {
    expect(
      ExtractedFactsSchema.safeParse({ ...validFacts, current_task: 42 }).success,
    ).toBe(false)
    expect(
      ExtractedFactsSchema.safeParse({
        ...validFacts,
        active_files: [{ path: "src/api.ts" }],
      }).success,
    ).toBe(false)
    expect(
      ExtractedFactsSchema.safeParse({
        ...validFacts,
        active_files: ["src/api.ts"],
      }).success,
    ).toBe(false)
    expect(
      ExtractedFactsSchema.safeParse({
        ...validFacts,
        decisions: [{ topic: "database", decision: "Use Postgres" }],
      }).success,
    ).toBe(false)
    expect(
      ExtractedFactsSchema.safeParse({
        ...validFacts,
        decisions: [{ topic: "database", decision: "Use Postgres", evidence_refs: [] }],
      }).success,
    ).toBe(false)
    expect(
      ExtractedFactsSchema.safeParse({
        ...validFacts,
        decisions: [{
          topic: "database",
          decision: "Use Postgres",
          evidence_refs: ["a", "b", "c", "d"],
        }],
      }).success,
    ).toBe(false)
    expect(
      ExtractedFactsSchema.safeParse({
        ...validFacts,
        decisions: [{
          topic: "database",
          decision: "Use Postgres",
          evidence_refs: ["a", "a"],
        }],
      }).success,
    ).toBe(false)
    expect(
      ExtractedFactsSchema.safeParse({ ...validFacts, assistant_text: "{}" }).success,
    ).toBe(false)
    expect(validateStructuredResult({ ...validFacts, next_steps: Array(6).fill("step") })).toBeNull()
  })

  it("publishes the required bounded evidence JSON Schema contract", () => {
    const decisionSchema = ExtractedFactsJsonSchema.properties.decisions.items
    expect(decisionSchema.properties.evidence_refs).toEqual({
      type: "array",
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 128 },
    })
    expect(decisionSchema.required).toContain("evidence_refs")
  })
})

describe("canonical extraction input", () => {
  it("caps transcript/prior state and normalizes, sorts, and caps candidates", () => {
    const messages: TranscriptMessage[] = Array.from({ length: 25 }, (_, index) => ({
      ...textMessage(`m-${index}`, `message-${index}-${"x".repeat(600)}`),
      parts: [
        { type: "text", text: `message-${index}-${"x".repeat(600)}` },
        ...(index === 24
          ? [{ type: "tool" as const, tool: "read", state: { input: { filePath: "./src/last.ts" }, output: "ignored" } }]
          : []),
      ],
    }))

    for (let index = 0; index < 25; index++) {
      messages.push({
        info: { id: `tool-${index}`, role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "read",
            state: { input: { filePath: `./src/file-${String(index).padStart(2, "0")}.ts` } },
          },
        ],
      })
    }

    const prior = {
      ...emptyMemory("/worktree"),
      current_task: "p".repeat(10_000),
      llm_extraction_cache: [{ cache_key: "must-not-affect-input" }],
    }
    const withCache = buildCanonicalInput(messages, prior)
    const withoutCache = buildCanonicalInput(messages, { ...prior, llm_extraction_cache: undefined })
    const withAuditAndCache = buildCanonicalInput(messages, {
      ...prior,
      llm_extraction_audits: [{
        audit_session_id: "audit-operational",
        source_session_id: "source-operational",
        cache_key: "source:sha256:provider/model",
        provider_id: "provider",
        model_id: "model",
        created_at: "2026-01-01T00:00:00.000Z",
        terminal_outcome: "pending" as const,
      }],
      llm_extraction_cache_quarantine: {
        count: 1,
        reason: "operational-only",
      },
      model_health: [{
        provider_id: "provider",
        model_id: "model",
        last_outcome: "success" as const,
        failure_streak: 0,
      }],
    })

    expect(withCache.priorStateJson.length).toBeLessThanOrEqual(8_000)
    expect(() => JSON.parse(withCache.priorStateJson)).not.toThrow()
    expect(withCache.priorStateJson).not.toContain("must-not-affect-input")
    expect(withCache.compressedTranscript).toContain("message-24-")
    expect(withCache.compressedTranscript).not.toContain("message-4-")
    expect(withCache.compressedTranscript).not.toContain("ignored")
    expect(withCache.compressedTranscript.match(/\[user\]/g)).toHaveLength(20)
    expect(withCache.fileCandidates).toHaveLength(20)
    expect(withCache.fileCandidates[0]).toBe("src/file-00.ts")
    expect(withCache.fileCandidates).toEqual([...withCache.fileCandidates].sort())
    expect(withCache.sha256).toBe(withoutCache.sha256)
    expect(withAuditAndCache.sha256).toBe(withoutCache.sha256)
    expect(withAuditAndCache.priorStateJson).toBe(withoutCache.priorStateJson)
  })

  it("builds stable bounded evidence refs, candidates, and digest maps", () => {
    const messages: TranscriptMessage[] = [
      textMessage("user-source", "Use the stable API."),
      textMessage("assistant-source", "We will use the stable API.", "assistant"),
      {
        info: { id: "tool-source", role: "assistant" },
        parts: [{ type: "tool", tool: "read", state: { output: "tool output must not be evidence" } }],
      },
      textMessage("system-source", "system prose must not be evidence", "system"),
    ]

    const first = buildTranscriptEvidenceCandidates(messages)
    const second = buildTranscriptEvidenceCandidates(messages.map((message) => ({
      ...message,
      info: { ...message.info, unrelated_metadata: "ignored" },
    })))
    const map = buildTranscriptEvidenceCandidateMap(messages)
    const digestMap = buildTranscriptEvidenceRefDigestMap(messages)

    expect(first).toEqual(second)
    expect(first).toHaveLength(2)
    expect(Object.keys(map)).toEqual(first.map((candidate) => candidate.ref))
    expect(Object.keys(map).every((ref) => ref.length <= 128)).toBe(true)
    expect(first.every((candidate) => candidate.ref.startsWith("tr-"))).toBe(true)
    expect(JSON.stringify(map)).toContain("Use the stable API.")
    expect(JSON.stringify(digestMap)).not.toContain("Use the stable API.")
    expect(compressTranscript(messages)).not.toContain("user-source")
    expect(compressTranscript(messages)).toContain(`[${first[0].ref}] [user]`)
    expect(compressTranscript(messages)).toContain(`[${first[1].ref}] [assistant]`)
    expect(compressTranscript(messages)).not.toContain("tool output must not be evidence")
    expect(compressTranscript(messages)).not.toContain("system prose")
    expect(digestMap).toEqual(Object.fromEntries(first.map((candidate) => [
      candidate.ref,
      candidate.digest,
    ])))
    expect(digestTranscriptEvidenceCandidate(first[0])).toBe(first[0].digest)
    expect(makeTranscriptEvidenceRef("user-source")).toBe(first[0].ref)
  })

  it("is stable for equivalent object key order and matches SHA-256", () => {
    const messages = [textMessage("m1", "Choose the API shape")]
    const first = buildCanonicalInput(messages, {
      version: 2,
      project_path: "/worktree",
      last_updated: "2026-01-01T00:00:00.000Z",
      current_task: "API",
      active_files: [],
      decisions: [],
      blockers: [],
      next_steps: [],
      recent_sessions: [],
    })
    const second = buildCanonicalInput(messages, {
      recent_sessions: [],
      next_steps: [],
      blockers: [],
      decisions: [],
      active_files: [],
      current_task: "API",
      last_updated: "2026-01-01T00:00:00.000Z",
      project_path: "/worktree",
      version: 2,
    })

    // Different object key order is canonicalized.
    expect(stableJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(first.sha256).toBe(second.sha256)

    const serialized = serializeCanonicalInput(first)
    expect(first.sha256).toBe(createHash("sha256").update(serialized).digest("hex"))
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe("extraction cache identity and prompt", () => {
  it("composes the source, fingerprint, and provider/model exactly", () => {
    expect(makeExtractionCacheKeyLegacy("session-123", "abc123", {
      providerID: "anthropic",
      modelID: "claude-3-5-haiku",
    })).toBe("session-123:abc123:anthropic/claude-3-5-haiku")
  })

  it("includes delta-only structured-output instructions and all canonical components", () => {
    const input = buildCanonicalInput(
      [textMessage("m1", "Decided to use Postgres."), {
        info: { id: "tool", role: "assistant" },
        parts: [{ type: "tool", tool: "read", state: { input: { filePath: "src/db.ts" } } }],
      }],
      emptyMemory("/worktree"),
    )
    const prompt = buildExtractionPrompt(input)

    expect(prompt).toContain("current-session facts or deltas")
    expect(prompt).toContain("CAPPED PRIOR STATE.json")
    expect(prompt).toContain("COMPRESSED SOURCE TRANSCRIPT")
    expect(prompt).toContain("FILE CANDIDATES")
    expect(prompt).toContain("src/db.ts")
    expect(prompt).toContain("StructuredOutput")
    expect(prompt).toContain("free-form JSON")
    expect(prompt).toContain("assistant text")
    expect(prompt).toContain("do not copy old facts")
    expect(prompt).toContain(
      'active_files: must be an array of objects, each exactly `{ "path": "relative/path", "reason": "short evidence-based reason" }`',
    )
    expect(prompt).toContain("use an empty array if no qualifying files")
    expect(prompt).toContain(
      'decisions: must be an array of objects, each with required `{ "topic": "short subject", "decision": "explicit decision", "evidence_refs": ["evidence ID"] }`',
    )
    expect(prompt).toContain("evidence_refs")
    expect(prompt).toContain("1–3 unique IDs")
    expect(prompt).toContain("never raw quotes or excerpts")
    expect(prompt).toContain("Never cite prior STATE.json, FILE CANDIDATES")
    expect(prompt).toContain("model/audit prose")
    expect(prompt).toContain("otherwise use an empty array")
    for (const field of ExtractedFactsJsonSchema.required) {
      expect(prompt).toContain(`- ${field}:`)
    }
  })
})

// ---------------------------------------------------------------------------
// PR 6 §Wave 1 — contract-freeze tests (§18.B items 1-7)
// ---------------------------------------------------------------------------
describe("PR 6 §Wave 1 — extraction contract v3", () => {
  type V3SchemaModule = typeof extractSchema & {
    LLMDecisionFactsJsonSchema: {
      required: string[]
      properties: { decisions: { maxItems: number; items: { required: string[] } } }
    }
    validateLLMDecisionResult: (value: unknown) => unknown
  }

  const v3 = extractSchema as V3SchemaModule
  const validateV3 = (value: unknown) => {
    expect(v3.validateLLMDecisionResult).toBeTypeOf("function")
    return v3.validateLLMDecisionResult(value)
  }

  const validDecision = {
    topic: "database",
    decision: "Use Postgres",
    rationale: "The transcript explicitly selected it.",
    evidence_refs: ["tr-evidence"],
  }

  it("bumps EXTRACTION_CONTRACT_VERSION to 3", () => {
    expect(prompt.EXTRACTION_CONTRACT_VERSION).toBe(3)
  })

  it("accepts decisions-only empty output and one valid evidence-backed decision", () => {
    expect(validateV3({ decisions: [] })).toEqual({ decisions: [] })
    expect(validateV3({ decisions: [validDecision] })).toEqual({ decisions: [validDecision] })

    expect(v3.LLMDecisionFactsJsonSchema.required).toEqual(["decisions"])
    expect(v3.LLMDecisionFactsJsonSchema.properties.decisions.maxItems).toBe(10)
    expect(v3.LLMDecisionFactsJsonSchema.properties.decisions.items.required).toEqual([
      "topic",
      "decision",
      "evidence_refs",
    ])
  })

  it.each([
    ["missing evidence_refs", { topic: "database", decision: "Use Postgres" }],
    ["empty evidence_refs", { ...validDecision, evidence_refs: [] }],
    ["duplicate evidence_refs", { ...validDecision, evidence_refs: ["tr-a", "tr-a"] }],
    ["more than three evidence_refs", { ...validDecision, evidence_refs: ["tr-a", "tr-b", "tr-c", "tr-d"] }],
  ])("rejects %s", (_name, decision) => {
    expect(validateV3({ decisions: [decision] })).toBeNull()
  })

  it.each([
    ["empty topic", { ...validDecision, topic: "" }],
    ["oversized topic", { ...validDecision, topic: "a".repeat(257) }],
    ["empty decision", { ...validDecision, decision: " " }],
    ["oversized decision", { ...validDecision, decision: "a".repeat(501) }],
    ["empty rationale", { ...validDecision, rationale: "" }],
    ["oversized rationale", { ...validDecision, rationale: "a".repeat(501) }],
  ])("rejects bounded-field violation: %s", (_name, decision) => {
    expect(validateV3({ decisions: [decision] })).toBeNull()
  })

  it("rejects more than ten decisions", () => {
    const decisions = Array.from({ length: 11 }, (_, index) => ({
      ...validDecision,
      topic: `topic-${index}`,
      evidence_refs: [`tr-${index}`],
    }))
    expect(validateV3({ decisions })).toBeNull()
  })

  it.each([
    "foundational",
    "foundational_requested",
    "current_task",
    "active_files",
    "blockers",
    "next_steps",
    "unknown_field",
  ])(
    "rejects forbidden top-level field: %s",
    (field) => {
      const value = field === "foundational" ? true : field === "unknown_field" ? "unexpected" : []
      expect(validateV3({ decisions: [], [field]: value })).toBeNull()
    },
  )

  it("rejects foundational on a structured decision", () => {
    expect(validateV3({
      decisions: [{ ...validDecision, foundational: true }],
    })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PR 5 §Wave 1 — source identity fixtures (§18.A items 1-10)
//
// These 10 fixtures are the spec for Wave 2's implementation of the planned
// source-identity helpers in src/memory/extract-prompt.ts:
//
//   EXTRACTION_CONTRACT_VERSION (const)
//   ExtractionSourceInput (interface)
//   serializeExtractionSourceInput()
//   buildExtractionSourceInput()
//   makeSourceVersionKey()
//   makeExtractionCacheKey()
//
// The exports above do not exist yet; they are referenced through a typed stub
// (`prompt as any as { ... }`) so this file still compiles today. Calling them
// at runtime throws, which is the intended Wave 1 failing behavior. Wave 2
// implements the production exports and these fixtures go green.
// ---------------------------------------------------------------------------
describe("PR 5 §Wave 1 — source identity fixtures (§18.A items 1-10)", () => {
  const {
    EXTRACTION_CONTRACT_VERSION,
    buildExtractionSourceInput,
    serializeExtractionSourceInput,
    makeSourceVersionKey,
    makeExtractionCacheKey,
  } = prompt as any as {
    EXTRACTION_CONTRACT_VERSION: number
    buildExtractionSourceInput: (messages: TranscriptMessage[]) => {
      compressedTranscript: string
      fileCandidates: string[]
      extractionContractVersion: number
      sourceInputSha256: string
    }
    serializeExtractionSourceInput: (input: {
      compressedTranscript: string
      fileCandidates: string[]
      extractionContractVersion: number
    }) => string
    makeSourceVersionKey: (args: {
      sourceSessionID: string
      sourceInputSha256: string
      extractionContractVersion: number
    }) => string
    makeExtractionCacheKey: (args: {
      sourceVersionKey: string
      extractionContractVersion: number
      model: { providerID: string; modelID: string; variant?: string }
    }) => string
  }

  /** A tool-only message whose input supplies one file candidate. */
  function toolMessage(id: string, filePath: string): TranscriptMessage {
    return {
      info: { id, role: "assistant" },
      parts: [{ type: "tool", tool: "read", state: { input: { filePath } } }],
    }
  }

  /** A fixed bounded source: two eligible text messages + one file candidate. */
  function sourceMessages(): TranscriptMessage[] {
    return [
      textMessage("m1", "Decided to use Postgres."),
      textMessage("m2", "Let's adopt the stable API surface.", "assistant"),
      toolMessage("tool-1", "./src/db.ts"),
    ]
  }

  it("§18.A.1 — same bounded source produces the same sourceInputSha256 repeatedly", () => {
    const first = buildExtractionSourceInput(sourceMessages())
    const second = buildExtractionSourceInput(sourceMessages())
    expect(first.sourceInputSha256).toBe(second.sourceInputSha256)
    expect(first.sourceInputSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(first.extractionContractVersion).toBe(EXTRACTION_CONTRACT_VERSION)
  })

  it("§18.A.2 — two different prior STATE snapshots produce the same sourceInputSha256", () => {
    const source = sourceMessages()
    // Parallel durable context: these differ between the two runs, but source
    // identity (§3.1) is derived only from the bounded transcript, file
    // candidates, and contract version. The builder never receives prior STATE.
    const priorStateRun1: Record<string, unknown> = { ...emptyMemory("/worktree"), revision: 3 }
    const priorStateRun2: Record<string, unknown> = {
      ...emptyMemory("/worktree"),
      revision: 4,
      current_task: "Changed after run 1",
      last_updated: "2026-08-11T12:00:00.000Z",
      recent_sessions: ["session-9"],
      last_session_id: "session-9",
    }
    void priorStateRun1
    void priorStateRun2
    const first = buildExtractionSourceInput(source)
    const second = buildExtractionSourceInput(source)
    expect(second.sourceInputSha256).toBe(first.sourceInputSha256)
  })

  it("§18.A.3 — the same case is allowed to produce different promptInputSha256 values", () => {
    // Wave 2 (§5.4) renames CanonicalExtractionInput.sha256 to
    // promptInputSha256. Prompt identity legitimately includes prior STATE, so
    // two STATE snapshots may yield different prompt digests while the source
    // digest above stays identical. The planned field does not exist today.
    const first = (buildCanonicalInput(sourceMessages(), emptyMemory("/worktree")) as any).promptInputSha256
    const second = (buildCanonicalInput(sourceMessages(), {
      ...emptyMemory("/worktree"),
      current_task: "Different prior task",
    }) as any).promptInputSha256
    expect(first).not.toBe(second)
  })

  it("§18.A.4 — cache/audit/model-health/revision-only STATE changes cannot alter source identity", () => {
    const source = sourceMessages()
    const baseline = buildExtractionSourceInput(source)
    const mutatedPriorState: Record<string, unknown> = {
      ...emptyMemory("/worktree"),
      last_updated: "2026-08-11T12:00:00.000Z",
      last_session_id: "session-99",
      recent_sessions: ["session-1", "session-2"],
      revision: 42,
      llm_extraction_cache: [{ cache_key: "operational-cache" }],
      llm_extraction_audits: [{ audit_session_id: "operational-audit" }],
      model_health: [{
        provider_id: "anthropic",
        model_id: "claude",
        last_outcome: "success",
        failure_streak: 0,
      }],
    }
    void mutatedPriorState
    const rebuilt = buildExtractionSourceInput(source)
    expect(rebuilt.sourceInputSha256).toBe(baseline.sourceInputSha256)
  })

  it("§18.A.5 — appending a new eligible message changes source identity", () => {
    const baseline = buildExtractionSourceInput(sourceMessages())
    const appended = buildExtractionSourceInput([
      ...sourceMessages(),
      textMessage("m3", "We chose Postgres 16 for the write path."),
    ])
    expect(appended.sourceInputSha256).not.toBe(baseline.sourceInputSha256)
  })

  it("§18.A.6 — changing a tool-derived file candidate changes source identity", () => {
    const baseline = buildExtractionSourceInput(sourceMessages())
    const changed = buildExtractionSourceInput([
      ...sourceMessages(),
      toolMessage("tool-2", "./src/cache.ts"),
    ])
    expect(changed.sourceInputSha256).not.toBe(baseline.sourceInputSha256)
  })

  it("§18.A.7 — reordering canonical file candidates cannot change source identity", () => {
    // The planned builder normalizes and sorts tool-derived candidates before
    // hashing (§5.2; the existing extractFileCandidates already sorts).
    // Reordering the tool parts that introduce the same two candidates must
    // not change the digest.
    const forward: TranscriptMessage[] = [
      textMessage("m1", "Decided to use Postgres."),
      toolMessage("tool-1", "./src/db.ts"),
      toolMessage("tool-2", "./src/cache.ts"),
    ]
    const reversed: TranscriptMessage[] = [
      textMessage("m1", "Decided to use Postgres."),
      toolMessage("tool-2", "./src/cache.ts"),
      toolMessage("tool-1", "./src/db.ts"),
    ]
    const first = buildExtractionSourceInput(forward)
    const second = buildExtractionSourceInput(reversed)
    expect(second.fileCandidates).toEqual(first.fileCandidates)
    expect(second.sourceInputSha256).toBe(first.sourceInputSha256)
  })

  it("§18.A.8 — changing the extraction contract version changes source identity", () => {
    const viaBuilder = buildExtractionSourceInput(sourceMessages())
    const current = serializeExtractionSourceInput({
      compressedTranscript: viaBuilder.compressedTranscript,
      fileCandidates: viaBuilder.fileCandidates,
      extractionContractVersion: EXTRACTION_CONTRACT_VERSION,
    })
    const bumped = serializeExtractionSourceInput({
      compressedTranscript: viaBuilder.compressedTranscript,
      fileCandidates: viaBuilder.fileCandidates,
      extractionContractVersion: EXTRACTION_CONTRACT_VERSION + 1,
    })
    expect(bumped).not.toBe(current)
    expect(viaBuilder.sourceInputSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it("§18.A.9 — source-version key changes when the source session ID changes", () => {
    const source = buildExtractionSourceInput(sourceMessages())
    const args = {
      sourceInputSha256: source.sourceInputSha256,
      extractionContractVersion: EXTRACTION_CONTRACT_VERSION,
    }
    const keyA = makeSourceVersionKey({ ...args, sourceSessionID: "session-a" })
    const keyB = makeSourceVersionKey({ ...args, sourceSessionID: "session-b" })
    expect(keyB).not.toBe(keyA)
    // §3.2: persist as an opaque bounded hash, not a concatenated string.
    expect(keyA).toMatch(/^v2s:[a-f0-9]{64}$/)
    expect(keyB).toMatch(/^v2s:[a-f0-9]{64}$/)
  })

  it("§18.A.10 — extraction key changes when provider, model, or variant changes", () => {
    const source = buildExtractionSourceInput(sourceMessages())
    const sourceVersionKey = makeSourceVersionKey({
      sourceSessionID: "session-1",
      sourceInputSha256: source.sourceInputSha256,
      extractionContractVersion: EXTRACTION_CONTRACT_VERSION,
    })
    const args = { sourceVersionKey, extractionContractVersion: EXTRACTION_CONTRACT_VERSION }
    const baseline = makeExtractionCacheKey({
      ...args,
      model: { providerID: "anthropic", modelID: "claude" },
    })
    const otherProvider = makeExtractionCacheKey({
      ...args,
      model: { providerID: "openai", modelID: "claude" },
    })
    const otherModel = makeExtractionCacheKey({
      ...args,
      model: { providerID: "anthropic", modelID: "gpt-5" },
    })
    const otherVariant = makeExtractionCacheKey({
      ...args,
      model: { providerID: "anthropic", modelID: "claude", variant: "none" },
    })
    expect(new Set([baseline, otherProvider, otherModel, otherVariant]).size).toBe(4)
    // §3.4: bounded opaque hash, never raw provider/model concatenation.
    expect(baseline).toMatch(/^v2e:[a-f0-9]{64}$/)
  })
})
