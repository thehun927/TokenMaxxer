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
import {
  TOOL_LIMITS,
  headPathsSchema,
  headLinesSchema,
  LINE_TRUNCATED_MARKER,
  FILE_TRUNCATED_MARKER,
  TOTAL_TRUNCATED_MARKER,
} from "./bounds"

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

/**
 * One bounded file head before final formatting (plan §7.4).
 * `content` is already limited to `headLinesMax` lines by the caller.
 */
export type HeadFileSection = {
  path: string
  content: string
}

/**
 * Format head-file sections into the model-visible tool result (plan §7.4).
 *
 * Applies three deterministic bounds, in order:
 *   1. each visible line is cut to `headLineChars` and tagged with
 *      `...(line truncated)`;
 *   2. each `### path` section is cut to `headFileOutputChars` and tagged with
 *      `...(file output truncated)`;
 *   3. the joined response is cut to `headTotalOutputChars` and tagged with
 *      `...(head_files output truncated)`.
 *
 * Nothing is ever appended after a truncation marker — hidden tail content is
 * dropped, never included in error strings or diagnostics (hard invariant 12).
 */
export function formatHeadFilesOutput(sections: HeadFileSection[]): string {
  const formatted = sections.map((section) => {
    const header = `### ${section.path}`
    const lines = section.content.split("\n").map((line) =>
      line.length > TOOL_LIMITS.headLineChars
        ? line.slice(0, TOOL_LIMITS.headLineChars) + LINE_TRUNCATED_MARKER
        : line,
    )
    let sectionText = `${header}\n${lines.join("\n")}`
    if (sectionText.length > TOOL_LIMITS.headFileOutputChars) {
      const budget = TOOL_LIMITS.headFileOutputChars - FILE_TRUNCATED_MARKER.length
      sectionText = sectionText.slice(0, budget) + FILE_TRUNCATED_MARKER
    }
    return sectionText
  })

  let result = formatted.join("\n\n")
  if (result.length > TOOL_LIMITS.headTotalOutputChars) {
    const budget = TOOL_LIMITS.headTotalOutputChars - TOTAL_TRUNCATED_MARKER.length
    result = result.slice(0, budget) + TOTAL_TRUNCATED_MARKER
  }
  return result
}

export async function _headFiles(
  args: HeadFilesArgs,
  context: HostProjectContext,
  client: HostClient,
): Promise<string> {
  const sections: HeadFileSection[] = []
  const notes: string[] = []
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
        notes.push(`### ${p}\n(empty or not found)`)
        continue
      }
      // PR 4 §7.4 step 1 — retain at most `headLinesMax` requested lines. The
      // registered schema already bounds `lines` to `headLinesMax`, but the
      // helper is exported for direct tests, so clamp defensively here as well.
      const requested = Math.min(args.lines, TOOL_LIMITS.headLinesMax)
      const allLines = content.split("\n")
      const head = allLines.slice(0, requested)
      const contentText =
        head.join("\n") + (allLines.length > requested ? "\n...(truncated)" : "")
      sections.push({ path: p, content: contentText })
    } catch (e) {
      // PR 4 §13: a host file.read failure is a bounded per-file result, not a
      // thrown error that aborts the whole tool call.
      notes.push(`### ${p}\n(error: ${e})`)
    }
  }
  const formatted = formatHeadFilesOutput(sections)
  return [...(formatted.length > 0 ? [formatted] : []), ...notes].join("\n\n")
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
          paths: headPathsSchema
            .describe("File paths to read; resolved by the host relative to the current tool invocation directory."),
          lines: headLinesSchema
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
