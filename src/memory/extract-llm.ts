/**
 * SDK-v2 structured extraction.
 *
 * The v1 plugin client is used only for the lazily-resolved project config;
 * all structured-output requests go through the lazily-created v2 client.
 */
import type { ExtractedFacts } from "../types"
import {
  ExtractedFactsJsonSchema,
  validateStructuredResult,
} from "./extract-schema"
import {
  LLMExtractionCacheEntrySchema,
  type LLMExtractionCacheEntry,
  type MemoryFile,
} from "./schema"
import type { CanonicalExtractionInput } from "./extract-prompt"
import { buildExtractionPrompt, makeExtractionCacheKey } from "./extract-prompt"

export interface SmallModel {
  providerID: string
  modelID: string
}

export interface LLMExtractionConfig {
  enabled: boolean
  model?: SmallModel
  /** A bounded, non-secret explanation when extraction is disabled. */
  reason?: string
}

export interface SanitizedError {
  name: string
  message: string
}

const MAX_DIAGNOSTIC_TEXT = 200

/** Keep diagnostics bounded and limited to an error's name and message. */
export function sanitizeError(error: unknown): SanitizedError {
  const bounded = (value: unknown, fallback: string): string => {
    if (typeof value !== "string" || value.length === 0) return fallback
    return value.slice(0, MAX_DIAGNOSTIC_TEXT)
  }

  if (error instanceof Error) {
    return {
      name: bounded(error.name, "Error"),
      message: bounded(error.message, "Unknown error"),
    }
  }

  if (typeof error === "string") {
    return { name: "Error", message: bounded(error, "Unknown error") }
  }

  if (isRecord(error)) {
    return {
      name: bounded(error.name, "Error"),
      message: bounded(error.message, "Unknown error"),
    }
  }

  return { name: "Error", message: "Unknown error" }
}

// Retained extraction sessions emit their own session.idle event. Keep their
// IDs for the lifetime of this plugin process so the event handler can ignore
// those audit sessions instead of recursively extracting them.
const retainedExtractionSessionIDs = new Set<string>()

/** Whether an idle event belongs to a session created for LLM extraction. */
export function isRetainedExtractionSession(sessionID: string): boolean {
  return retainedExtractionSessionIDs.has(sessionID)
}

/** The small model is provider/model, with the first slash as separator. */
export function parseSmallModel(smallModel: string | undefined): SmallModel | undefined {
  if (typeof smallModel !== "string") return undefined

  const value = smallModel.trim()
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return undefined

  const providerID = value.slice(0, separator).trim()
  const modelID = value.slice(separator + 1).trim()
  if (!providerID || !modelID || /\s/.test(providerID) || /\s/.test(modelID)) return undefined
  return { providerID, modelID }
}

type V2ClientLike = {
  config?: {
    get: (parameters: { directory: string }) => Promise<unknown>
  }
  v2?: {
    model?: {
      list: (parameters: { location: { directory: string } }) => Promise<unknown>
    }
    provider?: {
      list: (parameters: { location: { directory: string } }) => Promise<unknown>
    }
  }
  session?: {
    create: (parameters: {
      directory: string
      title: string
      metadata: Record<string, unknown>
    }) => Promise<unknown>
    prompt: (parameters: {
      sessionID: string
      directory: string
      model: SmallModel
      format: { type: "json_schema"; schema: Record<string, unknown> }
      parts: Array<{ type: "text"; text: string }>
    }) => Promise<unknown>
  }
}

type V1ConfigClientLike = {
  config?: {
    get: (parameters: { query: { directory: string } }) => Promise<unknown>
  }
}

type ProviderInventoryEntry = {
  id: string
  disabled: boolean
}

type ModelInventoryEntry = {
  id: string
  providerID: string
  enabled: boolean
  status: string
  tools: boolean
  cost: unknown[]
}

type ModelDiscoveryResult = {
  model?: SmallModel
  reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readConfiguredModel(result: unknown): SmallModel | undefined {
  if (!isRecord(result) || result.error != null || !isRecord(result.data)) return undefined

  const smallModel = result.data.small_model
  return parseSmallModel(typeof smallModel === "string" ? smallModel : undefined)
}

/** Read the response body used by the v2 inventory endpoints. */
function readInventoryData(result: unknown): unknown[] | undefined {
  if (!isRecord(result) || result.error != null || !isRecord(result.data)) return undefined
  return Array.isArray(result.data.data) ? result.data.data : undefined
}

function readProviderInventoryEntry(value: unknown): ProviderInventoryEntry | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return undefined
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") return undefined
  return { id: value.id, disabled: value.disabled === true }
}

function readModelInventoryEntry(value: unknown): ModelInventoryEntry | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== "string" || value.id.length === 0) return undefined
  if (typeof value.providerID !== "string" || value.providerID.length === 0) return undefined
  if (value.enabled !== true || typeof value.status !== "string" || value.status !== "active") {
    return undefined
  }

  const capabilities = value.capabilities
  if (!isRecord(capabilities) || capabilities.tools !== true) return undefined
  if (!Array.isArray(value.cost) || value.cost.length === 0) return undefined

  return {
    id: value.id,
    providerID: value.providerID,
    enabled: true,
    status: value.status,
    tools: true,
    cost: value.cost,
  }
}

function hasOnlyZeroInputOutputCost(cost: unknown[]): boolean {
  return cost.every((tier) => (
    isRecord(tier) &&
    typeof tier.input === "number" && tier.input === 0 &&
    typeof tier.output === "number" && tier.output === 0
  ))
}

/**
 * Find the first eligible model in the API's release-date order. The endpoint
 * already defines that order; no local quality or provider ranking is applied.
 */
async function discoverFreeSmallModel(
  client: V2ClientLike,
  directory: string,
): Promise<ModelDiscoveryResult> {
  if (!client.v2?.model?.list || !client.v2?.provider?.list) {
    return { reason: "model inventory is unavailable" }
  }

  try {
    const [modelsResult, providersResult] = await Promise.all([
      client.v2.model.list({ location: { directory } }),
      client.v2.provider.list({ location: { directory } }),
    ])
    const models = readInventoryData(modelsResult)
    const providers = readInventoryData(providersResult)
    if (!models || !providers) return { reason: "model inventory response is malformed" }

    const providersByID = new Map<string, ProviderInventoryEntry>()
    for (const value of providers) {
      const provider = readProviderInventoryEntry(value)
      if (provider && !providersByID.has(provider.id)) {
        providersByID.set(provider.id, provider)
      }
    }

    for (const value of models) {
      const model = readModelInventoryEntry(value)
      if (!model) continue

      const provider = providersByID.get(model.providerID)
      if (!provider || provider.disabled || !hasOnlyZeroInputOutputCost(model.cost)) continue

      return {
        model: { providerID: model.providerID, modelID: model.id },
        reason: "eligible model discovered",
      }
    }

    return { reason: "no eligible free model found" }
  } catch {
    // Inventory is optional. A failed or unavailable discovery request must
    // leave the durable heuristic path as the only fallback.
  }

  return { reason: "model inventory request failed" }
}

/** Resolve the opt-in model. This function is only called by session.idle. */
export async function getLLMConfig(
  v2Client: unknown,
  directory = "",
  configClient?: unknown,
): Promise<LLMExtractionConfig> {
  if (process.env.TOKENMAXXER_LLM_EXTRACT !== "1") {
    return { enabled: false, reason: "TOKENMAXXER_LLM_EXTRACT is disabled" }
  }

  try {
    const client = v2Client as V2ClientLike
    let configuredModel: SmallModel | undefined

    // The plugin's v1 client reads the project config through the nested query
    // shape. This is the authoritative source for an explicit small_model,
    // but it must remain inside the session.idle path that calls this helper.
    const v1Client = configClient as V1ConfigClientLike | undefined
    if (v1Client?.config?.get) {
      try {
        configuredModel = readConfiguredModel(
          await v1Client.config.get({ query: { directory } }),
        )
      } catch {
        // An unavailable v1 config endpoint falls through to the v2 attempt.
      }
    }

    // Keep the root-v2 config request as a compatibility fallback for callers
    // that do not expose the v1 client or when its explicit value is absent.
    if (!configuredModel && client.config?.get) {
      try {
        configuredModel ??= readConfiguredModel(await client.config.get({ directory }))
      } catch {
        // A config read failure is equivalent to an absent/malformed override;
        // try the dynamic inventory before falling back to heuristics.
      }
    }

    // A syntactically valid explicit override is authoritative and does not
    // need to be present in the inventory response.
    if (configuredModel) return { enabled: true, model: configuredModel }

    const discovered = await discoverFreeSmallModel(client, directory)
    return discovered.model
      ? { enabled: true, model: discovered.model }
      : { enabled: false, reason: discovered.reason }
  } catch {
    return { enabled: false, reason: "model resolution failed" }
  }
}

export type LLMExtractionDiagnostic =
  | {
      kind: "unavailable-client"
      reason: "missing-session-endpoint"
    }
  | {
      kind: "session-create-failed"
      reason: "request-error" | "error-response" | "malformed-response"
      error?: SanitizedError
    }
  | {
      kind: "structured-output-failed"
      attempt: number
      reason: "request-error" | "error-response" | "malformed-response" | "invalid-structured-output"
      error?: SanitizedError
    }
  | {
      kind: "retries-exhausted"
      attempts: number
    }

export type LLMExtractionDiagnosticCallback = (
  diagnostic: LLMExtractionDiagnostic,
) => void | Promise<void>

export interface ExtractFactsLLMOptions {
  /** Project directory required by every flattened v2 request. */
  directory?: string
  /** A validated cache result, checked before creating an audit session. */
  cachedFacts?: ExtractedFacts | null
  /** Optional best-effort callback for bounded extraction diagnostics. */
  onDiagnostic?: LLMExtractionDiagnosticCallback
}

/** Diagnostics must never change extraction behavior, even if a callback fails. */
function emitDiagnostic(
  callback: LLMExtractionDiagnosticCallback | undefined,
  diagnostic: LLMExtractionDiagnostic,
): void {
  if (!callback) return

  try {
    Promise.resolve(callback(diagnostic)).catch(() => {
      // Diagnostics are best effort.
    })
  } catch {
    // Diagnostics are best effort.
  }
}

/**
 * Extract facts through one retained audit session. Prompt errors and invalid
 * structured values share exactly one retry budget.
 */
export async function extractFactsLLM(
  canonicalInput: CanonicalExtractionInput,
  sourceSessionID: string,
  projectName: string,
  v2Client: unknown,
  config: LLMExtractionConfig,
  options?: ExtractFactsLLMOptions,
): Promise<ExtractedFacts | null> {
  if (!config.enabled || !config.model) return null
  if (options?.cachedFacts) return options.cachedFacts

  const client = (v2Client ?? {}) as V2ClientLike
  if (!client.session?.create || !client.session.prompt) {
    emitDiagnostic(options?.onDiagnostic, {
      kind: "unavailable-client",
      reason: "missing-session-endpoint",
    })
    return null
  }

  let extractionSessionID: string | undefined
  try {
    const created = await client.session.create({
      directory: options?.directory ?? "",
      title: `tokenmaxxer extract · ${projectName} · ${sourceSessionID.slice(-8)}`,
      metadata: {
        tokenmaxxer: {
          kind: "llm-extraction",
          sourceSessionID,
        },
      },
    })
    const response = created as { data?: { id?: unknown }; error?: unknown } | null
    if (!response || response.error != null || typeof response.data?.id !== "string") {
      emitDiagnostic(options?.onDiagnostic, {
        kind: "session-create-failed",
        reason: response?.error != null
          ? "error-response"
          : "malformed-response",
        ...(response?.error != null ? { error: sanitizeError(response.error) } : {}),
      })
      return null
    }
    extractionSessionID = response.data.id
    retainedExtractionSessionIDs.add(extractionSessionID)
  } catch (error) {
    emitDiagnostic(options?.onDiagnostic, {
      kind: "session-create-failed",
      reason: "request-error",
      error: sanitizeError(error),
    })
    return null
  }

  const promptParameters = {
    sessionID: extractionSessionID,
    directory: options?.directory ?? "",
    model: config.model,
    format: {
      type: "json_schema" as const,
      schema: ExtractedFactsJsonSchema,
    },
    parts: [{ type: "text" as const, text: buildExtractionPrompt(canonicalInput) }],
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await client.session.prompt(promptParameters)
      const response = result as {
        data?: { info?: { structured?: unknown; error?: unknown } }
        error?: unknown
      } | null

      // v2 may return an SDK error field without throwing. It is a failed
      // attempt even if a partial data object happens to be present.
      if (!response || response.error != null || response.data?.info?.error != null) {
        const responseError = response?.error ?? response?.data?.info?.error
        emitDiagnostic(options?.onDiagnostic, {
          kind: "structured-output-failed",
          attempt: attempt + 1,
          reason: !response ? "malformed-response" : "error-response",
          ...(responseError != null ? { error: sanitizeError(responseError) } : {}),
        })
        continue
      }

      // Structured output is the only response value that is inspected. In
      // particular, assistant text and free-form JSON are never fallbacks.
      const facts = validateStructuredResult(response.data?.info?.structured)
      if (facts) return facts
      emitDiagnostic(options?.onDiagnostic, {
        kind: "structured-output-failed",
        attempt: attempt + 1,
        reason: response?.data?.info?.structured === undefined
          ? "malformed-response"
          : "invalid-structured-output",
      })
    } catch (error) {
      emitDiagnostic(options?.onDiagnostic, {
        kind: "structured-output-failed",
        attempt: attempt + 1,
        reason: "request-error",
        error: sanitizeError(error),
      })
      // Thrown request errors, including StructuredOutputError, use the same
      // one-retry budget as an SDK error field or invalid structured output.
    }
  }

  emitDiagnostic(options?.onDiagnostic, { kind: "retries-exhausted", attempts: 2 })
  return null
}

/** Return validated facts for a cache key, or null for a stale/malformed entry. */
export function readExtractionCache(
  memory: Pick<MemoryFile, "llm_extraction_cache"> | null | undefined,
  cacheKey: string,
): ExtractedFacts | null {
  for (const candidate of [...(memory?.llm_extraction_cache ?? [])].reverse()) {
    const parsed = LLMExtractionCacheEntrySchema.safeParse(candidate)
    if (parsed.success && parsed.data.cache_key === cacheKey) return parsed.data.facts
  }
  return null
}

/** Build a validated cache entry for a successful extraction. */
export function makeExtractionCacheEntry(args: {
  sourceSessionID: string
  canonicalInput: CanonicalExtractionInput
  model: SmallModel
  facts: ExtractedFacts
  completedAt?: string
}): LLMExtractionCacheEntry {
  return {
    cache_key: makeExtractionCacheKey(
      args.sourceSessionID,
      args.canonicalInput.sha256,
      args.model,
    ),
    source_session_id: args.sourceSessionID,
    canonical_input_sha256: args.canonicalInput.sha256,
    provider_id: args.model.providerID,
    model_id: args.model.modelID,
    completed_at: args.completedAt ?? new Date().toISOString(),
    facts: args.facts,
  }
}

/** Upsert a successful entry while preserving newest-first cache recency. */
export function upsertExtractionCache(
  memory: MemoryFile,
  entry: LLMExtractionCacheEntry,
): MemoryFile {
  const parsed = LLMExtractionCacheEntrySchema.safeParse(entry)
  if (!parsed.success) return memory

  const entries = (memory.llm_extraction_cache ?? [])
    .map((candidate) => LLMExtractionCacheEntrySchema.safeParse(candidate))
    .filter((candidate): candidate is { success: true; data: LLMExtractionCacheEntry } => candidate.success)
    .map((candidate) => candidate.data)
    .filter((candidate) => candidate.cache_key !== parsed.data.cache_key)

  return {
    ...memory,
    llm_extraction_cache: [...entries, parsed.data].slice(-10),
  }
}

export function extractionCacheKey(
  sourceSessionID: string,
  canonicalInput: CanonicalExtractionInput,
  model: SmallModel,
): string {
  return makeExtractionCacheKey(sourceSessionID, canonicalInput.sha256, model)
}
