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
    /** References to labelled source-transcript candidates, never raw quotes. */
    evidence_refs: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(3)
      // Legacy full-facts compatibility is retained until the cache wave. The
      // decisions-only LLM schema below has a required, directly inferred
      // evidence_refs field and does not use this compatibility seam.
      .optional()
      .superRefine((refs, ctx) => {
        if (refs === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "evidence refs are required" })
          return
        }
        if (new Set(refs).size !== refs.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "evidence refs must be unique" })
        }
      }),
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
          evidence_refs: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 128 },
          },
          rationale: { type: "string" },
          foundational: { type: "boolean" },
        },
        required: ["topic", "decision", "evidence_refs"],
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

const boundedNonEmpty = (max: number) => z
  .string()
  .max(max)
  .refine((value) => value.trim().length > 0, "must be non-empty")

const evidenceRef = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0, "evidence ref must be non-empty")

/** One evidence-backed decision proposed by the structured LLM extractor. */
export const LLMDecisionSchema = z
  .object({
    topic: boundedNonEmpty(256),
    decision: boundedNonEmpty(500),
    rationale: boundedNonEmpty(500).optional(),
    evidence_refs: z
      .array(evidenceRef)
      .min(1)
      .max(3)
      .refine((refs) => new Set(refs).size === refs.length, "evidence refs must be unique"),
  })
  .strict()

/** Decisions-only structured LLM result. */
export const LLMDecisionFactsSchema = z
  .object({
    decisions: z.array(LLMDecisionSchema).max(10),
  })
  .strict()

export type LLMDecisionFacts = z.infer<typeof LLMDecisionFactsSchema>

/** JSON Schema for the decisions-only structured-output request. */
export const LLMDecisionFactsJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decisions: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string", minLength: 1, maxLength: 256 },
          decision: { type: "string", minLength: 1, maxLength: 500 },
          rationale: { type: "string", minLength: 1, maxLength: 500 },
          evidence_refs: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 128, pattern: "\\S" },
          },
        },
        required: ["topic", "decision", "evidence_refs"],
      },
    },
  },
  required: ["decisions"],
} as const

/** Validate only the decisions-only structured value returned by the SDK. */
export function validateLLMDecisionResult(result: unknown): LLMDecisionFacts | null {
  const parsed = LLMDecisionFactsSchema.safeParse(result)
  return parsed.success ? parsed.data : null
}
