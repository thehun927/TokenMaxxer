#!/usr/bin/env node
/**
 * PR-10 Wave 8 — release:stage
 *
 * Deterministically stages the immutable TokenMaxxer release asset set into an
 * ignored staging directory (default `.release/`):
 *
 *   install.sh               rendered release installer (exact version/tag/commit)
 *   RELEASE.json             schema v1 release identity manifest
 *   SHA256SUMS               deterministic checksums for the installer-verified
 *                            payload set (RELEASE.json + four executables)
 *   tokenmaxxer              launcher (bin/tokenmaxxer)
 *   tokenmaxxer.js           dist/index.js
 *   tokenmaxxer-tui.js       dist/tui.js
 *   tokenmaxxer-cli.js       dist/cli.js
 *   tokenmaxxer.d.ts         dist/index.d.ts
 *   tokenmaxxer-tui.d.ts     dist/tui.d.ts
 *   tokenmaxxer-cli.d.ts     dist/cli.d.ts
 *   tokenmaxxer-<version>.tgz  npm tarball (auditable package-layout artifact)
 *
 * The command is dry-run/local safe: it never creates a Git tag and never
 * calls GitHub Release APIs. For the same source commit and toolchain every
 * staged byte is identical across runs; no timestamps, random IDs, or
 * working-directory-specific values are embedded.
 *
 * SHA256SUMS covers every staged payload except SHA256SUMS itself. The
 * installer verifies the subset it downloads before mutating an installation;
 * release:verify verifies the complete staged set.
 *
 * Usage:
 *   node scripts/release-stage.mjs --tag v0.1.0 --commit <40-hex> [--out .release] [--build]
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { dirname, join, parse, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const COMMIT_RE = /^[0-9a-f]{40}$/
const EXPECTED_OPENCODE_PEER = ">=1.18.15 <2.0.0"
const EXPECTED_OPENCODE_MINIMUM = "1.18.15"
const RELEASE_MANIFEST_SCHEMA_VERSION = 1

const DIST_FILES = ["index.js", "index.d.ts", "tui.js", "tui.d.ts", "cli.js", "cli.d.ts"]

/** Mapping from generated dist file to the immutable release asset name. */
const DIST_TO_STAGED = {
  "dist/index.js": "tokenmaxxer.js",
  "dist/tui.js": "tokenmaxxer-tui.js",
  "dist/cli.js": "tokenmaxxer-cli.js",
  "dist/index.d.ts": "tokenmaxxer.d.ts",
  "dist/tui.d.ts": "tokenmaxxer-tui.d.ts",
  "dist/cli.d.ts": "tokenmaxxer-cli.d.ts",
}

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
  "tokenmaxxer-0.1.0.tgz",
]

const TAG_REF = "$" + "{RELEASE_TAG}"

function fail(message) {
  console.error(`release:stage: ${message}`)
  process.exit(1)
}

function usage() {
  console.log(
    "Usage: node scripts/release-stage.mjs --tag v0.1.0 --commit <40-hex> [--out .release] [--build]",
  )
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

/** Return problems when dist/ is not exactly the generated six-file set. */
function validateDist() {
  const distDir = join(ROOT, "dist")
  const problems = []
  if (!existsSync(distDir)) {
    return ["dist/ is missing; run npm run build before staging"]
  }
  let entries
  try {
    entries = readdirSync(distDir, { withFileTypes: true })
  } catch {
    return ["dist/ cannot be read"]
  }
  for (const entry of entries) {
    if (!entry.isFile()) {
      problems.push(`dist/${entry.name} is not a file`)
    } else if (!DIST_FILES.includes(entry.name)) {
      problems.push(`unexpected generated file dist/${entry.name}`)
    }
  }
  for (const name of DIST_FILES) {
    if (!existsSync(join(distDir, name))) {
      problems.push(`dist/${name} is missing`)
    } else if (statSync(join(distDir, name)).size === 0) {
      problems.push(`dist/${name} is empty`)
    }
  }
  return problems
}

/**
 * Render the source install.sh with the exact immutable release identity.
 * The source template must keep RELEASE_BASE_URL pinned to ${RELEASE_TAG}; if
 * the template embeds a literal tag, it is rebuilt from the repository prefix.
 */
function renderInstaller(source, identity) {
  const { version, tag, commit } = identity
  const assignments = [
    [/^RELEASE_VERSION=.*$/m, `RELEASE_VERSION="${version}"`],
    [/^RELEASE_TAG=.*$/m, `RELEASE_TAG="${tag}"`],
    [/^RELEASE_COMMIT=.*$/m, `RELEASE_COMMIT="${commit}"`],
  ]
  for (const [re] of assignments) {
    if (!re.test(source)) fail(`install.sh template is missing the assignment line matching ${re}`)
  }
  let rendered = source
    .replace(/^RELEASE_VERSION=.*$/m, `RELEASE_VERSION="${version}"`)
    .replace(/^RELEASE_TAG=.*$/m, `RELEASE_TAG="${tag}"`)
    .replace(/^RELEASE_COMMIT=.*$/m, `RELEASE_COMMIT="${commit}"`)
  const base = rendered.match(/^RELEASE_BASE_URL=["']([^"']+)["']$/m)
  if (!base) fail("install.sh template is missing a RELEASE_BASE_URL assignment")
  if (!base[1].includes(`/releases/download/${TAG_REF}`)) {
    const prefix = base[1].match(/^(https?:\/\/[^/\s]+(?:\/[^/\s]+)*)\/releases\/download\//)
    if (!prefix) fail(`install.sh RELEASE_BASE_URL is not a releases/download URL: ${base[1]}`)
    rendered = rendered.replace(
      /^RELEASE_BASE_URL=.*$/m,
      `RELEASE_BASE_URL="${prefix[1]}/releases/download/${TAG_REF}"`,
    )
  }
  return rendered
}

/** Actual toolchain versions recorded in RELEASE.json (deterministic per toolchain). */
function toolVersions() {
  const node = process.versions.node
  let npm = "unknown"
  try {
    npm = execFileSync("npm", ["--version"], { encoding: "utf8", cwd: ROOT }).trim()
  } catch {
    // npm is unavailable; fall through with "unknown"
  }
  let bun = "unknown"
  try {
    bun = execFileSync("bun", ["--version"], { encoding: "utf8", cwd: ROOT }).trim()
  } catch {
    const hint = join(ROOT, ".bun-version")
    if (existsSync(hint)) bun = readFileSync(hint, "utf8").trim()
  }
  return { node, npm, bun }
}

function main() {
  const args = process.argv.slice(2)
  let tag = null
  let commit = null
  let out = ".release"
  let buildRequested = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === "--tag" && args[i + 1]) {
      tag = args[i + 1]
      i += 1
    } else if (arg === "--commit" && args[i + 1]) {
      commit = args[i + 1]
      i += 1
    } else if (arg === "--out" && args[i + 1]) {
      out = args[i + 1]
      i += 1
    } else if (arg === "--build") {
      buildRequested = true
    } else if (arg === "--help" || arg === "-h") {
      usage()
      process.exit(0)
    } else {
      console.error(`release:stage: unknown argument: ${arg}`)
      process.exit(1)
    }
  }
  if (!tag || !commit) {
    console.error("release:stage: --tag and --commit are required")
    usage()
    process.exit(1)
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  const version = pkg.version

  // Exact identity validation: SemVer version, v${version} tag, 40 lowercase hex commit.
  if (!SEMVER_RE.test(version)) fail(`package version "${version}" is not valid SemVer`)
  if (tag !== `v${version}`) fail(`tag "${tag}" must exactly equal "v${version}"`)
  if (!COMMIT_RE.test(commit)) fail(`commit "${commit}" must be exactly 40 lowercase hex characters`)

  const peer = pkg.peerDependencies?.["@opencode-ai/plugin"]
  const minimum = pkg.devDependencies?.["@opencode-ai/plugin"]
  if (peer !== EXPECTED_OPENCODE_PEER) {
    fail(`opencode_peer must be "${EXPECTED_OPENCODE_PEER}", got "${peer}"`)
  }
  if (minimum !== EXPECTED_OPENCODE_MINIMUM) {
    fail(`opencode_minimum_verified must be "${EXPECTED_OPENCODE_MINIMUM}", got "${minimum}"`)
  }

  // Build or validate the generated six-file dist.
  const initialDist = validateDist()
  if (buildRequested || initialDist.length > 0) {
    if (initialDist.length > 0) {
      console.log(`release:stage: dist is missing or incomplete (${initialDist.join("; ")}); building...`)
    } else {
      console.log("release:stage: rebuilding dist as requested")
    }
    execFileSync("npm", ["run", "build"], { stdio: "inherit", cwd: ROOT })
  }
  const distProblems = validateDist()
  if (distProblems.length > 0) {
    for (const problem of distProblems) console.error(`release:stage: ${problem}`)
    fail("dist is not the expected generated six-file set")
  }

  // Clean deterministic staging directory.
  const outDir = resolve(ROOT, out)
  if (outDir === ROOT || outDir === parse(outDir).root) {
    fail(`refusing to stage into ${outDir}`)
  }
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  // 1) Rendered installer.
  const installerSource = readFileSync(join(ROOT, "install.sh"), "utf8")
  const renderedInstaller = renderInstaller(installerSource, { version, tag, commit })
  writeFileSync(join(outDir, "install.sh"), renderedInstaller)
  chmodSync(join(outDir, "install.sh"), 0o755)

  // 2) Launcher.
  copyFileSync(join(ROOT, "bin", "tokenmaxxer"), join(outDir, "tokenmaxxer"))
  chmodSync(join(outDir, "tokenmaxxer"), 0o755)

  // 3) Index/TUI/CLI JS bundles and declarations.
  for (const [source, target] of Object.entries(DIST_TO_STAGED)) {
    copyFileSync(join(ROOT, source), join(outDir, target))
  }

  // 4) RELEASE.json (schema v1, fixed key order, no timestamp/branch).
  const tools = toolVersions()
  const releaseManifest = {
    schema_version: RELEASE_MANIFEST_SCHEMA_VERSION,
    version,
    tag,
    commit,
    opencode_peer: peer,
    opencode_minimum_verified: minimum,
    builder: {
      node: tools.node,
      npm: tools.npm,
      bun: tools.bun,
    },
    artifacts: ["tokenmaxxer.js", "tokenmaxxer-tui.js", "tokenmaxxer-cli.js", "tokenmaxxer"],
  }
  writeFileSync(join(outDir, "RELEASE.json"), JSON.stringify(releaseManifest, null, 2) + "\n")

  // 5) npm tarball (auditable package-layout artifact, not an installer input).
  const tarballName = `tokenmaxxer-${version}.tgz`
  let packOutput
  let packedPath
  try {
    packOutput = execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts"],
      { encoding: "utf8", cwd: ROOT },
    )
  } catch (error) {
    fail(`npm pack failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  let packMeta
  try {
    packMeta = JSON.parse(packOutput)[0]
  } catch {
    fail("npm pack output could not be parsed")
  }
  if (!packMeta || packMeta.filename !== tarballName) {
    fail(`npm pack produced "${packMeta?.filename ?? "nothing"}"; expected "${tarballName}"`)
  }
  packedPath = resolve(ROOT, packMeta.filename)
  if (!existsSync(packedPath) || statSync(packedPath).size === 0) {
    fail(`npm tarball ${tarballName} was not produced in the repository root`)
  }
  copyFileSync(packedPath, join(outDir, tarballName))
  rmSync(packedPath, { force: true })

  // 6) SHA256SUMS covering the installer-verified payload set, sorted by filename.
  const checksumFiles = [
    "install.sh",
    "RELEASE.json",
    "tokenmaxxer",
    "tokenmaxxer.js",
    "tokenmaxxer-tui.js",
    "tokenmaxxer-cli.js",
    "tokenmaxxer.d.ts",
    "tokenmaxxer-tui.d.ts",
    "tokenmaxxer-cli.d.ts",
    tarballName,
  ]
  const checksumLines = checksumFiles
    .sort()
    .map((name) => `${sha256File(join(outDir, name))}  ${name}`)
  writeFileSync(join(outDir, "SHA256SUMS"), checksumLines.join("\n") + "\n")

  const staged = readdirSync(outDir).sort()
  console.log(`release:stage: staged immutable release set in ${outDir} (${tag} @ ${commit})`)
  for (const name of staged) {
    const st = statSync(join(outDir, name))
    console.log(`  ${name} (${st.size} bytes)`)
  }
  console.log("release:stage: OK (no Git tag or GitHub Release was created)")
}

main()
