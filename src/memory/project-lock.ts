/**
 * Cross-process project lock.
 *
 * This is a leaf module: it depends only on `node:fs/promises`, `node:os`,
 * `node:crypto`, `zod`, and `./paths`.  It must NOT import from `./store`,
 * `./writer`, `./schema`, or `./lock`.  Later waves wire this lock into
 * STATE mutations; this wave delivers the lock primitive only.
 *
 * The lock is a directory (not a file) so that a fully-initialized candidate
 * (with `owner.json` already present) can be published atomically via rename.
 * The canonical lock path is `<globalProjectStorageDir(project)>/.state-lock`.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { hostname } from "node:os"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import { globalProjectStorageDir, projectLockDir } from "./paths"

/** Bounded owner metadata. No transcripts, paths, commands, or PII. */
export const ProjectLockOwnerSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive().max(2_147_483_647),
    hostname: z.string().min(1).max(255),
    acquired_at: z.string().max(64), // bounded ISO
    nonce: z.string().min(1).max(64),
  })
  .strict()

export type ProjectLockOwner = z.infer<typeof ProjectLockOwnerSchema>

export type ProjectLockOptions = {
  /** Maximum total time to wait for acquisition. Defaults to a bounded value (e.g. 2000 ms). */
  acquireTimeoutMs?: number
  /** Initial backoff. Defaults small (e.g. 10 ms). */
  initialBackoffMs?: number
  /** Max backoff cap. Defaults small (e.g. 100 ms). */
  maxBackoffMs?: number
  /** Optional signal-style abort; currently a function returning boolean. */
  shouldAbort?: () => boolean
  /** For tests: allow a synchronous hook to observe the lock state. */
  onClassify?: (info: {
    owner: ProjectLockOwner | null
    classification: LockClassification
  }) => void
}

export type LockClassification =
  | { kind: "missing" }
  | { kind: "live-same-host"; owner: ProjectLockOwner }
  | { kind: "dead-same-host"; owner: ProjectLockOwner }
  | { kind: "foreign-host"; owner: ProjectLockOwner }
  | {
      kind: "unknown-owner"
      reason: "missing-metadata" | "malformed-metadata" | "read-error"
    }

/** Result of acquiring the project lock. */
export type ProjectLockHandle = {
  project: string
  lockDir: string
  owner: ProjectLockOwner
  /** Release the lock if-and-only-if the current owner nonce still matches. Returns whether it actually released. */
  release: () => Promise<boolean>
}

/** Typed failure raised when acquisition exceeds the bounded wait window. */
export class ProjectLockTimeoutError extends Error {
  readonly lockDir: string

  constructor(lockDir: string) {
    super(`Timed out acquiring project lock at ${lockDir}`)
    this.name = "ProjectLockTimeoutError"
    this.lockDir = lockDir
  }
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 2000
const DEFAULT_INITIAL_BACKOFF_MS = 10
const DEFAULT_MAX_BACKOFF_MS = 100

/** Build a fresh bounded owner record for this process. */
function buildOwner(): ProjectLockOwner {
  return {
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    acquired_at: new Date().toISOString(),
    nonce: randomUUID(),
  }
}

/** Ensure the global project storage directory (the lock's parent) exists. */
async function ensureGlobalProjectDir(project: string): Promise<void> {
  await mkdir(globalProjectStorageDir(project), { recursive: true })
}

/**
 * Create a unique, fully-initialized candidate directory containing
 * `owner.json`. Returns the candidate path and the owner it published.
 */
async function createCandidate(
  project: string,
): Promise<{ candidate: string; owner: ProjectLockOwner }> {
  const parentDir = globalProjectStorageDir(project)
  const candidate = join(
    parentDir,
    `.state-lock.candidate.${process.pid}.${randomUUID()}`,
  )
  await mkdir(candidate, { recursive: false })
  const owner = buildOwner()
  await writeFile(
    join(candidate, "owner.json"),
    JSON.stringify(owner, null, 2),
    "utf-8",
  )
  return { candidate, owner }
}

/** Read and validate the current owner of a lock directory, or null. */
async function readOwner(lockDir: string): Promise<ProjectLockOwner | null> {
  try {
    const raw = await readFile(join(lockDir, "owner.json"), "utf-8")
    const parsed = ProjectLockOwnerSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Classify an existing lock directory. Never deletes anything; it only
 * inspects the current owner metadata and local PID liveness.
 */
async function classifyLock(lockDir: string): Promise<LockClassification> {
  let raw: string
  try {
    raw = await readFile(join(lockDir, "owner.json"), "utf-8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return { kind: "unknown-owner", reason: "missing-metadata" }
    }
    return { kind: "unknown-owner", reason: "read-error" }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: "unknown-owner", reason: "malformed-metadata" }
  }

  const result = ProjectLockOwnerSchema.safeParse(parsed)
  if (!result.success) {
    return { kind: "unknown-owner", reason: "malformed-metadata" }
  }

  const owner = result.data
  if (owner.hostname !== hostname()) {
    return { kind: "foreign-host", owner }
  }

  try {
    process.kill(owner.pid, 0)
    return { kind: "live-same-host", owner }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EPERM") return { kind: "live-same-host", owner }
    if (code === "ESRCH") return { kind: "dead-same-host", owner }
    // Unexpected error: conservative, do not steal.
    return { kind: "unknown-owner", reason: "read-error" }
  }
}

/**
 * Treat rename errors portably as "destination exists". Do not assume POSIX.
 * Inspect `error.code` first, then fall back to known platform message
 * variants. Anything else is an unexpected error.
 */
function isDestinationExists(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  if (code === "EEXIST" || code === "ENOTEMPTY") return true
  const message = (error as Error).message ?? ""
  return /EEXIST|ENOTEMPTY|already exists|Cannot create a file when that file already exists/i.test(
    message,
  )
}

/**
 * ABA-safe stale recovery: atomically rename the canonical `.state-lock` into
 * a unique stale-recovery directory, then best-effort delete it. Only the
 * process that successfully renames owns the recovery. Returns true if we
 * quarantined the stale lock.
 */
async function quarantineStaleLock(project: string): Promise<boolean> {
  const lockDir = projectLockDir(project)
  const parentDir = globalProjectStorageDir(project)
  const recoveryDir = join(
    parentDir,
    `.state-lock.stale-recovery.${process.pid}.${randomUUID()}`,
  )
  try {
    await rename(lockDir, recoveryDir)
  } catch {
    // Someone else renamed first or replaced `.state-lock`; re-classify.
    return false
  }
  await rm(recoveryDir, { recursive: true, force: true }).catch(() => {})
  return true
}

/** Build a release handle bound to the nonce we published. */
function buildHandle(
  project: string,
  lockDir: string,
  owner: ProjectLockOwner,
): ProjectLockHandle {
  return {
    project,
    lockDir,
    owner,
    release: async () => {
      const current = await readOwner(lockDir)
      if (!current || current.nonce !== owner.nonce) {
        console.error("lock-release-skipped-owner-mismatch", { project })
        return false
      }
      try {
        await rm(lockDir, { recursive: true, force: true })
        return true
      } catch (error) {
        console.error("lock-release-failed", {
          project,
          error: String(error),
        })
        return false
      }
    },
  }
}

type AcquireOnceResult =
  | { status: "acquired"; handle: ProjectLockHandle }
  | { status: "contended"; classification: LockClassification }

/**
 * One acquisition attempt: publish a fully-initialized candidate and atomically
 * rename it to `.state-lock`. On contention, classify the current owner.
 */
async function acquireOnce(project: string): Promise<AcquireOnceResult> {
  const lockDir = projectLockDir(project)
  await ensureGlobalProjectDir(project)
  const { candidate, owner } = await createCandidate(project)
  try {
    await rename(candidate, lockDir)
    return { status: "acquired", handle: buildHandle(project, lockDir, owner) }
  } catch (error) {
    if (!isDestinationExists(error)) {
      // Unexpected error: surface a bounded diagnostic, do not crash.
      console.error("lock-acquire-unexpected-error", {
        project,
        error: String(error),
      })
      return {
        status: "contended",
        classification: { kind: "unknown-owner", reason: "read-error" },
      }
    }
    const classification = await classifyLock(lockDir)
    return { status: "contended", classification }
  } finally {
    // Best-effort cleanup of the abandoned candidate; never blocks acquisition.
    await rm(candidate, { recursive: true, force: true }).catch(() => {})
  }
}

function ownerFromClassification(
  classification: LockClassification,
): ProjectLockOwner | null {
  if (
    classification.kind === "live-same-host" ||
    classification.kind === "dead-same-host" ||
    classification.kind === "foreign-host"
  ) {
    return classification.owner
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Exponential backoff with jitter, capped at `max`. */
function backoffWithJitter(base: number, max: number): number {
  const jitter = Math.random() * base
  return Math.min(base + jitter, max)
}

/**
 * Single acquisition attempt. Returns `null` on contention / unknown ownership
 * (treat as "could not acquire right now"). Dead same-host locks are recovered
 * via ABA-safe quarantine before giving up. The caller is responsible for
 * retry/backoff logic if needed; `withProjectLock` wraps this with retry.
 */
export async function tryAcquireProjectLock(
  project: string,
  options?: ProjectLockOptions,
): Promise<ProjectLockHandle | null> {
  const result = await acquireOnce(project)
  if (result.status === "acquired") return result.handle

  const classification = result.classification
  options?.onClassify?.({
    owner: ownerFromClassification(classification),
    classification,
  })

  if (classification.kind === "dead-same-host") {
    const quarantined = await quarantineStaleLock(project)
    if (quarantined) {
      const retry = await acquireOnce(project)
      if (retry.status === "acquired") return retry.handle
    }
  }
  return null
}

/**
 * Acquire the project lock, run `operation`, and release in `finally`. On
 * acquisition timeout throws `ProjectLockTimeoutError` carrying the lock
 * directory path. On operation throw, releases the lock (with nonce check)
 * before re-throwing. Never holds the lock across retries; each retry goes
 * through the full acquisition path.
 */
export async function withProjectLock<T>(
  project: string,
  operation: () => Promise<T>,
  options?: ProjectLockOptions,
): Promise<T> {
  const acquireTimeoutMs =
    options?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
  const initialBackoffMs =
    options?.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
  const maxBackoffMs = options?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  const shouldAbort = options?.shouldAbort
  const onClassify = options?.onClassify

  const lockDir = projectLockDir(project)
  const start = Date.now()
  let backoff = initialBackoffMs

  for (;;) {
    if (shouldAbort?.()) {
      throw new ProjectLockTimeoutError(lockDir)
    }
    if (Date.now() - start >= acquireTimeoutMs) {
      throw new ProjectLockTimeoutError(lockDir)
    }

    const result = await acquireOnce(project)
    if (result.status === "acquired") {
      const handle = result.handle
      try {
        return await operation()
      } finally {
        await handle.release()
      }
    }

    const classification = result.classification
    onClassify?.({
      owner: ownerFromClassification(classification),
      classification,
    })

    if (classification.kind === "dead-same-host") {
      const quarantined = await quarantineStaleLock(project)
      if (quarantined) {
        // Retry normal acquisition from the top.
        backoff = initialBackoffMs
        continue
      }
      // Quarantine failed: someone else changed the lock; re-classify next loop.
      continue
    }

    // live-same-host, foreign-host, unknown-owner: backoff and retry.
    // "missing" never reaches here because acquireOnce would have acquired.
    await sleep(backoffWithJitter(backoff, maxBackoffMs))
    backoff = Math.min(backoff * 2, maxBackoffMs)
  }
}
