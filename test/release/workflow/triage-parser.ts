/**
 * PR-10 dependency audit policy parser (Wave 1, Agent 1C).
 *
 * Freezes the triage schema required by PR-10 §9.1. Every advisory/finding row
 * in `docs/CRIP/PR-10/dependency-audit.md` must record:
 *
 *   advisory/package
 *   severity
 *   direct or transitive
 *   dependency path(s)
 *   dev/build/runtime scope
 *   bundled into released JS? yes/no
 *   executed during release build? yes/no
 *   known reachability in TokenMaxxer
 *   non-breaking remediation available?
 *   action taken
 *   residual risk if retained
 *
 * The parser is behavioral: it validates a Markdown table against that exact
 * schema and reports per-row violations. Test-only code.
 */

export const REQUIRED_TRIAGE_FIELDS = [
  "advisory/package",
  "severity",
  "direct or transitive",
  "dependency path(s)",
  "dev/build/runtime scope",
  "bundled into released js?",
  "executed during release build?",
  "known reachability in tokenmaxxer",
  "non-breaking remediation available?",
  "action taken",
  "residual risk if retained",
] as const

export const VALID_SEVERITIES = ["low", "moderate", "high", "critical"]

export interface TriageRow {
  /** 0-based line index in the document. */
  line: number
  cells: string[]
}

export interface TriageParseResult {
  headerFound: boolean
  headerLine?: number
  rows: TriageRow[]
  violations: string[]
}

function normalizeCell(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, " ")
}

function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return body.split("|").map((c) => c.trim())
}

export function parseTriageTable(markdown: string): TriageParseResult {
  const lines = markdown.split(/\r?\n/)
  const result: TriageParseResult = { headerFound: false, rows: [], violations: [] }

  let headerCells: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim().startsWith("|")) continue

    // A separator row (`| --- | --- |`) is the signal that the previous line
    // was the header.
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-")) {
      const headerCandidate = i > 0 ? lines[i - 1] : ""
      if (!headerCandidate.trim().startsWith("|")) continue
      headerCells = splitRow(headerCandidate)
      result.headerLine = i - 1
      result.headerFound = true

      const expected = REQUIRED_TRIAGE_FIELDS.map(normalizeCell)
      const actual = headerCells.map(normalizeCell)
      if (actual.length !== expected.length) {
        result.violations.push(
          `header must have exactly ${expected.length} columns (got ${actual.length})`,
        )
      } else {
        for (let c = 0; c < expected.length; c += 1) {
          if (actual[c] !== expected[c]) {
            result.violations.push(
              `header column ${c + 1} must be "${REQUIRED_TRIAGE_FIELDS[c]}", got "${headerCells[c]}"`,
            )
          }
        }
      }

      // Collect following data rows.
      for (let j = i + 1; j < lines.length; j += 1) {
        const rowLine = lines[j]
        const trimmed = rowLine.trim()
        if (trimmed === "") continue
        if (!trimmed.startsWith("|")) break
        if (/^\|?[\s:|-]+\|?\s*$/.test(trimmed) && trimmed.includes("-")) continue
        const cells = splitRow(trimmed)
        result.rows.push({ line: j, cells })
      }
      break
    }
  }

  if (!result.headerFound) {
    result.violations.push("no triage table with a header row was found")
    return result
  }

  for (const row of result.rows) {
    const missing = REQUIRED_TRIAGE_FIELDS.filter((_, c) => !row.cells[c]?.trim())
    if (missing.length > 0) {
      result.violations.push(
        `row at line ${row.line + 1} is missing ${missing.length} required field(s)`,
      )
    }
    if (row.cells.length !== REQUIRED_TRIAGE_FIELDS.length) {
      result.violations.push(
        `row at line ${row.line + 1} must have ${REQUIRED_TRIAGE_FIELDS.length} cells (got ${row.cells.length})`,
      )
    }
    if (row.cells[1]) {
      const severity = normalizeCell(row.cells[1])
      if (!VALID_SEVERITIES.includes(severity)) {
        result.violations.push(
          `row at line ${row.line + 1} has invalid severity "${row.cells[1]}"`,
        )
      }
    }
    if (row.cells[2]) {
      const kind = normalizeCell(row.cells[2])
      if (kind !== "direct" && kind !== "transitive") {
        result.violations.push(
          `row at line ${row.line + 1} "direct or transitive" must be direct|transitive, got "${row.cells[2]}"`,
        )
      }
    }
    for (const [c, label] of [
      [5, "bundled into released JS?"],
      [6, "executed during release build?"],
    ] as const) {
      const cell = row.cells[c]
      if (cell) {
        const v = normalizeCell(cell)
        if (v !== "yes" && v !== "no") {
          result.violations.push(
            `row at line ${row.line + 1} "${label}" must be yes|no, got "${cell}"`,
          )
        }
      }
    }
  }

  return result
}

/**
 * Counts severities from an `npm audit --json` snapshot using the standard
 * `metadata.vulnerabilities` object. Returns zero counts when absent so the
 * policy gate fails loudly rather than silently passing.
 */
export function computeAuditSeverityCounts(auditJson: unknown): Record<string, number> {
  const counts: Record<string, number> = { low: 0, moderate: 0, high: 0, critical: 0 }
  if (!auditJson || typeof auditJson !== "object") return counts
  const metadata = (auditJson as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== "object") return counts
  const vuln = (metadata as { vulnerabilities?: unknown }).vulnerabilities
  if (!vuln || typeof vuln !== "object") return counts
  for (const severity of VALID_SEVERITIES) {
    const value = (vuln as Record<string, unknown>)[severity]
    if (typeof value === "number") counts[severity] = value
  }
  return counts
}

/** Package names reported by an `npm audit --json` snapshot. */
export function auditVulnerabilityPackages(auditJson: unknown): string[] {
  if (!auditJson || typeof auditJson !== "object") return []
  const vulnerabilities = (auditJson as { vulnerabilities?: unknown }).vulnerabilities
  if (!vulnerabilities || typeof vulnerabilities !== "object") return []
  return Object.keys(vulnerabilities as Record<string, unknown>).sort()
}
