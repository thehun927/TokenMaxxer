/**
 * PR 7 Wave 5 — Previous-summary recovery for replacement mode.
 *
 * This module provides typed extraction and recovery of completed compaction
 * summaries from session history, which is required for replacement mode to
 * satisfy the repeated-compaction anti-drift invariant.
 *
 * The verified OpenCode minimum host hides prior completed-compaction message
 * pairs before the next compaction. The previous summary is then passed only
 * to the host's native buildPrompt(). If TokenMaxxer replaces output.prompt,
 * that native anchor is bypassed. Therefore replacement mode must recover the
 * prior summary itself.
 */

import type { TranscriptMessage } from "../types"

/**
 * Result of attempting to recover a previous compaction summary.
 */
export type PreviousCompactionSummaryResult =
  | { status: "found"; summary: string }
  | { status: "none" }
  | { status: "unavailable"; reason: string }

/**
 * Extract the latest completed compaction summary from a transcript.
 *
 * Pure extraction that mirrors the verified host semantics closely enough to
 * avoid grabbing arbitrary assistant text:
 *
 * 1. Identify user messages containing a `part.type === "compaction"` marker.
 * 2. Find completed assistant summary messages whose `info.parentID` points to
 *    one of those compaction users.
 * 3. Require assistant role, parentID pointing to a compaction user, and
 *    `info.summary === true`.
 * 4. Skip summaries with truthy `info.error` or `info.incomplete`.
 * 5. Combine non-empty assistant text parts.
 * 6. Select the latest (chronologically last) completed non-empty summary.
 *
 * Does not parse human-readable content to decide what facts mean.
 *
 * @param messages - Transcript messages from client.session.messages()
 * @returns The latest completed compaction summary, or undefined if none found
 */
export function extractLatestCompactionSummary(
  messages: TranscriptMessage[],
): string | undefined {
  // 1. Identify compaction user messages
  const compactionUserIds = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "compaction") {
        compactionUserIds.add(msg.info.id)
        break
      }
    }
  }

  if (compactionUserIds.size === 0) {
    return undefined
  }

  // 2. Find completed assistant summary messages
  const summaries: Array<{ text: string }> = []

  for (const msg of messages) {
    // Must be assistant role
    if (msg.info.role !== "assistant") {
      continue
    }

    // Must have parentID pointing to a compaction user
    const parentID = typeof msg.info.parentID === "string" ? msg.info.parentID : undefined
    if (!parentID || !compactionUserIds.has(parentID)) {
      continue
    }

    // Must have summary flag
    if (!msg.info.summary) {
      continue
    }

    // Must have completed finish flag (OpenCode v1.18.15 semantics)
    if (!msg.info.finish || Boolean(msg.info.finish) !== true) {
      continue
    }

    // Skip summaries with truthy error or incomplete flags
    if (msg.info.error || msg.info.incomplete) {
      continue
    }

    // Combine non-empty text parts
    const textParts = msg.parts
      .filter((p) => p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0)
      .map((p) => String(p.text))

    if (textParts.length === 0) {
      continue
    }

    // Combine text parts (simple concatenation)
    const combinedText = textParts.join("\n")

    summaries.push({ text: combinedText })
  }

  if (summaries.length === 0) {
    return undefined
  }

  // 6. Select the latest (chronologically last) completed non-empty summary
  // Using transcript order (host returns chronological history)
  return summaries[summaries.length - 1].text
}

/**
 * Read the latest completed compaction summary from session history.
 *
 * Uses the verified host surface `client.session.messages({ path: { id: sessionID } })`.
 *
 * - Missing endpoint → unavailable
 * - Throw → unavailable
 * - Malformed response → unavailable
 * - No summary after successful read → none
 * - Summary found → found
 *
 * @param opts - Options including client and sessionID
 * @returns The recovered summary result
 */
export async function readPreviousCompactionSummary(
  opts: {
    client: unknown
    sessionID: string
  },
): Promise<PreviousCompactionSummaryResult> {
  const { client, sessionID } = opts

  try {
    const session = (client as {
      session?: {
        messages?: (args: { path: { id: string } }) => Promise<unknown>
      }
    } | null | undefined)?.session
    if (typeof session?.messages !== "function") {
      return { status: "unavailable", reason: "session.messages unavailable" }
    }

    // Use the verified host surface
    const result = await session.messages({
      path: { id: sessionID },
    })

    // Handle malformed response
    if (result == null) {
      return { status: "unavailable", reason: "session.messages returned no data" }
    }
    if (typeof result !== "object") {
      return { status: "unavailable", reason: "session.messages returned malformed response" }
    }

    // Handle missing data field
    const messages = (result as { data?: unknown }).data
    if (!messages) {
      return { status: "unavailable", reason: "session.messages returned no data" }
    }

    // Handle malformed response (not an array)
    if (!Array.isArray(messages)) {
      return { status: "unavailable", reason: "session.messages returned non-array data" }
    }

    // Extract the latest summary
    const summary = extractLatestCompactionSummary(messages)

    if (!summary) {
      return { status: "none" }
    }

    return { status: "found", summary }
  } catch (error) {
    // Missing endpoint, throw, or malformed response → unavailable
    const reason = error instanceof Error ? error.message : String(error)
    return { status: "unavailable", reason }
  }
}
