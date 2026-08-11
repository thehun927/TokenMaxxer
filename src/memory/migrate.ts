/**
 * Schema migration for MemoryFile.
 * Handles loading raw data from disk and migrating to the current version.
 *
 * This module is deliberately pure: it validates and returns a migrated
 * value, but never writes a migration result or a backup.  The store owns all
 * filesystem behavior and can therefore leave the prior file untouched when
 * this function returns null.
 */
import { createHash } from "node:crypto"
import {
  CacheQuarantineMetadataSchema,
  LLMExtractionCacheEntrySchema,
  MAX_IDENTIFIER,
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
 * PR 3 wave-9/10 (Blocker 2) — deterministic duplicate-decision-ID repair.
 *
 * Pre-PR3 files may contain two rows sharing one `id` because uniqueness was
 * never enforced. Since the stable decision ID is the human-review trust
 * address, a single confirmation token must never be able to upgrade two rows.
 * On load we repair such files deterministically:
 *
 *  - the deterministically-oldest row (timestamp asc, then lexical ID asc) is
 *    the canonical "winner" and KEEPS its old shared ID, so existing lineage
 *    references (`superseded_by` / `conflicts_with` /
 *    `derived_from_decision_id`) to the old ID naturally continue to point at
 *    the canonical winner with no rewrite;
 *  - every other row in a duplicate group receives a deterministic derived ID:
 *    a fixed-length 36-char digest (SHA-256 of the old ID + a stable group
 *    ordinal + a domain separator), chosen over a sequential
 *    `${oldId}-dup-${ordinal}` form because it is always within
 *    `MAX_IDENTIFIER` regardless of legacy ID length and immune to any
 *    characters appearing in a legacy ID;
 *  - an overlong legacy ID (> `MAX_IDENTIFIER`, which pre-wave-9 v3 allowed)
 *    is repaired with the same digest (ordinal 0) so such files still load
 *    instead of being rejected by the v3 ID bound (wave-10 Concern B);
 *  - if ANY row in a duplicate group carries `human_review`, ALL rows in the
 *    group (the canonical winner included) are demoted to
 *    `foundational=false` + `foundational_requested=true` (legacy repair) so
 *    the human must re-confirm against the resolved unique row — one duplicate
 *    is never silently treated as the confirmed review target, and a
 *    deterministic re-read observes the same demotion.
 *
 * Because `loadAndMigrate` is pure (it never persists the migration on a
 * read), the repair MUST be a pure function of the input bytes. No
 * `randomUUID()` may appear here: the same on-disk state must produce the same
 * repaired IDs on every load, or an ID exposed by `decisions`/`recall_decision`
 * could not be acted on by the transaction's `bypassCache: true` re-read.
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

  // old ID -> replacement ID. Only populated when a row's old ID is actually
  // being removed (overlong IDs). For a non-overlong duplicate group the
  // canonical winner preserves the old ID, so references to it need no rewrite.
  const idRewrite = new Map<string, string>()

  for (const [id, group] of byId) {
    const overlong = id.length > MAX_IDENTIFIER
    if (group.length < 2 && !overlong) continue

    // Deterministic order: oldest timestamp asc, then lexical ID asc.
    const sorted = group.slice().sort((a, b) => {
      const ta = Date.parse(typeof a.timestamp === "string" ? a.timestamp : "")
      const tb = Date.parse(typeof b.timestamp === "string" ? b.timestamp : "")
      const aOk = Number.isFinite(ta)
      const bOk = Number.isFinite(tb)
      if (aOk && bOk && ta !== tb) return ta - tb
      if (aOk && !bOk) return -1
      if (!aOk && bOk) return 1
      return String(a.id).localeCompare(String(b.id))
    })
    const winner = sorted[0]!

    if (group.length >= 2 && group.some((row) => row.human_review !== undefined)) {
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

    // Canonical winner keeps its old ID unless that ID is overlong (wave-10
    // Concern B); every non-winner duplicate receives a deterministic derived
    // ID keyed on its stable sorted ordinal within the group.
    sorted.forEach((row, index) => {
      if (row === winner && !overlong) return
      row.id = derivedDecisionId(id, index)
    })

    if (overlong) {
      idRewrite.set(id, String(winner.id))
    }
  }

  if (idRewrite.size === 0) return rows

  // Rewrite lineage references that pointed at a now-removed overlong ID.
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

/**
 * Deterministic derived decision ID for a non-canonical duplicate (or an
 * overlong legacy ID). Returns a fixed-length 36-char UUID-shaped digest of the
 * old ID plus a stable group ordinal, so the result is always within
 * `MAX_IDENTIFIER` regardless of the legacy ID's length or characters.
 */
function derivedDecisionId(oldId: string, ordinal: number): string {
  const ordinalTag = ordinal.toString(36).padStart(2, "0")
  const digest = createHash("sha256")
    .update(`tokenmaxxer-pr3-migrate:v1:${oldId}:${ordinalTag}`)
    .digest("hex")
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
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
 * B1 — quarantine pre-PR6 cache rows on current-v3 documents before final validation.
 * Any llm_extraction_cache row whose extraction_contract_version is missing or !==3
 * is disposable cache payload and must not make semantic STATE unreadable.
 * Do not parse broad facts first; filter purely on contract version.
 * Preserves semantic STATE, revision, processed_sources, and other operational metadata.
 * A contract-3 row that is malformed remains for fail-closed validation.
 */
function quarantineStaleCacheByContractVersion(data: RawRecord): RawRecord {
  if (!Array.isArray(data.llm_extraction_cache)) return data

  const retained: unknown[] = []
  let quarantined = 0

  for (const entry of data.llm_extraction_cache) {
    if (!isRecord(entry)) {
      quarantined++
      continue
    }
    const v = entry.extraction_contract_version
    if (typeof v !== "number" || v !== 3) {
      quarantined++
    } else {
      retained.push(entry)
    }
  }

  if (quarantined === 0) return data

  const result: RawRecord = { ...data }
  if (retained.length > 0) {
    result.llm_extraction_cache = retained
  } else {
    delete result.llm_extraction_cache
  }

  const count = Math.min(
    10_000,
    existingQuarantineCount(data.llm_extraction_cache_quarantine) + quarantined,
  )
  result.llm_extraction_cache_quarantine = {
    count,
    reason: "pre-pr6-cache-contract",
  }

  return result
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

function isCompleteTranscriptLLMProvenance(provenance: RawRecord): boolean {
  const hasAudit = typeof provenance.source_audit_session_id === "string" && provenance.source_audit_session_id.length > 0
  const evidence = provenance.evidence
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 3) return false
  for (const ev of evidence) {
    if (!isRecord(ev) || ev.kind !== "transcript") return false
  }
  return hasAudit
}

/**
 * PR 6 — downgrade decision LLM claims unless complete transcript-only tuple.
 * Retains llm-corroborated only when audit + 1-3 all-transcript evidence present;
 * otherwise downgrades to exact legacy/legacy while preserving stable ID, semantic
 * content, authority/history, and bounded evidence pointers.
 */
function repairIncompleteLLMClaims(decisions: unknown[]): unknown[] {
  return decisions.map((value) => {
    if (!isRecord(value)) return value
    const provenance = isRecord(value.provenance) ? value.provenance : undefined

    // Check if this is an LLM claim that needs repair
    const isLLMClaim = provenance?.extractor === "llm" && provenance?.confidence === "llm-corroborated"
    if (!isLLMClaim) return value

    if (isCompleteTranscriptLLMProvenance(provenance)) return value

    // Incomplete or non-transcript LLM claim - downgrade to exact legacy
    return {
      ...value,
      provenance: {
        ...provenance,
        extractor: "legacy",
        confidence: "legacy",
      },
    }
  })
}

/**
 * PR 6 B3 — downgrade ALL LLM provenance on non-decision state.
 * Regardless of completeness, any current_task_provenance or active_files[]
 * claiming extractor=llm / confidence=llm-corroborated is downgraded to exact
 * legacy/legacy, preserving semantic value/path/reason and bounded evidence pointers.
 * Do not invent heuristic provenance.
 */
function repairIncompleteLLMProvenanceInState(data: RawRecord): RawRecord {
  // Repair active_files — downgrade every LLM claim unconditionally
  if (Array.isArray(data.active_files)) {
    data.active_files = data.active_files.map((file) => {
      if (!isRecord(file)) return file
      const provenance = isRecord(file.provenance) ? file.provenance : undefined
      const isLLMClaim = provenance?.extractor === "llm" && provenance?.confidence === "llm-corroborated"
      if (!isLLMClaim) return file

      return {
        ...file,
        provenance: {
          ...provenance,
          extractor: "legacy",
          confidence: "legacy",
        },
      }
    })
  }

  // Repair current_task_provenance — downgrade every LLM claim unconditionally
  if (isRecord(data.current_task_provenance)) {
    const provenance = data.current_task_provenance
    const isLLMClaim = provenance.extractor === "llm" && provenance.confidence === "llm-corroborated"
    if (isLLMClaim) {
      data.current_task_provenance = {
        ...provenance,
        extractor: "legacy",
        confidence: "legacy",
      }
    }
  }

  return data
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

  // B1 — pre-PR6 cache contract quarantine for current-v3 documents (including PR5-era v3 broad rows).
  // Must run before final schema validation and before any parsing of broad facts.
  data = quarantineStaleCacheByContractVersion(data)

  // PR 3 §5 — repair pre-PR3 unverified human-review claims before v3
  // validation so they validate cleanly as legacy + foundational_requested.
  if (Array.isArray(data.decisions)) {
    data = {
      ...data,
      decisions: repairUnverifiedHumanClaims(data.decisions),
    }
  }

  // PR 3 wave-9/10 (Blocker 2) — repair duplicate decision IDs before the v3
  // schema's uniqueness invariant rejects the file. The repair is a pure,
  // deterministic function of the input bytes (the canonical oldest row keeps
  // its old ID; non-winners receive deterministic derived IDs; overlong legacy
  // IDs are re-identified to the v3 bound), so every read-only load produces
  // the same repaired IDs and lineage references.
  if (Array.isArray(data.decisions)) {
    data = {
      ...data,
      decisions: repairDuplicateDecisionIds(data.decisions),
    }
  }

  // PR 6 Wave 5 — repair incomplete LLM trust claims before v3 validation
  // so they validate cleanly as legacy provenance.
  if (Array.isArray(data.decisions)) {
    data = {
      ...data,
      decisions: repairIncompleteLLMClaims(data.decisions),
    }
  }

  // PR 6 Wave 5 — repair incomplete LLM provenance in active_files and current_task
  data = repairIncompleteLLMProvenanceInState(data)

  const parsed = MemoryFileSchema.safeParse(data)
  if (!parsed.success) {
    // Corrupt or invalid shape — return null.  In particular, no caller can
    // mistake a failed migration for permission to overwrite the old state.
    return null
  }
  return parsed.data
}
