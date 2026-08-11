/**
 * PR-7 Wave 4 — Injection sanitizer for durable values and previous-summary
 * anchors injected into compaction prompts.
 *
 * These are pure functions. They never mutate their inputs and never touch
 * storage.
 */

const TRUNC_MARKER = "…[truncated]"

const DURABLE_OPEN = "<<<TOKENMAXXER_DURABLE_CONTEXT_DATA>>>"
const DURABLE_CLOSE = "<<<END_TOKENMAXXER_DURABLE_CONTEXT_DATA>>>"
const PREV_SUMMARY_CLOSE = "<<<END_PREVIOUS_SUMMARY_ANCHOR>>>"
const PREV_SUMMARY_LEGACY_CLOSE = "<<<END_PREVIOUS_SUMMARY>>>"

/**
 * Sanitize a single durable-field value before injection into a DATA line.
 *
 * - Normalizes CR/LF/newline sequences into literal `\\n` escapes so no
 *   value can create extra data lines.
 * - Strips C0/C1 control characters and Unicode line/paragraph separators
 *   that could create structure.
 * - Removes verbatim durable-context delimiter strings so stored text
 *   cannot close or reopen the durable block.
 * - Truncates by Unicode code points, appending `…[truncated]` when
 *   capped.  Never splits a surrogate pair.
 * - Does NOT HTML-encode or base64-encode ordinary content.
 */
export function sanitizeDurableValue(value: string, maxChars: number): string {
  // 1. Normalize CRLF → LF first
  let result = value.replace(/\r\n/g, "\n")

  // 2. Standalone CR → LF (then all newlines handled uniformly in step 3)
  result = result.replace(/\r/g, "\n")

  // 3. Normalize every remaining literal newline into the two-char escape \\n
  result = result.replace(/\n/g, "\\n")

  // 4. Strip C0/C1 control characters (U+0000–U+001F and U+007F–U+009F).
  //    Tab (U+0009) is intentionally stripped — durable
  //    values are single-line DATA fields and tabs are not structural there.
  result = result.replace(/[\x00-\x1F\x7F-\x9F]/g, "")

  // 5. Strip Unicode line separator U+2028 and paragraph separator U+2029
  result = result.replace(/\u2028/g, "").replace(/\u2029/g, "")

  // 6. Remove verbatim durable-context delimiter strings so they cannot
  //    close/reopen the outer block.  Surrounding semantic content survives.
  result = result.split(DURABLE_OPEN).join("")
  result = result.split(DURABLE_CLOSE).join("")

  // 7. Truncate by Unicode code points (never splitting surrogate pairs)
  const codePoints = [...result]
  if (codePoints.length > maxChars) {
    result = codePoints.slice(0, maxChars).join("") + TRUNC_MARKER
  }

  return result
}

/**
 * Sanitize a recovered previous-summary anchor before interpolation into
 * a replacement-mode prompt.
 *
 * - Strips C0 control characters and CR.
 * - Preserves newlines (the summary is multi-line data for the model).
 * - Removes the verbatim previous-summary closing delimiter.
 * - Caps at 16,384 Unicode code points with a truncation marker.
 * - Is a pure function — does not mutate the input string.
 */
export function sanitizePreviousSummary(value: string): string {
  const MAX_SUMMARY_CHARS = 16_384

  // 1. Normalize CRLF → LF
  let result = value.replace(/\r\n/g, "\n")

  // 2. Strip standalone CR
  result = result.replace(/\r/g, "")

  // 3. Strip C0/C1 control characters and DEL (but preserve newlines)
  result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")

  // 4. Strip Unicode line/paragraph separators
  result = result.replace(/\u2028/g, "").replace(/\u2029/g, "")

  // 5. Remove verbatim previous-summary closing delimiter
  result = result.split(PREV_SUMMARY_CLOSE).join("")
  result = result.split(PREV_SUMMARY_LEGACY_CLOSE).join("")

  // 6. Truncate by Unicode code points
  const codePoints = [...result]
  if (codePoints.length > MAX_SUMMARY_CHARS) {
    result = codePoints.slice(0, MAX_SUMMARY_CHARS).join("") + TRUNC_MARKER
  }

  return result
}
