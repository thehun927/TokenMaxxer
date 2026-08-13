# Idea: Deep Recall / Cold Memory Archive

## Summary

Keep `STATE.json` as TokenMaxxer's small, deterministic **hot working set**, while moving history that would otherwise be pruned into a durable **cold-memory archive**.

The goal is to let TokenMaxxer remember hundreds or thousands of prior observations without allowing old history to bloat compaction context or the authoritative state file.

## Why this fits TokenMaxxer

TokenMaxxer is deliberately optimized around a small bounded `STATE.json`. That is excellent for fast reads, deterministic compaction, corruption recovery, and tight context budgets, but it means old information eventually has to leave the hot set.

Today, pruning means information can cease to be conveniently recallable. A cold archive would change pruning from **forgetting** into **tiering**.

```text
current session
    ↓
STATE.json                     hot memory
    ↓ prune/archive
memory-history.sqlite          cold memory
```

`STATE.json` remains the source for automatic compaction and current project state. Cold memory is pull-only.

## Proposed UX

Possible tools/commands:

```text
search_memory(query, type?, since?, limit?)
recall_session(session_id)
recall_history(topic)
```

CLI equivalents could eventually be:

```bash
tokenmaxxer memory search "release verification"
tokenmaxxer memory history "database"
tokenmaxxer memory session <id>
```

Example agent result:

```text
3 archived matches for "OpenTUI startup":

1. 2026-08-11 — /tmp quota exhaustion prevented Bun native-library extraction.
2. 2026-07-29 — TUI dependency mismatch investigated and rejected as root cause.
3. 2026-07-28 — OpenTUI plugin installation verified healthy.
```

## Storage model

Prefer a local SQLite database initially.

Reasons:

- transactional;
- compact;
- easy schema evolution;
- built-in indexing;
- FTS5 provides high-quality lexical search without another model or embedding dependency;
- straightforward retention and deletion semantics.

An append-only JSONL export can be supported later for portability/debugging, but should not be the primary query store.

### Initial record types

Archive durable objects rather than raw transcripts by default:

- decisions and superseded decisions;
- current-task snapshots;
- active-file observations;
- blockers;
- next steps;
- failed approaches;
- checkpoint metadata;
- session summaries;
- provenance/session/Git metadata.

Raw transcript archival should be a separate explicit policy because it materially changes privacy and disk-use expectations.

## Search strategy

### Phase 1 — deterministic lexical search

Use SQLite FTS over normalized text plus structured filters.

Support filters such as:

```text
type=decision
session=<id>
since=<timestamp>
before=<timestamp>
path=<file>
git_sha=<sha>
```

This keeps the first version dependency-free and auditable.

### Phase 2 — optional semantic search

Embeddings/vector search can be added later as an optional accelerator, not as the only retrieval mechanism.

Lexical/structured search must remain available so recall never depends on a model provider.

## Hot/cold lifecycle

When memory-budget enforcement removes an eligible historical row from `STATE.json`:

1. serialize the durable object;
2. insert/upsert it into cold storage transactionally;
3. only then remove it from the hot representation;
4. preserve stable IDs and provenance across both tiers.

Foundational or otherwise protected hot-state objects should continue following the existing authority/budget rules rather than being silently displaced merely because cold storage exists.

## Important boundaries

- **Cold memory must never be automatically injected wholesale.** Retrieval is explicit/pull-based.
- Search results must preserve authority/trust metadata. An archived invalid/superseded decision must not be presented as current truth.
- Project identity must use the canonical physical identity contract established by post-CRIP hardening.
- Cold storage failure must not corrupt or block a valid hot-state commit unless the lifecycle contract explicitly requires archival before deletion.
- Privacy/deletion policy must be designed before raw transcript storage is considered.

## Acceptance criteria

1. `STATE.json` remains within its existing hard budget.
2. An object pruned from hot memory remains searchable in cold memory.
3. Superseded/invalid decisions remain distinguishable from authoritative decisions.
4. Search supports deterministic text queries without an LLM.
5. Project A can never return Project B's archive records.
6. Archive corruption or unavailability fails safely and is visible through status/doctor surfaces.
7. Stable IDs and provenance survive hot-to-cold movement.
8. Search result count and byte output are bounded.
9. Archive writes are covered by crash/interruption tests.
10. Existing installs with no archive migrate without losing `STATE.json`.

## Future possibilities

Once the archive exists, it becomes the substrate for:

- memory staleness analysis;
- historical session reconstruction;
- durable failed-approach recall;
- project timelines;
- optional semantic search;
- memory analytics;
- explicit export/import.

## Priority

**High product value.** This is the strongest candidate for the first major feature after post-CRIP hardening.

## Status

Idea only. No implementation yet.
