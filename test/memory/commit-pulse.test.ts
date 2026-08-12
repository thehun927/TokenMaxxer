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
 *   - stale/future/malformed/Infinity markers return `null` and are unlinked
 *     best effort.
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

/** Assert a marker file no longer exists (best-effort cleanup happened). */
async function expectMarkerGone(): Promise<void> {
  await expect(access(memoryCommitPulsePath(PROJECT))).rejects.toThrow()
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

  it("returns null for a stale marker and unlinks it best effort", async () => {
    const stale = Date.now() - MEMORY_COMMIT_RECENT_MS - 1
    await writeMarker(JSON.stringify({ committed_at: stale }))

    await expect(readRecentMemoryCommit(PROJECT, Date.now())).resolves.toBeNull()
    await expectMarkerGone()
  })

  it("accepts a marker exactly at the freshness boundary", async () => {
    const now = Date.now()
    const boundary = now - MEMORY_COMMIT_RECENT_MS
    await writeMarker(JSON.stringify({ committed_at: boundary }))

    await expect(readRecentMemoryCommit(PROJECT, now)).resolves.toBe(boundary)
  })

  it("returns null for a future timestamp and unlinks it best effort", async () => {
    const future = Date.now() + 60_000
    await writeMarker(JSON.stringify({ committed_at: future }))

    await expect(readRecentMemoryCommit(PROJECT, Date.now())).resolves.toBeNull()
    await expectMarkerGone()
  })

  it("returns null for malformed JSON and unlinks it best effort", async () => {
    await writeMarker("not json")

    await expect(readRecentMemoryCommit(PROJECT)).resolves.toBeNull()
    await expectMarkerGone()
  })

  it("returns null for a non-number committed_at and unlinks it best effort", async () => {
    await writeMarker(JSON.stringify({ committed_at: "not-a-number" }))

    await expect(readRecentMemoryCommit(PROJECT)).resolves.toBeNull()
    await expectMarkerGone()
  })

  it("returns null for a missing committed_at key and unlinks it best effort", async () => {
    await writeMarker(JSON.stringify({ other: 1 }))

    await expect(readRecentMemoryCommit(PROJECT)).resolves.toBeNull()
    await expectMarkerGone()
  })

  it("returns null for an Infinity committed_at and unlinks it best effort", async () => {
    // `1e999` overflows to Infinity when parsed; JSON.stringify cannot encode
    // a literal Infinity, so the marker must be written as raw JSON text.
    await writeMarker('{"committed_at":1e999}')

    await expect(readRecentMemoryCommit(PROJECT)).resolves.toBeNull()
    await expectMarkerGone()
  })

  it("swallows read failures and returns null without throwing", async () => {
    // A directory at the marker path is unreadable as a file.
    await mkdir(memoryCommitPulsePath(PROJECT), { recursive: true })
    await expect(readRecentMemoryCommit(PROJECT)).resolves.toBeNull()
  })
})
