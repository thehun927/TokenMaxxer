/**
 * Package-metadata contract (PR 4 §11 / §12 F cases 40-42).
 *
 * TokenMaxxer declares compatibility only for the contract it actually
 * verifies.  The peer range, the exact dev dependency, and the actually
 * installed `@opencode-ai/plugin` must all agree on the frozen `1.18.15`
 * minimum — never `^1.18.15` and never a wider peer claim.
 *
 * These fixtures fail today because `peerDependencies` still claims
 * `>=1.0.0 <2.0.0`; Wave 7 tightens the peer range (the dev dependency and
 * the installed package are already exactly `1.18.15`).
 */
import { describe, expect, it } from "vitest"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(repoRoot, relativePath), "utf-8"),
  ) as Record<string, unknown>
}

describe("PR 4 §12 F / §11 — package metadata contract", () => {
  it("40. peerDependencies[@opencode-ai/plugin] is exactly the Wave-7 target range", async () => {
    const pkg = await readJson("package.json")
    const peers = pkg.peerDependencies as Record<string, unknown>
    expect(peers["@opencode-ai/plugin"]).toBe(">=1.18.15 <2.0.0")
  })

  it("41. devDependencies[@opencode-ai/plugin] is exactly 1.18.15 (no ^ range)", async () => {
    const pkg = await readJson("package.json")
    const dev = pkg.devDependencies as Record<string, unknown>
    expect(dev["@opencode-ai/plugin"]).toBe("1.18.15")
  })

  it("42. installed @opencode-ai/plugin version is exactly 1.18.15", async () => {
    const pluginPkg = await readJson(
      join("node_modules", "@opencode-ai", "plugin", "package.json"),
    )
    expect(pluginPkg.version).toBe("1.18.15")
  })
})
