#!/usr/bin/env node
/**
 * PR-10 Wave 2: Release Preflight Lifecycle Validator
 *
 * Enforces strict identity checks before publication:
 *   - version is valid SemVer
 *   - tag is exactly `v${package.version}`
 *   - commit is exactly 40 lowercase hex
 *   - peer range stays `>=1.18.15 <2.0.0`
 *   - minimum verified host stays `1.18.15`
 *   - RELEASE.json schema_version is exactly 1
 *
 * Two validation modes:
 *   --dry-run: Proposed-release identity check (no tag mutation, no ancestry checks)
 *   --require-main-ancestor: Real publication mode (validates requested tag target and ancestry)
 *
 * Usage:
 *   node scripts/release-preflight.mjs --tag v0.1.0 --commit 0123456789abcdef0123456789abcdef01234567 --dry-run
 *   node scripts/release-preflight.mjs --tag v0.1.0 --commit 0123456789abcdef0123456789abcdef01234567 --require-main-ancestor
 *
 * Returns exit code 0 on success, 1 on failure.
 */

import { existsSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")
const PACKAGE_JSON = resolve(ROOT, "package.json")

const EXPECTED_OPENCODE_PEER = ">=1.18.15 <2.0.0"
const EXPECTED_OPENCODE_MINIMUM = "1.18.15"
const RELEASE_MANIFEST_SCHEMA_VERSION = 1
const COMMIT_RE = /^[0-9a-f]{40}$/

function validateVersion(version) {
  if (typeof version !== "string" || version.trim() === "") {
    return [{ field: "version", message: "version is required" }]
  }
  const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  if (!SEMVER_RE.test(version)) {
    return [{ field: "version", message: `version "${version}" is not valid SemVer` }]
  }
  return []
}

function validateTagMatchesVersion(tag, version) {
  const expected = `v${version}`
  if (tag !== expected) {
    return [
      {
        field: "tag",
        message: `tag "${tag}" must exactly equal "v${version}" (= v${version})`,
      },
    ]
  }
  return []
}

function validateCommit(commit) {
  if (typeof commit !== "string" || commit.trim() === "") {
    return [{ field: "commit", message: "commit is required" }]
  }
  if (!COMMIT_RE.test(commit)) {
    return [
      {
        field: "commit",
        message: `commit "${commit}" must be exactly 40 lowercase hex characters`,
      },
    ]
  }
  return []
}

function validatePeerRange(peer) {
  if (peer !== EXPECTED_OPENCODE_PEER) {
    return [
      {
        field: "opencode_peer",
        message: `opencode_peer must be "${EXPECTED_OPENCODE_PEER}", got "${peer}"`,
      },
    ]
  }
  return []
}

function validateMinimumVerified(minimum) {
  if (minimum !== EXPECTED_OPENCODE_MINIMUM) {
    return [
      {
        field: "opencode_minimum_verified",
        message: `opencode_minimum_verified must be "${EXPECTED_OPENCODE_MINIMUM}", got "${minimum}"`,
      },
    ]
  }
  return []
}

function validateReleaseIdentity(input) {
  const violations = [
    ...validateVersion(input.version),
    ...validateTagMatchesVersion(input.tag, input.version),
    ...validateCommit(input.commit),
  ]
  if (input.opencodePeer !== undefined) violations.push(...validatePeerRange(input.opencodePeer))
  if (input.opencodeMinimumVerified !== undefined) {
    violations.push(...validateMinimumVerified(input.opencodeMinimumVerified))
  }
  return violations
}

function parseManifestIdentity(raw) {
  if (!raw || typeof raw !== "object") return null
  const obj = raw
  if (
    typeof obj.schema_version !== "number" ||
    typeof obj.version !== "string" ||
    typeof obj.tag !== "string" ||
    typeof obj.commit !== "string"
  ) {
    return null
  }
  return {
    schema_version: obj.schema_version,
    version: obj.version,
    tag: obj.tag,
    commit: obj.commit,
    opencode_peer: typeof obj.opencode_peer === "string" ? obj.opencode_peer : "",
    opencode_minimum_verified:
      typeof obj.opencode_minimum_verified === "string"
        ? obj.opencode_minimum_verified
        : "",
  }
}

function validateManifestIdentity(raw) {
  const manifest = parseManifestIdentity(raw)
  if (!manifest) {
    return [{ field: "manifest", message: "RELEASE.json identity fields are missing or malformed" }]
  }
  const violations = []
  if (manifest.schema_version !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    violations.push({
      field: "schema_version",
      message: `RELEASE.json schema_version must be ${RELEASE_MANIFEST_SCHEMA_VERSION}, got ${manifest.schema_version}`,
    })
  }
  violations.push(
    ...validateReleaseIdentity({
      version: manifest.version,
      tag: manifest.tag,
      commit: manifest.commit,
      opencodePeer: manifest.opencode_peer,
      opencodeMinimumVerified: manifest.opencode_minimum_verified,
    }),
  )
  return violations
}

function validatePackageIdentity(pkg) {
  const violations = []

  // Validate peerDependencies
  const peerDeps = pkg.peerDependencies
  if (!peerDeps) {
    violations.push({ field: "peerDependencies", message: "peerDependencies is required" })
  } else {
    const opencodePeer = peerDeps["@opencode-ai/plugin"]
    if (opencodePeer === undefined) {
      violations.push({ field: "peerDependencies", message: "@opencode-ai/plugin peer dependency is required" })
    } else {
      violations.push(...validatePeerRange(opencodePeer))
    }
  }

  // Validate devDependencies
  const devDeps = pkg.devDependencies
  if (!devDeps) {
    violations.push({ field: "devDependencies", message: "devDependencies is required" })
  } else {
    const opencodeMinimum = devDeps["@opencode-ai/plugin"]
    if (opencodeMinimum === undefined) {
      violations.push({ field: "devDependencies", message: "@opencode-ai/plugin dev dependency is required" })
    } else {
      violations.push(...validateMinimumVerified(opencodeMinimum))
    }
  }

  return violations
}

function validateRequestedTag(tag, commit) {
  const violations = []

  // Validate requested tag exists and resolves to exact commit
  try {
    const target = execFileSync("git", ["rev-list", "-n1", tag], { encoding: "utf8" }).trim()
    if (target !== commit) {
      violations.push({ field: "tag", message: `tag ${tag} targets ${target}, expected ${commit}` })
    }
  } catch {
    violations.push({ field: "tag", message: `tag ${tag} is not available in the checkout` })
  }

  // Validate commit is reachable from origin/main (publication mode only)
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, "origin/main"])
  } catch {
    violations.push({ field: "commit", message: "tagged commit is not reachable from origin/main" })
  }

  return violations
}

function main() {
  const args = process.argv.slice(2)

  // Parse command-line arguments
  let tag = null
  let commit = null
  const dryRun = args.includes("--dry-run")
  const requireMainAncestor = args.includes("--require-main-ancestor")

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--tag" && args[i + 1] && !args[i + 1].startsWith("--")) {
      tag = args[i + 1]
      i++
    } else if (arg === "--commit" && args[i + 1] && !args[i + 1].startsWith("--")) {
      commit = args[i + 1]
      i++
    }
  }

  if (!tag || !commit) {
    console.error("Error: --tag and --commit are required")
    console.error("Usage: node scripts/release-preflight.mjs --tag v0.1.0 --commit 0123456789abcdef0123456789abcdef01234567 [--dry-run] [--require-main-ancestor]")
    process.exit(1)
  }

  // Load package.json
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"))
  const version = pkg.version

  console.log("Running PR-10 release preflight...")
  console.log(`  Version: ${version}`)
  console.log(`  Tag: ${tag}`)
  console.log(`  Commit: ${commit}`)
  console.log(`  Dry run: ${dryRun}`)

  // Validate package identity
  console.log("\nValidating package identity...")
  const pkgViolations = validatePackageIdentity(pkg)
  if (pkgViolations.length > 0) {
    console.error("Package identity violations:")
    pkgViolations.forEach((v) => console.error(`  - ${v.field}: ${v.message}`))
  }

  // Validate release identity
  console.log("\nValidating release identity...")
  const releaseViolations = validateReleaseIdentity({
    version,
    tag,
    commit,
    opencodePeer: pkg.peerDependencies?.["@opencode-ai/plugin"],
    opencodeMinimumVerified: pkg.devDependencies?.["@opencode-ai/plugin"],
  })
  if (releaseViolations.length > 0) {
    console.error("Release identity violations:")
    releaseViolations.forEach((v) => console.error(`  - ${v.field}: ${v.message}`))
  }

  // Validate requested tag (publication mode) or identity check (dry-run)
  console.log("\nValidating requested tag...")
  const tagViolations = requireMainAncestor
    ? validateRequestedTag(tag, commit)
    : []
  if (tagViolations.length > 0) {
    console.error("Requested tag violations:")
    tagViolations.forEach((v) => console.error(`  - ${v.field}: ${v.message}`))
  }

  // Check for RELEASE.json if it exists
  const manifestViolations = []
  const RELEASE_JSON = resolve(ROOT, "RELEASE.json")
  if (existsSync(RELEASE_JSON)) {
    console.log("\nValidating RELEASE.json...")
    const releaseJson = readFileSync(RELEASE_JSON, "utf8")
    try {
      const manifest = JSON.parse(releaseJson)
      manifestViolations.push(...validateManifestIdentity(manifest))
      if (manifestViolations.length > 0) {
        console.error("RELEASE.json violations:")
        manifestViolations.forEach((v) => console.error(`  - ${v.field}: ${v.message}`))
      }
    } catch (error) {
      console.error(`RELEASE.json is not valid JSON: ${error}`)
      manifestViolations.push({ field: "manifest", message: "RELEASE.json is not valid JSON" })
    }
  }

  // Check for fabricated commit (non-dry-run only)
  console.log("\nValidating commit authenticity...")
  const authenticityViolations = []
  try {
    const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    if (!dryRun && actualCommit !== commit) {
      console.error(`Fabricated commit detected: expected ${actualCommit}, got ${commit}`)
      authenticityViolations.push({ field: "commit", message: "commit does not match checked-out HEAD" })
    } else {
      console.log(dryRun ? "Commit authenticity skipped in explicit dry-run mode" : `Commit is authentic: ${actualCommit}`)
    }
  } catch (error) {
    console.error("Could not verify commit authenticity:", error)
    if (!dryRun) authenticityViolations.push({ field: "commit", message: "could not verify checked-out commit" })
  }

  // Summary
  const allViolations = [
    ...pkgViolations,
    ...releaseViolations,
    ...tagViolations,
    ...manifestViolations,
    ...authenticityViolations,
  ]
  if (allViolations.length > 0) {
    console.error(`\n❌ Release preflight failed with ${allViolations.length} violation(s)`)
    process.exit(1)
  }

  console.log("\n✅ Release preflight passed")
  if (dryRun) {
    console.log("(Dry run mode - no changes made)")
  }
  process.exit(0)
}

main()
