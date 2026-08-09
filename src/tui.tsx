/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule as TuiPluginModuleType } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"
import { isMemoryActivityFresh } from "./memory/activity-state"
import { resolveProjectPath } from "./memory/store"

const POLL_MS = 1_000
const BLINK_MS = 650

function projectFromState(path: { worktree: string; directory: string }): string | null {
  if (typeof path?.directory !== "string" || !path.directory) return null
  if (typeof path.worktree !== "string") return path.directory
  return resolveProjectPath(path.worktree, path.directory)
}

const tui: TuiPluginModuleType["tui"] = async (api) => {
  api.slots.register({
    slots: {
      session_prompt_right: () => {
        const [active, setActive] = createSignal(false)
        const [blink, setBlink] = createSignal(true)
        const project = projectFromState(api.state.path)
        const poll = () => {
          if (!project) return void setActive(false)
          void isMemoryActivityFresh(project).then(setActive).catch(() => setActive(false))
        }
        poll()
        const pollTimer = setInterval(poll, POLL_MS)
        const blinkTimer = setInterval(() => setBlink((value) => !value), BLINK_MS)
        onCleanup(() => {
          clearInterval(pollTimer)
          clearInterval(blinkTimer)
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
