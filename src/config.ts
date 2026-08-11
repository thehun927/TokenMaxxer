import type { TokenmaxxerOptions } from "./types"

/**
 * Load plugin options from environment variables.
 *
 * PR 7 Wave 2 precedence:
 * 1. valid TOKENMAXXER_COMPACTION_MODE wins
 * 2. otherwise TOKENMAXXER_NO_PROMPT=1 -> augment
 * 3. otherwise explicit TOKENMAXXER_NO_PROMPT=0 -> replace
 * 4. otherwise -> augment
 *
 * Invalid new mode fails safely to augment.
 */
export function loadOptions(_ctx: unknown): TokenmaxxerOptions {
  const newMode = process.env.TOKENMAXXER_COMPACTION_MODE

  // 1. Valid new mode wins
  if (newMode === "augment" || newMode === "replace") {
    return { compactionMode: newMode }
  }

  // An explicitly supplied but invalid new mode must fail closed to augment;
  // it must not silently inherit legacy replacement behavior.
  if (newMode !== undefined) {
    return { compactionMode: "augment" }
  }

  // 2. Legacy TOKENMAXXER_NO_PROMPT=1 -> augment
  if (process.env.TOKENMAXXER_NO_PROMPT === "1") {
    return { compactionMode: "augment" }
  }

  // 3. Explicit legacy TOKENMAXXER_NO_PROMPT=0 -> replace
  if (process.env.TOKENMAXXER_NO_PROMPT === "0") {
    return { compactionMode: "replace" }
  }

  // 4. Default -> augment
  return { compactionMode: "augment" }
}
