<div align="center">

# tokenmaxxer

**Session longevity & cross-session memory for [opencode](https://opencode.ai)**

Never lose context to compaction again.

[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)]() [![Build](https://img.shields.io/badge/build-clean-brightgreen)]() [![License: MIT](https://img.shields.io/badge/license-MIT-blue)]()

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

1. Pulls the full session transcript via the opencode SDK.
2. Extracts structured facts using heuristics — current task, active files (from tool calls), decisions (from natural language), blockers, next steps.
3. Merges with existing memory, superseding old decisions on the same topic.
4. Prunes to stay under 8KB.
5. Writes `STATE.json` and regenerates `HEADER.md`.

On the next session start, the model sees `HEADER.md` (loaded via opencode's `instructions` config) and can call tools to pull detailed memory:

```
Session 1: "Let's use Postgres for the database"
  → session.idle → STATE.json: { decisions: [{ topic: "postgres", ... }] }

Session 2 (new): model sees HEADER.md → calls get_project_state
  → "You have a prior decision: use Postgres (SHA abc1234, 2026-08-08)"
```

## Install

### One-liner (global — recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/thehun927/TokenMaxxer/main/install.sh | bash
```

That's it. Both layers are active immediately in all projects — no per-project config required.

- **Layer 1** (compaction hook) fires on every `/compact`
- **Layer 2** (memory + tools) writes `STATE.json` on session idle and injects the project header into the system prompt via the `experimental.chat.system.transform` hook
- **7 custom tools** are registered and available to the agent in every session

### Manual install

```bash
git clone https://github.com/thehun927/TokenMaxxer.git
cd TokenMaxxer && npm install && npm run build
cp dist/index.js ~/.config/opencode/plugins/tokenmaxxer.js   # global (all projects)
# or: cp dist/index.js .opencode/plugins/tokenmaxxer.js       # local (single project)
```

### Optional tuning (not required)

For better token efficiency, add to your project's `opencode.json`:

```jsonc
{
  "compaction": { "auto": true, "prune": true, "reserved": 15000 },
  "watcher": { "ignore": [".opencode/memory/**"] }
}
```

| Setting | Why |
|---|---|
| `compaction.prune: true` | Drops old tool outputs — the biggest single token saver. Tokenmaxxer works without it, but compaction is less efficient. |
| `compaction.reserved: 15000` | Headroom so compaction doesn't overflow. |
| `watcher.ignore` | Stops the file watcher from processing the plugin's writes to `.opencode/memory/`. Harmless without it, but slightly cleaner. |

You can also add `.opencode/memory/HEADER.md` to `instructions` for redundant header injection (the `system.transform` hook already handles this, but `instructions` is the documented path):

```jsonc
"instructions": ["AGENTS.md", ".opencode/memory/HEADER.md"]
```

### .gitignore

Add to your project `.gitignore`:

```
.opencode/memory/STATE.json
.opencode/memory/last_compaction.log
.opencode/memory/*.corrupt.*
```

`STATE.json` contains session IDs and project decisions — don't commit it. `HEADER.md` is safe to commit (it's a <1KB pointer).

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

This skips prompt replacement but still injects the durable block via `output.context`, letting opencode use its default compaction prompt.

## Optional LLM extraction (v1.1)

Heuristic extraction remains the default. LLM extraction is **opt-in**. Start
OpenCode with:

```bash
TOKENMAXXER_LLM_EXTRACT=1 opencode
```

When enabled, tokenmaxxer resolves the extraction model from the user's
OpenCode installation:

1. If `small_model` is a valid `provider/model` string in `opencode.json`, it
   is the explicit model override.
2. If `small_model` is absent or malformed, tokenmaxxer inventories active,
   enabled, tool-capable models whose declared model cost is zero, and
   uses the first candidate in the API's release order.
3. If no such candidate exists, it uses heuristics only. Automatic discovery
   never falls back to a paid model, including a paid Anthropic model. Provider
   and model names are not hardcoded.

Free offerings change, and providers may apply their own data-use policies.
This selection policy makes no permanent claim about which model is best.

### List and configure models

List the models available to the OpenCode installation that is running the
plugin:

```bash
opencode models
```

To select one exact model, copy its provider and model IDs into the top-level
`small_model` setting:

```jsonc
{
  "small_model": "provider/model"
}
```

The value must be the exact `provider/model` identifier shown by OpenCode.
With a valid override, tokenmaxxer does not replace it with an automatically
discovered model. Remove it (or correct it) to use free-model discovery.

### Run a real extraction test

Use a fresh source session so an earlier cache entry cannot satisfy the test:

```bash
TOKENMAXXER_LLM_EXTRACT=1 opencode run "For an extraction test, make an explicit decision to keep the heuristic fallback available, state one next step, and do not edit files."
```

You can instead export the variable and use a normal interactive session.
After the source session becomes idle, look in OpenCode's session list for the
visible retained session titled `tokenmaxxer extract · ...`. It is a normal
audit session and is never deleted. If discovery finds no eligible free model,
no audit session is created because the run correctly uses heuristics only.

## Debugging

| What | Where |
|---|---|
| Plugin health | Call the `tokenmaxxer_status` tool |
| Last injected compaction prompt | `.opencode/memory/last_compaction.log` |
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

- **Heuristic extraction is conservative.** It prioritizes precision over recall — it would rather produce no decisions than wrong ones. Decisions stated in unusual phrasing will be missed. v1.1 adds optional structured LLM extraction via `TOKENMAXXER_LLM_EXTRACT=1`, with heuristics retained as the fallback.
- **No per-turn history pruning.** The plugin only intervenes at compaction time. Per-turn pruning would require the `experimental.chat.messages.transform` hook (which exists in the opencode API but is undocumented and unstable).
- **Durable recency uses the last three recorded source sessions.** Session IDs are retained in a bounded history, while older decisions remain available through the recall tools.
- **Event handlers are fire-and-forget.** opencode does not await async event handlers. If opencode exits while `writeMemoryOnIdle` is in flight, the write may not complete. Atomic writes (temp file + rename) prevent corruption — the worst case is a missed write, never a corrupt file.
- **Non-git directories.** opencode sets `worktree` to `/` in non-git directories. The plugin falls back to `directory` (session CWD) in this case.

## Architecture

```
src/
  index.ts                # Plugin entry — wires all hooks
  types.ts                # Shared types (CompactionInput, TranscriptPart, etc.)
  config.ts               # Options + kill switch (TOKENMAXXER_NO_PROMPT)
  memory/
    schema.ts             # Zod schemas (MemoryFile, Decision, ActiveFile)
    migrate.ts            # Version-aware migration (v1 → v2)
    store.ts              # Read/write STATE.json (cached, mtime-invalidated, corrupt recovery)
    writer.ts             # Heuristic/LLM extraction, merge, prune, HEADER.md generation
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
npm install          # Install dev deps (vitest, tsup, typescript, zod, @opencode-ai/plugin)
npm test            # Run the test suite
npm run build       # Build to dist/index.js (ESM)
npx tsc --noEmit    # Type check
```

## Project structure

```
docs/
  PLAN.md            # Original 708-line design spec
  IMPLEMENTATION.md  # Build guide with function specs, test plan, corrected milestone order
  journal.md         # Progress journal — every change logged with findings
test/
  fixtures/          # Transcript fixtures for heuristic extraction tests
  memory/            # Schema, merge, prune, writer, migrate tests
  compaction/        # Prompt, durable, bounded policy tests
  tools/             # Recall, efficiency, status tool tests
```

## License

MIT
