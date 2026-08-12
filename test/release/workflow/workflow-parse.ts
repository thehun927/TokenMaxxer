/**
 * Workflow contract parser for PR-10 (Wave 1, Agent 1C).
 *
 * Parses `.github/workflows/*.yml` into a typed model so contract tests can
 * assert on structure (triggers, permissions, steps, pinned action refs)
 * instead of brittle whole-file grep. `yaml` strips trailing comments, so the
 * raw text is additionally scanned to recover the `# <tag>` comment that
 * PR-10 requires next to every full-SHA action pin.
 *
 * This is test-only infrastructure under `test/release/workflow/`.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { parse } from "yaml"

/** Repository root, derived from this file's location (test/release/workflow/). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))

export interface WorkflowStep {
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
}

export interface WorkflowJob {
  name?: string
  permissions?: unknown
  runsOn?: string
  steps?: WorkflowStep[]
}

export interface RawUse {
  job: string
  stepIndex: number
  value: string
  action: string
  ref: string
  comment?: string
}

export interface WorkflowModel {
  file: string
  name?: string
  on?: unknown
  permissions?: unknown
  jobs: Record<string, WorkflowJob>
  rawUses: RawUse[]
}

export function loadWorkflow(path: string): WorkflowModel {
  const text = readFileSync(path, "utf8")
  const doc = (parse(text) ?? {}) as Record<string, unknown>
  const jobs: Record<string, WorkflowJob> = {}

  const rawJobs = (doc.jobs ?? {}) as Record<string, unknown>
  for (const [jobName, job] of Object.entries(rawJobs)) {
    const j = (job ?? {}) as { name?: unknown; permissions?: unknown; steps?: unknown; "runs-on"?: unknown }
    jobs[jobName] = {
      name: typeof j.name === "string" ? j.name : undefined,
      permissions: j.permissions,
      runsOn: typeof j["runs-on"] === "string" ? j["runs-on"] : undefined,
      steps: Array.isArray(j.steps) ? (j.steps as WorkflowStep[]) : [],
    }
  }

  // Recover raw `uses:` lines including trailing `# tag` comments, matched per
  // parsed step so ordering stays aligned with the structured model.
  const rawUses: RawUse[] = []
  for (const [jobName, job] of Object.entries(jobs)) {
    const steps = job.steps ?? []
    for (let i = 0; i < steps.length; i += 1) {
      const uses = steps[i].uses
      if (!uses) continue
      const escaped = uses.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const lineMatch = text.match(new RegExp(`uses:\\s*${escaped}([^\\S\\n]*#[^\\n]*)?`))
      const comment = lineMatch?.[1]?.replace(/^[^\S\n]*#/, "").trim() || undefined
      const at = uses.lastIndexOf("@")
      rawUses.push({
        job: jobName,
        stepIndex: i,
        value: uses,
        action: at >= 0 ? uses.slice(0, at) : uses,
        ref: at >= 0 ? uses.slice(at + 1) : "",
        comment,
      })
    }
  }

  return {
    file: path,
    name: typeof doc.name === "string" ? doc.name : undefined,
    on: doc.on,
    permissions: doc.permissions,
    jobs,
    rawUses,
  }
}

export interface TriggerInfo {
  pushBranches: string[]
  pushTags: string[]
  hasPullRequest: boolean
  pullRequestBranches: string[]
  hasWorkflowDispatch: boolean
  workflowDispatchInputs: Record<string, unknown>
}

function filterOf(filter: unknown, key: string): string[] {
  if (filter && typeof filter === "object") {
    const obj = filter as Record<string, unknown>
    if (Array.isArray(obj[key])) return obj[key].filter((x): x is string => typeof x === "string")
    if (typeof obj[key] === "string") return [obj[key] as string]
  }
  if (Array.isArray(filter)) return filter.filter((x): x is string => typeof x === "string")
  if (typeof filter === "string") return [filter]
  return []
}

export function getTriggerInfo(on: unknown): TriggerInfo {
  const info: TriggerInfo = {
    pushBranches: [],
    pushTags: [],
    hasPullRequest: false,
    pullRequestBranches: [],
    hasWorkflowDispatch: false,
    workflowDispatchInputs: {},
  }
  if (!on || typeof on !== "object") return info
  const onObj = on as Record<string, unknown>
  info.pushBranches = filterOf(onObj.push, "branches")
  info.pushTags = filterOf(onObj.push, "tags")
  info.hasPullRequest = onObj.pull_request !== undefined
  if (onObj.pull_request && typeof onObj.pull_request === "object") {
    info.pullRequestBranches = filterOf(onObj.pull_request, "branches")
  }
  info.hasWorkflowDispatch = onObj.workflow_dispatch !== undefined
  if (onObj.workflow_dispatch && typeof onObj.workflow_dispatch === "object") {
    const wd = onObj.workflow_dispatch as { inputs?: unknown }
    info.workflowDispatchInputs =
      wd.inputs && typeof wd.inputs === "object" ? (wd.inputs as Record<string, unknown>) : {}
  }
  return info
}

export interface PermissionScopes {
  scopes: Record<string, string>
  isAllRead: boolean
  isAllWrite: boolean
}

export function parsePermissions(permissions: unknown): PermissionScopes {
  if (typeof permissions === "string") {
    if (permissions === "read-all") return { scopes: {}, isAllRead: true, isAllWrite: false }
    if (permissions === "write-all") return { scopes: {}, isAllRead: false, isAllWrite: true }
    return { scopes: {}, isAllRead: false, isAllWrite: false }
  }
  if (permissions && typeof permissions === "object") {
    const scopes: Record<string, string> = {}
    for (const [key, value] of Object.entries(permissions as Record<string, unknown>)) {
      if (typeof value === "string") scopes[key] = value
    }
    return { scopes, isAllRead: false, isAllWrite: false }
  }
  return { scopes: {}, isAllRead: false, isAllWrite: false }
}

export function jobEffectivePermissions(
  job: WorkflowJob,
  topLevel: PermissionScopes,
): PermissionScopes {
  const jobScopes = parsePermissions(job.permissions)
  if (Object.keys(jobScopes.scopes).length > 0) return jobScopes
  if (jobScopes.isAllRead || jobScopes.isAllWrite) return jobScopes
  return topLevel
}

/** All step text (name + run + with values) for a job, lowercased, for gate matching. */
export function jobStepText(job: WorkflowJob): string {
  return (job.steps ?? [])
    .map((s) => {
      const parts: string[] = []
      if (s.name) parts.push(s.name)
      if (s.run) parts.push(s.run)
      if (s.with) parts.push(Object.values(s.with).map(String).join(" "))
      return parts.join(" ")
    })
    .join("\n")
}

export function allJobText(model: WorkflowModel): string {
  return Object.values(model.jobs).map(jobStepText).join("\n")
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
}

export function pathFromRoot(...parts: string[]): string {
  return resolve(REPO_ROOT, ...parts)
}
