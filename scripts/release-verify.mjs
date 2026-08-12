#!/usr/bin/env node
/**
 * PR-10 Wave 8 — release:verify
 *
 * Fails closed on any defect in a staged immutable release set (default
 * `.release/`). The command performs no Git tag and no GitHub Release
 * mutation; it only reads and verifies.
 *
 * Checks:
 *   - exact expected staged asset inventory (missing/extra assets fail);
 *   - RELEASE.json schema v1 identity and its agreement with package.json,
 *     an optional --tag/--commit, the staged installer's embedded identity,
 *     and the npm tarball package version (mixed-release detection);
 *   - SHA256SUMS format, duplicate/unknown/path-traversal filenames, missing
 *     expected digests, and actual file digests (malformed/mismatched
 *     checksums fail);
 *   - zero-byte executable payloads;
 *   - staged installer: no unresolved identity placeholders, every payload URL
 *     pinned to the exact release tag, no mutable `main` fetch and no second
 *     `latest` lookup;
 *   - npm tarball: exact expected package inventory and payload bytes that
 *     match the staged JS/declarations/launcher and source installer
 *     (package contents mismatch fails).
 *
 * Usage:
 *   node scripts/release-verify.mjs [--dir .release] [--tag v0.1.0] [--commit <40-hex>]
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const COMMIT_RE = /^[0-9a-f]{40}$/
const EXPECTED_OPENCODE_PEER = ">=1.18.15 <2.0.0"
const EXPECTED_OPENCODE_MINIMUM = "1.18.15"
const RELEASE_MANIFEST_SCHEMA_VERSION = 1

/** Every staged payload except SHA256SUMS itself. */
const CHECKSUMMED_FILES = [
  "install.sh",
  "RELEASE.json",
  "tokenmaxxer",
  "tokenmaxxer.js",
  "tokenmaxxer-tui.js",
  "tokenmaxxer-cli.js",
  "tokenmaxxer.d.ts",
  "tokenmaxxer-tui.d.ts",
  "tokenmaxxer-cli.d.ts",
]

/** Staged assets that must be present (the tarball name is version-dependent). */
const BASE_STAGED_ASSETS = [
  "install.sh",
  "RELEASE.json",
  "SHA256SUMS",
  "tokenmaxxer",
  "tokenmaxxer-cli.d.ts",
  "tokenmaxxer-cli.js",
  "tokenmaxxer-tui.d.ts",
  "tokenmaxxer-tui.js",
  "tokenmaxxer.d.ts",
  "tokenmaxxer.js",
]

const EXECUTABLE_PAYLOADS = [
  "tokenmaxxer",
  "tokenmaxxer.js",
  "tokenmaxxer-tui.js",
  "tokenmaxxer-cli.js",
]

/** Exact expected npm tarball inventory (npm prefixes every entry with `package/`). */
const PACKAGE_FILES = [
  "package/package.json",
  "package/bin/tokenmaxxer",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/tui.js",
  "package/dist/tui.d.ts",
  "package/dist/cli.js",
  "package/dist/cli.d.ts",
  "package/install.sh",
  "package/LICENSE",
  "package/README.md",
]

/** Tarball entries that must byte-match the staged release payloads. */
const TARBALL_TO_STAGED = [
  ["package/dist/index.js", "tokenmaxxer.js"],
  ["package/dist/tui.js", "tokenmaxxer-tui.js"],
  ["package/dist/cli.js", "tokenmaxxer-cli.js"],
  ["package/dist/index.d.ts", "tokenmaxxer.d.ts"],
  ["package/dist/tui.d.ts", "tokenmaxxer-tui.d.ts"],
  ["package/dist/cli.d.ts", "tokenmaxxer-cli.d.ts"],
  ["package/bin/tokenmaxxer", "tokenmaxxer"],
]

const violations = []

function usage() {
  console.log(
    "Usage: node scripts/release-verify.mjs [--dir .release] [--tag v0.1.0] [--commit <40-hex>]",
  )
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function validateManifest(m) {
  const out = []
  if (m.schema_version !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    out.push({
      field: "manifest",
      message: `schema_version must be ${RELEASE_MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(m.schema_version)}`,
    })
  }
  if (typeof m.version !== "string" || !SEMVER_RE.test(m.version)) {
    out.push({ field: "manifest", message: `version must be valid SemVer, got ${JSON.stringify(m.version)}` })
  }
  if (typeof m.tag !== "string" || m.tag !== `v${m.version}`) {
    out.push({ field: "manifest", message: `tag must exactly equal "v${m.version}", got ${JSON.stringify(m.tag)}` })
  }
  if (typeof m.commit !== "string" || !COMMIT_RE.test(m.commit)) {
    out.push({
      field: "manifest",
      message: `commit must be exactly 40 lowercase hex characters, got ${JSON.stringify(m.commit)}`,
    })
  }
  if (m.opencode_peer !== EXPECTED_OPENCODE_PEER) {
    out.push({
      field: "manifest",
      message: `opencode_peer must be "${EXPECTED_OPENCODE_PEER}", got ${JSON.stringify(m.opencode_peer)}`,
    })
  }
  if (m.opencode_minimum_verified !== EXPECTED_OPENCODE_MINIMUM) {
    out.push({
      field: "manifest",
      message: `opencode_minimum_verified must be "${EXPECTED_OPENCODE_MINIMUM}", got ${JSON.stringify(m.opencode_minimum_verified)}`,
    })
  }
  return out
}

/** Strict SHA256SUMS validation: conventional `<64-hex>  <filename>` lines. */
function validateChecksums(sumPath, stageDir) {
  const out = []
  const text = readFileSync(sumPath, "utf8")
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "")
  const seen = new Map()
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})  (\S+)$/)
    if (!match) {
      out.push({ field: "checksums", message: `malformed checksum line: "${line}"` })
      continue
    }
    const [, digest, filename] = match
    if (/[/\\\0]/.test(filename)) {
      out.push({ field: "checksums", message: `checksum filename contains a path separator: "${filename}"` })
    }
    if (!CHECKSUMMED_FILES.includes(filename)) {
      out.push({ field: "checksums", message: `unexpected checksum filename: "${filename}"` })
    }
    if (seen.has(filename)) {
      out.push({ field: "checksums", message: `duplicate checksum line for "${filename}"` })
    }
    seen.set(filename, digest)
  }
  for (const expected of CHECKSUMMED_FILES) {
    if (!seen.has(expected)) out.push({ field: "checksums", message: `SHA256SUMS is missing "${expected}"` })
  }
  for (const [filename, digest] of seen) {
    const filePath = join(stageDir, filename)
    if (!existsSync(filePath)) {
      out.push({ field: "checksums", message: `staged file for checksum "${filename}" is missing` })
      continue
    }
    if (sha256File(filePath) !== digest) {
      out.push({ field: "checksums", message: `checksum mismatch for "${filename}"` })
    }
  }
  return out
}

/** Extract the embedded release identity from a staged installer. */
function extractInstallerIdentity(text) {
  const get = (name) => {
    const match = text.match(new RegExp(`^${name}\\s*=\\s*["']?([^"'\\s]+)`, "m"))
    return match ? match[1] : ""
  }
  return {
    version: get("RELEASE_VERSION"),
    tag: get("RELEASE_TAG"),
    commit: get("RELEASE_COMMIT"),
    baseUrl: get("RELEASE_BASE_URL"),
  }
}

/** Extract every download URL from a staged installer, resolving $VAR references. */
function extractDownloadUrls(text) {
  const assignments = new Map()
  const assignRe = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']([^"']+)["']/gm
  let assignMatch
  while ((assignMatch = assignRe.exec(text)) !== null) {
    assignments.set(assignMatch[1], assignMatch[2])
  }
  const resolve = (value) => {
    let out = value
    for (let i = 0; i < 5; i += 1) {
      const next = out
        .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => assignments.get(name) ?? `\${${name}}`)
        .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => assignments.get(name) ?? `$${name}`)
      if (next === out) break
      out = next
    }
    return out
  }
  const urls = []
  const patterns = [
    /download\s+["']([^"']+)["']/g,
    /(?:PLUGIN_URL|TUI_PLUGIN_URL|CLI_PLUGIN_URL|LAUNCHER_URL|PAYLOAD_URL|SHA256SUMS_URL|RELEASE_JSON_URL)\s*=\s*["']([^"']+)["']/g,
  ]
  for (const re of patterns) {
    let match
    while ((match = re.exec(text)) !== null) urls.push(resolve(match[1]))
  }
  return urls
}

/** Parse a gzip tar stream (ustar, as emitted by npm pack) into name -> Buffer. */
function parseTarGz(buffer) {
  const data = gunzipSync(buffer)
  const files = new Map()
  let offset = 0
  while (offset + 512 <= data.length) {
    const name = data.toString("latin1", offset, offset + 100).replace(/\0[\s\S]*$/, "")
    if (name === "") break
    const sizeField = data
      .toString("latin1", offset + 124, offset + 136)
      .replace(/\0[\s\S]*$/, "")
      .trim()
    const size = Number.parseInt(sizeField, 8) || 0
    const type = String.fromCharCode(data[offset + 156])
    if (type === "0" || type === "\u0000") {
      files.set(name, Buffer.from(data.subarray(offset + 512, offset + 512 + size)))
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

/** Verify the npm tarball inventory and payload bytes against the staged set. */
function validateTarball(tarballPath, stageDir, tarballName, manifestVersion) {
  const out = []
  let buffer
  try {
    buffer = readFileSync(tarballPath)
  } catch (error) {
    return [{ field: "tarball", message: `npm tarball cannot be read: ${error.message}` }]
  }
  if (buffer.length === 0) return [{ field: "tarball", message: "npm tarball is empty" }]
  let files
  try {
    files = parseTarGz(buffer)
  } catch (error) {
    return [{ field: "tarball", message: `npm tarball is not a valid tar.gz: ${error.message}` }]
  }

  const names = [...files.keys()].sort()
  const expected = [...PACKAGE_FILES].sort()
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    const missing = expected.filter((name) => !names.includes(name))
    const extra = names.filter((name) => !expected.includes(name))
    out.push({
      field: "tarball",
      message: `package contents mismatch in ${tarballName} (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`,
    })
  }

  for (const [tarPath, stagedName] of TARBALL_TO_STAGED) {
    const tarBytes = files.get(tarPath)
    const stagedPath = join(stageDir, stagedName)
    if (!tarBytes) continue // already reported as missing above
    if (!existsSync(stagedPath)) {
      out.push({ field: "tarball", message: `staged ${stagedName} is missing (cannot compare tarball ${tarPath})` })
      continue
    }
    if (!tarBytes.equals(readFileSync(stagedPath))) {
      out.push({
        field: "tarball",
        message: `tarball ${tarPath} differs from staged ${stagedName} (package contents mismatch)`,
      })
    }
  }

  const pkgBytes = files.get("package/package.json")
  if (pkgBytes) {
    try {
      const pkgInTar = JSON.parse(pkgBytes.toString("utf8"))
      if (typeof pkgInTar.version !== "string" || !SEMVER_RE.test(pkgInTar.version)) {
        out.push({ field: "tarball", message: "tarball package.json version is not valid SemVer" })
      }
      if (manifestVersion && pkgInTar.version !== manifestVersion) {
        out.push({
          field: "tarball",
          message: `tarball package.json version "${pkgInTar.version}" disagrees with RELEASE.json version "${manifestVersion}" (package contents mismatch)`,
        })
      }
    } catch {
      out.push({ field: "tarball", message: "tarball package/package.json is not valid JSON" })
    }
  }

  const sourceInstaller = join(ROOT, "install.sh")
  if (existsSync(sourceInstaller)) {
    const tarInstaller = files.get("package/install.sh")
    if (tarInstaller && !tarInstaller.equals(readFileSync(sourceInstaller))) {
      out.push({
        field: "tarball",
        message: "tarball package/install.sh differs from source install.sh (package contents mismatch)",
      })
    }
  }
  return out
}

function main() {
  const args = process.argv.slice(2)
  let dir = ".release"
  let expectedTag = null
  let expectedCommit = null
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === "--dir" && args[i + 1]) {
      dir = args[i + 1]
      i += 1
    } else if (arg === "--tag" && args[i + 1]) {
      expectedTag = args[i + 1]
      i += 1
    } else if (arg === "--commit" && args[i + 1]) {
      expectedCommit = args[i + 1]
      i += 1
    } else if (arg === "--help" || arg === "-h") {
      usage()
      process.exit(0)
    } else {
      console.error(`release:verify: unknown argument: ${arg}`)
      process.exit(1)
    }
  }

  const stageDir = resolve(ROOT, dir)
  if (!existsSync(stageDir) || !statSync(stageDir).isDirectory()) {
    console.error(`release:verify: staged release directory does not exist: ${stageDir}`)
    process.exit(1)
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  const version = pkg.version
  const tarballName = `tokenmaxxer-${version}.tgz`
  CHECKSUMMED_FILES.push(tarballName)
  const expectedAssets = [...BASE_STAGED_ASSETS, tarballName].sort()

  // ---- Asset inventory: missing/extra staged assets fail closed. ----
  let entries
  try {
    entries = readdirSync(stageDir, { withFileTypes: true })
  } catch (error) {
    console.error(`release:verify: staged release directory cannot be read: ${error.message}`)
    process.exit(1)
  }
  const actual = entries.map((entry) => (entry.isFile() ? entry.name : `${entry.name}/`))
  for (const name of actual) {
    if (!expectedAssets.includes(name)) {
      violations.push({ field: "assets", message: `unexpected staged asset: ${name}` })
    }
  }
  for (const name of expectedAssets) {
    if (!actual.includes(name)) {
      violations.push({ field: "assets", message: `missing staged asset: ${name}` })
    }
  }

  // ---- RELEASE.json identity. ----
  const manifestPath = join(stageDir, "RELEASE.json")
  let manifest = null
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    } catch (error) {
      violations.push({ field: "manifest", message: `RELEASE.json is not valid JSON: ${error.message}` })
    }
  } else {
    violations.push({ field: "manifest", message: "RELEASE.json is missing" })
  }
  if (manifest) violations.push(...validateManifest(manifest))

  // ---- Zero-byte executable payloads. ----
  for (const name of EXECUTABLE_PAYLOADS) {
    const payloadPath = join(stageDir, name)
    if (existsSync(payloadPath) && statSync(payloadPath).size === 0) {
      violations.push({ field: "payload", message: `zero-byte executable payload: ${name}` })
    }
  }

  // ---- Identity agreement across sources (no mixed release). ----
  if (manifest) {
    if (pkg.version !== manifest.version) {
      violations.push({
        field: "identity",
        message: `package.json version "${pkg.version}" disagrees with RELEASE.json version "${manifest.version}"`,
      })
    }
    if (expectedTag && manifest.tag !== expectedTag) {
      violations.push({
        field: "identity",
        message: `RELEASE.json tag "${manifest.tag}" disagrees with supplied --tag "${expectedTag}"`,
      })
    }
    if (expectedCommit && manifest.commit !== expectedCommit) {
      violations.push({
        field: "identity",
        message: "RELEASE.json commit disagrees with supplied --commit",
      })
    }
  }

  // ---- SHA256SUMS. ----
  const sumPath = join(stageDir, "SHA256SUMS")
  if (existsSync(sumPath)) {
    violations.push(...validateChecksums(sumPath, stageDir))
  }

  // ---- Staged installer identity and URL pinning. ----
  const installerPath = join(stageDir, "install.sh")
  if (existsSync(installerPath)) {
    const installerText = readFileSync(installerPath, "utf8")
    const identity = extractInstallerIdentity(installerText)
    if (manifest) {
      if (identity.version !== manifest.version) {
        violations.push({
          field: "identity",
          message: `install.sh embeds version "${identity.version}" but RELEASE.json declares "${manifest.version}"`,
        })
      }
      if (identity.tag !== manifest.tag) {
        violations.push({
          field: "identity",
          message: `install.sh embeds tag "${identity.tag}" but RELEASE.json declares "${manifest.tag}"`,
        })
      }
      if (identity.commit !== manifest.commit) {
        violations.push({
          field: "identity",
          message: `install.sh embeds commit "${identity.commit}" but RELEASE.json declares "${manifest.commit}"`,
        })
      }
    }
    if (!identity.version || !identity.tag) {
      violations.push({ field: "identity", message: "install.sh release identity placeholders are unresolved" })
    }
    if (!identity.commit || !COMMIT_RE.test(identity.commit)) {
      violations.push({ field: "identity", message: "install.sh RELEASE_COMMIT is empty or malformed (unresolved placeholder)" })
    }
    const urls = extractDownloadUrls(installerText)
    const manifestTag = manifest?.tag
    if (manifestTag) {
      if (urls.length === 0) {
        violations.push({ field: "url", message: "staged installer declares no payload download URLs" })
      }
      for (const url of urls) {
        if (/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\//.test(url)) {
          violations.push({ field: "url", message: `payload URL fetches mutable main: ${url}` })
        }
        if (/\/releases\/latest\/download\//.test(url)) {
          violations.push({ field: "url", message: `payload URL performs a second latest lookup: ${url}` })
        }
        const urlTag = url.match(/\/releases\/download\/([^/]+)\//)?.[1]
        if (!urlTag) {
          violations.push({ field: "url", message: `payload URL is not pinned to a release tag: ${url}` })
        } else if (urlTag !== manifestTag) {
          violations.push({
            field: "url",
            message: `payload URL is pinned to "${urlTag}" but RELEASE.json declares "${manifestTag}"`,
          })
        }
      }
    }
  }

  // ---- npm tarball contents. ----
  const tarballPath = join(stageDir, tarballName)
  if (existsSync(tarballPath)) {
    violations.push(...validateTarball(tarballPath, stageDir, tarballName, manifest?.version))
  }

  if (violations.length > 0) {
    console.error(`release:verify: FAILED with ${violations.length} violation(s) in ${stageDir}`)
    for (const violation of violations) {
      console.error(`  - ${violation.field}: ${violation.message}`)
    }
    process.exit(1)
  }

  console.log(`release:verify: OK (${stageDir}, ${tarballName})`)
  console.log(`  release ${manifest?.version} (${manifest?.tag}, ${manifest?.commit})`)
}

main()
