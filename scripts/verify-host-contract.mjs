#!/usr/bin/env node
/**
 * Verify the PR 4 minimum host contract (plan §11 / §12 F items 40-42).
 *
 * TokenMaxxer declares compatibility only for the contract it actually
 * verifies: the frozen `@opencode-ai/plugin@1.18.15` baseline.  This script
 * fails with a clear error if any of the following drift:
 *
 *   - the declared OpenCode peer range is not exactly ">=1.18.15 <2.0.0";
 *   - the dev dependency is not exactly "1.18.15" (no ^ or ~ prefix);
 *   - the installed node_modules/@opencode-ai/plugin version is not exactly
 *     the dev minimum.
 *
 * CI compiles against the actual floor (`npm ci` installs exactly 1.18.15),
 * not whatever later 1.x npm would resolve today.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"

const APPROVED_PEER_RANGE = ">=1.18.15 <2.0.0"
const APPROVED_DEV_DEP = "1.18.15"

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"))

const peer = pkg.peerDependencies?.["@opencode-ai/plugin"]
if (peer !== APPROVED_PEER_RANGE) {
  console.error(`FAIL: peerDependencies[@opencode-ai/plugin] expected "${APPROVED_PEER_RANGE}", got "${peer}"`)
  process.exit(1)
}

const devDep = pkg.devDependencies?.["@opencode-ai/plugin"]
if (devDep !== APPROVED_DEV_DEP) {
  console.error(`FAIL: devDependencies[@opencode-ai/plugin] expected "${APPROVED_DEV_DEP}", got "${devDep}"`)
  process.exit(1)
}

// Installed version check: read the installed package.json
const installedPkgPath = join(process.cwd(), "node_modules", "@opencode-ai", "plugin", "package.json")
if (!existsSync(installedPkgPath)) {
  console.error(`FAIL: ${installedPkgPath} does not exist; run npm ci first`)
  process.exit(1)
}
const installedPkg = JSON.parse(readFileSync(installedPkgPath, "utf-8"))
if (installedPkg.version !== APPROVED_DEV_DEP) {
  console.error(`FAIL: installed @opencode-ai/plugin version expected "${APPROVED_DEV_DEP}", got "${installedPkg.version}"`)
  process.exit(1)
}

console.log(`OK: peer range = "${peer}"; dev dep = "${devDep}"; installed = "${installedPkg.version}"`)
process.exit(0)
