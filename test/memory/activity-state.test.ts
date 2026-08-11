import { afterEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  beginMemoryActivity,
  isMemoryActivityFresh,
  memoryActivityPath,
  resetMemoryActivity,
} from "../../src/memory/activity-state"

const projects: string[] = []

async function project(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tokenmaxxer-activity-"))
  projects.push(path)
  return path
}

afterEach(async () => {
  resetMemoryActivity()
  await Promise.all(projects.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("memory activity marker", () => {
  it("stays present until concurrent local work has settled", async () => {
    const path = await project()
    const first = beginMemoryActivity(path)
    const second = beginMemoryActivity(path)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await isMemoryActivityFresh(path)).toBe(true)

    first()
    expect(await isMemoryActivityFresh(path)).toBe(true)
    second()
    let fresh = true
    for (let attempt = 0; attempt < 20 && fresh; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      fresh = await isMemoryActivityFresh(path)
    }
    expect(fresh).toBe(false)
  })

  it("treats malformed and stale state as inactive without throwing", async () => {
    const path = await project()
    const marker = memoryActivityPath(path)
    expect(marker).toBe(join(path, ".opencode/.tokenmaxxer-memory-activity"))
    await mkdir(join(path, ".opencode"), { recursive: true })
    await writeFile(marker, "not json", "utf8")
    expect(await isMemoryActivityFresh(path)).toBe(false)

    await writeFile(marker, JSON.stringify({ updated_at: Date.now() - 60_000 }), "utf8")
    expect(await isMemoryActivityFresh(path)).toBe(false)
    await expect(readFile(marker, "utf8")).rejects.toThrow()
  })
})
