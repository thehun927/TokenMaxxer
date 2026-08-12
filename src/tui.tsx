/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule as TuiPluginModuleType } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"
import { resolveProjectPath } from "./memory/store"
import { readRecentMemoryCommit } from "./memory/commit-pulse"

// TMTUI-2 (docs/TMTUI/implementation-plan.md §2.6–2.8): the composer status
// element is a finite commit pulse. Idle renders a quiet `memory  ·`; a newly
// detected durable STATE commit plays exactly one `● -> • -> ·` animation.
// There is no continuous blink and no optimistic pulse from `session.idle`.
//
// The TMTUI-2 pulse module (commit-pulse.ts) exports the API consumed here:
//
//   export const MEMORY_COMMIT_RECENT_MS = 2_000
//   export function memoryCommitPulsePath(project: string): string
//   export async function recordMemoryCommit(project: string): Promise<void>
//   export async function readRecentMemoryCommit(
//     project: string,
//     now?: number,
//   ): Promise<number | null>
//
// `readRecentMemoryCommit` returns the marker's `committed_at` only when it is
// a finite number within MEMORY_COMMIT_RECENT_MS of `now`; stale, future, and
// malformed markers return `null`. TMTUI-2 consumes only this reader.

// Baseline poll interval (docs/TMTUI/implementation-plan.md §2.7). The pulse
// marker is durable telemetry, not a hot counter; 500 ms is the documented
// conservative floor. `session.idle` acts purely as a poll accelerator.
const POLL_MS = 500
// Finite local animation stages (docs/TMTUI/implementation-plan.md §2.6):
// bright ~350 ms, fade ~450 ms, idle thereafter (≈800 ms total).
const BRIGHT_MS = 350
const FADE_MS = 450

type PulseStage = "idle" | "bright" | "fade"

function projectFromState(path: { worktree: string; directory: string }): string | null {
  if (typeof path?.directory !== "string" || !path.directory) return null
  if (typeof path.worktree !== "string") return path.directory
  return resolveProjectPath(path.worktree, path.directory)
}

const tui: TuiPluginModuleType["tui"] = async (api) => {
  api.slots.register({
    slots: {
      session_prompt_right: (_context, { session_id }) => {
        const [pulseStage, setPulseStage] = createSignal<PulseStage>("idle")
        const project = projectFromState(api.state.path)

        // Last observed marker timestamp. The same or an older timestamp never
        // retriggers; a newer one restarts the pulse from bright.
        let lastSeenCommitAt = 0
        // Guards against overlapping reads if one poll outlives the interval.
        let pollInFlight = false
        let pulseTimer: ReturnType<typeof setTimeout> | undefined
        let pollTimer: ReturnType<typeof setInterval> | undefined
        let unsubscribe: (() => void) | undefined

        const startPulse = () => {
          if (pulseTimer) clearTimeout(pulseTimer)
          setPulseStage("bright")
          pulseTimer = setTimeout(() => {
            setPulseStage("fade")
            pulseTimer = setTimeout(() => {
              setPulseStage("idle")
              pulseTimer = undefined
            }, FADE_MS)
          }, BRIGHT_MS)
        }

        const poll = () => {
          if (!project || pollInFlight) return
          pollInFlight = true
          void readRecentMemoryCommit(project)
            .then((committedAt) => {
              if (committedAt !== null && committedAt > lastSeenCommitAt) {
                lastSeenCommitAt = committedAt
                startPulse()
              }
            })
            .catch(() => {
              // Missing/malformed markers and telemetry I/O failures are
              // normal; never invent a pulse from a read error.
            })
            .finally(() => {
              pollInFlight = false
            })
        }

        // `session.idle` is a poll accelerator only (docs/TMTUI/
        // implementation-plan.md §2.7). It never sets the pulse stage, so an
        // idle event alone cannot turn the indicator green.
        unsubscribe = project
          ? api.event.on("session.idle", (event) => {
              if (event.properties.sessionID !== session_id) return
              poll()
            })
          : undefined

        poll()
        pollTimer = setInterval(poll, POLL_MS)

        onCleanup(() => {
          if (pollTimer) clearInterval(pollTimer)
          if (pulseTimer) clearTimeout(pulseTimer)
          unsubscribe?.()
        })

        // Theme-native colors only (docs/TMTUI/implementation-plan.md §2.8):
        // the label and the idle dot use the muted text color; the finite
        // pulse uses the theme's success color. No hard-coded green. The fade
        // stage keeps the theme's success color per the recommended JSX shape.
        const muted = api.theme.current.textMuted
        return (
          <box flexDirection="row">
            <text fg={muted}>memory  </text>
            <text fg={pulseStage() === "idle" ? muted : api.theme.current.success}>
              {pulseStage() === "bright" ? "●" : pulseStage() === "fade" ? "•" : "·"}
            </text>
          </box>
        )
      },
    },
  })
}

const TuiPluginModule: TuiPluginModuleType = {
  id: "tokenmaxxer.tui",
  tui,
}

export default TuiPluginModule
