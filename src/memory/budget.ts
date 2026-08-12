/**
 * Memory budget primitives for PR-8 Wave 2.
 *
 * Provides UTF-8 helpers, typed budget failure reasons, protection metadata,
 * and a pure deterministic fitMemoryToBudget() function that never mutates input.
 *
 * @see docs/CRIP/PR-8/implementation-plan.md §§3–5
 */

import { MEMORY_MAX_BYTES as MEMORY_MAX_BYTES_INTERNAL, serializeMemory } from "./memory-size"
import type { MemoryFile } from "./schema"

/**
 * Re-export MEMORY_MAX_BYTES for convenience.
 * @see docs/CRIP/PR-8/implementation-plan.md §3.1
 */
export const MEMORY_MAX_BYTES = MEMORY_MAX_BYTES_INTERNAL

/**
 * Typed failure reasons for budget fitting.
 */
export type MemoryBudgetFailureReason =
  | "foundational-state-exceeds-budget"
  | "required-state-exceeds-budget"

/**
 * Protection metadata for budget fitting.
 *
 * Temporary commit intent, not a new durable field.
 */
export type MemoryBudgetProtection = {
  /** Preserve processed-source keys (e.g., newly created source marker). */
  preserveProcessedSourceKeys?: readonly string[]
  /** Preserve audit session IDs (e.g., newly created pending audit guard). */
  preserveAuditSessionIDs?: readonly string[]
  /** Preserve decision IDs (e.g., recall_promote target). */
  preserveDecisionIDs?: readonly string[]
}

/**
 * Result of budget fitting.
 */
export type PruneResult =
  | {
      ok: true
      memory: MemoryFile
      bytes: number
      maxBytes: number
      pruned: boolean
    }
  | {
      ok: false
      reason: MemoryBudgetFailureReason
      requiredBytes: number
      maxBytes: number
    }

/**
 * UTF-8 byte length of a string.
 *
 * Uses Buffer.byteLength for exact UTF-8 byte counting, not JavaScript character count.
 */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

/**
 * Check if a string fits within a byte budget.
 *
 * @param value - The string to check
 * @param maxBytes - Maximum allowed UTF-8 bytes
 * @returns true if the string fits, false otherwise
 */
export function fitsUtf8Budget(value: string, maxBytes: number): boolean {
  return utf8Bytes(value) <= maxBytes
}

/**
 * Truncate a string to fit within a byte budget.
 *
 * Never splits a UTF-8 code point. Reserves space for truncation marker when one is emitted.
 *
 * @param value - The string to truncate
 * @param maxBytes - Maximum allowed UTF-8 bytes
 * @returns Truncated string that fits within the budget
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = utf8Bytes(value)
  if (bytes <= maxBytes) {
    return value
  }

  // Reserve space for truncation marker
  const marker = "..."
  const markerBytes = utf8Bytes(marker)
  const availableBytes = maxBytes - markerBytes

  if (availableBytes <= 0) {
    // Even marker doesn't fit - return marker only
    return marker
  }

  // Find the last valid UTF-8 code point boundary before availableBytes
  let truncated = ""
  let remainingBytes = availableBytes

  for (const char of value) {
    const charBytes = utf8Bytes(char)
    if (remainingBytes >= charBytes) {
      truncated += char
      remainingBytes -= charBytes
    } else {
      break
    }
  }

  return truncated + marker
}

/**
 * Compute the byte size of a memory file using exact JSON.stringify serialization.
 */
function computeMemoryBytes(mem: MemoryFile): number {
  return utf8Bytes(serializeMemory(mem))
}

/**
 * Get all protected decision IDs from protection and foundational/human-conflict decisions.
 */
function getProtectedDecisionIDs(mem: MemoryFile, protection?: MemoryBudgetProtection): Set<string> {
  const protectedIDs = new Set<string>()

  // Add explicitly protected decision IDs
  if (protection?.preserveDecisionIDs) {
    for (const id of protection.preserveDecisionIDs) {
      protectedIDs.add(id)
    }
  }

  // Add all foundational decisions (trusted human authority)
  for (const decision of mem.decisions ?? []) {
    if (decision.foundational || decision.human_conflict_quarantined) {
      protectedIDs.add(decision.id)
    }
  }

  return protectedIDs
}

/**
 * Get all protected processed source keys from protection.
 */
function getProtectedSourceKeys(protection?: MemoryBudgetProtection): Set<string> {
  const protectedKeys = new Set<string>()
  if (protection?.preserveProcessedSourceKeys) {
    for (const key of protection.preserveProcessedSourceKeys) {
      protectedKeys.add(key)
    }
  }
  return protectedKeys
}

/**
 * Get all protected audit session IDs from protection.
 */
function getProtectedAuditSessionIDs(protection?: MemoryBudgetProtection): Set<string> {
  const protectedIDs = new Set<string>()
  if (protection?.preserveAuditSessionIDs) {
    for (const id of protection.preserveAuditSessionIDs) {
      protectedIDs.add(id)
    }
  }
  return protectedIDs
}

/**
 * Stage 0 — normalize disposable operational metadata
 *
 * - reclassify stale pending audits using the existing timeout rule;
 * - apply existing hard record-count bounds;
 * - remove impossible duplicate disposable metadata where existing helpers already define identity.
 */
function stage0NormalizeMetadata(mem: MemoryFile, options?: { now?: number }): MemoryFile {
  const now = options?.now ?? Date.now()
  const timeoutMs = 24 * 60 * 60 * 1000 // 24-hour timeout for pending audits

  // Reclassify stale pending audits
  const updatedAudits = (mem.llm_extraction_audits ?? []).map((audit) => {
    if (audit.terminal_outcome !== "pending" || !audit.created_at) {
      return audit
    }
    const created = new Date(audit.created_at).getTime()
    const ageMs = now - created
    if (ageMs > timeoutMs) {
      return { ...audit, terminal_outcome: "failed" as const }
    }
    return audit
  })

  return {
    ...mem,
    llm_extraction_audits: updatedAudits.length > 0 ? updatedAudits : undefined,
  }
}

/**
 * Stage 1 — completed audit history
 *
 * Remove oldest completed audit rows first. Pending protected audit guards are not eligible.
 */
function stage1CompletedAudits(mem: MemoryFile, protection?: MemoryBudgetProtection): MemoryFile {
  const protectedAuditIDs = getProtectedAuditSessionIDs(protection)
  const pendingProtected = (mem.llm_extraction_audits ?? [])
    .filter((a) => a.terminal_outcome === "pending" && protectedAuditIDs.has(a.audit_session_id))

  const completedAudits = (mem.llm_extraction_audits ?? [])
    .filter((a) => a.terminal_outcome !== "pending")

  // Keep newest 20 completed audits (or all if fewer)
  const retainedCompleted = completedAudits.slice(-20)

  // Combine retained completed audits with pending protected audits
  const allAudits = [...retainedCompleted, ...pendingProtected]

  if (allAudits.length === 0) {
    return mem
  }

  return {
    ...mem,
    llm_extraction_audits: allAudits,
  }
}

/**
 * Stage 2 — result cache
 *
 * Remove oldest cache rows. Cache is optional; completion proof is not.
 */
function stage2ResultCache(mem: MemoryFile): MemoryFile {
  const cache = mem.llm_extraction_cache ?? []
  // Keep newest 10 cache entries
  const retained = cache.slice(-10)

  if (retained.length === 0) {
    return mem
  }

  return {
    ...mem,
    llm_extraction_cache: retained,
  }
}

/**
 * Stage 3 — model-health and quarantine metadata
 *
 * Remove oldest model-health rows, then cache-quarantine metadata.
 */
function stage3ModelHealth(mem: MemoryFile): MemoryFile {
  const health = mem.model_health ?? []
  // Keep newest 10 model-health records
  const retainedHealth = health.slice(-10)

  const quarantine = mem.llm_extraction_cache_quarantine

  if (retainedHealth.length === 0 && !quarantine) {
    return mem
  }

  return {
    ...mem,
    model_health: retainedHealth.length > 0 ? retainedHealth : undefined,
    llm_extraction_cache_quarantine: quarantine,
  }
}

/**
 * Stage 4 — old source/session bookkeeping
 *
 * - remove oldest `recent_sessions` entries;
 * - remove oldest `processed_sources` entries except protected source keys.
 *
 * The protected current source key must survive a successful final LLM commit.
 */
function stage4SourceSessionBookkeeping(mem: MemoryFile, protection?: MemoryBudgetProtection): MemoryFile {
  const protectedSourceKeys = getProtectedSourceKeys(protection)

  // Remove oldest recent_sessions entries, keep newest 10
  const retainedSessions = (mem.recent_sessions ?? []).slice(-10)

  // Remove oldest processed_sources except protected keys. Keep the newest
  // unprotected rows as ordinary history, while always retaining operation
  // protected proof rows.
  const sources = mem.processed_sources ?? []
  const protectedSources = sources.filter((ps) => protectedSourceKeys.has(ps.source_key))
  const unprotectedSources = sources.filter((ps) => !protectedSourceKeys.has(ps.source_key))
  const finalSources = [...unprotectedSources.slice(-10), ...protectedSources]

  if (retainedSessions.length === 0 && finalSources.length === 0) {
    return mem
  }

  return {
    ...mem,
    recent_sessions: retainedSessions,
    processed_sources: finalSources,
  }
}

/**
 * Stage 5 — invalid disposable decisions
 *
 * Remove `still_valid === false` decisions that are not protected human conflict/history rows
 * and are not explicitly protected by the current operation.
 */
function stage5InvalidDisposableDecisions(mem: MemoryFile, protection?: MemoryBudgetProtection): MemoryFile {
  const protectedIDs = getProtectedDecisionIDs(mem, protection)

  const retained = (mem.decisions ?? []).filter((d) => {
    // Keep if still valid
    if (d.still_valid) {
      return true
    }
    // Keep if protected (foundational, human_conflict_quarantined, or explicitly protected)
    if (protectedIDs.has(d.id)) {
      return true
    }
    // Remove invalid disposable decisions
    return false
  })

  if (retained.length === 0) {
    return mem
  }

  return {
    ...mem,
    decisions: retained,
  }
}

/**
 * Stage 6 — stale observed files
 *
 * Remove least-recently-touched active-file observations one at a time.
 * Active files cannot carry human/LLM authority after PR 6.
 */
function stage6StaleObservedFiles(mem: MemoryFile): MemoryFile {
  const files = mem.active_files ?? []
  // Keep newest 16 active files (sorted by last_touched descending)
  const sorted = [...files].sort((a, b) => {
    const aTime = a.last_touched ?? ""
    const bTime = b.last_touched ?? ""
    return bTime.localeCompare(aTime)
  })
  const retained = sorted.slice(0, 16)

  if (retained.length === 0) {
    return mem
  }

  return {
    ...mem,
    active_files: retained,
  }
}

/**
 * Stage 7 — old non-foundational decisions
 *
 * Remove non-protected, non-foundational decisions older than 30 days, oldest first.
 */
function stage7OldNonFoundationalDecisions(mem: MemoryFile, options?: { now?: number }, protection?: MemoryBudgetProtection): MemoryFile {
  const now = options?.now ?? Date.now()
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
  const protectedIDs = getProtectedDecisionIDs(mem, protection)

  const retained = (mem.decisions ?? []).filter((d) => {
    // Keep if protected
    if (protectedIDs.has(d.id)) {
      return true
    }
    // Keep if foundational
    if (d.foundational) {
      return true
    }
    // Keep if recent (within 30 days)
    if (d.timestamp) {
      const ageMs = now - new Date(d.timestamp).getTime()
      if (ageMs <= thirtyDaysMs) {
        return true
      }
    }
    // Remove old non-foundational decisions
    return false
  })

  if (retained.length === 0) {
    return mem
  }

  return {
    ...mem,
    decisions: retained,
  }
}

/**
 * Stage 8 — verbose optional detail
 *
 * Shorten/drop optional verbosity before deleting authoritative core text:
 * - decision rationale (including foundational rationale, because rationale is optional while topic/decision/trust are not);
 * - active-file reason;
 * - blocker/next-step verbosity;
 * - current-task verbosity.
 *
 * Use deterministic UTF-8-safe truncation floors. Do not strip provenance/evidence needed to justify a trust level.
 */
function stage8VerboseDetail(mem: MemoryFile): MemoryFile {
  // Truncate decision rationales
  const truncatedDecisions = (mem.decisions ?? []).map((d) => {
    if (d.rationale) {
      const truncated = truncateUtf8(d.rationale, 500)
      return { ...d, rationale: truncated }
    }
    return d
  })

  // Truncate active-file reasons
  const truncatedActiveFiles = (mem.active_files ?? []).map((f) => {
    if (f.reason) {
      const truncated = truncateUtf8(f.reason, 512)
      return { ...f, reason: truncated }
    }
    return f
  })

  // Reduce lower-priority entries before reducing their individual text.
  const truncatedBlockers = (mem.blockers ?? []).slice(-8).map((b) => truncateUtf8(b, 512))
  const truncatedNextSteps = (mem.next_steps ?? []).slice(-8).map((n) => truncateUtf8(n, 512))

  // Truncate current_task
  const truncatedCurrentTask = mem.current_task
    ? truncateUtf8(mem.current_task, 512)
    : mem.current_task

  return {
    ...mem,
    decisions: truncatedDecisions,
    active_files: truncatedActiveFiles,
    blockers: truncatedBlockers,
    next_steps: truncatedNextSteps,
    current_task: truncatedCurrentTask,
  }
}

/**
 * Stage 9 — non-foundational decision pressure
 *
 * Remove oldest/least-recently-used non-foundational decisions one at a time.
 * Recently recalled decisions should outrank otherwise equivalent old non-foundational rows.
 *
 * Operation-protected decision IDs cannot be removed.
 */
function stage9NonFoundationalPressure(mem: MemoryFile, options?: { now?: number }, protection?: MemoryBudgetProtection): MemoryFile {
  const protectedIDs = getProtectedDecisionIDs(mem, protection)

  // Get non-foundational, non-protected decisions
  const candidates = (mem.decisions ?? []).filter((d) => {
    if (protectedIDs.has(d.id)) {
      return false
    }
    if (d.foundational) {
      return false
    }
    return true
  })

  // Sort by last_used_in_session (newest first), then by timestamp (newest first)
  const sorted = [...candidates].sort((a, b) => {
    const aLastUsed = a.last_used_in_session ?? ""
    const bLastUsed = b.last_used_in_session ?? ""
    const usedCompare = bLastUsed.localeCompare(aLastUsed)
    if (usedCompare !== 0) {
      return usedCompare
    }
    const aTime = a.timestamp ?? ""
    const bTime = b.timestamp ?? ""
    return bTime.localeCompare(aTime)
  })

  if (sorted.length === 0) {
    return mem
  }

  const protectedDecisions = (mem.decisions ?? []).filter((d) => protectedIDs.has(d.id))
  const retained = [...protectedDecisions, ...sorted]

  // Remove the least valuable disposable decisions until the actual serialized
  // candidate fits. This is deliberately a prefix retention policy: recalled
  // and newer rows remain ahead of older rows, and no lower-priority row is
  // inserted after the first omitted row.
  while (retained.length > protectedDecisions.length && computeMemoryBytes({ ...mem, decisions: retained }) > MEMORY_MAX_BYTES) {
    retained.pop()
  }

  return {
    ...mem,
    decisions: retained,
  }
}

/**
 * Stage 10 — current ephemeral state pressure
 *
 * If still required to fit protected authority:
 * - remove oldest remaining active files;
 * - reduce/remove lower-priority blocker and next-step entries;
 * - reduce/remove current task if necessary.
 *
 * This state is valuable but does not outrank trusted human authority.
 */
function stage10EphemeralState(mem: MemoryFile): MemoryFile {
  // Truncate current_task
  const truncatedCurrentTask = mem.current_task
    ? truncateUtf8(mem.current_task, 512)
    : mem.current_task

  // Truncate blockers and next_steps
  const truncatedBlockers = (mem.blockers ?? []).map((b) => truncateUtf8(b, 512))
  const truncatedNextSteps = (mem.next_steps ?? []).map((n) => truncateUtf8(n, 512))

  // Remove oldest active files (keep newest 8)
  const files = mem.active_files ?? []
  const sortedFiles = [...files].sort((a, b) => {
    const aTime = a.last_touched ?? ""
    const bTime = b.last_touched ?? ""
    return bTime.localeCompare(aTime)
  })
  const retainedFiles = sortedFiles.slice(0, 8)

  return {
    ...mem,
    current_task: truncatedCurrentTask,
    blockers: truncatedBlockers,
    next_steps: truncatedNextSteps,
    active_files: retainedFiles,
  }
}

/**
 * Compute the minimal legal state containing all trusted human foundational rows
 * and any explicitly protected decision rows / proof records.
 *
 * This is used in Stage 11 to determine if the irreducible state exceeds the
 * budget. The returned candidate contains ONLY schema-required base fields plus
 * protected authority/proof rows — disposable ephemeral fields (blockers,
 * active_files, next_steps, recent_sessions, cache) are omitted so they do not
 * inflate the byte measurement.
 */
function computeMinimalLegalState(mem: MemoryFile, protection?: MemoryBudgetProtection): MemoryFile {
  const protectedIDs = getProtectedDecisionIDs(mem, protection)
  const protectedSourceKeys = getProtectedSourceKeys(protection)
  const protectedAuditIDs = getProtectedAuditSessionIDs(protection)

  const foundationalDecisions = (mem.decisions ?? []).filter((d) => d.foundational)

  // Include all protected decisions: foundational, human_conflict_quarantined,
  // and explicitly protected via preserveDecisionIDs. Deduplicate by ID,
  // preserving first-seen order for deterministic measurement.
  const protectedDecisions = (mem.decisions ?? []).filter((d) => protectedIDs.has(d.id))
  const allProtectedDecisions = Array.from(
    new Map(
      [...foundationalDecisions, ...protectedDecisions].map((d) => [d.id, d]),
    ).values(),
  )

  // Include all protected processed sources
  const protectedSources = (mem.processed_sources ?? []).filter((ps) =>
    protectedSourceKeys.has(ps.source_key)
  )

  // Include all protected audit sessions
  const protectedAudits = (mem.llm_extraction_audits ?? []).filter((a) =>
    protectedAuditIDs.has(a.audit_session_id)
  )

  // Construct an explicit minimal MemoryFile. Do NOT spread `...mem`: that would
  // leak disposable ephemeral fields (blockers, active_files, next_steps,
  // recent_sessions, cache, model_health) into the supposedly minimal state and
  // misclassify required-state-exceeds-budget as foundational-state-exceeds-budget.
  return {
    version: mem.version,
    revision: mem.revision,
    project_path: mem.project_path,
    last_updated: mem.last_updated,
    last_git_sha: mem.last_git_sha,
    last_session_id: mem.last_session_id,
    active_files: [],
    decisions: allProtectedDecisions,
    blockers: [],
    next_steps: [],
    recent_sessions: [],
    processed_sources: protectedSources,
    llm_extraction_audits: protectedAudits.length > 0 ? protectedAudits : undefined,
  }
}

/**
 * Pure deterministic fitMemoryToBudget() function.
 *
 * Never mutates the input. Fits the memory to the budget using incremental retention stages.
 *
 * @param memory - The memory to fit
 * @param options - Optional configuration (now, protection)
 * @returns PruneResult with success or failure
 *
 * @see docs/CRIP/PR-8/implementation-plan.md §4.2
 */
export function fitMemoryToBudget(
  memory: MemoryFile,
  options?: {
    now?: number
    protection?: MemoryBudgetProtection
  }
): PruneResult {
  // Use provided now or current time
  const now = options?.now ?? Date.now()
  const protection = options?.protection

  // Check if already fits
  const initialBytes = computeMemoryBytes(memory)
  if (initialBytes <= MEMORY_MAX_BYTES) {
    return {
      ok: true,
      memory: memory,
      bytes: initialBytes,
      maxBytes: MEMORY_MAX_BYTES,
      pruned: false,
    }
  }

  // Work on a deep copy to avoid mutating input
  let mem: MemoryFile = JSON.parse(JSON.stringify(memory))

  // Apply retention stages incrementally, rechecking after each stage
  const stages = [
    () => stage0NormalizeMetadata(mem, { now }),
    (m: MemoryFile) => stage1CompletedAudits(m, protection),
    (m: MemoryFile) => stage2ResultCache(m),
    (m: MemoryFile) => stage3ModelHealth(m),
    (m: MemoryFile) => stage4SourceSessionBookkeeping(m, protection),
    (m: MemoryFile) => stage5InvalidDisposableDecisions(m, protection),
    (m: MemoryFile) => stage6StaleObservedFiles(m),
    (m: MemoryFile) => stage7OldNonFoundationalDecisions(m, { now }, protection),
    (m: MemoryFile) => stage8VerboseDetail(m),
    (m: MemoryFile) => stage9NonFoundationalPressure(m, { now }, protection),
    (m: MemoryFile) => stage10EphemeralState(m),
  ]

  let bytes = computeMemoryBytes(mem)
  let pruned = false

  for (let i = 0; i < stages.length; i++) {
    if (bytes <= MEMORY_MAX_BYTES) {
      break
    }

    const stage = stages[i]
    const result = stage(mem)
    mem = result

    const newBytes = computeMemoryBytes(mem)
    if (newBytes < bytes) {
      pruned = true
    }
    bytes = newBytes
  }

  // Check if we fit now
  if (bytes <= MEMORY_MAX_BYTES) {
    return {
      ok: true,
      memory: mem,
      bytes,
      maxBytes: MEMORY_MAX_BYTES,
      pruned,
    }
  }

  // Stage 11 — typed refusal
  // Compute whether the minimal legal state containing all trusted human foundational rows already exceeds MEMORY_MAX_BYTES
  const minimalLegalState = computeMinimalLegalState(memory, protection)
  const minimalBytes = computeMemoryBytes(minimalLegalState)

  if (minimalBytes > MEMORY_MAX_BYTES) {
    return {
      ok: false,
      reason: "foundational-state-exceeds-budget",
      requiredBytes: minimalBytes,
      maxBytes: MEMORY_MAX_BYTES,
    }
  }

  // The overflow is caused by operation-required protected proof/state
  return {
    ok: false,
    reason: "required-state-exceeds-budget",
    requiredBytes: bytes,
    maxBytes: MEMORY_MAX_BYTES,
  }
}
