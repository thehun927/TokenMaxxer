# Idea: Memory Staleness Detection

## Summary

Teach TokenMaxxer to distinguish between memory that is merely old and memory whose supporting code has materially changed.

Instead of recalling every prior decision as equally trustworthy, TokenMaxxer could report a lightweight validity signal such as:

```text
VALID
LIKELY STALE
REVIEW NEEDED
```

The goal is not to automatically invalidate human decisions because files changed. The goal is to surface evidence that the context supporting a memory may no longer match the repository.

## Why this matters

A durable memory system creates a new failure mode: **confidently remembering something that used to be true**.

TokenMaxxer already records Git provenance. That makes it possible to answer a much more useful question than "when was this remembered?":

> Has the code this memory was based on changed since it was recorded?

Example:

```text
Decision: keep session authentication in middleware
Recorded at: abc1234
Status: LIKELY STALE
Reason: src/auth.ts and src/session.ts changed in 8 commits since abc1234
```

That is safer than either blindly trusting the old decision or discarding it merely because it is old.

## Proposed UX

Recall surfaces could annotate memory:

```text
postgres: use PostgreSQL for durable metadata
authority: human-foundational
recorded: 2026-08-02 @ 91e7a52
staleness: VALID
```

or:

```text
auth middleware: preserve cookie-session design
recorded: 2026-07-19 @ a913bed
staleness: REVIEW NEEDED
reason: referenced files changed substantially since the recorded SHA
```

Potential command:

```bash
tokenmaxxer memory stale
tokenmaxxer memory inspect <id>
```

## Evidence model

Staleness should be evidence-based and conservative.

Useful signals:

### 1. Referenced-file change

If the memory has explicit related paths, compare those paths between the recorded SHA and current HEAD.

Possible states:

```text
no referenced files changed                -> strong VALID signal
referenced files changed                   -> stale evidence
referenced files deleted/renamed            -> stronger stale evidence
recorded SHA unavailable                    -> REVIEW NEEDED
```

### 2. Scope-aware Git diff

Avoid treating any repository commit as evidence that every memory is stale.

A README change should not stale an authentication decision. Prefer path-specific evidence.

### 3. Age

Age can be displayed, but should be a weak signal. A two-year-old architecture decision may still be perfectly valid.

### 4. Supersession/authority state

A decision already superseded or invalidated should remain governed by the authority model. Staleness is an additional dimension, not a replacement for `still_valid`, conflict resolution, or trusted-human authority.

## Suggested status model

```text
VALID
  Supporting paths unchanged since recorded SHA, or equivalent strong evidence.

LIKELY STALE
  Supporting paths materially changed/deleted/renamed since recorded SHA.

REVIEW NEEDED
  Evidence cannot be established safely: missing SHA, shallow history, unavailable repo state, ambiguous path scope, etc.

UNKNOWN
  No usable Git/path provenance exists.
```

Exact vocabulary is a product decision, but the system should avoid pretending uncertain evidence is definitive.

## Material-change policy

Version 1 should remain simple and deterministic:

- any content change to an explicitly referenced file counts as stale evidence;
- renames should be detected when practical;
- unreferenced memories remain `UNKNOWN`/age-only;
- do not use an LLM to decide semantic equivalence in the first implementation.

Later versions could optionally inspect symbol/range provenance or semantic diffs.

## Integration with Deep Recall

Cold memory makes staleness even more valuable. Search results could rank current/valid memories first while still exposing historically relevant stale records.

Example:

```text
search_memory("auth callback")

1. VALID — decision from current branch
2. LIKELY STALE — older workaround predating auth.ts rewrite
3. SUPERSEDED — original implementation choice
```

## Integration with Checkpoints

Checkpoint retrieval can show drift:

```text
Checkpoint SHA: a1b2c3d
Current SHA:    f9e8d7c
3 checkpoint files changed
1 locked decision has stale evidence
```

## Important boundaries

- File change must not automatically revoke a trusted human decision.
- Staleness must not become hidden automated authority.
- Git failures must fail to `UNKNOWN`/`REVIEW NEEDED`, never falsely `VALID`.
- Non-git projects must continue working without degraded core memory behavior.
- Results must be deterministic for a given repository state.

## Acceptance criteria

1. Unchanged referenced files produce the documented valid signal.
2. Changed referenced files produce stale/review evidence.
3. Deleted and renamed files are handled explicitly.
4. Unrelated repository changes do not stale scoped memories.
5. Missing/unreachable recorded SHAs never produce a false valid result.
6. Non-git projects degrade gracefully.
7. Trusted-human authority remains authority even when stale evidence is shown.
8. Recall, status, checkpoints and cold-memory search use the same staleness vocabulary.
9. Staleness computation is bounded and does not walk unlimited Git history during normal recall.
10. Tests cover shallow clones, detached HEAD, worktrees, dirty files and unavailable historical objects.

## Priority

**High.** This could become a signature TokenMaxxer capability because it turns passive memory into validity-aware memory.

## Status

Idea only. No implementation yet.
