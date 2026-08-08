import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"

/** Create an SDK v2 client for the server and project supplied to a plugin. */
export function createV2Client(serverUrl: URL, directory: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl: serverUrl.toString(),
    directory,
  })
}
