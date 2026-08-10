/**
 * Memory store — read/write STATE.json with caching, corruption recovery,
 * and global fallback for read-only worktrees.
 *
 * Authoritative reads go through `readFileResult`, which distinguishes
 * "missing" from "unreadable".  A read error is never silently treated as a
 * missing file and never authorizes empty-memory initialization.
 */
import { readFileResult, safeRead, getMtime, atomicWrite } from "../util/fs"
import type { FileReadResult } from "../util/fs"
import { resolveProjectPath, projectMemoryPath, globalMemoryPath } from "./paths"
import { loadAndMigrate } from "./migrate"
import { emptyMemory, MemoryFileSchema } from "./schema"
import type { MemoryFile } from "./schema"
import { log } from "../util/log"
import { MEMORY_MAX_BYTES, memorySizeBytes, serializeMemory } from "./memory-size"

export type MemorySource = "project" | "global"

export type MemoryReadResult = {
  memory: MemoryFile | null
  source: MemorySource | null
  path: string | null
  sizeBytes: number
  revision: number
}

/** A single candidate file's cached read outcome plus its invalidation mtime. */
type CacheEntry = { mtime: number | null; readResult: FileReadResult }

/**
 * Module-level cache keyed by the resolved project path.
 * Tracks BOTH candidates (local + global) so a change to either file
 * invalidates the cached selection, not merely a change to the selected one.
 */
type CacheValue = {
  local: CacheEntry | null
  global: CacheEntry | null
  selected: MemoryReadResult
}

const cache = new Map<string, CacheValue>()

/** Classification of one candidate after reading, parsing, and migrating. */
type Candidate =
  | { kind: "memory"; memory: MemoryFile; sizeBytes: number; revision: number }
  | { kind: "error"; code?: string }
  | { kind: "none" }

/**
 * Turn a raw typed read into a candidate:
 *  - missing → none
 *  - error (unreadable) → explicit error state, never treated as missing
 *  - ok + parseable + valid → memory
 *  - ok + corrupt (bad JSON or invalid shape) → backed up and treated as none
 */
async function candidateFrom(path: string, result: FileReadResult): Promise<Candidate> {
  if (result.kind === "missing") return { kind: "none" }
  if (result.kind === "error") return { kind: "error", code: result.code }

  let parsed: unknown
  try {
    parsed = JSON.parse(result.content)
  } catch {
    await backupCorrupt(path, result.content)
    return { kind: "none" }
  }

  const mem = loadAndMigrate(parsed)
  if (mem === null) {
    await backupCorrupt(path, result.content)
    return { kind: "none" }
  }

  return {
    kind: "memory",
    memory: mem,
    sizeBytes: Buffer.byteLength(result.content, "utf8"),
    // `MemoryFile` models the construction input shape, where the zod
    // `default(0)` makes `revision` optional. `loadAndMigrate` always applies
    // the default, so `?? 0` is a pure type-level guard.
    revision: mem.revision ?? 0,
  }
}

function resultFromCandidate(
  source: MemorySource,
  path: string,
  candidate: Extract<Candidate, { kind: "memory" }>,
): MemoryReadResult {
  return {
    memory: candidate.memory,
    source,
    path,
    sizeBytes: candidate.sizeBytes,
    revision: candidate.revision,
  }
}

/**
 * Deterministic selection between the two candidates:
 *  - both parseable → higher revision wins; equal revision → project wins
 *  - exactly one parseable → it wins (even when the other is unreadable)
 *  - neither parseable:
 *      - both unreadable → no memory + a bounded warning (never empty init)
 *      - otherwise (missing/corrupt involved) → no memory, no warning
 */
function selectCandidate(
  localPath: string,
  globalPath: string,
  local: Candidate,
  global: Candidate,
  client?: unknown,
): MemoryReadResult {
  if (local.kind === "memory" && global.kind === "memory") {
    if (global.revision > local.revision) {
      return resultFromCandidate("global", globalPath, global)
    }
    return resultFromCandidate("project", localPath, local)
  }
  if (local.kind === "memory") return resultFromCandidate("project", localPath, local)
  if (global.kind === "memory") return resultFromCandidate("global", globalPath, global)

  if (local.kind === "error" && global.kind === "error") {
    void log(client, "warn", "memory read failed for both candidates", {
      project: localPath,
      global: globalPath,
      projectError: local.code ?? "",
      globalError: global.code ?? "",
    })
  }
  return { memory: null, source: null, path: null, sizeBytes: 0, revision: 0 }
}

/**
 * Read the current authoritative memory state for a project.
 *
 * Resolves the project path (so non-git `worktree === "/"` still records the
 * real directory), inspects both the project-local and the global fallback
 * STATE files, and selects one deterministically.  Returns the selected
 * file's source, path, byte size, revision, and parsed memory — or an explicit
 * "no memory / cannot be safely determined" result.
 */
export async function readMemoryState(args: {
  worktree: string
  directory: string
  bypassCache?: boolean
  client?: unknown
}): Promise<MemoryReadResult> {
  const project = resolveProjectPath(args.worktree, args.directory)
  const localPath = projectMemoryPath(project)
  const globalPath = globalMemoryPath(project)

  const localMtime = await getMtime(localPath)
  const globalMtime = await getMtime(globalPath)

  const cached = cache.get(project)
  if (
    !args.bypassCache &&
    cached &&
    cached.local?.mtime === localMtime &&
    cached.global?.mtime === globalMtime
  ) {
    return cached.selected
  }

  const [localRead, globalRead] = await Promise.all([
    readFileResult(localPath),
    readFileResult(globalPath),
  ])
  const localCandidate = await candidateFrom(localPath, localRead)
  const globalCandidate = await candidateFrom(globalPath, globalRead)
  const selected = selectCandidate(
    localPath,
    globalPath,
    localCandidate,
    globalCandidate,
    args.client,
  )

  cache.set(project, {
    local: { mtime: localMtime, readResult: localRead },
    global: { mtime: globalMtime, readResult: globalRead },
    selected,
  })

  return selected
}

/**
 * Read the selected memory file for a project, or null when no authoritative
 * memory is available.  Compatibility wrapper over `readMemoryState`.
 */
export async function readMemory(args: {
  worktree: string
  directory: string
}): Promise<MemoryFile | null> {
  return (await readMemoryState(args)).memory
}

/**
 * Write the memory file atomically.
 * Tries project path first; falls back to global path if read-only.
 * Never throws — catches and logs on failure.
 */
export async function writeMemory(
  { worktree, directory, client }: { worktree: string; directory: string; client?: unknown },
  mem: MemoryFile,
): Promise<boolean> {
  const project = resolveProjectPath(worktree, directory)
  const validated = MemoryFileSchema.safeParse(mem)
  if (!validated.success) {
    // Never persist a state that the v3 reader would quarantine. This is also
    // the final guard against an unproven LLM cache or provenance-less fact.
    return false
  }
  const path = projectMemoryPath(project)
  const json = serializeMemory(validated.data)
  const bytes = memorySizeBytes(validated.data)

  if (bytes > MEMORY_MAX_BYTES) {
    // The size limit is a hard storage invariant. Callers may try pruning
    // first, but an unrepresentable state must never reach atomicWrite.
    void log(client, "error", `tokenmaxxer: STATE.json write rejected: exceeds ${MEMORY_MAX_BYTES}-byte cap`, {
      bytes,
      max_bytes: MEMORY_MAX_BYTES,
    })
    cache.delete(project)
    return false
  }

  try {
    await atomicWrite(path, json)
  } catch {
    // Project path read-only — try global fallback
    try {
      await atomicWrite(globalMemoryPath(project), json)
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
export { resolveProjectPath } from "./paths"

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
