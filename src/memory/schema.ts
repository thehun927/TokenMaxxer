/**
 * MemoryFile schema — zod definitions for the per-project memory file.
 * Uses M4.5 fields (foundational, last_used_in_session) as additive, optional fields.
 */
import { z } from "zod"
import { ExtractedFactsSchema } from "./extract-schema"

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
  last_used_in_session: z.string().optional(),    // M4.5: set by writer when decision is referenced
})
export type Decision = z.infer<typeof DecisionSchema>

export const ActiveFileSchema = z.object({
  path: z.string(),
  reason: z.string(),
  last_touched: z.string().datetime({ offset: true }).or(z.string()), // ISO 8601
})
export type ActiveFile = z.infer<typeof ActiveFileSchema>

/** A successful structured extraction that can be reused for the same input. */
export const LLMExtractionCacheEntrySchema = z.object({
  cache_key: z.string(),
  source_session_id: z.string(),
  canonical_input_sha256: z.string(),
  provider_id: z.string(),
  model_id: z.string(),
  completed_at: z.string().datetime({ offset: true }).or(z.string()),
  facts: ExtractedFactsSchema,
})
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
})
export type LLMAuditMetadata = z.infer<typeof LLMAuditMetadataSchema>

export const MemoryFileSchema = z.object({
  version: z.literal(2),
  project_path: z.string(),
  last_updated: z.string().datetime({ offset: true }).or(z.string()), // ISO 8601
  last_git_sha: z.string().optional(),
  last_session_id: z.string().optional(),
  current_task: z.string().optional(),
  active_files: z.array(ActiveFileSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  blockers: z.array(z.string()).default([]),
  next_steps: z.array(z.string()).default([]),
  recent_sessions: z.array(z.string()).max(10).default([]),
  llm_extraction_cache: z.array(LLMExtractionCacheEntrySchema).max(10).optional(),
  /** Additive v2 guard metadata; absent in older STATE.json files. */
  llm_extraction_audits: z.array(LLMAuditMetadataSchema).max(20).optional(),
})
export type MemoryFile = z.infer<typeof MemoryFileSchema>

/**
 * Factory for an empty MemoryFile for a given worktree.
 */
export function emptyMemory(worktree: string): MemoryFile {
  return {
    version: 2,
    project_path: worktree,
    last_updated: new Date().toISOString(),
    active_files: [],
    decisions: [],
    blockers: [],
    next_steps: [],
    recent_sessions: [],
  }
}
