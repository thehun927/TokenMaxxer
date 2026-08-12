/**
 * Ephemeral commit-pulse telemetry for the TUI.
 *
 * A successful durable STATE commit records a single timestamp in the stable
 * global per-project namespace; the TUI polls for a fresh timestamp and plays
 * one finite animation. This marker is telemetry only: it never carries
 * memory, transcript, or prompt data, and its I/O failures are always
 * swallowed so a pulse can never affect STATE commit success.
 *
 * The marker is deliberately not instrumented through the generic
 * `atomicWrite()` helper's call sites; it is written only from the canonical
 * successful STATE commit boundary (TMTUI-3) and read by the TUI.
 *
 * The reader is strictly non-destructive. Stale, future, and malformed
 * markers return `null` but are never unlinked: the marker is tiny and the
 * next successful commit atomically overwrites it, so reader-side cleanup
 * would only introduce a TOCTOU race in which a stale read could delete a
 * freshly written marker between the writer's atomic replace and the reader's
 * unlink. Any future cleanup must use compare-and-delete semantics, never a
 * blind unlink by pathname after a stale read.
 */
import { join } from "node:path"
import { atomicWrite, safeRead } from "../util/fs"
import { globalProjectStorageDir } from "./paths"

/**
 * How recent a `committed_at` timestamp must be to count as a live commit.
 * Longer than the TUI polling interval, short enough that an old marker
 * cannot look like current activity after a restart.
 */
export const MEMORY_COMMIT_RECENT_MS = 2_000

const COMMIT_PULSE_FILE = ".commit-pulse"

/**
 * Path to the commit-pulse marker in the stable global per-project namespace:
 * `~/.config/opencode/memory/<project-hash>/.commit-pulse`.
 */
export function memoryCommitPulsePath(project: string): string {
  return join(globalProjectStorageDir(project), COMMIT_PULSE_FILE)
}

/**
 * Record a successful durable STATE commit.
 *
 * Writes only `{"committed_at": <now>}`. Best effort: any I/O failure is
 * swallowed so telemetry can never turn a successful commit into a failed
 * memory operation. The marker is not refreshed on an interval and is not
 * removed immediately after writing.
 */
export async function recordMemoryCommit(project: string): Promise<void> {
  try {
    await atomicWrite(
      memoryCommitPulsePath(project),
      JSON.stringify({ committed_at: Date.now() }),
    )
  } catch {
    // Best effort telemetry: never surface marker I/O failures.
  }
}

/**
 * Read the most recent commit timestamp if it is fresh.
 *
 * Returns the `committed_at` timestamp when the marker exists, parses as
 * `{"committed_at": number}`, and is within `MEMORY_COMMIT_RECENT_MS` of
 * `now`. Stale, future, and malformed markers return `null`.
 *
 * The reader never deletes the marker. A stale/future/malformed marker is
 * left in place so a concurrent writer's atomic replace of a fresh marker can
 * never be deleted by a stale read (TOCTOU). The marker is tiny and the next
 * successful commit atomically overwrites it, so reader cleanup provides no
 * value worth the concurrency race it introduces.
 */
export async function readRecentMemoryCommit(
  project: string,
  now = Date.now(),
): Promise<number | null> {
  const path = memoryCommitPulsePath(project)
  let raw: string | null
  try {
    raw = await safeRead(path)
  } catch {
    return null
  }
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const committedAt = (parsed as { committed_at?: unknown } | null)?.committed_at
  const fresh =
    typeof committedAt === "number" &&
    Number.isFinite(committedAt) &&
    committedAt <= now &&
    now - committedAt <= MEMORY_COMMIT_RECENT_MS

  if (!fresh) {
    return null
  }
  return committedAt
}
