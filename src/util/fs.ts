/**
 * Safe filesystem operations: mkdir -p, atomic write, safe read, mtime.
 * All functions are null-safe and never throw on missing files.
 */
import { mkdir, writeFile, readFile, rename, rm, stat } from "node:fs/promises"
import type { Stats } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"

/** Ensure the parent directory of `path` exists (recursive mkdir). */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {})
}

/** Write a file atomically (temp file + rename on same filesystem). */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`
  await ensureDir(path)
  await writeFile(tmp, content, "utf-8")
  try {
    await rename(tmp, path)
  } catch (error) {
    // Best-effort cleanup of the orphan temp file; swallow cleanup failures.
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** Read a file, returning null if it doesn't exist or can't be read. */
export async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8")
  } catch {
    return null
  }
}

/** Get file mtime in ms, or null if the file doesn't exist. */
export async function getMtime(path: string): Promise<number | null> {
  try {
    const s = await stat(path)
    return s.mtimeMs
  } catch {
    return null
  }
}

/**
 * Distinguishes the three real outcomes of trying to read a file:
 *  - ok: file existed and was readable
 *  - missing: file did not exist (ENOENT)
 *  - error: file existed but could not be read (permission, IO, parse, etc.)
 *
 * This is the authoritative read API. `safeRead()` collapses "missing" and
 * "error" into a single null, which silently authorizes empty-memory
 * initialization from an unresolved read failure. Callers that need to know
 * whether a missing file vs. a permission error must use this typed API.
 */
export type FileReadResult =
  | { kind: "ok"; content: string; mtime: number }
  | { kind: "missing" }
  | { kind: "error"; code?: string; message: string }

/**
 * Read a file with full outcome classification.
 *
 * - ENOENT → "missing"
 * - any other stat/read failure → "error" with the OS code if available
 * - never caches an error as missing
 * - never silently returns ok for an unreadable file
 */
export async function readFileResult(path: string): Promise<FileReadResult> {
  let stats: Stats
  try {
    stats = await stat(path)
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return { kind: "missing" }
    }
    return { kind: "error", code: errnoCode(error), message: errorMessage(error) }
  }

  try {
    const content = await readFile(path, "utf-8")
    return { kind: "ok", content, mtime: stats.mtimeMs }
  } catch (error) {
    return { kind: "error", code: errnoCode(error), message: errorMessage(error) }
  }
}

/** Extract the OS errno code string (e.g. "ENOENT", "EACCES") from an error. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === "string" ? code : undefined
  }
  return undefined
}

/** Human-readable message for any thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
