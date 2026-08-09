/**
 * Safe filesystem operations: mkdir -p, atomic write, safe read, mtime.
 * All functions are null-safe and never throw on missing files.
 */
import { mkdir, writeFile, readFile, rename, stat } from "node:fs/promises"
import { dirname } from "node:path"

/** Ensure the parent directory of `path` exists (recursive mkdir). */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {})
}

/** Write a file atomically (temp file + rename on same filesystem). */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`
  await ensureDir(path)
  await writeFile(tmp, content, "utf-8")
  await rename(tmp, path)
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
