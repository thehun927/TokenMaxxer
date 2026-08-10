/**
 * PR 3 §15.48 — launcher routes `decisions` to the CLI bundle.
 *
 * Packaging smoke test: spawns the real `bin/tokenmaxxer` launcher against an
 * empty fixture project and asserts the CLI bundle (dist/cli.js) answers with
 * the bounded "No project memory yet." marker.
 *
 * This is skipped when no build is present so the plain `vitest run` unit
 * suite stays green without a build step; CI runs it after `npm run build`.
 * The shell-level checks (46, 47, 49) live in `test/cli-smoke/smoke.sh`.
 */
import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const launcher = join(repoRoot, "bin", "tokenmaxxer")
const cliBundle = join(repoRoot, "dist", "cli.js")

const bundlePresent =
  existsSync(cliBundle) && statSync(cliBundle).size > 0

function runLauncher(args: string[]): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  return new Promise((resolvePromise) => {
    const child = spawn(launcher, args, { env: process.env })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => {
      stdout += String(d)
    })
    child.stderr.on("data", (d) => {
      stderr += String(d)
    })
    child.on("error", (err) => {
      resolvePromise({ code: -1, stdout, stderr: String(err) })
    })
    child.on("exit", (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

describe.skipIf(!bundlePresent)("PR 3 §15.48 launcher → CLI bundle routing", () => {
  it("`tokenmaxxer decisions` on an empty project prints 'No project memory yet.'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tokenmaxxer-launch-"))
    try {
      const project = join(dir, "proj")
      await mkdir(project, { recursive: true })

      const { code, stdout, stderr } = await runLauncher([
        "decisions",
        "--project",
        project,
      ])

      // Bounded expected marker from the CLI bundle's read-only path.
      expect(stdout).toContain("No project memory yet.")
      expect(stderr).toBe("")
      expect(code).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
