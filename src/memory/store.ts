/**
 * Memory store — read/write STATE.json with caching, corruption recovery,
 * and global fallback for read-only worktrees.
 */
import { loadAndMigrate } from "./migrate"
import { atomicWrite, safeRead, getMtime } from "../util/fs"
import { emptyMemory, MemoryFileSchema } from "./schema"
import type { MemoryFile } from "./schema"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { homedir } from "node:os"

const MAX_BYTES = 8192

/**
 * Module-level cache keyed by worktree.
 * Includes mtime for multi-instance cache invalidation.
 */
const cache = new Map<string, { mem: MemoryFile | null; mtime: number }>()

/** Path to STATE.json within a worktree. */
function memoryPath(worktree: string): string {
  return join(worktree, ".opencode", "memory", "STATE.json")
}

/** Fallback global path when worktree is read-only. */
function globalPath(worktree: string): string {
  // Simple hash: hex-encode the first 16 chars of worktree path
  const hash = createHash("sha256").update(worktree).digest("hex").slice(0, 16)
  return join(homedir(), ".config", "opencode", "memory", hash, "STATE.json")
}

/**
 * Resolve the effective project path for memory storage.
 * `worktree` is the git worktree root, but in non-git directories opencode
 * sets it to "/" (root), which is not writable. Fall back to `directory`
 * (the session CWD) when worktree is "/" or otherwise invalid.
 */
export function resolveProjectPath(worktree: string, directory: string): string {
  if (!worktree || worktree === "/" || worktree === "") {
    return directory
  }
  return worktree
}

/**
 * Read the memory file for a worktree.
 * Returns null if no memory file exists.
 * If the file is corrupt, backs it up and returns emptyMemory.
 */
export async function readMemory({
  worktree,
  directory,
}: {
  worktree: string
  directory: string
}): Promise<MemoryFile | null> {
  const project = resolveProjectPath(worktree, directory)
  const path = memoryPath(project)
  const mtime = await getMtime(path)

  // Cache check with mtime invalidation (fixes multi-instance incoherence)
  const cached = cache.get(project)
  if (cached && mtime !== null && cached.mtime === mtime) {
    return cached.mem
  }
  if (cached && mtime === null && cached.mem === null) {
    // File still doesn't exist — cached null is valid
    return null
  }

  const raw = await safeRead(path)
  if (raw === null) {
    cache.set(project, { mem: null, mtime: mtime ?? 0 })
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corrupt JSON — back up and return empty
    await backupCorrupt(path, raw)
    const empty = emptyMemory(project)
    cache.set(project, { mem: empty, mtime: mtime ?? 0 })
    return empty
  }

  const mem = loadAndMigrate(parsed)
  if (mem === null) {
    // Valid JSON but invalid shape — back up and return empty
    await backupCorrupt(path, raw)
    const empty = emptyMemory(project)
    cache.set(project, { mem: empty, mtime: mtime ?? 0 })
    return empty
  }

  cache.set(project, { mem, mtime: mtime ?? 0 })
  return mem
}

/**
 * Write the memory file atomically.
 * Tries project path first; falls back to global path if read-only.
 * Never throws — catches and logs on failure.
 */
export async function writeMemory(
  { worktree, directory }: { worktree: string; directory: string },
  mem: MemoryFile,
): Promise<boolean> {
  const project = resolveProjectPath(worktree, directory)
  const validated = MemoryFileSchema.safeParse(mem)
  if (!validated.success) {
    // Never persist a state that the v3 reader would quarantine. This is also
    // the final guard against an unproven LLM cache or provenance-less fact.
    return false
  }
  const path = memoryPath(project)
  const json = JSON.stringify(validated.data, null, 2)

  if (json.length > MAX_BYTES) {
    // Should have been pruned before write — warn if still over
    console.warn(`tokenmaxxer: STATE.json still ${json.length} bytes after pruning`)
  }

  try {
    await atomicWrite(path, json)
  } catch {
    // Project path read-only — try global fallback
    try {
      await atomicWrite(globalPath(project), json)
    } catch {
      // Both paths failed — give up silently (don't throw from event handler)
      cache.delete(project)
      return false
    }
    // Even on global fallback success, invalidate the cache
    cache.delete(project)
    return true
  }

  // Invalidate cache after successful write
  cache.delete(project)
  return true
}

export { emptyMemory } from "./schema"

/**
 * Back up a corrupt STATE.json file by copying it to a timestamped path.
 */
async function backupCorrupt(path: string, content: string): Promise<void> {
  try {
    await atomicWrite(`${path}.corrupt.${Date.now()}`, content)
  } catch {
    // Best effort — silently ignore
  }
}
