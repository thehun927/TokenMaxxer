/**
 * Centralized project and storage path resolution.
 *
 * This is a leaf module: it depends only on `node:path`, `node:os`, and
 * `node:crypto`.  It must not import from `./store` or `./schema` to avoid
 * circular dependencies.  Storage, status, diagnostics, and project-lock
 * paths should all use these functions instead of deriving paths
 * independently.
 */
import { join } from "node:path"
import { createHash } from "node:crypto"
import { homedir } from "node:os"

/**
 * Resolve the effective project path for memory storage.
 * `worktree` is the git worktree root, but in non-git directories opencode
 * sets it to "/" (root), which is not writable. Fall back to `directory`
 * (the session CWD) when worktree is "/" or otherwise invalid.
 *
 * Compute this ONCE per session and pass it through. Never re-derive it
 * independently in storage, status, diagnostics, or project-lock paths.
 */
export function resolveProjectPath(worktree: string, directory: string): string {
  if (!worktree || worktree === "/" || worktree === "") {
    return directory
  }
  return worktree
}

/** Path to STATE.json within a project. */
export function projectMemoryPath(project: string): string {
  return join(project, ".opencode", "memory", "STATE.json")
}

/** Directory for global fallback storage for one project (hashed). */
export function globalProjectStorageDir(project: string): string {
  return join(homedir(), ".config", "opencode", "memory", projectStorageHash(project))
}

/** Path to global fallback STATE.json for one project (hashed). */
export function globalMemoryPath(project: string): string {
  return join(globalProjectStorageDir(project), "STATE.json")
}

/**
 * Directory used as the cross-process project lock.
 *
 * The lock is a directory (not a file) because lock state requires an atomic
 * rename of a fully-initialized candidate. The canonical lock path is
 * `<globalProjectStorageDir(project)>/.state-lock`.
 */
export function projectLockDir(project: string): string {
  return join(globalProjectStorageDir(project), ".state-lock")
}

/**
 * Stable hash identifying one project in the global fallback namespace.
 * Currently a 16-hex-char prefix of sha256(project). Keep this function
 * stable; PR 2 (cross-process transactions) reuses it for the project lock.
 */
export function projectStorageHash(project: string): string {
  return createHash("sha256").update(project).digest("hex").slice(0, 16)
}

/**
 * Directory for project-local memory storage.
 * Used by Wave 2 artifact storage for project-local artifacts.
 */
export function projectMemoryStorageDir(project: string): string {
  return join(project, ".opencode", "memory")
}
