/**
 * Release-gate fixtures — model-callable argument bounds (§12 B, cases 8-18)
 * and `head_files` output bounds (§12 C, cases 19-23).
 *
 * These tests are the SPEC for the Wave 3 bounds implementation and are
 * intentionally FAILING in Wave 1: they import `src/tools/bounds.ts` and the
 * planned `src/tools/efficiency.ts` output formatter, which do not exist yet.
 * The failure mode in Wave 1 is a module-load error; they are expected to go
 * green in Wave 3 when the production bounds land.
 *
 * Planned Wave 3 API referenced by these fixtures (do not rename the test
 * contract without a documented scope deviation):
 *
 *   src/tools/bounds.ts
 *     TOOL_LIMITS.recallQueryChars    = 256
 *     TOOL_LIMITS.recallLimitMax      = 25
 *     TOOL_LIMITS.decisionIdChars     = 256   (must stay aligned with MAX_IDENTIFIER)
 *     TOOL_LIMITS.decisionTopicChars  = 256
 *     TOOL_LIMITS.headPathCountMax    = 16
 *     TOOL_LIMITS.headPathChars       = 1024
 *     TOOL_LIMITS.headLinesMax        = 200
 *     TOOL_LIMITS.headLineChars       = 2_000
 *     TOOL_LIMITS.headFileOutputChars = 16_384
 *     TOOL_LIMITS.headTotalOutputChars= 65_536
 *
 *     recallQuerySchema   — zod string, max TOOL_LIMITS.recallQueryChars, optional
 *     recallLimitSchema   — zod int 1..TOOL_LIMITS.recallLimitMax, default 10
 *     decisionIdSchema    — zod string 1..MAX_IDENTIFIER, optional
 *     decisionTopicSchema — zod string 1..TOOL_LIMITS.decisionTopicChars, optional
 *     headPathsSchema     — zod array of strings (1..TOOL_LIMITS.headPathChars)
 *                           with array min 1, max TOOL_LIMITS.headPathCountMax
 *     headLinesSchema     — zod int 1..TOOL_LIMITS.headLinesMax, default 40
 *
 *   src/tools/efficiency.ts
 *     type HeadFileSection = { path: string; content: string }  // content already
 *                                   // limited to headLinesMax lines by caller
 *     formatHeadFilesOutput(sections: HeadFileSection[]): string
 *       - truncates each line to TOOL_LIMITS.headLineChars with
 *         `...(line truncated)` when a line is cut;
 *       - truncates each `### path` section to TOOL_LIMITS.headFileOutputChars
 *         with `...(file output truncated)`;
 *       - truncates the joined result to TOOL_LIMITS.headTotalOutputChars with
 *         `...(head_files output truncated)`;
 *       - never appends hidden tail content after a marker.
 */
import { describe, expect, it } from "vitest"
import * as bounds from "../../src/tools/bounds"
import * as eff from "../../src/tools/efficiency"
import { MAX_IDENTIFIER } from "../../src/memory/schema"

/** Planned Wave 3 `HeadFileSection` shape (mirrored locally until it exists). */
type HeadFileSection = {
  path: string
  content: string
}

describe("recall argument bounds (§12 B cases 8-11)", () => {
  it("case 8: recall query length exactly 256 is accepted", () => {
    expect(bounds.recallQuerySchema.safeParse("a".repeat(256)).success).toBe(true)
  })

  it("case 9: recall query length 257 is rejected by schema", () => {
    expect(bounds.recallQuerySchema.safeParse("a".repeat(257)).success).toBe(false)
  })

  it("case 10: recall limit 1 and 25 are accepted", () => {
    expect(bounds.recallLimitSchema.safeParse(1).success).toBe(true)
    expect(bounds.recallLimitSchema.safeParse(bounds.TOOL_LIMITS.recallLimitMax).success).toBe(true)
  })

  it("case 11: recall limits 0, 26, negative, fractional, and Infinity are rejected", () => {
    expect(bounds.recallLimitSchema.safeParse(0).success).toBe(false)
    expect(bounds.recallLimitSchema.safeParse(bounds.TOOL_LIMITS.recallLimitMax + 1).success).toBe(false)
    expect(bounds.recallLimitSchema.safeParse(-1).success).toBe(false)
    expect(bounds.recallLimitSchema.safeParse(1.5).success).toBe(false)
    expect(bounds.recallLimitSchema.safeParse(Infinity).success).toBe(false)
  })
})

describe("review-request argument bounds (§12 B cases 12-13)", () => {
  it("case 12: decision ID exactly MAX_IDENTIFIER accepted; MAX_IDENTIFIER + 1 rejected", () => {
    expect(bounds.decisionIdSchema.safeParse("x".repeat(MAX_IDENTIFIER)).success).toBe(true)
    expect(bounds.decisionIdSchema.safeParse("x".repeat(MAX_IDENTIFIER + 1)).success).toBe(false)
  })

  it("keeps TOOL_LIMITS.decisionIdChars aligned with persistence MAX_IDENTIFIER", () => {
    expect(bounds.TOOL_LIMITS.decisionIdChars).toBe(MAX_IDENTIFIER)
  })

  it("case 13: review-request topic at its max accepted; max + 1 rejected", () => {
    expect(
      bounds.decisionTopicSchema.safeParse("t".repeat(bounds.TOOL_LIMITS.decisionTopicChars)).success,
    ).toBe(true)
    expect(
      bounds.decisionTopicSchema.safeParse("t".repeat(bounds.TOOL_LIMITS.decisionTopicChars + 1)).success,
    ).toBe(false)
  })
})

describe("head_files argument bounds (§12 B cases 14-18)", () => {
  it("case 14: accepts 1 and headPathCountMax paths", () => {
    const one = ["src/index.ts"]
    const many = Array.from(
      { length: bounds.TOOL_LIMITS.headPathCountMax },
      (_, i) => `src/module-${i}.ts`,
    )
    expect(bounds.headPathsSchema.safeParse(one).success).toBe(true)
    expect(bounds.headPathsSchema.safeParse(many).success).toBe(true)
  })

  it("case 15: rejects zero paths and headPathCountMax + 1 paths", () => {
    const tooMany = Array.from(
      { length: bounds.TOOL_LIMITS.headPathCountMax + 1 },
      (_, i) => `src/module-${i}.ts`,
    )
    expect(bounds.headPathsSchema.safeParse([]).success).toBe(false)
    expect(bounds.headPathsSchema.safeParse(tooMany).success).toBe(false)
  })

  it("case 16: path max length accepted; max + 1 rejected", () => {
    expect(
      bounds.headPathsSchema.safeParse(["p".repeat(bounds.TOOL_LIMITS.headPathChars)]).success,
    ).toBe(true)
    expect(
      bounds.headPathsSchema.safeParse(["p".repeat(bounds.TOOL_LIMITS.headPathChars + 1)]).success,
    ).toBe(false)
  })

  it("case 17: head lines 1 and headLinesMax are accepted", () => {
    expect(bounds.headLinesSchema.safeParse(1).success).toBe(true)
    expect(bounds.headLinesSchema.safeParse(bounds.TOOL_LIMITS.headLinesMax).success).toBe(true)
  })

  it("case 18: head lines 0, headLinesMax + 1, negative, and fractional are rejected", () => {
    expect(bounds.headLinesSchema.safeParse(0).success).toBe(false)
    expect(bounds.headLinesSchema.safeParse(bounds.TOOL_LIMITS.headLinesMax + 1).success).toBe(false)
    expect(bounds.headLinesSchema.safeParse(-1).success).toBe(false)
    expect(bounds.headLinesSchema.safeParse(1.5).success).toBe(false)
  })
})

describe("head_files output bounds (§12 C cases 19-23)", () => {
  it("case 19: normal multi-line output below all caps is unchanged", () => {
    const sections: HeadFileSection[] = [
      { path: "a.ts", content: "line1\nline2\nline3" },
    ]
    expect(eff.formatHeadFilesOutput(sections)).toBe("### a.ts\nline1\nline2\nline3")
  })

  it("case 20: a single extremely long line is truncated with the line marker", () => {
    // Wave 3 fixture fix (see blockers.md): the original `"x".repeat(headLineChars + 500)`
    // makes the hidden tail `"x".repeat(500)` an indistinguishable substring of the
    // visible 2000-char prefix, so `not.toContain(tail)` can never pass for any
    // correct formatter. Give the tail a distinguishable suffix instead.
    const longLine = "x".repeat(bounds.TOOL_LIMITS.headLineChars) + "y".repeat(500)
    const result = eff.formatHeadFilesOutput([
      { path: "long.ts", content: `start\n${longLine}\nend` },
    ])
    expect(result).toContain("...(line truncated)")
    // The hidden tail of the long line must not appear anywhere.
    expect(result).not.toContain(longLine.slice(bounds.TOOL_LIMITS.headLineChars))
  })

  it("case 21: one file section cannot exceed the per-file output cap", () => {
    const sections: HeadFileSection[] = [
      { path: "big.ts", content: "z\n".repeat(bounds.TOOL_LIMITS.headFileOutputChars) },
    ]
    const result = eff.formatHeadFilesOutput(sections)
    expect(result).toContain("...(file output truncated)")
  })

  it("case 22: multiple files cannot exceed the total output cap", () => {
    // Six sections of ~13 KB each: individually under the per-file cap, but
    // the joined result far exceeds the 64 KB total cap.  Lines stay well
    // under headLineChars so only the total marker should fire.
    const sections: HeadFileSection[] = Array.from({ length: 6 }, (_, i) => ({
      path: `file-${i}.ts`,
      content: ("v".repeat(100) + "\n").repeat(130),
    }))
    const result = eff.formatHeadFilesOutput(sections)
    expect(result).toContain("...(head_files output truncated)")
  })

  it("case 23: output truncation never appends hidden tail content after the marker", () => {
    // Wave 3 fixture fix (see blockers.md): the original put `hiddenTail` inside
    // EVERY section, so it lands in the 64 KB kept prefix before the total
    // marker even though it is "hidden tail content" — unsatisfiable for any
    // content-preserving bounded formatter. The tail now appears only where a
    // deterministic truncation must remove it: the long-line section (line
    // marker) and the last section beyond the total output cap (total marker).
    const hiddenTail = "HIDDEN_TAIL_MUST_NOT_SURFACE"
    const sections: HeadFileSection[] = Array.from({ length: 6 }, (_, i) => ({
      path: `file-${i}.ts`,
      content: ("v".repeat(100) + "\n").repeat(130),
    }))
    // Hidden tail beyond the total output cap: it must never surface after the
    // total-truncation marker.
    sections[5] = {
      path: "file-5.ts",
      content: ("v".repeat(100) + "\n").repeat(130) + hiddenTail,
    }
    sections[0] = {
      path: "long.ts",
      content: "x".repeat(bounds.TOOL_LIMITS.headLineChars + 200) + hiddenTail,
    }
    const result = eff.formatHeadFilesOutput(sections)
    expect(result).not.toContain(hiddenTail)
  })
})
