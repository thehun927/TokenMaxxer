/**
 * Diagnostic artifact type definitions.
 *
 * Wave 2: Typed results for artifact read/write operations.
 */

/**
 * Artifact name (explicit contract §3).
 * Must be the exact filenames: last_compaction_prompt.log, last_compaction_result.json
 */
export type DiagnosticArtifactName = "last_compaction_prompt.log" | "last_compaction_result.json"

/**
 * Artifact write result (typed contract §3).
 */
export type DiagnosticArtifactWriteResult =
  | {
      ok: true
      source: "project" | "global"
      path: string
      sizeBytes: number
    }
  | {
      ok: false
      reason: "too-large" | "io-failed"
      sizeBytes: number
      maxBytes: number
    }

/**
 * Artifact read result (typed contract §3).
 */
export type DiagnosticArtifactReadResult =
  | {
      kind: "ok"
      content: string
      source: "project" | "global"
      path: string
      mtime: number
      sizeBytes: number
    }
  | {
      kind: "missing"
    }
  | {
      kind: "unavailable"
      errors: Array<{
        source: "project" | "global"
        path: string
        code?: string
        message: string
      }>
    }
