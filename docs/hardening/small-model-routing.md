# Small-Model Routing Hardening Plan

## Purpose

TokenMaxxer currently relies on OpenCode's merged `small_model` configuration for optional LLM-based memory extraction. If that value is missing or unreadable, TokenMaxxer automatically discovers an eligible free/tool-capable model from the provider inventory.

That behavior is convenient, but it has an undesirable failure mode: when the user explicitly intends TokenMaxxer to use one provider/model, a configuration-resolution problem can silently send extraction traffic to a different provider. In practice this can look like TokenMaxxer "defaulting" to a Codex model even though the user set an Ollama Cloud small model.

This hardening work should make model routing explicit, observable, testable, and fail-closed.

---

## Current Behavior

### OpenCode configuration source

TokenMaxxer does not define `small_model` in its own plugin config. The extraction path calls OpenCode's configuration API:

```ts
await client.config.get({ query: { directory } })
```

and reads:

```ts
result.data.small_model
```

The value is parsed as:

```text
provider/model
```

Relevant implementation:

- `src/memory/extract-llm.ts`
  - `parseSmallModel()`
  - `readConfiguredModel()`
  - `getLLMConfig()`
  - `discoverFreeSmallModel()`

OpenCode expects `small_model` as a top-level config key, for example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "provider/main-model",
  "small_model": "provider/small-model",
  "provider": {}
}
```

Global OpenCode config normally lives at:

```text
~/.config/opencode/opencode.json
```

or:

```text
~/.config/opencode/opencode.jsonc
```

Project-specific configs may also exist at the project root or under `.opencode/` and are merged by OpenCode according to its normal precedence rules.

### Current TokenMaxxer resolution flow

The effective flow is:

```text
TOKENMAXXER_LLM_EXTRACT != 1
  -> LLM extraction disabled

TOKENMAXXER_LLM_EXTRACT == 1
  -> host structured-output gate
  -> client.config.get(directory)
  -> parse data.small_model

If explicit small_model is valid:
  -> validate provider/model availability
  -> use exactly that model

If small_model is absent, malformed, or config read fails:
  -> discoverFreeSmallModel()
  -> choose an eligible connected/active/tool-callable/zero-cost model
  -> prefer a model exposing the "none" variant
  -> use that automatically selected model
```

The automatic discovery path is the source of surprising provider changes.

### Current eligibility rule for automatic discovery

`src/memory/provider-inventory.ts` currently considers a model eligible when:

```ts
model.connected &&
model.active &&
model.tool_callable &&
model.zero_cost
```

This is intentionally conservative about cost, but it is not conservative about provider identity.

### Existing explicit-model behavior

When a valid configured model is successfully read, it is already authoritative. TokenMaxxer does not intentionally fall through from a valid explicit override into discovery.

If an explicit model is unavailable, TokenMaxxer currently returns a disabled LLM config with reasons such as:

- `provider is not available`
- `provider is not connected`
- `model is not available`
- `configured model is on cooldown`

This is good and should be preserved.

The primary problem is therefore not explicit-model fallback. It is that an absent/malformed/unreadable OpenCode `small_model` is treated the same as permission to auto-discover another model.

---

## Immediate User Configuration

For current OpenCode versions, configure the small model at the top level of the OpenCode config.

Recommended global location:

```text
~/.config/opencode/opencode.json
```

Example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "small_model": "ollama-cloud/gpt-oss:20b-cloud"
}
```

If other settings already exist, add `small_model` as a sibling of `provider`, `model`, `compaction`, `instructions`, etc. Do not nest it under `provider` or TokenMaxxer configuration.

The exact `provider/model` identity must match OpenCode's model inventory. For Ollama Cloud, OpenCode's current provider documentation instructs users to pull model metadata with:

```bash
ollama pull gpt-oss:20b-cloud
```

and then select/check the model through `/models`. The full ID shown by OpenCode should be treated as authoritative.

After changing config, restart OpenCode so all plugins receive the newly merged configuration.

---

# Hardening Goals

## Goal 1 — No silent cross-provider routing

If the user has explicitly configured a model for TokenMaxxer or OpenCode, TokenMaxxer must never silently route LLM extraction to another provider.

## Goal 2 — Fail closed to heuristics

Heuristic extraction is already the permanent fallback. If LLM model resolution is ambiguous, missing, malformed, unavailable, disconnected, or rejected, TokenMaxxer should use heuristics instead of choosing another provider by surprise.

## Goal 3 — Make model selection observable

`tokenmaxxer_status` must show exactly:

- whether selection was explicit, automatic, or none
- selected provider
- selected model
- selected variant
- resolution reason
- whether discovery was allowed
- the configured source if known

A user should not need to inspect audit sessions or OpenCode logs to answer "which model did TokenMaxxer choose and why?"

## Goal 4 — Preserve an opt-in discovery mode

Automatic discovery can remain useful, but it should be an explicit compatibility/advanced feature rather than the default behavior.

## Goal 5 — Keep all behavior bounded and backward-compatible where practical

Do not expand persistence with raw config payloads, provider metadata, secrets, credentials, or model descriptions. Diagnostics should retain bounded identifiers and reasons only.

---

# Proposed Design

## 1. Add a TokenMaxxer-specific explicit override

Introduce:

```text
TOKENMAXXER_SMALL_MODEL
```

Accepted format:

```text
provider/model
```

Use the existing `parseSmallModel()` parser.

### Proposed precedence

```text
1. TOKENMAXXER_SMALL_MODEL
2. OpenCode top-level small_model
3. automatic discovery, only if explicitly enabled
4. heuristic extraction
```

This gives advanced users a way to isolate TokenMaxxer extraction from OpenCode's own lightweight-model behavior.

### Why this matters

OpenCode itself uses `small_model` for lightweight internal work such as title generation. TokenMaxxer currently borrows that setting. A dedicated TokenMaxxer override lets users choose a cheap extraction model without changing OpenCode's own small-model routing.

---

## 2. Make automatic discovery opt-in

Introduce:

```text
TOKENMAXXER_LLM_AUTO_MODEL=1
```

Default behavior when unset or any value other than `1`:

```text
no explicit TokenMaxxer model
+ no OpenCode small_model
-> disable LLM extraction for this idle event
-> continue with heuristics
```

Only when:

```text
TOKENMAXXER_LLM_AUTO_MODEL=1
```

may TokenMaxxer call `discoverFreeSmallModel()` after explicit model resolution is absent.

### Important distinction

An explicitly configured but unavailable model must never trigger discovery, even when auto-discovery is enabled.

Example:

```text
TOKENMAXXER_SMALL_MODEL=ollama-cloud/gpt-oss:20b-cloud
provider disconnected
```

Expected:

```text
LLM extraction disabled
reason=provider is not connected
heuristics continue
```

Not:

```text
pick openai/gpt-5.x-codex
```

---

## 3. Distinguish "absent" from "invalid"

Today `readConfiguredModel()` returns only `SmallModel | undefined`, which loses information.

Refactor it into a typed result such as:

```ts
type ConfiguredSmallModelRead =
  | { status: "absent" }
  | { status: "valid"; model: SmallModel }
  | { status: "invalid"; reason: "malformed-small-model" }
  | { status: "unavailable"; reason: "config-read-failed" | "malformed-config-response" }
```

This allows status output and logs to distinguish:

- user never configured a value
- user configured a malformed value
- OpenCode returned an unexpected envelope
- config API threw

Do not silently convert all four states into "go discover something else."

---

## 4. Record the model source in process-local resolution diagnostics

Extend `LLMModelResolutionStatus` with a bounded source field:

```ts
type LLMModelSource =
  | "tokenmaxxer-env"
  | "opencode-small-model"
  | "automatic-discovery"
  | "none"
```

Suggested status shape:

```ts
export type LLMModelResolutionStatus = {
  candidate_count: number
  selected_provider?: string
  selected_model?: string
  selection: "explicit" | "automatic" | "none"
  source: LLMModelSource
  variant?: string
  reason?: string
  discovery_enabled: boolean
}
```

Keep strings bounded to the current identifier/diagnostic limits.

---

## 5. Improve `tokenmaxxer_status`

`src/tools/status.ts` already reads:

```ts
const resolution = getLastLLMModelResolution()
```

but currently exposes only a subset of the useful fields.

Add lines similar to:

```text
LLM selection (process-wide): explicit
LLM selection source (process-wide): tokenmaxxer-env
LLM selected model (process-wide): ollama-cloud/gpt-oss:20b-cloud
LLM discovery enabled (process-wide): no
LLM resolution reason (process-wide): none
LLM variant (process-wide): none
```

If nothing is selected:

```text
LLM selection (process-wide): none
LLM selection source (process-wide): none
LLM selected model (process-wide): none
LLM discovery enabled (process-wide): no
LLM resolution reason (process-wide): no explicit small model configured
```

### Preserve existing durable health distinction

Do not conflate process-wide resolution with durable per-project model health.

The existing status line:

```text
Latest durable model health: ...
```

should remain separate because it answers a different question: which model most recently produced a persisted health outcome for this project.

---

## 6. Add bounded debug logging for resolution

Add a single debug event after resolution completes, for example:

```text
tokenmaxxer_llm_model_resolution
```

Metadata should include only:

```json
{
  "selection": "explicit",
  "source": "opencode-small-model",
  "provider_id": "ollama-cloud",
  "model_id": "gpt-oss:20b-cloud",
  "variant": "none",
  "candidate_count": 1,
  "discovery_enabled": false,
  "reason": "resolved"
}
```

Never log:

- credentials
- provider options
- API keys
- config file contents
- transcript content

---

# Implementation Steps

## Phase A — Refactor resolution without changing behavior

1. Add typed configured-model read result.
2. Add model source to `LLMModelResolutionStatus`.
3. Centralize updates to `lastModelResolution` so every exit path records a complete bounded state.
4. Add status output fields.
5. Add tests for every resolution state.

This phase should preserve current discovery behavior so the refactor can be validated independently.

## Phase B — Add `TOKENMAXXER_SMALL_MODEL`

1. Read `process.env.TOKENMAXXER_SMALL_MODEL` only when LLM extraction is enabled.
2. Parse it with `parseSmallModel()`.
3. If present but malformed, fail closed to heuristics.
4. If valid, resolve provider/model availability exactly as the current OpenCode explicit model does.
5. Mark source as `tokenmaxxer-env`.
6. Do not call OpenCode config discovery for model selection after a valid env override has been accepted, except provider inventory validation if required.

## Phase C — Gate automatic discovery

1. Add helper:

```ts
function isAutomaticModelDiscoveryEnabled(): boolean {
  return process.env.TOKENMAXXER_LLM_AUTO_MODEL === "1"
}
```

2. When no explicit model is available:
   - if disabled: return `{ enabled: false, reason: "no explicit small model configured" }`
   - if enabled: run existing `discoverFreeSmallModel()`
3. Never run discovery after any explicit-model validation failure.
4. Update README/docs to describe the new behavior.

## Phase D — Observability and diagnostics

1. Expand `tokenmaxxer_status`.
2. Add one bounded debug event per completed model-resolution attempt.
3. Ensure process-wide wording is retained where appropriate.
4. Keep durable model health separate from process-local current resolution.

## Phase E — Documentation

Update the README LLM extraction section with:

### Default behavior

```text
TOKENMAXXER_LLM_EXTRACT=1
+ explicit model configured
-> structured LLM extraction

TOKENMAXXER_LLM_EXTRACT=1
+ no explicit model
-> heuristics
```

### Dedicated override

```bash
TOKENMAXXER_SMALL_MODEL="ollama-cloud/gpt-oss:20b-cloud" tokenmaxxer opencode
```

### Optional discovery

```bash
TOKENMAXXER_LLM_AUTO_MODEL=1 tokenmaxxer opencode
```

Clearly state that automatic discovery may select another connected provider and is therefore opt-in.

---

# Test Plan

Primary test file:

```text
test/memory/extract-llm.test.ts
```

Additional status tests should be added under `test/tools/` as appropriate.

## Required unit tests

### Parsing

- valid `TOKENMAXXER_SMALL_MODEL`
- invalid value without `/`
- whitespace in provider
- whitespace in model
- model IDs containing additional `/` characters remain supported

### Precedence

1. env override beats OpenCode `small_model`
2. OpenCode `small_model` is used when env is absent
3. no explicit model + discovery disabled -> heuristics
4. no explicit model + discovery enabled -> existing discovery path

### Explicit failure behavior

For both env and OpenCode explicit models:

- provider missing -> disabled, no discovery
- provider disconnected -> disabled, no discovery
- model missing -> disabled, no discovery
- cooldown -> disabled, no discovery unless bypass cooldown was explicitly requested by existing internal recovery logic
- inventory request failure -> retain current explicit-model compatibility behavior where appropriate, but never switch provider

### Config-read failure behavior

- `client.config.get()` throws, discovery disabled -> heuristics
- config response malformed, discovery disabled -> heuristics
- `small_model` malformed, discovery disabled -> heuristics
- same states with auto-discovery enabled may discover only when there was no valid explicit intent

Be careful with the malformed-explicit case: a present malformed `small_model` should be treated as explicit intent and fail closed rather than discover another provider.

### Discovery

When explicitly enabled:

- preserves first eligible free model behavior
- preserves connected/active/tool/zero-cost filters
- preserves `none` variant preference
- preserves model-health cooldown filtering
- reports `selection=automatic`
- reports `source=automatic-discovery`

### Prompt routing

Assert that the final structured prompt body contains exactly the selected model:

```ts
body.model = {
  providerID: expectedProvider,
  modelID: expectedModel,
}
```

Add a regression test with an inventory containing both:

```text
ollama-cloud/gpt-oss:20b-cloud
openai/gpt-5.3-codex
```

Cases:

1. explicit Ollama model -> prompt must use Ollama
2. explicit Ollama unavailable -> no prompt with Codex
3. no explicit model + auto discovery disabled -> no LLM prompt
4. no explicit model + auto discovery enabled -> automatic selection allowed according to inventory rules

This regression is important because it directly captures the user-visible failure mode that triggered this hardening work.

---

# Acceptance Criteria

The implementation is complete when all of the following are true:

1. `TOKENMAXXER_SMALL_MODEL` can explicitly select the extraction model.
2. It takes precedence over OpenCode `small_model`.
3. OpenCode `small_model` remains supported as the normal secondary explicit source.
4. Automatic model discovery is disabled by default.
5. Automatic discovery requires `TOKENMAXXER_LLM_AUTO_MODEL=1`.
6. Explicit unavailable/malformed models never fall through to another provider.
7. Heuristic extraction remains available for all model-resolution failures.
8. `tokenmaxxer_status` identifies current selection, source, provider/model, variant, discovery state, and reason.
9. No secrets or config payloads are persisted/logged.
10. Existing structured-output validation, audit retention, health cooldowns, evidence validation, and heuristic fallback behavior remain intact.
11. Unit tests prove that an explicitly configured Ollama model can never silently become a Codex extraction request.
12. README documentation reflects the new precedence and opt-in discovery behavior.
13. `npm test` passes.
14. `npm run build` passes.
15. Existing host-contract and release verification checks remain green.

---

# Suggested Verification Procedure

After implementation, verify manually with a configuration containing both Ollama Cloud and OpenAI connectivity.

## Case 1 — OpenCode small model only

```jsonc
{
  "small_model": "ollama-cloud/gpt-oss:20b-cloud"
}
```

Expected status:

```text
LLM selection (process-wide): explicit
LLM selection source (process-wide): opencode-small-model
LLM selected model (process-wide): ollama-cloud/gpt-oss:20b-cloud
LLM discovery enabled (process-wide): no
```

## Case 2 — TokenMaxxer override

```bash
TOKENMAXXER_SMALL_MODEL="ollama-cloud/gpt-oss:20b-cloud" tokenmaxxer opencode
```

Expected source:

```text
tokenmaxxer-env
```

## Case 3 — No explicit model

Remove both explicit settings.

Expected:

```text
LLM selection (process-wide): none
LLM discovery enabled (process-wide): no
LLM resolution reason (process-wide): no explicit small model configured
```

Heuristic extraction should continue normally.

## Case 4 — Explicit model unavailable

Configure a nonexistent model.

Expected:

```text
selection=explicit
reason=model is not available
```

There must be no structured prompt to any alternate provider.

## Case 5 — Explicitly enable discovery

```bash
TOKENMAXXER_LLM_AUTO_MODEL=1 tokenmaxxer opencode
```

with no explicit small model.

Expected:

```text
selection=automatic
source=automatic-discovery
```

Only this mode may select another provider based on inventory eligibility.

---

# Non-Goals

This hardening should not:

- replace OpenCode's provider authentication system
- embed provider credentials in TokenMaxxer
- manage Ollama model installation/pulls
- change OpenCode's own title-generation model behavior
- add paid-model ranking logic
- alter structured extraction schema/evidence requirements
- change decision authority or foundational promotion rules
- persist raw OpenCode config

---

# Recommended Luna Execution Order

1. Read `src/memory/extract-llm.ts` and `src/memory/provider-inventory.ts` completely.
2. Read existing tests in `test/memory/extract-llm.test.ts` before editing behavior.
3. Refactor resolution state/result typing first.
4. Expand status output and tests.
5. Add `TOKENMAXXER_SMALL_MODEL` precedence.
6. Add `TOKENMAXXER_LLM_AUTO_MODEL` and switch discovery to opt-in.
7. Add the Codex/Ollama cross-provider regression tests.
8. Update README documentation.
9. Run targeted tests.
10. Run full test suite and build.
11. Inspect final diff specifically for accidental changes to evidence validation, audit persistence, health cooldowns, or heuristic fallback.

The desired end state is simple: **when the user names a model, TokenMaxxer uses that model or uses heuristics. It never silently chooses a different provider.**
