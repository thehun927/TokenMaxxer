# Idea: Named Checkpoints / Explicit Handoffs

## Summary

Add explicit, user- or agent-created memory checkpoints that capture a durable handoff state at meaningful moments rather than relying only on automatic `session.idle` extraction.

A checkpoint should answer:

> If work stopped right now, what exact state should the next session resume from?

## Why this fits TokenMaxxer

Automatic idle extraction is useful, but not every idle moment is equally important. Users often know when they are about to cross a dangerous boundary:

- before a large refactor;
- before `/compact`;
- before switching branches/models/agents;
- before ending work for the day;
- after finishing a difficult debugging milestone;
- before trying a risky alternative.

An explicit checkpoint gives TokenMaxxer a human-recognizable restoration point.

## Proposed UX

CLI:

```bash
tokenmaxxer checkpoint "before auth refactor"
tokenmaxxer checkpoints
tokenmaxxer checkpoint show "before auth refactor"
```

Potential agent tools:

```text
save_checkpoint(name, note?)
list_checkpoints()
get_checkpoint(name_or_id)
```

Example:

```text
Checkpoint: before auth refactor
Created: 2026-08-13 00:20
Git SHA: abc1234
Task: replace legacy auth middleware
Files: src/auth.ts, src/session.ts, tests/auth.test.ts
Locked decisions: keep cookie sessions; do not introduce JWT
Blocker: OAuth callback fixture still flaky
Next step: isolate callback test before changing middleware
```

## Checkpoint contents

A checkpoint should snapshot the resolved, user-facing state rather than blindly copy every raw row.

Candidate fields:

```text
id
name
created_at
session_id
git_sha
project identity
branch/worktree identity when available
current_task
active_files
authoritative decisions
blockers
next_steps
failed-approach references
optional human note
STATE revision
```

The stored checkpoint should be immutable by default. Corrections should create a new checkpoint or explicit replacement record rather than silently rewriting historical evidence.

## Creation semantics

Checkpoint creation should:

1. acquire the same project/state authority needed for a coherent read;
2. resolve authoritative decisions using the canonical authority resolver;
3. record the current STATE revision and Git SHA;
4. persist the snapshot atomically;
5. avoid mutating normal current-task/decision state merely because a checkpoint was created.

If a checkpoint is created while a memory write is in flight, the result must correspond to one coherent committed state, never a half-old/half-new mixture.

## Storage

Possible locations:

```text
.opencode/memory/checkpoints/<id>.json
```

or, if Deep Recall ships first, checkpoint records can live in the cold-memory database with a compact index exposed to the hot layer.

Checkpoint data should not count against the normal `STATE.json` hot-memory budget.

## Restore semantics

A checkpoint should initially be **read-only guidance**, not a destructive state rollback.

`get_checkpoint` can provide the snapshot to the agent while clearly labeling:

- checkpoint Git SHA;
- current Git SHA;
- whether files have changed;
- whether remembered decisions are now stale/superseded.

A future explicit restore command could be considered separately, but should never silently overwrite newer authoritative state.

## Acceptance criteria

1. A checkpoint captures one coherent committed STATE revision.
2. Checkpoint creation causes no unrelated STATE revision bump.
3. Names may repeat only under a documented disambiguation policy, or must be unique.
4. Checkpoint retrieval is deterministic and bounded.
5. Historical checkpoints remain immutable unless explicitly deleted.
6. Checkpoints preserve provenance and Git SHA.
7. A checkpoint created in Project A is never visible in Project B.
8. Retrieval clearly distinguishes checkpoint truth from current authoritative truth.
9. Checkpoint creation works with both local and global fallback storage.
10. Interrupted writes cannot leave a valid-looking partial checkpoint.

## Future possibilities

- automatic checkpoint before compaction;
- optional checkpoint before destructive refactors;
- checkpoint diff (`then` vs `now`);
- checkpoint-associated cold-memory timeline;
- explicit handoff export for another developer/agent.

## Priority

**High.** Best built immediately after or alongside Deep Recall.

## Status

Idea only. No implementation yet.
