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

  // For maxBytes 0, 1, 2: return empty string (marker doesn't fit)
  const marker = "..."
  const markerBytes = utf8Bytes(marker)

  if (maxBytes <= 2) {
    // Even marker doesn't fit - return empty string
    return ""
  }

  if (bytes <= maxBytes) {
    return value
  }

  // Reserve space for truncation marker
  const availableBytes = maxBytes - markerBytes

  if (availableBytes <= 0) {
    // Marker doesn't fit - return empty string
    return ""
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
  const audits = mem.llm_extraction_audits ?? []
  const pending = audits.filter((a) => a.terminal_outcome === "pending")
  const completed = audits.filter((a) => a.terminal_outcome !== "pending")
  const retained = completed.slice(-20)
  while (retained.length > 0 && computeMemoryBytes({ ...mem, llm_extraction_audits: [...retained, ...pending] }) > MEMORY_MAX_BYTES) {
    retained.shift()
  }
  const allAudits = [...retained, ...pending]

  return {
    ...mem,
    llm_extraction_audits: allAudits.length > 0 ? allAudits : undefined,
  }
}

/**
 * Stage 2 — result cache
 *
 * Remove oldest cache rows. Cache is optional; completion proof is not.
 */
function stage2ResultCache(mem: MemoryFile): MemoryFile {
  const cache = mem.llm_extraction_cache ?? []
  const retained = cache.slice(-10)
  while (retained.length > 0 && computeMemoryBytes({ ...mem, llm_extraction_cache: retained }) > MEMORY_MAX_BYTES) {
    retained.shift()
  }

  return {
    ...mem,
    llm_extraction_cache: retained.length > 0 ? retained : undefined,
  }
}

/**
 * Stage 3 — model-health and quarantine metadata
 *
 * Remove oldest model-health rows, then cache-quarantine metadata.
 */
function stage3ModelHealth(mem: MemoryFile): MemoryFile {
  const health = mem.model_health ?? []
  const retainedHealth = health.slice(-10)
  let quarantine = mem.llm_extraction_cache_quarantine
  while (retainedHealth.length > 0 && computeMemoryBytes({ ...mem, model_health: retainedHealth, llm_extraction_cache_quarantine: quarantine }) > MEMORY_MAX_BYTES) {
    retainedHealth.shift()
  }
  if (computeMemoryBytes({ ...mem, model_health: retainedHealth, llm_extraction_cache_quarantine: quarantine }) > MEMORY_MAX_BYTES) {
    quarantine = undefined
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

  const retainedSessions = (mem.recent_sessions ?? []).slice(-10)

  // Remove oldest processed_sources except protected keys. Keep the newest
  // unprotected rows as ordinary history, while always retaining operation
  // protected proof rows.
  const sources = mem.processed_sources ?? []
  const protectedSources = sources.filter((ps) => protectedSourceKeys.has(ps.source_key))
  const unprotectedSources = sources.filter((ps) => !protectedSourceKeys.has(ps.source_key))
  const retainedSources = unprotectedSources.slice(-10)
  while (retainedSessions.length > 0 && computeMemoryBytes({ ...mem, recent_sessions: retainedSessions, processed_sources: [...retainedSources, ...protectedSources] }) > MEMORY_MAX_BYTES) {
    retainedSessions.shift()
  }
  while (retainedSources.length > 0 && computeMemoryBytes({ ...mem, recent_sessions: retainedSessions, processed_sources: [...retainedSources, ...protectedSources] }) > MEMORY_MAX_BYTES) {
    retainedSources.shift()
  }
  const finalSources = [...retainedSources, ...protectedSources]

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

  // Return candidate with decisions: [] when all decisions in this category are removed
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
  const sorted = [...files].sort((a, b) => {
    const aTime = a.last_touched ?? ""
    const bTime = b.last_touched ?? ""
    return bTime.localeCompare(aTime)
  })
  const retained = sorted.slice(0, 16)
  while (retained.length > 0 && computeMemoryBytes({ ...mem, active_files: retained }) > MEMORY_MAX_BYTES) {
    retained.pop()
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

  // Return candidate with decisions: [] when all decisions in this category are removed
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
 *
 * Performs exact incremental disposable reduction in priority order:
 * oldest active_files, lower-priority blockers, lower-priority next_steps,
 * then current_task removal/truncation until serialized bytes <=8192 or exhausted.
 */
function stage10EphemeralState(mem: MemoryFile): MemoryFile {
  // Thread the candidate through each reduction step
  let candidate: MemoryFile = mem

  // 1. Remove oldest active files until we fit or run out
  const files = mem.active_files ?? []
  // Sort oldest first (ascending by last_touched)
  const sortedFiles = [...files].sort((a, b) => {
    const aTime = a.last_touched ?? ""
    const bTime = b.last_touched ?? ""
    return aTime.localeCompare(bTime)
  })

  // Remove from oldest (beginning) until we fit or exhausted
  // Check bytes of candidate with reduced active_files
  let retainedFiles = [...sortedFiles]
  while (
    retainedFiles.length > 0 &&
    computeMemoryBytes({ ...candidate, active_files: retainedFiles }) > MEMORY_MAX_BYTES
  ) {
    retainedFiles.shift()
  }

  candidate = {
    ...candidate,
    active_files: retainedFiles,
  }

  // 2. Remove lower-priority blockers until we fit or run out
  const blockers = candidate.blockers ?? []
  let retainedBlockers = [...blockers]
  while (
    retainedBlockers.length > 0 &&
    computeMemoryBytes({ ...candidate, blockers: retainedBlockers }) > MEMORY_MAX_BYTES
  ) {
    retainedBlockers.shift()
  }

  candidate = {
    ...candidate,
    blockers: retainedBlockers,
  }

  // 3. Remove lower-priority next_steps until we fit or run out
  const nextSteps = candidate.next_steps ?? []
  let retainedNextSteps = [...nextSteps]
  while (
    retainedNextSteps.length > 0 &&
    computeMemoryBytes({ ...candidate, next_steps: retainedNextSteps }) > MEMORY_MAX_BYTES
  ) {
    retainedNextSteps.shift()
  }

  candidate = {
    ...candidate,
    next_steps: retainedNextSteps,
  }

  // 4. Truncate current_task until we fit or run out
  let truncatedCurrentTask = candidate.current_task
  while (
    truncatedCurrentTask !== undefined &&
    computeMemoryBytes({ ...candidate, current_task: truncatedCurrentTask }) > MEMORY_MAX_BYTES
  ) {
    const shortened = truncateUtf8(truncatedCurrentTask, 512)
    truncatedCurrentTask = shortened === truncatedCurrentTask ? undefined : shortened
  }

  candidate = {
    ...candidate,
    current_task: truncatedCurrentTask,
  }

  return candidate
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

  // Work on a deep copy to avoid mutating input
  let mem: MemoryFile = JSON.parse(JSON.stringify(memory))

  // Apply stages 0-4 (metadata normalization, audit history, cache, model-health, source/session bookkeeping)
  // These stages reduce size and are always applied
  mem = stage0NormalizeMetadata(mem, { now })
  mem = stage1CompletedAudits(mem, protection)
  mem = stage2ResultCache(mem)
  mem = stage3ModelHealth(mem)
  mem = stage4SourceSessionBookkeeping(mem, protection)

  // Apply stage 5 (invalid disposable decisions) - always apply to clean up invalid decisions
  mem = stage5InvalidDisposableDecisions(mem, protection)

  // Apply stage 6 (stale observed files)
  mem = stage6StaleObservedFiles(mem)

  // Apply stage 7 (old non-foundational decisions) - always apply to clean up old decisions
  mem = stage7OldNonFoundationalDecisions(mem, { now }, protection)

  // Apply stage 8 (verbose detail truncation) - always apply to enforce creation limits
  mem = stage8VerboseDetail(mem)

  // Apply stages 9-10 (decision pressure, ephemeral state) - only if needed to fit budget
  let bytes = computeMemoryBytes(mem)
  let pruned = bytes < computeMemoryBytes(memory)

  if (bytes > MEMORY_MAX_BYTES) {
    mem = stage9NonFoundationalPressure(mem, { now }, protection)
    bytes = computeMemoryBytes(mem)

    if (bytes > MEMORY_MAX_BYTES) {
      mem = stage10EphemeralState(mem)
      bytes = computeMemoryBytes(mem)
    }
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
