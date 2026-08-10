/**
 * Shared tool-bound constants and argument schemas (PR 4 §7, Part C).
 *
 * Hard invariants 11/12: every model-callable string/count argument is bounded
 * at schema validation, and `head_files` model-visible output is deterministically
 * bounded even when a host file contains an extremely long line.
 *
 * All limits live in `TOOL_LIMITS` so tests can pin the intended contract.
 * `decisionIdChars` is aligned with the persistence-side `MAX_IDENTIFIER` from
 * `src/memory/schema.ts` (PR 3's identifier contract) — the drift-prevention
 * fixture in test/tools/bounds.test.ts asserts the two constants stay equal.
 *
 * These are tool-call / tool-response limits (plan §7); they do not replace
 * PR 8's durable-storage and compaction-injection byte budgets.
 *
 * Validator integration (PR 4 Part C deviation, see blockers.md wave-3):
 * `@opencode-ai/plugin@1.18.15` bundles its own `zod@4.1.8` and requires
 * registered `tool()` args to be built from its `tool.schema` instance, so the
 * argument schemas here are built with `tool.schema` rather than the project's
 * direct `zod@3` dependency. The schemas still behave like standard zod
 * schemas (`safeParse` etc.), which is all the fixtures drive.
 *
 * The schemas deliberately REJECT malformed values at the schema boundary —
 * no silent coercion of `0`, negatives, fractions, `Infinity`, or oversized
 * counts (plan §7.1 / §7.3).
 */
import { tool } from "@opencode-ai/plugin"
import { MAX_IDENTIFIER } from "../memory/schema"

export const TOOL_LIMITS = {
  recallQueryChars: 256,
  recallLimitMax: 25,
  decisionIdChars: MAX_IDENTIFIER, // persistence-side identifier contract (PR 3)
  decisionTopicChars: 256,
  headPathCountMax: 16,
  headPathChars: 1024,
  headLinesMax: 200,
  headLineChars: 2_000,
  headFileOutputChars: 16_384,
  headTotalOutputChars: 65_536,
} as const

/** Deterministic marker appended when a single visible line is cut (§7.4). */
export const LINE_TRUNCATED_MARKER = "...(line truncated)"

/** Deterministic marker appended when one file section is cut (§7.4). */
export const FILE_TRUNCATED_MARKER = "...(file output truncated)"

/** Deterministic marker appended when the whole response is cut (§7.4). */
export const TOTAL_TRUNCATED_MARKER = "...(head_files output truncated)"

// --- Portable annotation for the plugin-bundled zod v4 schema type ---
// The inferred types of `tool.schema.*` chains live inside the plugin's nested
// zod package, which is not nameable from this module's `.d.ts` (TS2742).
// `PluginSchema` derives the exact element type that `tool()` args require
// (`$ZodType<unknown, unknown, ...>`) through the plugin's public `tool.schema`
// surface, so the emitted declarations stay portable.

type LooseObjectShape = NonNullable<Parameters<typeof tool.schema.object>[0]>
type RawObjectShape = LooseObjectShape extends (...args: never[]) => infer R ? R : LooseObjectShape
type PluginSchema = RawObjectShape[string]

// --- Recall argument bounds (plan §7.1) ---

export const recallQuerySchema: PluginSchema = tool.schema
  .string()
  .max(TOOL_LIMITS.recallQueryChars)
  .optional()

export const recallLimitSchema: PluginSchema = tool.schema
  .number()
  .int()
  .min(1)
  .max(TOOL_LIMITS.recallLimitMax)
  .default(10)

// --- Review-request bounds (plan §7.2) ---
// Both selectors are optional at the schema boundary: `_recallPromote` enforces
// the exact-one-selector rule at runtime (PR 3 §9). The schema only bounds the
// length of whatever the model supplies.

export const decisionIdSchema: PluginSchema = tool.schema
  .string()
  .min(1)
  .max(TOOL_LIMITS.decisionIdChars)
  .optional()

export const decisionTopicSchema: PluginSchema = tool.schema
  .string()
  .min(1)
  .max(TOOL_LIMITS.decisionTopicChars)
  .optional()

// --- head_files argument bounds (plan §7.3) ---

export const headPathsSchema: PluginSchema = tool.schema
  .array(tool.schema.string().min(1).max(TOOL_LIMITS.headPathChars))
  .min(1)
  .max(TOOL_LIMITS.headPathCountMax)

export const headLinesSchema: PluginSchema = tool.schema
  .number()
  .int()
  .min(1)
  .max(TOOL_LIMITS.headLinesMax)
  .default(40)
