/**
 * Schema migration for MemoryFile.
 * Handles loading raw data from disk and migrating to the current version.
 *
 * This module is deliberately pure: it validates and returns a migrated
 * value, but never writes a migration result or a backup.  The store owns all
 * filesystem behavior and can therefore leave the prior file untouched when
 * this function returns null.
 */
import {
  CacheQuarantineMetadataSchema,
  LLMExtractionCacheEntrySchema,
  MemoryFileSchema,
  type MemoryFile,
  type Provenance,
} from "./schema"

const CURRENT_VERSION = 3
const LEGACY_SOURCE_SESSION = "legacy"

type RawRecord = Record<string, unknown>

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Keep a legacy identifier usable without allowing it to defeat v3 bounds. */
function legacySourceSession(value: unknown): string {
  const source = nonEmptyString(value)
  if (!source) return LEGACY_SOURCE_SESSION
  return source.slice(0, 256)
}

function legacyProvenance(sourceSessionID: unknown): Provenance {
  return {
    extractor: "legacy",
    source_session_id: legacySourceSession(sourceSessionID),
    confidence: "legacy",
    evidence: [],
  }
}

function hasOwn(record: RawRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/**
 * Add legacy provenance to a pre-v3 fact.  Existing evidence/provenance is
 * not trusted because it was not governed by the v3 contract; importantly,
 * this never invents an evidence reference or digest.
 */
function migrateDecision(value: unknown, fallbackSource: unknown): unknown {
  if (!isRecord(value)) return value
  return {
    ...value,
    foundational_requested: hasOwn(value, "foundational_requested")
      ? value.foundational_requested
      : false,
    provenance: legacyProvenance(value.session_id ?? fallbackSource),
  }
}

function migrateActiveFile(value: unknown, fallbackSource: unknown): unknown {
  if (!isRecord(value)) return value
  return {
    ...value,
    provenance: legacyProvenance(fallbackSource),
  }
}

function migrateCurrentTask(data: RawRecord, fallbackSource: unknown): RawRecord {
  if (typeof data.current_task !== "string") return data
  return {
    ...data,
    // Keep current_task as the existing string for old readers.  Provenance is
    // additive rather than a replacement object/union.
    current_task_provenance: legacyProvenance(fallbackSource),
  }
}

function isEvidenceBackedCacheEntry(value: unknown): value is RawRecord {
  if (!isRecord(value)) return false
  const parsed = LLMExtractionCacheEntrySchema.safeParse(value)
  if (!parsed.success) return false

  const provenance = parsed.data.provenance
  return Boolean(
    provenance &&
      provenance.extractor === "llm" &&
      provenance.confidence === "llm-corroborated" &&
      provenance.source_audit_session_id &&
      provenance.evidence.length > 0,
  )
}

function existingQuarantineCount(value: unknown): number {
  const parsed = CacheQuarantineMetadataSchema.safeParse(value)
  return parsed.success ? parsed.data.count : 0
}

/**
 * Drop cache rows that cannot be evidence-backed v3 hits.  Only a bounded
 * count and a non-sensitive reason survive.  This is applied while migrating
 * v2.  A malformed v3 cache row is rejected by MemoryFileSchema instead of
 * being silently rewritten as a different v3 document.
 */
function quarantineUnprovenCache(data: RawRecord): RawRecord {
  if (!Array.isArray(data.llm_extraction_cache)) return data

  const retained = data.llm_extraction_cache.filter(isEvidenceBackedCacheEntry)
  const quarantined = data.llm_extraction_cache.length - retained.length
  const result: RawRecord = { ...data }

  if (retained.length > 0) {
    result.llm_extraction_cache = retained
  } else {
    delete result.llm_extraction_cache
  }

  if (quarantined > 0) {
    const count = Math.min(
      10_000,
      existingQuarantineCount(data.llm_extraction_cache_quarantine) + quarantined,
    )
    result.llm_extraction_cache_quarantine = {
      count,
      reason: "missing-evidence-backed-provenance",
    }
  }

  return result
}

/** Migrate the v1 shape that predated recent_sessions to v2. */
function migrateV1ToV2(data: RawRecord): RawRecord {
  return {
    ...data,
    version: 2,
    recent_sessions: hasOwn(data, "recent_sessions") ? data.recent_sessions : [],
  }
}

/** Add v3 provenance without changing the meaning of any existing fact. */
function migrateV2ToV3(data: RawRecord): RawRecord {
  const fallbackSource = data.last_session_id
  const withFacts: RawRecord = {
    ...data,
    version: CURRENT_VERSION,
    active_files: Array.isArray(data.active_files)
      ? data.active_files.map((file) => migrateActiveFile(file, fallbackSource))
      : data.active_files,
    decisions: Array.isArray(data.decisions)
      ? data.decisions.map((decision) => migrateDecision(decision, fallbackSource))
      : data.decisions,
  }

  return quarantineUnprovenCache(migrateCurrentTask(withFacts, fallbackSource))
}

/**
 * Load a raw parsed JSON value and migrate it to the current MemoryFile schema.
 * Returns null for invalid/corrupt data, unknown versions, or missing version.
 * No filesystem operation is performed on either success or failure.
 */
export function loadAndMigrate(raw: unknown): MemoryFile | null {
  if (raw === null || raw === undefined) return null
  if (!isRecord(raw)) return null

  const version = raw.version
  if (typeof version !== "number" || !Number.isInteger(version)) return null

  let data: RawRecord = raw
  if (version === 1) {
    data = migrateV1ToV2(data)
  }
  if (data.version === 2) {
    data = migrateV2ToV3(data)
  }
  if (data.version !== CURRENT_VERSION) return null

  const parsed = MemoryFileSchema.safeParse(data)
  if (!parsed.success) {
    // Corrupt or invalid shape — return null.  In particular, no caller can
    // mistake a failed migration for permission to overwrite the old state.
    return null
  }
  return parsed.data
}
