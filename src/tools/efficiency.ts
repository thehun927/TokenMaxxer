/**
 * Efficiency tools — model-side helpers for saving context tokens.
 *
 * Implements §7.1 from docs/IMPLEMENTATION.md.
 * Each tool's execute body is extracted into an inner function (exported)
 * for direct testability without invoking the opencode tool runtime.
 */
import { tool } from "@opencode-ai/plugin"
import { buildDurableBlock } from "../compaction/durable"

// --- Inner functions (exported for testability) ---

export async function _previewCompaction(
  _args: Record<string, never>,
  context: { worktree: string; directory: string; client: unknown },
): Promise<string> {
  try {
    return await buildDurableBlock({
      worktree: context.worktree,
      directory: context.directory,
      client: context.client,
    })
  } catch (e) {
    return `Error previewing compaction: ${String(e)}`
  }
}

export async function _headFiles(
  args: { paths: string[]; lines: number },
  context: { worktree: string; directory: string; client: any },
): Promise<string> {
  const out: string[] = []
  for (const p of args.paths) {
    try {
      const content =
        (await context.client.file.read({ query: { path: p } })).data
          ?.content ?? ""
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
      out.push(`### ${p}\n(error: ${e})`)
    }
  }
  return out.join("\n\n")
}

// --- Tool registration ---

export function registerEfficiencyTools(): {
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
            _args as Record<string, never>,
            {
              worktree: context.worktree,
              directory: context.directory,
              client: (context as any).client,
            },
          )
        },
      }),

      head_files: tool({
        description:
          "Read the first N lines of each file. Use instead of calling `read` on large files when you only need to see the top (imports, exports, config). Call `read` on the full file if you need more.",
        args: {
          paths: tool.schema
            .array(tool.schema.string())
            .describe("File paths, relative to worktree."),
          lines: tool.schema
            .number()
            .default(40)
            .describe("Lines to return per file"),
        },
        async execute(args, context) {
          return _headFiles(args, {
            worktree: context.worktree,
            directory: context.directory,
            client: (context as any).client,
          })
        },
      }),
    },
  }
}
