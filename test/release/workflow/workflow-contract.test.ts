/**
 * PR-10 workflow contract tests (Wave 1, Agent 1C).
 *
 * Freezes the workflow contracts from PR-10 §6, §10 and §10.1:
 *   - all external Actions pinned to full 40-hex commit SHAs with tag comments;
 *   - minimal permissions (CI read-only; release `contents: write` only);
 *   - release workflow triggers ONLY from `v*.*.*` tags and can never run from
 *     an ordinary main push or pull request;
 *   - CI runs the complete dry-run release validation without mutating releases;
 *   - release job uses draft-first publication, verifies before publishing,
 *     fails closed when immutable-release status cannot be proven, uses the gh
 *     CLI (no third-party release action), and never `--clobber`s assets.
 *
 * Production is pre-PR-10, so `.github/workflows/release.yml` does not exist
 * yet and `ci.yml` still uses mutable tag refs. Those assertions fail
 * intentionally and are reported; the fixture-driven tests prove the parser
 * and the contract logic are correct.
 */

import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import {
  allJobText,
  getTriggerInfo,
  jobEffectivePermissions,
  loadWorkflow,
  parsePermissions,
  pathFromRoot,
  type WorkflowModel,
  type PermissionScopes,
} from "./workflow-parse"

const FIXTURES = fileURLToPath(new URL("./fixtures/workflows/", import.meta.url))

// Planning-time verified tag→SHA identities (docs/CRIP/PR-10/blockers.md).
const VERIFIED_PINS: Record<string, string> = {
  "actions/checkout": "de0fac2e4500dabe0009e67214ff5f5447ce83dd",
  "actions/setup-node": "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  "oven-sh/setup-bun": "0c5077e51419868618aeaa5fe8019c62421857d6",
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/
const MUTABLE_REF_RE = /^(v\d+(?:\.\d+)*|main|master|latest)$/

function loadFixture(name: string): WorkflowModel {
  return loadWorkflow(resolve(FIXTURES, name))
}

/** Violations of the full-SHA pinning contract. */
function pinViolations(model: WorkflowModel): string[] {
  const violations: string[] = []
  if (model.rawUses.length === 0) {
    violations.push("workflow uses no external actions (nothing to pin)")
  }
  for (const use of model.rawUses) {
    if (!FULL_SHA_RE.test(use.ref)) {
      violations.push(
        `${use.action}@${use.ref} in job "${use.job}" must be pinned to a full 40-hex commit SHA`,
      )
    }
    if (MUTABLE_REF_RE.test(use.ref)) {
      violations.push(
        `${use.action}@${use.ref} is a mutable ref; PR-10 removes the Node-20 action runtime deprecation path`,
      )
    }
    if (FULL_SHA_RE.test(use.ref) && !use.comment) {
      violations.push(
        `${use.action}@${use.ref} in job "${use.job}" must record the human-readable tag as a comment`,
      )
    }
    if (VERIFIED_PINS[use.action] && VERIFIED_PINS[use.action] !== use.ref) {
      violations.push(
        `${use.action} must use verified pin ${VERIFIED_PINS[use.action]}, got ${use.ref}`,
      )
    }
  }
  return violations
}

/** Violations of the minimal-permissions contract (no write beyond allowed set). */
function permissionViolations(
  model: WorkflowModel,
  allowedWriteScopes: string[] = [],
): string[] {
  const violations: string[] = []
  const top = parsePermissions(model.permissions)
  if (!top.isAllRead && Object.keys(top.scopes).length === 0 && !top.isAllWrite) {
    violations.push("workflow must declare explicit top-level permissions")
  }
  if (top.isAllWrite) {
    violations.push("workflow must not use write-all")
  }
  for (const [jobName, job] of Object.entries(model.jobs)) {
    const effective = jobEffectivePermissions(job, top)
    if (effective.isAllWrite) {
      violations.push(`job "${jobName}" must not use write-all`)
    }
    for (const [scope, level] of Object.entries(effective.scopes)) {
      if (level === "write" && !allowedWriteScopes.includes(scope)) {
        violations.push(
          `job "${jobName}" grants write on "${scope}" (allowed write scopes: ${allowedWriteScopes.join(", ") || "none"})`,
        )
      }
    }
  }
  return violations
}

/** Violations of the tag-only trigger contract for a release workflow. */
function releaseTriggerViolations(model: WorkflowModel): string[] {
  const violations: string[] = []
  const triggers = getTriggerInfo(model.on)
  if (triggers.pushTags.length === 0) {
    violations.push("release workflow must trigger on a version tag filter (push.tags)")
  }
  if (!triggers.pushTags.some((t) => /^v\*.*\*$/.test(t))) {
    violations.push(
      `release workflow push.tags must match version tags like "v*.*.*", got ${JSON.stringify(triggers.pushTags)}`,
    )
  }
  if (triggers.pushBranches.length > 0) {
    violations.push(
      `release workflow must never trigger on branch push (found branches: ${triggers.pushBranches.join(", ")})`,
    )
  }
  if (triggers.hasPullRequest) {
    violations.push("release workflow must never trigger on pull_request")
  }
  if (triggers.hasWorkflowDispatch) {
    const inputs = Object.keys(triggers.workflowDispatchInputs)
    const freeText = inputs.filter((name) =>
      ["tag", "version", "commit", "ref"].includes(name.toLowerCase()),
    )
    if (freeText.length > 0) {
      violations.push(
        `release workflow_dispatch must not accept free-form identity inputs (found: ${freeText.join(", ")})`,
      )
    }
  }
  return violations
}

/** Violations of the draft-first publication sequence for a release workflow. */
function releasePublicationViolations(model: WorkflowModel): string[] {
  const violations: string[] = []
  const allText = allJobText(model)
  const steps = Object.values(model.jobs)[0]?.steps ?? []

  if (!allText.includes("--draft")) {
    violations.push("release workflow must create a draft release first (--draft)")
  }
  if (!allText.includes("gh release create")) {
    violations.push("release workflow must use gh release create")
  }
  if (!allText.includes("gh release upload")) {
    violations.push("release workflow must upload the complete staged asset set")
  }
  if (!allText.includes("gh release verify")) {
    violations.push("release workflow must verify the uploaded release/assets")
  }
  const publishIndex = steps.findIndex(
    (s) => (s.run ?? "").includes("draft=false") || (s.run ?? "").includes("--draft=false"),
  )
  const verifyIndex = steps.findIndex((s) => (s.run ?? "").includes("gh release verify"))
  const uploadIndex = steps.findIndex((s) => (s.run ?? "").includes("gh release upload"))
  const draftIndex = steps.findIndex((s) => (s.run ?? "").includes("--draft") && !(s.run ?? "").includes("draft=false"))
  if (draftIndex === -1) violations.push("no step creates the draft release")
  if (uploadIndex === -1) violations.push("no step uploads assets")
  if (verifyIndex === -1) violations.push("no step verifies before publish")
  if (publishIndex === -1) violations.push("no step publishes the draft (draft=false)")
  if (
    draftIndex !== -1 &&
    uploadIndex !== -1 &&
    verifyIndex !== -1 &&
    publishIndex !== -1 &&
    !(draftIndex < uploadIndex && uploadIndex < verifyIndex && verifyIndex < publishIndex)
  ) {
    violations.push("draft → upload → verify → publish ordering is violated")
  }
  if (allText.includes("--clobber")) {
    violations.push("release workflow must never use asset --clobber on a published release")
  }
  // Immutable-release preflight must fail closed.
  if (!/preflight|immutable|releases\/.*(settings|immutab)/i.test(allText)) {
    violations.push(
      "release workflow must preflight that repository immutable releases are enabled and fail closed",
    )
  }
  // gh CLI only: no third-party release action.
  for (const use of model.rawUses) {
    if (/release/i.test(use.action) && !use.action.startsWith("actions/")) {
      violations.push(`third-party release action ${use.action} is not allowed; use gh CLI`)
    }
  }
  return violations
}

/** Violations of the mandatory CI gate list (PR-10 §10). */
function ciGateViolations(model: WorkflowModel): string[] {
  const text = allJobText(model)
  const gates: { key: string; match: RegExp }[] = [
    { key: "clean install", match: /npm ci\b/ },
    { key: "full tests", match: /npm test\b/ },
    { key: "typecheck", match: /tsc --noEmit/ },
    { key: "host contract", match: /verify:host-contract/ },
    { key: "audit release gate", match: /audit:release|npm audit/ },
    { key: "build", match: /npm run build\b/ },
    { key: "exact dist inventory", match: /verify:dist|verify-dist/ },
    { key: "self-contained bundles", match: /no-splitting|chunk import|generatedChunkImport/ },
    { key: "TUI bundle check", match: /check:tui-bundle/ },
    { key: "CLI bundle/launcher check", match: /verify-cli-bundle/ },
    { key: "CLI smoke", match: /smoke:cli/ },
    { key: "installer/launcher shell syntax", match: /bash -n install\.sh/ },
    { key: "npm package allow-list", match: /verify:package|npm pack/ },
    { key: "release staging dry-run", match: /release:dry-run|release:stage/ },
    { key: "release-set checksum verification", match: /release:verify|SHA256SUMS/ },
    { key: "installer transactional fixture suite", match: /test\/release|installer.*fixture/i },
    { key: "same-commit reproducible-build check", match: /verify:reproducible-build|reproducible/i },
    { key: "git diff --check", match: /git diff --check/ },
    { key: "assert no tracked dist files", match: /git ls-files[^\n]*dist/ },
  ]
  const missing = gates.filter((g) => !g.match.test(text)).map((g) => g.key)
  return missing.map((key) => `CI gate missing: ${key}`)
}

/** A release workflow must not run from an ordinary main push/PR (PR-10 §5.2/§6). */
function releaseExclusionViolations(model: WorkflowModel): string[] {
  const violations = releaseTriggerViolations(model)
  const permViolations = permissionViolations(model, ["contents"])
  // A release workflow running from branch push is itself the exclusion violation.
  return [...violations, ...permViolations]
}

describe("PR-10 workflow contract — parser behavior on fixtures (W1C-A0)", () => {
  it("parses triggers, permissions, jobs and raw uses from a valid CI fixture", () => {
    const model = loadFixture("ci.valid-pinned.yml")
    const triggers = getTriggerInfo(model.on)
    expect(triggers.pushBranches).toContain("main")
    expect(triggers.hasPullRequest).toBe(true)
    expect(parsePermissions(model.permissions).scopes).toEqual({ contents: "read" })
    expect(Object.keys(model.jobs)).toEqual(["verify"])
    expect(model.rawUses).toHaveLength(3)
  })

  it("recovers the human-readable tag comment next to each pinned SHA", () => {
    const model = loadFixture("ci.valid-pinned.yml")
    const checkout = model.rawUses.find((u) => u.action === "actions/checkout")
    expect(checkout?.comment).toBe("v6.0.2")
    const setupBun = model.rawUses.find((u) => u.action === "oven-sh/setup-bun")
    expect(setupBun?.comment).toBe("v2.2.0")
  })
})

describe("PR-10 action pinning contract (W1C-A1/A2/A3)", () => {
  const validFixture = loadFixture("ci.valid-pinned.yml")
  const mutableFixture = loadFixture("ci.mutable-tags.yml")

  it("accepts a workflow whose actions are pinned to verified full SHAs", () => {
    expect(pinViolations(validFixture)).toEqual([])
  })

  it("rejects mutable tag refs like actions/checkout@v4", () => {
    const violations = pinViolations(mutableFixture)
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("actions/checkout@v4"),
        expect.stringContaining("actions/setup-node@v4"),
        expect.stringContaining("oven-sh/setup-bun@v2"),
      ]),
    )
  })

  it("accepts the three known actions only at their exact verified SHAs", () => {
    for (const [action, sha] of Object.entries(VERIFIED_PINS)) {
      const uses = validFixture.rawUses.filter((u) => u.action === action)
      expect(uses.length).toBeGreaterThan(0)
      for (const use of uses) expect(use.ref).toBe(sha)
    }
  })

  it("CI and release workflows must pin every external action to a full commit SHA", () => {
    // Production release.yml does not exist yet → expected pre-PR-10 failure.
    const ciPath = pathFromRoot(".github/workflows/ci.yml")
    const ci = loadWorkflow(ciPath)
    expect(
      pinViolations(ci),
      "expected pre-PR-10 failure: ci.yml still uses mutable action tags; PR-10 Wave 6 must pin all Actions to full SHAs",
    ).toEqual([])

    const releasePath = pathFromRoot(".github/workflows/release.yml")
    expect(
      existsSync(releasePath),
      "expected pre-PR-10 failure: .github/workflows/release.yml does not exist yet; PR-10 Wave 6 must add it",
    ).toBe(true)
    if (existsSync(releasePath)) {
      const release = loadWorkflow(releasePath)
      expect(pinViolations(release)).toEqual([])
    }
  })

  it("no workflow may reference the deprecated Node-20 action tag line", () => {
    // Current production ci.yml uses actions/checkout@v4 / setup-node@v4 → fail.
    const ci = loadWorkflow(pathFromRoot(".github/workflows/ci.yml"))
    const mutableRefs = ci.rawUses.filter((u) => MUTABLE_REF_RE.test(u.ref))
    expect(
      mutableRefs.map((u) => `${u.action}@${u.ref}`),
      "expected pre-PR-10 failure: ci.yml still references mutable action tags; all must be full-SHA pinned",
    ).toEqual([])
  })
})

describe("PR-10 CI permissions and triggers (W1C-B1/B2/B4)", () => {
  it("CI has read-only permissions: no push/PR CI job receives write access", () => {
    const ci = loadWorkflow(pathFromRoot(".github/workflows/ci.yml"))
    const violations = permissionViolations(ci)
    expect(violations).toEqual([])
  })

  it("CI triggers on push to main and pull requests", () => {
    const ci = loadWorkflow(pathFromRoot(".github/workflows/ci.yml"))
    const triggers = getTriggerInfo(ci.on)
    expect(triggers.pushBranches).toContain("main")
    expect(triggers.hasPullRequest).toBe(true)
  })

  it("CI must not mutate GitHub Releases (no gh release mutation, no write token)", () => {
    const ci = loadWorkflow(pathFromRoot(".github/workflows/ci.yml"))
    const text = allJobText(ci)
    expect(/gh release (create|upload|edit|delete)/.test(text)).toBe(false)
    expect(/--clobber/.test(text)).toBe(false)
  })
})

describe("PR-10 CI mandatory release-validation gates (W1C-B3)", () => {
  const validFixture = loadFixture("ci.valid-pinned.yml")

  it("the known-good fixture contains every mandatory CI gate", () => {
    expect(ciGateViolations(validFixture)).toEqual([])
  })

  it("current ci.yml runs the complete dry-run release validation without mutating releases", () => {
    const ci = loadWorkflow(pathFromRoot(".github/workflows/ci.yml"))
    const missing = ciGateViolations(ci)
    expect(
      missing,
      `expected pre-PR-10 failure: ci.yml is missing mandatory PR-10 gates: ${missing.join(", ")}`,
    ).toEqual([])
  })
})

describe("PR-10 release workflow exclusion from main push/PR (W1C-C1/C2/C3)", () => {
  const validFixture = loadFixture("release.valid.yml")
  const branchTriggerFixture = loadFixture("release.branch-trigger.yml")

  it("a tag-only release workflow passes the exclusion contract", () => {
    expect(releaseExclusionViolations(validFixture)).toEqual([])
  })

  it("a release workflow triggered by branch push fails the exclusion contract", () => {
    const violations = releaseExclusionViolations(branchTriggerFixture)
    expect(violations).toEqual(
      expect.arrayContaining([expect.stringContaining("branch push")]),
    )
  })

  it("release workflow exists and triggers only from version tags, never from main push/PR", () => {
    const releasePath = pathFromRoot(".github/workflows/release.yml")
    expect(
      existsSync(releasePath),
      "expected pre-PR-10 failure: .github/workflows/release.yml does not exist yet; a tag-only release workflow is required (PR-10 §6)",
    ).toBe(true)
    if (existsSync(releasePath)) {
      const release = loadWorkflow(releasePath)
      const triggers = getTriggerInfo(release.on)
      expect(triggers.pushTags.some((t) => /^v\*.*\*$/.test(t))).toBe(true)
      expect(triggers.pushBranches).toEqual([])
      expect(triggers.hasPullRequest).toBe(false)
    }
  })

  it("no release mutation step appears in the ordinary push/PR CI workflow", () => {
    const ci = loadWorkflow(pathFromRoot(".github/workflows/ci.yml"))
    expect(allJobText(ci)).not.toMatch(/gh release (create|upload|edit)/)
  })
})

describe("PR-10 release workflow permissions, publication, tooling (W1C-C4..C10)", () => {
  const validFixture = loadFixture("release.valid.yml")

  it("release permissions are minimal: contents: write only (no broader scopes)", () => {
    expect(permissionViolations(validFixture, ["contents"])).toEqual([])
  })

  it("release checkout uses fetch-depth 0 and persist-credentials false", () => {
    const model = loadFixture("release.valid.yml")
    const checkout = Object.values(model.jobs)[0].steps?.find(
      (s) => s.uses && s.uses.startsWith("actions/checkout@"),
    )
    expect(checkout?.with).toMatchObject({ "fetch-depth": 0, "persist-credentials": false })
  })

  it("release tooling is pinned: node 22.23.1, bun 1.3.14", () => {
    const model = loadFixture("release.valid.yml")
    const steps = Object.values(model.jobs)[0].steps ?? []
    const node = steps.find((s) => s.uses?.startsWith("actions/setup-node@"))
    const bun = steps.find((s) => s.uses?.startsWith("oven-sh/setup-bun@"))
    expect(node?.with).toMatchObject({ "node-version": "22.23.1" })
    expect(bun?.with).toMatchObject({ "bun-version": "1.3.14" })
  })

  it("release workflow is draft-first and verifies before publishing", () => {
    expect(releasePublicationViolations(validFixture)).toEqual([])
  })

  it("release workflow uses gh CLI and never a third-party release action or --clobber", () => {
    const violations = releasePublicationViolations(validFixture)
    expect(violations).toEqual([])
  })

  it("release workflow fails closed when immutable-release status cannot be proven", () => {
    const text = allJobText(validFixture)
    expect(/preflight|immutable/i.test(text)).toBe(true)
  })
})

describe("PR-10 release workflow permissions/pinning vs production (W1C-C4/C5)", () => {
  it("production release workflow permissions and action pinning", () => {
    const releasePath = pathFromRoot(".github/workflows/release.yml")
    expect(
      existsSync(releasePath),
      "expected pre-PR-10 failure: .github/workflows/release.yml does not exist yet; cannot verify release permissions/pinning until PR-10 Wave 6",
    ).toBe(true)
    if (existsSync(releasePath)) {
      const release = loadWorkflow(releasePath)
      expect(permissionViolations(release, ["contents"])).toEqual([])
      expect(pinViolations(release)).toEqual([])
    }
  })
})
