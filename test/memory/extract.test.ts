import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import {
  ExtractedFactsJsonSchema,
  ExtractedFactsSchema,
  validateStructuredResult,
} from "../../src/memory/extract-schema"
import {
  buildCanonicalInput,
  buildExtractionPrompt,
  makeExtractionCacheKey,
  serializeCanonicalInput,
  stableJson,
} from "../../src/memory/extract-prompt"
import { emptyMemory } from "../../src/memory/schema"
import type { TranscriptMessage } from "../../src/types"

const validFacts = {
  current_task: "Build the API",
  active_files: [{ path: "src/api.ts", reason: "edited" }],
  decisions: [{ topic: "database", decision: "Use Postgres" }],
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
      ExtractedFactsSchema.safeParse({ ...validFacts, assistant_text: "{}" }).success,
    ).toBe(false)
    expect(validateStructuredResult({ ...validFacts, next_steps: Array(6).fill("step") })).toBeNull()
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
    expect(makeExtractionCacheKey("session-123", "abc123", {
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
      'decisions: must be an array of objects, each with required `{ "topic": "short subject", "decision": "explicit decision" }`; optional `rationale` and `foundational`',
    )
    expect(prompt).toContain("otherwise use an empty array")
    for (const field of ExtractedFactsJsonSchema.required) {
      expect(prompt).toContain(`- ${field}:`)
    }
  })
})
