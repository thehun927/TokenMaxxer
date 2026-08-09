/**
 * Get the current git SHA for a worktree.
 * Returns null if not a git repo, git not installed, or any error.
 * Uses a captured child process so git output never reaches the terminal.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export async function getCurrentGitSha(worktree: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", worktree, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      shell: false,
    })
    const sha = stdout.trim()
    if (sha && /^[0-9a-f]{7,40}$/.test(sha)) return sha
    return null
  } catch {
    return null
  }
}
