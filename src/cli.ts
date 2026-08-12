/**
 * PR 3 §11 — real human-controlled CLI confirmation boundary.
 *
 * Three commands, driven through an injected I/O adapter so the interactive
 * TTY boundary is testable without weakening production confirmation:
 *
 *   tokenmaxxer decisions [--all] [--project <path>]
 *   tokenmaxxer promote <decision-id> [--project <path>]
 *   tokenmaxxer supersede <candidate-id> --replaces <authority-id> [--project <path>]
 *
 * The CLI reuses the shared reader/store/decision-review code. It does NOT
 * implement its own STATE JSON writer or project-lock algorithm.
 *
 * For `promote`/`supersede` the interactive confirmation happens BEFORE the
 * project lock is acquired, and the exact IDs are re-validated inside the
 * single `mutateMemory()` transaction after the human has typed confirmation —
 * so if the state changed during the confirmation window, the transaction
 * aborts without promoting (TOCTOU fail-closed, PR 3 §14).
 */
import { createInterface } from "node:readline/promises"
import { pathToFileURL } from "node:url"
import { resolve as resolvePath } from "node:path"

import { readMemoryState, mutateMemory } from "./memory/store"
import type { MemoryFile, Decision } from "./memory/schema"
import {
  queryDecisions,
  getExactDecisionById,
  getDecisionAuthorityConflicts,
} from "./memory/reader"
import {
  resolveDecisionAuthorities,
  isTrustedHumanFoundational,
  normalizeDecisionTopic,
} from "./memory/decision-authority"
import {
  confirmFoundationalReview,
  supersedeHumanAuthority,
} from "./memory/decision-review"

export interface CliIO {
  stdin: { isTTY: boolean; read(prompt: string): Promise<string> }
  stdout: { isTTY: boolean; write(text: string): void }
  stderr: { isTTY: boolean; write(text: string): void }
}

export type CliOptions = {
  /** Absolute path; defaults to process.cwd(). */
  project?: string
  io: CliIO
  /** Defaults to () => new Date(); injectable for tests. */
  now?: () => Date
}

type CliResult = { kind: string; message: string }

type PromoteOutcome =
  | { outcome: "confirmed"; targetId: string }
  | { outcome: "decision-changed-during-review" }
  | { outcome: "not-requested" }
  | { outcome: "promote-failed" }

type SupersedeOutcome =
  | { outcome: "superseded"; newAuthorityId: string }
  | { outcome: "decision-changed-during-review" }
  | { outcome: "supersede-failed" }

// ─── argument parsing ────────────────────────────────────────────────────────

type ParsedFlags = {
  positional: string[]
  project: string | undefined
  all: boolean
  replaces: string | undefined
}

function parseFlags(args: string[]): ParsedFlags {
  const positional: string[] = []
  let project: string | undefined
  let all = false
  let replaces: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--project") {
      project = args[++i]
    } else if (arg === "--all") {
      all = true
    } else if (arg === "--replaces") {
      replaces = args[++i]
    } else {
      positional.push(arg)
    }
  }
  return { positional, project, all, replaces }
}

// ─── formatting ──────────────────────────────────────────────────────────────

function provenanceLabel(d: Decision): string {
  const p = d.provenance
  if (!p) return ""
  return `source=${p.source_session_id}${p.source_audit_session_id
    ? ` audit=${p.source_audit_session_id}`
    : ""} evidence=${p.evidence?.length ?? 0}`
}

function formatDecisionLine(
  d: Decision,
  authorityIds: Set<string>,
  all: boolean,
): string {
  const marker = ` [id=${d.id} confidence=${d.provenance?.confidence ?? "unknown"} foundational=${d.foundational === true} requested=${d.foundational_requested === true}]`
  const provenance = d.provenance ? ` ${provenanceLabel(d)}` : ""
  let line = `${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${d.timestamp})${marker}${provenance}`
  if (all) {
    const extras: string[] = []
    extras.push(`still_valid=${d.still_valid === true}`)
    extras.push(`authority=${authorityIds.has(d.id) ? "yes" : "no"}`)
    if (d.superseded_by) extras.push(`superseded_by=${d.superseded_by}`)
    if (d.conflicts_with && d.conflicts_with.length > 0) {
      extras.push(`conflicts_with=${d.conflicts_with.join(",")}`)
    }
    if (d.derived_from_decision_id) {
      extras.push(`derived_from=${d.derived_from_decision_id}`)
    }
    line += ` ${extras.join(" ")}`
  }
  return line
}

// ─── decisions (read-only) ───────────────────────────────────────────────────

async function cmdDecisions(
  project: string,
  all: boolean,
  options: CliOptions,
): Promise<CliResult> {
  const read = await readMemoryState({
    worktree: project,
    directory: project,
    bypassCache: true,
  })
  if (read.status === "unavailable") {
    const msg =
      "Authoritative STATE is unavailable (unreadable); cannot list decisions."
    options.io.stderr.write(msg + "\n")
    return { kind: "unavailable", message: msg }
  }
  if (read.status === "missing") {
    const msg = "No project memory yet."
    options.io.stdout.write(msg + "\n")
    return { kind: "empty", message: msg }
  }

  const mem = read.memory
  const resolution = resolveDecisionAuthorities(mem.decisions)
  const authorityIds = new Set(resolution.authorities.map((a) => a.id))

  const lines: string[] = []
  if (all) {
    const rows = [...mem.decisions].sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp),
    )
    for (const d of rows) lines.push(formatDecisionLine(d, authorityIds, true))
  } else {
    // Authoritative decisions via the authority-aware reader (PR 3 §8).
    const authorities = queryDecisions(mem, undefined, Number.MAX_SAFE_INTEGER)
    for (const d of authorities) lines.push(formatDecisionLine(d, authorityIds, false))
  }
  options.io.stdout.write(lines.join("\n") + (lines.length > 0 ? "\n" : ""))

  if (all) {
    const conflicts = getDecisionAuthorityConflicts(mem)
    if (conflicts.length > 0) {
      options.io.stdout.write("Unresolved human conflicts:\n")
      for (const c of conflicts) {
        options.io.stdout.write(
          `  ${c.normalized_topic} (human-foundational conflict: ${c.decision_ids.join(", ")})\n`,
        )
      }
    }
  }

  return { kind: "decisions", message: `listed ${lines.length} decision(s)` }
}

// ─── promote ─────────────────────────────────────────────────────────────────

async function cmdPromote(
  project: string,
  decisionId: string,
  options: CliOptions,
): Promise<CliResult> {
  const io = options.io

  const read = await readMemoryState({
    worktree: project,
    directory: project,
    bypassCache: true,
  })
  if (read.status !== "ok") {
    const msg =
      read.status === "unavailable"
        ? "Authoritative STATE is unavailable; cannot promote."
        : `No project memory; no decision with id "${decisionId}".`
    io.stderr.write(msg + "\n")
    return { kind: "refused", message: msg }
  }

  const mem = read.memory
  const resolution = resolveDecisionAuthorities(mem.decisions)
  const authority = resolution.authorities.find((a) => a.id === decisionId)

  // Wave-9 (Blocker 2): refuse ambiguous duplicate-ID state BEFORE any
  // confirmation prompt. `getExactDecisionById` returns `exact` only when
  // exactly one raw row matches; `getDecisionById` would otherwise silently
  // take the first match and could mint trust onto a different row.
  const exact = getExactDecisionById(mem, decisionId)
  if (exact.kind === "duplicate") {
    const msg = `Refusing promote: ${decisionId} is ambiguous (${exact.ids.length} rows share this ID). Re-run 'tokenmaxxer decisions' and specify a unique decision ID.`
    io.stderr.write(msg + "\n")
    return { kind: "refused", message: msg }
  }
  const raw = exact.kind === "exact" ? exact.decision : undefined
  if (!raw || !authority) {
    const msg = `Refusing promote: ${decisionId} is not the current authority for its topic. Re-run 'tokenmaxxer decisions' for the exact ID.`
    io.stderr.write(msg + "\n")
    return { kind: "refused", message: msg }
  }
  if (raw.foundational_requested !== true) {
    const msg = `Refusing promote: ${decisionId} is not currently marked for foundational review. Request review first via recall_promote.`
    io.stderr.write(msg + "\n")
    return { kind: "refused", message: msg }
  }

  // Print the exact topic + decision + provenance the human is reviewing.
  io.stdout.write(`Decision ${decisionId}\n`)
  io.stdout.write(`  topic: ${raw.topic}\n`)
  io.stdout.write(`  decision: ${raw.decision}\n`)
  io.stdout.write(
    `  provenance: extractor=${raw.provenance?.extractor ?? "unknown"} confidence=${raw.provenance?.confidence ?? "unknown"} source=${raw.provenance?.source_session_id ?? "?"}${raw.provenance?.source_audit_session_id ? ` audit=${raw.provenance.source_audit_session_id}` : ""}\n`,
  )

  // Interactive confirmation boundary. No --yes, no env bypass, no piped
  // confirmation: the human must type the exact decision ID.
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    const msg =
      "Refusing non-interactive promote: human confirmation requires an interactive terminal (TTY)."
    io.stderr.write(msg + "\n")
    return { kind: "refused", message: msg }
  }

  let confirmed = false
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await io.stdin.read(
      `Type the exact decision ID to confirm promotion (${decisionId}): `,
    )
    if (answer.trim() === decisionId) {
      confirmed = true
      break
    }
    if (attempt < 2) {
      io.stderr.write(`Mismatch: expected the exact ID "${decisionId}".\n`)
    }
  }
  if (!confirmed) {
    const msg = `Cancelled: confirmation did not match "${decisionId}". No state was changed.`
    io.stderr.write(msg + "\n")
    return { kind: "cancelled", message: msg }
  }

  // Human confirmation happened BEFORE the lock. Inside one mutateMemory
  // transaction the exact ID is re-read and re-validated as the authority; if
  // it changed during the confirmation window, abort without promoting.
  const reviewedAt = (options.now ?? (() => new Date()))().toISOString()
  const result = await mutateMemory<PromoteOutcome>(
    { worktree: project, directory: project },
    (memory) => {
      const currentResolution = resolveDecisionAuthorities(memory.decisions)
      const currentAuthority = currentResolution.authorities.find(
        (a) => a.id === decisionId,
      )
      const currentExact = getExactDecisionById(memory, decisionId)
      if (currentExact.kind === "duplicate") {
        return { kind: "noop", value: { outcome: "decision-changed-during-review" } }
      }
      const currentRaw = currentExact.kind === "exact" ? currentExact.decision : undefined
      if (!currentRaw || !currentAuthority) {
        return { kind: "noop", value: { outcome: "decision-changed-during-review" } }
      }
      if (currentRaw.foundational_requested !== true) {
        return { kind: "noop", value: { outcome: "not-requested" } }
      }
      const mutation = confirmFoundationalReview(memory, decisionId, reviewedAt)
      if (mutation.kind === "confirmed") {
        return {
          kind: "commit",
          memory: mutation.memory,
          value: { outcome: "confirmed", targetId: decisionId },
          budgetProtection: { preserveDecisionIDs: [decisionId] },
        }
      }
      return { kind: "noop", value: { outcome: "promote-failed" } }
    },
  )

  return handlePromoteResult(result, decisionId, io)
}

function handlePromoteResult(
  result: Awaited<ReturnType<typeof mutateMemory<PromoteOutcome>>>,
  decisionId: string,
  io: CliIO,
): CliResult {
  if (result.status === "committed") {
    const msg = `Promotion confirmed for ${decisionId}.`
    io.stdout.write(msg + "\n")
    return { kind: "promoted", message: msg }
  }
  if (result.status === "noop") {
    const outcome = (result.value as { outcome: string }).outcome
    if (outcome === "decision-changed-during-review") {
      const msg = `Aborted: ${decisionId} changed during review. Re-run 'tokenmaxxer decisions' to inspect current state.`
      io.stderr.write(msg + "\n")
      return { kind: "decision-changed-during-review", message: msg }
    }
    if (outcome === "not-requested") {
      const msg = `Aborted: ${decisionId} is no longer marked for foundational review.`
      io.stderr.write(msg + "\n")
      return { kind: "refused", message: msg }
    }
    const msg = "Promotion could not be written; STATE unchanged."
    io.stderr.write(msg + "\n")
    return { kind: "failed", message: msg }
  }
  if (result.status === "budget-rejected") {
    const msg = "Promotion would exceed the protected STATE budget; STATE unchanged."
    io.stderr.write(msg + "\n")
    return { kind: "failed", message: msg }
  }
  if (result.status === "lock-timeout") {
    const msg = "Timed out waiting for the project lock; try again."
    io.stderr.write(msg + "\n")
    return { kind: "lock-timeout", message: msg }
  }
  if (result.status === "commit-failed") {
    const msg = "Promotion failed to commit; STATE unchanged."
    io.stderr.write(msg + "\n")
    return { kind: "commit-failed", message: msg }
  }
  if (result.status === "unavailable") {
    const msg = "Authoritative STATE unavailable; promotion aborted."
    io.stderr.write(msg + "\n")
    return { kind: "unavailable", message: msg }
  }
  // Exhaustive check: all MemoryMutationResult discriminants handled above.
  const _exhaustive: never = result
  void _exhaustive
  const msg = "Authoritative STATE unavailable; promotion aborted."
  io.stderr.write(msg + "\n")
  return { kind: "unavailable", message: msg }
}

// ─── supersede ───────────────────────────────────────────────────────────────

async function cmdSupersede(
  project: string,
  candidateId: string,
  authorityId: string,
  options: CliOptions,
): Promise<CliResult> {
  const io = options.io

  const read = await readMemoryState({
    worktree: project,
    directory: project,
    bypassCache: true,
  })
  if (read.status !== "ok") {
    const msg =
      read.status === "unavailable"
        ? "Authoritative STATE is unavailable; cannot supersede."
        : "No project memory; cannot supersede."
    io.stderr.write(msg + "\n")
    return { kind: "refused", message: msg }
  }

  const mem = read.memory
  const authorityLookup = getExactDecisionById(mem, authorityId)
  const candidateLookup = getExactDecisionById(mem, candidateId)
  if (authorityLookup.kind === "duplicate" || candidateLookup.kind === "duplicate") {
    const msg = `Refusing supersede: "${authorityId}" or "${candidateId}" is ambiguous (duplicate decision IDs). Repair the STATE before superseding.`
    io.stderr.write(msg + "\n")
    return { kind: "refused", message: msg }
  }
  const authority = authorityLookup.kind === "exact" ? authorityLookup.decision : undefined
  const candidate = candidateLookup.kind === "exact" ? candidateLookup.decision : undefined
  if (!authority || !candidate) {
    const msg = `Refusing supersede: authority "${authorityId}" or candidate "${candidateId}" does not exist.`
    io.stderr.write(msg + "\n")
    return { kind: "refused", message: msg }
  }
  if (!isTrustedHumanFoundational(authority)) {
    const msg = `Refusing supersede: ${authorityId} is not a trusted human foundational authority.`
    io.stderr.write(msg + "\n")
    return { kind: "refused", message: msg }
  }
  const sameTopic =
    normalizeDecisionTopic(candidate.topic) === normalizeDecisionTopic(authority.topic)
  const linked = candidate.conflicts_with?.includes(authorityId) === true
  if (!sameTopic || !linked) {
    const msg = `Refusing supersede: candidate ${candidateId} is not linked to authority ${authorityId} (unrelated topic or no conflict link).`
    io.stderr.write(msg + "\n")
    return { kind: "refused", message: msg }
  }

  io.stdout.write("Superseding trusted human authority:\n")
  io.stdout.write(`  authority: ${authorityId} (${authority.topic}: ${authority.decision})\n`)
  io.stdout.write(`  candidate: ${candidateId} (${candidate.topic}: ${candidate.decision})\n`)

  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    const msg =
      "Refusing non-interactive supersede: human confirmation requires an interactive terminal (TTY)."
    io.stderr.write(msg + "\n")
    return { kind: "refused", message: msg }
  }

  let confirmed = false
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await io.stdin.read(
      `Type the exact candidate decision ID to confirm supersession (${candidateId}): `,
    )
    if (answer.trim() === candidateId) {
      confirmed = true
      break
    }
    if (attempt < 2) {
      io.stderr.write(`Mismatch: expected the exact ID "${candidateId}".\n`)
    }
  }
  if (!confirmed) {
    const msg = `Cancelled: confirmation did not match "${candidateId}". No state was changed.`
    io.stderr.write(msg + "\n")
    return { kind: "cancelled", message: msg }
  }

  const reviewedAt = (options.now ?? (() => new Date()))().toISOString()
  const result = await mutateMemory<SupersedeOutcome>(
    { worktree: project, directory: project },
    (memory) => {
      const currentAuthorityLookup = getExactDecisionById(memory, authorityId)
      const currentCandidateLookup = getExactDecisionById(memory, candidateId)
      if (
        currentAuthorityLookup.kind === "duplicate" ||
        currentCandidateLookup.kind === "duplicate"
      ) {
        return { kind: "noop", value: { outcome: "decision-changed-during-review" } }
      }
      const currentAuthority =
        currentAuthorityLookup.kind === "exact" ? currentAuthorityLookup.decision : undefined
      const currentCandidate =
        currentCandidateLookup.kind === "exact" ? currentCandidateLookup.decision : undefined
      if (
        !currentAuthority ||
        !currentCandidate ||
        !isTrustedHumanFoundational(currentAuthority)
      ) {
        return { kind: "noop", value: { outcome: "decision-changed-during-review" } }
      }
      const cSameTopic =
        normalizeDecisionTopic(currentCandidate.topic) ===
        normalizeDecisionTopic(currentAuthority.topic)
      const cLinked = currentCandidate.conflicts_with?.includes(authorityId) === true
      if (!cSameTopic || !cLinked) {
        return { kind: "noop", value: { outcome: "decision-changed-during-review" } }
      }
      const mutation = supersedeHumanAuthority(memory, {
        authorityId,
        candidateId,
        reviewedAt,
      })
      if (mutation.kind === "superseded") {
        return {
          kind: "commit",
          memory: mutation.memory,
          value: { outcome: "superseded", newAuthorityId: mutation.newAuthorityId },
          budgetProtection: { preserveDecisionIDs: [mutation.newAuthorityId, authorityId, candidateId] },
        }
      }
      return { kind: "noop", value: { outcome: "supersede-failed" } }
    },
  )

  return handleSupersedeResult(result, io)
}

function handleSupersedeResult(
  result: Awaited<ReturnType<typeof mutateMemory<SupersedeOutcome>>>,
  io: CliIO,
): CliResult {
  if (result.status === "committed") {
    const newId = (result.value as { newAuthorityId: string }).newAuthorityId
    const msg = `Supersession complete. New human authority: ${newId}`
    io.stdout.write(msg + "\n")
    return { kind: "superseded", message: msg }
  }
  if (result.status === "noop") {
    const outcome = (result.value as { outcome: string }).outcome
    if (outcome === "decision-changed-during-review") {
      const msg =
        "Aborted: the authority or candidate changed during review. Re-run 'tokenmaxxer decisions'."
      io.stderr.write(msg + "\n")
      return { kind: "decision-changed-during-review", message: msg }
    }
    const msg = "Supersession could not be written; STATE unchanged."
    io.stderr.write(msg + "\n")
    return { kind: "failed", message: msg }
  }
  if (result.status === "budget-rejected") {
    const msg = "Supersession would exceed the protected STATE budget; STATE unchanged."
    io.stderr.write(msg + "\n")
    return { kind: "failed", message: msg }
  }
  if (result.status === "lock-timeout") {
    const msg = "Timed out waiting for the project lock; try again."
    io.stderr.write(msg + "\n")
    return { kind: "lock-timeout", message: msg }
  }
  if (result.status === "commit-failed") {
    const msg = "Supersession failed to commit; STATE unchanged."
    io.stderr.write(msg + "\n")
    return { kind: "commit-failed", message: msg }
  }
  if (result.status === "unavailable") {
    const msg = "Authoritative STATE unavailable; supersession aborted."
    io.stderr.write(msg + "\n")
    return { kind: "unavailable", message: msg }
  }
  // Exhaustive check: all MemoryMutationResult discriminants handled above.
  const _exhaustive: never = result
  void _exhaustive
  const msg = "Authoritative STATE unavailable; supersession aborted."
  io.stderr.write(msg + "\n")
  return { kind: "unavailable", message: msg }
}

// ─── dispatch ────────────────────────────────────────────────────────────────

export async function runCli(
  args: string[],
  options: CliOptions,
): Promise<CliResult> {
  const [command, ...rest] = args
  const flags = parseFlags(rest)
  const project = resolvePath(flags.project ?? options.project ?? process.cwd())

  switch (command) {
    case "decisions":
      return cmdDecisions(project, flags.all, options)

    case "promote": {
      const decisionId = flags.positional[0]
      if (!decisionId) {
        const msg = "Usage: tokenmaxxer promote <decision-id> [--project <path>]"
        options.io.stderr.write(msg + "\n")
        return { kind: "usage", message: msg }
      }
      return cmdPromote(project, decisionId, options)
    }

    case "supersede": {
      const candidateId = flags.positional[0]
      if (!candidateId || !flags.replaces) {
        const msg =
          "Usage: tokenmaxxer supersede <candidate-id> --replaces <authority-id> [--project <path>]"
        options.io.stderr.write(msg + "\n")
        return { kind: "usage", message: msg }
      }
      return cmdSupersede(project, candidateId, flags.replaces, options)
    }

    default: {
      const msg =
        "Usage: tokenmaxxer opencode [args...] | decisions [--all] [--project <path>] | promote <decision-id> [--project <path>] | supersede <candidate-id> --replaces <authority-id> [--project <path>]"
      options.io.stderr.write(msg + "\n")
      return { kind: "usage", message: msg }
    }
  }
}

// ─── default IO for the launcher (bin/tokenmaxxer -> node dist/cli.js) ───────

function makeDefaultIo(): CliIO {
  let readline: ReturnType<typeof createInterface> | null = null
  return {
    stdin: {
      isTTY: process.stdin.isTTY === true,
      read: async (prompt: string): Promise<string> => {
        if (process.stdout.isTTY) process.stdout.write(prompt)
        if (!readline) {
          readline = createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
          })
        }
        return readline.question("")
      },
    },
    stdout: {
      isTTY: process.stdout.isTTY === true,
      write: (text: string) => {
        process.stdout.write(text)
      },
    },
    stderr: {
      isTTY: process.stderr.isTTY === true,
      write: (text: string) => {
        process.stderr.write(text)
      },
    },
  }
}

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2), {
    io: makeDefaultIo(),
  })
  if (
    result.kind === "refused" ||
    result.kind === "cancelled" ||
    result.kind === "decision-changed-during-review" ||
    result.kind === "commit-failed" ||
    result.kind === "lock-timeout" ||
    result.kind === "unavailable" ||
    result.kind === "failed" ||
    result.kind === "usage"
  ) {
    process.exitCode = 1
  }
}

// Only run the launcher entry when executed directly (node dist/cli.js); when
// imported by tests the module exposes runCli/CliIO/CliOptions only.
const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : ""
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error(String(error))
    process.exitCode = 1
  })
}
