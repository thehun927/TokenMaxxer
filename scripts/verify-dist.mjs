#!/usr/bin/env node

/**
 * Verify dist/ contains exactly six expected files and no other entries.
 * This ensures clean source checkout builds emit exactly:
 * - dist/index.js, dist/index.d.ts
 * - dist/tui.js, dist/tui.d.ts
 * - dist/cli.js, dist/cli.d.ts
 * at dist root with no other files or directories.
 */

import { readFileSync, readdirSync, statSync, unlinkSync, rmSync } from "node:fs"
import { join } from "node:path"

const distDir = "dist"
const expectedFiles = [
  "index.js",
  "index.d.ts",
  "tui.js",
  "tui.d.ts",
  "cli.js",
  "cli.d.ts",
]

function checkFiles() {
  console.log("Checking dist/ for expected files...")

  const entries = readdirSync(distDir, { withFileTypes: true })

  // Check that we have exactly 6 entries
  if (entries.length !== expectedFiles.length) {
    console.error(`ERROR: Expected exactly ${expectedFiles.length} entries, found ${entries.length}`)
    process.exit(1)
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      console.error(`ERROR: ${entry.name} is not a file`)
      process.exit(1)
    }
    const name = entry.name
    if (!expectedFiles.includes(name)) {
      console.error(`ERROR: Unexpected file found: dist/${name}`)
      process.exit(1)
    }
    console.log(`✓ ${name}`)
  }
}

function checkFileSizes() {
  console.log("\nChecking file sizes...")

  for (const file of expectedFiles) {
    const path = join(distDir, file)
    const stats = statSync(path)
    const size = stats.size
    console.log(`✓ ${file}: ${size} bytes`)
  }
}

function checkDeclarationFiles() {
  console.log("\nChecking declaration files...")

  for (const file of expectedFiles) {
    if (file.endsWith(".d.ts")) {
      const path = join(distDir, file)
      const content = readFileSync(path, "utf8")
      if (!content) {
        console.error(`ERROR: ${file} is empty`)
        process.exit(1)
      }
      console.log(`✓ ${file} (valid)`)
    }
  }
}

try {
  checkFiles()
  checkFileSizes()
  checkDeclarationFiles()
  console.log("\n✓ verify:dist: OK")
} catch (error) {
  console.error("\n✗ verify:dist: FAILED")
  process.exit(1)
}
