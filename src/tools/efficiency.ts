/**
 * Efficiency tools — model-side helpers for saving context tokens.
 *
 * Implements §7.1 from docs/IMPLEMENTATION.md.
 * Each tool's execute body is extracted into an inner function (exported)
 * for direct testability without invoking the opencode tool runtime.
 *
 * PR 4 §6 — dependency injection: the supported v1.18.15 `ToolContext` does
 * NOT carry a client (hard invariant 1/7). The legitimate SDK client comes
 * from `PluginInput["client"]` and is injected by closure at registration.
 * Helpers therefore take `(args, context, client)` — `client` is a separate
 * typed parameter, never a property of the context type.
 */
import { tool } from "@opencode-ai/plugin"
import { buildDurableBlock } from "../compaction/durable"
import type { HostClient, HostProjectContext } from "../host/contract"

// --- Inner functions (exported for testability) ---

export type PreviewCompactionArgs = Record<string, never>

export async function _previewCompaction(
  _args: PreviewCompactionArgs,
  context: HostProjectContext,
  client: HostClient,
): Promise<string> {
  try {
    return await buildDurableBlock({
      worktree: context.worktree,
      directory: context.directory,
      client,
    })
  } catch (e) {
    return `Error previewing compaction: ${String(e)}`
  }
}

export type HeadFilesArgs = {
  paths: string[]
  lines: number
}

export async function _headFiles(
  args: HeadFilesArgs,
  context: HostProjectContext,
  client: HostClient,
): Promise<string> {
  const out: string[] = []
  for (const p of args.paths) {
    try {
      // PR 4 §6.2: the closure client is stable, but the request directory is
      // the CURRENT invocation's directory — never process.cwd(), never an
      // init-time directory, never a hand-joined worktree path. The host file
      // API remains the access-policy boundary.
      const content =
        (await client.file.read({
          query: { path: p, directory: context.directory },
        })).data?.content ?? ""
      if (!content) {
        out.push(`### ${p}\n(empty or not found)`)
        continue
      }
      const allLines = content.split("\n")
      const head = allLines.slice(0, args.lines).join("\n")
      out.push(
        `### ${p}\n${head}${
          allLines.length > args.lines ? "\n...(truncated)" : ""
        }`,
      )
    } catch (e) {
      // PR 4 §13: a host file.read failure is a bounded per-file result, not a
      // thrown error that aborts the whole tool call.
      out.push(`### ${p}\n(error: ${e})`)
    }
  }
  return out.join("\n\n")
}

// --- Tool registration ---

export function registerEfficiencyTools(client: HostClient): {
  tool: Record<string, ReturnType<typeof tool>>
} {
  return {
    tool: {
      preview_compaction: tool({
        description:
          "Preview the durable-state block that would be injected at the next compaction. Call when context is getting large to see what would survive before compaction fires.",
        args: {},
        async execute(_args, context) {
          return _previewCompaction(
            _args as PreviewCompactionArgs,
            {
              worktree: context.worktree,
              directory: context.directory,
            },
            client,
          )
        },
      }),

      head_files: tool({
        description:
          "Read the first N lines of each file. Paths are routed through OpenCode using the current tool invocation directory. Use instead of calling `read` on large files when you only need to see the top (imports, exports, config). Call `read` on the full file if you need more.",
        args: {
          paths: tool.schema
            .array(tool.schema.string())
            .describe("File paths to read; resolved by the host relative to the current tool invocation directory."),
          lines: tool.schema
            .number()
            .default(40)
            .describe("Lines to return per file"),
        },
        async execute(args, context) {
          return _headFiles(
            args,
            {
              worktree: context.worktree,
              directory: context.directory,
            },
            client,
          )
        },
      }),
    },
  }
}
