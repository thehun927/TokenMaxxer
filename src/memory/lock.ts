/**
 * Per-project async serialization for idle memory work.
 *
 * This is intentionally process-local.  It is not a distributed lock and it
 * never records request payloads or source text.
 */

export interface ProjectQueueStatus {
  project: string
  /** Jobs waiting for the active project job. */
  queueDepth: number
  /** Distinct source jobs which are queued or currently running. */
  inFlight: number
  /** Currently executing jobs (useful when a source job is queued). */
  active: number
  lastOutcome: string | null
}

interface ProjectQueueState {
  tail: Promise<void>
  queued: number
  active: number
  inFlight: Map<string, Promise<unknown>>
  lastOutcome: string | null
  touchedAt: number
}

const queues = new Map<string, ProjectQueueState>()
const MAX_QUEUE_STATES = 64
const MAX_OUTCOME_LENGTH = 48

function stateFor(project: string): ProjectQueueState {
  const existing = queues.get(project)
  if (existing) {
    existing.touchedAt = Date.now()
    return existing
  }

  const created: ProjectQueueState = {
    tail: Promise.resolve(),
    queued: 0,
    active: 0,
    inFlight: new Map(),
    lastOutcome: null,
    touchedAt: Date.now(),
  }
  queues.set(project, created)
  return created
}

function pruneIdleStates(): void {
  if (queues.size <= MAX_QUEUE_STATES) return
  for (const [project, state] of [...queues.entries()]
    .filter(([, state]) => state.inFlight.size === 0 && state.active === 0)
    .sort(([, a], [, b]) => a.touchedAt - b.touchedAt)) {
    if (queues.size <= MAX_QUEUE_STATES) break
    queues.delete(project)
  }
}

function boundedOutcome(outcome: string): string {
  return outcome.slice(0, MAX_OUTCOME_LENGTH)
}

/**
 * Queue one source-session job.  A second call for the same project/source
 * receives the exact promise already owned by the first call.
 */
export function enqueueProjectJob<T>(
  project: string,
  sourceSessionID: string,
  job: () => Promise<T>,
): Promise<T> {
  const state = stateFor(project)
  const existing = state.inFlight.get(sourceSessionID)
  if (existing) return existing as Promise<T>

  state.queued += 1
  const run = state.tail.then(async () => {
    state.queued = Math.max(0, state.queued - 1)
    state.active += 1
    try {
      return await job()
    } catch (error) {
      state.lastOutcome = "failed"
      throw error
    } finally {
      state.active = Math.max(0, state.active - 1)
      state.inFlight.delete(sourceSessionID)
      state.touchedAt = Date.now()
      pruneIdleStates()
    }
  })

  // A rejected job must not poison the serial tail for later source sessions.
  state.tail = run.then(() => undefined, () => undefined)
  state.inFlight.set(sourceSessionID, run)
  pruneIdleStates()
  return run
}

/** Record a bounded, local-only lifecycle outcome for a project. */
export function setProjectQueueOutcome(project: string, outcome: string): void {
  const state = stateFor(project)
  state.lastOutcome = boundedOutcome(outcome)
  state.touchedAt = Date.now()
}

/** Return queue diagnostics without exposing source or transcript content. */
export function getProjectQueueStatus(project: string): ProjectQueueStatus {
  const state = queues.get(project)
  if (!state) {
    return {
      project,
      queueDepth: 0,
      inFlight: 0,
      active: 0,
      lastOutcome: null,
    }
  }
  return {
    project,
    queueDepth: state.queued,
    inFlight: state.inFlight.size,
    active: state.active,
    lastOutcome: state.lastOutcome,
  }
}

/** Alias useful to callers that want the generic queue terminology. */
export const getQueueStatus = getProjectQueueStatus

/** Test/process lifecycle reset; it carries no persisted state. */
export function resetProjectQueues(): void {
  queues.clear()
}
