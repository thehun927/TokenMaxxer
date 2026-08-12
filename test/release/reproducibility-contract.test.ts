import { describe, expect, it } from "vitest"
import { execSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

describe("reproducibility contract", () => {
  const projectDir = new URL("../../", import.meta.url).pathname

  it("should have no tracked dist files in git", () => {
    // This is a behavioral test: git ls-files should return nothing for dist/**
    const result = execSync("git ls-files 'dist/**'", { encoding: "utf-8", cwd: projectDir })
    expect(result.trim()).toBe("")
  })

  it("should have dist/ in .gitignore", () => {
    const gitignore = readFileSync(join(projectDir, ".gitignore"), "utf-8")
    expect(gitignore).toContain("dist/")
  })

  it("should have expected package.json structure", () => {
    const packageJsonPath = join(projectDir, "package.json")
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"))

    expect(packageJson).toHaveProperty("name", "tokenmaxxer")
    expect(packageJson).toHaveProperty("version")
    expect(packageJson).toHaveProperty("type", "module")
    expect(packageJson).toHaveProperty("files")
    expect(Array.isArray(packageJson.files)).toBe(true)
  })

  it("should have valid semver version", () => {
    const packageJsonPath = join(projectDir, "package.json")
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"))
    const version = packageJson.version

    // Basic semver validation
    const semverRegex = /^\d+\.\d+\.\d+$/
    expect(semverRegex.test(version)).toBe(true)
  })

  it("should have correct peer dependencies", () => {
    const packageJsonPath = join(projectDir, "package.json")
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"))

    expect(packageJson.peerDependencies).toHaveProperty("@opencode-ai/plugin")
    expect(packageJson.peerDependencies).toHaveProperty("@opentui/core")
    expect(packageJson.peerDependencies).toHaveProperty("@opentui/keymap")
    expect(packageJson.peerDependencies).toHaveProperty("@opentui/solid")
    expect(packageJson.peerDependencies).toHaveProperty("zod")

    const pluginRange = packageJson.peerDependencies["@opencode-ai/plugin"]
    expect(pluginRange).toMatch(/>=1\.18\.15/)
  })

  it("should have expected files in package.json files list", () => {
    const packageJsonPath = join(projectDir, "package.json")
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"))
    const expectedFiles = [
      "bin/tokenmaxxer",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/tui.js",
      "dist/tui.d.ts",
      "dist/cli.js",
      "dist/cli.d.ts",
      "install.sh",
      "LICENSE",
      "README.md",
    ]

    expectedFiles.forEach(file => {
      expect(packageJson.files).toContain(file)
    })
  })

  it("should not include unexpected files in package.json files list", () => {
    const packageJsonPath = join(projectDir, "package.json")
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"))

    const unexpectedFiles = [
      "src/",
      "test/",
      "docs/",
      ".opencode/",
      ".release/",
      "STATE.json",
      "diagnostic artifacts",
      "node_modules/",
      "CI files",
    ]

    unexpectedFiles.forEach(file => {
      expect(packageJson.files).not.toContain(file)
    })
  })
})
