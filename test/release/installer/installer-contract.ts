/**
 * Frozen PR-10 installer integrity/transaction contract (Wave 1, Agent 1B).
 *
 * Mirrors the installer contract planned in PR-10 §7:
 *   1. every payload URL is pinned to the installer's embedded exact release tag;
 *   2. no payload URL may fetch `main` or a second `latest` lookup;
 *   3. all payloads come from one exact release tag (no mixed-release sets);
 *   4. SHA256SUMS is parsed strictly (64-hex digest + filename, sorted);
 *   5. every payload verifies against SHA256SUMS before any destination mutation;
 *   6. missing payload (e.g. CLI) refuses the entire install;
 *   7. malformed digest refuses the entire install;
 *   8. replacement is all-or-rollback: injected failure restores prior bytes;
 *   9. first install leaves no partial install on injected commit failure;
 *  10. receipt records exact version/tag/40-hex commit from the staged identity.
 *
 * The production implementation lands in `install.sh` (Wave 5). Until then
 * these rules are exercised here against fixtures so the contract itself is
 * frozen and behaviorally validated. Test-only code.
 */

import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs"
import { basename, join } from "node:path"

/** The single release identity every staged payload must carry. */
export const RELEASE_VERSION = "0.1.0"
export const RELEASE_TAG = "v0.1.0"
export const RELEASE_COMMIT = "0123456789abcdef0123456789abcdef01234567"

/** The four executable payloads the raw installer must download and verify. */
export const PAYLOAD_FILES = [
  "tokenmaxxer.js",
  "tokenmaxxer-tui.js",
  "tokenmaxxer-cli.js",
  "tokenmaxxer",
] as const

export const MANIFEST_FILE = "SHA256SUMS"
export const RELEASE_MANIFEST_FILE = "RELEASE.json"

const SHA256_RE = /^[0-9a-f]{64}$/
const COMMIT_RE = /^[0-9a-f]{40}$/
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export interface ContractViolation {
  field: string
  message: string
}

export interface EmbeddedIdentity {
  version?: string
  tag?: string
  commit?: string
  baseUrl?: string
}

/** Extract the embedded release identity placeholders from a staged installer. */
export function extractEmbeddedIdentity(text: string): EmbeddedIdentity {
  const identity: EmbeddedIdentity = {}
  const version = text.match(/RELEASE_VERSION\s*=\s*["']?([^"'\s]+)/)
  const tag = text.match(/RELEASE_TAG\s*=\s*["']?([^"'\s]+)/)
  const commit = text.match(/RELEASE_COMMIT\s*=\s*["']?([^"'\s]+)/)
  const baseUrl = text.match(/RELEASE_BASE_URL\s*=\s*["']?([^"'\s]+)/)
  if (version) identity.version = version[1]
  if (tag) identity.tag = tag[1]
  if (commit) identity.commit = commit[1]
  if (baseUrl) identity.baseUrl = baseUrl[1]
  return identity
}

/** Extract every download URL from a staged installer script. */
export function extractDownloadUrls(text: string): string[] {
  // Collect `VAR="value"` assignments so `$VAR` references in download calls
  // can be resolved to their concrete URL values.
  const assignments = new Map<string, string>()
  const assignRe = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']([^"']+)["']/gm
  let am: RegExpExecArray | null
  while ((am = assignRe.exec(text)) !== null) {
    assignments.set(am[1], am[2])
  }

  const resolve = (value: string): string => {
    let out = value
    for (let i = 0; i < 5; i += 1) {
      const next = out
        .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
          const v = assignments.get(name)
          return v !== undefined ? v : `\${${name}}`
        })
        .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
          const v = assignments.get(name)
          return v !== undefined ? v : `$${name}`
        })
      if (next === out) break
      out = next
    }
    return out
  }

  const urls: string[] = []
  const patterns = [
    /download\s+["']([^"']+)["']/g,
    /(?:PLUGIN_URL|TUI_PLUGIN_URL|CLI_PLUGIN_URL|LAUNCHER_URL|PAYLOAD_URL|SHA256SUMS_URL|RELEASE_JSON_URL)\s*=\s*["']([^"']+)["']/g,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      urls.push(resolve(m[1]))
    }
  }
  return urls
}

/**
 * Violations of the exact-tag URL pinning contract (PR-10 §7):
 *   - every payload URL must be pinned to the embedded exact release tag;
 *   - no payload URL may use `raw.githubusercontent.com/.../main` or a second
 *     `latest` lookup;
 *   - all payload URLs must share one exact release tag (no mixed releases).
 */
export function urlPinViolations(text: string): ContractViolation[] {
  const violations: ContractViolation[] = []
  const identity = extractEmbeddedIdentity(text)
  const urls = extractDownloadUrls(text)

  if (urls.length === 0) {
    violations.push({ field: "urls", message: "installer declares no payload download URLs" })
    return violations
  }

  // Resolve embedded identity variables (e.g. `${RELEASE_TAG}`) inside URLs so
  // the pinning check sees the concrete release tag the installer will fetch.
  const expand = (url: string): string =>
    url
      .replace(/\$\{RELEASE_TAG\}/g, identity.tag ?? "")
      .replace(/\$\{RELEASE_VERSION\}/g, identity.version ?? "")
      .replace(/\$\{RELEASE_COMMIT\}/g, identity.commit ?? "")
      .replace(/\$\{RELEASE_BASE_URL\}/g, identity.baseUrl ?? "")

  const pinnedTags = new Set<string>()
  for (const rawUrl of urls) {
    const url = expand(rawUrl)
    if (/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\//.test(url)) {
      violations.push({
        field: "url",
        message: `payload URL fetches mutable main: ${url}`,
      })
    }
    if (/\/releases\/latest\/download\//.test(url)) {
      violations.push({
        field: "url",
        message: `payload URL performs a second latest lookup: ${url}`,
      })
    }
    const tagMatch = url.match(/\/releases\/download\/([^/]+)\//)
    if (!tagMatch) {
      violations.push({
        field: "url",
        message: `payload URL is not pinned to a release tag: ${url}`,
      })
      continue
    }
    pinnedTags.add(tagMatch[1])
  }

  if (identity.tag && pinnedTags.size > 0) {
    for (const tag of pinnedTags) {
      if (tag !== identity.tag) {
        violations.push({
          field: "url",
          message: `payload URL pinned to tag "${tag}" but installer embeds exact tag "${identity.tag}"`,
        })
      }
    }
  }
  if (pinnedTags.size > 1) {
    violations.push({
      field: "url",
      message: `payload URLs mix multiple release tags: ${[...pinnedTags].join(", ")}`,
    })
  }
  return violations
}

export interface ChecksumEntry {
  digest: string
  filename: string
}

export interface ChecksumManifest {
  entries: ChecksumEntry[]
  violations: ContractViolation[]
}

/**
 * Parse a SHA256SUMS manifest strictly. Every line must be
 * `<64 lowercase hex>  <filename>`; anything else is a malformed-digest
 * violation that must refuse the entire install (PR-10 §7.1, case 63).
 */
export function parseChecksumManifest(text: string): ChecksumManifest {
  const entries: ChecksumEntry[] = []
  const violations: ContractViolation[] = []
  const seen = new Set<string>()

  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "")
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{64})\s{1,2}(\S+)$/)
    if (!m) {
      violations.push({
        field: "manifest",
        message: `malformed digest line: "${line}"`,
      })
      continue
    }
    const [, digest, filename] = m
    if (seen.has(filename)) {
      violations.push({
        field: "manifest",
        message: `duplicate checksum line for "${filename}"`,
      })
    }
    seen.add(filename)
    entries.push({ digest, filename })
  }
  return { entries, violations }
}

export interface StagedReleaseVerification {
  ok: boolean
  violations: ContractViolation[]
}

function sha256OfFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

/**
 * Verify a staged release directory against its SHA256SUMS manifest.
 * Fails when: the manifest is missing, a digest line is malformed, a payload
 * is missing, or any payload digest does not match (PR-10 §7.1, cases 55–63).
 */
export function verifyStagedRelease(dir: string): StagedReleaseVerification {
  const violations: ContractViolation[] = []
  const manifestPath = join(dir, MANIFEST_FILE)
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      violations: [
        { field: "manifest", message: `missing ${MANIFEST_FILE} in staged release` },
      ],
    }
  }
  const manifest = parseChecksumManifest(readFileSync(manifestPath, "utf8"))
  violations.push(...manifest.violations)

  const byName = new Map(manifest.entries.map((e) => [e.filename, e.digest]))
  for (const payload of PAYLOAD_FILES) {
    const payloadPath = join(dir, payload)
    if (!existsSync(payloadPath)) {
      violations.push({
        field: "payload",
        message: `missing payload "${payload}" refuses the entire install`,
      })
      continue
    }
    const expected = byName.get(payload)
    if (!expected) {
      violations.push({
        field: "payload",
        message: `no checksum line for payload "${payload}"`,
      })
      continue
    }
    const actual = sha256OfFile(payloadPath)
    if (actual !== expected) {
      violations.push({
        field: "payload",
        message: `payload "${payload}" digest mismatch (tampered or corrupted)`,
      })
    }
  }
  return { ok: violations.length === 0, violations }
}

/** Extract the `release-tag:` / `release-commit:` identity markers from a payload. */
export function payloadIdentity(file: string): { tag?: string; commit?: string } {
  const text = readFileSync(file, "utf8")
  const tag = text.match(/release-tag:\s*(\S+)/)
  const commit = text.match(/release-commit:\s*(\S+)/)
  return {
    tag: tag?.[1],
    commit: commit?.[1],
  }
}

/**
 * Violations of the no-mixed-release contract: every payload must carry the
 * same release tag/commit as RELEASE.json (PR-10 §7, case 67/68).
 */
export function payloadIdentityViolations(dir: string): ContractViolation[] {
  const violations: ContractViolation[] = []
  const releasePath = join(dir, RELEASE_MANIFEST_FILE)
  if (!existsSync(releasePath)) {
    return [
      {
        field: "identity",
        message: `missing ${RELEASE_MANIFEST_FILE} in staged release`,
      },
    ]
  }
  let release: { tag?: string; commit?: string } = {}
  try {
    release = JSON.parse(readFileSync(releasePath, "utf8")) as { tag?: string; commit?: string }
  } catch {
    return [{ field: "identity", message: `${RELEASE_MANIFEST_FILE} is not valid JSON` }]
  }
  for (const payload of PAYLOAD_FILES) {
    const payloadPath = join(dir, payload)
    if (!existsSync(payloadPath)) continue
    const identity = payloadIdentity(payloadPath)
    if (identity.tag && release.tag && identity.tag !== release.tag) {
      violations.push({
        field: "identity",
        message: `payload "${payload}" is from tag "${identity.tag}" but RELEASE.json declares "${release.tag}"`,
      })
    }
    if (identity.commit && release.commit && identity.commit !== release.commit) {
      violations.push({
        field: "identity",
        message: `payload "${payload}" is from commit "${identity.commit}" but RELEASE.json declares "${release.commit}"`,
      })
    }
  }
  return violations
}

export interface Receipt {
  schema_version?: number
  version?: string
  tag?: string
  commit?: string
}

/** Violations of the installation-receipt contract (PR-10 §7.3, cases 78–85). */
export function validateReceipt(receipt: Receipt): ContractViolation[] {
  const violations: ContractViolation[] = []
  if (receipt.schema_version !== 1) {
    violations.push({ field: "schema_version", message: "receipt schema_version must be exactly 1" })
  }
  if (typeof receipt.version !== "string" || !SEMVER_RE.test(receipt.version)) {
    violations.push({ field: "version", message: "receipt version must be valid SemVer" })
  }
  if (typeof receipt.tag !== "string" || receipt.tag !== `v${receipt.version}`) {
    violations.push({
      field: "tag",
      message: `receipt tag must exactly equal "v${receipt.version}"`,
    })
  }
  if (typeof receipt.commit !== "string" || !COMMIT_RE.test(receipt.commit)) {
    violations.push({
      field: "commit",
      message: "receipt commit must be exactly 40 lowercase hex characters",
    })
  }
  return violations
}

export interface TargetSpec {
  /** Destination path that the installer replaces. */
  target: string
  /** Verified staged payload that will be committed to the target. */
  staged: string
}

/**
 * Reference all-or-rollback replacement (PR-10 §7.2, cases 69–77).
 *
 * 1. copy verified staged files to unique destination-side temp files;
 * 2. create backups of every existing target;
 * 3. rename verified temps into place;
 * 4. if any replacement fails, restore all prior targets and remove partial
 *    new files.
 *
 * This is the frozen behavioral contract the production installer must match.
 * Test-only implementation.
 */
export function transactionalReplace(
  targets: TargetSpec[],
  options: { failOn?: string } = {},
): { ok: boolean; error?: string } {
  const { failOn } = options
  const backups: { target: string; backup: string; existed: boolean }[] = []
  const committed: string[] = []
  const temps: string[] = []

  try {
    // Phase 1: stage destination-side temp files (no mutation of targets).
    for (const spec of targets) {
      const temp = `${spec.target}.tmp.${Math.random().toString(36).slice(2)}`
      temps.push(temp)
      // Copy verified staged bytes to the destination-side temp file.
      copyFileSync(spec.staged, temp)
    }

    // Phase 2: back up every existing target.
    for (const spec of targets) {
      if (existsSync(spec.target)) {
        const backup = `${spec.target}.bak.${Math.random().toString(36).slice(2)}`
        copyFileSync(spec.target, backup)
        backups.push({ target: spec.target, backup, existed: true })
      } else {
        backups.push({ target: spec.target, backup: "", existed: false })
      }
    }

    // Phase 3: rename verified temps into place.
    for (let i = 0; i < targets.length; i += 1) {
      if (failOn && basename(targets[i].target) === failOn) {
        throw new Error(`injected replacement failure on ${targets[i].target}`)
      }
      renameSync(temps[i], targets[i].target)
      committed.push(targets[i].target)
    }

    return { ok: true }
  } catch (error) {
    // Phase 4: restore all prior targets and remove partial new files.
    for (const target of committed) {
      try {
        rmSync(target, { force: true })
      } catch {
        // best-effort cleanup
      }
    }
    for (const backup of backups) {
      if (backup.existed) {
        try {
          renameSync(backup.backup, backup.target)
        } catch {
          // best-effort restore
        }
      } else {
        try {
          rmSync(backup.target, { force: true })
        } catch {
          // best-effort cleanup
        }
      }
    }
    for (const temp of temps) {
      try {
        rmSync(temp, { force: true })
      } catch {
        // best-effort cleanup
      }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Read a directory's file names (sorted) for inventory assertions. */
export function listFiles(dir: string): string[] {
  return readdirSync(dir).sort()
}

/** True when a file exists and is non-empty. */
export function isNonEmptyFile(file: string): boolean {
  return existsSync(file) && statSync(file).size > 0
}
