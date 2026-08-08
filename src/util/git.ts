/**
 * Get the current git SHA for a worktree.
 * Returns null if not a git repo, git not installed, or any error.
 * Uses Bun.$ when available, falls back to child_process.
 */
export async function getCurrentGitSha(worktree: string): Promise<string | null> {
  try {
    // Try Bun shell first (available in opencode runtime)
    const Bun = (globalThis as unknown as { Bun?: { $?: { git: unknown } } }).Bun
    if (Bun?.$) {
      const proc = (Bun.$ as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<{ stdout: string }>)`git -C ${worktree} rev-parse HEAD`
      const result = await proc
      const sha = result.stdout?.trim()
      if (sha && /^[0-9a-f]{7,40}$/.test(sha)) return sha
      return null
    }
  } catch {
    // Fall through to child_process
  }

  try {
    const { execSync } = await import("node:child_process")
    const sha = execSync("git rev-parse HEAD", {
      cwd: worktree,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    if (sha && /^[0-9a-f]{7,40}$/.test(sha)) return sha
    return null
  } catch {
    return null
  }
}