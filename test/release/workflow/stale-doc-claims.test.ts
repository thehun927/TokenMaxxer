/**
 * PR-10 stale release URL / documentation claim assertions (Wave 1, Agent 1C).
 *
 * These claims are stale under PR-10 §1.6/§7/§11 and MUST disappear once the
 * documentation truth pass lands:
 *   - README one-liner downloading from mutable `raw.githubusercontent.com/.../main`;
 *   - README describing tracked `dist/` as the distribution/release authority;
 *   - README describing compaction as replacing the native prompt by default;
 *   - README describing `recall_promote` as directly minting foundational trust;
 *   - installer payload URLs pointing at `main` (mutable, can mix revisions);
 *   - launcher recovery claim for unverified `npm install -g tokenmaxxer@latest`;
 *   - debug section omitting the PR-9 successful result diagnostic.
 *
 * PR-10 must replace them with immutable GitHub Release URLs, generated-only
 * dist semantics, native-augment compaction wording, human-review promotion
 * wording, and the PR-9 result diagnostic. All assertions in this file assert
 * the ABSENCE of stale claims, so they fail intentionally while production is
 * still pre-PR-10.
 */

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { pathFromRoot } from "./workflow-parse"

const README = readFileSync(pathFromRoot("README.md"), "utf8")
const INSTALLER = readFileSync(pathFromRoot("install.sh"), "utf8")
const LAUNCHER = readFileSync(pathFromRoot("bin/tokenmaxxer"), "utf8")

describe("PR-10 stale mutable-main install URLs must disappear (W1C-S1)", () => {
  it("README one-liner no longer uses raw.githubusercontent.com/.../main", () => {
    expect(
      /raw\.githubusercontent\.com\/[^\s`)]*\/main\/install\.sh/.test(README),
      "expected pre-PR-10 failure: README still advertises the mutable raw main one-liner; it must use the immutable GitHub Release asset (PR-10 §7/§11)",
    ).toBe(false)
  })

  it("installer no longer downloads any payload from mutable main", () => {
    const urls = INSTALLER.match(/https?:\/\/[^\s"']+/g) ?? []
    const mainUrls = urls.filter((u) => /raw\.githubusercontent\.com[^\s]*\/main\//.test(u))
    expect(
      mainUrls,
      "expected pre-PR-10 failure: install.sh still downloads server/TUI/CLI/launcher from mutable main; PR-10 pins every payload URL to one exact release tag",
    ).toEqual([])
    expect(
      /raw\.githubusercontent\.com/.test(INSTALLER),
      "expected pre-PR-10 failure: install.sh still contains raw.githubusercontent URLs; PR-10 removes all mutable main fetches",
    ).toBe(false)
  })

  it("README install section uses the immutable releases/latest/download installer asset", () => {
    expect(
      README.includes("releases/latest/download/install.sh"),
      "expected pre-PR-10 failure: README one-liner must point at the GitHub Release installer asset (PR-10 §7)",
    ).toBe(true)
  })
})

describe("PR-10 tracked-dist distribution authority claims must disappear (W1C-S2)", () => {
  it("README no longer describes tracked dist/ as distribution truth", () => {
    expect(
      /tracked single-file distribution/i.test(README),
      "expected pre-PR-10 failure: README still calls tracked dist/ the distribution; PR-10 makes dist/ generated-only",
    ).toBe(false)
    expect(
      /Manual install from the tracked artifacts/i.test(README),
      "expected pre-PR-10 failure: README still documents installing from tracked dist artifacts",
    ).toBe(false)
  })

  it("README no longer says the one-liner downloads the tracked dist targets", () => {
    expect(
      /downloads the tracked [`]?dist\//.test(README),
      "expected pre-PR-10 failure: README still describes downloading tracked dist files",
    ).toBe(false)
  })
})

describe("PR-10 stale compaction/promotion semantics must disappear (W1C-S3/S4)", () => {
  it("README no longer claims compaction replaces the native prompt by default", () => {
    expect(
      /replaces the default compaction prompt/i.test(README),
      "expected pre-PR-10 failure: PR-7 shipped augment-native-by-default; README must not say the hook replaces the default prompt",
    ).toBe(false)
  })

  it("README no longer claims recall_promote directly mints foundational trust", () => {
    expect(
      /Marks a decision as foundational/i.test(README),
      "expected pre-PR-10 failure: PR-3 moved human promotion behind the CLI review boundary; README must describe recall_promote as requesting human review",
    ).toBe(false)
  })
})

describe("PR-10 unverified npm recovery claims must disappear (W1C-S5)", () => {
  it("launcher no longer advertises npm install -g tokenmaxxer@latest as a recovery channel", () => {
    expect(
      /npm install -g tokenmaxxer@latest/.test(LAUNCHER),
      "expected pre-PR-10 failure: bin/tokenmaxxer still claims an unverified npm publication channel; PR-10 removes it unless npm publication is separately verified",
    ).toBe(false)
  })
})

describe("PR-10 debug docs must describe shipped PR-9 diagnostics (W1C-S6)", () => {
  it("README debug section documents the successful result diagnostic", () => {
    expect(
      /last_compaction_result\.json/.test(README),
      "expected pre-PR-10 failure: README debug documentation still omits the PR-9 successful compaction result diagnostic",
    ).toBe(true)
  })
})
