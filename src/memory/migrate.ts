/**
 * Schema migration for MemoryFile.
 * Handles loading raw data from disk and migrating to the current version.
 *
 * This module is deliberately pure: it validates and returns a migrated
 * value, but never writes a migration result or a backup.  The store owns all
 * filesystem behavior and can therefore leave the prior file untouched when
 * this function returns null.
 */
import { randomUUID } from "node:crypto"
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

/**
 * PR 3 §5 — conservatively reclassify pre-PR3 unverified human-review claims.
 *
 * Before PR 3 the model-callable promotion path could mint `extractor="human"` /
 * `confidence="human-reviewed"` provenance without an explicit interactive
 * human-review record. Such rows cannot be trusted as proof of human action, so
 * on load we downgrade them to `legacy` provenance and mark them
 * `foundational_requested=true` for re-confirmation. This runs in memory only;
 * it persists naturally on the next successful STATE mutation.
 */
function repairUnverifiedHumanClaims(decisions: unknown[]): unknown[] {
  return decisions.map((value) => {
    if (!isRecord(value)) return value
    const provenance = isRecord(value.provenance) ? value.provenance : undefined
    const claimsHumanTrust =
      provenance?.extractor === "human" || provenance?.confidence === "human-reviewed"
    if (!claimsHumanTrust || hasOwn(value, "human_review")) return value

    return {
      ...value,
      foundational: false,
      foundational_requested: true,
      provenance: {
        ...provenance,
        extractor: "legacy",
        confidence: "legacy",
      },
    }
  })
}

function migrateActiveFile(value: unknown, fallbackSource: unknown): unknown {
  if (!isRecord(value)) return value
  return {
    ...value,
    provenance: legacyProvenance(fallbackSource),
  }
}

/**
 * PR 3 wave-9 (Blocker 2) — deterministic duplicate-decision-ID repair.
 *
 * Pre-PR3 files may contain two rows sharing one `id` because uniqueness was
 * never enforced. Since the stable decision ID is the human-review trust
 * address, a single confirmation token must never be able to upgrade two rows.
 * On load we repair such files deterministically:
 *
 *  - every row in a duplicate-ID group receives a fresh UUID v4 `id`, keeping
 *    its semantic fields (topic/decision/rationale/evidence/session);
 *  - the deterministically-oldest row (timestamp asc, then lexical ID asc) is
 *    the canonical "winner";
 *  - any `superseded_by` / `conflicts_with` / `derived_from_decision_id`
 *    reference that pointed at the old shared ID is rewritten to point at the
 *    winner's fresh ID;
 *  - if ANY row in the group carries `human_review`, ALL rows in the group are
 *    demoted to `foundational=false` + `foundational_requested=true` (legacy
 *    repair) so the human must re-confirm against the resolved unique row —
 *    one duplicate is never silently treated as the confirmed review target.
 */
function repairDuplicateDecisionIds(decisions: unknown[]): unknown[] {
  const rows = decisions.map((value) => (isRecord(value) ? { ...value } : value))

  const byId = new Map<string, RawRecord[]>()
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = row.id
    if (typeof id !== "string" || id.length === 0) continue
    const group = byId.get(id)
    if (group) group.push(row)
    else byId.set(id, [row])
  }

  const idRewrite = new Map<string, string>()

  for (const [id, group] of byId) {
    if (group.length < 2) continue

    // Deterministic winner: oldest timestamp asc, then lexical ID asc.
    const winner = group.slice().sort((a, b) => {
      const ta = Date.parse(typeof a.timestamp === "string" ? a.timestamp : "")
      const tb = Date.parse(typeof b.timestamp === "string" ? b.timestamp : "")
      const aOk = Number.isFinite(ta)
      const bOk = Number.isFinite(tb)
      if (aOk && bOk && ta !== tb) return ta - tb
      if (aOk && !bOk) return -1
      if (!aOk && bOk) return 1
      return String(a.id).localeCompare(String(b.id))
    })[0]!

    for (const row of group) {
      row.id = randomUUID()
    }
    idRewrite.set(id, String(winner.id))

    if (group.some((row) => row.human_review !== undefined)) {
      for (const row of group) {
        row.foundational = false
        row.foundational_requested = true
        delete row.human_review
        // A surviving human trust claim would violate the v3 human-trust
        // invariant (foundational must be true), so rows that carried human
        // provenance are downgraded to legacy; non-human rows keep their
        // evidence-backed provenance.
        if (
          isRecord(row.provenance) &&
          (row.provenance.extractor === "human" || row.provenance.confidence === "human-reviewed")
        ) {
          row.provenance = {
            ...row.provenance,
            extractor: "legacy",
            confidence: "legacy",
          }
        }
      }
    }
  }

  if (idRewrite.size === 0) return rows

  // Rewrite lineage references that pointed at a now-removed duplicate ID.
  for (const row of rows) {
    if (!isRecord(row)) continue
    for (const field of ["superseded_by", "derived_from_decision_id"] as const) {
      const value = row[field]
      if (typeof value === "string" && idRewrite.has(value)) {
        row[field] = idRewrite.get(value)
      }
    }
    if (Array.isArray(row.conflicts_with)) {
      row.conflicts_with = row.conflicts_with.map((ref) => {
        if (typeof ref !== "string" || !idRewrite.has(ref)) return ref
        return idRewrite.get(ref)
      })
    }
  }

  return rows
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

  // PR 3 §5 — repair pre-PR3 unverified human-review claims before v3
  // validation so they validate cleanly as legacy + foundational_requested.
  if (Array.isArray(data.decisions)) {
    data = {
      ...data,
      decisions: repairUnverifiedHumanClaims(data.decisions),
    }
  }

  // PR 3 wave-9 (Blocker 2) — repair duplicate decision IDs before the v3
  // schema's uniqueness invariant rejects the file. Fresh IDs are assigned to
  // every duplicate and lineage references are rewritten to the canonical
  // (deterministically-oldest) row.
  if (Array.isArray(data.decisions)) {
    data = {
      ...data,
      decisions: repairDuplicateDecisionIds(data.decisions),
    }
  }

  const parsed = MemoryFileSchema.safeParse(data)
  if (!parsed.success) {
    // Corrupt or invalid shape — return null.  In particular, no caller can
    // mistake a failed migration for permission to overwrite the old state.
    return null
  }
  return parsed.data
}
