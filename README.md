<div align="center">

# tokenmaxxer

**Session longevity & cross-session memory for [opencode](https://opencode.ai)**

Never lose context to compaction again.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)]()

</div>

---

## The problem

opencode is an AI coding agent that works in long sessions. When the context window fills up, opencode **compacts** — it asks the model to generate a summary that replaces the entire conversation. The agent then continues from that summary.

This causes two problems:

1. **Post-compaction quality drop.** The model's summary is unstructured. It often loses track of which files matter, what decisions were locked in, what was already tried and rejected. The agent resumes work confused — re-reading files it already explored, re-litigating decisions that were settled, repeating approaches that failed.

2. **No cross-session memory.** When you start a new session, the agent starts from scratch. It doesn't know what you were working on yesterday, which files matter, or what decisions were made in prior sessions. You have to re-explain everything.

## The solution

tokenmaxxer is an opencode plugin that solves both problems in two layers:

### Layer 1 — Compaction-quality hook

When compaction fires, tokenmaxxer intercepts it (`experimental.session.compacting` hook) and replaces the default compaction prompt with a **schema-constrained** one. The model is forced to produce a structured summary with exactly these sections:

| Section | What it captures |
|---|---|
| **Current task** | What we're doing and why |
| **Active files** | Which files matter and why |
| **Locked decisions** | Settled decisions that should NOT be relitigated |
| **Open questions** | Unresolved decisions still in play |
| **Blockers** | What's blocking progress |
| **Next steps** | The concrete next 1-3 actions |
| **What NOT to redo** | Approaches already tried and rejected |

The model also receives a **durable context block** — recorded observations from prior sessions (current task, active files, valid decisions, blockers, next steps). The model is instructed to treat these as useful but potentially stale, and to verify against the conversation if they conflict.

**The result:** after compaction, the agent knows exactly what it was doing, which files it was working on, what decisions were locked in, and what to do next — without re-reading a single file.

### Layer 2 — Per-project durable memory

On `session.idle` (when the agent finishes responding), tokenmaxxer:

1. Pulls the full session transcript through the host `PluginInput` v1 client
   transport.
2. Extracts structured facts using heuristics — current task, active files (from tool calls), decisions (from natural language), blockers, next steps.
3. Merges with existing memory, superseding old decisions on the same topic.
4. Prunes to stay under 8KB.
5. Writes `STATE.json` silently.

Memory remains available through pull-based tools; tokenmaxxer does not automatically add project memory or current-task text to a new session:

```
Session 1: "Let's use Postgres for the database"
  → session.idle → STATE.json: { decisions: [{ topic: "postgres", ... }] }

Session 2 (new): model calls get_project_state
  → "You have a prior decision: use Postgres (SHA abc1234, 2026-08-08)"
```

### Tracked single-file distribution

The repository tracks the built server and TUI artifacts in `dist/`. The build
uses `--no-splitting`, so `dist/index.js` and `dist/tui.js` are each a
self-contained target with no generated chunk files to copy alongside it.
They retain imports only for host/runtime packages supplied by OpenCode or the
installation's configured dependencies.

### Silent server target and separate TUI target

The server target (`dist/index.js`) is silent: memory work never writes text to
the composer. Automatic text injection was removed so user-derived or
truncated current-task text cannot surface as a composer message. Memory is
accessed through explicit tools and the compaction flow instead.

The separate TUI target (`dist/tui.js`) renders only the right-side `memory`
indicator as a non-composer status surface. It never renders composer text and
is not required for server memory, extraction, or the core plugin.

### LLM extraction status

The opt-in structured extraction path is shipped and has been verified end to
end in this environment. A connected `ollama-cloud/gpt-oss:20b` returned
`StructuredOutput`; tokenmaxxer Zod-validated and merged the facts, persisted
an `llm_extraction_cache` entry in `STATE.json`, and retained an audit session
titled `tokenmaxxer extract · …`.

## Install

### One-liner (global — recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/thehun927/TokenMaxxer/main/install.sh | bash
```

Restart opencode after installation. Both server layers are then active in all
projects — no per-project config required.

The one-liner downloads the tracked `dist/index.js`, `dist/tui.js`, and
launcher artifacts directly; it does not require a local build or model
configuration for installation.

- **Layer 1** (compaction hook) fires on every `/compact`
- **Layer 2** (memory + tools) silently writes `STATE.json` on session idle; it does not write to the composer
- **7 custom tools** are registered and available to the agent in every session

### Manual install from the tracked artifacts

```bash
git clone https://github.com/thehun927/TokenMaxxer.git
cd TokenMaxxer
mkdir -p ~/.config/opencode/plugins
cp dist/index.js ~/.config/opencode/plugins/tokenmaxxer.js       # tracked server target, global (all projects)
cp dist/tui.js ~/.config/opencode/plugins/tokenmaxxer-tui.js     # tracked TUI target, global (all projects)
# or: cp dist/index.js .opencode/plugins/tokenmaxxer.js       # local (single project)
```

For a global install, add `"./plugins/tokenmaxxer-tui.js"` once to the
`plugin` array in `~/.config/opencode/tui.json` without removing existing
entries. Also ensure `~/.config/opencode/package.json` has these dependency
ranges (the one-liner adds them without running a network install):

```json
{
  "dependencies": {
    "zod": "^3.25.0",
    "@opentui/solid": "^0.4.5",
    "@opentui/core": "^0.4.5",
    "@opentui/keymap": "^0.4.5"
  }
}
```

Restart opencode after copying both files so the server and separate TUI
targets, dependencies, and TUI configuration are loaded.

The installer also provides a `tokenmaxxer` launcher. After installation, run
OpenCode with extraction enabled for the child process:

```bash
tokenmaxxer opencode [args]
```

This launcher requires the tokenmaxxer plugin/launcher to be installed and a
configured, connected, accessible small model. It only supplies the extraction
opt-in environment; it does not provide model credentials or entitlement.

### Optional tuning (not required)

For better token efficiency, add to your project's `opencode.json`:

```jsonc
{
  "compaction": { "auto": true, "prune": true, "reserved": 25000 },
  "watcher": { "ignore": [".opencode/memory/**"] }
}
```

| Setting | Why |
|---|---|
| `compaction.prune: true` | Drops old tool outputs — the biggest single token saver. Tokenmaxxer works without it, but compaction is less efficient. |
| `compaction.reserved: 25000` | Headroom so compaction doesn't overflow. |
| `watcher.ignore` | Stops the file watcher from processing the plugin's writes to `.opencode/memory/`. Harmless without it, but slightly cleaner. |

### .gitignore

Add to your project `.gitignore`:

```
.opencode/memory/STATE.json
.opencode/memory/last_compaction_prompt.log
.opencode/memory/*.corrupt.*
```

`STATE.json` contains session IDs and project decisions — don't commit it.

## Tools

The plugin registers 7 custom tools, available to the agent in every session:

| Tool | When to use | What it returns |
|---|---|---|
| `get_project_state` | **Call once at session start** when resuming work | Full project memory: current task, active files, valid decisions, blockers, next steps |
| `recall_decision` | When you need to recall a prior decision | Decisions matching a topic query (or most recent if no query) |
| `get_active_files` | When you need to know which files matter | Files being worked on and why each matters |
| `recall_promote` | When a decision should never be forgotten | Marks a decision as foundational — always included in compaction context |
| `preview_compaction` | When context is getting large | Previews what would survive compaction before it fires |
| `head_files` | When exploring large files | First N lines of files — cheaper than full `read` |
| `tokenmaxxer_status` | When debugging | Plugin health: memory file path, size, decision count, last write, last compaction |

## Kill switch

If the schema-constrained compaction prompt makes things worse, disable it without uninstalling:

```bash
TOKENMAXXER_NO_PROMPT=1
```

This selects augment mode for compatibility: the plugin leaves `output.prompt` unset and appends its data-only context, letting opencode use its default compaction prompt.

## Optional LLM extraction

Heuristic extraction remains the default. LLM extraction is **opt-in**. Start
OpenCode with:

```bash
TOKENMAXXER_LLM_EXTRACT=1 opencode
```

Alternatively, the installer-provided launcher enables the same environment for
its child process:

```bash
tokenmaxxer opencode [args]
```

The launcher is available only after plugin/launcher installation and still
requires an accessible configured/connected small model. Heuristic extraction remains the
durable fallback when the opt-in path is disabled, the model cannot be used, or
the structured result is invalid.

When enabled, tokenmaxxer resolves the extraction model from the user's
OpenCode installation:

1. If `small_model` is a valid `provider/model` string in the host config, it
   is the explicit model override. The verified example for this environment is
   `ollama-cloud/gpt-oss:20b`; it is not a permanent or universal recommendation.
2. If `small_model` is absent or malformed, tokenmaxxer reads the host provider
   inventory from connected providers in `data.all[].models`, keeps only active,
   zero-cost, tool-callable models, and prefers candidates that advertise an
   explicit `none` reasoning variant. A `none` variant is not required: if no
   preferred candidate has one, another eligible candidate may be selected in
   host provider-list and model-map order.
3. Automatic discovery never falls back to a paid model, including a paid
   Anthropic model. Provider and model names are not hardcoded.

Structured extraction uses `variant: none` when the selected model advertises
that variant. If it does not, extraction uses the selected model without
forcing an unavailable variant. The verified explicit
`ollama-cloud/gpt-oss:20b` example has no `none` variant and remains a valid
explicit choice. Heuristics remain the fallback when the selected model cannot
be used or its structured result is invalid.

An OpenCode model listing is inventory only. It does not guarantee
authentication, entitlement, thinking/tool-choice compatibility, or adherence
to the structured-result contract. The selected model still needs to be
available through a connected provider. If a model request returns `401`,
authenticate and verify the provider before enabling extraction:

```bash
opencode auth login
```

Complete the OpenCode/Zen provider flow, then confirm the connection with:

```bash
opencode auth list
```

Auto-discovery selects models only from connected providers. An explicit
`small_model` that is listed but unavailable, not entitled, not authenticated,
or incompatible falls back to heuristic extraction rather than being replaced
with another model.

Extraction uses the host `PluginInput` v1 client transport; it does not create
a separate SDK-v2 bridge. The generated client types omit JSON-schema fields
that the existing server responses already provide, so the session prompt
request and result each use one localized compatibility cast. Zod validates
the structured result after the result cast. This is a bounded compatibility
risk: a transport or validation failure is retried once and then fails safe to
heuristic extraction rather than replacing it with an alternate bridge.

Free offerings change, and providers may apply their own data-use policies.
This selection policy makes no permanent claim about which model is best.

### List and configure models

List the models available to the OpenCode installation that is running the
plugin. The list describes inventory; it does not prove that a model is
authenticated, entitled, compatible, or currently usable:

```bash
opencode models
```

To select one exact model, copy its provider and model IDs into the top-level
`small_model` setting. The value must use the `provider/model` form:

```jsonc
{
  "small_model": "ollama-cloud/gpt-oss:20b"
}
```

Use the exact provider and model identifiers shown by OpenCode. The verified
Ollama Cloud value above is an environment-specific example, not a promise
that the model will remain available, entitled, compatible, or preferable.
With a valid override, tokenmaxxer does not replace it with an automatically
discovered model. Remove it (or correct it) to use eligible-model discovery.

The extraction prompt has a strict structured-output contract. In particular,
every `active_files` object requires both `path` and `reason`, and every
`decisions` object requires both `topic` and `decision`. Assistant prose,
free-form JSON, and code fences do not satisfy the contract.

### Run a real extraction test

Use a fresh source session so an earlier cache entry cannot satisfy the test.
Do not use `opencode run` for this validation: `opencode run` may exit before
the fire-and-forget `session.idle` handlers finish. It can therefore create the
source session without persisting memory or the retained audit extraction
session.

1. In the target project, start an interactive OpenCode process, either
   directly or through the installed launcher:

   ```bash
   TOKENMAXXER_LLM_EXTRACT=1 opencode
   ```

   ```bash
   tokenmaxxer opencode
   ```

2. Send a prompt with an explicit decision and next step, for example: “For an
   extraction test, explicitly decide to keep the heuristic fallback available,
   state one next step, and do not edit files.”
3. Keep the process open after the response until the source session is idle and
   its detached idle work has completed.
4. Confirm that `.opencode/memory/STATE.json` has a newer timestamp than before
   the test and contains an `llm_extraction_cache` entry. Its key includes the
   source session, canonical input, and selected provider/model.
5. Run `opencode session list` and confirm it includes a visible retained
   session titled `tokenmaxxer extract · ...`.

The verified run used the connected `ollama-cloud/gpt-oss:20b` model: the host
returned `StructuredOutput`, tokenmaxxer Zod-validated and merged the facts,
and the cache and retained audit session were both present. A model listing
alone is not a successful extraction test; authentication, entitlement,
thinking/tool-choice behavior, and structured-result adherence must work.

The retained session is a normal audit record and is never deleted. If
discovery finds no eligible connected model, no cache entry or audit session is
created because the opt-in path correctly uses heuristics only.

## Debugging

| What | Where |
|---|---|
| Plugin health | Call the `tokenmaxxer_status` tool |
| Last injected compaction prompt | `.opencode/memory/last_compaction_prompt.log` |
| Raw memory file | `.opencode/memory/STATE.json` (human-readable JSON) |
| Corrupt file backups | `.opencode/memory/*.corrupt.*` |
| Plugin load confirmation | opencode logs: `grep "tokenmaxxer plugin loaded" ~/.local/share/opencode/log/opencode.log` |
| Compaction hook confirmation | opencode logs: `grep "compaction hook fired" ~/.local/share/opencode/log/opencode.log` |

## How memory extraction works

The heuristic extractor scans the session transcript on `session.idle` and extracts:

- **Current task** — first natural-language user message (skips XML, JSON, code blocks)
- **Active files** — from `read`/`edit`/`write`/`bash` tool calls (path field `filePath`), filtered to real source files (URLs, system paths, and paths without extensions are rejected)
- **Decisions** — from user and assistant text, using keyword matching (`let's`, `decided`, `chose`, `go with`, etc.) with:
  - **Sentence-initial requirement** — keywords must be at the start of a sentence or after a clause boundary (prevents "The decision regex has a gap" from matching)
  - **Pre-keyword negation** — checks 3 words before the keyword for `not`/`never`/`avoid`/`skip`/`reject`
  - **Post-keyword negation** — checks 3 words after the keyword (catches "decided to not use X")
  - **Code block stripping** — fenced code blocks, inline code, and JSON-like lines are removed before scanning
  - **Quality filters** — topics must be plausible nouns (rejects common English words, code fragments, JSON artifacts)
  - **Tool outputs excluded** — only natural language conversation is scanned, not file contents or logs
- **Blockers** — last assistant message, lines containing `blocked`/`can't`/`fails`/`error`/`stuck`
- **Next steps** — last assistant message, numbered lists and `next:`/`then:`/`TODO` lines

Memory is merged across sessions: new decisions on the same topic supersede old ones (exact normalized topic match, not substring — "auth" does not clobber "authentication"). The file is pruned to 8KB: invalid decisions dropped first, then old active files, then decisions older than 30 days, then last-resort truncation.

## Limitations

- **Heuristic extraction is conservative.** It prioritizes precision over recall — it would rather produce no decisions than wrong ones. Decisions stated in unusual phrasing will be missed. Optional structured LLM extraction is available through `TOKENMAXXER_LLM_EXTRACT=1`, with heuristics retained as the durable fallback.
- **Host client type compatibility.** The host `PluginInput` v1 client transport's generated types omit existing server JSON-schema fields. Two localized casts bridge only the session prompt request and result, with Zod validation, one retry, and heuristic fallback. This bounded risk is not a separate SDK-v2 bridge.
- **No per-turn history pruning.** The plugin only intervenes at compaction time. Per-turn pruning would require the `experimental.chat.messages.transform` hook (which exists in the opencode API but is undocumented and unstable).
- **Durable recency uses the last three recorded source sessions.** Session IDs are retained in a bounded history, while older decisions remain available through the recall tools.
- **Event handlers are fire-and-forget.** opencode does not await async event handlers. If opencode exits while `writeMemoryOnIdle` is in flight, the write may not complete. Atomic writes (temp file + rename) prevent corruption — the worst case is a missed write, never a corrupt file.
- **Non-git directories.** opencode sets `worktree` to `/` in non-git directories. The plugin falls back to `directory` (session CWD) in this case.

## Architecture

```
src/
  index.ts                # Plugin entry — wires all hooks
  types.ts                # Shared types (CompactionInput, TranscriptPart, etc.)
  config.ts               # Options + legacy compatibility mapping (TOKENMAXXER_NO_PROMPT)
  memory/
    schema.ts             # Zod schemas (MemoryFile, Decision, ActiveFile)
    migrate.ts            # Version-aware migration (v1 → v2)
    store.ts              # Read/write STATE.json (cached, mtime-invalidated, corrupt recovery)
    writer.ts             # Heuristic/LLM extraction, merge, prune, STATE.json writes
    extract-llm.ts        # Opt-in structured extraction, model discovery, cache
    extract-prompt.ts     # Canonical extraction input and prompt
    reader.ts             # Query helpers for tools
  compaction/
    prompt.ts             # Schema-constrained compaction prompt
    durable.ts            # Builds durable-state block (bounded: foundational + recent + top-5 older)
  tools/
    recall.ts             # recall_decision, get_active_files, get_project_state, recall_promote
    efficiency.ts         # preview_compaction, head_files
    status.ts             # tokenmaxxer_status
  util/
    git.ts                # Current git SHA (Bun.$ with child_process fallback)
    log.ts                # client.app.log wrapper (never throws)
    fs.ts                 # Atomic write, safe read, mtime, ensureDir
```

## Development

```bash
npm ci                # Install dev deps (vitest, tsup, typescript, zod, @opencode-ai/plugin)
npm test            # Run the test suite
npm run build        # Rebuild the tracked single-file server and TUI targets
npx tsc --noEmit    # Type check
```

## Project structure

```
docs/
  PLAN.md            # Original 708-line design spec
  IMPLEMENTATION.md  # Build guide with function specs, test plan, corrected milestone order
test/
  fixtures/          # Transcript fixtures for heuristic extraction tests
  memory/            # Schema, merge, prune, writer, migrate tests
  compaction/        # Prompt, durable, bounded policy tests
  tools/             # Recall, efficiency, status tool tests
```

## License

MIT
