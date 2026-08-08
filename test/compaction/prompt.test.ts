import { describe, it, expect } from "vitest"
import { buildCompactionPrompt } from "../../src/compaction/prompt"

describe("buildCompactionPrompt", () => {
  const requiredHeaders = [
    "## Current task",
    "## Active files",
    "## Locked decisions",
    "## Open questions",
    "## Blockers",
    "## Next steps",
    "## What NOT to redo",
  ]

  it("contains all 7 required section headers", () => {
    const prompt = buildCompactionPrompt("(no prior memory)")
    for (const header of requiredHeaders) {
      expect(prompt).toContain(header)
    }
  })

  it("interpolates the durable block string", () => {
    const durable = "Project: test-project\nCurrent task: building things"
    const prompt = buildCompactionPrompt(durable)
    expect(prompt).toContain("Project: test-project")
    expect(prompt).toContain("building things")
    expect(prompt).toContain("### DURABLE CONTEXT")
  })

  it("works with empty durable block", () => {
    const prompt = buildCompactionPrompt("")
    expect(prompt).toContain("### DURABLE CONTEXT")
    // Durable block is interpolated even when empty — the header is always present
    // but there's no content under it beyond what the empty string provides
    expect(prompt.endsWith("### DURABLE CONTEXT\n")).toBe(true)
  })

  it('works with placeholder durable block "(no prior project memory)"', () => {
    const prompt = buildCompactionPrompt("(no prior project memory)")
    expect(prompt).toContain("(no prior project memory)")
    expect(prompt).toContain("### DURABLE CONTEXT")
  })

  it('contains "recorded observations" language, NOT "ground truth"', () => {
    const prompt = buildCompactionPrompt("any durable block")
    // The corrected language must be present
    expect(prompt).toContain("recorded observations from prior sessions")
    expect(prompt).toContain(
      "Verify against the conversation if they conflict",
    )
    // The original "ground truth" language must NOT be present
    expect(prompt).not.toContain("ground truth")
  })
})
