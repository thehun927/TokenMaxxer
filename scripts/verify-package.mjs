#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync("package.json", "utf8"))
const expected = new Set(["package.json", ...pkg.files])

try {
  const result = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }))[0]
  const actual = result.files.map(({ path }) => path).sort()
  const expectedSorted = [...expected].sort()
  const missing = expectedSorted.filter((file) => !actual.includes(file))
  const unexpected = actual.filter((file) => !expected.has(file))
  if (missing.length || unexpected.length || actual.length !== expected.size) {
    throw new Error(JSON.stringify({ missing, unexpected, expected: expectedSorted, actual }, null, 2))
  }
  console.log("verify:package: OK")
} catch (error) {
  console.error(`verify:package: FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
