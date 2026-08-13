# Idea: Shareable Team Memory

## Summary

Add an explicitly curated, git-safe shared memory layer for durable project knowledge that should travel with the repository and be available to every developer/agent working on it.

This is not a shared transcript store and not a mechanism for committing local `STATE.json`.

The goal is to capture **institutional project memory** such as architecture decisions, conventions, known traps, and durable operational facts.

## Why this fits TokenMaxxer

TokenMaxxer currently focuses on local per-project continuity. Some remembered facts are valuable beyond one developer's machine:

- "PostgreSQL is the canonical durable store.";
- "Do not reintroduce automatic composer memory injection.";
- "Release assets must be immutable and attestation-verified.";
- "This subsystem intentionally fails open/closed in a specific way.";
- "This workaround was tried and rejected for these reasons."

Those are repository knowledge, not personal session history.

## Proposed model

Keep three concepts separate:

```text
local hot memory      STATE.json                 private/runtime
local cold memory     memory-history.sqlite      private/runtime
shared team memory    .tokenmaxxer/shared.json   explicit/git-safe
```

The shared file should contain only reviewed records intentionally promoted for team use.

## Proposed UX

CLI examples:

```bash
tokenmaxxer team list
tokenmaxxer team promote <memory-id>
tokenmaxxer team add --topic "release policy" --decision "Release assets are immutable"
tokenmaxxer team remove <shared-id>
tokenmaxxer team validate
```

Potential agent-facing read tool:

```text
get_shared_project_memory()
```

Promotion to shared memory should require explicit human action or a clearly reviewable patch.

## Shared schema

Candidate record:

```ts
type SharedMemoryRecord = {
  id: string
  type: "decision" | "convention" | "known_issue" | "failed_approach"
  topic: string
  text: string
  rationale?: string
  related_paths?: string[]
  created_at: string
  reviewed_by?: string
  source_git_sha?: string
  supersedes?: string
}
```

Avoid local-only fields such as:

- OpenCode session IDs;
- absolute machine paths;
- provider/model audit-session IDs;
- local timestamps that expose unnecessary activity detail;
- raw transcript fragments;
- extraction cache metadata.

## Trust model

Shared memory should be treated as human-reviewed project authority, but its exact relationship to local trusted-human foundational memory needs an explicit contract.

A safe initial rule:

- shared records are trusted because they entered through an explicit reviewed repository change;
- local automated extraction may not overwrite them;
- conflicts between shared and local trusted-human authority are surfaced, not silently resolved;
- repository history provides an additional audit trail.

## Git workflow

The shared memory file should be:

- deterministic in formatting/order;
- diff-friendly;
- merge-friendly where possible;
- schema-validated in CI;
- safe to edit/review in pull requests.

A validation command could check:

```bash
tokenmaxxer team validate
```

CI can then reject malformed, duplicate, or contradictory shared records.

## Import into local recall

On read:

1. parse and validate shared memory;
2. merge it through the same authority-resolution concepts used elsewhere;
3. combine with local project/branch memory;
4. preserve the source distinction in output.

Example:

```text
release policy: assets are immutable
source: shared project memory
introduced: commit a1b2c3d
```

## Security and privacy boundaries

Shared memory must be opt-in and curated because the file is designed to be committed.

Never automatically promote:

- transcript text;
- session IDs;
- secrets;
- credentials;
- absolute home paths;
- private issue/customer data;
- automatically inferred personal context.

A promotion operation should run redaction/validation checks and present exactly what will be written.

## Acceptance criteria

1. Shared memory is separate from local `STATE.json` and cold memory.
2. Nothing is promoted automatically.
3. The shared file is deterministic and schema-validated.
4. Session IDs, absolute local paths and extraction cache metadata are rejected/sanitized.
5. Shared decisions cannot be silently overwritten by automated local extraction.
6. Conflicts with local trusted-human authority are explicit.
7. Project clones can read the shared file without any prior local TokenMaxxer state.
8. Invalid shared memory fails safely and does not destroy local memory behavior.
9. `team validate` can run in CI without an LLM/provider.
10. Removal/supersession remains visible through Git history and explicit record semantics.

## Future possibilities

- PR-generated memory change proposals;
- organization policy packs;
- signed shared-memory bundles;
- repository onboarding summaries;
- project-specific agent guidance generated from reviewed shared memory.

## Priority

**Medium / strategic.** Potentially a major differentiator once local memory lifecycle and governance are mature.

## Status

Idea only. No implementation yet.
