/**
 * Cross-process project lock.
 *
 * This is a leaf module: it depends only on `node:fs/promises`, `node:os`,
 * `node:crypto`, `zod`, and `./paths`.  It must NOT import from `./store`,
 * `./writer`, `./schema`, or `./lock`.  Later waves wire this lock into
 * STATE mutations; this wave delivers the lock primitive only.
 *
 * The lock is a directory (not a file). The canonical lock path is
 * `<globalProjectStorageDir(project)>/.state-lock`. Ownership is published by
 * atomically creating the canonical directory (`mkdir` with `recursive:false`)
 * and then writing `owner.json` inside it. Release retires the owned directory
 * to a unique `.state-lock.released.<nonce>.*` path before recursive cleanup,
 * so old cleanup can never target a replacement owner's canonical lock.
 */
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
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
  /**
   * For tests: a barrier path. Immediately after every classification the
   * caller writes `<path>` and waits for `<path>.release` to exist. This lets
   * a test deterministically pause a contender at the classification →
   * recovery boundary. Only honored when provided; no effect on production.
   */
  waitForClassificationBarrier?: string
  /**
   * For tests: a barrier path. Immediately after a recovery claim has been
   * acquired AND the owner revalidated as still-dead, but BEFORE the stale
   * lock is quarantined, the caller writes `<path>.reached` and waits for
   * `<path>` to exist. This lets a test deterministically pause a recoverer at
   * the claim-revalidation → quarantine boundary to prove the canonical claim
   * is exclusive across processes. Only honored when provided; no effect on
   * production. These test-only hooks exist solely for adversarial tests and
   * are never surfaced in production error paths.
   */
  waitForPostClaimBarrier?: string
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
 * Treat mkdir/rename errors portably as "destination exists". Do not assume
 * POSIX. Inspect `error.code` first, then fall back to known platform message
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
 * Identity-preserving recovery claim.
 *
 * Before quarantining a `dead-same-host` lock, a recoverer must atomically
 * create a CANONICAL claim directory INSIDE the canonical lock directory and
 * then re-read `owner.json` to confirm the exact owner it classified is still
 * present and still dead. This closes the window between classification and
 * quarantine where another contender could replace the canonical lock with a
 * live replacement.
 *
 * CANONICAL IDENTITY: the claim path is derived ONLY from the stale owner's
 * nonce (`.recovery-claim-<expected-owner-nonce>`), NOT from the recovering
 * process's PID. Every compliant recoverer contending on the same stale owner
 * attempts to create the SAME path with true create-if-absent semantics
 * (`mkdir` with `recursive:false`). Only one process can hold the claim for a
 * given stale lock at a time, so a second recoverer cannot replace the stale
 * lock before the claimant quarantines it.
 *
 * Returns a claim handle on success, or `null` if the claim could not be
 * acquired (another recoverer already holds it) or the owner identity changed
 * (the current lock is NOT what we classified — do not quarantine).
 *
 * SOFT PROTOCOL: all compliant recoverers must honor the claim. A non-compliant
 * recoverer that ignores the claim can still race; the claim is a mutual
 * exclusion marker, not a hard filesystem primitive.
 *
 * AVAILABILITY TRADEOFF: a recoverer that crashes while holding the short
 * claim leaves the claim directory behind, which blocks compliant recovery of
 * that stale lock until manual cleanup. This is the documented tradeoff for
 * safety against stealing a live lock.
 */
type RecoveryClaim = {
  /** Canonical claim directory path inside the stale lock. */
  path: string
  /** Bounded random token identifying this recoverer instance. */
  nonce: string
  /** The stale owner this claim is bound to. */
  expectedOwner: ProjectLockOwner
}

async function acquireRecoveryClaim(
  project: string,
  expectedOwner: ProjectLockOwner,
  postClaimBarrier?: string,
): Promise<RecoveryClaim | null> {
  const lockDir = projectLockDir(project)
  // Canonical claim identity: derived from the stale owner's nonce only, so
  // every compliant recoverer of the same stale owner contends on one path.
  const claimPath = join(lockDir, `.recovery-claim-${expectedOwner.nonce}`)
  const recovererNonce = randomUUID()
  try {
    // True cross-process create-if-absent: throws EEXIST if any file or
    // directory already exists at the canonical claim path.
    await mkdir(claimPath, { recursive: false })
  } catch {
    // EEXIST (another recoverer already holds the canonical claim) or ENOENT
    // (canonical lock already gone). Do not recover.
    return null
  }

  // Write bounded claimant metadata inside the claim directory.
  try {
    await writeFile(
      join(claimPath, "claim.json"),
      JSON.stringify(
        {
          recoverer_pid: process.pid,
          recoverer_nonce: recovererNonce,
          claimed_at: new Date().toISOString(),
          expected_owner_nonce: expectedOwner.nonce,
        },
        null,
        2,
      ),
      "utf-8",
    )
  } catch {
    await rm(claimPath, { recursive: true, force: true }).catch(() => {})
    return null
  }

  // Re-read the current owner and verify it is still the exact owner we
  // classified, and still qualifies as dead (PID ESRCH).
  const current = await readOwner(lockDir)
  if (!current || current.nonce !== expectedOwner.nonce) {
    await rm(claimPath, { recursive: true, force: true }).catch(() => {})
    return null
  }
  try {
    process.kill(current.pid, 0)
    // Still alive: not dead anymore. Do not recover.
    await rm(claimPath, { recursive: true, force: true }).catch(() => {})
    return null
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ESRCH") {
      // EPERM or unexpected: conservative, do not recover.
      await rm(claimPath, { recursive: true, force: true }).catch(() => {})
      return null
    }
  }

  // Test hook: pause AFTER claim acquisition AND revalidation, BEFORE
  // quarantine. Writes `<path>.reached` and waits for `<path>` to exist. This
  // lets a test deterministically prove the canonical claim is exclusive.
  if (postClaimBarrier) {
    await writeFile(`${postClaimBarrier}.reached`, "ready", "utf-8")
    await waitFor(postClaimBarrier)
  }

  return { path: claimPath, nonce: recovererNonce, expectedOwner }
}

/**
 * Best-effort removal of a recovery claim directory. The claim is only a
 * mutual-exclusion marker during recovery; failure to remove it is non-fatal.
 */
async function retireRecoveryClaim(
  _project: string,
  claimPath: string,
): Promise<void> {
  await rm(claimPath, { recursive: true, force: true }).catch(() => {})
}

/**
 * ABA-safe stale recovery: atomically rename the canonical `.state-lock` into
 * a unique stale-recovery directory, then best-effort delete it. Only the
 * process that successfully renames owns the recovery. Returns true if we
 * quarantined the stale lock.
 *
 * The canonical recovery claim lives INSIDE `.state-lock`, so the rename moves
 * the claim WITH the stale directory and the recursive delete removes it. We
 * never try to remove a claim from a newly created canonical replacement.
 *
 * SOFT PROTOCOL ASSUMPTION: this function is only safe to call AFTER the
 * caller has acquired a recovery claim via `acquireRecoveryClaim` and verified
 * the owner identity. The atomic rename proves only that one process moved
 * whatever object occupied the canonical path at rename time; it does NOT
 * prove that object is the stale owner previously classified. The recovery
 * claim + revalidation is what closes that interval. Non-compliant callers that
 * call this without a claim can still race and must not be relied upon.
 */
async function quarantineStaleLock(
  project: string,
  claim: RecoveryClaim,
): Promise<boolean> {
  const lockDir = projectLockDir(project)
  const parentDir = globalProjectStorageDir(project)
  const recoveryDir = join(
    parentDir,
    `.state-lock.stale-recovery.${process.pid}.${randomUUID()}`,
  )
  try {
    await rename(lockDir, recoveryDir)
  } catch {
    // Someone else renamed first or replaced `.state-lock`. Clean up the claim
    // ONLY if it is still demonstrably this recoverer's claim under the same
    // expected owner. If the metadata file has been replaced by another
    // recoverer, leave it alone and fail conservatively.
    await cleanupClaimIfOwned(claim)
    return false
  }
  await rm(recoveryDir, { recursive: true, force: true }).catch(() => {})
  return true
}

/**
 * Best-effort removal of a recovery claim directory, but ONLY if it is still
 * demonstrably this recoverer's claim under the same expected owner. Re-checks
 * the metadata file under the canonical claim path and confirms `recoverer_pid`
 * matches this process AND `expected_owner_nonce` matches the expected stale
 * nonce. If the metadata file has been replaced by another recoverer, leave it
 * alone and fail conservatively.
 */
async function cleanupClaimIfOwned(claim: RecoveryClaim): Promise<void> {
  try {
    const raw = await readFile(join(claim.path, "claim.json"), "utf-8")
    const meta = JSON.parse(raw)
    if (
      meta &&
      meta.recoverer_pid === process.pid &&
      meta.expected_owner_nonce === claim.expectedOwner.nonce
    ) {
      await rm(claim.path, { recursive: true, force: true }).catch(() => {})
    }
    // Otherwise the claim belongs to another recoverer; leave it alone.
  } catch {
    // Metadata unreadable or already gone; do nothing.
  }
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
      // Retire-then-delete: atomically rename the owned canonical directory to
      // a unique retired path, then recursively delete ONLY that path. Once the
      // rename succeeds, a new owner can acquire the canonical path; our
      // cleanup can never target a replacement owner's lock.
      const parentDir = globalProjectStorageDir(project)
      const retiredPath = join(
        parentDir,
        `.state-lock.released.${owner.nonce}.${randomUUID().slice(0, 8)}`,
      )
      try {
        await rename(lockDir, retiredPath)
      } catch (error) {
        // Rename failed (someone else acquired). Do NOT recursively delete the
        // canonical path.
        console.error("lock-release-failed", {
          project,
          error: String(error),
        })
        return false
      }
      // Best-effort recursive delete of the unique retired path.
      await rm(retiredPath, { recursive: true, force: true }).catch(() => {})
      return true
    },
  }
}

type AcquireOnceResult =
  | { status: "acquired"; handle: ProjectLockHandle }
  | { status: "contended"; classification: LockClassification }

/**
 * One acquisition attempt: atomically create the canonical `.state-lock`
 * directory (create-if-absent via `mkdir` with `recursive:false`), then write
 * `owner.json`. On contention, classify the current owner.
 *
 * There is a brief publication interval where `.state-lock` exists but
 * `owner.json` does not yet exist. That interval is SAFE: a contender that
 * observes an empty `.state-lock` classifies as `unknown-owner` and retries. A
 * crash in that window leaves an unknown lock requiring manual cleanup
 * (availability failure, not a mutual-exclusion failure).
 */
async function acquireOnce(project: string): Promise<AcquireOnceResult> {
  const lockDir = projectLockDir(project)
  await ensureGlobalProjectDir(project)
  const owner = buildOwner()
  try {
    // True create-if-absent: throws EEXIST if `.state-lock` already exists.
    await mkdir(lockDir, { recursive: false })
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
  }

  // We created the canonical directory; publish the owner metadata.
  try {
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify(owner, null, 2),
      "utf-8",
    )
  } catch (error) {
    // Best-effort cleanup of the directory we just created. No contender can
    // have acquired it (mkdir would have failed for them), so removing it is
    // safe. A crash here leaves an unknown lock for manual cleanup.
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
    console.error("lock-acquire-write-owner-failed", {
      project,
      error: String(error),
    })
    return {
      status: "contended",
      classification: { kind: "unknown-owner", reason: "read-error" },
    }
  }

  return { status: "acquired", handle: buildHandle(project, lockDir, owner) }
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

/** Wait until `path` exists (used by the test classification barrier). */
async function waitFor(path: string): Promise<void> {
  for (;;) {
    try {
      await access(path)
      return
    } catch {
      await sleep(10)
    }
  }
}

/** Exponential backoff with jitter, capped at `max`. */
function backoffWithJitter(base: number, max: number): number {
  const jitter = Math.random() * base
  return Math.min(base + jitter, max)
}

/**
 * Single acquisition attempt. Returns `null` on contention / unknown ownership
 * (treat as "could not acquire right now"). Dead same-host locks are recovered
 * via an identity-preserving recovery claim + quarantine before giving up. The
 * caller is responsible for retry/backoff logic if needed; `withProjectLock`
 * wraps this with retry.
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
    const claim = await acquireRecoveryClaim(
      project,
      classification.owner,
      options?.waitForPostClaimBarrier,
    )
    if (claim) {
      const quarantined = await quarantineStaleLock(project, claim)
      await retireRecoveryClaim(project, claim.path)
      if (quarantined) {
        const retry = await acquireOnce(project)
        if (retry.status === "acquired") return retry.handle
      }
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
  const classificationBarrier = options?.waitForClassificationBarrier
  const postClaimBarrier = options?.waitForPostClaimBarrier

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

    // Test hook: pause immediately after classification, before any recovery.
    if (classificationBarrier) {
      await writeFile(classificationBarrier, "ready", "utf-8")
      await waitFor(`${classificationBarrier}.release`)
    }

    if (classification.kind === "dead-same-host") {
      const claim = await acquireRecoveryClaim(
        project,
        classification.owner,
        postClaimBarrier,
      )
      if (claim) {
        const quarantined = await quarantineStaleLock(project, claim)
        await retireRecoveryClaim(project, claim.path)
        if (quarantined) {
          // Retry normal acquisition from the top.
          backoff = initialBackoffMs
          continue
        }
        // Quarantine failed: someone else changed the lock; re-classify next loop.
        continue
      }
      // Claim failed: someone else is recovering (or the lock changed). Back off
      // and re-classify on the next iteration.
      await sleep(backoffWithJitter(backoff, maxBackoffMs))
      backoff = Math.min(backoff * 2, maxBackoffMs)
      continue
    }

    // live-same-host, foreign-host, unknown-owner: backoff and retry.
    // "missing" never reaches here because acquireOnce would have acquired.
    await sleep(backoffWithJitter(backoff, maxBackoffMs))
    backoff = Math.min(backoff * 2, maxBackoffMs)
  }
}
