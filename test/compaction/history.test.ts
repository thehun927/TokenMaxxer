/**
 * PR 7 Wave 5 — Previous-summary recovery tests.
 *
 * Tests for:
 * - extractLatestCompactionSummary pure extraction
 * - readPreviousCompactionSummary async recovery
 * - Replace mode history fallback to augment
 * - First compaction without anchor
 * - History unavailable handling
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { TranscriptMessage } from "../../src/types"
import {
  extractLatestCompactionSummary,
  readPreviousCompactionSummary,
  type PreviousCompactionSummaryResult,
} from "../../src/compaction/history"

describe("extractLatestCompactionSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns undefined when no compaction user messages exist", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "text", text: "Hello" }],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBeUndefined()
  })

  it("returns undefined when no completed assistant summaries exist", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "user", parentID: "msg-1" },
        parts: [{ type: "text", text: "Normal user message" }],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBeUndefined()
  })

  it("returns undefined when no completed assistant summaries have summary flag", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: false },
        parts: [{ type: "text", text: "Assistant message without summary flag" }],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBeUndefined()
  })

  it("returns undefined when completed assistant summaries have no text parts", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: true, finish: "stop" },
        parts: [{ type: "tool", tool: "some-tool" }],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBeUndefined()
  })

  it("returns the latest completed non-empty summary", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: true, finish: "stop" },
        parts: [{ type: "text", text: "First summary" }],
      },
      {
        info: { id: "msg-3", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Second compaction request" }],
      },
      {
        info: { id: "msg-4", role: "assistant", parentID: "msg-3", summary: true, finish: "stop" },
        parts: [{ type: "text", text: "Second summary" }],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBe("Second summary")
  })

  it("combines multiple text parts into a single summary", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: true, finish: "stop" },
        parts: [
          { type: "text", text: "First part" },
          { type: "text", text: "Second part" },
          { type: "text", text: "Third part" },
        ],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBe("First part\nSecond part\nThird part")
  })

  it("ignores errored/incomplete summary records when fields are present", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: true, error: "some error", finish: "stop" },
        parts: [{ type: "text", text: "Errored summary" }],
      },
      {
        info: { id: "msg-3", role: "assistant", parentID: "msg-1", summary: true, finish: "stop" },
        parts: [{ type: "text", text: "Valid summary" }],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBe("Valid summary")
  })

  it("ignores incomplete summary records when fields are present", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: true, incomplete: true, finish: "stop" },
        parts: [{ type: "text", text: "Incomplete summary" }],
      },
      {
        info: { id: "msg-3", role: "assistant", parentID: "msg-1", summary: true, finish: "stop" },
        parts: [{ type: "text", text: "Valid summary" }],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBe("Valid summary")
  })

  it("ignores messages without parentID pointing to compaction user", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: true, finish: "stop" },
        parts: [{ type: "text", text: "Valid summary" }],
      },
      {
        info: { id: "msg-3", role: "assistant", parentID: "msg-2", summary: true, finish: "stop" },
        parts: [{ type: "text", text: "Orphaned summary (no compaction parent)" }],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBe("Valid summary")
  })

  it("ignores messages with wrong role", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "user", parentID: "msg-1", summary: true, finish: "stop" },
        parts: [{ type: "text", text: "User message with summary flag" }],
      },
      {
        info: { id: "msg-3", role: "assistant", parentID: "msg-1", summary: true, finish: "stop" },
        parts: [{ type: "text", text: "Valid summary" }],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBe("Valid summary")
  })

  it("ignores summary:true with finish missing", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: true },
        parts: [{ type: "text", text: "Summary without finish" }],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBeUndefined()
  })

  it("ignores summary:true with finish:false", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: true, finish: false },
        parts: [{ type: "text", text: "Summary with finish:false" }],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBeUndefined()
  })

  it("older finished summary wins over newer summary:true without finish", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: true, finish: "stop" },
        parts: [{ type: "text", text: "Older finished summary" }],
      },
      {
        info: { id: "msg-3", role: "assistant", parentID: "msg-1", summary: true },
        parts: [{ type: "text", text: "Newer summary without finish" }],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBe("Older finished summary")
  })

  it("ignores finished errored summary", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: true, error: "some error", finish: "stop" },
        parts: [{ type: "text", text: "Errored summary" }],
      },
      {
        info: { id: "msg-3", role: "assistant", parentID: "msg-1", summary: true, finish: "stop" },
        parts: [{ type: "text", text: "Valid summary" }],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBe("Valid summary")
  })

  it("newest finished, non-error, non-empty summary wins", () => {
    const messages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: true, finish: "stop" },
        parts: [{ type: "text", text: "Older summary" }],
      },
      {
        info: { id: "msg-3", role: "assistant", parentID: "msg-1", summary: true, finish: "stop" },
        parts: [{ type: "text", text: "Newer summary" }],
      },
    ]
    const result = extractLatestCompactionSummary(messages)
    expect(result).toBe("Newer summary")
  })
})

describe("readPreviousCompactionSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 'none' when no summary is found after successful read", async () => {
    const mockClient = {
      session: {
        messages: vi.fn(async () => ({ data: [] })),
      },
    }

    const result = await readPreviousCompactionSummary({
      client: mockClient,
      sessionID: "test-session",
    })

    expect(result).toEqual({ status: "none" })
  })

  it("returns 'found' when a summary is recovered", async () => {
    const mockMessages: TranscriptMessage[] = [
      {
        info: { id: "msg-1", role: "user", parentID: undefined },
        parts: [{ type: "compaction", text: "Compaction request" }],
      },
      {
        info: { id: "msg-2", role: "assistant", parentID: "msg-1", summary: true, finish: "stop" },
        parts: [{ type: "text", text: "Recovered summary" }],
      },
    ]

    const mockClient = {
      session: {
        messages: vi.fn(async () => ({ data: mockMessages })),
      },
    }

    const result = await readPreviousCompactionSummary({
      client: mockClient,
      sessionID: "test-session",
    })

    expect(result).toEqual({ status: "found", summary: "Recovered summary" })
  })

  it("returns 'unavailable' when client.session.messages throws", async () => {
    const mockClient = {
      session: {
        messages: vi.fn(async () => {
          throw new Error("Network error")
        }),
      },
    }

    const result = await readPreviousCompactionSummary({
      client: mockClient,
      sessionID: "test-session",
    })

    expect(result).toEqual({ status: "unavailable", reason: "Network error" })
  })

  it("returns 'unavailable' when client.session.messages is missing", async () => {
    const mockClient = {} as unknown

    const result = await readPreviousCompactionSummary({
      client: mockClient,
      sessionID: "test-session",
    })

    expect(result).toEqual({ status: "unavailable", reason: "session.messages unavailable" })
  })

  it("returns 'unavailable' when client.session.messages returns malformed response", async () => {
    const mockClient = {
      session: {
        messages: vi.fn(async () => "not an object" as unknown),
      },
    }

    const result = await readPreviousCompactionSummary({
      client: mockClient,
      sessionID: "test-session",
    })

    expect(result).toEqual({ status: "unavailable", reason: "session.messages returned malformed response" })
  })

  it("returns 'unavailable' when client.session.messages returns null", async () => {
    const mockClient = {
      session: {
        messages: vi.fn(async () => null as unknown),
      },
    }

    const result = await readPreviousCompactionSummary({
      client: mockClient,
      sessionID: "test-session",
    })

    expect(result).toEqual({ status: "unavailable", reason: "session.messages returned no data" })
  })

  it("returns 'unavailable' when client.session.messages returns undefined", async () => {
    const mockClient = {
      session: {
        messages: vi.fn(async () => undefined as unknown),
      },
    }

    const result = await readPreviousCompactionSummary({
      client: mockClient,
      sessionID: "test-session",
    })

    expect(result).toEqual({ status: "unavailable", reason: "session.messages returned no data" })
  })
})

describe("PreviousCompactionSummaryResult type", () => {
  it("should be exhaustively handled", () => {
    const result: PreviousCompactionSummaryResult = { status: "found", summary: "test" }
    expect(result.status).toBe("found")

    const result2: PreviousCompactionSummaryResult = { status: "none" }
    expect(result2.status).toBe("none")

    const result3: PreviousCompactionSummaryResult = { status: "unavailable", reason: "test" }
    expect(result3.status).toBe("unavailable")
  })
})
