/**
 * Structured output contract for LLM fact extraction.
 *
 * This module intentionally has no SDK dependency. The JSON Schema is passed
 * to the SDK by the later LLM integration, while the Zod schema validates the
 * value returned by structured output.
 */
import { z } from "zod"

export const ExtractedActiveFileSchema = z
  .object({
    path: z.string(),
    reason: z.string(),
  })
  .strict()

export const ExtractedDecisionSchema = z
  .object({
    topic: z.string(),
    decision: z.string(),
    rationale: z.string().optional(),
    foundational: z.boolean().optional(),
  })
  .strict()

/** The facts shape already used by the heuristic extractor. */
export const ExtractedFactsSchema = z
  .object({
    current_task: z.string().nullable(),
    active_files: z.array(ExtractedActiveFileSchema).max(5),
    decisions: z.array(ExtractedDecisionSchema),
    blockers: z.array(z.string()),
    next_steps: z.array(z.string()).max(5),
  })
  .strict()

export type ExtractedFacts = z.infer<typeof ExtractedFactsSchema>

/**
 * JSON Schema for opencode's `format: { type: "json_schema", schema }`.
 * Keep this declaration dependency-free and in sync with ExtractedFactsSchema.
 */
export const ExtractedFactsJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    current_task: {
      type: ["string", "null"],
    },
    active_files: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          reason: { type: "string" },
        },
        required: ["path", "reason"],
      },
    },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string" },
          decision: { type: "string" },
          rationale: { type: "string" },
          foundational: { type: "boolean" },
        },
        required: ["topic", "decision"],
      },
    },
    blockers: {
      type: "array",
      items: { type: "string" },
    },
    next_steps: {
      type: "array",
      maxItems: 5,
      items: { type: "string" },
    },
  },
  required: [
    "current_task",
    "active_files",
    "decisions",
    "blockers",
    "next_steps",
  ],
}

/** Validate only the structured value returned by the SDK. */
export function validateStructuredResult(result: unknown): ExtractedFacts | null {
  const parsed = ExtractedFactsSchema.safeParse(result)
  return parsed.success ? parsed.data : null
}
