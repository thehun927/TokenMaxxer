import { describe, expect, it, vi } from "vitest"

const { createOpencodeClient } = vi.hoisted(() => ({
  createOpencodeClient: vi.fn(() => ({ kind: "v2-client" })),
}))

vi.mock("@opencode-ai/sdk/v2", () => ({ createOpencodeClient }))

import { createV2Client } from "../../src/opencode/v2"

describe("createV2Client", () => {
  it("creates a v2 client with the plugin server and directory", () => {
    const serverUrl = new URL("http://127.0.0.1:4096")
    const directory = "/workspace/project"

    expect(createV2Client(serverUrl, directory)).toEqual({ kind: "v2-client" })
    expect(createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: serverUrl.toString(),
      directory,
    })
  })
})
