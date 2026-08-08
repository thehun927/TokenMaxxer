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

/** Facts extracted from a session transcript by the heuristic extractor */
export interface ExtractedFacts {
  current_task: string | null
  active_files: { path: string; reason: string }[]
  decisions: { topic: string; decision: string; rationale?: string; foundational?: boolean }[]
  blockers: string[]
  next_steps: string[]
}

/** Plugin options (read from env vars; future: opencode.json "tokenmaxxer" key) */
export interface TokenmaxxerOptions {
  /** Kill switch for compaction prompt replacement. false = inject durable block via context only. */
  compactionPrompt: boolean
  /** Header injection mechanism: "instructions" (documented) or "system_transform" (experimental) */
  headerInjection: "instructions" | "system_transform"
  /** Memory isolation key: "worktree" (default, single-repo) or "directory" (monorepo sub-packages) */
  memoryKey: "worktree" | "directory"
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
  | { type: "tool"; tool: string; input: Record<string, unknown>; output?: { state?: { status?: string }; [key: string]: unknown }; [key: string]: unknown }
  | { type: "step-finish"; tokens?: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } }; [key: string]: unknown }
  | { type: string; [key: string]: unknown }