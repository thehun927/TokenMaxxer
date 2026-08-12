/**
 * Diagnostic artifact storage for compaction-related artifacts.
 *
 * Wave 2: Centralized artifact handling with typed read/write results,
 * explicit safe names, and local/global fallback semantics.
 *
 * Contract §3:
 * - Explicit safe names: last_compaction_prompt.log, last_compaction_result.json
 * - Typed write/read results with status: ok, unavailable
 * - Exact UTF-8 byte limits before disk
 * - Atomic project-local write then global fallback
 * - No throws for expected write failures
 * - Local/global read selection by newest mtime with project tie-break
 * - Missing/unavailable distinction
 * - No cache
 * - Reuse existing project hash/global storage
 */

import type { DiagnosticArtifactName, DiagnosticArtifactReadResult, DiagnosticArtifactWriteResult } from "./artifacts.types"
import { projectMemoryStorageDir, globalProjectStorageDir } from "../memory/paths"
import { atomicWrite, readFileResult } from "../util/fs"
import { basename, join } from "node:path"

/**
 * Maximum artifact size in bytes before write is rejected.
 * This is a safety limit to prevent artifact corruption.
 */
const MAX_ARTIFACT_SIZE_BYTES = 1024 * 1024 // 1 MB

/**
 * Artifact safe names (explicit contract §3).
 */
const ARTIFACT_NAMES = {
  "last_compaction_prompt.log": "last_compaction_prompt.log",
  "last_compaction_result.json": "last_compaction_result.json",
} as const

/**
 * Resolve the on-disk artifact filename for a diagnostic artifact name.
 *
 * The name union already restricts callers to the two explicit safe names.
 * This runtime guard is defense-in-depth: it rejects any name that is not a
 * plain basename (no separators, no "..", no absolute path) so a future
 * widening of the union can never enable path traversal.
 */
function resolveArtifactName(name: DiagnosticArtifactName): string {
  const fileName = ARTIFACT_NAMES[name]
  if (fileName === undefined) {
    throw new TypeError(`unsafe diagnostic artifact name: ${String(name)}`)
  }
  const candidate = String(fileName)
  if (
    basename(candidate) !== candidate ||
    candidate.includes("/") ||
    candidate.includes("\\") ||
    candidate === ".."
  ) {
    throw new TypeError(`unsafe diagnostic artifact name: ${candidate}`)
  }
  return candidate
}

/**
 * Exact UTF-8 byte length of a string.
 */
function utf8Bytes(content: string): number {
  return Buffer.byteLength(content, "utf-8")
}

/**
 * Write an artifact to the project-local storage.
 * Falls back to global storage if project-local write fails.
 *
 * Returns a typed write result with status: ok or unavailable.
 * Does not throw for expected write failures.
 */
export async function writeDiagnosticArtifact(
  name: DiagnosticArtifactName,
  project: string,
  content: string,
  maxBytes: number = MAX_ARTIFACT_SIZE_BYTES,
): Promise<DiagnosticArtifactWriteResult> {
  const artifactName = resolveArtifactName(name)

  // Exact UTF-8 byte limit check before touching disk.
  const contentBytes = utf8Bytes(content)
  if (contentBytes > maxBytes) {
    return {
      ok: false,
      reason: "too-large",
      sizeBytes: contentBytes,
      maxBytes,
    }
  }

  // Atomic project-local write first.
  const projectPath = join(projectMemoryStorageDir(project), artifactName)
  try {
    await atomicWrite(projectPath, content)
    return {
      ok: true,
      source: "project",
      path: projectPath,
      sizeBytes: contentBytes,
    }
  } catch {
    // Project-local write failed - try global fallback.
    const globalPath = join(globalProjectStorageDir(project), artifactName)
    try {
      await atomicWrite(globalPath, content)
      return {
        ok: true,
        source: "global",
        path: globalPath,
        sizeBytes: contentBytes,
      }
    } catch {
      // Global write also failed - return typed failure.
      return {
        ok: false,
        reason: "io-failed",
        sizeBytes: contentBytes,
        maxBytes,
      }
    }
  }
}

/**
 * Read an artifact from the most recent source.
 * Selects the source with the newest mtime, with project as tie-breaker.
 *
 * Returns a typed read result with status: ok, missing, or unavailable.
 * Does not throw for expected read failures.
 */
export async function readDiagnosticArtifact(
  name: DiagnosticArtifactName,
  project: string,
): Promise<DiagnosticArtifactReadResult> {
  const artifactName = resolveArtifactName(name)
  const projectPath = join(projectMemoryStorageDir(project), artifactName)
  const globalPath = join(globalProjectStorageDir(project), artifactName)

  const [projectResult, globalResult] = await Promise.all([
    readFileResult(projectPath),
    readFileResult(globalPath),
  ])

  // Both absent = missing.
  if (projectResult.kind === "missing" && globalResult.kind === "missing") {
    return { kind: "missing" }
  }

  // Both readable - select by mtime, project wins on tie.
  if (projectResult.kind === "ok" && globalResult.kind === "ok") {
    if (projectResult.mtime >= globalResult.mtime) {
      return {
        kind: "ok",
        content: projectResult.content,
        source: "project",
        path: projectPath,
        mtime: projectResult.mtime,
        sizeBytes: utf8Bytes(projectResult.content),
      }
    }
    return {
      kind: "ok",
      content: globalResult.content,
      source: "global",
      path: globalPath,
      mtime: globalResult.mtime,
      sizeBytes: utf8Bytes(globalResult.content),
    }
  }

  // Exactly one readable candidate wins (the other is missing or errored).
  if (projectResult.kind === "ok") {
    return {
      kind: "ok",
      content: projectResult.content,
      source: "project",
      path: projectPath,
      mtime: projectResult.mtime,
      sizeBytes: utf8Bytes(projectResult.content),
    }
  }
  if (globalResult.kind === "ok") {
    return {
      kind: "ok",
      content: globalResult.content,
      source: "global",
      path: globalPath,
      mtime: globalResult.mtime,
      sizeBytes: utf8Bytes(globalResult.content),
    }
  }

  // None readable. Any read error -> unavailable, otherwise missing.
  const errors: Array<{ source: "project" | "global"; path: string; code?: string; message: string }> = []
  if (projectResult.kind === "error") {
    errors.push({
      source: "project",
      path: projectPath,
      code: projectResult.code,
      message: projectResult.message,
    })
  }
  if (globalResult.kind === "error") {
    errors.push({
      source: "global",
      path: globalPath,
      code: globalResult.code,
      message: globalResult.message,
    })
  }
  if (errors.length > 0) {
    return { kind: "unavailable", errors }
  }
  return { kind: "missing" }
}

/**
 * Export artifact names for external use.
 */
export { ARTIFACT_NAMES }
