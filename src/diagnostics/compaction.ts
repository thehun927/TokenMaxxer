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
  const sessionID = boundWithSuffix(input.sessionID, MAX_SESSION_ID_CHARS)
  const fallbackReason = input.fallbackReason
    ? boundWithSuffix(input.fallbackReason, MAX_FALLBACK_REASON_LINE_VALUE_CHARS)
    : undefined
  const payloadBytes = utf8Bytes(input.payload)
  const effectiveMode = input.effectiveMode
  const kind = effectiveMode === "replace" ? "replacement-prompt" : "context-augmentation"

  const headerLines = (storedBytes: number, truncated: boolean): string[] => [
    "artifact=tokenmaxxer-compaction-prompt",
    "format_version=1",
    `observed_at=${new Date().toISOString()}`,
    `session=${sessionID}`,
    `requested_mode=${input.requestedMode}`,
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
 * Normalize a summary for persistence: bound the unavailable reason to 500
 * chars, keep only finite byte counts, and require a 64-lowercase-hex SHA-256
 * identity. The summary body itself is never carried here.
 */
function normalizeResultSummary(summary: CompactionResultSummary): CompactionResultSummary {
  if (summary.status === "found") {
    const bytes = Number.isFinite(summary.bytes) ? summary.bytes : 0
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
 * Runtime schema check for a persisted result artifact (contract §5.1).
 * A malformed artifact is a diagnostic failure, not memory corruption; the
 * caller decides how to surface it without throwing the whole status away.
 */
export function validateCompactionResultDiagnostic(
  json: string,
): CompactionResultValidationResult {
  try {
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
    if (typeof parsed.session_id !== "string") {
      return { ok: false, reason: "session_id is not a string" }
    }
    const summary = parsed.summary
    if (!isRecord(summary)) {
      return { ok: false, reason: "summary is missing or malformed" }
    }

    const status = summary.status
    if (status === "found") {
      const bytes = summary.bytes
      if (typeof bytes !== "number" || !Number.isFinite(bytes)) {
        return { ok: false, reason: "summary.bytes is not a finite number" }
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
