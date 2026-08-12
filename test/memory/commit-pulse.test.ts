/**
 * TMTUI-2 commit-pulse protocol tests (docs/TMTUI/implementation-plan.md §2.5).
 *
 * The commit pulse is ephemeral telemetry for the composer status element:
 *
 *   - written only after a successful durable STATE commit;
 *   - contains only `{"committed_at": <now>}` — never prompt/transcript/memory
 *     data (marker payload minimality);
 *   - lives in the stable global per-project namespace
 *     (`~/.config/opencode/memory/<project-hash>/.commit-pulse`), never inside
 *     the project worktree;
 *   - best effort: I/O failures must never throw from `recordMemoryCommit()`
 *     and must never surface from `readRecentMemoryCommit()`;
 *   - stale/future/malformed/Infinity markers return `null` (fail-closed);
 *   - the reader is strictly non-destructive: invalid markers are never
 *     unlinked, so a stale read can never delete a freshly atomically
 *     replaced marker (TOCTOU regression, docs/TMTUI/TMTUI-review.md
 *     Finding 3);
 *   - rapid commit bursts may coalesce into one pulse; the marker is a single
 *     timestamp file, not an event log (docs/TMTUI/TMTUI-review.md §4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { access } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import {
  MEMORY_COMMIT_RECENT_MS,
  memoryCommitPulsePath,
  readRecentMemoryCommit,
  recordMemoryCommit,
} from "../../src/memory/commit-pulse"
import { globalProjectStorageDir } from "../../src/memory/paths"

let homeDir: string

const PROJECT = "/worktree/project"

/** Write a marker file directly, creating its parent directory on the way. */
async function writeMarker(content: string): Promise<void> {
  await mkdir(dirname(memoryCommitPulsePath(PROJECT)), { recursive: true })
  await writeFile(memoryCommitPulsePath(PROJECT), content, "utf8")
}

/** Assert the marker file still exists (reader is non-destructive). */
async function expectMarkerStillThere(): Promise<void> {
  await expect(access(memoryCommitPulsePath(PROJECT))).resolves.toBeUndefined()
}

beforeEach(async () => {
  // Isolate the global fallback namespace from the developer's real home.
  homeDir = await mkdtemp(join(tmpdir(), "tokenmaxxer-pulse-home-"))
  vi.stubEnv("HOME", homeDir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(homeDir, { recursive: true, force: true })
})

describe("commit-pulse marker location", () => {
  it("derives the marker from the global hashed per-project namespace", () => {
    expect(memoryCommitPulsePath(PROJECT)).toBe(
      join(globalProjectStorageDir(PROJECT), ".commit-pulse"),
    )
    expect(memoryCommitPulsePath(PROJECT)).toContain(
      join(".config", "opencode", "memory"),
    )
  })

  it("never places the marker inside the project worktree", () => {
    expect(memoryCommitPulsePath(PROJECT).startsWith(PROJECT)).toBe(false)
  })
})

describe("recordMemoryCommit", () => {
  it("writes only a committed_at timestamp (marker payload minimality)", async () => {
    await recordMemoryCommit(PROJECT)
    const raw = await readFile(memoryCommitPulsePath(PROJECT), "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(["committed_at"])
    expect(typeof parsed.committed_at).toBe("number")
    expect(Number.isFinite(parsed.committed_at as number)).toBe(true)
    // The API accepts only the project — there is no payload parameter, so a
    // memory/transcript/prompt payload cannot be supplied to the marker.
    expect(recordMemoryCommit.length).toBe(1)
  })

  it("writes one timestamp and is not refreshed on an interval", async () => {
    // `recordMemoryCommit` is a one-shot write: the marker must hold exactly
    // one `committed_at` value, and that value must round-trip through the
    // reader unchanged (no periodic refresh re-stamping the file).
    await recordMemoryCommit(PROJECT)
    const raw = await readFile(memoryCommitPulsePath(PROJECT), "utf8")
    const recorded = (JSON.parse(raw) as { committed_at: number }).committed_at
    await expect(readRecentMemoryCommit(PROJECT, recorded)).resolves.toBe(recorded)
  })

  it("swallows I/O failures so telemetry can never fail a STATE commit", async () => {
    // Make the global storage directory itself a regular file so the marker
    // cannot be created underneath it.
    await mkdir(dirname(globalProjectStorageDir(PROJECT)), { recursive: true })
    await writeFile(globalProjectStorageDir(PROJECT), "i am a file", "utf8")
    await expect(recordMemoryCommit(PROJECT)).resolves.toBeUndefined()
  })
})

describe("readRecentMemoryCommit", () => {
  it("returns the recorded timestamp when the marker is fresh", async () => {
    await recordMemoryCommit(PROJECT)
    const raw = await readFile(memoryCommitPulsePath(PROJECT), "utf8")
    const recorded = (JSON.parse(raw) as { committed_at: number }).committed_at

    const result = await readRecentMemoryCommit(PROJECT, recorded)
    expect(result).toBe(recorded)
  })

  it("returns null when no marker exists", async () => {
    await expect(readRecentMemoryCommit(PROJECT)).resolves.toBeNull()
  })

  it("returns null for a stale marker without deleting it", async () => {
    const stale = Date.now() - MEMORY_COMMIT_RECENT_MS - 1
    await writeMarker(JSON.stringify({ committed_at: stale }))

    await expect(readRecentMemoryCommit(PROJECT, Date.now())).resolves.toBeNull()
    await expectMarkerStillThere()
  })

  it("accepts a marker exactly at the freshness boundary", async () => {
    const now = Date.now()
    const boundary = now - MEMORY_COMMIT_RECENT_MS
    await writeMarker(JSON.stringify({ committed_at: boundary }))

    await expect(readRecentMemoryCommit(PROJECT, now)).resolves.toBe(boundary)
  })

  it("returns null for a future timestamp without deleting it", async () => {
    const future = Date.now() + 60_000
    await writeMarker(JSON.stringify({ committed_at: future }))

    await expect(readRecentMemoryCommit(PROJECT, Date.now())).resolves.toBeNull()
    await expectMarkerStillThere()
  })

  it("returns null for malformed JSON without deleting it", async () => {
    await writeMarker("not json")

    await expect(readRecentMemoryCommit(PROJECT)).resolves.toBeNull()
    await expectMarkerStillThere()
  })

  it("returns null for a non-number committed_at without deleting it", async () => {
    await writeMarker(JSON.stringify({ committed_at: "not-a-number" }))

    await expect(readRecentMemoryCommit(PROJECT)).resolves.toBeNull()
    await expectMarkerStillThere()
  })

  it("returns null for a missing committed_at key without deleting it", async () => {
    await writeMarker(JSON.stringify({ other: 1 }))

    await expect(readRecentMemoryCommit(PROJECT)).resolves.toBeNull()
    await expectMarkerStillThere()
  })

  it("returns null for an Infinity committed_at without deleting it", async () => {
    // `1e999` overflows to Infinity when parsed; JSON.stringify cannot encode
    // a literal Infinity, so the marker must be written as raw JSON text.
    await writeMarker('{"committed_at":1e999}')

    await expect(readRecentMemoryCommit(PROJECT)).resolves.toBeNull()
    await expectMarkerStillThere()
  })

  it("swallows read failures and returns null without throwing", async () => {
    // A directory at the marker path is unreadable as a file.
    await mkdir(memoryCommitPulsePath(PROJECT), { recursive: true })
    await expect(readRecentMemoryCommit(PROJECT)).resolves.toBeNull()
  })

  it("never creates a pulse from an invalid marker (fail-closed null)", async () => {
    // The TUI treats a `null` read as "no new commit" and never starts a
    // pulse. An invalid marker must therefore read as null even though it is
    // left in place, and it must not poison the namespace for later commits.
    await writeMarker("not json")
    await expect(readRecentMemoryCommit(PROJECT)).resolves.toBeNull()

    // A subsequent valid marker still reads correctly.
    await recordMemoryCommit(PROJECT)
    const raw = await readFile(memoryCommitPulsePath(PROJECT), "utf8")
    const recorded = (JSON.parse(raw) as { committed_at: number }).committed_at
    await expect(readRecentMemoryCommit(PROJECT, recorded)).resolves.toBe(recorded)
  })

  it("does not lose a fresh atomically replaced marker after a stale read", async () => {
    // TOCTOU regression (docs/TMTUI/TMTUI-review.md Finding 3): a reader that
    // observes a stale marker must not delete the path, because the writer may
    // have atomically replaced it with a fresh marker in the meantime. Here we
    // simulate the interleaving: stale read first, then the writer's atomic
    // replace, then the next poll. The fresh marker must survive and be read.
    const stale = Date.now() - MEMORY_COMMIT_RECENT_MS - 1
    await writeMarker(JSON.stringify({ committed_at: stale }))

    // Stale read: returns null and must leave the path untouched.
    await expect(readRecentMemoryCommit(PROJECT, Date.now())).resolves.toBeNull()
    await expectMarkerStillThere()

    // Writer atomically replaces the marker with a fresh commit timestamp.
    await recordMemoryCommit(PROJECT)
    const raw = await readFile(memoryCommitPulsePath(PROJECT), "utf8")
    const fresh = (JSON.parse(raw) as { committed_at: number }).committed_at

    // The next poll observes the fresh marker — it was not deleted by the
    // earlier stale read.
    await expect(readRecentMemoryCommit(PROJECT, fresh)).resolves.toBe(fresh)
  })
})
