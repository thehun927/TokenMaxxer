/**
 * PR-10 tag/package/commit identity validation contracts (Wave 1, Agent 1C).
 *
 * Freezes the release-preflight identity rules from PR-10 §4 and §6.2:
 *   - version is valid SemVer;
 *   - tag is exactly `v${package.version}`;
 *   - commit is exactly 40 lowercase hex;
 *   - peer range stays `>=1.18.15 <2.0.0`;
 *   - minimum verified host stays `1.18.15`;
 *   - RELEASE.json schema_version is exactly 1;
 *   - no release tag may exist before the independent Oracle Ship.
 *
 * The frozen validator is proven behaviorally on fixtures (valid and each
 * violation shape), then the same rules are asserted against production
 * `package.json`. `scripts/release-preflight.mjs` does not exist yet (Wave 4),
 * so the executable gate fails intentionally until it lands.
 */

import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import {
  EXPECTED_OPENCODE_MINIMUM,
  EXPECTED_OPENCODE_PEER,
  validateCommit,
  validateManifestIdentity,
  validateReleaseIdentity,
  validateTagMatchesVersion,
  validateVersion,
} from "./identity-contract"
import { pathFromRoot } from "./workflow-parse"

const execFileAsync = promisify(execFile)
const FIXTURES = fileURLToPath(new URL("./fixtures/release-identity/", import.meta.url))

const COMMIT_40 = "0123456789abcdef0123456789abcdef01234567"

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as unknown
}

describe("PR-10 release identity — frozen validator behavior on fixtures (W1C-I1..I5)", () => {
  it("accepts the fully valid release identity", () => {
    expect(validateManifestIdentity(loadFixture("valid.release.json"))).toEqual([])
    expect(
      validateReleaseIdentity({ version: "0.1.0", tag: "v0.1.0", commit: COMMIT_40 }),
    ).toEqual([])
  })

  it("rejects a tag that does not equal v${version}", () => {
    const violations = validateManifestIdentity(loadFixture("mismatched-tag.release.json"))
    expect(violations).toEqual([expect.objectContaining({ field: "tag" })])
    expect(validateTagMatchesVersion("v0.2.0", "0.1.0").length).toBeGreaterThan(0)
  })

  it("rejects a short commit", () => {
    const violations = validateManifestIdentity(loadFixture("short-commit.release.json"))
    expect(violations).toEqual([expect.objectContaining({ field: "commit" })])
    expect(validateCommit("abc123").length).toBeGreaterThan(0)
  })

  it("rejects a non-lowercase/non-hex commit", () => {
    const violations = validateManifestIdentity(loadFixture("nonhex-commit.release.json"))
    expect(violations).toEqual([expect.objectContaining({ field: "commit" })])
    expect(validateCommit("0123456789ABCDEF0123456789ABCDEF01234567").length).toBeGreaterThan(0)
  })

  it("accepts exactly 40 lowercase hex commit", () => {
    expect(validateCommit(COMMIT_40)).toEqual([])
  })

  it("rejects a changed OpenCode peer range or minimum host", () => {
    const violations = validateManifestIdentity(loadFixture("wrong-peer.release.json"))
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "opencode_peer" }),
        expect.objectContaining({ field: "opencode_minimum_verified" }),
      ]),
    )
  })

  it("rejects a RELEASE.json with the wrong schema version", () => {
    const violations = validateManifestIdentity(loadFixture("wrong-schema.release.json"))
    expect(violations).toEqual([expect.objectContaining({ field: "schema_version" })])
  })

  it("rejects malformed SemVer versions", () => {
    expect(validateVersion("1.0")).toEqual([expect.objectContaining({ field: "version" })])
    expect(validateVersion("v1.0.0")).toEqual([expect.objectContaining({ field: "version" })])
    expect(validateVersion("0.1.0")).toEqual([])
  })
})

describe("PR-10 package identity contracts against production (W1C-I1..I5)", () => {
  const pkg = JSON.parse(readFileSync(pathFromRoot("package.json"), "utf8")) as {
    version: string
    peerDependencies: Record<string, string>
    devDependencies: Record<string, string>
  }

  it("package.json version is valid SemVer", () => {
    expect(validateVersion(pkg.version)).toEqual([])
  })

  it("v${version} is the exact release tag identity", () => {
    expect(`v${pkg.version}`).toBe(`v${pkg.version}`)
    expect(validateTagMatchesVersion(`v${pkg.version}`, pkg.version)).toEqual([])
    expect(validateReleaseIdentity({ version: pkg.version, tag: `v${pkg.version}`, commit: COMMIT_40 })).toEqual([])
  })

  it("OpenCode peer range stays >=1.18.15 <2.0.0", () => {
    expect(pkg.peerDependencies["@opencode-ai/plugin"]).toBe(EXPECTED_OPENCODE_PEER)
  })

  it("minimum verified dev/host pin stays 1.18.15", () => {
    expect(pkg.devDependencies["@opencode-ai/plugin"]).toBe(EXPECTED_OPENCODE_MINIMUM)
  })

  it("no release tag exists before the independent Oracle Ship", () => {
    const tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).trim()
    expect(tags.split(/\s+/).filter(Boolean), "PR-10 must never create a v* release tag during implementation").toEqual([])
  })
})

describe("PR-10 executable release preflight (W1C-I6/I7)", () => {
  it("scripts/release-preflight.mjs exists to enforce identity before publication", () => {
    const script = pathFromRoot("scripts/release-preflight.mjs")
    expect(
      existsSync(script),
      "expected pre-PR-10 failure: scripts/release-preflight.mjs does not exist yet; PR-10 Wave 4 must add the release preflight",
    ).toBe(true)
  })

  it("spawned release preflight accepts exact identity and rejects mismatches", async () => {
    const script = pathFromRoot("scripts/release-preflight.mjs")
    if (!existsSync(script)) {
      throw new Error(
        "expected pre-PR-10 failure: scripts/release-preflight.mjs must exist for behavioral validation (PR-10 Wave 4)",
      )
    }
    const pkg = JSON.parse(readFileSync(pathFromRoot("package.json"), "utf8")) as { version: string }

    const ok = await execFileAsync("node", [script, "--tag", `v${pkg.version}`, "--commit", COMMIT_40, "--dry-run"])
    expect(ok.stdout).toBeDefined()

    await expect(
      execFileAsync("node", [script, "--tag", "v9.9.9", "--commit", COMMIT_40, "--dry-run"]),
    ).rejects.toThrow()
    await expect(
      execFileAsync("node", [script, "--tag", `v${pkg.version}`, "--commit", "abc", "--dry-run"]),
    ).rejects.toThrow()
  })
})
