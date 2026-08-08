import type { TokenmaxxerOptions } from "./types"

/**
 * Load plugin options from environment variables.
 * Future: also read from opencode.json "tokenmaxxer" key via client.config.get().
 */
export function loadOptions(_ctx: unknown): TokenmaxxerOptions {
  return {
    // Kill switch: set TOKENMAXXER_NO_PROMPT=1 to skip prompt replacement,
    // still inject durable block via output.context
    compactionPrompt: process.env.TOKENMAXXER_NO_PROMPT !== "1",
    headerInjection: "instructions",
    memoryKey: "worktree",
  }
}