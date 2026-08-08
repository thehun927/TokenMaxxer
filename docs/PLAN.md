# tokenmaxxer — opencode plugin for session longevity & cross-session memory

> A build plan for an opencode plugin. Self-contained: another LLM (or human) can execute this from prompt 1.
> Target: opencode plugin (no fork). TypeScript. Single npm package, also usable as a local plugin.

---

## 0. Goal & success criteria

**Problem (confirmed from user):** the dominant pain is *post-compaction quality drop* — when opencode's built-in compaction fires, the model loses track of state/decisions and work degrades. Secondary: a large durable knowledge base spread across multiple projects, needing cheap cross-session recall without re-loading full context.

**Not the problem:** hard context-window exhaustion (raw headroom). Built-in `compaction.prune` + `reserved` handle that; we don't optimize for it.

**Architecture (two layers, both pure plugin):**
1. **Compaction-quality hook** — `experimental.session.compacting` injects structured durable state + replaces the compaction prompt with a schema-constrained one. Targets the actual pain.
2. **Per-project durable memory** — written on `session.idle`, read by pull-based custom tools (`recall_*`) and injected as a small header at session start. Keyed by project `worktree`/`directory` for multi-project isolation. Optional vector index behind `search_kb` as a v2 if the structured memory exceeds ~4KB.

**Success criteria:**
- After compaction fires, the model can correctly answer "what were we doing, which files, what decisions are locked in?" without re-reading files.
- A brand-new session on a previously-worked project boots with <1KB of injected header and can pull prior decisions via a tool call.
- Zero forks. Works as a local plugin (`.opencode/plugins/`) or npm package.

**Non-goals:** per-turn history rewriting (requires a hook opencode doesn't expose — would need forking), general-purpose RAG over arbitrary corpora, UI changes.

---

## 1. Verified opencode surface (the contract we build against)

Confirmed against opencode docs (https://opencode.ai/docs/, Aug 2026). Everything below is documented; no guessing.

### Plugin model
A plugin is a JS/TS module exporting a function that returns a hooks map:

```ts
import type { Plugin } from "@opencode-ai/plugin"
export const TokenmaxxerPlugin: Plugin = async (ctx) => {
  // ctx: { project, client, $, directory, worktree }
  return { /* hooks */ }
}
```
- Load from `.opencode/plugins/*.ts` (project) or `~/.config/opencode/plugins/*.ts` (global), or via `"plugin": ["tokenmaxxer"]` in `opencode.json` (npm).
- External deps require a `package.json` in the config dir; opencode runs `bun install` at startup.

### Hooks we use
| Hook | Fires | Purpose in this plugin |
|---|---|---|
| `experimental.session.compacting` | before LLM generates the continuation summary | **Layer 1.** Inject durable-state block; optionally replace compaction prompt. |
| `event` with `event.type === "session.idle"` | when a session finishes responding | **Layer 2.** Trigger memory-writer. |
| `event` with `event.type === "session.created"` | new session | **Layer 2.** Inject small memory header. |
| `tool` (plugin sub-object) | always (registers tools) | **Layer 2.** Register `recall_*` custom tools. |

Other available events (not used v1, listed for awareness): `session.compacted`, `session.updated`, `message.updated`, `message.part.updated/removed`, `tui.prompt.append`, `tool.execute.before/after`.

> **CORRECTED:** `tui.prompt.append` is an *event* (subscribed via the `event` hook when `event.type === "tui.prompt.append"`) — **not** a hook key. The §5.4 (B) fallback path was correctly using it as an event, but the wording in this section was ambiguous. See also bug note 5 below.

### SDK client (verified — critical capability)
The `client` passed to plugins exposes full on-demand transcript access:

```ts
// List messages in a session — returns full transcript with parts
const { data } = await client.session.messages({ path: { id: sessionId } })
// Each entry: { info: Message, parts: Part[] }

// Get a single message
const { data } = await client.session.message({ path: { id: messageId } })

// Session metadata (title, etc.)
const { data } = await client.session.get({ path: { id: sessionId } })
```
**Implication:** the memory-writer does NOT need to accumulate from streaming `message.updated` events. It pulls a clean transcript once on `session.idle`. This is the key simplification.

Other relevant client methods:
- `client.session.list()` — all sessions (use to find recent sessions for a project).
- `client.app.log({ body: { service, level, message, extra } })` — structured logging (use this, not `console.log`).
- `client.tui.appendPrompt({ body: { text } })` — append to prompt buffer (alternative to `tui.prompt.append` event for session-start injection; pick one — see §5).
- `client.file.read({ query: { path } })`, `client.find.*` — file access if needed.

### Custom tools
Defined inside the plugin's `tool` sub-object using the `tool()` helper (Zod schemas):

```ts
import { type Plugin, tool } from "@opencode-ai/plugin"

export const TokenmaxxerPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      recall_decision: tool({
        description: "Recall a prior decision for this project. Call before assuming context continuity.",
        args: { query: tool.schema.string().describe("Topic or keyword") },
        async execute(args, context) {
          const { worktree, directory } = context
          // read from per-project memory store, return matching decisions
          return "..."
        },
      }),
    },
  }
}
```
- Tool name = key in the `tool` object.
- `context` provides `agent, sessionID, messageID, directory, worktree` — use `worktree` (or `directory`) as the project key for memory isolation.
- Custom tools appear alongside built-ins; model decides when to call.

### Config knobs (document users should set, not part of plugin code)
Users add to their `opencode.json`:
```jsonc
{
  "compaction": { "auto": true, "prune": true, "reserved": 10000 },
  "instructions": ["AGENTS.md", ".opencode/memory/HEADER.md"]
}
```
- `compaction.prune: true` — drops old tool outputs (the bulk of tokens). Complements, doesn't replace, our compaction hook.
- `instructions` glob — loads static files into the system prompt. We can generate `HEADER.md` per-project (the <1KB index pointer). Alternative to `tui.appendPrompt` for session-start injection; see §5 for the decision.

### Constraints / what we cannot do (no fork)
- **No per-turn "rewrite outgoing history before send" hook.** The only history-shaping hook is `experimental.session.compacting`, which fires *only when compaction triggers*, not every turn. We do not attempt per-turn pruning.
- **No hook to read/modify the raw system prompt at session start** (the compaction hook only affects the compaction prompt; `instructions` files are the documented lever for system-prompt augmentation, applied at startup).
- **No documented hook for "session is about to send to LLM".** If we later need per-turn intervention, that's fork territory — out of scope v1.

---

## 2. File structure of the plugin

Ship as an npm package `tokenmaxxer` with a single entry point. Also works as a local plugin by symlinking or copying `dist/index.js` into `.opencode/plugins/`.

```
tokenmaxxer/
  package.json              # deps: @opencode-ai/plugin, zod (peer)
  tsconfig.json
  src/
    index.ts                # plugin entry — exports TokenmaxxerPlugin, wires hooks
    memory/
      store.ts              # per-project memory store (read/write/append) — keyed by worktree
      schema.ts             # MemoryFile schema (zod) + types
      writer.ts             # builds MemoryFile from a session transcript
      reader.ts             # queries memory for recall_* tools + header generation
    compaction/
      prompt.ts             # the schema-constrained compaction prompt (Layer 1)
      durable.ts            # builds the durable-state block pushed into compaction
    tools/
      recall.ts             # recall_decision, get_active_files tools (Layer 2)
    inject/
      header.ts             # generates the <1KB HEADER.md per project; session-start injection
    util/
      git.ts                # get current git SHA for staleness tagging
      log.ts                # wraps client.app.log
  dist/                      # built output (gitignored)
  README.md
```

**Why this split:** `memory/`, `compaction/`, `tools/`, `inject/` map 1:1 to the four mechanisms in the design. Each is independently testable. `index.ts` is thin wiring.

---

## 3. Data model — the per-project memory file

Stored at `<worktree>/.opencode/memory/STATE.json` (per-project, gitignorable; or under `~/.config/opencode/memory/<hash>/STATE.json` for global). Decide in §5. Schema:

```ts
// src/memory/schema.ts
import { z } from "zod"

export const DecisionSchema = z.object({
  id: z.string(),                       // uuid or slug
  topic: z.string(),
  decision: z.string(),                 // what was decided
  rationale: z.string().optional(),     // why
  timestamp: z.string().iso(),
  git_sha: z.string().optional(),       // repo state when recorded
  session_id: z.string(),
  still_valid: z.boolean().default(true),
})
export type Decision = z.infer<typeof DecisionSchema>

export const ActiveFileSchema = z.object({
  path: z.string(),
  reason: z.string(),                   // why we care about it
  last_touched: z.string().iso(),
})
export type ActiveFile = z.infer<typeof ActiveFileSchema>

export const MemoryFileSchema = z.object({
  version: z.literal(1),
  project_path: z.string(),             // the worktree/directory key
  last_updated: z.string().iso(),
  last_git_sha: z.string().optional(),
  last_session_id: z.string().optional(),
  current_task: z.string().optional(),  // one-line "what we're doing now"
  active_files: z.array(ActiveFileSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  blockers: z.array(z.string()).default([]),
  next_steps: z.array(z.string()).default([]),
})
export type MemoryFile = z.infer<typeof MemoryFileSchema>
```

**Design rules:**
- Capped size. Hard cap: 8KB on disk. Writer (§4.2) enforces by pruning oldest decisions with `still_valid: true` that haven't been touched in N sessions. If cap exceeded regularly → that's the trigger to consider v2 vector index.
- Every entry is timestamped + git-SHA'd so the model (and the user) can detect staleness. The compaction prompt and recall tools are instructed to surface the SHA so the model doesn't hallucinate continuity on a stale file.
- `still_valid` flips to `false` when a newer decision on the same `topic` is recorded. Reader filters them out by default but keeps them for audit.
- **Schema migration: add a `migrate(v1→vN)` step in `readMemory`.** The `version: 1` literal is in the schema but no loader-side migration is defined. When the schema changes, old `STATE.json` files will fail zod validation and the user loses their memory. Add a small migration table now even if v1 is the only version.

---

## 4. Layer 1 — Compaction-quality hook (build first, highest value)

### 4.1 The hook wiring (`src/index.ts`)
```ts
import type { Plugin } from "@opencode-ai/plugin"
import { buildCompactionPrompt } from "./compaction/prompt"
import { buildDurableBlock } from "./compaction/durable"
import { writeMemoryOnIdle, injectHeaderOnCreate } from "./memory/store"
import { registerTools } from "./tools/recall"

export const TokenmaxxerPlugin: Plugin = async (ctx) => {
  const { client, directory, worktree } = ctx
  return {
    "experimental.session.compacting": async (input, output) => {
      // 1. Load the per-project memory (durable facts accumulated across sessions)
      const durable = await buildDurableBlock({ worktree, directory, client, input })
      output.context.push(durable)
      // 2. Replace the compaction prompt with a schema-constrained one.
      //    (When output.prompt is set, output.context is ignored by opencode —
      //     so fold `durable` INTO the prompt string instead. See note below.)
      output.prompt = buildCompactionPrompt(durable)
    },
    "event": async ({ event }) => {
      if (event.type === "session.idle") {
        await writeMemoryOnIdle({ client, worktree, directory, event })
      }
      if (event.type === "session.created") {
        await injectHeaderOnCreate({ client, worktree, directory, event })
      }
    },
    ...registerTools(ctx),
  }
}
```

> **Doc-verified gotcha:** when `output.prompt` is set in the compaction hook, `output.context` is ignored. So we fold the durable block *into* the prompt string rather than using both. `buildCompactionPrompt(durable)` takes the durable block and interpolates it into the structured prompt.

### 4.2 The compaction prompt (`src/compaction/prompt.ts`)
Schema-constrained. Freeform compaction prompts are what cause quality drop — they leave what survives up to the model. We constrain it.

```ts
export function buildCompactionPrompt(durable: string): string {
  return `You are generating a continuation prompt for an opencode session that has run out of context window space. The summary you produce REPLACES the entire conversation history for the agent that resumes this work, so it must be self-sufficient.

Produce a summary with EXACTLY these sections, in this order, each prefixed with its header:

## Current task
One paragraph: what we are doing and why. If no clear task, say "No active task."

## Active files
A bullet list. Each line: \`<path> — <why it matters to the current task>\`. Only files the task depends on. Omit files merely read for exploration.

## Locked decisions
A bullet list. Each line: \`<topic>: <decision> (SHA <git_sha>, <date>)\`. Only decisions that are settled and should NOT be relitigated. If none, write "None."

## Open questions
A bullet list of unresolved decisions or questions still in play.

## Blockers
A bullet list. If none, write "None."

## Next steps
A numbered list of the concrete next 1-3 actions to advance the task.

## What NOT to redo
A bullet list of approaches already tried and rejected, with one-line reasons. If none, write "None."

Rules:
- Do NOT include code snippets. Reference file paths + line numbers instead.
- Do NOT include tool outputs. Summarize their conclusions.
- If a section would be empty, write the "None"/"No active task" literal — do not omit the section header.
- Treat the DURABLE CONTEXT block below as ground truth; it survives compaction. Prefer it over the conversation if they conflict.

### DURABLE CONTEXT (persists across sessions, verify against git SHA before trusting)
${durable}`
}
```

### 4.3 The durable block (`src/compaction/durable.ts`)
Built from the per-project memory file (Layer 2 output), not from the dying session — so accumulated knowledge survives, not just the current session's content.

```ts
export async function buildDurableBlock({ worktree, directory, client, input }): Promise<string> {
  const mem = await readMemory({ worktree, directory })  // from store.ts
  if (!mem) return "(no prior project memory)"
  const lines: string[] = []
  lines.push(`Project: ${mem.project_path}`)
  lines.push(`Last updated: ${mem.last_updated}  git SHA: ${mem.last_git_sha ?? "unknown"}`)
  if (mem.current_task) lines.push(`Current task: ${mem.current_task}`)
  if (mem.active_files.length) {
    lines.push("Active files:")
    for (const f of mem.active_files) lines.push(`  - ${f.path} — ${f.reason}`)
  }
  const valid = mem.decisions.filter(d => d.still_valid)
  if (valid.length) {
    lines.push("Valid decisions:")
    for (const d of valid) lines.push(`  - ${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${d.timestamp})`)
  }
  if (mem.blockers.length) lines.push(`Blockers: ${mem.blockers.join("; ")}`)
  if (mem.next_steps.length) lines.push(`Next: ${mem.next_steps.join("; ")}`)
  return lines.join("\n")
}
```

### 4.4 Acceptance test for Layer 1
Manual but structured:
1. Start a session, do real work across 5+ turns with file edits and a decision ("use Postgres, not SQLite").
2. Force compaction (keep going until it fires, or trigger via a long task).
3. After compaction, ask the model: "what are we doing, which files, what DB did we pick and why?" without re-reading.
4. Pass = model answers all three correctly from the summary alone.
5. Fail = iterate on `buildCompactionPrompt` (most likely: a section is being omitted or filled with "None" when it shouldn't be).

---

## 5. Layer 2 — Per-project durable memory

### 5.1 Memory store (`src/memory/store.ts`)
- Location decision: store at `<worktree>/.opencode/memory/STATE.json` (per-project, can be committed or gitignored per user preference). Global fallback `~/.config/opencode/memory/<sha(worktree)>/STATE.json` if `<worktree>` is read-only. Prefer the worktree path — it's the natural isolation key and survives across sessions on the same checkout.
- Read: `readMemory({ worktree, directory })` → `MemoryFile | null`. Caches in a module-level Map keyed by worktree; invalidated on write.

> **CORRECTED — `worktree` is the *git worktree root*, not the session CWD.** `ctx.worktree` is the parent project's git worktree root. For monorepos where you `cd` into a sub-package and run opencode from there, all sub-packages share the same `worktree` and therefore the same `STATE.json`. For monorepo users, the isolation key should be `ctx.directory` (the session CWD), not `ctx.worktree`. Decision for v1: use `worktree` as the primary key, with a config option `memory.key: "worktree" | "directory"` to switch. Default `"worktree"` matches the simpler single-repo case most users will have.

- Write: `writeMemory({ worktree, directory }, mem)` — atomic write (temp file + rename). Enforces the 8KB cap by calling `pruneOld(mem)`.

### 5.2 The writer (`src/memory/writer.ts`)
Triggered on `session.idle`. This is where the verified SDK capability matters.

```ts
import type { Plugin } from "@opencode-ai/plugin"

// Verified EventSessionIdle shape (from opencode sdk types.gen.ts):
//   { type: "session.idle", properties: { sessionID: string } }
// Verified EventSessionCreated shape:
//   { type: "session.created", properties: { info: Session } }  // sessionID lives on info.id
// Verified EventSessionCompacted shape:
//   { type: "session.compacted", properties: { sessionID: string } }

const TRANSCRIPT_WINDOW = 50  // cap considered turns; full transcripts can be MBs

export async function writeMemoryOnIdle({ client, worktree, directory, event }) {
  // CORRECTED: properties.sessionID is flat (not nested under .session).
  const sessionId = event.properties?.sessionID
  if (!sessionId) return

  // Pull the FULL clean transcript on demand — verified SDK method.
  // Cap to the most recent N turns to bound memory + parse cost on long sessions.
  const { data: messages } = await client.session.messages({ path: { id: sessionId } })
  if (!messages || messages.length === 0) return
  const recent = messages.slice(-TRANSCRIPT_WINDOW)

  const gitSha = await getCurrentGitSha(worktree)  // util/git.ts via Bun.$ git rev-parse HEAD
  const existing = await readMemory({ worktree, directory }) ?? emptyMemory(worktree)

  // Extract structured facts from the transcript using a *cheap* model call
  // OR a heuristic pass. Decision: use heuristic pass for v1 (no extra LLM cost,
  // no dependency on a second model). Promote to LLM extraction in v1.1 if heuristics miss too much.
  const extracted = extractFactsHeuristic(messages)  // { current_task, active_files, decisions, blockers, next_steps }

  const updated: MemoryFile = mergeMemory(existing, extracted, {
    sessionId, gitSha, timestamp: new Date().toISOString(),
  })

  await writeMemory({ worktree, directory }, pruneOld(updated))
}
```

**Heuristic extraction (`extractFactsHeuristic`)** — v1 approach, no LLM cost:
- `active_files`: collect all paths from tool calls to `read`/`edit`/`write`/`bash` (parse tool args); rank by frequency; keep top 5 with `reason` = "edited" / "read N times".
- `decisions`: scan assistant text for sentences matching `/^(decision|decided|let's|we'll (use|go with)|chose|picked)\b/i`; dedupe by topic keyword; flag `still_valid`.

> **CORRECTED — heuristic extraction scope is too narrow.** Decisions are frequently stated in user text (e.g. "let's use Postgres") or in tool outputs (build output confirming a config, test output confirming a library version). The original heuristic only scans assistant text. Add two more sources: (a) the first user message of the session (often contains the task decision), and (b) `ToolPart` outputs with `state.status === "completed"` where the output text contains decision-keywords. The v1.1 LLM-extraction upgrade is still the right long-term move; this just makes v1 less anemic.

- `current_task`: first user message text, truncated to 200 chars.
- `blockers` / `next_steps`: scan for "blocked", "TODO", "next", "then" in the last assistant message.
- This is crude. That's intentional — v1 proves the loop. If it misses real decisions, upgrade to a `small_model` LLM extraction pass in v1.1 (configurable via plugin options).

**`mergeMemory` rules:**
- New decisions with a topic matching an existing one (case-insensitive substring) flip the old one's `still_valid` to false and append the new one.
- `active_files` replaces the list (latest wins), but preserves `reason` for files still present.
- `current_task` always overwrites.
- `blockers`/`next_steps` overwrite.
- Cap check: if serialized > 8KB, drop oldest `still_valid: false` decisions first, then oldest `still_valid: true` decisions older than 30 days.

### 5.3 The recall tools (`src/tools/recall.ts`)
Pull-based — the model fetches only what it needs. This is how the large-KB case stays cheap on new sessions.

```ts
import { tool } from "@opencode-ai/plugin"
import { readMemory } from "../memory/store"

export function registerTools(ctx): { tool: Record<string, ReturnType<typeof tool>> } {
  return {
    tool: {
      recall_decision: tool({
        description: "Recall a prior decision for this project. CALL THIS before assuming continuity with a previous session. Returns the decision and its date/git-SHA so you can judge staleness.",
        args: { query: tool.schema.string().describe("topic or keyword") },
        async execute(args, context) {
          const mem = await readMemory({ worktree: context.worktree, directory: context.directory })
          if (!mem) return "No project memory yet."
          const hits = mem.decisions.filter(d => d.still_valid && d.topic.toLowerCase().includes(args.query.toLowerCase()))
          if (!hits.length) return `No valid decisions matching "${args.query}".`
          return hits.map(d => `${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${d.timestamp})`).join("\n")
        },
      }),
      get_active_files: tool({
        description: "List files actively being worked on in this project, with why each matters. Use to avoid re-discovering them.",
        args: {},
        async execute(_args, context) {
          const mem = await readMemory({ worktree: context.worktree, directory: context.directory })
          if (!mem || !mem.active_files.length) return "No active files recorded."
          return mem.active_files.map(f => `${f.path} — ${f.reason}`).join("\n")
        },
      }),
      get_project_state: tool({
        description: "Full project memory header: current task, active files, valid decisions, blockers, next steps. Call once at session start if resuming work.",
        args: {},
        async execute(_args, context) {
          const mem = await readMemory({ worktree: context.worktree, directory: context.directory })
          if (!mem) return "No project memory. This looks like a fresh start."
          return [
            `Project: ${mem.project_path}`,
            `Last: ${mem.last_updated} (SHA ${mem.last_git_sha ?? "?"})`,
            `Task: ${mem.current_task ?? "—"}`,
            `Active files: ${mem.active_files.map(f => f.path).join(", ") || "none"}`,
            `Decisions: ${mem.decisions.filter(d=>d.still_valid).map(d=>d.topic).join(", ") || "none"}`,
            `Blockers: ${mem.blockers.join("; ") || "none"}`,
            `Next: ${mem.next_steps.join("; ") || "none"}`,
          ].join("\n")
        },
      }),
    },
  }
}
```

> **CORRECTED — recall tool gaps:**
> 1. Every tool's first line should be `Project: ${mem.project_path}` so the model can sanity-check isolation (relevant when multiple projects are open in tabs or in a subagent's view).
> 2. `recall_decision` uses substring match on `topic` only — too narrow for 30+ decisions where the model can't guess the exact topic. Add an `args.limit` (default 10) and allow `args.query` to be empty to return the **most recent N valid decisions** sorted by `timestamp` desc. This is what the model actually needs on a fresh session boot.
```

### 5.4 Session-start injection (`src/inject/header.ts`)
Two mechanisms available; pick one:

- **(A) `instructions` glob + generated `HEADER.md`** — write `<worktree>/.opencode/memory/HEADER.md` (a <1KB pointer: "Project X, last session Y, call `get_project_state` for details"). List it in `opencode.json` `"instructions"`. Pro: loaded into system prompt automatically at startup, no hook needed. Con: static file; regenerating it on `session.idle` means the *next* session sees it. Con: `instructions` may be cached at startup — verify timing.
- **(B) `session.created` event → `client.tui.appendPrompt`** — inject the header text into the prompt buffer on every new session. Pro: always fresh. Con: goes into the user prompt buffer, not the system prompt; may require user to submit. Less clean.

**Decision for v1:** use (A). It's the documented system-prompt augmentation path, it's what `instructions` is for, and the staleness lag (one session) is acceptable. Fallback to (B) if startup caching makes (A) stale.

> **CORRECTED — (B) is not a real fallback, and there's a better one.** `client.tui.appendPrompt` puts text in the *user* prompt buffer, which won't be visible to the model until the user submits — strictly worse than (A) for session-start injection. If (A) turns out to cache stale at startup, the correct runtime injection path is **`client.session.prompt({ path: { id: sessionId }, body: { noReply: true, parts: [{ type: "text", text: header }] } })`** — confirmed in the SDK docs as "Inject context without triggering AI response (useful for plugins)". This appends to the system context immediately without a round-trip. Use it from a `session.created` handler with `event.properties.info.id` (NOT `.sessionID` — the field is on `info`, verified in `EventSessionCreated` type).

`HEADER.md` template (generated on `session.idle`):
```markdown
<!-- tokenmaxxer project memory header — auto-generated, do not edit -->
# Project: <name>
Last session: <date> (git SHA <sha>)
Current task: <one line>
This project has accumulated memory. Call the `get_project_state` tool to load prior decisions, active files, and next steps before assuming continuity.
```

### 5.5 Acceptance tests for Layer 2
1. Work on project A (worktree `/proj-a`). Confirm `STATE.json` exists at `/proj-a/.opencode/memory/STATE.json` after `session.idle`.
2. Start a new session in `/proj-a`. Confirm `HEADER.md` is in scope (check the model references it) and that calling `get_project_state` returns the prior task/decisions.
3. Start a session in project B (`/proj-b`). Confirm `get_project_state` returns "No project memory" — isolation works, no cross-project leakage.
4. Make a conflicting decision in project A's new session ("actually use MySQL"). Confirm the old Postgres decision is now `still_valid: false` and `recall_decision("database")` returns MySQL.

> **CORRECTED — test 2 is non-deterministic.** "Check the model references it" is not a verifiable assertion. The test should instead: (a) run `opencode debug config` and confirm the `instructions` list includes `.opencode/memory/HEADER.md`, and (b) call `get_project_state` and confirm it returns the expected data. Do not assert on model text.

---

## 6. Prompt-level efficiency (do this first, costs nothing)

Before writing any plugin code, set in `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": { "auto": true, "prune": true, "reserved": 10000 },
  "small_model": "<cheapest model from your provider>",
  "agent": {
    "build": {
      "permission": { "webfetch": "deny", "websearch": "deny" }  // disable any tool you don't use
    }
  },
  "provider": {
    "anthropic": { "options": { "setCacheKey": true } }  // Anthropic only; cuts cost/latency, not tokens
  },
  "instructions": ["AGENTS.md", ".opencode/memory/HEADER.md"]
}
```

Rationale:
- `compaction.prune: true` — biggest single token saver; drops old tool outputs. Independent of our plugin; complementary.
- `compaction.reserved` — leave headroom so compaction doesn't overflow. 10000 is a starting point; tune. **Set proportional to the durable-block max size** — if durable can be 4KB, `reserved` should be `4KB + model headroom for the summary itself`, not a flat guess.
- `small_model` — offloads title/summary generation from the main model. **Note:** the docs only explicitly state `small_model` is used for *title* generation. Whether it is also used for the built-in `compaction` summary is not documented; if it is not, set `compaction.reserved` more aggressively (e.g. 20000) so the main model has room to write a quality summary.
- Disable unused tools per-agent — tool schemas are a large fixed system-prompt cost.
- `setCacheKey` — Anthropic prompt caching; doesn't reduce tokens but reduces cost/latency, extending the practical session budget.
- `instructions` — wires in the Layer 2 header (once implemented).

**Additional prompt-efficiency wins not in the original list (verified against opencode docs):**
- `"tools": { "webfetch": false, "websearch": false }` at the **top level** (not per-agent) — disables for every agent in one line. Cheaper than the per-agent version if you never use these.
- `"watcher": { "ignore": ["node_modules/**", "dist/**", ".git/**", ".opencode/memory/**"] }` — drops file-watcher noise; also stops any future hook from being re-fired by its own writes.
- `"experimental.primary_tools": ["<list>"]` — restricts the listed tools to primary agents only; subagents won't see them. Useful for hiding heavy tools (and tokenmaxxer's own recall tools, if you want them available to the main agent but not the explore/scout subagents).
- `"permission": { "todowrite": "deny" }` if you don't use todo lists — saves tool-schema tokens in every session.

**Order of operations:** apply these config changes and use opencode normally for a few sessions *before* building the plugin. If compaction quality is still the pain after `prune: true` + a reasonable `reserved`, proceed to build. Don't build speculatively.

> **CORRECTED — the M0 gate should be a measurement, not a vibe.** "Use for a few sessions" is not a verifiable exit criterion. Concrete measurement: before applying the config, run `client.session.list()` and record the typical `time.compacting` field on sessions that have been compacted (it's on the `Session` type, per `types.gen.ts`). After applying `prune: true` + tuned `reserved`, run the same query. If the average compacted session length (in `StepFinishPart.tokens.input + .output`) is materially lower and the post-compaction quality still drops, the plugin is justified. If `prune: true` alone is enough, stop at M0. The plugin is only worth building if the underlying context-pressure problem is real.

---

## 7. Build order & milestones

**M0 — Config tuning (no code, 1 hour):** Apply §6 config. Validate the pain persists after `prune: true`. Gate: if compaction quality is fine after config, stop here.

**M1 — Layer 1 compaction hook (the real first build, ~1 day):**
- `src/compaction/prompt.ts`, `src/compaction/durable.ts`
- Stub `readMemory` returning null (durable block = "(no prior memory)")
- `src/index.ts` wiring the `experimental.session.compacting` hook only
- Run the §4.4 acceptance test
- Gate: the post-compaction recall test passes

**M2 — Layer 2 memory store + writer (~1-2 days):**
- `src/memory/schema.ts`, `src/memory/store.ts`, `src/memory/writer.ts`
- `src/util/git.ts`, `src/util/log.ts`
- Wire `session.idle` → `writeMemoryOnIdle`
- Confirm `STATE.json` appears and looks sane after a real session
- Heuristic extraction only (no LLM extraction yet)
- Gate: §5.5 tests 1-4 pass (isolation, conflict resolution)

**M3 — Recall tools + header injection (~1 day):**
- `src/tools/recall.ts` (three tools)
- `src/inject/header.ts` generating `HEADER.md` on `session.idle`
- User adds `.opencode/memory/HEADER.md` to `instructions`
- Gate: new session on prior project boots with <1KB header and `get_project_state` returns real data

**M4 — Package & polish (~0.5 day):**
- `package.json`, `tsconfig.json`, build to `dist/index.js`
- README with install + config instructions
- Decide npm publish vs. local-plugin distribution

**M3.5 — Prompt-efficiency tools (~0.5 day, ship with M3):**

These tools directly address the user's "make prompting in opencode more efficient" goal. They are cheap, mechanical, and ride on the same `registerTools` machinery as the recall tools.

```ts
// src/tools/efficiency.ts
import { tool } from "@opencode-ai/plugin"
import { readFile } from "../util/fs"  // wraps client.file.read

// Tool: pull a short summary of several files at once, instead of the model
// reading each one whole and burning context on raw bytes.
summarize_files: tool({
  description: "Read a list of files and return a short summary of each. Use instead of calling `read` on large files when you only need to know what they contain.",
  args: {
    paths: tool.schema.array(tool.schema.string()).describe("File paths to summarize, relative to the worktree."),
    budget: tool.schema.number().default(40).describe("Approx. lines of summary per file."),
  },
  async execute(args, context) {
    const out: string[] = []
    for (const p of args.paths) {
      const content = (await context.client.file.read({ query: { path: p } })).data?.content ?? ""
      // Truncate to first N lines and append an ellipsis marker. The model can
      // call `read` on the full file later if it actually needs the rest.
      const head = content.split("\n").slice(0, args.budget).join("\n")
      out.push(`### ${p}\n${head}${content.split("\n").length > args.budget ? "\n…(truncated)" : ""}`)
    }
    return out.join("\n\n")
  },
}),

// Tool: force-compact now, returning the durable-state block formatted exactly
// like buildDurableBlock does. Lets the model ask "what would survive compaction?"
// mid-session and act on it before context actually runs out.
compact_now: tool({
  description: "Return the same durable-state block that would be injected at the next compaction. Call this when context is getting large and you want to know what would survive before compaction fires.",
  args: {},
  async execute(_args, context) {
    return buildDurableBlock({ worktree: context.worktree, directory: context.directory, client: context.client, input: {} })
  },
}),
```

**Why these belong in the plugin (not as separate config):**
- They depend on the same `readMemory` and `buildDurableBlock` paths that Layer 1/2 already produce, so they cost ~50 LOC and zero new abstractions.
- They save tokens *without* depending on the model deciding to call them — the descriptions are phrased so the model reaches for them on its own when context is large or when exploring.
- `compact_now` is a unique affordance: no other tool lets the model "preview" the compaction prompt mid-session.

**Test for M3.5:** in a long session that hasn't yet triggered compaction, call `compact_now` and confirm it returns the same `## Current task / Active files / Locked decisions` shape that the post-compaction summary would have. Pass = identical schema; Fail = format drift between the tool output and the compaction prompt.

**M4 — Package & polish (~0.5 day):**
- `package.json`, `tsconfig.json`, build to `dist/index.js`
- README with install + config instructions
- Decide npm publish vs. local-plugin distribution

**M4.5 — Bounded durable block on every compaction (~0.5 day, ship with M4):**

The current `buildDurableBlock` (4.3) re-includes *all* valid decisions, every time compaction fires. For long-lived projects this grows unbounded — 8KB of decisions injected at every compaction, even when 90% are settled and irrelevant to the current task. This makes the compaction prompt itself a slow leak.

**Policy — add to `buildDurableBlock`:**

1. **Always include** (full set, no truncation):
   - `current_task` (one line)
   - `blockers`, `next_steps` (small lists by design)
2. **Conditionally include** valid decisions, in this priority:
   - Decisions tagged `foundational: true` (new field on `Decision` schema — see below) — always included
   - Decisions touched in the **last 3 sessions** (track via `last_session_id` + a new `last_used_in_session` field) — always included
   - Everything else: include only the **5 most recent by `timestamp`** as a "## Older decisions" section with a one-line-per-decision format (topic + decision + SHA, no rationale)
3. **Always include** `active_files` capped at top 8 by `last_touched`.

**Schema additions** (additive, no v1→v2 migration needed because both fields are optional):

```ts
export const DecisionSchema = z.object({
  // ...existing fields...
  foundational: z.boolean().default(false),    // promoted by model via recall_promote tool
  last_used_in_session: z.string().optional(),  // set by writer when decision is referenced
})
```

**Heuristic for auto-marking `foundational`:** on `mergeMemory`, any decision matching one of these patterns in the *original* assistant text is auto-marked foundational:
- `/we (will|'ll) (always|never)/i`
- `/architect(ure)? decision/i`
- `/breaking change/i`
- `/migrat(e|ion|ing) to /i`
- `/this (changes|breaks) the (public )?api/i`

The model can also call a new `recall_promote(topic)` tool (added to `recall.ts`) to manually mark a decision foundational. This gives the user explicit control.

**Why this matters:** without the policy, a 6-month-old project with 200 decisions injects 4KB of decision text into every compaction prompt, every turn the model thinks about anything. With the policy, the durable block stays roughly constant as the project grows — older knowledge is reachable via `recall_decision` (a tool call, not an injection) but doesn't bloat the compaction prompt.

**Test for M4.5:**
1. Seed a memory file with 50 valid decisions, only 2 of them `foundational` and 3 of them touched in the last 3 sessions.
2. Trigger `buildDurableBlock` (call `compact_now` tool or just exercise the function in a unit test).
3. Assert: the 2 foundational + 3 recent = 5 are full-fidelity; 5 most recent of the rest appear in `## Older decisions` one-line format; the remaining 40 are not in the block.
4. Pass: block size is bounded under ~2KB even with 50 decisions seeded.

**M5 (conditional, only if structured memory exceeds 8KB regularly) — v2 vector index:**
- Add `search_kb` tool backed by a per-project vector store (e.g. `orama` or sqlite-vec — embedded, no server)
- Index: `STATE.json` content + (optionally) codebase files
- This is the embeddings path. Do NOT build it unless M2-M3 prove insufficient — it's the highest-effort, highest-maintenance piece.

---

## 8. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Compaction prompt schema is worse than default | Medium | M1 acceptance test catches it; iterate the prompt, not the code. |
| Heuristic extraction misses real decisions | High (v1) | Expected. Design `extractFactsHeuristic` to be swapped for an LLM pass in v1.1 without touching the store. |
| `session.idle` event payload shape differs from assumption | Medium | Confirm `event.properties` shape at M2 start against actual events; the docs don't fully specify it. |
| `instructions` glob caches `HEADER.md` at startup → stale | Medium | M3 tests this; fallback to `tui.appendPrompt` mechanism (B). |
| Memory file grows unbounded | Low | 8KB cap + `pruneOld` in writer. |
| Hallucinated continuity on stale memory | Medium | git-SHA + timestamp in every entry; compaction prompt instructs model to verify SHA before trusting. |
| Plugin `client` SDK not available in all plugin contexts | Low | Docs show `client` in the plugin ctx signature; if missing, plugin init should no-op gracefully with a log line. |
| Per-project memory leaks across projects via global `~/.config` | Low | Default store location is `<worktree>/.opencode/memory/` — per-project by construction. Global path only used when worktree is read-only, and is SHA-namespaced. |

---

## 9. Open questions to resolve at build time (not blocking the plan)

1. **Exact `session.idle` event payload** — does it carry `sessionID` directly, or nested? Confirm at M2 start by logging the event. Docs list the event but not its full payload.
2. **`instructions` file refresh timing** — is `HEADER.md` re-read per session or cached at opencode startup? Determines M3 mechanism choice (A vs B). Test empirically.
3. **Plugin `client` availability** — is it always non-null, or can it be null in some load contexts? Add a guard in `index.ts`.
4. **`small_model` for extraction** — if heuristic extraction is too crude, which model to use for the extraction pass? Likely the configured `small_model`; need to confirm the plugin can read it from config via `client.config.get()`.

---

## 10. Quick reference — exact opencode APIs used

```
Plugin signature:        export const X: Plugin = async (ctx) => { return { ...hooks } }
Plugin ctx:              { project, client, $, directory, worktree }
Compaction hook:         "experimental.session.compacting": async (input, output) => { output.prompt = ... }
                         (when output.prompt is set, output.context is ignored)
Event hook:              "event": async ({ event }) => { if (event.type === "session.idle") ... }
                         EventSessionIdle.properties  = { sessionID: string }
                         EventSessionCreated.properties = { info: Session }   // sessionID on info.id
                         EventSessionCompacted.properties = { sessionID: string }
Tool registration:       "tool": { name: tool({ description, args, execute }) }
Tool execute ctx:        { agent, sessionID, messageID, directory, worktree }
Read transcript:         const { data } = await client.session.messages({ path: { id } })
Get session:             await client.session.get({ path: { id } })
List sessions:           await client.session.list()
Inject context (fallback for stale HEADER.md): await client.session.prompt({
                           path: { id: sessionId },
                           body: { noReply: true, parts: [{ type: "text", text }] }
                         })
Get current project:     await client.project.current()   // defensive fallback if ctx.worktree is missing
Get config:              await client.config.get()        // for reading small_model at runtime
Log:                     await client.app.log({ body: { service, level, message, extra } })
File find/read:          client.find.text / .files / .symbols; client.file.read({ query: { path } })
Config (user):           compaction.{auto,prune,reserved}, instructions[], small_model,
                         agent.<x>.permission.{edit,bash,webfetch,websearch,todowrite,...},
                         provider.<id>.options.{setCacheKey,timeout,chunkTimeout},
                         tools.<name> (top-level disable), watcher.ignore[],
                         experimental.primary_tools[], permission.<key> (top-level)
```

> **Deliberately not used (for awareness, in case a future reader wonders):**
> - `experimental.hook.file_edited` and `experimental.hook.session_completed` — these are *config-level* shell-hook arrays (run a command when a file is edited or a session completes), not plugin hooks. They could replace our `session.idle` writer with a shell script, but the plugin has access to the SDK transcript which a shell hook doesn't. Not worth the trade.
> - `tui.prompt.append` *event* — superseded by `client.session.prompt({ noReply: true })` for header injection (see §5.4 bug note 5).
> - `message.updated` / `message.part.updated/removed` — would only matter if we needed real-time streaming aggregation, which we don't (writer pulls full transcript on idle).

Docs: https://opencode.ai/docs/plugins/ , https://opencode.ai/docs/sdk/ , https://opencode.ai/docs/config/