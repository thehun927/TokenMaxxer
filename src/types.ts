// Shared types for tokenmaxxer plugin

/** Compaction hook input (confirmed via spike — see docs/journal.md) */
export interface CompactionInput {
  sessionID: string
}

/** Compaction hook output — when prompt is set, context is ignored */
export interface CompactionOutput {
  context: string[]
  prompt?: string
}

/**
 * PR-9 Wave 6 — transient file activity counts by tool category.
 * Only completed tool operations count; errored/pending calls do not.
 * This type is transient and must not enter durable STATE.
 */
export interface FileActivity {
  reads: number
  edits: number
  writes: number
  searches: number
  shellRefs: number
}

/** Full facts extracted from a session transcript by the heuristic extractor. */
export interface HeuristicFacts {
  current_task: string | null
  active_files: { path: string; reason: string }[]
  decisions: { topic: string; decision: string; rationale?: string; foundational?: boolean }[]
  blockers: string[]
  next_steps: string[]
}

/**
 * Backward-compatible name for the pre-PR6 heuristic boundary.
 * Structured LLM extraction uses LLMDecisionFacts instead.
 */
export type ExtractedFacts = HeuristicFacts

/** Plugin options (read from env vars) */
export interface TokenmaxxerOptions {
  /** Compaction mode: "augment" (default) or "replace" */
  compactionMode: "augment" | "replace"
}

/** A session transcript message as returned by client.session.messages() */
export interface TranscriptMessage {
  info: {
    id: string
    role: string
    [key: string]: unknown
  }
  parts: TranscriptPart[]
}

export type TranscriptPart =
  | { type: "text"; text: string; [key: string]: unknown }
  | {
      type: "tool"
      tool: string
      state?: {
        status?: string
        input?: Record<string, unknown>
        output?: string
        error?: string
        [key: string]: unknown
      }
      [key: string]: unknown
    }
  | { type: "step-finish"; tokens?: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } }; [key: string]: unknown }
  | { type: string; [key: string]: unknown }
