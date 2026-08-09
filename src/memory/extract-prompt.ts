/**
 * SDK-independent canonical input and prompt construction for LLM extraction.
 */
import { createHash } from "node:crypto"

import type { MemoryFile } from "./schema"
import type { TranscriptMessage } from "../types"

const MAX_PRIOR_STATE_CHARS = 8_000
const MAX_TRANSCRIPT_MESSAGES = 20
const MAX_MESSAGE_CHARS = 500
const MAX_FILE_CANDIDATES = 20
const MAX_EVIDENCE_REF_CHARS = 128

const FILE_TOOL_NAMES = new Set(["read", "edit", "write", "glob", "grep", "bash"])

export interface CanonicalExtractionInput {
  /** Capped, cache-free prior STATE.json content. */
  priorStateJson: string
  /** Last text messages, with each message capped before joining. */
  compressedTranscript: string
  /** Unique, normalized, sorted tool-derived file candidates. */
  fileCandidates: string[]
  /** SHA-256 of the canonical representation of the three fields above. */
  sha256: string
}

/**
 * An ephemeral source-transcript candidate used to corroborate model output.
 * `text` is intentionally kept out of durable state and diagnostics; it is
 * available only to the caller that is building the prompt or corroborating
 * the current source transcript.
 */
export interface TranscriptEvidenceCandidate {
  /** Stable bounded ID cited by a structured decision. */
  ref: string
  role: "user" | "assistant"
  text: string
  /** Digest of the bounded candidate representation, never the candidate text. */
  digest: string
}

export type TranscriptEvidenceCandidateMap = Readonly<
  Record<string, TranscriptEvidenceCandidate>
>

type CacheBearingMemory = MemoryFile & {
  llm_extraction_cache?: unknown
}

/**
 * Remove operational result metadata from the prior snapshot without
 * mutating it. Cache entries and audit guards must not change the identity of
 * the same source input.
 */
export function withoutExtractionCache(
  priorState: CacheBearingMemory | null,
): Record<string, unknown> {
  if (priorState === null) return {}

  const snapshot = { ...(priorState as Record<string, unknown>) }
  delete snapshot.llm_extraction_cache
  delete snapshot.llm_extraction_audits
  delete snapshot.llm_extraction_cache_quarantine
  delete snapshot.model_health
  return snapshot
}

/**
 * Serialize JSON values with object keys in lexical order.
 * Arrays retain their order because their order is part of the input meaning.
 */
export function stableJson(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`
  }

  const object = value as Record<string, unknown>
  const entries = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)

  return `{${entries.join(",")}}`
}

/** Return a lowercase SHA-256 digest for a canonical string. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

/**
 * Derive a short, opaque evidence ID from a source TranscriptMessage ID.
 * Hashing keeps arbitrary host/session IDs out of the prompt while preserving
 * stable references for the same message.
 */
export function makeTranscriptEvidenceRef(messageID: string): string {
  return `tr-${sha256Hex(messageID).slice(0, 16)}`.slice(0, MAX_EVIDENCE_REF_CHARS)
}

interface MutableJsonContainer {
  [key: string]: unknown
}

interface StringLocation {
  parent: MutableJsonContainer | unknown[]
  key: string | number
  value: string
  path: string
}

interface ArrayLocation {
  value: unknown[]
  path: string
}

interface ObjectLocation {
  value: MutableJsonContainer
  path: string
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue)
  if (value && typeof value === "object") {
    const clone: MutableJsonContainer = {}
    for (const key of Object.keys(value)) {
      const child = (value as MutableJsonContainer)[key]
      if (child !== undefined) clone[key] = cloneJsonValue(child)
    }
    return clone
  }
  return value
}

function findStringLocations(
  value: unknown,
  path = "$",
  parent?: MutableJsonContainer | unknown[],
  key?: string | number,
  locations: StringLocation[] = [],
): StringLocation[] {
  if (typeof value === "string" && parent !== undefined && key !== undefined) {
    locations.push({ parent, key, value, path })
    return locations
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      findStringLocations(child, `${path}[${index}]`, value, index, locations),
    )
    return locations
  }
  if (value && typeof value === "object") {
    for (const childKey of Object.keys(value).sort()) {
      findStringLocations(
        (value as MutableJsonContainer)[childKey],
        `${path}.${childKey}`,
        value as MutableJsonContainer,
        childKey,
        locations,
      )
    }
  }
  return locations
}

function findArrayLocations(
  value: unknown,
  path = "$",
  locations: ArrayLocation[] = [],
): ArrayLocation[] {
  if (Array.isArray(value)) {
    locations.push({ value, path })
    value.forEach((child, index) => findArrayLocations(child, `${path}[${index}]`, locations))
    return locations
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value).sort()) {
      findArrayLocations((value as MutableJsonContainer)[key], `${path}.${key}`, locations)
    }
  }
  return locations
}

function findObjectLocations(
  value: unknown,
  path = "$",
  locations: ObjectLocation[] = [],
): ObjectLocation[] {
  if (Array.isArray(value)) {
    value.forEach((child, index) => findObjectLocations(child, `${path}[${index}]`, locations))
    return locations
  }
  if (value && typeof value === "object") {
    const object = value as MutableJsonContainer
    locations.push({ value: object, path })
    for (const key of Object.keys(object).sort()) {
      findObjectLocations(object[key], `${path}.${key}`, locations)
    }
  }
  return locations
}

/**
 * Cap a JSON-compatible snapshot without ever slicing its serialized form.
 * The largest strings are shortened first; if necessary, array tails and
 * object keys are removed deterministically. Every intermediate value remains
 * JSON-compatible, and the final stable serialization is therefore valid JSON.
 */
function capPriorStateJson(snapshot: Record<string, unknown>): string {
  const capped = cloneJsonValue(snapshot)

  while (true) {
    const serialized = stableJson(capped)
    if (serialized.length <= MAX_PRIOR_STATE_CHARS) return serialized

    const strings = findStringLocations(capped).sort(
      (a, b) => b.value.length - a.value.length || a.path.localeCompare(b.path),
    )
    const longest = strings[0]
    if (longest) {
      const reduction = Math.max(serialized.length - MAX_PRIOR_STATE_CHARS, 1)
      const nextLength = Math.max(0, longest.value.length - reduction)
      if (Array.isArray(longest.parent)) {
        longest.parent[longest.key as number] = longest.value.slice(0, nextLength)
      } else {
        longest.parent[longest.key as string] = longest.value.slice(0, nextLength)
      }
      continue
    }

    const arrays = findArrayLocations(capped)
      .filter((location) => location.value.length > 0)
      .sort((a, b) => b.value.length - a.value.length || a.path.localeCompare(b.path))
    const largestArray = arrays[0]
    if (largestArray) {
      const remove = Math.max(1, Math.ceil(largestArray.value.length / 2))
      largestArray.value.splice(largestArray.value.length - remove, remove)
      continue
    }

    const objects = findObjectLocations(capped)
      .filter((location) => Object.keys(location.value).length > 0)
      .sort(
        (a, b) =>
          Object.keys(b.value).length - Object.keys(a.value).length ||
          a.path.localeCompare(b.path),
      )
    const largestObject = objects[0]
    if (largestObject) {
      const keys = Object.keys(largestObject.value).sort()
      const remove = Math.max(1, Math.ceil(keys.length / 2))
      for (const key of keys.slice(-remove)) delete largestObject.value[key]
      continue
    }

    // A JSON primitive cannot be reduced further while retaining its value.
    return "{}"
  }
}

function normalizedTextCandidate(message: TranscriptMessage): {
  role: "user" | "assistant"
  text: string
} | null {
  const role = message.info.role.trim().toLowerCase()
  if (role !== "user" && role !== "assistant") return null

  const text = message.parts
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .replace(/\r\n?/g, "\n")
    .trim()

  if (!text) return null
  return { role, text: text.slice(0, MAX_MESSAGE_CHARS) }
}

/** Digest a bounded candidate without retaining or exposing its source text. */
export function digestTranscriptEvidenceCandidate(
  candidate: Pick<TranscriptEvidenceCandidate, "ref" | "role" | "text">,
): string {
  return sha256Hex(stableJson({
    ref: candidate.ref,
    role: candidate.role,
    text: candidate.text,
  }))
}

/**
 * Build the bounded, deterministic source candidates shared by prompting and
 * later corroboration. Only user/assistant text is eligible; tool parts,
 * tool output, and audit-session prose are never candidates.
 */
export function buildTranscriptEvidenceCandidates(
  messages: readonly TranscriptMessage[],
): TranscriptEvidenceCandidate[] {
  const seenRefs = new Map<string, number>()
  const candidates: TranscriptEvidenceCandidate[] = []

  for (const message of messages) {
    const normalized = normalizedTextCandidate(message)
    if (!normalized) continue

    const baseRef = makeTranscriptEvidenceRef(message.info.id)
    const occurrence = (seenRefs.get(baseRef) ?? 0) + 1
    seenRefs.set(baseRef, occurrence)
    const ref = occurrence === 1
      ? baseRef
      : `${baseRef}-${occurrence}`.slice(0, MAX_EVIDENCE_REF_CHARS)
    const candidate = {
      ref,
      role: normalized.role,
      text: normalized.text,
    }
    candidates.push({
      ...candidate,
      digest: digestTranscriptEvidenceCandidate(candidate),
    })
  }

  return candidates.slice(-MAX_TRANSCRIPT_MESSAGES)
}

/** Build an ID-indexed candidate map for deterministic corroboration. */
export function buildTranscriptEvidenceCandidateMap(
  messages: readonly TranscriptMessage[],
): TranscriptEvidenceCandidateMap {
  const map: Record<string, TranscriptEvidenceCandidate> = {}
  for (const candidate of buildTranscriptEvidenceCandidates(messages)) {
    map[candidate.ref] = candidate
  }
  return map
}

/** Return only reference digests for privacy-safe logging or persistence. */
export function buildTranscriptEvidenceRefDigestMap(
  messages: readonly TranscriptMessage[],
): Readonly<Record<string, string>> {
  const candidates = buildTranscriptEvidenceCandidateMap(messages)
  const digests: Record<string, string> = {}
  for (const ref of Object.keys(candidates).sort()) {
    digests[ref] = candidates[ref].digest
  }
  return digests
}

/**
 * Keep only labelled text from the last 20 eligible messages. Tool parts and
 * their outputs are deliberately omitted from the transcript sent to the LLM.
 */
export function compressTranscript(messages: readonly TranscriptMessage[]): string {
  return buildTranscriptEvidenceCandidates(messages)
    .map((candidate) => `[${candidate.ref}] [${candidate.role}] ${candidate.text}`)
    .join("\n")
}

/**
 * Extract file-like values from tool inputs. Tool output is never inspected:
 * only paths supplied as tool arguments are candidates.
 */
export function extractFileCandidates(
  messages: readonly TranscriptMessage[],
): string[] {
  const candidates = new Set<string>()

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      const toolName = (part as { tool?: unknown }).tool
      if (typeof toolName !== "string" || !FILE_TOOL_NAMES.has(toolName)) continue

      const state = (part as { state?: unknown }).state
      if (!state || typeof state !== "object") continue
      const input = (state as { input?: unknown }).input
      if (!input || typeof input !== "object") continue

      const values: string[] = []
      const record = input as Record<string, unknown>

      for (const key of ["filePath", "path", "file"]) {
        const value = record[key]
        if (typeof value === "string") values.push(value)
      }

      for (const key of ["paths", "query"]) {
        if (!Array.isArray(record[key])) continue
        for (const value of record[key] as unknown[]) {
          if (typeof value === "string") values.push(value)
        }
      }

      if (typeof record.pattern === "string") values.push(record.pattern)

      if (toolName === "bash" && typeof record.command === "string") {
        for (const match of record.command.matchAll(
          /(?:\.?\/)?(?:[\w.-]+\/)+[\w.-]+\.\w+/g,
        )) {
          values.push(match[0])
        }
      }

      for (const value of values) {
        const normalized = normalizeFileCandidate(value)
        if (normalized) candidates.add(normalized)
      }
    }
  }

  return [...candidates].sort().slice(0, MAX_FILE_CANDIDATES)
}

/** Normalize a tool-provided path and reject known non-file values. */
export function normalizeFileCandidate(value: string): string | null {
  let path = value.trim().replace(/^['"]|['"]$/g, "")
  path = path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/")
  path = path.replace(/[;,]+$/, "")

  if (!path || path.startsWith("-") || path.includes("\0")) return null
  if (path.includes("://") || path.includes("github.com/")) return null
  if (
    path.startsWith("/dev/") ||
    path.startsWith("/usr/") ||
    path.startsWith("/bin/") ||
    path.startsWith("/lib/") ||
    path.startsWith("/etc/") ||
    path.startsWith("/proc/") ||
    path.startsWith("/sys/") ||
    path.startsWith("/tmp/opencode")
  ) {
    return null
  }
  if (path.startsWith("node_modules/") || path.includes("opencode.db")) return null

  // A candidate should look like a file or a source-tree pattern, not a
  // command/search word accidentally supplied in a tool argument.
  const sourcePrefix = ["src/", "test/", "tests/", "docs/", "lib/", "scripts/"]
  if (!/\.\w+(?:$|[/*])/.test(path) && !sourcePrefix.some((prefix) => path.startsWith(prefix))) {
    return null
  }

  return path
}

/** Build the exact canonical payload whose digest identifies extraction input. */
export function serializeCanonicalInput(
  input: Pick<CanonicalExtractionInput, "priorStateJson" | "compressedTranscript" | "fileCandidates">,
): string {
  return stableJson({
    prior_state: input.priorStateJson,
    source_transcript: input.compressedTranscript,
    file_candidates: input.fileCandidates,
  })
}

export function buildCanonicalInput(
  messages: readonly TranscriptMessage[],
  priorState: CacheBearingMemory | MemoryFile | null,
): CanonicalExtractionInput {
  const priorStateJson = capPriorStateJson(
    withoutExtractionCache(priorState as CacheBearingMemory | null),
  )
  const compressedTranscript = compressTranscript(messages)
  const fileCandidates = extractFileCandidates(messages)
  const canonical = serializeCanonicalInput({
    priorStateJson,
    compressedTranscript,
    fileCandidates,
  })

  return {
    priorStateJson,
    compressedTranscript,
    fileCandidates,
    sha256: sha256Hex(canonical),
  }
}

/** Compose the source-session/model-specific cache identity. */
export function makeExtractionCacheKey(
  sourceSessionID: string,
  canonicalInputSha256: string,
  model: { providerID: string; modelID: string },
): string {
  return `${sourceSessionID}:${canonicalInputSha256}:${model.providerID}/${model.modelID}`
}

/**
 * Build the extraction instructions. The SDK-provided structured-output
 * format, not this prompt, defines the response shape.
 */
export function buildExtractionPrompt(input: CanonicalExtractionInput): string {
  return `You are a fact extractor for a coding session. Use the current-session evidence below to produce the values required by the StructuredOutput schema supplied with this request.

The prior STATE.json snapshot is potentially stale context. Return only current-session facts or deltas; do not copy old facts merely because they appear in prior state. Use file candidates as corroborating candidates, not as proof that a file was changed.

Rules:
- current_task: describe what the current session is working on; use null when unclear.
- active_files: must be an array of objects, each exactly \`{ "path": "relative/path", "reason": "short evidence-based reason" }\`; include only files read, edited, or written in this source session; max 5, relative paths; use an empty array if no qualifying files.
- decisions: must be an array of objects, each with required \`{ "topic": "short subject", "decision": "explicit decision", "evidence_refs": ["evidence ID"] }\`; \`evidence_refs\` must contain 1–3 unique IDs copied exactly from the labels in the COMPRESSED SOURCE TRANSCRIPT. Optional \`rationale\` and \`foundational\` must not replace evidence; include only explicit decisions (for example, "let's use X" or "decided to go with Y"); otherwise use an empty array. Do not include discussions, descriptions, or hypothetical decisions.
- blockers: only blockers supported by the current session; otherwise use an empty array.
- next_steps: only next steps stated by the current session; max 5.
- Every decision must cite one to three labelled source-transcript evidence IDs. Cite IDs only, never raw quotes or excerpts.
- Evidence IDs may point only to eligible user/assistant source-text labels in COMPRESSED SOURCE TRANSCRIPT. Never cite prior STATE.json, FILE CANDIDATES, these instructions, model/audit prose, or the model's own response.
- Do not include code snippets, tool outputs, or file contents.
- Do not answer with assistant text or free-form JSON. Return the result through the required StructuredOutput tool.

CAPPED PRIOR STATE.json (potentially stale):
${input.priorStateJson}

COMPRESSED SOURCE TRANSCRIPT:
${input.compressedTranscript || "(none)"}

FILE CANDIDATES:
${input.fileCandidates.join("\n") || "(none)"}`
}
