/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule as TuiPluginModuleType } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"
import { isMemoryActivityFresh } from "./memory/activity-state"
import { resolveProjectPath } from "./memory/store"

const POLL_MS = 1_000
const BLINK_MS = 650
// The idle event and the marker write can happen in either order. Keep the
// optimistic state around long enough for a fast write to be visible at least
// once, while the marker remains the authority for longer-running work.
const OPTIMISTIC_DWELL_MS = 1_500

function projectFromState(path: { worktree: string; directory: string }): string | null {
  if (typeof path?.directory !== "string" || !path.directory) return null
  if (typeof path.worktree !== "string") return path.directory
  return resolveProjectPath(path.worktree, path.directory)
}

const tui: TuiPluginModuleType["tui"] = async (api) => {
  api.slots.register({
    slots: {
      session_prompt_right: (_context, { session_id }) => {
        const [active, setActive] = createSignal(false)
        const [blink, setBlink] = createSignal(true)
        const project = projectFromState(api.state.path)
        let optimisticUntil = 0
        let optimisticTimer: ReturnType<typeof setTimeout> | undefined
        const poll = () => {
          if (!project) return void setActive(false)
          void isMemoryActivityFresh(project).then((durableActive) => {
            // A marker read can finish after an idle event. Never let that
            // older read erase the event's short optimistic signal.
            setActive(durableActive || optimisticUntil > Date.now())
          }).catch(() => {
            // Missing or malformed markers are normal for fast writes.
            setActive(optimisticUntil > Date.now())
          })
        }
        const stopOptimisticActivity = () => {
          optimisticTimer = undefined
          poll()
        }
        const unsubscribe = project
          ? api.event.on("session.idle", (event) => {
              if (event.properties.sessionID !== session_id) return
              optimisticUntil = Date.now() + OPTIMISTIC_DWELL_MS
              setActive(true)
              if (optimisticTimer) clearTimeout(optimisticTimer)
              optimisticTimer = setTimeout(stopOptimisticActivity, OPTIMISTIC_DWELL_MS)
            })
          : undefined
        poll()
        const pollTimer = setInterval(poll, POLL_MS)
        const blinkTimer = setInterval(() => setBlink((value) => !value), BLINK_MS)
        onCleanup(() => {
          clearInterval(pollTimer)
          clearInterval(blinkTimer)
          if (optimisticTimer) clearTimeout(optimisticTimer)
          unsubscribe?.()
        })
        return (
          <>
            <text fg={active() && blink() ? api.theme.current.success : api.theme.current.textMuted}>●</text>
            <text fg={api.theme.current.textMuted}> memory</text>
          </>
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
