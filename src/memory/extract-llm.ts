/**
 * SDK-v2 structured extraction.
 *
 * This module deliberately knows nothing about the v1 plugin client. The v1
 * client is still used by the writer to read the source transcript, while all
 * structured-output requests go through the lazily-created v2 client.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
): Promise<SmallModel | undefined> {
  if (!client.v2?.model?.list || !client.v2?.provider?.list) return undefined

  try {
    const [modelsResult, providersResult] = await Promise.all([
      client.v2.model.list({ location: { directory } }),
      client.v2.provider.list({ location: { directory } }),
    ])
    const models = readInventoryData(modelsResult)
    const providers = readInventoryData(providersResult)
    if (!models || !providers) return undefined

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

      return { providerID: model.providerID, modelID: model.id }
    }
  } catch {
    // Inventory is optional. A failed or unavailable discovery request must
    // leave the durable heuristic path as the only fallback.
  }

  return undefined
}

/** Resolve the opt-in model. This function is only called by session.idle. */
export async function getLLMConfig(
  v2Client: unknown,
  directory = "",
): Promise<LLMExtractionConfig> {
  if (process.env.TOKENMAXXER_LLM_EXTRACT !== "1") return { enabled: false }

  try {
    const client = v2Client as V2ClientLike
    let configuredModel: SmallModel | undefined

    if (client.config?.get) {
      try {
        const result = await client.config.get({ directory })
        const response = result as { data?: { small_model?: unknown }; error?: unknown } | null
        if (response && response.error == null && response.data) {
          configuredModel = parseSmallModel(
            typeof response.data.small_model === "string" ? response.data.small_model : undefined,
          )
        }
      } catch {
        // A config read failure is equivalent to an absent/malformed override;
        // try the dynamic inventory before falling back to heuristics.
      }
    }

    // A syntactically valid explicit override is authoritative and does not
    // need to be present in the inventory response.
    if (configuredModel) return { enabled: true, model: configuredModel }

    const discoveredModel = await discoverFreeSmallModel(client, directory)
    return discoveredModel ? { enabled: true, model: discoveredModel } : { enabled: false }
  } catch {
    return { enabled: false }
  }
}

export interface ExtractFactsLLMOptions {
  /** Project directory required by every flattened v2 request. */
  directory?: string
  /** A validated cache result, checked before creating an audit session. */
  cachedFacts?: ExtractedFacts | null
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

  const client = v2Client as V2ClientLike
  if (!client.session?.create || !client.session.prompt) return null

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
      return null
    }
    extractionSessionID = response.data.id
    retainedExtractionSessionIDs.add(extractionSessionID)
  } catch {
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
        continue
      }

      // Structured output is the only response value that is inspected. In
      // particular, assistant text and free-form JSON are never fallbacks.
      const facts = validateStructuredResult(response.data?.info?.structured)
      if (facts) return facts
    } catch {
      // Thrown request errors, including StructuredOutputError, use the same
      // one-retry budget as an SDK error field or invalid structured output.
    }
  }

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
