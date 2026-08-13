# Idea: Branch / Worktree Memory Overlays

## Summary

Separate durable **project-wide truth** from **branch/worktree-local task state**.

The project layer should hold repository-wide facts and architectural decisions. A branch/worktree overlay should hold temporary work that is only valid in that line of development.

Conceptually:

```text
project memory
    ↓
branch/worktree overlay
    ↓
current session
```

## Why this matters

A long-lived feature branch can accumulate task state that should not pollute `main`.

Example:

Project-wide:

```text
Use PostgreSQL for durable metadata.
The release workflow signs immutable assets.
```

Feature branch only:

```text
Current task: replace auth middleware.
Active files: src/auth.ts, tests/auth.test.ts.
Temporary blocker: callback fixture is flaky.
```

When the user switches back to `main`, the architectural decisions should remain, but branch-local active-task state should not incorrectly follow them.

## Identity model

This feature should be built only after canonical physical project identity is established by post-CRIP hardening.

Possible identity layers:

```text
physical project identity
branch/ref identity
worktree identity
```

Important cases:

- normal branch checkout;
- detached HEAD;
- Git worktrees;
- branch rename;
- branch deletion;
- non-git projects;
- two worktrees on different branches of the same repository.

## Proposed classification

### Project-wide candidates

- trusted human-foundational decisions;
- architecture decisions explicitly marked project-wide;
- durable operational facts;
- project conventions;
- shared failed approaches where branch-independent.

### Overlay candidates

- current task;
- active files;
- blockers;
- next steps;
- recent branch-local decisions;
- checkpoint state;
- branch-specific failed approaches.

Automated extraction should default ambiguous short-lived task state to the overlay rather than promoting it globally.

## Proposed UX

Status could show:

```text
Project: /repo
Branch: feature/oauth

Project memory:
  6 authoritative decisions
  2 foundational decisions

Branch overlay:
  current task: replace auth middleware
  3 active files
  1 blocker
```

Potential CLI:

```bash
tokenmaxxer memory scope
tokenmaxxer memory promote <id> --scope project
tokenmaxxer memory move <id> --scope branch
```

## Merge behavior

Branch overlay state should not automatically become project truth merely because the branch is merged.

Possible future workflow:

1. detect that branch work is complete/merged;
2. identify candidate durable learnings;
3. ask for or record explicit promotion;
4. archive the transient overlay.

This avoids turning temporary implementation details into permanent project memory.

## Recall behavior

Within a branch/worktree:

1. read project-wide authority;
2. layer applicable branch/worktree state;
3. surface conflicts explicitly;
4. never allow a lower-trust overlay row to silently override trusted project-wide human authority.

## Non-git behavior

Non-git projects should retain the current single-scope behavior. Branch overlays are an enhancement, not a new requirement for basic memory.

## Acceptance criteria

1. Two worktrees from the same repository share project-wide memory.
2. Their current tasks and active files remain isolated.
3. Switching branches does not leak branch-local task state into another branch.
4. Trusted project authority cannot be silently overridden by lower-trust overlay memory.
5. Detached HEAD has a deterministic documented scope.
6. Branch rename/deletion does not corrupt project memory.
7. Non-git projects preserve existing behavior.
8. Checkpoints record the scope they belong to.
9. Cold-memory search can filter by project vs branch/worktree scope.
10. Canonical physical identity prevents symlink/path spelling from creating duplicate project roots.

## Priority

**Medium.** Particularly valuable for developers using parallel Git worktrees or long-running feature branches.

## Status

Idea only. No implementation yet.
