/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule as TuiPluginModuleType } from "@opencode-ai/plugin/tui"

const tui: TuiPluginModuleType["tui"] = async (api) => {
  api.slots.register({
    slots: {
      session_prompt_right: () => (
        <text fg={api.theme.current.textMuted}>memory</text>
      ),
    },
  })
}

const TuiPluginModule: TuiPluginModuleType = {
  id: "tokenmaxxer.tui",
  tui,
}

export default TuiPluginModule
