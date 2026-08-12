#!/usr/bin/env node

import { execFileSync, execSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const payloadFiles = ["index.js", "index.d.ts", "tui.js", "tui.d.ts", "cli.js", "cli.d.ts"]

function payloadHashes() {
  return Object.fromEntries(payloadFiles.map((file) => [
    file,
    createHash("sha256").update(readFileSync(join("dist", file))).digest("hex"),
  ]))
}

function stableMetadata() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"))
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    packageVersion: pkg.version,
    packageManager: pkg.packageManager,
    nodeVersion: process.version,
  }
}

try {
  execSync("npm run build", { stdio: "inherit" })
  const firstHashes = payloadHashes()
  const firstMetadata = stableMetadata()
  execSync("npm run build", { stdio: "inherit" })
  const secondHashes = payloadHashes()
  const secondMetadata = stableMetadata()

  if (JSON.stringify(firstHashes) !== JSON.stringify(secondHashes)) {
    throw new Error(`payload SHA256 hashes differ: ${JSON.stringify({ firstHashes, secondHashes })}`)
  }
  if (JSON.stringify(firstMetadata) !== JSON.stringify(secondMetadata)) {
    throw new Error(`stable metadata differs: ${JSON.stringify({ firstMetadata, secondMetadata })}`)
  }
  console.log("verify:reproducible-build: OK")
  console.log(JSON.stringify({ metadata: firstMetadata, sha256: firstHashes }, null, 2))
} catch (error) {
  console.error(`verify:reproducible-build: FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
