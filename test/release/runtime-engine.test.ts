/**
 * Oracle B4 — runtime engine vs builder pinning contract.
 *
 * Restores shipped runtime engines.node to >=18 while preserving builder
 * pinning in .node-version / packageManager / workflow setup-node /
 * RELEASE.json builder metadata. Also preserves OpenCode host peer range
 * and minimum verified pin.
 *
 * Required remediation for B4:
 * 1. shipped runtime engine floor remains >=18 (not builder 22.23.1)
 * 2. builder pinning stays at 22.23.1 via .node-version, packageManager,
 *    workflow setup-node, and RELEASE builder metadata
 * 3. runtime engine and builder version are distinct contracts
 * 4. OpenCode peer >=1.18.15 <2.0.0 and minimum dev 1.18.15 unchanged
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const projectDir = new URL("../../", import.meta.url).pathname

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"))
}

function readText(path: string): string {
  return readFileSync(path, "utf-8")
}

describe("B4 shipped runtime engine contract", () => {
  it("declares runtime engines.node as >=18 (not builder >=22.23.1)", () => {
    const pkg = readJson(join(projectDir, "package.json"))
    expect(pkg.engines).toBeDefined()
    expect(pkg.engines.node).toBe(">=18")
  })

  it("runtime engine allows Node 18 while CLI build still targets node18", () => {
    const pkg = readJson(join(projectDir, "package.json"))
    const engine: string = pkg.engines.node

    // Parse floor major from ">=18" (allow ">=18.0.0" variants)
    const m = engine.match(/>=\s*(\d+)/)
    expect(m, `engines.node "${engine}" must be a >= range`).not.toBeNull()
    const floorMajor = Number(m![1])
    expect(floorMajor).toBe(18)
    // Must not have been narrowed to builder floor 22
    expect(floorMajor).not.toBe(22)
    expect(engine).not.toBe(">=22.23.1")

    // CLI still builds for node18 per shipped runtime contract
    const buildScript: string = pkg.scripts?.build ?? ""
    const cliScript: string = pkg.scripts?.["build:cli"] ?? ""
    expect(buildScript + cliScript).toMatch(/node18/)
  })

  it("distinguishes runtime engine from release builder pinned version", () => {
    const pkg = readJson(join(projectDir, "package.json"))
    const runtimeEngine: string = pkg.engines.node

    const nodeVersion = readText(join(projectDir, ".node-version")).trim()
    expect(nodeVersion).toBe("22.23.1")
    expect(runtimeEngine).not.toContain(nodeVersion)
    expect(runtimeEngine).not.toBe(`>=${nodeVersion}`)

    // packageManager remains builder-pinned
    expect(pkg.packageManager).toBe("npm@10.9.8")

    // builder pinning must differ from runtime floor
    expect(`>=${nodeVersion}`).not.toBe(runtimeEngine)
  })
})

describe("B4 builder pinning preserved separately from runtime", () => {
  it("keeps .node-version pinned to 22.23.1", () => {
    const v = readText(join(projectDir, ".node-version")).trim()
    expect(v).toBe("22.23.1")
  })

  it("keeps packageManager pinned to npm@10.9.8", () => {
    const pkg = readJson(join(projectDir, "package.json"))
    expect(pkg.packageManager).toBe("npm@10.9.8")
  })

  it("keeps workflow setup-node pinned to 22.23.1", () => {
    const ci = readText(join(projectDir, ".github/workflows/ci.yml"))
    const rel = readText(join(projectDir, ".github/workflows/release.yml"))

    // ci must have node-version 22.23.1 via setup-node
    expect(ci).toMatch(/node-version:\s*22\.23\.1/)
    expect(rel).toMatch(/node-version:\s*22\.23\.1/)

    // pinning must be present as action SHA comment not mutable tag alone
    expect(ci).toContain("48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e")
    expect(rel).toContain("48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e")
  })

  it("keeps RELEASE.json builder metadata distinct from runtime engine", () => {
    const stageScript = readText(join(projectDir, "scripts/release-stage.mjs"))
    // release-stage records builder.node/npm/bun separately
    expect(stageScript).toMatch(/builder:\s*\{/)
    expect(stageScript).toContain("node: tools.node")
    expect(stageScript).toContain("npm: tools.npm")

    // builder metadata must not be conflated with engines.node
    const pkg = readJson(join(projectDir, "package.json"))
    expect(pkg.engines.node).toBe(">=18")
    // builder node is captured from process.versions.node at staging time
    expect(stageScript).toMatch(/process\.versions\.node/)
  })
})

describe("B4 OpenCode host peer/minimum contract preserved", () => {
  it("preserves peer range >=1.18.15 <2.0.0", () => {
    const pkg = readJson(join(projectDir, "package.json"))
    expect(pkg.peerDependencies["@opencode-ai/plugin"]).toBe(">=1.18.15 <2.0.0")
  })

  it("preserves minimum dev pin 1.18.15", () => {
    const pkg = readJson(join(projectDir, "package.json"))
    expect(pkg.devDependencies["@opencode-ai/plugin"]).toBe("1.18.15")
  })

  it("peer range lower bound matches minimum dev pin", () => {
    const pkg = readJson(join(projectDir, "package.json"))
    const peer: string = pkg.peerDependencies["@opencode-ai/plugin"]
    const minimum: string = pkg.devDependencies["@opencode-ai/plugin"]
    expect(peer).toContain(`>=${minimum}`)
    expect(peer).toBe(">=1.18.15 <2.0.0")
    expect(minimum).toBe("1.18.15")
  })
})
