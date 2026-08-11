/**
 * PR 7 Wave 5 — Previous-summary sanitization adversarial tests.
 *
 * Tests for:
 * - Removal of actual prompt anchor closing delimiter
 * - Removal of legacy closing delimiter
 * - Preservation of other content
 */
import { describe, it, expect } from "vitest"
import { sanitizePreviousSummary } from "../../src/compaction/sanitize"

describe("sanitizePreviousSummary — adversarial delimiter removal", () => {
  it("removes actual prompt anchor closing delimiter", () => {
    const input = `Some summary content\n<<<END_PREVIOUS_SUMMARY_ANCHOR>>>\nMore content`
    const result = sanitizePreviousSummary(input)
    expect(result).not.toContain("END_PREVIOUS_SUMMARY_ANCHOR")
    expect(result).toContain("Some summary content")
    expect(result).toContain("More content")
  })

  it("removes legacy closing delimiter", () => {
    const input = `Some summary content\n<<<END_PREVIOUS_SUMMARY>>>\nMore content`
    const result = sanitizePreviousSummary(input)
    expect(result).not.toContain("END_PREVIOUS_SUMMARY")
    expect(result).toContain("Some summary content")
    expect(result).toContain("More content")
  })

  it("removes both delimiters when both present", () => {
    const input = `Some summary content\n<<<END_PREVIOUS_SUMMARY_ANCHOR>>>\nMiddle\n<<<END_PREVIOUS_SUMMARY>>>\nMore content`
    const result = sanitizePreviousSummary(input)
    expect(result).not.toContain("END_PREVIOUS_SUMMARY_ANCHOR")
    expect(result).not.toContain("END_PREVIOUS_SUMMARY")
    expect(result).toContain("Some summary content")
    expect(result).toContain("Middle")
    expect(result).toContain("More content")
  })

  it("preserves content between delimiters", () => {
    const input = `Start\n<<<END_PREVIOUS_SUMMARY_ANCHOR>>>\nMiddle\n<<<END_PREVIOUS_SUMMARY_ANCHOR>>>\nEnd`
    const result = sanitizePreviousSummary(input)
    expect(result).toContain("Start")
    expect(result).toContain("Middle")
    expect(result).toContain("End")
    expect(result).not.toContain("END_PREVIOUS_SUMMARY_ANCHOR")
  })

  it("handles empty input", () => {
    const result = sanitizePreviousSummary("")
    expect(result).toBe("")
  })

  it("handles input with only delimiters", () => {
    const result = sanitizePreviousSummary("<<<END_PREVIOUS_SUMMARY_ANCHOR>>>")
    expect(result).toBe("")
  })

  it("handles input with delimiters at start and end", () => {
    const input = `<<<END_PREVIOUS_SUMMARY_ANCHOR>>>\nSome content\n<<<END_PREVIOUS_SUMMARY_ANCHOR>>>`
    const result = sanitizePreviousSummary(input)
    expect(result).toContain("Some content")
    expect(result).not.toContain("END_PREVIOUS_SUMMARY_ANCHOR")
  })
})
