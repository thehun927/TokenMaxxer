import { describe, expect, it } from "vitest"
import { execSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

describe("dist inventory contract", () => {
  const projectDir = new URL("../../", import.meta.url).pathname
  const distDir = join(projectDir, "dist")
  const expectedFiles = [
    "index.js",
    "index.d.ts",
    "tui.js",
    "tui.d.ts",
    "cli.js",
    "cli.d.ts",
  ]

  it("should generate exactly six expected dist files", () => {
    // This test will fail until PR-10 implementation builds dist/
    const files = readdirSync(distDir)
    expect(files).toHaveLength(6)
  })

  it("should have expected dist file names", () => {
    const files = readdirSync(distDir)
    const expectedSet = new Set(expectedFiles)
    const actualSet = new Set(files)

    expectedSet.forEach(file => {
      expect(actualSet.has(file)).toBe(true)
    })
  })

  it("should have no generated chunk imports in JS files", () => {
    // This is a behavioral test: check that no JS file imports from other dist files
    const jsFiles = readdirSync(distDir).filter(f => f.endsWith(".js"))
    jsFiles.forEach(file => {
      const content = readFileSync(join(distDir, file), "utf-8")
      // Check for common chunk import patterns
      const hasChunkImport = /from ['"]\.\.\/.*chunk|from ['"]\.\.\/.*dist\//.test(content)
      expect(hasChunkImport).toBe(false)
    })
  })

  it("should have .d.ts files matching .js files", () => {
    const jsFiles = readdirSync(distDir).filter(f => f.endsWith(".js"))
    jsFiles.forEach(jsFile => {
      const dtsFile = jsFile.replace(/\.js$/, ".d.ts")
      const dtsPath = join(distDir, dtsFile)
      expect(() => readFileSync(dtsPath, "utf-8")).not.toThrow()
    })
  })

  it("should have non-zero byte sizes for all dist files", () => {
    const files = readdirSync(distDir)
    files.forEach(file => {
      const filePath = join(distDir, file)
      const stats = execSync(`stat -c %s ${filePath}`, { encoding: "utf-8", cwd: projectDir }).trim()
      const size = parseInt(stats, 10)
      expect(size).toBeGreaterThan(0)
    })
  })
})
