# tokenmaxxer

> opencode plugin for session longevity & cross-session memory.

Solves two problems:
1. **Post-compaction quality drop** — when opencode's built-in compaction fires, the model loses track of state and decisions. tokenmaxxer injects a structured durable-state block and replaces the compaction prompt with a schema-constrained one.
2. **Cross-session durable memory** — a per-project knowledge base (`STATE.json`) that survives session restarts. Written automatically on session idle, recalled on demand via tools.

## Install

### Option A: npm package

```jsonc
// opencode.json
{
  "plugin": ["tokenmaxxer"]
}
```

### Option B: local plugin

```bash
npm run build
cp dist/index.js .opencode/plugins/tokenmaxxer.js
```

## Required config

Add to your `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["tokenmaxxer"],
  "compaction": { "auto": true, "prune": true, "reserved": 10000 },
  "instructions": ["AGENTS.md", ".opencode/memory/HEADER.md"],
  "watcher": {
    "ignore": ["node_modules/**", "dist/**", ".git/**", ".opencode/memory/**"]
  },
  "permission": {
    "webfetch": "deny",
    "websearch": "deny"
  },
  "provider": {
    "anthropic": { "options": { "setCacheKey": true } }
  }
}
```

**Why each setting:**
- `compaction.prune: true` — drops old tool outputs (biggest single token saver). Complements the plugin.
- `compaction.reserved` — headroom so compaction doesn't overflow. Start at 10000; increase to 15000-20000 if post-compaction quality matters.
- `instructions` — wires in the Layer 2 header. The plugin generates `.opencode/memory/HEADER.md` automatically on session idle; listing it here loads it into the system prompt at session start.
- `watcher.ignore` — stops the file watcher from re-firing on the plugin's own writes to `.opencode/memory/`.
- `permission` — disable tools you don't use (tool schemas are a fixed system-prompt cost). `permission` is the current API (the old `tools: { x: false }` is deprecated since v1.1.1).
- `setCacheKey` — Anthropic prompt caching; reduces cost/latency.

### .gitignore recommendation

Add to your project `.gitignore`:

```
.opencode/memory/STATE.json
.opencode/memory/last_compaction.log
.opencode/memory/*.corrupt.*
```

`STATE.json` contains session IDs, file paths, and project decisions — committing it leaks metadata. `HEADER.md` is safe to commit (it's a <1KB pointer).

## How it works

### Layer 1: Compaction-quality hook

When opencode's compaction fires (`experimental.session.compacting` hook), tokenmaxxer:

1. Reads the per-project memory file (`STATE.json`).
2. Builds a durable-state block (current task, active files, valid decisions, blockers, next steps).
3. Replaces the compaction prompt with a schema-constrained one that forces the model to produce a structured summary with exactly these sections:
   - Current task
   - Active files
   - Locked decisions
   - Open questions
   - Blockers
   - Next steps
   - What NOT to redo

The durable block is folded into the prompt as "recorded observations from prior sessions" — the model is instructed to verify against the conversation if they conflict, and to check git SHAs/timestamps before relying on a decision.

### Layer 2: Per-project durable memory

On `session.idle`, the plugin:

1. Pulls the full session transcript via the SDK.
2. Extracts structured facts using heuristics (current task, active files, decisions, blockers, next steps).
3. Merges with existing memory (superseding old decisions on the same topic).
4. Prunes to stay under 8KB.
5. Writes `STATE.json` and regenerates `HEADER.md`.

On session start, the model sees `HEADER.md` (via `instructions`) and can call tools to pull detailed memory.

### Memory isolation

Memory is keyed by `worktree` (the git worktree root) by default. For monorepos where you run opencode from sub-packages, set `memoryKey: "directory"` to isolate by session CWD instead. (Config option — not yet wired; tracked in journal.)

## Tools

The plugin registers 7 custom tools:

| Tool | Purpose |
|---|---|
| `recall_decision` | Recall prior decisions by topic. Omit query to get most recent decisions. |
| `get_active_files` | List files being worked on and why each matters. |
| `get_project_state` | Full project memory header — call once at session start when resuming. |
| `recall_promote` | Mark a decision as foundational (always included in compaction context). |
| `preview_compaction` | Preview what would survive compaction before it fires. |
| `head_files` | Read the first N lines of files (cheaper than full `read` for exploration). |
| `tokenmaxxer_status` | Plugin health: memory file path, size, decision count, last write. |

## Kill switch

If the schema-constrained compaction prompt makes things worse, disable it without uninstalling:

```bash
TOKENMAXXER_NO_PROMPT=1
```

This skips prompt replacement but still injects the durable block via `output.context`, letting opencode use its default compaction prompt.

## Debugging

- **`tokenmaxxer_status` tool** — check plugin health, memory file size, decision count.
- **`.opencode/memory/last_compaction.log`** — the exact compaction prompt injected at the last compaction. Inspect this if post-compaction quality degrades.
- **`.opencode/memory/STATE.json`** — the raw memory file. Human-readable JSON.
- **`.opencode/memory/*.corrupt.*`** — backups of corrupt STATE.json files (if the file ever fails validation).

## Limitations (v1)

- **Heuristic extraction is crude.** Decisions are detected via keyword matching (`decided`, `let's use`, `go with`, etc.) with negation detection. It will miss decisions stated in unusual phrasing and may produce false positives. v1.1 will add optional LLM-based extraction via `small_model`.
- **`last_used_in_session` tracks the current session only.** The bounded durable block (M5) includes decisions referenced in the current session as "recent." True "last 3 sessions" windowing requires a session history array (planned for v1.1).
- **No per-turn history pruning.** The plugin only intervenes at compaction time. Per-turn pruning would require the `experimental.chat.messages.transform` hook (which exists but is undocumented and unstable).

## Architecture

```
src/
  index.ts                # plugin entry — wires all hooks
  types.ts                # shared types
  config.ts               # options + kill switch
  memory/
    schema.ts             # zod schemas (MemoryFile, Decision, ActiveFile)
    migrate.ts            # version-aware migration (v1 = identity)
    store.ts              # read/write STATE.json (cached, mtime-invalidated, corrupt recovery)
    writer.ts             # extractFactsHeuristic, mergeMemory, pruneOld, generateHeader
    reader.ts             # query helpers for tools
  compaction/
    prompt.ts             # schema-constrained compaction prompt
    durable.ts            # builds durable-state block (M5: bounded policy)
  tools/
    recall.ts             # recall_decision, get_active_files, get_project_state, recall_promote
    efficiency.ts         # preview_compaction, head_files
    status.ts             # tokenmaxxer_status
  util/
    git.ts                # current git SHA (Bun.$ with child_process fallback)
    log.ts                # client.app.log wrapper (never throws)
    fs.ts                 # atomic write, safe read, mtime
```

See `docs/PLAN.md` (design) and `docs/IMPLEMENTATION.md` (build guide) for full details.

## License

MIT