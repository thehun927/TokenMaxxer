/**
 * The parts of the OpenCode host contract TokenMaxxer owns (PR 4 §5 / §5.1).
 *
 * Single source of truth for:
 *   - the typed host client (`PluginInput["client"]`) that must be injected
 *     into registered tools by closure, never read off a `ToolContext`;
 *   - the verified minimum plugin package version and the peer range the repo
 *     actually declares;
 *   - the strict stable-version parser/gate used to bound optional
 *     structured-output extraction.
 *
 * Never invent host fields here.  `HostClient` is exactly what the installed
 * `@opencode-ai/plugin` package declares for `PluginInput["client"]`, so SDK
 * drift becomes a compile-time event.
 */
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"

/** The typed SDK client supplied once to the plugin initializer. */
export type HostClient = PluginInput["client"]

/** The tool-invocation context passed to every registered tool's execute(). */
export type HostToolContext = ToolContext

/**
 * The slice of `ToolContext` that host-facing helpers depend on.
 * Deliberately excludes `client`: the supported baseline's `ToolContext` does
 * not expose one.
 */
export type HostProjectContext = Pick<HostToolContext, "directory" | "worktree">

/**
 * The oldest stable OpenCode plugin/host contract TokenMaxxer verifies.
 * Do not lower this during PR 4: a lower minimum is valid only after the full
 * contract matrix passes against that older package/host contract.
 */
export const MIN_SUPPORTED_OPENCODE_VERSION = "1.18.15"

/** The exact minimum plugin package the repo compiles against (devDependency). */
export const VERIFIED_HOST_CONTRACT_VERSION = "1.18.15"

/** The peer range TokenMaxxer actually declares and tests. */
export const OPENCODE_PLUGIN_PEER_RANGE = ">=1.18.15 <2.0.0"

/**
 * Cap on version strings accepted by the parser.  Guards against pathological
 * input before any parsing work happens.
 */
const MAX_VERSION_INPUT_LENGTH = 64

export type ParsedHostVersion = {
  major: number
  minor: number
  patch: number
}

/**
 * Strictly parse a stable `major.minor.patch` version string.
 *
 * - Rejects prerelease and build metadata (`-` / `+` suffixes).
 * - Rejects whitespace, a leading `v`, extra dot segments, and empty input.
 * - Caps the input length and each numeric component so every result is a safe
 *   integer.
 * - Accepts any valid stable tuple; support policy is applied separately by
 *   `isSupportedHostVersion`.
 */
export function parseHostVersion(value: string): ParsedHostVersion | null {
  if (typeof value !== "string") return null
  if (value.length === 0 || value.length > MAX_VERSION_INPUT_LENGTH) return null
  const match = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(value)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null
  }
  return { major, minor, patch }
}

/**
 * Whether a host version string falls inside the verified supported range.
 *
 * Policy (PR 4 §5.1):
 *   1.18.14  -> false
 *   1.18.15  -> true
 *   1.18.16  -> true
 *   1.19.0   -> true
 *   1.999.0  -> true
 *   2.0.0    -> false
 *   0.x      -> false
 *   malformed -> false
 *   prerelease -> false unless explicitly added to the supported matrix later.
 *
 * The verifier requires a parseable stable version whose tuple `(major, minor,
 * patch)` is >= `(1, 18, 15)` and `< (2, 0, 0)` with `major === 1`.  Because
 * major must equal 1, the `< 2.0.0` upper bound is implied.
 */
export function isSupportedHostVersion(value: string): boolean {
  const parsed = parseHostVersion(value)
  if (!parsed) return false
  if (parsed.major !== 1) return false
  if (parsed.minor < 18) return false
  if (parsed.minor === 18 && parsed.patch < 15) return false
  return true
}
