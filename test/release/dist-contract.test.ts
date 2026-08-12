import { describe, expect, it } from "vitest"
import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

describe("dist authority contract", () => {
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

  it("allows a clean checkout to omit generated dist until build", () => {
    const distDir = join(projectDir, "dist")
    if (!existsSync(distDir)) {
      expect(existsSync(distDir)).toBe(false)
      return
    }
    const hasFiles = execSync(`ls -A ${distDir}`, { encoding: "utf-8", cwd: projectDir }).trim().length > 0
    expect(hasFiles).toBe(true)
  })
})
