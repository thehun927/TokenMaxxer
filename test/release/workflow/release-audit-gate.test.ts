/**
 * PR-10 residual R2 regression (Oracle final re-review, §191-228).
 *
 * The real tag workflow must rerun the COMPLETE committed dependency release
 * gate, not half of it. Ordinary CI runs `npm run audit:release` (which expands
 * to both `npm audit --audit-level=high` and
 * `npm audit --omit=dev --audit-level=low`); the tag-only release workflow must
 * invoke the exact same committed gate.
 *
 * This file is the focused contract regression: it freezes that ordinary CI and
 * the tag release workflow reference the same `audit:release` script, and that
 * the tag workflow never falls back to the standalone `npm audit
 * --audit-level=high` half-gate. It also guards that the R2 fix did not regress
 * the surrounding release contracts (tag-only trigger, immutable admin
 * credential, draft-first ordering, prepublish inventory/checksum verification,
 * postpublish `gh release verify`).
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import {
  allJobText,
  getTriggerInfo,
  loadWorkflow,
  pathFromRoot,
  type WorkflowModel,
} from "./workflow-parse"

const CI_PATH = pathFromRoot(".github/workflows/ci.yml")
const RELEASE_PATH = pathFromRoot(".github/workflows/release.yml")
const PACKAGE_PATH = pathFromRoot("package.json")

function auditSteps(model: WorkflowModel): string[] {
  return Object.values(model.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run ?? "")
    .filter((run) => /npm (run )?audit/.test(run))
}

describe("PR-10 residual R2 — complete release-audit gate parity (W1C-R2)", () => {
  const ci = loadWorkflow(CI_PATH)
  const release = loadWorkflow(RELEASE_PATH)

  it("commits audit:release as the single source of truth for the release-audit gate", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as { scripts?: Record<string, string> }
    const gate = pkg.scripts?.["audit:release"] ?? ""
    expect(gate).toContain("npm audit --audit-level=high")
    expect(gate).toContain("npm audit --omit=dev --audit-level=low")
  })

  it("ordinary CI invokes npm run audit:release", () => {
    const runs = auditSteps(ci)
    expect(runs.some((run) => /npm run audit:release/.test(run))).toBe(true)
  })

  it("tag release workflow invokes npm run audit:release", () => {
    const runs = auditSteps(release)
    expect(runs.some((run) => /npm run audit:release/.test(run))).toBe(true)
  })

  it("ordinary CI and tag release invoke the same committed release-audit gate", () => {
    const ciGate = auditSteps(ci).find((run) => /npm run audit:release/.test(run))
    const releaseGate = auditSteps(release).find((run) => /npm run audit:release/.test(run))
    expect(ciGate).toBeDefined()
    expect(releaseGate).toBeDefined()
    // Both must reference the committed script verbatim, never inline audit flags.
    expect(ciGate).toMatch(/(^|\n)[^\n]*npm run audit:release[^\n]*(\n|$)/)
    expect(releaseGate).toMatch(/(^|\n)[^\n]*npm run audit:release[^\n]*(\n|$)/)
  })

  it("tag release workflow never falls back to the standalone half-gate", () => {
    const runs = auditSteps(release)
    for (const run of runs) {
      expect(run).not.toMatch(/npm audit --audit-level=high/)
    }
  })
})

describe("PR-10 residual R2 — preserved release workflow contracts", () => {
  const release = loadWorkflow(RELEASE_PATH)
  const releaseText = readFileSync(RELEASE_PATH, "utf8")

  it("tag-only trigger is preserved (v*.*.*, no branch push/PR)", () => {
    const triggers = getTriggerInfo(release.on)
    expect(triggers.pushTags.some((t) => /^v\*.*\*$/.test(t))).toBe(true)
    expect(triggers.pushBranches).toEqual([])
    expect(triggers.hasPullRequest).toBe(false)
  })

  it("immutable admin credential is preserved and fails closed", () => {
    expect(releaseText).toContain("RELEASE_ADMIN_TOKEN")
    expect(releaseText).toContain("GH_TOKEN: ${{ secrets.RELEASE_ADMIN_TOKEN }}")
    expect(releaseText).toContain(": \"${GH_TOKEN:?secrets.RELEASE_ADMIN_TOKEN")
  })

  it("draft-first ordering is preserved", () => {
    const steps = Object.values(release.jobs)[0]?.steps ?? []
    const draftIndex = steps.findIndex((s) => (s.run ?? "").includes("--draft") && !(s.run ?? "").includes("draft=false"))
    const uploadIndex = steps.findIndex((s) => (s.run ?? "").includes("gh release upload"))
    const publishIndex = steps.findIndex((s) => (s.run ?? "").includes("--draft=false"))
    expect(draftIndex).toBeGreaterThanOrEqual(0)
    expect(uploadIndex).toBeGreaterThan(draftIndex)
    expect(publishIndex).toBeGreaterThan(uploadIndex)
  })

  it("prepublish inventory/checksum verification is preserved", () => {
    const text = allJobText(release)
    expect(text).toContain("gh release upload")
    expect(text).toContain(".release/RELEASE.json")
    expect(text).toContain("SHA256SUMS")
    expect(text).toContain("release:verify")
  })

  it("postpublish gh release verify is preserved", () => {
    expect(allJobText(release)).toContain("gh release verify")
  })
})
