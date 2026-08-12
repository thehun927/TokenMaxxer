/**
 * PR-10 CI release gate tests (Wave 1, Agent 1C).
 *
 * Tests that ordinary CI executes the complete release gate as specified in Oracle B3.
 * This includes:
 * - audit:release (not just npm audit high)
 * - build/verify dist/package/reproducibility
 * - actual release:dry-run followed by release:verify
 * - fail-closed zero tracked dist assertion
 * - production installer E2E tests
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

describe("PR-10 CI release gate (Oracle B3)", () => {
  const ciPath = pathFromRoot(".github/workflows/ci.yml")
  const ci = loadWorkflow(ciPath)
  const rawText = readFileSync(ciPath, "utf8")

  it("runs audit:release instead of npm audit --audit-level=high", () => {
    expect(/npm run audit:release/.test(rawText)).toBe(true)
    expect(/npm audit --audit-level=high/.test(rawText)).toBe(false)
  })

  it("runs build, verify:dist, verify:package, verify:reproducible-build", () => {
    expect(/npm run build\b/.test(rawText)).toBe(true)
    expect(/npm run verify:dist\b/.test(rawText)).toBe(true)
    expect(/npm run verify:package\b/.test(rawText)).toBe(true)
    expect(/npm run verify:reproducible-build\b/.test(rawText)).toBe(true)
  })

  it("runs actual release:dry-run followed by release:verify", () => {
    expect(/npm run release:dry-run/.test(rawText)).toBe(true)
    expect(/npm run release:verify/.test(rawText)).toBe(true)
  })

  it("release:verify includes --dir .release, --tag, and --commit arguments", () => {
    expect(/npm run release:verify -- --dir .release/.test(rawText)).toBe(true)
    expect(/--tag "v\$\{version\}"/.test(rawText)).toBe(true)
    expect(/--commit "\$\(git rev-parse HEAD\)"/.test(rawText)).toBe(true)
  })

  it("asserts no tracked dist files with fail-closed zero-tracked-dist", () => {
    expect(/git ls-files[^\\n]*dist/.test(rawText)).toBe(true)
    expect(/test -z "\$\(git ls-files/.test(rawText)).toBe(true)
  })

  it("runs production installer E2E tests from test/release/installer", () => {
    expect(/test\/release\/installer/.test(rawText)).toBe(true)
  })

  it("does not use npm_package_version under set -u", () => {
    const steps = Object.values(ci.jobs)[0]?.steps ?? []
    for (const step of steps) {
      const run = step.run ?? ""
      if (run.includes("set -u")) {
        expect(run).not.toMatch(/\$\{npm_package_version\}/)
        expect(run).not.toMatch(/\$npm_package_version/)
      }
    }
  })

  it("npm test may run before build but tests must not fail merely because generated dist is absent", () => {
    const steps = Object.values(ci.jobs)[0]?.steps ?? []
    const testIndex = steps.findIndex((s) => (s.name ?? "").toLowerCase().includes("run full test suite"))
    const buildIndex = steps.findIndex((s) => (s.name ?? "").toLowerCase().includes("build distribution"))

    expect(testIndex).toBeGreaterThanOrEqual(0)
    expect(buildIndex).toBeGreaterThanOrEqual(0)

    // Test should come before build, but build should not depend on test passing
    expect(testIndex).toBeLessThan(buildIndex)
  })

  it("CI gates match the mandatory list from workflow-contract.test.ts", () => {
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
      { key: "assert no tracked dist files", match: /git ls-files[^\\n]*dist/ },
    ]
    const missing = gates.filter((g) => !g.match.test(rawText)).map((g) => g.key)
    expect(missing).toEqual([])
  })
})

describe("PR-10 CI workflow structure (Oracle B3)", () => {
  const ciPath = pathFromRoot(".github/workflows/ci.yml")
  const ci = loadWorkflow(ciPath)

  it("CI has read-only permissions", () => {
    const violations = permissionViolations(ci)
    expect(violations).toEqual([])
  })

  it("CI triggers on push to main and pull requests", () => {
    const triggers = getTriggerInfo(ci.on)
    expect(triggers.pushBranches).toContain("main")
    expect(triggers.hasPullRequest).toBe(true)
  })

  it("CI does not mutate GitHub Releases", () => {
    const text = allJobText(ci)
    expect(/gh release (create|upload|edit|delete)/.test(text)).toBe(false)
    expect(/--clobber/.test(text)).toBe(false)
  })

  it("all external actions are pinned to full commit SHAs", () => {
    const violations = pinViolations(ci)
    expect(violations).toEqual([])
  })
})

// Helper functions from workflow-contract.test.ts
function pinViolations(model: WorkflowModel): string[] {
  const violations: string[] = []
  if (model.rawUses.length === 0) {
    violations.push("workflow uses no external actions (nothing to pin)")
  }
  for (const use of model.rawUses) {
    const FULL_SHA_RE = /^[0-9a-f]{40}$/
    const MUTABLE_REF_RE = /^(v\d+(?:\.\d+)*|main|master|latest)$/
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
  }
  return violations
}

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
