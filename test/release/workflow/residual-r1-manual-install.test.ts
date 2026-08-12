/**
 * PR-10 residual R1 — README manual install contradicts generated-only dist.
 *
 * This test proves that the README manual install instructions either:
 * 1. Require a build step before copying generated dist targets, OR
 * 2. Never claim that generated dist/ is already present in a fresh clone.
 *
 * This is a focused regression for the residual R1 issue described in
 * docs/CRIP/PR-10/oracle-final-rereview.md lines 145-187.
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { pathFromRoot } from "./workflow-parse"

const README = readFileSync(pathFromRoot("README.md"), "utf8")

describe("PR-10 residual R1 — README manual install must be truthful for generated-only dist", () => {
  it("manual install section either requires build step or never claims dist/ is already present", () => {
    // Extract the manual install section
    const manualInstallMatch = README.match(/### Manual install from generated artifacts([\s\S]*?)###/)
    if (!manualInstallMatch) {
      throw new Error("Could not find manual install section in README")
    }

    const manualInstallSection = manualInstallMatch[1]

    // Check if the section requires a build step
    const requiresBuild = /npm ci|npm run build/.test(manualInstallSection)

    // Check if the section claims dist/ is already present (without requiring build)
    const claimsDistPresent = /cp dist\//.test(manualInstallSection) && !requiresBuild

    // The assertion: either requires build OR never claims dist/ is present
    expect(
      requiresBuild || !claimsDistPresent,
      "Manual install section must either require a build step (npm ci && npm run build) before copying generated dist targets, OR never claim that generated dist/ is already present in a fresh clone.",
    ).toBe(true)
  })

  it("one-liner description uses release asset names, not repository dist paths", () => {
    // The one-liner should describe immutable release assets: tokenmaxxer.js, tokenmaxxer-tui.js, tokenmaxxer-cli.js, tokenmaxxer
    // NOT repository dist paths like dist/index.js, dist/tui.js
    const oneLinerMatch = README.match(/The one-liner downloads the immutable GitHub Release assets([\s\S]*?)(?:\n\n|\n-)/)
    const oneLinerSection = oneLinerMatch ? oneLinerMatch[1] : ""

    // Check that one-liner mentions release asset names
    const hasReleaseAssets = /tokenmaxxer\.(js|tui|cli|js|)$/i.test(oneLinerSection) || /tokenmaxxer$/.test(oneLinerSection) || /tokenmaxxer\.(js|tui|cli|js)/.test(oneLinerSection) || /tokenmaxxer-tui\.js/.test(oneLinerSection) || /tokenmaxxer-cli\.js/.test(oneLinerSection) || /tokenmaxxer\.js/.test(oneLinerSection) || /`tokenmaxxer\.(js|tui|cli|js)`/.test(oneLinerSection)

    // Check that one-liner does NOT mention repository dist paths (unless in context of build)
    const mentionsDistPaths = /dist\//.test(oneLinerSection)

    // The assertion: one-liner should describe release assets, not repository dist paths
    expect(
      hasReleaseAssets && !mentionsDistPaths,
      "One-liner must describe immutable GitHub Release asset names (tokenmaxxer.js, tokenmaxxer-tui.js, tokenmaxxer-cli.js, tokenmaxxer), not repository dist paths.",
    ).toBe(true)
  })
})
