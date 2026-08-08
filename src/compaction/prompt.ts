/**
 * Schema-constrained compaction prompt.
 *
 * Replaces opencode's default compaction prompt with a structured one
 * that constrains what the model includes in the continuation summary.
 * The durable block (project memory) is interpolated at the end and the
 * model is instructed to treat it as recorded observations, not ground truth.
 */

export function buildCompactionPrompt(durable: string): string {
  return `You are generating a continuation prompt for an opencode session that has run out of context window space. The summary you produce REPLACES the entire conversation history for the agent that resumes this work, so it must be self-sufficient.

Produce a summary with EXACTLY these sections, in this order, each prefixed with its header:

## Current task
One paragraph: what we are doing and why. If no clear task, say "No active task."

## Active files
A bullet list. Each line: \`<path> — <why it matters to the current task>\`. Only files the task depends on. Omit files merely read for exploration.

## Locked decisions
A bullet list. Each line: \`<topic>: <decision> (SHA <git_sha>, <date>)\`. Only decisions that are settled and should NOT be relitigated. If none, write "None."

## Open questions
A bullet list of unresolved decisions or questions still in play.

## Blockers
A bullet list. If none, write "None."

## Next steps
A numbered list of the concrete next 1-3 actions to advance the task.

## What NOT to redo
A bullet list of approaches already tried and rejected, with one-line reasons. If none, write "None."

Rules:
- Do NOT include code snippets. Reference file paths + line numbers instead.
- Do NOT include tool outputs. Summarize their conclusions.
- If a section would be empty, write the "None"/"No active task" literal — do not omit the section header.
- Treat the DURABLE CONTEXT block below as **recorded observations from prior sessions**. They are useful but may be stale or incomplete. Verify against the conversation if they conflict. Check git SHAs and timestamps before relying on a decision.

### DURABLE CONTEXT
${durable}`
}
