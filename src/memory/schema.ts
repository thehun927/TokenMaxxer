/**
 * MemoryFile schema — zod definitions for the per-project memory file.
 *
 * Version 3 adds bounded provenance to durable facts.  Provenance contains
 * references and digests only; source text is deliberately not part of this
 * schema.
 */
import { z } from "zod"
import { LLMDecisionFactsSchema } from "./extract-schema"
export { LLMDecisionFactsSchema } from "./extract-schema"

export const MAX_IDENTIFIER = 256
const MAX_REFERENCE = 128
const MAX_CACHE_QUARANTINE_COUNT = 10_000
export const MAX_MODEL_HEALTH_RECORDS = 10
export const MAX_PROCESSED_SOURCES = 10

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

/**
 * Proof that the trusted human-review boundary was crossed interactively.
 * Deliberately minimal: no OS usernames, terminal contents, commands, or
 * prompts. `reviewed_at` is bounded to match the project's string-length
 * pattern.
 */
export const HumanReviewSchema = z
  .object({
    channel: z.literal("interactive-cli"),
    reviewed_at: z.string().datetime({ offset: true }).max(64).or(z.string().max(64)),
  })
  .strict()
export type HumanReview = z.infer<typeof HumanReviewSchema>

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
  .superRefine((provenance, ctx) => {
    // PR-6 Wave 6: Enforce extractor/confidence pairing contract
    // extractor=llm must pair with confidence=llm-corroborated
    // extractor=heuristic must pair with confidence=heuristic
    // extractor=human must pair with confidence=human-reviewed
    // extractor=legacy has no pairing requirement
    const { extractor, confidence } = provenance

    if (extractor === "llm" && confidence !== "llm-corroborated") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confidence"],
        message: "extractor=llm must pair with confidence=llm-corroborated",
      })
    }

    if (extractor === "heuristic" && confidence !== "heuristic") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confidence"],
        message: "extractor=heuristic must pair with confidence=heuristic",
      })
    }

    if (extractor === "human" && confidence !== "human-reviewed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confidence"],
        message: "extractor=human must pair with confidence=human-reviewed",
      })
    }

    // PR-6 Wave 6: LLM provenance requires source_audit_session_id and 1-3 evidence entries
    if (extractor === "llm" && confidence === "llm-corroborated") {
      if (!provenance.source_audit_session_id || provenance.source_audit_session_id.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["source_audit_session_id"],
          message: "LLM provenance requires non-empty source_audit_session_id",
        })
      }
      if (!provenance.evidence || provenance.evidence.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidence"],
          message: "LLM provenance requires at least 1 evidence entry",
        })
      }
      if (provenance.evidence.length > 3) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidence"],
          message: "LLM provenance evidence must have at most 3 entries",
        })
      }
    }
  })
export type Provenance = z.infer<typeof ProvenanceSchema>

export const DecisionSchema = z.object({
  // PR 3 wave-9 (Blocker 2): the stable decision ID is the trust address for
  // human review, so it shares the same identifier contract as the lineage
  // fields (`superseded_by`, `conflicts_with`, `derived_from_decision_id`).
  id: z.string().min(1).max(MAX_IDENTIFIER),
  topic: z.string(),
  decision: z.string(),
  rationale: z.string().optional(),
  timestamp: z.string().datetime({ offset: true }).or(z.string()), // ISO 8601
  git_sha: z.string().optional(),
  session_id: z.string(),
  still_valid: z.boolean().default(true),
  foundational: z.boolean().default(false),         // confirmed retention intent (human-reviewed state)
  foundational_requested: z.boolean().default(false), // Human promotion request; not a promotion itself.
  last_used_in_session: z.string().optional(),    // M4.5: set by writer when decision is referenced
  human_review: HumanReviewSchema.optional(),       // proof the trusted review boundary was crossed
  superseded_by: z.string().max(MAX_IDENTIFIER).optional(), // historical lineage for a deliberate replacement
  conflicts_with: z.array(z.string().max(MAX_IDENTIFIER)).max(8).optional(), // candidate/history disagreeing with protected authorities
  derived_from_decision_id: z.string().max(MAX_IDENTIFIER).optional(), // explicit human supersession lineage
  /**
   * PR 3 wave-9 (Blocker 1) — durable unresolved-human-conflict marker.
   *
   * The read view sets this on every trusted-human row inside a
   * `conflicting-human-foundational` topic. The write path persists it so the
   * next read can reconstruct the conflict even though those rows have been
   * reconciled to `still_valid=false`. Additive with a default so pre-PR3
   * STATE files continue to load.
   */
  human_conflict_quarantined: z.boolean().default(false),
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

/**
 * Compact durable completion ledger entry for a processed source.
 * Stores only the identity of a successfully extracted source, not the
 * transcript, prompt, response, or any other content.
 */
export const ProcessedSourceSchema = z.object({
  source_key: z.string().regex(/^v2s:[a-f0-9]{64}$/),
  extraction_key: z.string().regex(/^v2e:[a-f0-9]{64}$/),
  extraction_contract_version: z.number().int().positive().max(10_000),
  completed_at: z.string().datetime({ offset: true }).or(z.string().max(128)),
}).strict()
export type ProcessedSource = z.infer<typeof ProcessedSourceSchema>

/**
 * Decisions-only LLM facts for cache payload (Wave 5).
 * The cache stores only decisions, not full heuristic ExtractedFacts.
 * Non-decision fields (current_task, active_files, blockers, next_steps) are
 * derived from base state on cache hit, not replayed from cache.
 */
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
  /** Wave 5: decisions-only facts payload; never full heuristic ExtractedFacts. */
  facts: LLMDecisionFactsSchema,
  /** PR 5 Wave 3: optional source identity fields for backward compatibility. */
  source_key: z.string().optional(),
  source_input_sha256: z.string().optional(),
  prompt_input_sha256: z.string().optional(),
  extraction_contract_version: z.number().int().positive().max(10_000).optional(),
  model_variant: z.string().optional(),
})
/**
 * Wave 5: Cache entry facts type is decisions-only LLM facts.
 * The type alias maintains compatibility with the extraction contract.
 */
export type LLMExtractionCacheEntry = z.infer<typeof LLMExtractionCacheEntrySchema>

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
  /** PR 5 Wave 3: optional source identity fields for backward compatibility. */
  source_key: z.string().optional(),
  source_input_sha256: z.string().optional(),
  prompt_input_sha256: z.string().optional(),
  extraction_contract_version: z.number().int().positive().max(10_000).optional(),
  model_variant: z.string().optional(),
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
  /** PR 5 Wave 3: compact processed-source completion ledger; optional with default for backward compatibility. */
  processed_sources: z.array(ProcessedSourceSchema).max(MAX_PROCESSED_SOURCES).default([]),
})

/**
 * v3 validation also makes the evidence-backed cache boundary explicit.  The
 * entry schema remains constructible by the pre-v3 extraction code, while a
 * complete MemoryFile cannot expose an unproven cache hit.
 */
/**
 * Stable issue codes for the decision trust invariants so callers can branch
 * on them programmatically.
 */
export const DECISION_TRUST_ISSUE = "decision-trust-invariant"
export const DECISION_LINEAGE_ISSUE = "decision-lineage-invariant"
/**
 * Stable issue code for the wave-9 duplicate-decision-ID persistence
 * invariant. Callers (migration repair, defensive exact-ID helpers) branch on
 * this to distinguish "ambiguous ID" from other validation failures.
 */
export const DUPLICATE_DECISION_ID = "DUPLICATE_DECISION_ID"

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

  // PR 3 §4.1 — decision trust + lineage invariants. A human trust claim must
  // be self-consistent, and malformed lineage is rejected.
  for (const [index, decision] of memory.decisions.entries()) {
    const path = (field: string) => ["decisions", index, field]

    const claimsHumanTrust =
      decision.provenance?.extractor === "human" ||
      decision.provenance?.confidence === "human-reviewed" ||
      decision.human_review !== undefined

    if (claimsHumanTrust) {
      const trustOk =
        decision.foundational === true &&
        decision.provenance?.extractor === "human" &&
        decision.provenance?.confidence === "human-reviewed" &&
        decision.human_review?.channel === "interactive-cli"

      if (!trustOk) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: path("provenance"),
          message:
            "a human trust claim requires foundational=true, extractor=human, " +
            "confidence=human-reviewed, and human_review.channel=interactive-cli",
        })
      }
    }

    // Malformed lineage: a decision cannot supersede or conflict with itself.
    if (decision.superseded_by === decision.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: path("superseded_by"),
        message: "a decision cannot supersede itself",
      })
    }

    if (decision.conflicts_with?.includes(decision.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: path("conflicts_with"),
        message: "a decision cannot conflict with itself",
      })
    }

    if (decision.conflicts_with) {
      const seen = new Set<string>()
      for (const id of decision.conflicts_with) {
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path("conflicts_with"),
            message: `duplicate conflict id: ${id}`,
          })
        }
        seen.add(id)
      }
    }
  }

  // PR 3 wave-9 (Blocker 2) — decision IDs must be unique. The stable ID is the
  // human-review trust address, so a single confirmation token must never be
  // able to upgrade two different rows. This is a persistence invariant, not a
  // convention: legacy duplicate-ID files are repaired by `loadAndMigrate`
  // before this rule is consulted.
  const seenDecisionIds = new Set<string>()
  for (const [index, decision] of memory.decisions.entries()) {
    if (seenDecisionIds.has(decision.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisions", index, "id"],
        params: { issue: DUPLICATE_DECISION_ID },
        message: `duplicate decision id: ${decision.id}`,
      })
    }
    seenDecisionIds.add(decision.id)
  }
})

/**
 * The input type intentionally allows the existing in-memory writer shape.
 * `loadAndMigrate` returns only data that passed the strict v3 output schema.
 */
export type MemoryFile = Omit<
  z.input<typeof MemoryFileBaseSchema>,
  | "version"
  | "revision"
  | "active_files"
  | "decisions"
  | "blockers"
  | "next_steps"
  | "recent_sessions"
  | "llm_extraction_cache"
  | "processed_sources"
> & {
  version: number
  revision: number
  active_files: ActiveFile[]
  decisions: Decision[]
  blockers: string[]
  next_steps: string[]
  recent_sessions: string[]
  llm_extraction_cache?: LLMExtractionCacheEntry[]
  processed_sources: ProcessedSource[]
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
    processed_sources: [],
  }
}
