import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { atomicWrite, readFileResult, safeRead } from "../../src/util/fs"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tokenmaxxer-fs-test-"))
  temporaryDirectories.push(directory)
  return directory
}

describe("readFileResult", () => {
  it("returns missing for a file that does not exist", async () => {
    const directory = await createTemporaryDirectory()
    const result = await readFileResult(join(directory, "does-not-exist.txt"))
    expect(result).toEqual({ kind: "missing" })
  })

  it("returns ok with content and a positive mtime for a readable file", async () => {
    const directory = await createTemporaryDirectory()
    const filePath = join(directory, "hello.txt")
    await writeFile(filePath, "hello world", "utf-8")

    const result = await readFileResult(filePath)
    expect(result.kind).toBe("ok")
    if (result.kind !== "ok") return
    expect(result.content).toBe("hello world")
    expect(typeof result.mtime).toBe("number")
    expect(result.mtime).toBeGreaterThan(0)
  })

  it("returns error (not missing) when the target is a directory", async () => {
    const directory = await createTemporaryDirectory()
    const subdir = join(directory, "a-directory")
    await mkdir(subdir)

    const result = await readFileResult(subdir)
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.code).toBe("EISDIR")
    }
  })

  it("returns error for a file that cannot be read", async () => {
    const directory = await createTemporaryDirectory()
    const filePath = join(directory, "secret.txt")
    await writeFile(filePath, "top secret", "utf-8")
    await chmod(filePath, 0o000)

    // Probe whether the environment actually enforces the permission: on a
    // root / privileged runner chmod 000 is not enforced and reading still
    // succeeds. In that case fall back to reading a directory as a file
    // (fails with EISDIR regardless of privileges). Either way the goal is to
    // prove the API distinguishes "cannot read" from "does not exist".
    let permissionEnforced = false
    try {
      await readFile(filePath, "utf-8")
    } catch {
      permissionEnforced = true
    }

    const result = await readFileResult(permissionEnforced ? filePath : directory)
    expect(result.kind).toBe("error")
    expect(result).not.toMatchObject({ kind: "missing" })
  })
})

describe("atomicWrite", () => {
  it("writes content that a subsequent read returns unchanged", async () => {
    const directory = await createTemporaryDirectory()
    const filePath = join(directory, "state.json")
    const content = JSON.stringify({ revision: 1 })

    await atomicWrite(filePath, content)

    expect(await readFile(filePath, "utf-8")).toBe(content)
  })

  it("leaves no .tmp.* file behind on success", async () => {
    const directory = await createTemporaryDirectory()
    const filePath = join(directory, "state.json")

    await atomicWrite(filePath, "data")

    const entries = await readdir(directory)
    expect(entries).toEqual(["state.json"])
  })

  it("allows two concurrent writes to the same target without temp collisions", async () => {
    const directory = await createTemporaryDirectory()
    const filePath = join(directory, "state.json")

    await Promise.all([
      atomicWrite(filePath, "first"),
      atomicWrite(filePath, "second"),
    ])

    const finalContent = await readFile(filePath, "utf-8")
    expect(["first", "second"]).toContain(finalContent)

    const entries = await readdir(directory)
    expect(entries).toEqual(["state.json"])
  })
})

describe("safeRead (regression guard for Wave 2)", () => {
  it("returns null for a missing file", async () => {
    const directory = await createTemporaryDirectory()
    await expect(safeRead(join(directory, "missing.txt"))).resolves.toBeNull()
  })

  it("returns the content for an existing file", async () => {
    const directory = await createTemporaryDirectory()
    const filePath = join(directory, "known.txt")
    await writeFile(filePath, "known content", "utf-8")
    await expect(safeRead(filePath)).resolves.toBe("known content")
  })
})
