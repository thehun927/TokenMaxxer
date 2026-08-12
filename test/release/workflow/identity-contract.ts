/**
 * Frozen PR-10 tag/package/commit identity validation contract (Wave 1, Agent 1C).
 *
 * Mirrors the release-preflight identity checks planned in PR-10 §6.2:
 *   1. version is valid SemVer;
 *   2. tag is exactly `v${package.version}`;
 *   3. commit is exactly 40 lowercase hex;
 *   4. peer range remains `>=1.18.15 <2.0.0`;
 *   5. minimum dev/host contract remains `1.18.15`.
 *
 * The production implementation lands in `scripts/release-preflight.mjs`
 * (Wave 4). Until then these rules are exercised here against fixtures so the
 * contract itself is frozen and behaviorally validated. Test-only code.
 */

export interface IdentityViolation {
  field: string
  message: string
}

export interface ReleaseIdentityInput {
  version: string
  tag: string
  commit: string
  opencodePeer?: string
  opencodeMinimumVerified?: string
  schemaVersion?: number
}

export const EXPECTED_OPENCODE_PEER = ">=1.18.15 <2.0.0"
export const EXPECTED_OPENCODE_MINIMUM = "1.18.15"
export const RELEASE_MANIFEST_SCHEMA_VERSION = 1

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const COMMIT_RE = /^[0-9a-f]{40}$/

export function validateVersion(version: string): IdentityViolation[] {
  if (typeof version !== "string" || version.trim() === "") {
    return [{ field: "version", message: "version is required" }]
  }
  if (!SEMVER_RE.test(version)) {
    return [{ field: "version", message: `version "${version}" is not valid SemVer` }]
  }
  return []
}

export function validateTagMatchesVersion(tag: string, version: string): IdentityViolation[] {
  const expected = `v${version}`
  if (tag !== expected) {
    return [
      {
        field: "tag",
        message: `tag "${tag}" must exactly equal "v${version}" (= v${version})`,
      },
    ]
  }
  return []
}

export function validateCommit(commit: string): IdentityViolation[] {
  if (typeof commit !== "string" || commit.trim() === "") {
    return [{ field: "commit", message: "commit is required" }]
  }
  if (!COMMIT_RE.test(commit)) {
    return [
      {
        field: "commit",
        message: `commit "${commit}" must be exactly 40 lowercase hex characters`,
      },
    ]
  }
  return []
}

export function validatePeerRange(peer: string): IdentityViolation[] {
  if (peer !== EXPECTED_OPENCODE_PEER) {
    return [
      {
        field: "opencode_peer",
        message: `opencode_peer must be "${EXPECTED_OPENCODE_PEER}", got "${peer}"`,
      },
    ]
  }
  return []
}

export function validateMinimumVerified(minimum: string): IdentityViolation[] {
  if (minimum !== EXPECTED_OPENCODE_MINIMUM) {
    return [
      {
        field: "opencode_minimum_verified",
        message: `opencode_minimum_verified must be "${EXPECTED_OPENCODE_MINIMUM}", got "${minimum}"`,
      },
    ]
  }
  return []
}

export function validateReleaseIdentity(input: ReleaseIdentityInput): IdentityViolation[] {
  const violations: IdentityViolation[] = [
    ...validateVersion(input.version),
    ...validateTagMatchesVersion(input.tag, input.version),
    ...validateCommit(input.commit),
  ]
  if (input.opencodePeer !== undefined) violations.push(...validatePeerRange(input.opencodePeer))
  if (input.opencodeMinimumVerified !== undefined) {
    violations.push(...validateMinimumVerified(input.opencodeMinimumVerified))
  }
  return violations
}

export interface ManifestIdentity {
  schema_version: number
  version: string
  tag: string
  commit: string
  opencode_peer: string
  opencode_minimum_verified: string
}

/** Extracts the identity fields of a RELEASE.json manifest (schema v1). */
export function parseManifestIdentity(raw: unknown): ManifestIdentity | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  if (
    typeof obj.schema_version !== "number" ||
    typeof obj.version !== "string" ||
    typeof obj.tag !== "string" ||
    typeof obj.commit !== "string"
  ) {
    return null
  }
  return {
    schema_version: obj.schema_version,
    version: obj.version,
    tag: obj.tag,
    commit: obj.commit,
    opencode_peer:
      typeof obj.opencode_peer === "string" ? obj.opencode_peer : "",
    opencode_minimum_verified:
      typeof obj.opencode_minimum_verified === "string"
        ? obj.opencode_minimum_verified
        : "",
  }
}

export function validateManifestIdentity(raw: unknown): IdentityViolation[] {
  const manifest = parseManifestIdentity(raw)
  if (!manifest) {
    return [{ field: "manifest", message: "RELEASE.json identity fields are missing or malformed" }]
  }
  const violations: IdentityViolation[] = []
  if (manifest.schema_version !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    violations.push({
      field: "schema_version",
      message: `RELEASE.json schema_version must be ${RELEASE_MANIFEST_SCHEMA_VERSION}, got ${manifest.schema_version}`,
    })
  }
  violations.push(
    ...validateReleaseIdentity({
      version: manifest.version,
      tag: manifest.tag,
      commit: manifest.commit,
      opencodePeer: manifest.opencode_peer,
      opencodeMinimumVerified: manifest.opencode_minimum_verified,
    }),
  )
  return violations
}
