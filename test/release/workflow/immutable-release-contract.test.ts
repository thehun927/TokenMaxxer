/**
 * PR-10 Oracle finding B2 — immutable-release contract regressions.
 *
 * Oracle B2 (docs/CRIP/PR-10/oracle-findings.md) blocks the tag release because
 * the release workflow:
 *   1. proved immutable releases by querying the general repository object
 *      (`repos/$GITHUB_REPOSITORY`), which does not expose
 *      `.security_and_analysis.immutable_releases` and is not the documented
 *      immutable-release status API;
 *   2. authenticated that lookup with the ordinary `github.token` under
 *      `contents: write`, which does NOT grant the required
 *      Administration: read permission;
 *   3. ran `gh release verify` before the draft was published, although
 *      `gh release verify` validates the immutable-release attestation that
 *      only exists after publication;
 *   4. interleaved pre-publish attestation verification instead of first
 *      verifying the complete uploaded asset inventory and the local/staged
 *      checksums and identity, and only then publishing.
 *
 * Required structure frozen here:
 *   - dedicated GET /repos/$GITHUB_REPOSITORY/immutable-releases endpoint;
 *   - explicit Administration-read credential secret (e.g.
 *     secrets.RELEASE_ADMIN_TOKEN) with a fail-closed guard when the credential
 *     is absent, and never `github.token`;
 *   - `gh release verify` only immediately after publish;
 *   - complete asset-inventory + staged checksum/identity verification before
 *     publish, with publish only after those checks pass.
 *
 * Fixtures are embedded as inline YAML strings so the contract can be exercised
 * without writing extra fixture files. Validation owner: Luna.
 */

import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import {
  allJobText,
  loadWorkflow,
  pathFromRoot,
  type WorkflowJob,
  type WorkflowModel,
  type WorkflowStep,
} from "./workflow-parse"

/** Build a WorkflowModel from an inline YAML string (fixture-driven tests). */
function modelFromYaml(name: string, text: string): WorkflowModel {
  const doc = (parse(text) ?? {}) as Record<string, unknown>
  const jobs: Record<string, WorkflowJob> = {}
  const rawJobs = (doc.jobs ?? {}) as Record<string, unknown>
  for (const [jobName, job] of Object.entries(rawJobs)) {
    const j = (job ?? {}) as {
      name?: unknown
      permissions?: unknown
      steps?: unknown
      "runs-on"?: unknown
    }
    jobs[jobName] = {
      name: typeof j.name === "string" ? j.name : undefined,
      permissions: j.permissions,
      runsOn: typeof j["runs-on"] === "string" ? j["runs-on"] : undefined,
      steps: Array.isArray(j.steps) ? (j.steps as WorkflowStep[]) : [],
    }
  }
  return {
    file: `inline:${name}`,
    name: typeof doc.name === "string" ? doc.name : undefined,
    on: doc.on,
    permissions: doc.permissions,
    jobs,
    rawUses: [],
  }
}

/** Assemble a minimal release workflow YAML from pre-indented step blocks. */
function releaseYaml(steps: string[]): string {
  return [
    "name: Release",
    "",
    "on:",
    "  push:",
    "    tags: ['v*.*.*']",
    "",
    "permissions:",
    "  contents: write",
    "",
    "jobs:",
    "  publish:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: write",
    "    steps:",
    ...steps,
    "",
  ].join("\n")
}

const DRAFT_STEP = `      - name: Create draft release
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" --draft --verify-tag --title "TokenMaxxer $GITHUB_REF_NAME"`

const UPLOAD_STEP = `      - name: Upload complete staged asset set
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh release upload "$GITHUB_REF_NAME" .release/RELEASE.json .release/SHA256SUMS .release/install.sh .release/tokenmaxxer .release/tokenmaxxer.js .release/tokenmaxxer-tui.js .release/tokenmaxxer-cli.js .release/tokenmaxxer.d.ts .release/tokenmaxxer-tui.d.ts .release/tokenmaxxer-cli.d.ts .release/tokenmaxxer-*.tgz`

/** Pre-publish inventory + staged checksum/identity verification (no gh release verify). */
const INVENTORY_VERIFY_STEP = `      - name: Verify uploaded asset inventory and staged checksums before publish
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          actual="$(gh release view "$GITHUB_REF_NAME" --json assets --jq '.assets | map(.name) | sort | join("\\n")')"
          tarball="$(printf '%s\\n' .release/tokenmaxxer-*.tgz | xargs -n1 basename)"
          expected="$(printf '%s\\n' RELEASE.json SHA256SUMS install.sh tokenmaxxer tokenmaxxer.js tokenmaxxer-tui.js tokenmaxxer-cli.js tokenmaxxer.d.ts tokenmaxxer-tui.d.ts tokenmaxxer-cli.d.ts "$tarball" | sort)"
          test "$actual" = "$expected"
          npm run release:verify -- --dir .release --tag "$GITHUB_REF_NAME" --commit "$GITHUB_SHA"`

const PUBLISH_STEP = `      - name: Publish verified draft
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh release edit "$GITHUB_REF_NAME" --draft=false`

const VERIFY_AFTER_PUBLISH_STEP = `      - name: Verify published release (immutable attestation)
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh release verify "$GITHUB_REF_NAME"`

/** Wrong endpoint: repository-object query + .security_and_analysis field. */
const PREFLIGHT_WRONG_ENDPOINT = `      - name: Prove immutable releases are enabled (fail closed)
        env:
          GH_TOKEN: \${{ secrets.RELEASE_ADMIN_TOKEN }}
        run: |
          set -euo pipefail
          : "\${GH_TOKEN:?secrets.RELEASE_ADMIN_TOKEN is required}"
          settings="$(gh api "repos/\${GITHUB_REPOSITORY}" --jq '{immutable_releases: .security_and_analysis.immutable_releases}')"
          printf '%s\\n' "$settings"
          test "$(printf '%s' "$settings" | jq -r '.immutable_releases.enabled // false')" = true`

/** Missing auth input: dedicated endpoint but github.token, no fail-closed guard. */
const PREFLIGHT_MISSING_AUTH = `      - name: Prove immutable releases are enabled (fail closed)
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          settings="$(gh api "/repos/\${GITHUB_REPOSITORY}/immutable-releases" --jq '{enabled: .enabled, enforced_by_owner: .enforced_by_owner}')"
          printf '%s\\n' "$settings"
          test "$(printf '%s' "$settings" | jq -r '.enabled // false')" = true`

/** Correct endpoint + auth, but runs gh release verify before publishing. */
const PREPUBLISH_GH_VERIFY_STEP = `      - name: Verify uploaded assets before publish (attestation verify too early)
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          gh release verify "$GITHUB_REF_NAME"
          gh release view "$GITHUB_REF_NAME" --json assets --jq '.assets | map(.name) | sort | join("\\n")'
          npm run release:verify -- --dir .release --tag "$GITHUB_REF_NAME" --commit "$GITHUB_SHA"`

/** Correct endpoint + auth, but publishes before the asset set is verified. */
const PUBLISH_BEFORE_VERIFY_STEP = `      - name: Publish verified draft
        env:
          GH_TOKEN: \${{ github.token }}
        run: gh release edit "$GITHUB_REF_NAME" --draft=false`

const ENDPOINT_RE = /\/repos\/\$\{GITHUB_REPOSITORY\}\/immutable-releases/
const WRONG_ENDPOINT_RE = /gh\s+api\s+["']?repos\/\$\{GITHUB_REPOSITORY\}(?!\/immutable-releases)/
const REPO_OBJECT_FIELD_RE = /security_and_analysis\.immutable_releases/
const PUBLISH_RE = /--draft=false/
const GH_VERIFY_RE = /gh\s+release\s+verify\b/
const INVENTORY_RE = /gh\s+release\s+view\b[^\n]*--json\s+assets/
const CHECKSUM_RE = /release:verify|sha256sum/

/**
 * Structural immutable-release contract for a release workflow. Returns every
 * violation; an empty array means the workflow is B2-compliant.
 */
function immutableContractViolations(model: WorkflowModel): string[] {
  const violations: string[] = []
  const steps = Object.values(model.jobs)[0]?.steps ?? []
  const text = allJobText(model)

  // 1) Dedicated immutable-release endpoint, never the repository object.
  if (!ENDPOINT_RE.test(text)) {
    violations.push(
      "immutable-status lookup must use the dedicated GET /repos/$GITHUB_REPOSITORY/immutable-releases endpoint",
    )
  }
  if (WRONG_ENDPOINT_RE.test(text)) {
    violations.push(
      "immutable-status lookup must not query the general repository object repos/$GITHUB_REPOSITORY",
    )
  }
  if (REPO_OBJECT_FIELD_RE.test(text)) {
    violations.push(
      "immutable-status lookup must not read .security_and_analysis.immutable_releases from the repository object",
    )
  }

  // 2) Administration-read credential with a fail-closed guard, never github.token.
  const immutableStep = steps.find((s) => (s.run ?? "").includes("immutable-releases"))
  if (immutableStep) {
    const stepWithEnv = immutableStep as WorkflowStep & { env?: Record<string, unknown> }
    const stepText = [
      stepWithEnv.name ?? "",
      Object.entries(stepWithEnv.env ?? {})
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join("\n"),
      stepWithEnv.run ?? "",
    ].join("\n")
    if (!/secrets\.[A-Za-z0-9_]+/.test(stepText)) {
      violations.push(
        "immutable-status step must authenticate with an explicit Administration-read credential secret (e.g. secrets.RELEASE_ADMIN_TOKEN)",
      )
    }
    if (stepText.includes("github.token")) {
      violations.push(
        "immutable-status step must not use github.token (contents:write does not grant Administration read)",
      )
    }
    const failClosed =
      /\$\{GH_TOKEN:\?/.test(stepText) ||
      /\btest\s+-[zn]\s+"\$GH_TOKEN"/.test(stepText) ||
      /\[\[\s*-z\s+"\$GH_TOKEN"/.test(stepText)
    if (!failClosed) {
      violations.push(
        "immutable-status step must fail closed when the Administration-read credential is absent",
      )
    }
  }

  // 3) gh release verify only immediately after publication.
  const publishIndex = steps.findIndex((s) => PUBLISH_RE.test(s.run ?? ""))
  const verifyIndex = steps.findIndex((s) => GH_VERIFY_RE.test(s.run ?? ""))
  if (publishIndex !== -1 && verifyIndex !== -1 && verifyIndex < publishIndex) {
    violations.push("gh release verify must run only after the draft is published")
  }

  // 4) Complete uploaded asset inventory + staged checksum/identity checks before publish.
  const inventoryIndex = steps.findIndex((s) => INVENTORY_RE.test(s.run ?? ""))
  const checksumIndex = steps.findIndex((s) => CHECKSUM_RE.test(s.run ?? ""))
  if (inventoryIndex === -1 || (publishIndex !== -1 && inventoryIndex > publishIndex)) {
    violations.push(
      "publish-before-asset-verification: complete uploaded asset inventory must be verified before publish",
    )
  }
  if (checksumIndex === -1 || (publishIndex !== -1 && checksumIndex > publishIndex)) {
    violations.push(
      "publish-before-asset-verification: staged checksums/identity must be verified before publish",
    )
  }

  return violations
}

describe("PR-10 B2 immutable-release contract — production workflow", () => {
  it("release.yml passes every B2 immutable-release contract check", () => {
    const release = loadWorkflow(pathFromRoot(".github/workflows/release.yml"))
    expect(immutableContractViolations(release)).toEqual([])
  })
})

describe("PR-10 B2 immutable-release contract — structural regressions", () => {
  const baseSteps = [DRAFT_STEP, UPLOAD_STEP]

  it("rejects the wrong repository-object endpoint for the immutable-status lookup", () => {
    const model = modelFromYaml(
      "wrong-endpoint",
      releaseYaml([
        PREFLIGHT_WRONG_ENDPOINT,
        ...baseSteps,
        INVENTORY_VERIFY_STEP,
        PUBLISH_STEP,
        VERIFY_AFTER_PUBLISH_STEP,
      ]),
    )
    const violations = immutableContractViolations(model)
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "must use the dedicated GET /repos/$GITHUB_REPOSITORY/immutable-releases endpoint",
        ),
        expect.stringContaining("must not query the general repository object"),
        expect.stringContaining(".security_and_analysis.immutable_releases"),
      ]),
    )
  })

  it("rejects a missing Administration-read auth input for the immutable-status lookup", () => {
    const model = modelFromYaml(
      "missing-auth",
      releaseYaml([
        PREFLIGHT_MISSING_AUTH,
        ...baseSteps,
        INVENTORY_VERIFY_STEP,
        PUBLISH_STEP,
        VERIFY_AFTER_PUBLISH_STEP,
      ]),
    )
    const violations = immutableContractViolations(model)
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("explicit Administration-read credential secret"),
        expect.stringContaining("must not use github.token"),
        expect.stringContaining("fail closed when the Administration-read credential is absent"),
      ]),
    )
  })

  it("rejects gh release verify before the draft is published", () => {
    const model = modelFromYaml(
      "pre-publish-verify",
      releaseYaml([DRAFT_STEP, UPLOAD_STEP, PREPUBLISH_GH_VERIFY_STEP, PUBLISH_STEP, VERIFY_AFTER_PUBLISH_STEP]),
    )
    const violations = immutableContractViolations(model)
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("gh release verify must run only after the draft is published"),
      ]),
    )
  })

  it("rejects publishing before the complete asset set is verified", () => {
    const model = modelFromYaml(
      "publish-before-verify",
      releaseYaml([DRAFT_STEP, UPLOAD_STEP, PUBLISH_BEFORE_VERIFY_STEP, INVENTORY_VERIFY_STEP, VERIFY_AFTER_PUBLISH_STEP]),
    )
    const violations = immutableContractViolations(model)
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("publish-before-asset-verification"),
      ]),
    )
  })

  it("rejects a workflow with no pre-publish asset verification at all", () => {
    const model = modelFromYaml(
      "no-asset-verification",
      releaseYaml([DRAFT_STEP, UPLOAD_STEP, PUBLISH_STEP, VERIFY_AFTER_PUBLISH_STEP]),
    )
    const violations = immutableContractViolations(model)
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("publish-before-asset-verification"),
      ]),
    )
  })
})
