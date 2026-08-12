/**
 * PR-10 dependency audit policy tests (Wave 1, Agent 1C).
 *
 * Freezes the dependency policy from PR-10 §9:
 *   - raw `npm audit --json` snapshot committed at
 *     `docs/CRIP/PR-10/dependency-audit.json`;
 *   - human triage at `docs/CRIP/PR-10/dependency-audit.md` covering every
 *     finding with all §9.1 fields;
 *   - severity gate: no unresolved high/critical (full-tree audit-level=high
 *     must pass), and production scope (`--omit=dev --audit-level=low`) clean;
 *   - `npm audit fix --force` is never policy.
 *
 * The parser/triage schema is proven behaviorally on fixtures. The production
 * audit artifacts do not exist yet (Wave 2), so those assertions fail
 * intentionally until the snapshot and triage are committed.
 */

import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import {
  auditVulnerabilityPackages,
  computeAuditSeverityCounts,
  parseTriageTable,
} from "./triage-parser"
import { pathFromRoot } from "./workflow-parse"

const DEP_POLICY_FIXTURES = fileURLToPath(new URL("./fixtures/dependency-policy/", import.meta.url))

function readFixture(name: string): string {
  return readFileSync(resolve(DEP_POLICY_FIXTURES, name), "utf8")
}

describe("PR-10 dependency triage schema parser — fixture behavior (W1C-D4)", () => {
  it("accepts a triage table with every required field on every row", () => {
    const result = parseTriageTable(readFixture("triage.valid.md"))
    expect(result.headerFound).toBe(true)
    expect(result.rows).toHaveLength(4)
    expect(result.violations).toEqual([])
  })

  it("rejects rows that omit required fields or use invalid values", () => {
    const result = parseTriageTable(readFixture("triage.missing-field.md"))
    expect(result.headerFound).toBe(true)
    expect(result.rows).toHaveLength(3)
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations.join("\n")).toMatch(/missing \d+ required field/)
    expect(result.violations.join("\n")).toMatch(/invalid severity/)
  })

  it("parses severity counts from an npm audit snapshot", () => {
    const audit = JSON.parse(readFixture("audit.sample.json")) as unknown
    expect(computeAuditSeverityCounts(audit)).toEqual({
      low: 1,
      moderate: 1,
      high: 0,
      critical: 0,
    })
    expect(auditVulnerabilityPackages(audit)).toEqual(["esbuild", "undici"])
  })
})

describe("PR-10 dependency snapshot gate (W1C-D1/D2)", () => {
  const auditPath = pathFromRoot("docs/CRIP/PR-10/dependency-audit.json")

  it("committed implementation-head npm audit snapshot exists", () => {
    expect(
      existsSync(auditPath),
      "expected pre-PR-10 failure: docs/CRIP/PR-10/dependency-audit.json must be committed (PR-10 Wave 2)",
    ).toBe(true)
  })

  it("snapshot parses as npm audit JSON and severity counts are present", () => {
    if (!existsSync(auditPath)) {
      throw new Error(
        "expected pre-PR-10 failure: dependency-audit.json missing; cannot parse severity counts until PR-10 Wave 2",
      )
    }
    const audit = JSON.parse(readFileSync(auditPath, "utf8")) as unknown
    const counts = computeAuditSeverityCounts(audit)
    expect(counts).toHaveProperty("low")
    expect(counts).toHaveProperty("moderate")
    expect(counts).toHaveProperty("high")
    expect(counts).toHaveProperty("critical")
  })
})

describe("PR-10 dependency triage coverage and policy gate (W1C-D3/D5/D6)", () => {
  const triagePath = pathFromRoot("docs/CRIP/PR-10/dependency-audit.md")

  it("committed human triage document exists", () => {
    expect(
      existsSync(triagePath),
      "expected pre-PR-10 failure: docs/CRIP/PR-10/dependency-audit.md must be committed (PR-10 Wave 2)",
    ).toBe(true)
  })

  it("every snapshot finding appears in the triage with a disposition", () => {
    const auditPath = pathFromRoot("docs/CRIP/PR-10/dependency-audit.json")
    if (!existsSync(triagePath) || !existsSync(auditPath)) {
      throw new Error(
        "expected pre-PR-10 failure: dependency audit artifacts missing until PR-10 Wave 2",
      )
    }
    const audit = JSON.parse(readFileSync(auditPath, "utf8")) as unknown
    const triage = parseTriageTable(readFileSync(triagePath, "utf8"))
    expect(triage.violations).toEqual([])

    const packages = auditVulnerabilityPackages(audit)
    const triagedPackages = triage.rows.map((r) => r.cells[0].trim().toLowerCase())
    for (const pkg of packages) {
      expect(
        triagedPackages.some((name) => name.includes(pkg.toLowerCase())),
        `finding for ${pkg} must have a triage row`,
      ).toBe(true)
    }
  })

  it("no unresolved high or critical severity remains in the snapshot", () => {
    const auditPath = pathFromRoot("docs/CRIP/PR-10/dependency-audit.json")
    if (!existsSync(auditPath)) {
      throw new Error(
        "expected pre-PR-10 failure: dependency-audit.json missing; high/critical gate cannot pass until PR-10 Wave 2",
      )
    }
    const audit = JSON.parse(readFileSync(auditPath, "utf8")) as unknown
    const counts = computeAuditSeverityCounts(audit)
    expect(counts.high, "PR-10 §9.2 requires zero unresolved high advisories").toBe(0)
    expect(counts.critical, "PR-10 §9.2 requires zero unresolved critical advisories").toBe(0)
  })

  it("the frozen policy gate rejects a snapshot that still has high/critical findings", () => {
    const high = {
      metadata: { vulnerabilities: { low: 0, moderate: 0, high: 1, critical: 0 } },
      vulnerabilities: {},
    }
    const counts = computeAuditSeverityCounts(high)
    expect(counts.high).toBe(1)
    expect(counts.high === 0).toBe(false)
  })
})

describe("PR-10 dependency remediation policy (W1C-D6)", () => {
  it("package.json contains no npm audit fix --force as policy", () => {
    const pkg = readFileSync(pathFromRoot("package.json"), "utf8")
    expect(pkg).not.toMatch(/audit fix --force/)
  })
})
