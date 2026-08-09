/**
 * The single compatibility boundary for the host v1 structured-output calls.
 *
 * The generated v1 client type does not describe the JSON-schema request or
 * the structured result currently returned by the host.  Keep those casts and
 * all envelope inspection here.  Callers receive a small typed result and
 * never need to inspect an SDK response body.
 */
import { log } from "../util/log"

export const VERIFIED_HOST_CONTRACT_VERSION = "1.18.15"
export const MINIMUM_HOST_CONTRACT = "1.18"

export type StructuredModel = {
  providerID: string
  modelID: string
}

export type StructuredPromptRequest = {
  sessionID: string
  directory: string
  model: StructuredModel
  prompt: string
  schema: Record<string, unknown>
  variant?: string
}

export type AuditSessionRequest = {
  directory: string
  title: string
  sourceSessionID: string
}

export type LLMAdapterErrorCode =
  | "unavailable-client"
  | "request-error"
  | "error-response"
  | "response-shape-drift"
  | "structured-output-drift"

/** A bounded, typed failure at the host transport boundary. */
export class LLMAdapterError extends Error {
  readonly code: LLMAdapterErrorCode
  readonly stage: "session-create" | "structured-prompt"
  readonly receivedKeys?: string[]
  readonly causeValue?: unknown

  constructor(args: {
    code: LLMAdapterErrorCode
    stage: "session-create" | "structured-prompt"
    message: string
    receivedKeys?: string[]
    causeValue?: unknown
  }) {
    super(args.message)
    this.name = "LLMAdapterError"
    this.code = args.code
    this.stage = args.stage
    this.receivedKeys = args.receivedKeys
    this.causeValue = args.causeValue
  }
}

export type AdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LLMAdapterError }

type V1ClientLike = {
  session?: {
    create?: (parameters: unknown) => Promise<unknown>
    prompt?: (parameters: unknown) => Promise<unknown>
  }
  global?: {
    health?: () => Promise<unknown>
  }
}

export type HostHealthGate = {
  allowed: boolean
  source: "health" | "pinned-compatibility"
  reason:
    | "verified"
    | "health-surface-unavailable"
    | "health-request-failed"
    | "malformed-health"
    | "unhealthy"
    | "unsupported-version"
  hostVersion?: string
}

let cachedHealthGate: HostHealthGate | undefined
let healthGateInFlight: Promise<HostHealthGate> | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clientOf(value: unknown): V1ClientLike | null {
  return isRecord(value) ? (value as V1ClientLike) : null
}

function boundedKeys(value: unknown): string[] | undefined {
  if (!isRecord(value)) return undefined
  return Object.keys(value).slice(0, 16)
}

function adapterError(args: {
  code: LLMAdapterErrorCode
  stage: "session-create" | "structured-prompt"
  message: string
  received?: unknown
  causeValue?: unknown
}): LLMAdapterError {
  return new LLMAdapterError({
    code: args.code,
    stage: args.stage,
    message: args.message,
    ...(args.received !== undefined ? { receivedKeys: boundedKeys(args.received) } : {}),
    ...(args.causeValue !== undefined ? { causeValue: args.causeValue } : {}),
  })
}

function driftFailure<T>(client: unknown, error: LLMAdapterError): AdapterResult<T> {
  void log(client, "debug", "sdk_response_shape_drift", {
    stage: error.stage,
    reason: error.code,
    ...(error.receivedKeys ? { received_keys: error.receivedKeys } : {}),
  })
  return { ok: false, error }
}

/** Create and validate the retained audit session envelope. */
export async function createAuditSession(
  clientValue: unknown,
  request: AuditSessionRequest,
): Promise<AdapterResult<string>> {
  const client = clientOf(clientValue)
  const create = client?.session?.create
  if (!client || typeof create !== "function") {
    return {
      ok: false,
      error: adapterError({
        code: "unavailable-client",
        stage: "session-create",
        message: "host session create endpoint is unavailable",
      }),
    }
  }

  try {
    // The metadata field is part of the host JSON request but is absent from
    // the generated v1 declaration.  This is intentionally the only request
    // cast for session creation.
    const response = await create.call(client.session, {
      body: {
        title: request.title,
        metadata: {
          tokenmaxxer: {
            kind: "llm-extraction",
            sourceSessionID: request.sourceSessionID,
          },
        },
      },
      query: { directory: request.directory },
    } as {
      body: {
        title: string
        metadata: Record<string, unknown>
      }
      query: { directory: string }
    })

    if (!isRecord(response)) {
      return driftFailure(clientValue, adapterError({
        code: "response-shape-drift",
        stage: "session-create",
        message: "host session create response is not an object",
        received: response,
      }))
    }
    if (response.error != null) {
      return {
        ok: false,
        error: adapterError({
          code: "error-response",
          stage: "session-create",
          message: "host session create returned an error",
          causeValue: response.error,
        }),
      }
    }
    if (!isRecord(response.data) || typeof response.data.id !== "string" || response.data.id.length === 0) {
      return driftFailure(clientValue, adapterError({
        code: "response-shape-drift",
        stage: "session-create",
        message: "host session create envelope lacks data.id",
        received: response,
      }))
    }

    return { ok: true, value: response.data.id }
  } catch (error) {
    return {
      ok: false,
      error: adapterError({
        code: "request-error",
        stage: "session-create",
        message: "host session create request failed",
        causeValue: error,
      }),
    }
  }
}

/**
 * Send one structured-only prompt and return exactly info.structured.
 * Assistant text, free-form JSON, and any other response fields are not read.
 */
export async function requestStructuredOutput(
  clientValue: unknown,
  request: StructuredPromptRequest,
): Promise<AdapterResult<unknown>> {
  const client = clientOf(clientValue)
  const prompt = client?.session?.prompt
  if (!client || typeof prompt !== "function") {
    return {
      ok: false,
      error: adapterError({
        code: "unavailable-client",
        stage: "structured-prompt",
        message: "host session prompt endpoint is unavailable",
      }),
    }
  }

  try {
    // `format` and its JSON schema are present in the host v1 wire contract but
    // omitted by the generated declaration.  Keep that compatibility cast in
    // this adapter and nowhere in extraction code.
    const response = await prompt.call(client.session, {
      path: { id: request.sessionID },
      query: { directory: request.directory },
      body: {
        model: request.model,
        parts: [{ type: "text", text: request.prompt }],
        format: { type: "json_schema", schema: request.schema },
        ...(request.variant !== undefined ? { variant: request.variant } : {}),
      },
    } as {
      path: { id: string }
      query: { directory: string }
      body: {
        model: StructuredModel
        parts: Array<{ type: "text"; text: string }>
        format: { type: "json_schema"; schema: Record<string, unknown> }
        variant?: string
      }
    })

    if (!isRecord(response)) {
      return driftFailure(clientValue, adapterError({
        code: "response-shape-drift",
        stage: "structured-prompt",
        message: "host structured response is not an object",
        received: response,
      }))
    }
    if (response.error != null) {
      return {
        ok: false,
        error: adapterError({
          code: "error-response",
          stage: "structured-prompt",
          message: "host structured request returned an error",
          causeValue: response.error,
        }),
      }
    }
    if (!isRecord(response.data) || !isRecord(response.data.info)) {
      return driftFailure(clientValue, adapterError({
        code: "response-shape-drift",
        stage: "structured-prompt",
        message: "host structured response envelope lacks data.info",
        received: response,
      }))
    }
    if (response.data.info.error != null) {
      return {
        ok: false,
        error: adapterError({
          code: "error-response",
          stage: "structured-prompt",
          message: "host structured response info returned an error",
          causeValue: response.data.info.error,
        }),
      }
    }
    if (!Object.prototype.hasOwnProperty.call(response.data.info, "structured")) {
      return driftFailure(clientValue, adapterError({
        code: "structured-output-drift",
        stage: "structured-prompt",
        message: "host structured response envelope lacks data.info.structured",
        received: response.data.info,
      }))
    }
    if (!isRecord(response.data.info.structured)) {
      return driftFailure(clientValue, adapterError({
        code: "structured-output-drift",
        stage: "structured-prompt",
        message: "host structured response data.info.structured is not an object",
        received: response.data.info,
      }))
    }

    return { ok: true, value: response.data.info.structured }
  } catch (error) {
    return {
      ok: false,
      error: adapterError({
        code: "request-error",
        stage: "structured-prompt",
        message: "host structured request failed",
        causeValue: error,
      }),
    }
  }
}

function parseHostVersion(version: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor)
    ? { major, minor }
    : null
}

function healthGateFromResponse(response: unknown): HostHealthGate {
  if (!isRecord(response) || response.error != null || !isRecord(response.data)) {
    return { allowed: false, source: "health", reason: "malformed-health" }
  }

  const health = response.data
  if (!Object.prototype.hasOwnProperty.call(health, "healthy") ||
    !Object.prototype.hasOwnProperty.call(health, "version")) {
    return { allowed: false, source: "health", reason: "malformed-health" }
  }
  if (health.healthy !== true) {
    return { allowed: false, source: "health", reason: "unhealthy" }
  }
  if (typeof health.version !== "string") {
    return { allowed: false, source: "health", reason: "malformed-health" }
  }

  const parsed = parseHostVersion(health.version)
  const minimum = parseHostVersion(MINIMUM_HOST_CONTRACT)
  if (!parsed || !minimum || parsed.major !== minimum.major || parsed.minor < minimum.minor) {
    return {
      allowed: false,
      source: "health",
      reason: "unsupported-version",
      hostVersion: health.version.slice(0, 64),
    }
  }
  return {
    allowed: true,
    source: "health",
    reason: "verified",
    hostVersion: health.version.slice(0, 64),
  }
}

async function readHostHealth(clientValue: unknown): Promise<HostHealthGate> {
  const client = clientOf(clientValue)
  const health = client?.global?.health

  // v1.18.15's generated client does not expose this endpoint.  Proceeding
  // under the exact pinned package contract is the established compatibility
  // policy; newer clients are gated by their explicit health response.
  if (typeof health !== "function") {
    return {
      allowed: true,
      source: "pinned-compatibility",
      reason: "health-surface-unavailable",
    }
  }

  try {
    return healthGateFromResponse(await health.call(client?.global))
  } catch {
    return {
      allowed: false,
      source: "health",
      reason: "health-request-failed",
    }
  }
}

/**
 * Gate structured extraction using the public host health surface when it is
 * present.  The result is process-cached so idle work never probes repeatedly.
 */
export async function getHostStructuredContractGate(
  clientValue: unknown,
): Promise<HostHealthGate> {
  if (cachedHealthGate) return cachedHealthGate
  healthGateInFlight ??= readHostHealth(clientValue)
  try {
    cachedHealthGate = await healthGateInFlight
  } finally {
    healthGateInFlight = undefined
  }
  void log(clientValue, cachedHealthGate.allowed ? "debug" : "warn", "sdk_host_version_gate", {
    reason: cachedHealthGate.reason,
    expected: `>=${MINIMUM_HOST_CONTRACT} (verified ${VERIFIED_HOST_CONTRACT_VERSION})`,
    ...(cachedHealthGate.hostVersion ? { host_version: cachedHealthGate.hostVersion } : {}),
  })
  return cachedHealthGate
}

/** Test-only/process lifecycle reset; no network request is made here. */
export function resetHostStructuredContractGate(): void {
  cachedHealthGate = undefined
  healthGateInFlight = undefined
}
