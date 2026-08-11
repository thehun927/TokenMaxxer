import { describe, it, expect } from "vitest"
import {
  buildCompactionAugmentation,
  buildCompactionPrompt,
} from "../../src/compaction/prompt"

describe("Anti-drift fixtures for repeated compaction (§9, §14.E)", () => {
  // Generation-1 prior summary fixture containing all required elements
  const generation1PriorSummary = `
## Current task
Implement user authentication with JWT tokens

## User constraints
- do not change API X
- keep API backwards-compatible
- use pnpm rather than npm
- must support host version Y

## Work completed
- Database schema migration completed and verified
- JWT token generation implemented but unverified
- Express middleware scaffold created

## Current work
- Currently editing authentication middleware
- Investigating token refresh edge cases

## Relevant files and changes
changed: src/auth/middleware.ts — exact edit evidence exists
changed: src/auth/tokens.ts — exact write evidence exists
relevant/explored: src/auth/types.ts — read/search/reference only

## Locked decisions
- database: Use PostgreSQL (SHA abc123, 2026-08-07)
- auth: Use JWT for authentication (SHA def456, 2026-08-07)

## Verification state
- npm test: passing
- npx tsc --noEmit: failing in src/auth/middleware.ts:42
- build: not rerun after last edit
- host smoke: pending

## Important discoveries
- Exact error: "TokenExpiredError: jwt expired" at src/auth/tokens.ts:15
- Version constraint: jsonwebtoken@9.0.0 required
- Command: pnpm test:auth --filter=unit

## Open questions
- Should refresh tokens rotate on each use?
- How to handle clock skew between services?

## Blockers
- Waiting on API key from third-party provider
- Exact error: "ECONNREFUSED 127.0.0.1:5432" when connecting to local PostgreSQL

## Next steps
1. Fix TypeScript error in middleware.ts:42
2. Resolve PostgreSQL connection issue
3. Implement token refresh rotation logic

## What NOT to redo
- Do not use SQLite — rejected due to JSON support requirements
- Do not implement custom crypto — rejected, use jsonwebtoken library
- Do not refactor entire auth module — out of scope

## Memory conflicts
Conflict: durable decision says SQLite; current session is migrating toward PostgreSQL; migration status is current evidence and the conflict remains unresolved pending confirmation.
`

  describe("Replacement mode second-generation anchor preservation (§14.E cases 56-62)", () => {
    it("preserves prior constraint in second-generation replacement anchor (case 56)", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("do not change API X")
      expect(prompt).toContain("keep API backwards-compatible")
      expect(prompt).toContain("use pnpm rather than npm")
      expect(prompt).toContain("must support host version Y")
    })

    it("preserves prior unresolved blocker with exact error in second-generation replacement anchor (case 57)", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("Waiting on API key from third-party provider")
      expect(prompt).toContain("ECONNREFUSED 127.0.0.1:5432")
    })

    it("preserves prior rejected approach in second-generation replacement anchor (case 58)", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("Do not use SQLite")
      expect(prompt).toContain("rejected due to JSON support requirements")
      expect(prompt).toContain("Do not implement custom crypto")
      expect(prompt).toContain("rejected, use jsonwebtoken library")
    })

    it("preserves prior verification status in second-generation replacement anchor (case 59)", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("npm test: passing")
      expect(prompt).toContain("npx tsc --noEmit: failing in src/auth/middleware.ts:42")
      expect(prompt).toContain("build: not rerun after last edit")
      expect(prompt).toContain("host smoke: pending")
    })

    it("preserves prior pending action in second-generation replacement anchor (case 60)", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("Fix TypeScript error in middleware.ts:42")
      expect(prompt).toContain("Resolve PostgreSQL connection issue")
      expect(prompt).toContain("Implement token refresh rotation logic")
    })

    it("contract says unresolved prior items survive even when absent from newer turns (case 61)", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("Omission from recent turns is not resolution")
      expect(prompt).toContain("Any still-applicable user constraint, settled decision, unresolved blocker, rejected approach, verification state, exact critical detail, or pending action present in the prior continuation summary must survive the next summary")
      expect(prompt).toContain("unless later conversation explicitly superseded, resolved, disproved, or completed it")
    })

    it("contract says explicitly resolved/superseded/completed items may disappear (case 62)", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("explicitly superseded, resolved, disproved, or completed it")
      expect(prompt).toContain("a later explicit user instruction can supersede an earlier one")
    })
  })

  describe("Augment mode anti-drift reinforcement", () => {
    it("does not duplicate previous summary but reinforces retention rule", () => {
      const augmentation = buildCompactionAugmentation("durable context")
      expect(augmentation).toContain("carry unresolved facts from the previous anchored summary forward")
      expect(augmentation).toContain("absence from recent turns is not evidence of resolution")
      expect(augmentation).not.toContain(generation1PriorSummary)
    })
  })

  describe("Exact critical detail preservation (§5.5, §14.B case 24)", () => {
    it("preserves exact error strings when paraphrase would impair continuation", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("TokenExpiredError: jwt expired")
      expect(prompt).toContain("ECONNREFUSED 127.0.0.1:5432")
    })

    it("preserves exact version constraints", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("jsonwebtoken@9.0.0")
    })

    it("preserves exact commands", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("pnpm test:auth --filter=unit")
    })

    it("preserves exact file paths and line numbers", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("src/auth/middleware.ts:42")
      expect(prompt).toContain("src/auth/tokens.ts:15")
    })
  })

  describe("Changed vs explored file distinction (§5.4, §14.B cases 22-23)", () => {
    it("requires exact edit/write/patch evidence for changed files", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("changed: exact edit/write/patch evidence exists")
      expect(prompt).toContain("src/auth/middleware.ts — exact edit evidence exists")
      expect(prompt).toContain("src/auth/tokens.ts — exact write evidence exists")
    })

    it("labels durable file observations as relevance/touch evidence only", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("relevant/explored: read/search/reference only")
      expect(prompt).toContain("src/auth/types.ts — read/search/reference only")
      expect(prompt).toContain("Durable file observations are hints about relevance, not modification proof")
    })
  })

  describe("Work completed vs current work distinction (§5.3, §14.B cases 16-17)", () => {
    it("distinguishes completed and verified from implemented but unverified", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("completed and verified")
      expect(prompt).toContain("implemented but unverified")
      expect(prompt).toContain("Database schema migration completed and verified")
      expect(prompt).toContain("JWT token generation implemented but unverified")
    })

    it("distinguishes currently editing/investigating from planned only", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("currently editing/investigating")
      expect(prompt).toContain("planned only")
      expect(prompt).toContain("Currently editing authentication middleware")
      expect(prompt).toContain("Investigating token refresh edge cases")
    })
  })

  describe("Conflict preservation (§5.6, §14.B case 27)", () => {
    it("preserves durable/current-session disagreement as explicit conflict", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("Conflict: durable decision says SQLite")
      expect(prompt).toContain("current session is migrating toward PostgreSQL")
      expect(prompt).toContain("migration status is current evidence and the conflict remains unresolved pending confirmation")
    })

    it("does not silently choose one side", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("do not silently choose one")
      expect(prompt).toContain("preserve the disagreement")
    })

    it("identifies durable side as prior recorded state", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("identify the durable side as prior recorded state")
    })

    it("identifies current-session side as current evidence", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("identify the current-session side as current evidence")
    })
  })

  describe("Human-reviewed foundational authority protection (§5.6, §9 exception)", () => {
    it("protects human-reviewed foundational decision under PR 3", () => {
      const prompt = buildCompactionPrompt({
        durableContext: "",
        previousSummary: generation1PriorSummary,
      })
      expect(prompt).toContain("Human-reviewed foundational authority remains authority under PR 3")
      expect(prompt).toContain("a git mismatch or casual automation text does not silently supersede it")
    })
  })
})

describe("First compaction replacement mode (no prior summary)", () => {
  it("replacement mode may proceed without anchor on first compaction", () => {
    const prompt = buildCompactionPrompt({
      durableContext: "some durable context",
      previousSummary: undefined,
    })
    expect(prompt).toContain("## Current task")
    expect(prompt).toContain("## User constraints")
    // Should not contain previous summary anchor block
    expect(prompt).not.toContain("previous summary")
    expect(prompt).not.toContain("data/anchor")
  })
})

describe("Augment mode no-duplicate-heading expectation (§6)", () => {
  it("augmentation does not contain duplicate mandatory headings", () => {
    const augmentation = buildCompactionAugmentation("durable context")
    // Host already requires these sections in its native prompt
    expect(augmentation).not.toContain("## Current task")
    expect(augmentation).not.toContain("## Active files")
    expect(augmentation).not.toContain("## Locked decisions")
    expect(augmentation).not.toContain("## Open questions")
    expect(augmentation).not.toContain("## Blockers")
    expect(augmentation).not.toContain("## Next steps")
    expect(augmentation).not.toContain("## What NOT to redo")
  })

  it("augmentation says 'Within the host's existing summary sections:'", () => {
    const augmentation = buildCompactionAugmentation("durable context")
    expect(augmentation).toContain("Within the host's existing summary sections")
  })
})

describe("Replacement mode expanded sections and previous-summary anchor wording (§7)", () => {
  it("includes all 13 expanded sections in correct order", () => {
    const prompt = buildCompactionPrompt({
      durableContext: "",
      previousSummary: "prior summary",
    })
    const sections = [
      "## Current task",
      "## User constraints",
      "## Work completed",
      "## Current work",
      "## Relevant files and changes",
      "## Locked decisions",
      "## Verification state",
      "## Important discoveries",
      "## Open questions",
      "## Blockers",
      "## Next steps",
      "## What NOT to redo",
      "## Memory conflicts",
    ]
    let lastIndex = -1
    for (const section of sections) {
      const index = prompt.indexOf(section)
      expect(index).toBeGreaterThan(lastIndex)
      lastIndex = index
    }
  })

  it("includes previous summary in clearly delimited data/anchor block", () => {
    const prompt = buildCompactionPrompt({
      durableContext: "",
      previousSummary: "prior summary content",
    })
    expect(prompt).toContain("previous summary")
    expect(prompt).toContain("data/anchor")
    expect(prompt).toContain("prior summary content")
  })

  it("instructs model to update anchor against current conversation evidence", () => {
    const prompt = buildCompactionPrompt({
      durableContext: "",
      previousSummary: "prior summary content",
    })
    expect(prompt).toContain("update it against current conversation evidence")
  })
})
