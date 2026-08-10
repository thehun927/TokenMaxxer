/**
 * MemoryFile schema — zod definitions for the per-project memory file.
 *
 * Version 3 adds bounded provenance to durable facts.  Provenance contains
 * references and digests only; source text is deliberately not part of this
 * schema.
 */
import { z } from "zod"
import { ExtractedFactsSchema } from "./extract-schema"
import type { ExtractedFacts as LegacyExtractedFacts } from "../types"

const MAX_IDENTIFIER = 256
const MAX_REFERENCE = 128
const MAX_CACHE_QUARANTINE_COUNT = 10_000
export const MAX_MODEL_HEALTH_RECORDS = 10

/** The two kinds of source material an extractor may point at. */
export const EvidenceKindSchema = z.enum(["transcript", "heuristic-candidate"])
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>

/** A bounded pointer to source material.  It never contains the material. */
export const EvidenceSchema = z
  .object({
    kind: EvidenceKindSchema,
    ref: z.string().min(1).max(MAX_REFERENCE),
    digest: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict()
export type Evidence = z.infer<typeof EvidenceSchema>

export const ExtractorSchema = z.enum(["heuristic", "llm", "human", "legacy"])
export type Extractor = z.infer<typeof ExtractorSchema>

export const ConfidenceSchema = z.enum([
  "heuristic",
  "llm-corroborated",
  "human-reviewed",
  "legacy",
])
export type Confidence = z.infer<typeof ConfidenceSchema>

/** Provenance shared by decisions, files, and current-task state. */
export const ProvenanceSchema = z
  .object({
    extractor: ExtractorSchema,
    source_session_id: z.string().min(1).max(MAX_IDENTIFIER),
    source_audit_session_id: z.string().min(1).max(MAX_IDENTIFIER).optional(),
    confidence: ConfidenceSchema,
    evidence: z.array(EvidenceSchema).max(3).default([]),
  })
  .strict()
export type Provenance = z.infer<typeof ProvenanceSchema>

export const DecisionSchema = z.object({
  id: z.string(),
  topic: z.string(),
  decision: z.string(),
  rationale: z.string().optional(),
  timestamp: z.string().datetime({ offset: true }).or(z.string()), // ISO 8601
  git_sha: z.string().optional(),
  session_id: z.string(),
  still_valid: z.boolean().default(true),
  foundational: z.boolean().optional(),             // M4.5: promoted by model or auto-detected (undefined = false)
  foundational_requested: z.boolean().default(false), // Human promotion request; not a promotion itself.
  last_used_in_session: z.string().optional(),    // M4.5: set by writer when decision is referenced
  provenance: ProvenanceSchema,
})

/**
 * The input type intentionally keeps provenance additive for the existing
 * writer.  Disk reads are still checked by DecisionSchema, and migrations add
 * the required legacy record before returning a MemoryFile.
 */
export type Decision = Omit<z.input<typeof DecisionSchema>, "provenance"> & {
  provenance?: Provenance
}

export const ActiveFileSchema = z.object({
  path: z.string(),
  reason: z.string(),
  last_touched: z.string().datetime({ offset: true }).or(z.string()), // ISO 8601
  provenance: ProvenanceSchema,
})

export type ActiveFile = Omit<z.input<typeof ActiveFileSchema>, "provenance"> & {
  provenance?: Provenance
}

/** A bounded per-provider/model outcome record for future health consumers. */
export const ModelHealthOutcomeSchema = z.enum([
  "success",
  "structured-shape-failure",
  "validation-failure",
  "transport-auth-failure",
  "timeout",
])
export type ModelHealthOutcome = z.infer<typeof ModelHealthOutcomeSchema>

export const ModelHealthSchema = z.object({
  provider_id: z.string().min(1).max(MAX_IDENTIFIER),
  model_id: z.string().min(1).max(MAX_IDENTIFIER),
  last_outcome: ModelHealthOutcomeSchema,
  failure_streak: z.number().int().min(0).max(32).default(0),
  last_outcome_at: z.string().datetime({ offset: true }).or(z.string().max(128)).optional(),
  cooldown_until: z.string().datetime({ offset: true }).or(z.string().max(128)).optional(),
  failure_reason: z.string().max(MAX_REFERENCE).optional(),
})
export type ModelHealth = z.infer<typeof ModelHealthSchema>

/**
 * Only bounded operational metadata is retained for quarantined cache rows.
 * Cache payloads themselves are intentionally dropped.
 */
export const CacheQuarantineMetadataSchema = z.object({
  count: z.number().int().min(0).max(MAX_CACHE_QUARANTINE_COUNT),
  reason: z.string().max(MAX_REFERENCE).optional(),
})
export type CacheQuarantineMetadata = z.infer<typeof CacheQuarantineMetadataSchema>

/** A successful structured extraction that can be reused for the same input. */
export const LLMExtractionCacheEntrySchema = z.object({
  cache_key: z.string(),
  source_session_id: z.string(),
  canonical_input_sha256: z.string(),
  provider_id: z.string(),
  model_id: z.string(),
  completed_at: z.string().datetime({ offset: true }).or(z.string()),
  /** Required for an evidence-backed v3 cache hit; optional for construction by the pre-v3 writer. */
  provenance: ProvenanceSchema.optional(),
  facts: ExtractedFactsSchema,
})
/**
 * Keep the exported construction type compatible with the pre-v3 extractor
 * while the disk schema validates the newer structured-facts shape.
 */
export type LLMExtractionCacheEntry = Omit<
  z.infer<typeof LLMExtractionCacheEntrySchema>,
  "facts"
> & { facts: LegacyExtractedFacts }

/**
 * Bounded durable guard information for a retained extraction session.
 *
 * This is deliberately operational metadata only.  It does not contain a
 * transcript, prompt, response, or provenance claim.  `pending` is used while
 * the audit session exists but before extraction has reached a terminal
 * outcome; keeping that record is what prevents an audit idle event from
 * re-entering after a reload.
 */
export const AuditTerminalOutcomeSchema = z.enum(["pending", "success", "failed"])
export type AuditTerminalOutcome = z.infer<typeof AuditTerminalOutcomeSchema>

export const LLMAuditMetadataSchema = z.object({
  audit_session_id: z.string().max(256),
  source_session_id: z.string().max(256),
  cache_key: z.string().max(512),
  provider_id: z.string().max(256),
  model_id: z.string().max(256),
  created_at: z.string().datetime({ offset: true }).or(z.string().max(128)),
  terminal_outcome: AuditTerminalOutcomeSchema,
})
export type LLMAuditMetadata = z.infer<typeof LLMAuditMetadataSchema>

const MemoryFileBaseSchema = z.object({
  version: z.literal(3),
  /** Monotonic logical freshness signal. Additive: existing STATE files load with revision 0. */
  revision: z.number().int().nonnegative().default(0),
  project_path: z.string(),
  last_updated: z.string().datetime({ offset: true }).or(z.string()), // ISO 8601
  last_git_sha: z.string().optional(),
  last_session_id: z.string().optional(),
  current_task: z.string().optional(),
  current_task_provenance: ProvenanceSchema.optional(),
  active_files: z.array(ActiveFileSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  blockers: z.array(z.string()).default([]),
  next_steps: z.array(z.string()).default([]),
  recent_sessions: z.array(z.string()).max(10).default([]),
  llm_extraction_cache: z.array(LLMExtractionCacheEntrySchema).max(10).optional(),
  /** Additive v2 guard metadata; absent in older STATE.json files. */
  llm_extraction_audits: z.array(LLMAuditMetadataSchema).max(20).optional(),
  /** Bounded local provider/model health records used by extraction gating. */
  model_health: z.array(ModelHealthSchema).max(MAX_MODEL_HEALTH_RECORDS).optional(),
  /** Count/reason only; quarantined cache payloads are never retained. */
  llm_extraction_cache_quarantine: CacheQuarantineMetadataSchema.optional(),
})

/**
 * v3 validation also makes the evidence-backed cache boundary explicit.  The
 * entry schema remains constructible by the pre-v3 extraction code, while a
 * complete MemoryFile cannot expose an unproven cache hit.
 */
export const MemoryFileSchema = MemoryFileBaseSchema.superRefine((memory, ctx) => {
  for (const [index, entry] of (memory.llm_extraction_cache ?? []).entries()) {
    const provenance = entry.provenance
    if (
      !provenance ||
      provenance.extractor !== "llm" ||
      provenance.confidence !== "llm-corroborated" ||
      !provenance.source_audit_session_id ||
      provenance.evidence.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["llm_extraction_cache", index, "provenance"],
        message: "cache entry lacks evidence-backed provenance",
      })
    }
  }
})

/**
 * The input type intentionally allows the existing in-memory writer shape.
 * `loadAndMigrate` returns only data that passed the strict v3 output schema.
 */
export type MemoryFile = Omit<
  z.input<typeof MemoryFileBaseSchema>,
  | "version"
  | "active_files"
  | "decisions"
  | "blockers"
  | "next_steps"
  | "recent_sessions"
  | "llm_extraction_cache"
> & {
  version: number
  active_files: ActiveFile[]
  decisions: Decision[]
  blockers: string[]
  next_steps: string[]
  recent_sessions: string[]
  llm_extraction_cache?: LLMExtractionCacheEntry[]
}

/**
 * Factory for an empty MemoryFile for a given worktree.
 */
export function emptyMemory(worktree: string): MemoryFile {
  return {
    version: 3,
    revision: 0,
    project_path: worktree,
    last_updated: new Date().toISOString(),
    active_files: [],
    decisions: [],
    blockers: [],
    next_steps: [],
    recent_sessions: [],
  }
}
