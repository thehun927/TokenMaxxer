/**
 * Small, local-only signal for idle memory work.
 *
 * The file deliberately contains only a timestamp. It is a hint, not a
 * source of truth: readers treat malformed and old files as inactive.
 */
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { atomicWrite, safeRead } from "../util/fs"

export const MEMORY_ACTIVITY_STALE_MS = 8_000
const REFRESH_MS = 2_000
const ACTIVITY_FILE = ".opencode/.tokenmaxxer-memory-activity"

type ActivityState = {
  references: number
  generation: number
  timer?: ReturnType<typeof setInterval>
}

const states = new Map<string, ActivityState>()

export function memoryActivityPath(project: string): string {
  return join(project, ACTIVITY_FILE)
}

async function removeMarker(project: string): Promise<void> {
  await unlink(memoryActivityPath(project)).catch(() => {})
}

async function refreshMarker(project: string, generation: number): Promise<void> {
  const state = states.get(project)
  if (!state || state.references === 0 || state.generation !== generation) return
  try {
    // Do not add fields here: this file must never carry prompt or transcript data.
    await atomicWrite(memoryActivityPath(project), JSON.stringify({ updated_at: Date.now() }))
    // A very fast completion can race the initial best-effort write. Do not
    // leave a marker behind when there is no newer local activity state.
    if (!states.has(project)) await removeMarker(project)
  } catch {
    // Activity is best effort and must never affect memory writing.
  }
}

/** Mark one locally queued/in-flight idle write as active. */
export function beginMemoryActivity(project: string): () => void {
  const state = states.get(project) ?? { references: 0, generation: 0 }
  state.references += 1
  state.generation += 1
  const generation = state.generation
  states.set(project, state)
  void refreshMarker(project, generation)
  if (!state.timer) {
    state.timer = setInterval(() => void refreshMarker(project, state.generation), REFRESH_MS)
  }

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    state.references = Math.max(0, state.references - 1)
    if (state.references > 0) return
    state.generation += 1
    if (state.timer) clearInterval(state.timer)
    state.timer = undefined
    states.delete(project)
    void removeMarker(project)
  }
}

/** Read the marker without surfacing filesystem or JSON errors to the UI. */
export async function isMemoryActivityFresh(
  project: string,
  now = Date.now(),
): Promise<boolean> {
  let parsed: unknown
  try {
    const raw = await safeRead(memoryActivityPath(project))
    if (!raw) return false
    parsed = JSON.parse(raw)
  } catch {
    await removeMarker(project)
    return false
  }

  const updatedAt = (parsed as { updated_at?: unknown } | null)?.updated_at
  const fresh = typeof updatedAt === "number" && Number.isFinite(updatedAt) &&
    updatedAt <= now && now - updatedAt <= MEMORY_ACTIVITY_STALE_MS
  if (!fresh) await removeMarker(project)
  return fresh
}

/** Test/process cleanup; it does not report errors or touch memory state. */
export function resetMemoryActivity(): void {
  for (const state of states.values()) if (state.timer) clearInterval(state.timer)
  states.clear()
}
