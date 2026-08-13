# Idea: Privacy / Persistence Policy

## Summary

Add an explicit policy layer that controls what TokenMaxxer is allowed to remember, archive, send to optional extraction models, and delete on request.

This becomes increasingly important as TokenMaxxer grows from a small bounded `STATE.json` into deeper cold memory, checkpoints, shared memory, and richer observability.

The goal is to make persistence **predictable, inspectable, and user-controlled**.

## Why this matters

A useful memory system eventually encounters data that should not become durable memory:

- secrets and credentials;
- `.env` contents;
- private keys;
- customer/client identifiers;
- generated build artifacts;
- large logs/tool output;
- specific files or directories;
- entire sessions the user wants excluded;
- content acceptable in local memory but not acceptable to send to an external LLM provider.

Today, keeping memory deliberately small reduces exposure. Deep Recall and Team Memory raise the stakes and therefore need a stronger policy contract.

## Proposed configuration

Illustrative only:

```jsonc
{
  "tokenmaxxer": {
    "memory": {
      "exclude_paths": [
        ".env",
        ".env.*",
        "secrets/**",
        "**/*.pem"
      ],
      "redact_patterns": [
        "(?i)api[_-]?key\\s*[:=]\\s*[^\\s]+"
      ],
      "archive": true,
      "archive_transcripts": false
    },
    "llm_extraction": {
      "exclude_paths": ["customer-data/**"]
    }
  }
}
```

Exact config placement/naming should follow the project's eventual configuration contract.

## Policy dimensions

### 1. Path exclusions

Allow users to declare files/directories whose contents or path-derived observations should not become durable memory.

Examples:

```text
.env
secrets/**
customer-data/**
*.pem
```

Path exclusion should not necessarily prevent TokenMaxxer from remembering a safe high-level fact such as "authentication configuration changed" unless the policy is explicitly strict. The boundary should be documented.

### 2. Redaction

Apply a conservative redaction pass before durable persistence and before optional LLM extraction payload construction.

Built-in detections could include obvious forms of:

- bearer/API tokens;
- private-key blocks;
- common credential assignments;
- connection strings with embedded passwords.

Redaction should be defense-in-depth, not a claim that arbitrary secrets can be perfectly detected.

### 3. LLM-send policy

Local persistence and external model transmission are separate decisions.

A user may reasonably want:

```text
remember locally: yes
send to extraction model: no
```

The policy system should preserve that distinction.

### 4. Session exclusion

Possible commands:

```bash
tokenmaxxer memory exclude-session <id>
tokenmaxxer memory forget-session <id>
```

`exclude-session` prevents future extraction/persistence from that source where technically possible.

`forget-session` removes durable records derived solely from that session according to documented provenance rules.

### 5. Retention

Define optional retention for cold memory/audit data without weakening current-state authority.

Examples:

```text
retain cold observations indefinitely
retain audit extraction sessions under host policy
expire non-foundational cold task snapshots after N days
```

Retention should be explicit and should never accidentally delete current trusted authority merely because it is old.

### 6. Deletion semantics

A real "forget" operation needs to define all derived locations:

```text
STATE.json
cold-memory database
checkpoints if explicitly requested
search indexes
LLM extraction cache
stats containing only aggregate counters (usually unaffected)
shared team memory only through explicit repository edit
```

If a record cannot be removed from an external provider's logs/audit retention, TokenMaxxer should not imply otherwise.

## Proposed CLI

```bash
tokenmaxxer privacy show
tokenmaxxer privacy check <path>
tokenmaxxer memory forget <id>
tokenmaxxer memory forget-session <id>
tokenmaxxer memory purge-archive --before <date>
```

Potential dry-run output:

```text
Forget session ses_123

Would remove:
  2 hot-memory observations
  11 cold-memory records
  1 extraction-cache entry

Would not remove:
  Git-committed shared memory
  OpenCode/provider audit history outside TokenMaxxer's storage

No changes made. Re-run with explicit confirmation to continue.
```

## Human-readable policy inspection

Users should be able to ask why something was or was not stored.

Example:

```text
customer-data/export.csv
  local persistence: denied by exclude_paths
  LLM extraction: denied by exclude_paths
  path metadata: redacted
```

This makes privacy behavior debuggable instead of magical.

## Integration with other ideas

### Deep Recall

Cold storage should obey the same exclusion/redaction contract as hot state.

### Checkpoints

Checkpoint creation must not bypass privacy rules merely because it is explicitly invoked.

### Failed Approaches

Store summarized conclusions, not secret-bearing raw command output.

### Team Memory

Promotion to a git-committed shared file should use the strictest validation and show an exact preview.

### Stats

Operational stats should remain content-free and local-only by default.

## Important boundaries

- Do not promise perfect secret detection.
- Explicit exclusions must take precedence over extraction convenience.
- Privacy checks must occur before model transmission, not only before persistence.
- A failed redaction/policy parser should fail safely under a documented rule.
- Automatic extraction must never override explicit user exclusion.
- Deletion must be provenance-aware so removing one source does not destroy a separately supported human-authoritative fact.

## Acceptance criteria

1. Excluded paths are not persisted according to the documented policy.
2. LLM extraction exclusions are enforced before request construction.
3. Built-in redaction catches tested secret patterns without storing originals in derived memory.
4. Custom malformed redaction rules fail safely and produce actionable diagnostics.
5. `forget` removes all TokenMaxxer-owned derived records promised by the command.
6. Forgetting one session does not remove a decision independently established by another trusted source.
7. Shared git memory is never silently deleted by a local forget command.
8. Dry-run/inspection output clearly describes scope.
9. Privacy configuration is validated by `tokenmaxxer doctor` when implemented.
10. Tests cover hot state, cold state, checkpoints, extraction cache and LLM-send boundaries.

## Priority

**High prerequisite for deep persistence.** A minimal policy should ship before or alongside any feature that materially expands the amount or lifetime of retained data.

## Status

Idea only. No implementation yet.
