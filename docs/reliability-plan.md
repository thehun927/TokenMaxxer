# tokenmaxxer reliability plan

This is an implementation plan for the next reliability pass. It does not
change the current shipped behavior by itself.

## 1. Scope, evidence, and immutable invariants

### Scope

Resolve four risks without weakening the existing heuristic-first memory loop:

1. duplicate `session.idle` work and source-session races;
2. false or weakly supported LLM memories;
3. SDK response/inventory shape drift at the v1 compatibility boundary; and
4. unstable or misleading model discovery.

### Observed evidence

- A connected `ollama-cloud/gpt-oss:20b` returned `StructuredOutput`.
- tokenmaxxer Zod-validated and merged the facts, persisted an
  `llm_extraction_cache` entry keyed by source session, canonical input, and
  provider/model, and retained an audit session titled
  `tokenmaxxer extract · …`.
- The verified explicit Ollama Cloud model has no `none` variant. Therefore
  `none` is a preference/conditional request variant, not a discovery gate.
- Heuristic facts are written before detached LLM work and remain the safe
  fallback when the feature is off, unavailable, incompatible, or invalid.

### Immutable invariants

- **Heuristic first:** write the heuristic result before any LLM request. A
  failed, timed-out, rejected, or rolled-back LLM attempt cannot erase it.
- **Retained audits:** every cache-miss extraction creates one visible retained
  audit session; extraction sessions are never deleted. Cache hits do not create
  another prompt or audit session.
- **Structured-output only:** accept only the host client's structured result,
  then Zod-validate it. Prose, free-form JSON, and code fences are never result
  fallbacks.
- **No paid automatic fallback:** automatic discovery uses active, connected,
  zero-cost, tool-callable models. It prefers a model advertising `none`, but
  may select another eligible model. An explicit `small_model` always has
  precedence and is never silently replaced.
- **Conditional variant:** send `variant: none` only when the selected model
  advertises that variant. Do not probe for it with extra prompts.
- **No composer injection:** server memory and extraction never write project,
  current-task, or evidence text into the composer. A separate TUI indicator is
  right-side status only.
- **Privacy:** do not log prompts, transcripts, raw structured responses, or
  evidence excerpts. Persist bounded references/digests and the minimum fact
  metadata needed for review and audit.

## 2. Ordered phases

Priority is P0 before any broader rollout. P1 depends on the P0 invariants and
can ship independently after its gates pass.

### P0-A — Serialize idle work and make extraction idempotent

**Dependencies:** none. **Owner files:**

- `src/index.ts`: route each project idle event through the writer queue and
  skip durable audit-session IDs before dispatch.
- `src/memory/writer.ts`: own the per-project serial queue, source-session
  coalescing, and heuristic-first ordering.
- `src/memory/extract-llm.ts`: own the in-flight map and cache-miss/prompt
  transaction.
- `src/memory/store.ts` and `src/memory/schema.ts`: persist bounded audit
  metadata and cache identity.
- `src/tools/status.ts`: expose bounded queue, in-flight, and last-outcome
  diagnostics.
- `test/memory/writer.test.ts`, `test/memory/extract-llm.test.ts`,
  `test/memory/store.test.ts`, and integration fixtures under
  `test/fixtures/llm/`.

**Behavior:**

1. Key a serial queue by resolved project path. All idle writes for one project
   execute in order; different projects remain independent.
2. Coalesce duplicate idle events by `(project, source_session_id)` while the
   first job is queued or running. All callers receive the same outcome.
3. Keep the existing cache identity:
   `source session + SHA-256(canonical input) + provider/model`.
4. On a cache miss, re-read/verify the cache under the queue immediately before
   prompting. After validation and evidence acceptance, upsert idempotently by
   that identity; a retry or duplicate completion cannot append a second entry.
5. Create the retained audit session once, persist its audit metadata before the
   first prompt, and register the ID before prompting. A later `session.idle`
   for that audit ID is skipped.
6. Persist bounded audit metadata so the guard survives plugin reload. At
   minimum store audit session ID, source session ID, cache identity, model,
   creation time, and terminal outcome. Prune oldest completed records only
   after retaining enough metadata to prevent an active audit from re-entering.

**Failure and rollback:**

- If queue state is unavailable, write heuristics and skip detached LLM work;
  never run an un-serialized prompt.
- If audit metadata cannot be atomically persisted, do not send the first
  prompt. Log the reason and retain heuristic facts.
- If a process exits after audit creation but before cache commit, the durable
  audit guard prevents recursive processing after reload; the next source idle
  may retry only after the existing cache identity is checked.
- Unset `TOKENMAXXER_LLM_EXTRACT` to disable all LLM work without disabling
  heuristic memory or tools.

**Observability:** emit bounded structured events such as
`idle_queued`, `idle_coalesced`, `audit_guard_skip`, `cache_hit`,
`cache_commit`, `llm_started`, and `llm_terminal`. Include project digest,
source/audit session IDs, cache-key digest, model, queue duration, and outcome;
never include transcript or response text.

**Acceptance gates:**

- **Unit:** two concurrent idle events for the same source invoke one
  extraction and one cache commit; two different source sessions are serialized
  and both commit; different projects run independently; repeated completion is
  idempotent.
- **Integration:** reload with persisted audit metadata, deliver the audit
  session's idle event, and prove no writer/prompt is started. Simulate exit
  between audit registration and cache commit and verify heuristic state stays
  readable.
- **Live:** perform one real extraction, repeat the same source/input/model,
  and prove the second run is a cache hit with no new prompt and no additional
  `tokenmaxxer extract · …` session.

### P0-B — Add evidence-backed false-memory controls

**Dependencies:** P0-A queue/cache identity. **Owner files:**

- `src/memory/schema.ts`: define schema v3 provenance, evidence, confidence,
  audit metadata, and model-health records.
- `src/memory/migrate.ts`: migrate v1/v2 state safely and quarantine
  unproven legacy LLM cache facts.
- `src/memory/extract-prompt.ts`: require concise evidence references for every
  proposed decision.
- `src/memory/extract-llm.ts`: reject missing/invalid evidence before merge or
  cache write.
- `src/memory/writer.ts`: build deterministic transcript/heuristic candidates
  and corroborate LLM facts.
- `src/memory/reader.ts`, `src/tools/recall.ts`, and `src/tools/status.ts`:
  show source and confidence without exposing raw transcript content.
- `test/memory/schema.test.ts`, `migrate.test.ts`, `writer.test.ts`,
  `extract-llm.test.ts`, `test/tools/recall.test.ts`, and bounded fixtures.

**Schema v3 strategy:**

Add, rather than reinterpret, provenance on every accepted extracted fact:

```ts
provenance: {
  extractor: "heuristic" | "llm" | "human" | "legacy",
  source_session_id: string,
  source_audit_session_id?: string,
  confidence: "heuristic" | "llm-corroborated" | "human-reviewed" | "legacy",
  evidence: Array<{
    kind: "transcript" | "heuristic-candidate"
    ref: string                 // bounded message/part reference
    digest: string              // digest, not source text
  }>                         // max 3 entries
}
```

LLM facts require a source audit session and at least one evidence reference.
Evidence references and digests are bounded; raw transcript text is not stored
in `STATE.json` or logs. Existing v1/v2 facts migrate as `legacy` with visible
unknown confidence and no fabricated evidence. Existing LLM cache entries that
lack evidence are quarantined for audit and cannot satisfy a new evidence-backed
merge/cache hit.

Migration must validate the complete v3 document, write atomically, and retain a
timestamped pre-migration backup. A failed migration leaves the prior readable
state untouched and disables only LLM extraction. A package downgrade must use
the backup/export path rather than overwriting v3 with an older schema.

**Behavior:**

1. The prompt asks the model to return evidence references, but prompt wording
   is not trust. The writer derives deterministic transcript candidates from
   tool calls, text, and the heuristic extractor.
2. For each LLM decision, normalize topic/decision and require an exact or
   explicitly defined deterministic match to a transcript/heuristic candidate.
   Evidence that points only to the model's own prose is rejected.
3. Reject a decision with no evidence, an unknown reference, a mismatched digest,
   or an unsupported schema shape. Do not merge or cache rejected facts.
4. LLM extraction never sets `foundational`. `recall_promote` becomes a human
   review path: it displays source session, audit session, confidence, and
   evidence references and requires explicit confirmation before promotion.
5. Recall, status, and compaction diagnostics show extractor, source/audit
   identifiers, confidence, and evidence count. They do not show raw evidence.

This reduces hallucinated durable memory; it does not eliminate hallucinations.
An LLM can still make a wrong claim that happens to match an ambiguous
candidate, and heuristics can also be incomplete. Human review remains the
authority for foundational promotion.

**Failure and rollback:**

- Missing or failed corroboration drops only the LLM fact and preserves the
  heuristic merge.
- A v3 validation or migration failure quarantines the new LLM result and keeps
  the prior state/heuristic writer available.
- Disable LLM extraction to roll back operationally; do not delete legacy facts
  or audit records during rollback.

**Observability:** log `llm_fact_rejected` with reason code, source/audit IDs,
model, and candidate/evidence counts. Log digests and references only. Expose
accepted/rejected counts and legacy/quarantined counts in local status.

**Acceptance gates:**

- **Unit:** evidence is mandatory; valid candidate matches merge; altered
  digests, missing references, ambiguous matches, malformed active files, and
  malformed decisions do not merge or cache; LLM cannot auto-promote
  foundational; human-confirmed `recall_promote` records review provenance.
- **Integration:** migrate representative v1/v2 state and cache fixtures to v3;
  verify old facts remain visible as legacy, unproven LLM cache facts are not
  reused, and a fresh accepted result has bounded provenance.
- **Live:** use the successful gpt-oss audit/session as the retained contract;
  verify accepted facts show source/audit metadata, while a deliberately
  unsupported or evidence-free structured result falls back to heuristics.

### P1-A — Harden the SDK and structured-response boundary

**Dependencies:** P0-A for transaction boundaries; P0-B for acceptance and
provenance. **Owner files:**

- `package.json` and `package-lock.json`: replace floating dev SDK/plugin
  versions with the exact versions used by the successful run.
- `src/memory/llm-adapter.ts` (new, or the equivalent centralized section of
  `src/memory/extract-llm.ts`): own all v1 structured request/result casts.
- `src/memory/provider-inventory.ts` (new, or the equivalent discovery module):
  own normalized inventory decoding.
- `src/config.ts` and `src/memory/extract-llm.ts`: honor the existing opt-in
  gate and a runtime LLM kill switch/circuit state.
- `src/util/log.ts`: own redacted drift diagnostics.
- `test/fixtures/llm/structured-success.json`,
  `provider-inventory.json`, `test/memory/llm-adapter.test.ts`, and
  `test/memory/extract-llm.test.ts`.

**Behavior:**

- Pin the tested dev `@opencode-ai/plugin`/host SDK version exactly and record
  it in the lockfile; do not use `latest` for the compatibility test.
- Validate runtime response and inventory shapes before any cast. The adapter
  accepts only the known structured-result envelope, normalizes it to the Zod
  input, and returns a typed drift error otherwise.
- Keep one localized compatibility boundary. No second SDK bridge is added.
- Validate required fields (`active_files.path/reason`,
  `decisions.topic/decision`) before provenance corroboration.
- On drift, log an explicit `sdk_response_shape_drift` or
  `provider_inventory_shape_drift` event with expected shape/version and
  redacted received keys. Then use heuristics and record the feature outcome.

**Failure and rollback:**

- Any adapter drift, cast exception, or Zod failure skips the LLM merge and
  preserves heuristic facts; the existing one-retry budget remains bounded.
- A runtime kill switch disables LLM extraction per process/project while tools,
  heuristics, cache reads for already accepted facts, and audit history remain
  available.
- Revert to the pinned prior adapter/SDK after a failed upgrade; do not fall
  back to an unpinned SDK or a second transport.

**Observability:** include adapter version, host version if available, stage,
  provider/model, response keys, and drift reason codes. Never log response
  bodies, prompts, or inventory payloads wholesale.

**Acceptance gates:**

- **Unit:** sanitized retained-audit structured output parses; missing envelope,
  wrong field types, unknown required-shape changes, and inventory variants
  produce explicit drift errors; casts are exercised only inside the adapter.
- **Integration:** load the v3 state and sanitized retained-audit fixture with
  the pinned SDK/plugin version and prove the normal structured merge path.
- **Live:** run the connected gpt-oss extraction once after the pin, record the
  outcome, and prove a simulated drift switches to heuristics without composer
  output or a paid request.

### P1-B — Normalize discovery and add model health backoff

**Dependencies:** P1-A inventory adapter and P0-A cache/audit transaction.
**Owner files:**

- `src/memory/provider-inventory.ts`: normalize provider connectivity, model
  IDs, cost, active/tool-callable flags, and optional variant metadata.
- `src/memory/extract-llm.ts`: exact configured-model precedence and candidate
  selection.
- `src/memory/schema.ts`/`migrate.ts`: bounded per-provider/model health state.
- `src/tools/status.ts` and `src/util/log.ts`: local diagnostics only.
- `test/memory/provider-inventory.test.ts`,
  `test/memory/model-health.test.ts`, and discovery integration fixtures.

**Behavior:**

1. Normalize provider inventory variants into one internal record:
   `provider`, `model`, `connected`, `active`, `tool_callable`, `zero_cost`,
   `variants`, and bounded metadata. Reject ambiguous IDs rather than guessing.
2. Automatic discovery considers only connected providers and active,
   zero-cost, tool-callable models. Prefer a candidate advertising `none`, but
   allow another eligible candidate when none is advertised. Use
   `variant: none` only for a selected candidate that actually has it.
3. A valid configured `small_model` is exact and takes precedence over
   discovery. If it is unavailable, unhealthy, or incompatible, preserve
   heuristics; do not replace it with another model.
4. Record health per provider/model after the first real retained extraction:
   success, structured-shape failure, validation failure, transport/auth
   failure, or timeout. Do not issue hidden paid/free capability probes.
5. Use a bounded circuit-breaker TTL: repeated structured failures place that
   candidate on cooldown with capped exponential backoff; a successful real
   extraction clears the failure streak. Health is local metadata, not a
   promise that future entitlement or provider behavior remains unchanged.

**Failure and rollback:**

- Empty/ambiguous inventory means heuristics only and no audit session.
- A disconnected or cooled-down auto candidate is skipped; no paid fallback is
  attempted.
- Explicit configured-model failure is terminal for that idle event, not a
  trigger for discovery replacement.
- Clear local health metadata or disable LLM extraction to immediately recover
  from an overly conservative cooldown.

**Observability:** `tokenmaxxer_status` reports normalized candidate count,
selected provider/model, whether selection was explicit or automatic, variant
used, last outcome, cooldown-until, and bounded failure reason. It must not
report credentials, prompts, or raw provider payloads.

**Acceptance gates:**

- **Unit:** normalize all supported connected/disconnected and cost/variant
  shapes; reject ambiguous records; test explicit precedence, no paid fallback,
  `none` preference without requirement, and conditional variant use.
- **Integration:** persist/reload health and audit metadata; verify cooldown
  suppresses prompts until TTL, success clears it, and status remains bounded.
- **Live:** perform the first real extraction for a candidate and record that
  outcome as health. Repeat against the same cache identity to prove a cache hit;
  do not run an extra probe prompt merely to test capability.

## 3. Test matrix and release checklist

### Test matrix

| Area | Unit | Integration | Live acceptance |
|---|---|---|---|
| Idle races | Same-source coalescing; different-source serialization; cross-project independence | Reload audit guard; crash-window replay | Concurrent idle delivery produces one prompt/cache commit |
| Idempotency | Repeated cache upsert and cache-key normalization | Duplicate completion after retry | Real second run is a cache hit with no new prompt/audit session |
| False memory | Evidence match/mismatch, missing evidence, bounded provenance, no auto-foundational | v2→v3 migration and legacy cache quarantine | gpt-oss accepted facts show source/audit/confidence; unsupported result keeps heuristic facts |
| SDK boundary | Sanitized retained-audit fixture; malformed result/inventory drift | Pinned SDK loads v3 state and fixture | Real gpt-oss structured response passes adapter; simulated drift fails safe |
| Discovery | Connectivity/cost/tool/variant normalization; explicit precedence | Health persistence and TTL | First retained extraction records outcome; no hidden capability probe |
| Privacy | No raw text in logs/evidence serialization | Status output redaction | Review/status exposes references and confidence, never transcript text |
| Upgrade | Schema v3 and adapter contract fixtures | Old state/cache/audit migration and rollback backup | Upgrade then real cache-hit proof against the same source/input/model |

### Release checklist

- [ ] P0 queue, coalescing, idempotent cache commit, and durable audit guard
      tests pass for same/different sessions and projects.
- [ ] Schema v3 migration validates, backs up, preserves legacy facts visibly,
      and quarantines unproven legacy LLM cache entries.
- [ ] LLM decisions cannot merge or cache without deterministic evidence;
      foundational promotion requires explicit human review.
- [ ] No source/transcript/response text appears in logs, status, or persisted
      evidence metadata.
- [ ] SDK/plugin dev versions are pinned to the versions used by the successful
      structured run; no `latest` compatibility dependency remains.
- [ ] Sanitized retained-audit response and inventory fixtures pass the
      centralized adapter and drift tests.
- [ ] Discovery tests prove connected-provider filtering, zero-cost/tool-call
      filtering, `none` preference without requirement, explicit precedence, no
      paid fallback, and conditional variant use.
- [ ] Health cooldown/backoff is bounded, persisted, observable locally, and
      reset by a successful real extraction.
- [ ] The existing opt-in gate/kill switch leaves heuristic memory functional.
- [ ] Live gpt-oss extraction still returns StructuredOutput, Zod-validates,
      merges accepted facts, persists `llm_extraction_cache`, and retains the
      `tokenmaxxer extract · …` audit session.
- [ ] Repeat the exact live source/input/model and prove a cache hit: no new
      prompt, no new audit session, and the same accepted facts are returned.
- [ ] Run the upgrade compatibility test from the prior state/cache schema and
      verify rollback backup restoration before release.
- [ ] Run `git diff --check`; changes for this plan remain limited to this file
      until an implementation task is explicitly approved.

## 4. Explicit non-goals and later product decisions

### Non-goals

- No automatic capability-probe prompts, especially not hidden paid/free
  prompts. Health comes from the first retained real extraction outcome.
- No paid automatic fallback and no replacement of an unavailable explicit
  model with a discovered model.
- No attempt to prove that a model will remain entitled, authenticated,
  private, cheap, or structured-output compatible from inventory metadata alone.
- No raw transcript archive, prompt logging, composer injection, vector search,
  or broad memory rewrite in this reliability pass.
- No claim that corroboration eliminates hallucination; it only narrows the
  accepted failure surface.
- No multi-process distributed lock. The queue is per plugin process/project;
  cross-process locking requires a separate design.

### Decisions requiring later user/product approval

- Whether bounded evidence may persist short sanitized excerpts, or only
  references/digests; the privacy-preserving default is references/digests.
- The exact v3 retention limits for audit metadata, evidence, cache entries, and
  model-health records.
- Whether human review is exposed as a TUI flow, a tool confirmation protocol,
  or a separate command, and who is authorized to promote a fact.
- The final confidence vocabulary and whether users want numeric confidence;
  the implementation should start with explainable categorical levels.
- Circuit-breaker TTL/backoff values and whether health is project-local or
  shared across projects for the same provider/model.
- Whether a schema-v3 upgrade may quarantine old LLM cache entries (safer) or
  must preserve their cache-hit behavior for compatibility.
- The exact pinned SDK/plugin versions and the minimum supported host-version
  range after the live contract fixture is captured.
