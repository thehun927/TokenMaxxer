/**
 * MemoryFile schema — zod definitions for the per-project memory file.
 * Uses M4.5 fields (foundational, last_used_in_session) as additive, optional fields.
 */
import { z } from "zod"

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

export const MemoryFileSchema = z.object({
  version: z.literal(1),
  project_path: z.string(),
  last_updated: z.string().datetime({ offset: true }).or(z.string()), // ISO 8601
  last_git_sha: z.string().optional(),
  last_session_id: z.string().optional(),
  current_task: z.string().optional(),
  active_files: z.array(ActiveFileSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  blockers: z.array(z.string()).default([]),
  next_steps: z.array(z.string()).default([]),
})
export type MemoryFile = z.infer<typeof MemoryFileSchema>

/**
 * Factory for an empty MemoryFile for a given worktree.
 */
export function emptyMemory(worktree: string): MemoryFile {
  return {
    version: 1,
    project_path: worktree,
    last_updated: new Date().toISOString(),
    active_files: [],
    decisions: [],
    blockers: [],
    next_steps: [],
  }
}
