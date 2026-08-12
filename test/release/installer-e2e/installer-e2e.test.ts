/**
 * Oracle B1 — production-shell integration tests for the real `install.sh`.
 *
 * These tests execute the repository's actual `install.sh` (not the
 * installer-contract.ts model) in an isolated HOME/TMPDIR with PATH shims so
 * every download command copies local staged assets. Both the curl and wget
 * download branches are exercised, plus the sha256sum/shasum checksum
 * abstraction that the production installer already implements.
 *
 * The staged fixture is built from
 * `test/release/installer/fixtures/staged-release/valid`; tampered / malformed
 * / missing-checksum variants are derived from it in a temporary copy so the
 * repository fixtures are never modified.
 *
 * Scenarios frozen here:
 *   - valid install (curl branch) creates all four targets + valid receipt;
 *   - valid install (wget branch) creates all four targets + valid receipt;
 *   - valid install (shasum branch) creates all four targets + valid receipt;
 *   - tampered payload fails before mutation and preserves prior bytes
 *     (curl and wget branches);
 *   - malformed checksum fails before mutation and preserves prior bytes;
 *   - missing checksum entry fails before mutation and preserves prior bytes;
 *   - injected replacement failure rolls back already-replaced targets and
 *     leaves no temp artifacts in the destination;
 *   - first-install failure leaves no partial targets.
 *
 * Validation owner: Luna.
 */

import { afterEach, describe, expect, it } from "vitest"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const INSTALL_SH = join(REPO_ROOT, "install.sh")
const FIXTURES = fileURLToPath(new URL("../installer/fixtures/staged-release/", import.meta.url))

const PAYLOAD_NAMES = ["tokenmaxxer.js", "tokenmaxxer-tui.js", "tokenmaxxer-cli.js", "tokenmaxxer"] as const
const RELEASE_VERSION = "0.1.0"
const RELEASE_TAG = "v0.1.0"
const RELEASE_COMMIT = "0123456789abcdef0123456789abcdef01234567"

const createdDirs: string[] = []

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function resolveTool(name: string): string {
  const out = execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim()
  if (!out) throw new Error(`required tool not found: ${name}`)
  return out
}

function makeSandbox(): { root: string; home: string; tmpdir: string } {
  const root = mkdtempSync(join(tmpdir(), "tokenmaxxer-e2e-"))
  createdDirs.push(root)
  const home = join(root, "home")
  const tmp = join(root, "tmp")
  mkdirSync(home, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  return { root, home, tmpdir: tmp }
}

interface ToolboxOptions {
  downloader: "curl" | "wget"
  checksum: "sha256sum" | "shasum"
  assets: string
  /** Destination path substring that makes the mv shim fail (injected replacement failure). */
  failMvOn?: string
}

function buildToolbox(root: string, opts: ToolboxOptions): string {
  const dir = join(root, "toolbox")
  mkdirSync(dir, { recursive: true })
  const tools = [
    "bash",
    "node",
    "awk",
    "mktemp",
    "rm",
    "cp",
    "mv",
    "mkdir",
    "dirname",
    "basename",
    "chmod",
    "printf",
    "env",
  ]
  if (opts.checksum === "sha256sum") tools.push("sha256sum")
  else tools.push("shasum", "perl")
  for (const tool of tools) {
    symlinkSync(resolveTool(tool), join(dir, tool))
  }
  const shim = opts.downloader === "curl" ? curlShim(opts.assets) : wgetShim(opts.assets)
  writeFileSync(join(dir, opts.downloader), shim, { mode: 0o755 })
  if (opts.failMvOn) {
    rmSync(join(dir, "mv"), { force: true })
    writeFileSync(join(dir, "mv"), mvShim(resolveTool("mv"), opts.failMvOn), { mode: 0o755 })
  }
  return dir
}

function curlShim(assets: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --retry) shift 2 ;;
    --retry-delay) shift 2 ;;
    --retry-connrefused) shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ -n "$out" ] || { echo "curl shim: missing -o" >&2; exit 2; }
[ -n "$url" ] || { echo "curl shim: missing url" >&2; exit 2; }
name="$(basename "$url")"
src="${assets}/$name"
[ -f "$src" ] || { echo "curl shim: no staged asset $name" >&2; exit 1; }
cp "$src" "$out"
`
}

function wgetShim(assets: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -O) out="$2"; shift 2 ;;
    -q) shift ;;
    --tries) shift 2 ;;
    --tries=*) shift ;;
    --waitretry) shift 2 ;;
    --waitretry=*) shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ -n "$out" ] || { echo "wget shim: missing -O" >&2; exit 2; }
[ -n "$url" ] || { echo "wget shim: missing url" >&2; exit 2; }
name="$(basename "$url")"
src="${assets}/$name"
[ -f "$src" ] || { echo "wget shim: no staged asset $name" >&2; exit 1; }
cp "$src" "$out"
`
}

function mvShim(realMv: string, failPattern: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 2 ] && [[ "$2" == *"${failPattern}"* ]]; then
  echo "mv shim: injected failure for $2" >&2
  exit 1
fi
exec ${realMv} "$@"
`
}

/** Copy the valid staged fixture into the sandbox as the local asset root. */
function stageFixture(root: string): string {
  const dst = join(root, "assets")
  cpSync(join(FIXTURES, "valid"), dst, { recursive: true })
  rmSync(join(dst, "install.sh"), { force: true })
  return dst
}

/** Valid fixture with tokenmaxxer.js modified after checksum generation. */
function stageTampered(root: string): string {
  const assets = stageFixture(root)
  const payload = join(assets, "tokenmaxxer.js")
  writeFileSync(payload, readFileSync(payload, "utf8") + "\n// tampered after SHA256SUMS generation\n")
  return assets
}

/** Valid fixture with a malformed digest line in SHA256SUMS. */
function stageMalformed(root: string): string {
  const assets = stageFixture(root)
  const sums = readFileSync(join(assets, "SHA256SUMS"), "utf8")
  const fixed = sums.replace(/^[0-9a-f]{64}  RELEASE\.json/m, "not-a-valid-sha256-digest  RELEASE.json")
  writeFileSync(join(assets, "SHA256SUMS"), fixed)
  return assets
}

/** Valid fixture with the tokenmaxxer.js checksum entry removed. */
function stageMissingChecksum(root: string): string {
  const assets = stageFixture(root)
  const sums = readFileSync(join(assets, "SHA256SUMS"), "utf8")
  const fixed = sums
    .split("\n")
    .filter((line) => !line.includes("tokenmaxxer.js"))
    .join("\n")
  writeFileSync(join(assets, "SHA256SUMS"), fixed + "\n")
  return assets
}

function runInstall(opts: { toolbox: string; home: string; tmpdir: string }): {
  status: number
  stdout: string
  stderr: string
} {
  const bash = resolveTool("bash")
  const res = spawnSync(bash, [INSTALL_SH], {
    env: { ...process.env, HOME: opts.home, TMPDIR: opts.tmpdir, PATH: opts.toolbox },
    encoding: "utf8",
  })
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
}

function makePriorInstall(home: string): { targets: Record<string, string>; receipt: string } {
  const plugins = join(home, ".config", "opencode", "plugins")
  const bin = join(home, ".local", "bin")
  mkdirSync(plugins, { recursive: true })
  mkdirSync(bin, { recursive: true })
  const targets: Record<string, string> = {}
  for (const name of PAYLOAD_NAMES) {
    const target = name === "tokenmaxxer" ? join(bin, name) : join(plugins, name)
    targets[name] = target
    writeFileSync(target, `prior-install bytes for ${name}\n`)
  }
  const receipt = join(home, ".config", "opencode", "tokenmaxxer-release.json")
  writeFileSync(
    receipt,
    JSON.stringify({
      schema_version: 1,
      version: "0.0.0",
      tag: "v0.0.0",
      commit: "0000000000000000000000000000000000000000",
    }),
  )
  return { targets, receipt }
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else out.push(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

function targetPath(home: string, name: string): string {
  return name === "tokenmaxxer"
    ? join(home, ".local", "bin", name)
    : join(home, ".config", "opencode", "plugins", name)
}

function receiptPath(home: string): string {
  return join(home, ".config", "opencode", "tokenmaxxer-release.json")
}

function assertValidInstall(home: string, assets: string): void {
  for (const name of PAYLOAD_NAMES) {
    const target = targetPath(home, name)
    expect(existsSync(target), `target ${name} must exist`).toBe(true)
    expect(
      readFileSync(target).equals(readFileSync(join(assets, name))),
      `target ${name} must match the staged payload byte-for-byte`,
    ).toBe(true)
  }
  const launcher = targetPath(home, "tokenmaxxer")
  expect(statSync(launcher).mode & 0o111, "launcher must be executable").not.toBe(0)
  const receipt = JSON.parse(readFileSync(receiptPath(home), "utf8")) as Record<string, unknown>
  expect(receipt).toEqual({
    schema_version: 1,
    version: RELEASE_VERSION,
    tag: RELEASE_TAG,
    commit: RELEASE_COMMIT,
  })
}

function assertPriorPreserved(prior: { targets: Record<string, string>; receipt: string }): () => void {
  const before = new Map(Object.entries(prior.targets).map(([n, p]) => [n, readFileSync(p)]))
  const receiptBefore = readFileSync(prior.receipt)
  return (): void => {
    for (const [name, target] of Object.entries(prior.targets)) {
      expect(
        readFileSync(target).equals(before.get(name)!),
        `prior ${name} must be byte-identical after failed install`,
      ).toBe(true)
    }
    expect(readFileSync(prior.receipt).equals(receiptBefore), "prior receipt must be byte-identical").toBe(true)
  }
}

describe("Oracle B1 — production install.sh e2e (curl branch)", () => {
  it("valid install creates all four targets and a valid receipt", () => {
    const sb = makeSandbox()
    const assets = stageFixture(sb.root)
    const toolbox = buildToolbox(sb.root, { downloader: "curl", checksum: "sha256sum", assets })
    const res = runInstall({ toolbox, home: sb.home, tmpdir: sb.tmpdir })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain("installed")
    assertValidInstall(sb.home, assets)
  })

  it("tampered payload fails before mutation and preserves prior bytes", () => {
    const sb = makeSandbox()
    const assets = stageTampered(sb.root)
    const prior = makePriorInstall(sb.home)
    const verify = assertPriorPreserved(prior)
    const toolbox = buildToolbox(sb.root, { downloader: "curl", checksum: "sha256sum", assets })
    const res = runInstall({ toolbox, home: sb.home, tmpdir: sb.tmpdir })
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain("SHA256SUMS verification failed")
    verify()
  })

  it("malformed checksum fails before mutation and preserves prior bytes", () => {
    const sb = makeSandbox()
    const assets = stageMalformed(sb.root)
    const prior = makePriorInstall(sb.home)
    const verify = assertPriorPreserved(prior)
    const toolbox = buildToolbox(sb.root, { downloader: "curl", checksum: "sha256sum", assets })
    const res = runInstall({ toolbox, home: sb.home, tmpdir: sb.tmpdir })
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain("malformed SHA256SUMS digest")
    verify()
  })

  it("missing checksum entry fails before mutation and preserves prior bytes", () => {
    const sb = makeSandbox()
    const assets = stageMissingChecksum(sb.root)
    const prior = makePriorInstall(sb.home)
    const verify = assertPriorPreserved(prior)
    const toolbox = buildToolbox(sb.root, { downloader: "curl", checksum: "sha256sum", assets })
    const res = runInstall({ toolbox, home: sb.home, tmpdir: sb.tmpdir })
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain("SHA256SUMS must contain")
    verify()
  })

  it("injected replacement failure rolls back already-replaced targets", () => {
    const sb = makeSandbox()
    const assets = stageFixture(sb.root)
    const prior = makePriorInstall(sb.home)
    const verify = assertPriorPreserved(prior)
    const toolbox = buildToolbox(sb.root, {
      downloader: "curl",
      checksum: "sha256sum",
      assets,
      failMvOn: "/.config/opencode/plugins/tokenmaxxer-cli.js",
    })
    const res = runInstall({ toolbox, home: sb.home, tmpdir: sb.tmpdir })
    expect(res.status).not.toBe(0)
    verify()
    const leftovers = listFilesRecursive(sb.home).filter((p) => p.includes(".tmp."))
    expect(leftovers, "no temp files may remain in the destination after rollback").toEqual([])
  })

  it("first-install failure leaves no partial targets", () => {
    const sb = makeSandbox()
    const assets = stageFixture(sb.root)
    const toolbox = buildToolbox(sb.root, {
      downloader: "curl",
      checksum: "sha256sum",
      assets,
      failMvOn: "/.local/bin/tokenmaxxer",
    })
    const res = runInstall({ toolbox, home: sb.home, tmpdir: sb.tmpdir })
    expect(res.status).not.toBe(0)
    expect(
      listFilesRecursive(sb.home),
      "no partial install: HOME must contain no files after a failed first install",
    ).toEqual([])
  })
})

describe("Oracle B1 — production install.sh e2e (wget branch)", () => {
  it("valid install creates all four targets and a valid receipt", () => {
    const sb = makeSandbox()
    const assets = stageFixture(sb.root)
    const toolbox = buildToolbox(sb.root, { downloader: "wget", checksum: "sha256sum", assets })
    const res = runInstall({ toolbox, home: sb.home, tmpdir: sb.tmpdir })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain("installed")
    assertValidInstall(sb.home, assets)
  })

  it("tampered payload fails before mutation and preserves prior bytes", () => {
    const sb = makeSandbox()
    const assets = stageTampered(sb.root)
    const prior = makePriorInstall(sb.home)
    const verify = assertPriorPreserved(prior)
    const toolbox = buildToolbox(sb.root, { downloader: "wget", checksum: "sha256sum", assets })
    const res = runInstall({ toolbox, home: sb.home, tmpdir: sb.tmpdir })
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain("SHA256SUMS verification failed")
    verify()
  })
})

describe("Oracle B1 — production install.sh e2e (shasum checksum branch)", () => {
  it("valid install creates all four targets and a valid receipt", () => {
    const sb = makeSandbox()
    const assets = stageFixture(sb.root)
    const toolbox = buildToolbox(sb.root, { downloader: "wget", checksum: "shasum", assets })
    const res = runInstall({ toolbox, home: sb.home, tmpdir: sb.tmpdir })
    expect(res.status).toBe(0)
    expect(res.stdout).toContain("installed")
    assertValidInstall(sb.home, assets)
  })
})

describe("Oracle B1 — production install.sh e2e (sanity)", () => {
  it("tests the repository's production install.sh, not a fixture", () => {
    const production = readFileSync(INSTALL_SH, "utf8")
    expect(production).toContain("SHA256SUMS")
    expect(production).toMatch(/sha256sum|shasum/)
    expect(production).toContain("RELEASE_BASE_URL")
  })
})
