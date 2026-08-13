# Idea: Human Memory Control Plane

## Summary

Expose TokenMaxxer's authority and provenance model through explicit user controls so memory can be reviewed, corrected, superseded, pinned, forgotten, and conflict-resolved without hand-editing `STATE.json`.

The goal is to make memory governance a first-class feature rather than an internal implementation detail.

## Why this fits TokenMaxxer

CRIP established strong rules around decision authority, human-foundational trust, conflict handling, and provenance. Those rules become much more valuable when users can directly interact with them.

A durable memory system needs an answer to:

> What do I do when TokenMaxxer remembers something incorrectly?

The answer should not be "edit JSON manually."

## Proposed CLI

```bash
tokenmaxxer memory list
tokenmaxxer memory show <id>
tokenmaxxer memory remember --topic "database" --decision "Use PostgreSQL"
tokenmaxxer memory pin <id>
tokenmaxxer memory supersede <id> --with "Use SQLite for local-only mode"
tokenmaxxer memory forget <id>
tokenmaxxer memory conflicts
tokenmaxxer memory resolve <conflict-id>
```

Exact syntax is open; the important part is explicit human intent.

## Proposed agent tools

Potential tools should be narrower than the CLI and preserve human-review boundaries:

```text
request_memory_correction(...)
request_memory_forget(...)
list_memory_conflicts()
```

Direct mutation of trusted human authority by an autonomous agent should remain restricted unless explicitly authorized by the user.

## Core operations

### List / inspect

Show:

- ID;
- topic/type;
- authority status;
- provenance;
- timestamp;
- Git SHA;
- staleness evidence;
- supersession/conflict state;
- hot vs cold storage location.

### Remember

Allow a user to create an explicitly human-authored memory with clear provenance.

### Pin / foundational review

Convert an eligible reviewed memory into trusted human-foundational state using the same tuple required by the authority model.

Do not equate a raw `foundational=true` bit with trusted human authority.

### Supersede

Create a new decision and invalidate/supersede the old one atomically while preserving audit history.

### Forget

Define explicit deletion semantics:

- remove from hot state;
- remove/tombstone cold archive record;
- remove derived search index entries;
- do not silently resurrect from cache/history later.

This should integrate with the privacy/persistence policy idea.

### Resolve conflict

For conflicting trusted-human foundational decisions, present the alternatives and require explicit human selection or replacement.

Example:

```text
Conflict: package manager

[A] Use npm
    human-foundational · 2026-08-01

[B] Use pnpm
    human-foundational · 2026-08-07

Choose authority, replace both, or leave unresolved.
```

## Safety model

Memory mutation commands should distinguish:

```text
read-only operations
human-authoritative mutations
automated suggestions
```

An agent may recommend a correction, but a command that establishes trusted human authority should require direct user action or an unmistakable explicit authorization path.

## Auditability

Every mutation should preserve:

- previous record ID;
- new record ID where applicable;
- actor/provenance;
- timestamp;
- session when applicable;
- Git SHA;
- mutation reason/note where supplied.

A user should be able to answer "why does TokenMaxxer believe this?"

## Acceptance criteria

1. Users can inspect memory without opening `STATE.json`.
2. Human-created memories receive explicit human provenance.
3. Supersession is atomic and preserves history.
4. Forget operations follow documented hot/cold/cache deletion semantics.
5. Trusted-human conflicts cannot be silently resolved by automated extraction.
6. Pin/foundational operations use the canonical trust predicate.
7. CLI output clearly distinguishes raw rows from authoritative decisions.
8. Non-interactive/JSON output is available for scripting where practical.
9. All mutations use the canonical project lock/transaction path.
10. Failed mutations leave the previous state intact.

## Future possibilities

- interactive TUI memory browser;
- conflict-review queue;
- bulk cleanup;
- export/import;
- team-shared memory approval workflow.

## Priority

**Medium-high.** Especially valuable before memory volume grows substantially.

## Status

Idea only. No implementation yet.
