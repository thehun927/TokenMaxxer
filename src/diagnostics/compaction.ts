/**
 * Compaction prompt/result diagnostic builders and validators.
 *
 * PR-9 Wave 3: bounded compaction prompt snapshots and successful
 * `session.compacted` result metadata.
 *
 * Contract §3/§4/§5:
 * - the prompt artifact (`last_compaction_prompt.log`) records the exact
 *   TokenMaxxer-supplied compaction payload for that hook invocation and is
 *   bounded to 96 KiB UTF-8 bytes, with UTF-8-safe truncation of the stored
 *   diagnostic copy only (never the payload sent to the host);
 * - the result artifact (`last_compaction_result.json`) records successful
 *   completion metadata (version, completed_at, session_id, host_event,
 *   bounded summary status / bytes / sha256) and never persists the summary
 *   body or conversation;
 * - the result JSON is bounded to 4096 UTF-8 bytes;
 * - prompt and result artifacts are never conflated: the prompt builder never
 *   emits result fields and the result builder never emits the payload body.
 *
 * These builders are pure and never touch the filesystem. Persistence is the
 * caller's job through the canonical artifact resolver
 * (`src/diagnostics/artifacts.ts`).
 */

export const COMPACTION_PROMPT_ARTIFACT_MAX_BYTES = 96 * 1024
export const COMPACTION_RESULT_ARTIFACT_MAX_BYTES = 4096

/** Result/prompt metadata bounds (contract §4.2 / §5.1). */
const MAX_SESSION_ID_CHARS = 256
const MAX_REASON_CHARS = 500
const MAX_REQUESTED_MODE_CHARS = 64
/**
 * Cap for a stored fallback_reason value so the full
 * `fallback_reason=<value>` line (16 prefix chars) stays within 550
 * characters total. A pre-bounded reason (index.ts boundReason cap 500 +
 * truncation suffix, at most ~527 chars) is preserved verbatim so the
 * snapshot and the `app.log` metadata always carry the same value.
 */
const MAX_FALLBACK_REASON_LINE_VALUE_CHARS = 534

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

/**
 * Bound a string to at most `max` characters. Values already within the cap
 * are returned unmodified, so a caller can pre-bound once and share the exact
 * value across surfaces (app.log metadata and artifact snapshot).
 */
function boundWithSuffix(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 3)}...`
}

/**
 * Normalize a header metadata value to a bounded single line with visible escaping.
 * - Truncates to maxChars if needed
 * - Escapes CR/LF/control chars with visible markers
 * - Ensures emoji-safe byte accounting
 */
function normalizeHeaderMetadata(value: string, maxChars: number): string {
  // First escape control chars (this makes the string longer)
  let escaped = value.replace(/[\r\n\t]/g, (char) => {
    if (char === '\r') return '\\r'
    if (char === '\n') return '\\n'
    if (char === '\t') return '\\t'
    return char
  })

  // Escape other control chars (0x00-0x1F, 0x7F)
  escaped = escaped.replace(/[\x00-\x1F\x7F]/g, (char) => {
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
  })

  // Now truncate to maxChars (after escaping, so we account for escape sequences)
  return boundWithSuffix(escaped, maxChars)
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a
 * code point in the middle, so the stored diagnostic never contains a
 * malformed UTF-8 replacement character from a split sequence.
 */
function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value
  const bytes = Buffer.from(value, "utf8")
  let end = Math.min(maxBytes, bytes.length)
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1
  }
  return bytes.subarray(0, end).toString("utf8")
}

// ─── Prompt artifact ────────────────────────────────────────────────────────

export type CompactionPromptArtifactInput = {
  sessionID: string
  requestedMode: string
  effectiveMode: string
  fallbackReason?: string
  payload: string
}

export type CompactionPromptArtifact = {
  name: "last_compaction_prompt.log"
  content: string
  payloadBytes: number
  payloadStoredBytes: number
  payloadTruncated: boolean
}

/**
 * Build the bounded prompt snapshot for one compaction hook invocation.
 *
 * The header is a deterministic text block with real newlines, followed by
 * the exact TokenMaxxer-supplied payload (or a UTF-8-safe truncated prefix).
 * The whole artifact is hard-bounded to `COMPACTION_PROMPT_ARTIFACT_MAX_BYTES`
 * UTF-8 bytes including header + payload + separators.
 */
export function buildCompactionPromptArtifact(
  input: CompactionPromptArtifactInput,
): CompactionPromptArtifact {
  const maxBytes = COMPACTION_PROMPT_ARTIFACT_MAX_BYTES
  const sessionID = normalizeHeaderMetadata(input.sessionID, MAX_SESSION_ID_CHARS)
  const requestedMode = normalizeHeaderMetadata(input.requestedMode, MAX_REQUESTED_MODE_CHARS)
  const effectiveMode = normalizeHeaderMetadata(input.effectiveMode, MAX_REQUESTED_MODE_CHARS)
  const fallbackReason = input.fallbackReason
    ? normalizeHeaderMetadata(input.fallbackReason, MAX_FALLBACK_REASON_LINE_VALUE_CHARS)
    : undefined
  const payloadBytes = utf8Bytes(input.payload)
  const kind = effectiveMode === "replace" ? "replacement-prompt" : "context-augmentation"

  const headerLines = (storedBytes: number, truncated: boolean): string[] => [
    "artifact=tokenmaxxer-compaction-prompt",
    "format_version=1",
    `observed_at=${normalizeHeaderMetadata(new Date().toISOString(), 128)}`,
    `session=${sessionID}`,
    `requested_mode=${requestedMode}`,
    `effective_mode=${effectiveMode}`,
    `kind=${kind}`,
    `payload_bytes=${payloadBytes}`,
    `payload_stored_bytes=${storedBytes}`,
    `payload_truncated=${truncated ? "true" : "false"}`,
    ...(fallbackReason !== undefined ? [`fallback_reason=${fallbackReason}`] : []),
  ]

  const payloadMarker = "--- payload ---"
  const footer = "\n---\n"

  // The optimistic header (assuming the whole payload fits) determines the
  // budget available for the stored diagnostic payload.
  const optimisticPrefix = `${headerLines(payloadBytes, false).join("\n")}\n${payloadMarker}\n`
  const budget = maxBytes - utf8Bytes(optimisticPrefix) - utf8Bytes(footer)

  let storedPayload: string
  let truncated: boolean
  if (utf8Bytes(input.payload) <= budget) {
    storedPayload = input.payload
    truncated = false
  } else {
    storedPayload = truncateUtf8(input.payload, budget)
    truncated = true
  }

  const header = headerLines(utf8Bytes(storedPayload), truncated)
  const content = `${header.join("\n")}\n${payloadMarker}\n${storedPayload}${footer}`

  // Defensive guarantee: the rebuilt header can only shrink relative to the
  // optimistic one ("false"→"true" is shorter and stored-bytes digits never
  // grow), but re-truncate against the real header size if that assumption
  // ever breaks so the hard byte invariant always holds.
  if (utf8Bytes(content) > maxBytes) {
    const realPrefix = `${header.join("\n")}\n${payloadMarker}\n`
    const realBudget = maxBytes - utf8Bytes(realPrefix) - utf8Bytes(footer)
    const reStored = truncateUtf8(input.payload, realBudget)
    const reHeader = headerLines(utf8Bytes(reStored), true)
    const reContent = `${reHeader.join("\n")}\n${payloadMarker}\n${reStored}${footer}`
    return {
      name: "last_compaction_prompt.log",
      content: reContent,
      payloadBytes,
      payloadStoredBytes: utf8Bytes(reStored),
      payloadTruncated: true,
    }
  }

  return {
    name: "last_compaction_prompt.log",
    content,
    payloadBytes,
    payloadStoredBytes: utf8Bytes(storedPayload),
    payloadTruncated: truncated,
  }
}

// ─── Result artifact ────────────────────────────────────────────────────────

export type CompactionResultSummary =
  | { status: "found"; bytes: number; sha256: string }
  | { status: "missing" }
  | { status: "unavailable"; reason: string }

export type CompactionResultDiagnostic = {
  version: 1
  completed_at: string
  session_id: string
  host_event: "session.compacted"
  summary: CompactionResultSummary
}

export type CompactionResultDiagnosticArtifact = {
  name: "last_compaction_result.json"
  json: string
}

/**
 * Clamp a byte count to the authoritative persisted representation: a
 * non-negative safe integer (matching `validateCompactionResultDiagnostic`).
 * Negative, fractional, unsafe, or non-finite inputs collapse to 0 so builder
 * output always passes the read-side validator.
 */
function normalizeByteCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * Normalize a summary for persistence: bound the unavailable reason to 500
 * chars, keep only non-negative safe byte counts, and require a
 * 64-lowercase-hex SHA-256 identity. The summary body itself is never carried
 * here.
 */
function normalizeResultSummary(summary: CompactionResultSummary): CompactionResultSummary {
  if (summary.status === "found") {
    const bytes = normalizeByteCount(summary.bytes)
    const sha256 =
      typeof summary.sha256 === "string" && /^[0-9a-f]{64}$/.test(summary.sha256)
        ? summary.sha256
        : "0".repeat(64)
    return { status: "found", bytes, sha256 }
  }
  if (summary.status === "unavailable") {
    return { status: "unavailable", reason: boundWithSuffix(summary.reason, MAX_REASON_CHARS) }
  }
  return { status: "missing" }
}

/**
 * Build the bounded result artifact JSON for a successful `session.compacted`
 * event. `completed_at` is the time TokenMaxxer receives the host's successful
 * completion event; the host emits that event only after successful compaction
 * processing, so this is a truthful completion observation.
 */
export function buildCompactionResultDiagnostic(input: {
  completedAt: string
  sessionID: string
  summary: CompactionResultSummary
}): CompactionResultDiagnosticArtifact {
  const value: CompactionResultDiagnostic = {
    version: 1,
    completed_at: input.completedAt,
    session_id: boundWithSuffix(input.sessionID, MAX_SESSION_ID_CHARS),
    host_event: "session.compacted",
    summary: normalizeResultSummary(input.summary),
  }
  return {
    name: "last_compaction_result.json",
    json: JSON.stringify(value),
  }
}

// ─── Runtime validation ─────────────────────────────────────────────────────

export type CompactionResultValidationResult =
  | { ok: true; value: CompactionResultDiagnostic }
  | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedErrorText(error: unknown, maxChars = 200): string {
  const message = error instanceof Error ? error.message : String(error)
  return boundWithSuffix(message, maxChars)
}

/**
 * Strong ISO-8601 timestamp check for `completed_at` (contract §5.1).
 *
 * Requires the builder-consistent representation — `YYYY-MM-DDTHH:mm:ss`
 * with optional milliseconds and a `Z` or numeric UTC offset — and rejects
 * impossible calendar/clock values (e.g. `2026-02-30` or `24:00`) that
 * `Date.parse` would otherwise silently roll over.
 */
const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function isIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_RE.exec(value)
  if (!match) return false
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  const hour = Number(hourStr)
  const minute = Number(minuteStr)
  const second = Number(secondStr)
  if (month < 1 || month > 12) return false
  if (day < 1 || day > daysInMonth(year, month)) return false
  if (hour > 23 || minute > 59 || second > 59) return false
  return !Number.isNaN(Date.parse(value))
}

/**
 * Runtime schema check for a persisted result artifact (contract §5.1).
 *
 * This validator is authoritative for the persisted result schema, not merely
 * for builder output: it enforces every declared persisted bound even when a
 * damaged, legacy, or externally modified JSON artifact bypasses the builder's
 * normalizing side. A malformed artifact is a diagnostic failure, not memory
 * corruption; the caller decides how to surface it without throwing the whole
 * status away (status reports it as `unavailable (invalid diagnostic
 * artifact)`).
 *
 * Enforced persisted bounds:
 * - the raw result JSON is `<= 4096` UTF-8 bytes (checked before parsing);
 * - `session_id` is `<= 256` chars;
 * - `summary.reason` is `<= 500` chars;
 * - `summary.bytes` is a non-negative safe integer;
 * - `completed_at` is a valid ISO-8601 timestamp consistent with the builder;
 * - `summary.sha256` is exactly 64 lowercase hex chars.
 */
export function validateCompactionResultDiagnostic(
  json: string,
): CompactionResultValidationResult {
  try {
    // Reject an oversized raw artifact before spending any parse effort.
    if (utf8Bytes(json) > COMPACTION_RESULT_ARTIFACT_MAX_BYTES) {
      return {
        ok: false,
        reason: `result JSON exceeds ${COMPACTION_RESULT_ARTIFACT_MAX_BYTES} UTF-8 bytes`,
      }
    }
    const parsed: unknown = JSON.parse(json)
    if (!isRecord(parsed)) {
      return { ok: false, reason: "result is not a JSON object" }
    }
    if (parsed.version !== 1) {
      return { ok: false, reason: "unsupported result version" }
    }
    if (parsed.host_event !== "session.compacted") {
      return { ok: false, reason: "unexpected host_event" }
    }
    if (typeof parsed.completed_at !== "string") {
      return { ok: false, reason: "completed_at is not a string" }
    }
    if (!isIsoTimestamp(parsed.completed_at)) {
      return { ok: false, reason: "completed_at is not a valid ISO timestamp" }
    }
    if (typeof parsed.session_id !== "string") {
      return { ok: false, reason: "session_id is not a string" }
    }
    if (parsed.session_id.length > MAX_SESSION_ID_CHARS) {
      return {
        ok: false,
        reason: `session_id exceeds ${MAX_SESSION_ID_CHARS} chars`,
      }
    }
    const summary = parsed.summary
    if (!isRecord(summary)) {
      return { ok: false, reason: "summary is missing or malformed" }
    }

    const status = summary.status
    if (status === "found") {
      const bytes = summary.bytes
      if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
        return { ok: false, reason: "summary.bytes is not a non-negative safe integer" }
      }
      const sha256 = summary.sha256
      if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
        return { ok: false, reason: "summary.sha256 is not 64 lowercase hex chars" }
      }
      return {
        ok: true,
        value: {
          version: 1,
          completed_at: parsed.completed_at,
          session_id: parsed.session_id,
          host_event: "session.compacted",
          summary: { status: "found", bytes, sha256 },
        },
      }
    }

    if (status === "missing") {
      return {
        ok: true,
        value: {
          version: 1,
          completed_at: parsed.completed_at,
          session_id: parsed.session_id,
          host_event: "session.compacted",
          summary: { status: "missing" },
        },
      }
    }

    if (status === "unavailable") {
      const reason = summary.reason
      if (typeof reason !== "string") {
        return { ok: false, reason: "summary.reason is not a string" }
      }
      if (reason.length > MAX_REASON_CHARS) {
        return {
          ok: false,
          reason: `summary.reason exceeds ${MAX_REASON_CHARS} chars`,
        }
      }
      return {
        ok: true,
        value: {
          version: 1,
          completed_at: parsed.completed_at,
          session_id: parsed.session_id,
          host_event: "session.compacted",
          summary: { status: "unavailable", reason },
        },
      }
    }

    return { ok: false, reason: "unknown summary status" }
  } catch (error) {
    return { ok: false, reason: boundedErrorText(error) }
  }
}
