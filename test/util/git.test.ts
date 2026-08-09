import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { getCurrentGitSha } from "../../src/util/git"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tokenmaxxer-git-test-"))
  temporaryDirectories.push(directory)
  return directory
}

describe("getCurrentGitSha", () => {
  it("returns null for a non-git directory without leaking git stderr", async () => {
    const directory = await createTemporaryDirectory()
    const write = process.stderr.write
    let stderrWrites = 0
    process.stderr.write = ((...args: Parameters<typeof write>) => {
      stderrWrites += 1
      return write.apply(process.stderr, args)
    }) as typeof write

    try {
      await expect(getCurrentGitSha(directory)).resolves.toBeNull()
      expect(stderrWrites).toBe(0)
    } finally {
      process.stderr.write = write
    }
  })

  it("returns the SHA for a valid repository", async () => {
    const directory = await createTemporaryDirectory()
    await execFileAsync("git", ["init", "-q", directory])
    await writeFile(join(directory, "file.txt"), "test\n")
    await execFileAsync("git", ["-C", directory, "add", "file.txt"])
    await execFileAsync("git", [
      "-C",
      directory,
      "-c",
      "user.name=Tokenmaxxer Test",
      "-c",
      "user.email=tokenmaxxer@example.com",
      "commit",
      "-q",
      "-m",
      "test",
    ])

    const { stdout } = await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])
    const expectedSha = stdout.trim()

    await expect(getCurrentGitSha(directory)).resolves.toBe(expectedSha)
  })
})
