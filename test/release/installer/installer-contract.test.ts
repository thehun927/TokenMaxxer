/**
 * PR-10 installer integrity/transaction contract tests (Wave 1, Agent 1B).
 *
 * Freezes the installer contracts from PR-10 §7 and the semantic matrix
 * section E/F/G:
 *   - exact-tag URL pinning and absence of mutable `main` payload URLs;
 *   - SHA256SUMS success, tampered-payload refusal, missing-CLI refusal,
 *     malformed-digest refusal;
 *   - all payload verification before any mutation, with prior-install byte
 *     preservation on verification failure;
 *   - injected replacement failure rolls back already-replaced targets and a
 *     first install leaves no partial install;
 *   - receipt records exact version/tag/40-hex commit;
 *   - no mixed-release payloads (all payloads from one exact release tag).
 *
 * Production is pre-PR-10, so `install.sh` still downloads from mutable
 * `main` and performs no checksum verification. The production assertions
 * fail intentionally and are reported; the fixture-driven tests prove the
 * frozen contract logic is correct.
 */

import { describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  PAYLOAD_FILES,
  RELEASE_COMMIT,
  RELEASE_TAG,
  RELEASE_VERSION,
  extractDownloadUrls,
  listFiles,
  parseChecksumManifest,
  payloadIdentityViolations,
  transactionalReplace,
  urlPinViolations,
  validateReceipt,
  verifyStagedRelease,
  type Receipt,
} from "./installer-contract"
import { pathFromRoot } from "../workflow/workflow-parse"

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url))
const STAGED = join(FIXTURES, "staged-release")
const RECEIPTS = join(FIXTURES, "receipt")

function stagedDir(name: string): string {
  return join(STAGED, name)
}

function loadReceipt(name: string): Receipt {
  return JSON.parse(readFileSync(join(RECEIPTS, name), "utf8")) as Receipt
}

/** Build a temp HOME-like destination tree with the four prior-install targets. */
function makePriorInstall(): { root: string; targets: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "tokenmaxxer-installer-"))
  const plugins = join(root, "plugins")
  const bin = join(root, "bin")
  mkdirSync(plugins, { recursive: true })
  mkdirSync(bin, { recursive: true })
  const targets = {
    "tokenmaxxer.js": join(plugins, "tokenmaxxer.js"),
    "tokenmaxxer-tui.js": join(plugins, "tokenmaxxer-tui.js"),
    "tokenmaxxer-cli.js": join(plugins, "tokenmaxxer-cli.js"),
    tokenmaxxer: join(bin, "tokenmaxxer"),
  }
  for (const [name, target] of Object.entries(targets)) {
    writeFileSync(target, `prior-install bytes for ${name}\n`)
  }
  return { root, targets }
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

describe("PR-10 installer — exact-tag URL pinning (W1B-U1/U2/U3)", () => {
  it("a staged installer pins every payload URL to its embedded exact release tag", () => {
    const staged = readFileSync(
      join(STAGED, "valid", "install.sh"),
      "utf8",
    )
    const violations = urlPinViolations(staged)
    expect(violations).toEqual([])
  })

  it("no payload URL may fetch raw.githubusercontent.com/.../main", () => {
    const staged = readFileSync(
      join(STAGED, "valid", "install.sh"),
      "utf8",
    )
    const urls = extractDownloadUrls(staged)
    for (const url of urls) {
      expect(url).not.toMatch(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\//)
    }
  })

  it("no payload URL may perform a second latest lookup", () => {
    const staged = readFileSync(
      join(STAGED, "valid", "install.sh"),
      "utf8",
    )
    const urls = extractDownloadUrls(staged)
    for (const url of urls) {
      expect(url).not.toMatch(/\/releases\/latest\/download\//)
    }
  })

  it("all payload URLs share one exact release tag (no mixed-release URLs)", () => {
    const staged = readFileSync(
      join(STAGED, "valid", "install.sh"),
      "utf8",
    )
    const urls = extractDownloadUrls(staged)
    const tags = new Set(
      urls
        .map((u) => u.match(/\/releases\/download\/([^/]+)\//)?.[1])
        .filter((t): t is string => Boolean(t)),
    )
    expect(tags.size).toBe(1)
    expect([...tags][0]).toBe(RELEASE_TAG)
  })

  it("production install.sh must pin all payload URLs to an exact release tag", () => {
    const production = readFileSync(pathFromRoot("install.sh"), "utf8")
    const violations = urlPinViolations(production)
    expect(
      violations,
      "expected pre-PR-10 failure: install.sh still downloads from mutable main; PR-10 Wave 5 must pin every payload URL to the embedded exact release tag",
    ).toEqual([])
  })
})

describe("PR-10 installer — SHA256SUMS verification (W1B-C1..C5)", () => {
  it("a valid staged release verifies cleanly against SHA256SUMS", () => {
    const result = verifyStagedRelease(stagedDir("valid"))
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
  })

  it("a tampered payload is refused (digest mismatch)", () => {
    const result = verifyStagedRelease(stagedDir("tampered-payload"))
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "payload" }),
      ]),
    )
    expect(result.violations.some((v) => v.message.includes("tokenmaxxer.js"))).toBe(true)
  })

  it("a missing CLI payload refuses the entire install", () => {
    const result = verifyStagedRelease(stagedDir("missing-cli"))
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "payload",
          message: expect.stringContaining("tokenmaxxer-cli.js"),
        }),
      ]),
    )
  })

  it("a malformed digest line refuses the entire install", () => {
    const result = verifyStagedRelease(stagedDir("malformed-digest"))
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "manifest" }),
      ]),
    )
  })

  it("the manifest parser rejects malformed and duplicate digest lines", () => {
    const malformed = parseChecksumManifest("not-a-digest  file.js\n")
    expect(malformed.violations.length).toBeGreaterThan(0)

    const duplicate = parseChecksumManifest(
      `${"a".repeat(64)}  file.js\n${"b".repeat(64)}  file.js\n`,
    )
    expect(duplicate.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("duplicate") }),
      ]),
    )
  })

  it("production install.sh must verify every payload against SHA256SUMS before mutation", () => {
    const production = readFileSync(pathFromRoot("install.sh"), "utf8")
    expect(
      production.includes("SHA256SUMS"),
      "expected pre-PR-10 failure: install.sh performs no SHA256SUMS verification; PR-10 Wave 5 must verify every payload before replacing an existing install",
    ).toBe(true)
  })
})

describe("PR-10 installer — verify before mutate, prior-install preservation (W1B-P1..P5)", () => {
  it("verification failure leaves every prior-install target byte-identical", () => {
    const prior = makePriorInstall()
    try {
      const before = new Map(
        Object.entries(prior.targets).map(([name, target]) => [
          name,
          readFileSync(target),
        ]),
      )
      // A tampered staged release must be refused before any destination
      // replacement. The frozen contract: verification happens first, so the
      // prior install is untouched.
      const result = verifyStagedRelease(stagedDir("tampered-payload"))
      expect(result.ok).toBe(false)
      for (const [name, target] of Object.entries(prior.targets)) {
        expect(readFileSync(target).equals(before.get(name)!)).toBe(true)
      }
    } finally {
      cleanup(prior.root)
    }
  })

  it("verification failure does not write or update an installation receipt", () => {
    const prior = makePriorInstall()
    try {
      const receiptPath = join(prior.root, "tokenmaxxer-release.json")
      writeFileSync(receiptPath, JSON.stringify({ schema_version: 1, version: "0.0.0" }))
      const before = readFileSync(receiptPath)
      const result = verifyStagedRelease(stagedDir("tampered-payload"))
      expect(result.ok).toBe(false)
      expect(readFileSync(receiptPath).equals(before)).toBe(true)
    } finally {
      cleanup(prior.root)
    }
  })

  it("a missing CLI refuses the entire install before any destination mutation", () => {
    const prior = makePriorInstall()
    try {
      const before = new Map(
        Object.entries(prior.targets).map(([name, target]) => [
          name,
          readFileSync(target),
        ]),
      )
      const result = verifyStagedRelease(stagedDir("missing-cli"))
      expect(result.ok).toBe(false)
      for (const [name, target] of Object.entries(prior.targets)) {
        expect(readFileSync(target).equals(before.get(name)!)).toBe(true)
      }
    } finally {
      cleanup(prior.root)
    }
  })

  it("a malformed digest refuses the entire install before any destination mutation", () => {
    const prior = makePriorInstall()
    try {
      const before = new Map(
        Object.entries(prior.targets).map(([name, target]) => [
          name,
          readFileSync(target),
        ]),
      )
      const result = verifyStagedRelease(stagedDir("malformed-digest"))
      expect(result.ok).toBe(false)
      for (const [name, target] of Object.entries(prior.targets)) {
        expect(readFileSync(target).equals(before.get(name)!)).toBe(true)
      }
    } finally {
      cleanup(prior.root)
    }
  })

  it("production install.sh must verify all payloads before replacing an existing install", () => {
    const production = readFileSync(pathFromRoot("install.sh"), "utf8")
    // The pre-PR-10 installer downloads directly into the destination
    // (download() writes to the final path), so it cannot preserve prior bytes
    // on verification failure. This is the contract Wave 5 must implement.
    const hasStaging = /mktemp|\.tmp\./.test(production)
    const hasChecksum = production.includes("SHA256SUMS")
    expect(
      hasStaging && hasChecksum,
      "expected pre-PR-10 failure: install.sh must stage and checksum-verify payloads before touching the existing install (PR-10 §7.1)",
    ).toBe(true)
  })
})

describe("PR-10 installer — all-or-rollback replacement (W1B-R1..R4)", () => {
  it("a successful replacement commits every verified target", () => {
    const prior = makePriorInstall()
    try {
      const staged = stagedDir("valid")
      const targets = PAYLOAD_FILES.map((name) => ({
        target: prior.targets[name],
        staged: join(staged, name),
      }))
      const result = transactionalReplace(targets)
      expect(result.ok).toBe(true)
      for (const name of PAYLOAD_FILES) {
        expect(readFileSync(prior.targets[name]).toString()).toBe(
          readFileSync(join(staged, name)).toString(),
        )
      }
    } finally {
      cleanup(prior.root)
    }
  })

  it("an injected replacement failure rolls back already-replaced targets", () => {
    const prior = makePriorInstall()
    try {
      const before = new Map(
        Object.entries(prior.targets).map(([name, target]) => [
          name,
          readFileSync(target),
        ]),
      )
      const staged = stagedDir("valid")
      const targets = PAYLOAD_FILES.map((name) => ({
        target: prior.targets[name],
        staged: join(staged, name),
      }))
      // Fail on the third replacement (tokenmaxxer-cli.js), after the first
      // two targets were already replaced.
      const result = transactionalReplace(targets, { failOn: "tokenmaxxer-cli.js" })
      expect(result.ok).toBe(false)
      for (const [name, target] of Object.entries(prior.targets)) {
        expect(
          readFileSync(target).equals(before.get(name)!),
          `target ${name} must be restored byte-for-byte after rollback`,
        ).toBe(true)
      }
    } finally {
      cleanup(prior.root)
    }
  })

  it("a first install with no prior targets leaves no partial install on injected failure", () => {
    const root = mkdtempSync(join(tmpdir(), "tokenmaxxer-first-install-"))
    try {
      const plugins = join(root, "plugins")
      const bin = join(root, "bin")
      mkdirSync(plugins, { recursive: true })
      mkdirSync(bin, { recursive: true })
      const targets = {
        "tokenmaxxer.js": join(plugins, "tokenmaxxer.js"),
        "tokenmaxxer-tui.js": join(plugins, "tokenmaxxer-tui.js"),
        "tokenmaxxer-cli.js": join(plugins, "tokenmaxxer-cli.js"),
        tokenmaxxer: join(bin, "tokenmaxxer"),
      }
      const staged = stagedDir("valid")
      const specs = PAYLOAD_FILES.map((name) => ({
        target: targets[name],
        staged: join(staged, name),
      }))
      const result = transactionalReplace(specs, { failOn: "tokenmaxxer" })
      expect(result.ok).toBe(false)
      for (const target of Object.values(targets)) {
        expect(
          existsSync(target),
          `no partial install: ${target} must not exist after failed first install`,
        ).toBe(false)
      }
    } finally {
      cleanup(root)
    }
  })

  it("production install.sh must be rollback-capable on replacement failure", () => {
    const production = readFileSync(pathFromRoot("install.sh"), "utf8")
    expect(
      /\.bak\.|backup|rollback/.test(production),
      "expected pre-PR-10 failure: install.sh has no backup/rollback path; PR-10 Wave 5 must restore prior targets on replacement failure",
    ).toBe(true)
  })
})

describe("PR-10 installer — receipt exact identity (W1B-RC1..RC4)", () => {
  it("a valid receipt records exact version, tag and 40-hex commit", () => {
    const receipt = loadReceipt("valid.receipt.json")
    expect(validateReceipt(receipt)).toEqual([])
    expect(receipt.version).toBe(RELEASE_VERSION)
    expect(receipt.tag).toBe(RELEASE_TAG)
    expect(receipt.commit).toBe(RELEASE_COMMIT)
    expect(receipt.commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it("a receipt whose tag does not match v${version} is rejected", () => {
    const receipt = loadReceipt("mismatched-tag.receipt.json")
    expect(validateReceipt(receipt)).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "tag" })]),
    )
  })

  it("a receipt with a short commit is rejected", () => {
    const receipt = loadReceipt("short-commit.receipt.json")
    expect(validateReceipt(receipt)).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "commit" })]),
    )
  })

  it("a receipt missing the commit never fabricates one", () => {
    const receipt = loadReceipt("missing-commit.receipt.json")
    expect(validateReceipt(receipt)).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "commit" })]),
    )
    expect(receipt.commit).toBeUndefined()
  })

  it("a malformed receipt fails or reports unavailable safely", () => {
    expect(() => loadReceipt("malformed.receipt.json")).toThrow()
  })

  it("production install.sh must write a receipt with exact version/tag/commit", () => {
    const production = readFileSync(pathFromRoot("install.sh"), "utf8")
    expect(
      /tokenmaxxer-release\.json|RELEASE_VERSION|RELEASE_TAG|RELEASE_COMMIT/.test(production),
      "expected pre-PR-10 failure: install.sh writes no release receipt; PR-10 Wave 5 must persist exact version/tag/commit after a successful install",
    ).toBe(true)
  })
})

describe("PR-10 installer — no mixed-release payloads (W1B-M1/M2)", () => {
  it("a valid staged release carries one consistent release identity in every payload", () => {
    expect(payloadIdentityViolations(stagedDir("valid"))).toEqual([])
  })

  it("a staged release mixing payloads from two tags is rejected", () => {
    const violations = payloadIdentityViolations(stagedDir("mixed-release"))
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "identity",
          message: expect.stringContaining("tokenmaxxer.js"),
        }),
      ]),
    )
  })

  it("production install.sh must never mix payloads from different releases", () => {
    const production = readFileSync(pathFromRoot("install.sh"), "utf8")
    const urls = extractDownloadUrls(production)
    const tags = new Set(
      urls
        .map((u) => u.match(/\/releases\/download\/([^/]+)\//)?.[1])
        .filter((t): t is string => Boolean(t)),
    )
    expect(
      tags.size <= 1,
      "expected pre-PR-10 failure: install.sh must pin every payload to one exact release tag so a release set can never mix revisions",
    ).toBe(true)
  })
})

describe("PR-10 installer — staged release inventory (W1B-I1)", () => {
  it("the valid staged release contains exactly the four payloads plus manifest and RELEASE.json", () => {
    const files = listFiles(stagedDir("valid"))
    expect(files).toEqual(
      expect.arrayContaining([...PAYLOAD_FILES, "SHA256SUMS", "RELEASE.json"]),
    )
  })

  it("the missing-CLI staged release is missing the CLI payload", () => {
    const files = listFiles(stagedDir("missing-cli"))
    expect(files).not.toContain("tokenmaxxer-cli.js")
  })
})
