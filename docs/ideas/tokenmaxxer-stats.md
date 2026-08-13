# Idea: `tokenmaxxer stats`

## Summary

Add a local-only statistics surface that reports what TokenMaxxer has actually been doing over time.

The purpose is observability, debugging, and product feedback — not vanity metrics or unverifiable token-savings claims.

## Proposed UX

```bash
tokenmaxxer stats
tokenmaxxer stats --json
tokenmaxxer stats --since 7d
```

Example:

```text
TokenMaxxer Stats

Sessions observed                 184
Memory commits                    171
Compactions augmented              23
Heuristic extractions             171
LLM extraction attempts            38
LLM extraction successes           34
LLM fallbacks                       4
Extraction cache hits              19
Recall tool calls                  61
Checkpoints                         7
Archived memory records           912
Unresolved memory conflicts         0
Write failures                      1

Current STATE
  6.3 KiB / 8 KiB
  revision 142
```

## Metrics worth tracking

### Memory lifecycle

- sessions observed;
- successful memory commits;
- no-op/idempotent source skips;
- failed memory commits;
- corruption recoveries;
- STATE revision;
- STATE byte utilization;
- hot-memory prune/archive count.

### Compaction

- compaction hooks observed;
- compactions augmented;
- compatibility/kill-switch mode use;
- durable-context bytes supplied;
- compaction failures where detectable.

### Extraction

- heuristic extraction count;
- LLM extraction attempts;
- structured-output successes;
- validation failures;
- request failures;
- heuristic fallbacks;
- retry count;
- cache hits/misses;
- selected-provider/model counts when LLM extraction is enabled.

Provider/model statistics should be local and informational only; never include credentials or prompt text.

### Recall

- `get_project_state` calls;
- decision recall calls;
- active-file recall calls;
- cold-memory searches;
- failed-approach recalls;
- checkpoint reads.

### Authority / governance

- authoritative decision count;
- trusted human-foundational count;
- unresolved trusted-human conflicts;
- human corrections/supersessions/forgets.

### Cold memory

When implemented:

- archive record count;
- database size;
- archive writes;
- search count;
- search latency summary if useful.

## Storage

Statistics should not inflate `STATE.json` or participate in automatic compaction.

Prefer a separate small local metrics file/database with atomic updates and bounded growth.

Possible approaches:

```text
~/.config/opencode/tokenmaxxer/stats.json
```

for installation-wide operational totals, plus optional project-local counters where project scoping matters.

If cold-memory SQLite already exists, a dedicated metrics table may be appropriate, but stats must remain optional and recoverable.

## Token-savings policy

Avoid claims such as:

```text
TokenMaxxer saved 483,291 tokens
```

unless the product can directly measure the avoided tokens under a documented methodology.

Safe metrics include actual bytes/characters injected, compactions augmented, tool calls, cache hits, and state sizes.

A clearly labeled estimate could be considered later, but should expose its calculation and assumptions.

## Privacy

Stats must never store:

- transcript text;
- memory contents;
- file contents;
- API keys/credentials;
- prompts/results from extraction;
- user queries unless separately and explicitly opted in.

Default stats should be local-only. No telemetry upload is implied by this feature.

## Relationship to `doctor` and `status`

```text
tokenmaxxer_status   -> current project/runtime snapshot
tokenmaxxer doctor   -> diagnostic checks and actionable failures
tokenmaxxer stats    -> accumulated historical operational metrics
```

These should share underlying canonical counters/readers where possible rather than independently redefining the same facts.

## Acceptance criteria

1. Statistics collection cannot break a successful memory commit.
2. Metrics are local-only by default.
3. No user content or credentials are stored in stats.
4. Counters are crash-safe enough to avoid corrupting core memory state.
5. Missing/corrupt stats reset or recover without affecting TokenMaxxer memory.
6. `--json` has stable machine-readable field names once declared stable.
7. Counters clearly distinguish attempts, successes, failures and fallbacks.
8. STATE size/revision shown by stats agrees with canonical state readers.
9. Metric storage has a bounded growth policy.
10. Tests cover concurrent process updates if counters are shared cross-process.

## Priority

**Medium.** Useful for understanding real-world behavior and proving reliability after the core lifecycle features ship.

## Status

Idea only. No implementation yet.
