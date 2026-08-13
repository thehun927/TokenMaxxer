# Idea: Durable Failed-Approaches Memory

## Summary

Promote "What NOT to redo" from a compaction-summary concept into a durable, queryable memory type.

TokenMaxxer should remember not only successful decisions, but also meaningful approaches that were tried, what symptoms they produced, why they failed, and what ultimately resolved the issue.

The goal is to prevent expensive debugging loops across sessions.

## Why this fits TokenMaxxer

One of the most costly forms of context loss is not forgetting what worked — it is forgetting what has already been disproven.

A later session often repeats the same investigation because the negative result was present only in conversation history or a compaction summary.

Example:

```text
Problem: OpenTUI failed to load libopentui-*.so
Tried: reinstalling OpenCode / suspecting missing embedded library
Result: not root cause
Actual cause: /tmp user quota exhausted; Bun could not extract native library
Resolution: use writable TMPDIR / clear quota pressure
```

That is exactly the kind of hard-earned knowledge TokenMaxxer should preserve.

## Proposed memory object

```ts
type FailedApproach = {
  id: string
  topic: string
  attempt: string
  symptom?: string
  why_failed?: string
  resolution?: string
  related_files?: string[]
  command_fingerprints?: string[]
  timestamp: string
  git_sha?: string
  session_id: string
  source: "heuristic" | "llm" | "human"
  confidence?: "explicit" | "inferred"
  still_relevant?: boolean
}
```

The exact schema is open, but failed approaches should remain distinct from decisions. "We chose X" and "we tried Y and it failed" have different semantics.

## Proposed UX

Agent tool:

```text
recall_attempts(query)
```

CLI:

```bash
tokenmaxxer memory attempts "OpenTUI"
tokenmaxxer memory attempts "release verification"
```

Example result:

```text
Prior failed approaches for "OpenTUI startup":

- Reinstall OpenCode
  Outcome: did not resolve the failure.
  Evidence: embedded library was intact.

- Investigate plugin dependency mismatch
  Outcome: rejected.

Resolution from prior incident:
  /tmp quota exhaustion prevented Bun extraction.
```

## Extraction rules

Failed-approach extraction should be conservative.

Strong signals include explicit statements such as:

- "that didn't work";
- "not the root cause";
- "we ruled out X";
- "reverting this fixed it";
- "the actual issue was Y";
- failed command/tool outcomes followed by an explicit conclusion.

Do not infer a durable failure merely because a command returned non-zero. Many failed commands are incidental exploration.

LLM extraction may improve structure when enabled, but heuristic/human paths must remain useful without a model.

## Relationship to compaction

The existing `What NOT to redo` compaction section can be populated from:

1. current-session explicit failures;
2. a small number of relevant durable failed approaches;
3. only when they are directly relevant to the active task.

Do not dump the entire failure archive into compaction.

## Lifecycle

Recent/relevant failed approaches may live in hot state if budget permits, but Deep Recall cold storage is the natural long-term home.

Old failures should remain searchable even after they no longer deserve automatic compaction priority.

A failure can become obsolete. For example, an approach that failed because of an old upstream bug may work after an upgrade. Therefore support:

```text
still_relevant=false
superseded_by=<id>
```

or an equivalent explicit lifecycle.

## Important boundaries

- A failed approach is evidence, not an absolute prohibition.
- The system should surface when/where it failed so the agent can judge whether conditions changed.
- Human corrections must override automated inference.
- Secrets or giant command outputs must not be persisted as failure memory.
- Store summaries/fingerprints, not unrestricted raw tool output.

## Acceptance criteria

1. Explicitly rejected approaches become queryable durable records.
2. Incidental command failures do not automatically become durable failed approaches.
3. Records preserve session and Git provenance.
4. Recall returns bounded, relevance-ranked results.
5. Obsolete/superseded failed approaches remain historical but are clearly labeled.
6. Compaction only includes failures relevant to the current task.
7. Human-authored corrections can mark an approach relevant/obsolete.
8. Records survive hot-memory pruning when cold storage is enabled.
9. Project isolation follows canonical project identity.
10. Tests cover repeated similar attempts, conflicting conclusions and later successful reuse of a formerly failed approach.

## Priority

**Medium-high.** High practical debugging value and a natural extension of TokenMaxxer's existing compaction schema.

## Status

Idea only. No implementation yet.
