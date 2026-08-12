import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/tui.tsx"],
  outdir: "dist",
  format: "esm",
  target: "bun",
  plugins: [createSolidTransformPlugin()],
  external: [
    "@opencode-ai/plugin",
    "@opencode-ai/plugin/tui",
    "@opentui/solid",
    "@opentui/core",
    "@opentui/keymap",
    "zod",
  ],
})

if (!result.success) {
  console.error("TUI build failed:")
  for (const message of result.logs) {
    console.error(message)
  }
  process.exit(1)
}

console.log("TUI build succeeded")
