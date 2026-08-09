/**
 * Structured extraction through the client supplied to the plugin.
 *
 * The client is deliberately used lazily: config discovery and all session
 * requests are made only from the session.idle path.
 */
import type { ExtractedFacts } from "../types"
import {
  ExtractedFactsJsonSchema,
  validateStructuredResult,
} from "./extract-schema"
import {
  LLMExtractionCacheEntrySchema,
  type AuditTerminalOutcome,
  type LLMAuditMetadata,
  type LLMExtractionCacheEntry,
  type MemoryFile,
} from "./schema"
import type { CanonicalExtractionInput } from "./extract-prompt"
import { buildExtractionPrompt, makeExtractionCacheKey } from "./extract-prompt"
import { readMemory } from "./store"

export interface SmallModel {
  providerID: string
  modelID: string
  variant?: string
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

/** One extraction transaction per project/source, including direct callers. */
const extractionInFlight = new Map<string, Promise<ExtractedFacts | null>>()

/** Whether an idle event belongs to a session created for LLM extraction. */
export function isRetainedExtractionSession(sessionID: string): boolean {
  return retainedExtractionSessionIDs.has(sessionID)
}

/** Check the durable v2 audit guard used after a plugin/module reload. */
export async function isPersistedRetainedExtractionSession(args: {
  sessionID: string
  worktree: string
  directory: string
}): Promise<boolean> {
  try {
    const memory = await readMemory({ worktree: args.worktree, directory: args.directory })
    return (memory?.llm_extraction_audits ?? []).some(
      (audit) => audit.audit_session_id === args.sessionID,
    )
  } catch {
    return false
  }
}

/** Bounded extraction lifecycle diagnostics for local status consumers. */
export function getLLMExtractionInFlightCount(): number {
  return extractionInFlight.size
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

type V1ClientLike = {
  config?: {
    get: (parameters: { query: { directory: string } }) => Promise<unknown>
  }
  provider?: {
    list: (parameters: { query: { directory: string } }) => Promise<unknown>
  }
  session?: {
    create: (parameters: {
      body: { title: string }
      query: { directory: string }
    }) => Promise<unknown>
    prompt: (parameters: {
      path: { id: string }
      query: { directory: string }
      body: {
        model: SmallModel
        parts: Array<{ type: "text"; text: string }>
      }
    }) => Promise<unknown>
  }
}

type StructuredPromptParameters = {
  path: { id: string }
  query: { directory: string }
  body: {
    model: SmallModel
    parts: Array<{ type: "text"; text: string }>
    format: { type: "json_schema"; schema: Record<string, unknown> }
    variant?: string
  }
}

type StructuredResponseInfo = {
  structured?: unknown
  error?: unknown
}

type ProviderInventoryEntry = {
  id: string
  models: Record<string, unknown>
}

type ProviderInventory = {
  providers: ProviderInventoryEntry[]
  /** Present only when the host returned a valid connected-provider list. */
  connected?: string[]
}

type ConfiguredModelResolution = {
  model?: SmallModel
  reason?: string
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

function readProviderInventory(result: unknown): ProviderInventory | undefined {
  if (!isRecord(result) || result.error != null || !isRecord(result.data)) return undefined
  if (!Array.isArray(result.data.all)) return undefined

  // Array iteration preserves the API's provider order; Object.entries below
  // preserves each provider's model object order.
  const providers = result.data.all.flatMap((value) => {
    if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.models)) return []
    return [{ id: value.id, models: value.models }]
  })

  let connected: string[] | undefined
  if ("connected" in result.data) {
    if (
      Array.isArray(result.data.connected) &&
      result.data.connected.every((providerID): providerID is string => typeof providerID === "string")
    ) {
      connected = result.data.connected
    }
  }

  return { providers, connected }
}

function isFreeToolCallingModel(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.status !== undefined && value.status !== "active") return false
  const toolCalling = value.tool_call === true || (
    isRecord(value.capabilities) && value.capabilities.toolcall === true
  )
  if (!toolCalling) return false
  if (!isRecord(value.cost)) return false
  return value.cost.input === 0 && value.cost.output === 0
}

function readNoneVariant(value: unknown): "none" | undefined {
  if (!isRecord(value) || !isRecord(value.variants)) return undefined
  return isRecord(value.variants.none) ? "none" : undefined
}

function withInventoryVariant(model: SmallModel, inventoryModel: unknown): SmallModel {
  const variant = readNoneVariant(inventoryModel)
  return variant ? { ...model, variant } : model
}

async function resolveConfiguredModelVariant(
  client: V1ClientLike,
  directory: string,
  model: SmallModel,
): Promise<ConfiguredModelResolution> {
  if (!client.provider?.list) return { model }

  try {
    const inventory = readProviderInventory(
      await client.provider.list({ query: { directory } }),
    )
    if (!inventory) return { model }

    if (inventory.connected !== undefined && !inventory.connected.includes(model.providerID)) {
      return { reason: "provider is not connected" }
    }

    const provider = inventory.providers.find((candidate) => candidate.id === model.providerID)
    if (!provider) return { model }
    const inventoryModel = Object.entries(provider.models).find(([modelKey, value]) => (
      modelKey === model.modelID || (isRecord(value) && value.id === model.modelID)
    ))?.[1]
    return { model: withInventoryVariant(model, inventoryModel) }
  } catch {
    // An explicit model remains valid when optional inventory lookup fails.
    return { model }
  }
}

/**
 * Find the first eligible model in provider order, then model object order.
 * No local ranking or paid-model fallback is applied.
 */
async function discoverFreeSmallModel(
  client: V1ClientLike,
  directory: string,
): Promise<ModelDiscoveryResult> {
  if (!client.provider?.list) return { reason: "model inventory is unavailable" }

  try {
    const inventory = readProviderInventory(
      await client.provider.list({ query: { directory } }),
    )
    if (!inventory) return { reason: "model inventory response is malformed" }

    let firstEligible: SmallModel | undefined
    for (const provider of inventory.providers) {
      if (inventory.connected !== undefined && !inventory.connected.includes(provider.id)) continue
      for (const [modelID, model] of Object.entries(provider.models)) {
        if (!modelID || !isFreeToolCallingModel(model)) continue
        const valueModelID = isRecord(model) && typeof model.id === "string" && model.id.length > 0
          ? model.id
          : modelID
        const candidate = withInventoryVariant(
          { providerID: provider.id, modelID: valueModelID },
          model,
        )
        if (candidate.variant === "none") {
          return { model: candidate, reason: "eligible model discovered" }
        }
        firstEligible ??= candidate
      }
    }

    if (firstEligible) {
      return { model: firstEligible, reason: "eligible model discovered" }
    }
    return {
      reason: inventory.connected !== undefined
        ? "no connected provider has a suitable free tool model"
        : "no eligible free model found",
    }
  } catch {
    // Discovery is optional. A failed request leaves heuristic persistence as
    // the only fallback.
    return { reason: "model inventory request failed" }
  }
}

/** Resolve the opt-in model. This function is only called by session.idle. */
export async function getLLMConfig(
  clientValue: unknown,
  directory = "",
): Promise<LLMExtractionConfig> {
  if (process.env.TOKENMAXXER_LLM_EXTRACT !== "1") {
    return { enabled: false, reason: "TOKENMAXXER_LLM_EXTRACT is disabled" }
  }

  const client = (clientValue ?? {}) as V1ClientLike
  let configuredModel: SmallModel | undefined

  if (client.config?.get) {
    try {
      configuredModel = readConfiguredModel(
        await client.config.get({ query: { directory } }),
      )
    } catch {
      // A config read failure is equivalent to an absent/malformed override;
      // try discovery before falling back to heuristics.
    }
  }

  // A syntactically valid explicit override is authoritative for model choice;
  // a valid connected-provider list may still reject an unavailable provider.
  if (configuredModel) {
    const resolved = await resolveConfiguredModelVariant(client, directory, configuredModel)
    if (resolved.reason) return { enabled: false, reason: resolved.reason }
    return {
      enabled: true,
      model: resolved.model,
    }
  }

  const discovered = await discoverFreeSmallModel(client, directory)
  return discovered.model
    ? { enabled: true, model: discovered.model }
    : { enabled: false, reason: discovered.reason }
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
  | {
      kind: "audit-registration-failed"
    }

export type LLMExtractionDiagnosticCallback = (
  diagnostic: LLMExtractionDiagnostic,
) => void | Promise<void>

export type AuditCreatedCallback = (
  audit: LLMAuditMetadata,
) => boolean | void | Promise<boolean | void>

export type AuditTerminalCallback = (
  auditSessionID: string,
  outcome: Exclude<AuditTerminalOutcome, "pending">,
) => void | Promise<void>

export interface ExtractFactsLLMOptions {
  /** Project directory required by every v1 request. */
  directory?: string
  /** Stable resolved project key for process-local in-flight coalescing. */
  projectKey?: string
  /** A validated cache result, checked before creating an audit session. */
  cachedFacts?: ExtractedFacts | null
  /** Optional best-effort callback for bounded extraction diagnostics. */
  onDiagnostic?: LLMExtractionDiagnosticCallback
  /** Persist the guard before the first audit prompt. Returning false aborts. */
  onAuditCreated?: AuditCreatedCallback
  /** Persist the terminal state after structured extraction completes. */
  onAuditTerminal?: AuditTerminalCallback
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
  clientValue: unknown,
  config: LLMExtractionConfig,
  options?: ExtractFactsLLMOptions,
): Promise<ExtractedFacts | null> {
  if (!config.enabled || !config.model) return null
  if (options?.cachedFacts) return options.cachedFacts

  const projectKey = options?.projectKey ?? options?.directory ?? projectName
  const inFlightKey = `${projectKey}\u0000${sourceSessionID}`
  const existing = extractionInFlight.get(inFlightKey)
  if (existing) return existing

  let promise!: Promise<ExtractedFacts | null>
  promise = (async () => {
    try {
      return await extractFactsLLMOnce(
        canonicalInput,
        sourceSessionID,
        projectName,
        clientValue,
        config,
        options,
      )
    } finally {
      if (extractionInFlight.get(inFlightKey) === promise) {
        extractionInFlight.delete(inFlightKey)
      }
    }
  })()
  extractionInFlight.set(inFlightKey, promise)
  return promise
}

async function extractFactsLLMOnce(
  canonicalInput: CanonicalExtractionInput,
  sourceSessionID: string,
  projectName: string,
  clientValue: unknown,
  config: LLMExtractionConfig,
  options?: ExtractFactsLLMOptions,
): Promise<ExtractedFacts | null> {

  if (!config.enabled || !config.model) return null

  const client = (clientValue ?? {}) as V1ClientLike
  if (!client.session?.create || !client.session.prompt) {
    emitDiagnostic(options?.onDiagnostic, {
      kind: "unavailable-client",
      reason: "missing-session-endpoint",
    })
    return null
  }

  let extractionSessionID: string | undefined
  try {
    // The v1 create type omits metadata. Keep the compatibility cast at this
    // call site rather than widening the rest of the client surface.
    const create = client.session.create as unknown as (parameters: {
      body: {
        title: string
        metadata: Record<string, unknown>
      }
      query: { directory: string }
    }) => Promise<unknown>
    const created = await create.call(client.session, {
      body: {
        title: `tokenmaxxer extract · ${projectName} · ${sourceSessionID.slice(-8)}`,
        metadata: {
          tokenmaxxer: {
            kind: "llm-extraction",
            sourceSessionID,
          },
        },
      },
      query: { directory: options?.directory ?? "" },
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
    // Register before the first prompt so the audit session's idle event can
    // never re-enter extraction.
    retainedExtractionSessionIDs.add(extractionSessionID)

    const audit: LLMAuditMetadata = {
      audit_session_id: extractionSessionID,
      source_session_id: sourceSessionID,
      cache_key: makeExtractionCacheKey(
        sourceSessionID,
        canonicalInput.sha256,
        config.model,
      ),
      provider_id: config.model.providerID,
      model_id: config.model.modelID,
      created_at: new Date().toISOString(),
      terminal_outcome: "pending",
    }

    if (options?.onAuditCreated) {
      try {
        const persisted = await options.onAuditCreated(audit)
        if (persisted === false) {
          emitDiagnostic(options.onDiagnostic, { kind: "audit-registration-failed" })
          return null
        }
      } catch {
        emitDiagnostic(options.onDiagnostic, { kind: "audit-registration-failed" })
        return null
      }
    }
  } catch (error) {
    emitDiagnostic(options?.onDiagnostic, {
      kind: "session-create-failed",
      reason: "request-error",
      error: sanitizeError(error),
    })
    return null
  }

  // The v1 prompt type omits structured format. Cast only this request shape;
  // response text is intentionally never inspected as a fallback.
  const prompt = client.session.prompt as unknown as (
    parameters: StructuredPromptParameters,
  ) => Promise<unknown>
  const promptParameters: StructuredPromptParameters = {
    path: { id: extractionSessionID },
    query: { directory: options?.directory ?? "" },
    body: {
      model: {
        providerID: config.model.providerID,
        modelID: config.model.modelID,
      },
      parts: [{ type: "text", text: buildExtractionPrompt(canonicalInput) }],
      format: {
        type: "json_schema",
        schema: ExtractedFactsJsonSchema,
      },
      ...(config.model.variant !== undefined ? { variant: config.model.variant } : {}),
    },
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await prompt.call(client.session, promptParameters)
      const response = result as {
        data?: { info?: unknown }
        error?: unknown
      } | null

      // The SDK may return an error field without throwing. It is a failed
      // attempt even if a partial data object happens to be present.
      const info = response?.data?.info as StructuredResponseInfo | undefined
      if (!response || response.error != null || info?.error != null) {
        const responseError = response?.error ?? info?.error
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
      const structured = info?.structured
      const facts = validateStructuredResult(structured)
      if (facts) {
        await notifyAuditTerminal(options?.onAuditTerminal, extractionSessionID, "success")
        return facts
      }
      emitDiagnostic(options?.onDiagnostic, {
        kind: "structured-output-failed",
        attempt: attempt + 1,
        reason: structured === undefined
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
  await notifyAuditTerminal(options?.onAuditTerminal, extractionSessionID, "failed")
  return null
}

async function notifyAuditTerminal(
  callback: AuditTerminalCallback | undefined,
  auditSessionID: string,
  outcome: Exclude<AuditTerminalOutcome, "pending">,
): Promise<void> {
  if (!callback) return
  try {
    await callback(auditSessionID, outcome)
  } catch {
    // Terminal persistence is best effort and must not alter extraction.
  }
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
