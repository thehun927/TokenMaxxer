/**
 * Structured output contract for LLM fact extraction.
 *
 * This module intentionally has no SDK dependency. The JSON Schema is passed
 * to the SDK by the later LLM integration, while the Zod schema validates the
 * value returned by structured output.
 *
 * PR 8 B4 — automatic creation limits are authoritative via
 * MEMORY_CREATION_LIMITS (src/memory/schema.ts). To avoid a circular
 * dependency (schema.ts -> extract-schema.ts for LLMDecisionFactsSchema),
 * the numeric constants are mirrored here and kept in sync via
 * oracle-b4-creation tests. Prefer the shared export when importing from
 * outside this cycle; do not introduce a runtime import of schema.ts here.
 */
import { z } from "zod"

// Mirrored from src/memory/schema.ts MEMORY_CREATION_LIMITS — keep in sync.
const CREATION_LIMITS = {
  currentTaskChars: 512,
  activeFilePathChars: 2_048,
  activeFileReasonChars: 512,
  decisionTopicChars: 256,
  decisionTextChars: 500,
  decisionRationaleChars: 500,
  blockerChars: 512,
  nextStepChars: 512,
  blockersMax: 8,
  nextStepsMax: 8,
  activeFilesMax: 16,
} as const

const boundedNonEmpty = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, "must be non-empty")

const evidenceRef = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0, "evidence ref must be non-empty")

export const ExtractedActiveFileSchema = z
  .object({
    path: boundedNonEmpty(CREATION_LIMITS.activeFilePathChars),
    reason: boundedNonEmpty(CREATION_LIMITS.activeFileReasonChars),
  })
  .strict()

export const ExtractedDecisionSchema = z
  .object({
    topic: boundedNonEmpty(CREATION_LIMITS.decisionTopicChars),
    decision: boundedNonEmpty(CREATION_LIMITS.decisionTextChars),
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
    rationale: boundedNonEmpty(CREATION_LIMITS.decisionRationaleChars).optional(),
    foundational: z.boolean().optional(),
  })
  .strict()

/** The facts shape already used by the heuristic extractor. */
export const ExtractedFactsSchema = z
  .object({
    current_task: z.string().max(CREATION_LIMITS.currentTaskChars).nullable(),
    active_files: z.array(ExtractedActiveFileSchema).max(CREATION_LIMITS.activeFilesMax),
    decisions: z.array(ExtractedDecisionSchema),
    blockers: z
      .array(boundedNonEmpty(CREATION_LIMITS.blockerChars))
      .max(CREATION_LIMITS.blockersMax)
      .refine((arr) => new Set(arr).size === arr.length, "blockers must be unique"),
    next_steps: z
      .array(boundedNonEmpty(CREATION_LIMITS.nextStepChars))
      .max(CREATION_LIMITS.nextStepsMax)
      .refine((arr) => new Set(arr).size === arr.length, "next_steps must be unique"),
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
      maxLength: CREATION_LIMITS.currentTaskChars,
    },
    active_files: {
      type: "array",
      maxItems: CREATION_LIMITS.activeFilesMax,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, maxLength: CREATION_LIMITS.activeFilePathChars },
          reason: { type: "string", minLength: 1, maxLength: CREATION_LIMITS.activeFileReasonChars },
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
          topic: { type: "string", minLength: 1, maxLength: CREATION_LIMITS.decisionTopicChars },
          decision: { type: "string", minLength: 1, maxLength: CREATION_LIMITS.decisionTextChars },
          evidence_refs: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 128 },
          },
          rationale: { type: "string", minLength: 1, maxLength: CREATION_LIMITS.decisionRationaleChars },
          foundational: { type: "boolean" },
        },
        required: ["topic", "decision", "evidence_refs"],
      },
    },
    blockers: {
      type: "array",
      maxItems: CREATION_LIMITS.blockersMax,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: CREATION_LIMITS.blockerChars },
    },
    next_steps: {
      type: "array",
      maxItems: CREATION_LIMITS.nextStepsMax,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: CREATION_LIMITS.nextStepChars },
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
