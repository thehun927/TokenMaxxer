/**
 * Memory store — read/write STATE.json with caching, corruption recovery,
 * and global fallback for read-only worktrees.
 *
 * Authoritative reads go through `readFileResult`, which distinguishes
 * "missing" from "unreadable".  A read error is never silently treated as a
 * missing file and never authorizes empty-memory initialization.
 */
import { readFileResult, getMtime, atomicWrite } from "../util/fs"
import type { FileReadResult } from "../util/fs"
import { resolveProjectPath, projectMemoryPath, globalMemoryPath } from "./paths"
import { loadAndMigrate } from "./migrate"
import { emptyMemory, MemoryFileSchema } from "./schema"
import type { MemoryFile } from "./schema"
import { log } from "../util/log"
import { MEMORY_MAX_BYTES, memorySizeBytes, serializeMemory } from "./memory-size"
import {
  withProjectLock,
  ProjectLockTimeoutError,
} from "./project-lock"
import type { ProjectLockOptions } from "./project-lock"

export type MemorySource = "project" | "global"

export type MemoryReadStatus = "ok" | "missing" | "unavailable"

/**
 * The authoritative read outcome, discriminated so the type system can switch
 * on it. Mutation callers MUST consume `readMemoryState` and fail closed on
 * `"unavailable"` — that status means the state could not be authoritatively
 * read and must never be treated as permission to start from empty memory.
 */
export type MemoryReadResult =
  | { status: "ok"; memory: MemoryFile; source: MemorySource; path: string; sizeBytes: number; revision: number }
  | { status: "missing"; memory: null; source: null; path: null; sizeBytes: 0; revision: 0 }
  | {
      status: "unavailable"
      memory: null
      source: null
      path: null
      sizeBytes: 0
      revision: 0
      errors: Array<{ source: MemorySource; path: string; code?: string }>
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
  | { kind: "memory"; memory: MemoryFile; sizeBytes: number; mtime: number | null; revision: number }
  | { kind: "error"; code?: string }
  | { kind: "none" }

/**
 * Turn a raw typed read into a candidate:
 *  - missing → none
 *  - error (unreadable) → explicit error state, never treated as missing
 *  - ok + parseable + valid → memory (carrying the file's mtime for the
 *    equal-revision tie-break)
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
    mtime: result.mtime,
    revision: mem.revision,
  }
}

function resultFromCandidate(
  source: MemorySource,
  path: string,
  candidate: Extract<Candidate, { kind: "memory" }>,
): MemoryReadResult {
  return {
    status: "ok",
    memory: candidate.memory,
    source,
    path,
    sizeBytes: candidate.sizeBytes,
    revision: candidate.revision,
  }
}

/**
 * Deterministic selection between the two candidates:
 *  - both parseable → higher revision wins; if revisions tie, newer mtime
 *    wins; if both tie, project-local wins
 *  - exactly one parseable → it wins (even when the other is unreadable)
 *  - neither parseable:
 *      - any candidate unreadable → "unavailable" (never empty init)
 *      - otherwise (missing/corrupt involved) → "missing"
 */
function selectCandidate(
  localPath: string,
  globalPath: string,
  local: Candidate,
  global: Candidate,
  client?: unknown,
): MemoryReadResult {
  if (local.kind === "memory" && global.kind === "memory") {
    // 1. Higher revision wins.
    if (local.revision > global.revision) {
      return resultFromCandidate("project", localPath, local)
    }
    if (global.revision > local.revision) {
      return resultFromCandidate("global", globalPath, global)
    }
    // 2. Revisions tied → newer candidate mtime wins. `mtime ?? 0` is the
    //    correct comparison: legacy dual-file states carry both null mtimes
    //    (0 === 0), falling through to the project-local preference below.
    if ((global.mtime ?? 0) > (local.mtime ?? 0)) {
      return resultFromCandidate("global", globalPath, global)
    }
    // 3. Revisions AND mtime tied → deterministic project-local preference.
    return resultFromCandidate("project", localPath, local)
  }
  if (local.kind === "memory") return resultFromCandidate("project", localPath, local)
  if (global.kind === "memory") return resultFromCandidate("global", globalPath, global)

  // Neither candidate parsed as memory. Collect every read error so the
  // caller can distinguish "genuinely absent" from "cannot be determined".
  const localError = local.kind === "error" ? local.code : undefined
  const globalError = global.kind === "error" ? global.code : undefined
  const errors: Array<{ source: MemorySource; path: string; code?: string }> = []
  if (local.kind === "error") {
    errors.push({ source: "project", path: localPath, code: localError })
  }
  if (global.kind === "error") {
    errors.push({ source: "global", path: globalPath, code: globalError })
  }

  if (errors.length > 0) {
    if (errors.length === 2) {
      void log(client, "warn", "memory read failed for both candidates", {
        project: localPath,
        global: globalPath,
        projectError: localError ?? "",
        globalError: globalError ?? "",
      })
    }
    // Any unreadable candidate means the authoritative state is unknown. This
    // is NOT "missing" and must never authorize empty-memory initialization.
    return {
      status: "unavailable",
      memory: null,
      source: null,
      path: null,
      sizeBytes: 0,
      revision: 0,
      errors,
    }
  }

  return { status: "missing", memory: null, source: null, path: null, sizeBytes: 0, revision: 0 }
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
    cached.global?.mtime === globalMtime &&
    // A permission flip (chmod 000 -> readable) changes ctime, not mtime, so
    // an mtime-identical cached pair can still be stale. Never reuse a cached
    // selection that was derived from an error — re-read both candidates so
    // restored permissions are honored on the next access.
    cached.local.readResult.kind !== "error" &&
    cached.global.readResult.kind !== "error"
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
 *
 * Non-mutation callers may use this. Mutation callers MUST consume
 * `readMemoryState` directly so an "unavailable" state (unreadable files) is
 * never collapsed into a missing-file `null` that authorizes empty init.
 */
export async function readMemory(args: {
  worktree: string
  directory: string
}): Promise<MemoryFile | null> {
  const result = await readMemoryState(args)
  if (result.status === "ok") return result.memory
  // "missing" and "unavailable" both collapse to null for the read-only
  // wrapper; only true "missing" may authorize empty-memory initialization.
  return null
}

/**
 * Write the supplied memory to disk exactly.
 *
 * This is a low-level persistence primitive. It serializes `mem.revision`
 * exactly as supplied — it does NOT advance revision. Revision advancement is
 * the sole responsibility of `mutateMemory`. It is retained for the fallback
 * path and migration; application code should prefer `mutateMemory`.
 *
 * Tries project path first; falls back to global path if read-only.
 * Never throws — catches and logs on failure.
 */
export async function writeMemory(
  { worktree, directory, client }: { worktree: string; directory: string; client?: unknown },
  mem: MemoryFile,
): Promise<boolean> {
  const project = resolveProjectPath(worktree, directory)
  const committed = await commitMemoryExact(project, mem, { client })
  return committed.ok
}

/**
 * Result of an exact commit. `ok: true` carries the path that was written.
 */
type CommitMemoryExactResult =
  | { ok: true; path: string }
  | { ok: false; reason: "validation-failed" | "size-cap-exceeded" | "io-failed" }

/**
 * Internal exact-commit primitive used by `mutateMemory`.
 *
 * - validates via `MemoryFileSchema.safeParse`;
 * - enforces the `MEMORY_MAX_BYTES` byte cap;
 * - serializes the supplied revision exactly (no increment);
 * - tries the project-local path first, then the global fallback;
 * - does NOT perform a preceding read;
 * - invalidates the process cache on both success and failure.
 */
async function commitMemoryExact(
  project: string,
  memory: MemoryFile,
  options?: { client?: unknown },
): Promise<CommitMemoryExactResult> {
  const validated = MemoryFileSchema.safeParse(memory)
  if (!validated.success) {
    // Never persist a state that the v3 reader would quarantine. This is also
    // the final guard against an unproven LLM cache or provenance-less fact.
    cache.delete(project)
    return { ok: false, reason: "validation-failed" }
  }

  const json = serializeMemory(validated.data)
  const bytes = memorySizeBytes(validated.data)

  if (bytes > MEMORY_MAX_BYTES) {
    // The size limit is a hard storage invariant. Callers may try pruning
    // first, but an unrepresentable state must never reach atomicWrite.
    void log(options?.client, "error", `tokenmaxxer: STATE.json write rejected: exceeds ${MEMORY_MAX_BYTES}-byte cap`, {
      bytes,
      max_bytes: MEMORY_MAX_BYTES,
    })
    cache.delete(project)
    return { ok: false, reason: "size-cap-exceeded" }
  }

  const path = projectMemoryPath(project)
  try {
    await atomicWrite(path, json)
  } catch {
    // Project path read-only — try global fallback
    try {
      await atomicWrite(globalMemoryPath(project), json)
    } catch {
      // Both paths failed — give up silently (don't throw from event handler)
      cache.delete(project)
      return { ok: false, reason: "io-failed" }
    }
    // Even on global fallback success, invalidate the cache
    cache.delete(project)
    return { ok: true, path: globalMemoryPath(project) }
  }

  // Invalidate cache after successful write
  cache.delete(project)
  return { ok: true, path }
}

/**
 * A single logical mutation action produced by the synchronous mutation
 * callback. `commit` persists a new memory; `noop` leaves STATE untouched.
 */
export type MutationAction<T> =
  | { kind: "commit"; memory: MemoryFile; value: T }
  | { kind: "noop"; value: T }

/**
 * Result of a `mutateMemory` transaction.
 */
export type MemoryMutationResult<T> =
  | { status: "committed"; value: T; revision: number }
  | { status: "noop"; value: T; revision: number }
  | { status: "lock-timeout" }
  | { status: "unavailable" }
  | { status: "commit-failed" }

/**
 * The canonical logical mutation primitive.
 *
 * Acquires the cross-process project lock, re-reads the authoritative STATE
 * bypassing the process cache, applies one synchronous in-memory mutation,
 * advances revision exactly once, and commits atomically.
 *
 * Lock ordering (PR 2 §10): the process-local queue in `./lock` is an outer
 * optimization layer for same-process coalescing/ordering. The filesystem
 * lock inside `withProjectLock` is the cross-process durability boundary.
 * This function does not participate in the process-local queue; a caller
 * that wants same-process coalescing wraps this call in `enqueueProjectJob`.
 *
 * The mutation callback is synchronous. If a caller needs an async step
 * inside the transaction body, it must do so BEFORE calling `mutateMemory`
 * (PR 2 §12 "no-lock zones").
 */
export async function mutateMemory<T>(
  args: {
    worktree: string
    directory: string
    client?: unknown
    lockOptions?: ProjectLockOptions
  },
  mutate: (
    memory: MemoryFile,
    state: MemoryReadResult,
  ) => MutationAction<T>,
): Promise<MemoryMutationResult<T>> {
  const project = resolveProjectPath(args.worktree, args.directory)

  try {
    return await withProjectLock(project, async () => {
      const state = await readMemoryState({
        worktree: args.worktree,
        directory: args.directory,
        client: args.client,
        bypassCache: true, // PR 2 §9: every transaction read bypasses cache
      })

      if (state.status === "unavailable") {
        return { status: "unavailable" } as const
      }

      const base = state.status === "ok"
        ? state.memory
        : emptyMemory(project)

      const action = mutate(base, state)

      if (action.kind === "noop") {
        return {
          status: "noop",
          value: action.value,
          revision: base.revision,
        } as const
      }

      const next: MemoryFile = {
        ...action.memory,
        revision: base.revision + 1,
      }

      const committed = await commitMemoryExact(project, next, { client: args.client })
      if (!committed.ok) {
        return { status: "commit-failed" } as const
      }

      return {
        status: "committed",
        value: action.value,
        revision: next.revision,
      } as const
    }, args.lockOptions)
  } catch (error) {
    if (error instanceof ProjectLockTimeoutError) {
      return { status: "lock-timeout" }
    }
    // Other errors propagate; the lock module releases on throw.
    throw error
  }
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
