/**
 * Compatibility decoder for the v1 provider-list response.
 *
 * The generated client has changed the surrounding envelope and a few model
 * fields over time.  Keep those differences here so discovery never has to
 * guess at an SDK response.  This module deliberately returns metadata only;
 * provider payloads, credentials, and model descriptions are not retained.
 */

const MAX_DIAGNOSTICS = 16
const MAX_IDENTIFIER = 256
const MAX_VARIANTS = 32

export type ProviderInventoryDiagnostic = {
  code:
    | "malformed-envelope"
    | "malformed-provider"
    | "ambiguous-provider-id"
    | "malformed-models"
    | "ambiguous-model-id"
    | "malformed-model"
    | "malformed-connected"
  path: string
  received_keys?: string[]
}

export type NormalizedProviderModel = {
  provider: string
  model: string
  connected: boolean
  active: boolean
  tool_callable: boolean
  zero_cost: boolean
  variants: string[]
  /** Bounded, non-secret metadata useful to local diagnostics. */
  metadata: Record<string, string | number | boolean>
}

export type NormalizedProvider = {
  provider: string
  connected: boolean
  models: NormalizedProviderModel[]
}

export type NormalizedProviderInventory = {
  providers: NormalizedProvider[]
  models: NormalizedProviderModel[]
  /** Flat alias for discovery callers. */
  candidates: NormalizedProviderModel[]
  /** Undefined means the host did not expose a connected list. */
  connected_provider_ids?: string[]
  /** Compatibility alias for callers using the host field name. */
  connected?: string[]
  diagnostics: ProviderInventoryDiagnostic[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const result = value.trim()
  if (!result || result.length > MAX_IDENTIFIER || /\s/.test(result)) return undefined
  return result
}

function receivedKeys(value: unknown): string[] | undefined {
  if (!isRecord(value)) return undefined
  return Object.keys(value)
    .slice(0, 12)
    .map((key) => key.slice(0, 64))
}

function addDiagnostic(
  diagnostics: ProviderInventoryDiagnostic[],
  diagnostic: ProviderInventoryDiagnostic,
): void {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(diagnostic)
}

function readIdentifier(
  value: Record<string, unknown>,
  keys: string[],
): { id?: string; ambiguous: boolean; malformed: boolean } {
  let malformed = false
  const values = keys
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
    .map((key) => {
      const raw = value[key]
      if (raw === undefined || boundedIdentifier(raw) === undefined) malformed = true
      return boundedIdentifier(raw)
    })
    .filter((candidate): candidate is string => candidate !== undefined)
  const distinct = [...new Set(values)]
  return {
    id: distinct[0],
    ambiguous: distinct.length > 1,
    malformed,
  }
}

function connectedList(
  data: Record<string, unknown>,
  diagnostics: ProviderInventoryDiagnostic[],
): string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(data, "connected")) return undefined
  const value = data.connected

  if (Array.isArray(value)) {
    const ids: string[] = []
    for (const [index, item] of value.entries()) {
      const objectIdentifier = isRecord(item)
        ? readIdentifier(item, ["id", "providerID", "provider_id"])
        : undefined
      const id = typeof item === "string"
        ? boundedIdentifier(item)
        : objectIdentifier && !objectIdentifier.malformed && !objectIdentifier.ambiguous
          ? objectIdentifier.id
          : undefined
      if (!id) {
        addDiagnostic(diagnostics, {
          code: "malformed-connected",
          path: `data.connected[${index}]`,
          ...(receivedKeys(item) ? { received_keys: receivedKeys(item) } : {}),
        })
        continue
      }
      if (!ids.includes(id)) ids.push(id)
    }
    return ids
  }

  // A few v1-compatible hosts expose a provider -> connected boolean map.
  if (isRecord(value)) {
    const ids: string[] = []
    for (const [id, connected] of Object.entries(value).slice(0, 128)) {
      if (connected === true && boundedIdentifier(id)) ids.push(id)
    }
    if (Object.values(value).some((item) => typeof item !== "boolean")) {
      addDiagnostic(diagnostics, { code: "malformed-connected", path: "data.connected" })
    }
    return ids
  }

  addDiagnostic(diagnostics, {
    code: "malformed-connected",
    path: "data.connected",
    ...(receivedKeys(value) ? { received_keys: receivedKeys(value) } : {}),
  })
  return undefined
}

function readVariants(value: Record<string, unknown>): string[] {
  const raw = value.variants
  const variants: string[] = []
  if (isRecord(raw)) {
    for (const [name, variant] of Object.entries(raw)) {
      if (variants.length >= MAX_VARIANTS) break
      if (boundedIdentifier(name) && variant !== false && variant !== null && variant !== undefined) {
        variants.push(name)
      }
    }
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (variants.length >= MAX_VARIANTS) break
      const name = typeof item === "string"
        ? boundedIdentifier(item)
        : isRecord(item)
          ? readIdentifier(item, ["id", "name", "variant"]).id
          : undefined
      if (name && !variants.includes(name)) variants.push(name)
    }
  }
  return variants
}

function boundedMetadata(value: Record<string, unknown>): Record<string, string | number | boolean> {
  const metadata: Record<string, string | number | boolean> = {}
  const keys = ["status", "active", "name", "source", "providerID", "provider_id"]
  for (const key of keys) {
    const item = value[key]
    if (typeof item === "string" && item.length > 0) metadata[key] = item.slice(0, 128)
    if (typeof item === "number" && Number.isFinite(item)) metadata[key] = item
    if (typeof item === "boolean") metadata[key] = item
  }
  return metadata
}

function normalizeModel(
  provider: string,
  modelKey: string | undefined,
  raw: unknown,
  path: string,
  diagnostics: ProviderInventoryDiagnostic[],
): NormalizedProviderModel | undefined {
  if (!isRecord(raw)) {
    addDiagnostic(diagnostics, { code: "malformed-model", path, ...(receivedKeys(raw) ? { received_keys: receivedKeys(raw) } : {}) })
    return undefined
  }

  const identifiers = readIdentifier(raw, ["id", "modelID", "model_id"])
  if (identifiers.malformed || identifiers.ambiguous || (modelKey && identifiers.id && modelKey !== identifiers.id)) {
    addDiagnostic(diagnostics, {
      code: identifiers.malformed ? "malformed-model" : "ambiguous-model-id",
      path,
      ...(receivedKeys(raw) ? { received_keys: receivedKeys(raw) } : {}),
    })
    return undefined
  }
  const model = identifiers.id ?? boundedIdentifier(modelKey)
  if (!model) {
    addDiagnostic(diagnostics, {
      code: "malformed-model",
      path,
      ...(receivedKeys(raw) ? { received_keys: receivedKeys(raw) } : {}),
    })
    return undefined
  }

  const active = raw.active === undefined
    ? raw.status === undefined || raw.status === "active"
    : raw.active === true
  const toolCallable = raw.tool_call === true || (
    isRecord(raw.capabilities) && raw.capabilities.toolcall === true
  )
  const cost = isRecord(raw.cost) ? raw.cost : undefined
  const zeroCost = cost !== undefined && cost.input === 0 && cost.output === 0

  return {
    provider,
    model,
    connected: true,
    active,
    tool_callable: toolCallable,
    zero_cost: zeroCost,
    variants: readVariants(raw),
    metadata: boundedMetadata(raw),
  }
}

function normalizeProvider(
  raw: unknown,
  index: number,
  connectedIDs: string[] | undefined,
  diagnostics: ProviderInventoryDiagnostic[],
): NormalizedProvider | undefined {
  if (!isRecord(raw)) {
    addDiagnostic(diagnostics, { code: "malformed-provider", path: `data.all[${index}]` })
    return undefined
  }
  const identifiers = readIdentifier(raw, ["id", "providerID", "provider_id"])
  if (identifiers.malformed || identifiers.ambiguous || !identifiers.id) {
    addDiagnostic(diagnostics, {
      code: identifiers.ambiguous ? "ambiguous-provider-id" : "malformed-provider",
      path: `data.all[${index}]`,
      ...(receivedKeys(raw) ? { received_keys: receivedKeys(raw) } : {}),
    })
    return undefined
  }

  const modelSource = raw.models
  const modelEntries: Array<[string | undefined, unknown]> = []
  if (isRecord(modelSource)) {
    for (const [key, value] of Object.entries(modelSource).slice(0, 256)) modelEntries.push([key, value])
  } else if (Array.isArray(modelSource)) {
    for (const value of modelSource.slice(0, 256)) modelEntries.push([undefined, value])
  } else {
    addDiagnostic(diagnostics, {
      code: "malformed-models",
      path: `data.all[${index}].models`,
      ...(receivedKeys(modelSource) ? { received_keys: receivedKeys(modelSource) } : {}),
    })
    return undefined
  }

  if (connectedIDs === undefined && raw.connected !== undefined && typeof raw.connected !== "boolean") {
    addDiagnostic(diagnostics, {
      code: "malformed-provider",
      path: `data.all[${index}].connected`,
      ...(receivedKeys(raw) ? { received_keys: receivedKeys(raw) } : {}),
    })
    return undefined
  }
  const connected = connectedIDs === undefined
    ? raw.connected !== false
    : connectedIDs.includes(identifiers.id)
  const models: NormalizedProviderModel[] = []
  for (const [modelKey, value] of modelEntries) {
    const model = normalizeModel(
      identifiers.id,
      modelKey,
      value,
      `data.all[${index}].models${modelKey ? `.${modelKey.slice(0, 64)}` : "[]"}`,
      diagnostics,
    )
    if (model) models.push({ ...model, connected })
  }

  return { provider: identifiers.id, connected, models }
}

/**
 * Decode either the raw v1 provider response or its `data` envelope.
 * Valid records are retained when a sibling record is malformed; diagnostics
 * are bounded and identify only the drift category and received keys.
 */
function emptyInventory(diagnostics: ProviderInventoryDiagnostic[]): NormalizedProviderInventory {
  return { providers: [], models: [], candidates: [], diagnostics }
}

export function normalizeProviderInventory(value: unknown): NormalizedProviderInventory {
  const diagnostics: ProviderInventoryDiagnostic[] = []
  if (!isRecord(value) || value.error != null) {
    addDiagnostic(diagnostics, { code: "malformed-envelope", path: "response" })
    return emptyInventory(diagnostics)
  }
  const data = isRecord(value.data) ? value.data : value
  const providersValue = data.all ?? data.providers
  if (!Array.isArray(providersValue)) {
    addDiagnostic(diagnostics, {
      code: "malformed-envelope",
      path: "data.all",
      ...(receivedKeys(data) ? { received_keys: receivedKeys(data) } : {}),
    })
    return emptyInventory(diagnostics)
  }

  const hasConnectedField = Object.prototype.hasOwnProperty.call(data, "connected")
  const connectedIDs = connectedList(data, diagnostics)
  if (hasConnectedField && connectedIDs === undefined) return emptyInventory(diagnostics)
  const providers: NormalizedProvider[] = []
  for (const [index, provider] of providersValue.slice(0, 256).entries()) {
    const normalized = normalizeProvider(provider, index, connectedIDs, diagnostics)
    if (normalized) providers.push(normalized)
  }

  if (providers.length === 0) return emptyInventory(diagnostics)
  return {
    providers,
    models: providers.flatMap((provider) => provider.models),
    candidates: providers.flatMap((provider) => provider.models),
    ...(connectedIDs !== undefined ? { connected_provider_ids: connectedIDs } : {}),
    ...(connectedIDs !== undefined ? { connected: connectedIDs } : {}),
    diagnostics,
  }
}

/** Alias kept for callers that prefer an explicit decode verb. */
export const decodeProviderInventory = normalizeProviderInventory

export function hasVariant(model: NormalizedProviderModel, variant: string): boolean {
  return model.variants.includes(variant)
}

export function isEligibleAutomaticModel(model: NormalizedProviderModel): boolean {
  return model.connected && model.active && model.tool_callable && model.zero_cost
}
