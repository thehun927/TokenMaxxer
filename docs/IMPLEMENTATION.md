# tokenmaxxer — Implementation Guide (historical)

> Companion to `PLAN.md`. Read both. This guide fills the execution-level gaps the plan leaves open, corrects the build order, and adds what an engineer needs to ship without making mid-build design decisions.
>
> **Status:** the server plugin and opt-in LLM extraction flow are shipped. The
> server memory target is silent; it does not inject current-task or project
> memory text into the composer. A separate TUI target may show only a
> right-side indicator.
>
> The remaining proposal snippets are preserved as historical diagnosis, not
> as instructions to add a header injector or a system-transform hook.

---

## 0. What the reviews found

### 0.1 API verification summary (35 claims checked against live docs)

| Result | Count | Notes |
|---|---|---|
| CONFIRMED | 28 | Both critical hinges verified verbatim |
| PARTIALLY CONFIRMED | 5 | Minor underspecification (see below) |
| CONTRADICTED | 1 | The "no-fork" premise (see §0.3) |
| NOT FOUND | 1 | `client` null gotcha — source says always present |

**Critical confirmations:**
- `output.prompt` set in compaction hook → `output.context` is ignored (verbatim from docs). Layer 1 design is sound.
- The host also exposes `client.session.prompt({ body: { noReply: true, parts: [...] } })`, but the shipped server target does not use it for memory injection.

**Corrections needed:**
- `session.message({ path: { id } })` requires **both** `id` AND `messageID`: `{ path: { id, messageID } }`. The plan's signature would 404.
- OpenCode's own `small_model` setting has documented title/slug semantics;
  tokenmaxxer additionally uses the exact value as its opt-in extraction
  `provider/model` override. It is not a compaction offload setting.
- Top-level `tools: { webfetch: false }` is **deprecated since v1.1.1**. Use `permission: { webfetch: "deny" }` instead.
- `$` (Bun shell) in plugin ctx **can be undefined** when running outside Bun. `util/git.ts` using `Bun.$` needs a fallback path.
- Plugin ctx has two additional fields not in the plan: `experimental_workspace`, `serverUrl`.
- Tool execute ctx has additional fields: `abort` (AbortSignal), `metadata()`, `ask()`.

### 0.2 Architecture review — overlooked items (by severity)

**Blocking (must resolve before/during build):**
- No unit test plan at all. The four most brittle pure functions (`extractFactsHeuristic`, `mergeMemory`, `pruneOld`, bounded `buildDurableBlock`) need deterministic tests.
- False-confidence risk: heuristic extraction has no negation detection. "We decided NOT to use Postgres" records the opposite decision, which then gets injected as "ground truth" into every compaction. **False memory is worse than no memory.**
- Four pure functions lack type signatures, pseudocode, and edge-case handling — an engineer would be designing, not implementing. Full specs in Appendix A.
- Build/packaging unspecified: ESM vs CJS, build tool, `exports`/`types` fields, peer dep strategy.
- Three new blocking open questions (see §1).

**Should-fix:**
- No error boundaries on SDK calls (unhandled rejections in event handlers).
- No corrupt-STATE.json recovery path.
- No `mkdir -p` for `.opencode/memory/` on first run.
- Concurrency: lost-update on concurrent sessions, stale cache, multi-instance cache incoherence.
- `last_used_in_session` field (M4.5) is never set by the writer — the bounded block policy depends on it.
- `recall_promote` tool mentioned but never defined.
- No kill switch for compaction prompt replacement.
- No observability (status tool, compaction dump).
- First-session HEADER.md gap: superseded; the shipped server target does not generate or reference a memory header.
- Schema migration mentioned but never specified.
- M4 milestone listed twice (copy-paste error in plan).
- Version skew: no pin or version check.

**Nice-to-have:**
- `compact_now` misnamed (doesn't trigger compaction, returns preview).
- `summarize_files` is blind truncation, not summarization.
- `.gitignore` recommendation for STATE.json.

### 0.3 Final transport and composer boundary

The shipped server target does not use `experimental.chat.system.transform`,
`client.tui.appendPrompt`, or a generated `HEADER.md` to inject memory. Server
memory work is silent and does not place project or current-task text in the
composer. A separate TUI target may render only a right-side `memory`
indicator; it is not part of the server transport and is not required for
extraction.

The historical API review identified experimental hooks that could modify
messages or system prompts. Those findings are diagnosis only, not an
implementation recommendation for tokenmaxxer.

---

## 1. Phase 0 — Pre-build spike (resolve blocking unknowns)

**Time: ~30 min. Do this before any milestone work.**

The plan's §9 open questions #1 and #2 are blocking. Resolve them with a throwaway event-logging plugin, not by reading more docs.

### 1.1 Create a spike plugin

Write to `.opencode/plugins/spike-log.ts`:

```ts
import type { Plugin } from "@opencode-ai/plugin"

export const SpikeLogPlugin: Plugin = async (ctx) => {
  const { client } = ctx
  return {
    "experimental.session.compacting": async (input, output) => {
      await client.app.log({ body: { service: "spike", level: "info",
        message: "compacting hook fired",
        extra: { input, hasPrompt: !!output.prompt, contextLen: output.context.length } } })
    },
    event: async ({ event }) => {
      await client.app.log({ body: { service: "spike", level: "info",
        message: `event:${event.type}`,
        extra: { properties: event.properties } } })
    },
  }
}
```

### 1.2 Run and confirm

Start opencode, do a few turns, force compaction (long task), start a new session. Check logs. Confirm:

| Unknown | What to verify | Expected (from API verification) |
|---|---|---|
| `session.idle` payload | `event.properties.sessionID` is a string, flat | `{ sessionID: string }` |
| `session.created` payload | `event.properties.info.id` has the session ID | `{ info: Session }` |
| `session.compacted` payload | `event.properties.sessionID` is a string | `{ sessionID: string }` |
| Compaction hook `input` | What fields does `input` carry? | `{ sessionID: string }` |
| Compaction hook `output` | Confirm `.prompt` and `.context` both exist | `{ context: string[]; prompt?: string }` |
| `output.prompt` scope | Does setting it replace the entire LLM input or just the summary instruction? | It replaces the compaction prompt; model still sees original conversation |
| Event handler async | Does opencode await long-running async event handlers? | Confirm no timeout/cutoff |
| Tool key name | Is it `"tool"` or `"tools"` in the hooks map? | `"tool"` (singular) |

### 1.3 Final memory-injection check

Do not add a generated `HEADER.md` to `opencode.json` `instructions` and do
not use `experimental.chat.system.transform` for server memory. Confirm that
idle memory writes are silent and that any installed TUI indicator is confined
to the right side of the TUI.

### 1.4 Clean up

Delete the spike plugin after confirming. Record findings in a comment at the top of `src/index.ts`.

---

## 2. Phase 1 — Project scaffolding

### 2.1 Directory structure

```
tokenmaxxer/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts
    types.ts                    # shared types (compaction hook input/output, ExtractedFacts, etc.)
    config.ts                   # reads plugin options + env vars (kill switches)
    memory/
      schema.ts
      store.ts
      writer.ts
      reader.ts
      migrate.ts
    compaction/
      prompt.ts
      durable.ts
    tools/
      recall.ts
      efficiency.ts
      status.ts
    util/
      git.ts
      log.ts
      fs.ts                     # mkdir -p, atomic write, safe read
  test/
    fixtures/
      transcripts/              # sample session transcripts for heuristic tests
      states/                   # sample STATE.json files for merge/prune tests
    memory/
      writer.test.ts
      merge.test.ts
      prune.test.ts
      migrate.test.ts
    compaction/
      durable.test.ts
      prompt.test.ts
    tools/
      recall.test.ts
  dist/                         # gitignored
  README.md
  .gitignore
```

### 2.2 package.json

```json
{
  "name": "tokenmaxxer",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --external @opencode-ai/plugin --external zod",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": ">=1.0.0",
    "zod": ">=3.0.0"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0",
    "@opencode-ai/plugin": "latest"
  }
}
```

**Decisions:**
- **ESM** (`"type": "module"`) — opencode runs on Bun which handles ESM natively; the plugin SDK is ESM.
- **tsup** for building — handles ESM + DTS + externals in one config. Simpler than raw tsc for a single-entry plugin.
- **`@opencode-ai/plugin` and `zod` as peer deps** — don't bundle them. The runtime (opencode) provides them. Bundling risks version skew where the plugin's zod instance differs from opencode's, breaking `instanceof` checks.
- **Pin `@opencode-ai/plugin` to `latest` in devDeps** for type-checking; add a version check at runtime (§2.4).

### 2.3 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "declaration": true,
    "sourceMap": true,
    "lib": ["ES2022"],
    "types": ["bun-types"]
  },
  "include": ["src"],
  "exclude": ["dist", "test"]
}
```

### 2.4 .gitignore

```
dist/
node_modules/
.opencode/memory/STATE.json
.opencode/memory/last_compaction.log
*.tsbuildinfo
```

> **Recommend users add to their project .gitignore:** `.opencode/memory/STATE.json` — contains session IDs, file paths, and project decisions. Committing it leaks metadata.

---

## 3. Milestone M0 — Config tuning (no code, ~1 hour)

Follow PLAN.md §6 with these corrections:

### 3.1 Corrected opencode.json

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": { "auto": true, "prune": true, "reserved": 25000 },
  "small_model": "ollama-cloud/gpt-oss:20b",
  "permission": {
    "webfetch": "deny",    // was "tools": { "webfetch": false } — deprecated since v1.1.1
    "websearch": "deny"
  },
  "watcher": {
    "ignore": ["node_modules/**", "dist/**", ".git/**", ".opencode/memory/**"]
  },
  "provider": {
    "anthropic": { "options": { "setCacheKey": true } }
  }
}
```

**Changes from plan:**
- `tools: { webfetch: false }` → `permission: { webfetch: "deny" }` (deprecated API replaced).
- `small_model` is tokenmaxxer's exact `provider/model` override for opt-in
  extraction. `ollama-cloud/gpt-oss:20b` is a verified example for this
  environment, not a universal recommendation. Model listings do not
  guarantee authentication, entitlement, thinking/tool-choice compatibility,
  or structured-result adherence.

### 3.2 M0 measurement (resolve the chicken-and-egg)

The plan says "no code" but the measurement needs SDK queries. **Use the spike plugin from §1.1** (still in place) to run the measurement:

```ts
// Add to spike plugin's event handler:
if (event.type === "session.idle") {
  const { data: sessions } = await client.session.list()
  const compacted = sessions.filter(s => s.time.compacting)
  for (const s of compacted) {
    const { data: msgs } = await client.session.messages({ path: { id: s.id } })
    const tokens = msgs.flatMap(m => m.parts)
      .filter(p => p.type === "step-finish")
      .reduce((acc, p) => ({
        input: acc.input + (p.tokens?.input ?? 0),
        output: acc.output + (p.tokens?.output ?? 0)
      }), { input: 0, output: 0 })
    await client.app.log({ body: { service: "spike", level: "info",
      message: `session ${s.id} compacted, tokens: ${JSON.stringify(tokens)}` } })
  }
}
```

**Gate:** compare average `tokens.input + tokens.output` across compacted sessions before and after `prune: true`. If `prune` alone reduces post-compaction token count materially AND quality is fine → stop at M0. Only build the plugin if the quality problem persists.

---

## 4. Milestone M1 — Compaction hook (Layer 1, ~1 day)

### 4.1 What M1 tests

M1 stubs `readMemory` → null, so `buildDurableBlock` returns "(no prior project memory)." The §4.4 acceptance test validates that **the prompt structure alone** improves post-compaction quality — not the durable block. This is correct isolation. The prompt is the product at M1; memory comes at M2.

### 4.2 Files to create

**`src/types.ts`** — shared types:
```ts
// Compaction hook types (confirmed via spike in Phase 0)
export interface CompactionInput {
  sessionID: string
}
export interface CompactionOutput {
  context: string[]
  prompt?: string
}

// Extracted facts from transcript
export interface ExtractedFacts {
  current_task: string | null
  active_files: { path: string; reason: string }[]
  decisions: { topic: string; decision: string; rationale?: string }[]
  blockers: string[]
  next_steps: string[]
}

// Plugin options (read from opencode.json "tokenmaxxer" key, or env)
export interface TokenmaxxerOptions {
  compactionPrompt: boolean     // kill switch, default true
  memoryKey: "worktree" | "directory"  // default "worktree"
}
```

**`src/config.ts`** — option parsing + kill switch:
```ts
import type { TokenmaxxerOptions } from "./types"

export function loadOptions(ctx: any): TokenmaxxerOptions {
  return {
    compactionPrompt: process.env.TOKENMAXXER_NO_PROMPT !== "1",
    memoryKey: "worktree",
  }
}
```

> **Kill switch:** `TOKENMAXXER_NO_PROMPT=1` env var or `tokenmaxxer.compaction_prompt: false` in config skips prompt replacement but still injects the durable block via `output.context`. This is the rollback path if the schema-constrained prompt makes things worse mid-session.

**`src/compaction/prompt.ts`** — use PLAN.md §4.2 with one correction:

Change line 276 from:
> Treat the DURABLE CONTEXT block below as ground truth; it survives compaction. Prefer it over the conversation if they conflict.

To:
> Treat the DURABLE CONTEXT block below as **recorded observations from prior sessions**. They are useful but may be stale or incomplete. Verify against the conversation if they conflict. Check git SHAs and timestamps before relying on a decision.

**Rationale:** "ground truth" + brittle heuristic extraction = false confidence. Recorded observations with verification guidance is safer.

**`src/compaction/durable.ts`** — use PLAN.md §4.3. Remove the unused `input` parameter from the signature (dead param, E.9):

```ts
export async function buildDurableBlock(opts: {
  worktree: string
  directory: string
  client: any
}): Promise<string> {
  try {
    const mem = await readMemory({ worktree: opts.worktree, directory: opts.directory })
    if (!mem) return "(no prior project memory)"
    // ... format as in PLAN.md §4.3
  } catch (e) {
    await log(opts.client, "warn", "buildDurableBlock failed", { error: String(e) })
    return "(memory unavailable)"
  }
}
```

**`src/util/log.ts`:**
```ts
export async function log(client: any, level: "debug" | "info" | "warn" | "error",
  message: string, extra?: Record<string, unknown>) {
  try {
    await client.app.log({ body: { service: "tokenmaxxer", level, message, extra } })
  } catch {
    // logging must never throw
  }
}
```

**`src/index.ts`** — plugin entry with graceful init:
```ts
import type { Plugin } from "@opencode-ai/plugin"
import { loadOptions } from "./config"
import { buildCompactionPrompt } from "./compaction/prompt"
import { buildDurableBlock } from "./compaction/durable"
import { log } from "./util/log"

export const TokenmaxxerPlugin: Plugin = async (ctx) => {
  const { client, directory, worktree } = ctx
  const options = loadOptions(ctx)

  // Version check (warn, don't fail)
  try {
    const { data: appInfo } = await client.app.info()
    if (appInfo?.version) {
      const major = parseInt(appInfo.version.split(".")[0])
      if (major < 1) await log(client, "warn", `opencode ${appInfo.version} may be unsupported`)
    }
  } catch {}

  return {
    "experimental.session.compacting": async (input: CompactionInput, output: CompactionOutput) => {
      try {
        const durable = await buildDurableBlock({ worktree, directory, client })
        if (options.compactionPrompt) {
          output.prompt = buildCompactionPrompt(durable)
        } else {
          // Kill switch: inject durable block via context, keep default prompt
          output.context.push(durable)
        }
      } catch (e) {
        await log(client, "error", "compaction hook failed", { error: String(e) })
        // On failure, do nothing — let opencode use its default compaction
      }
    },
  }
}

export default TokenmaxxerPlugin
```

> **Graceful init:** the plugin function itself is wrapped in try/catch at the top level by opencode's plugin loader, but our internal init (version check) is guarded. If `buildDurableBlock` or `buildCompactionPrompt` throw, we log and let opencode fall back to default compaction. The plugin never bricks a session.

### 4.3 M1 acceptance test

Follow PLAN.md §4.4. Pass criteria: after compaction, the model answers "what are we doing, which files, what decision did we make?" correctly from the summary alone. The durable block will say "(no prior project memory)" — that's expected at M1.

### 4.4 M1 unit tests

```ts
// test/compaction/prompt.test.ts
import { describe, it, expect } from "vitest"
import { buildCompactionPrompt } from "../../src/compaction/prompt"

describe("buildCompactionPrompt", () => {
  it("contains all required section headers", () => {
    const prompt = buildCompactionPrompt("(no prior memory)")
    for (const header of [
      "## Current task", "## Active files", "## Locked decisions",
      "## Open questions", "## Blockers", "## Next steps", "## What NOT to redo"
    ]) {
      expect(prompt).toContain(header)
    }
  })

  it("interpolates durable block", () => {
    const prompt = buildCompactionPrompt("Project: test\nCurrent task: building X")
    expect(prompt).toContain("Project: test")
    expect(prompt).toContain("building X")
  })
})
```

---

## 5. Milestone M2 — Memory store + writer (Layer 2 core, ~1-2 days)

### 5.1 Files to create

**`src/memory/schema.ts`** — use PLAN.md §3 schema, with M4.5 fields added now (additive, optional, no migration needed):

```ts
import { z } from "zod"

export const DecisionSchema = z.object({
  id: z.string(),
  topic: z.string(),
  decision: z.string(),
  rationale: z.string().optional(),
  timestamp: z.string().iso(),
  git_sha: z.string().optional(),
  session_id: z.string(),
  still_valid: z.boolean().default(true),
  foundational: z.boolean().default(false),       // M4.5: promoted by model or auto-detected
  last_used_in_session: z.string().optional(),    // M4.5: set by writer when referenced
})
export type Decision = z.infer<typeof DecisionSchema>

export const ActiveFileSchema = z.object({
  path: z.string(),
  reason: z.string(),
  last_touched: z.string().iso(),
})
export type ActiveFile = z.infer<typeof ActiveFileSchema>

export const MemoryFileSchema = z.object({
  version: z.literal(1),
  project_path: z.string(),
  last_updated: z.string().iso(),
  last_git_sha: z.string().optional(),
  last_session_id: z.string().optional(),
  current_task: z.string().optional(),
  active_files: z.array(ActiveFileSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  blockers: z.array(z.string()).default([]),
  next_steps: z.array(z.string()).default([]),
})
export type MemoryFile = z.infer<typeof MemoryFileSchema>
```

**`src/memory/migrate.ts`** — migration skeleton (build now, not later):
```ts
import { MemoryFileSchema, type MemoryFile } from "./schema"

const migrations: Record<number, (data: any) => any> = {
  // 1: (d) => d,  // v1 is identity — no migration needed
}

export function loadAndMigrate(raw: unknown): MemoryFile | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== "object") return null

  const version = (raw as any).version ?? 0
  let data = raw
  for (let v = version; v < 1; v++) {
    const fn = migrations[v]
    if (!fn) {
      // Unknown version — can't migrate
      return null
    }
    data = fn(data)
  }

  const parsed = MemoryFileSchema.safeParse(data)
  if (!parsed.success) {
    // Corrupt or invalid — return null, caller handles
    return null
  }
  return parsed.data
}
```

**`src/util/fs.ts`** — safe filesystem operations:
```ts
import { mkdir, writeFile, readFile, rename, stat } from "fs/promises"
import { join, dirname } from "path"

export async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {})
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`
  await ensureDir(path)
  await writeFile(tmp, content, "utf-8")
  await rename(tmp, path)  // atomic on same filesystem
}

export async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8")
  } catch {
    return null
  }
}

export async function getMtime(path: string): Promise<number | null> {
  try {
    const s = await stat(path)
    return s.mtimeMs
  } catch {
    return null
  }
}
```

**`src/memory/store.ts`** — with error handling, cache invalidation, and corrupt recovery:
```ts
import { loadAndMigrate } from "./migrate"
import { atomicWrite, safeRead, getMtime } from "../util/fs"
import type { MemoryFile } from "./schema"
import { join } from "path"

const MAX_BYTES = 8192
const cache = new Map<string, { mem: MemoryFile | null; mtime: number }>()

function memoryPath(worktree: string): string {
  return join(worktree, ".opencode", "memory", "STATE.json")
}

function globalPath(worktree: string): string {
  // Fallback when worktree is read-only
  const hash = Bun.hash(worktree)  // or crypto.createHash if Bun unavailable
  return join(process.env.HOME ?? "", ".config", "opencode", "memory", String(hash), "STATE.json")
}

export async function readMemory({ worktree, directory }: {
  worktree: string; directory: string
}): Promise<MemoryFile | null> {
  const path = memoryPath(worktree)
  const mtime = await getMtime(path)

  // Cache check with mtime invalidation (fixes multi-instance incoherence)
  const cached = cache.get(worktree)
  if (cached && mtime !== null && cached.mtime === mtime) {
    return cached.mem
  }

  const raw = await safeRead(path)
  if (raw === null) {
    cache.set(worktree, { mem: null, mtime: mtime ?? 0 })
    return null
  }

  const mem = loadAndMigrate(JSON.parse(raw))
  if (mem === null) {
    // Corrupt — back up and return empty
    await backupCorrupt(path)
    const empty = emptyMemory(worktree)
    cache.set(worktree, { mem: empty, mtime: mtime ?? 0 })
    return empty
  }

  cache.set(worktree, { mem, mtime: mtime ?? 0 })
  return mem
}

export async function writeMemory({ worktree, directory }: {
  worktree: string; directory: string
}, mem: MemoryFile): Promise<void> {
  const path = memoryPath(worktree)
  const json = JSON.stringify(mem, null, 2)

  if (json.length > MAX_BYTES) {
    // Should have been pruned before write — log if still over
    console.warn(`tokenmaxxer: STATE.json still ${json.length} bytes after pruning`)
  }

  try {
    await atomicWrite(path, json)
  } catch {
    // Worktree read-only — try global fallback
    try {
      await atomicWrite(globalPath(worktree), json)
    } catch (e) {
      // Both paths failed — log and give up (don't throw from event handler)
      console.warn(`tokenmaxxer: cannot write memory: ${e}`)
    }
  }

  // Invalidate cache
  const mtime = await getMtime(path)
  cache.set(worktree, { mem, mtime: mtime ?? 0 })
}

export function emptyMemory(worktree: string): MemoryFile {
  return {
    version: 1,
    project_path: worktree,
    last_updated: new Date().toISOString(),
    active_files: [],
    decisions: [],
    blockers: [],
    next_steps: [],
  }
}

async function backupCorrupt(path: string): Promise<void> {
  try {
    const content = await safeRead(path)
    if (content) await atomicWrite(`${path}.corrupt.${Date.now()}`, content)
  } catch {}
}
```

**`src/memory/writer.ts`** — full specification in Appendix A.1. Key additions over PLAN.md §5.2:
- Try/catch around all SDK calls.
- `TRANSCRIPT_WINDOW = 50` cap.
- Negation detection in decision extraction.
- `last_used_in_session` tracking (scan transcript for `recall_decision` tool calls + topic keyword mentions).
- Auto-mark `foundational` via regex patterns from PLAN.md M4.5.

**`src/util/git.ts`** — with Bun.$ fallback:
```ts
export async function getCurrentGitSha(worktree: string): Promise<string | null> {
  try {
    if (typeof Bun !== "undefined" && Bun.$) {
      const result = await Bun.$`git -C ${worktree} rev-parse HEAD`.text()
      return result.trim() || null
    }
    // Fallback: child_process
    const { execSync } = await import("child_process")
    return execSync("git rev-parse HEAD", { cwd: worktree, encoding: "utf-8" }).trim() || null
  } catch {
    return null  // not a git repo, git not installed, etc.
  }
}
```

### 5.2 Wire session.idle

Add to `src/index.ts`:
```ts
event: async ({ event }) => {
  if (event.type === "session.idle") {
    const sessionId = event.properties?.sessionID
    if (!sessionId) return
    try {
      await writeMemoryOnIdle({ client, worktree, directory, sessionId })
    } catch (e) {
      await log(client, "error", "writeMemoryOnIdle failed", { error: String(e) })
    }
  }
},
```

### 5.3 M2 unit tests

Create `test/fixtures/transcripts/` with sample transcripts (JSON files matching `{ info: Message, parts: Part[] }[]`). At minimum:

| Fixture | Contains | Tests |
|---|---|---|
| `simple-decision.json` | Assistant says "let's use Postgres" | Decision extracted, topic = "postgres" |
| `negated-decision.json` | Assistant says "we decided NOT to use SQLite" | Decision NOT extracted (negation detection) |
| `user-decision.json` | User says "let's go with Postgres" in first message | Decision extracted from user text |
| `conflicting-decisions.json` | "use Postgres" then later "actually use MySQL" | Old decision still_valid=false, new one valid |
| `long-session.json` | 60+ messages | Only last 50 considered (TRANSCRIPT_WINDOW) |
| `no-decisions.json` | General work, no decision language | Empty decisions array, no false positives |

Test `mergeMemory` and `pruneOld` with property-based tests:
```ts
// test/memory/merge.test.ts
describe("mergeMemory", () => {
  it("never loses a decision that wasn't superseded", () => {
    // property: merge(existing, extract) → result.decisions includes all existing.valid
    //   unless a new decision on the same topic supersedes it
  })
  it("supersession uses exact normalized topic match, not substring", () => {
    const existing = { decisions: [{ topic: "auth", ... }] }
    const extracted = { decisions: [{ topic: "authentication", ... }] }
    const result = mergeMemory(existing, extracted, meta)
    expect(result.decisions.filter(d => d.still_valid)).toHaveLength(2)  // both kept
  })
})

// test/memory/prune.test.ts
describe("pruneOld", () => {
  it("drops still_valid:false decisions first when over cap", () => { ... })
  it("drops decisions older than 30 days second", () => { ... })
  it("caps active_files at 8 when over cap", () => { ... })
  it("logs warning if still over 8KB after all pruning", () => { ... })
  it("does not mutate input", () => { ... })
})
```

### 5.4 M2 acceptance tests

Follow PLAN.md §5.5 tests 1-4 (isolation, conflict resolution). All should pass with the corrected `mergeMemory` (exact topic match, not substring).

---

## 6. Milestone M3 — Recall tools + silent memory (shipped)

### 6.1 Recall tools (`src/tools/recall.ts`)

Use PLAN.md §5.3 with these corrections:

1. **Every tool's first line is `Project: ${mem.project_path}`** (sanity-check isolation).
2. **`recall_decision`**: add `args.limit` (default 10), make `args.query` optional. Empty query returns most recent N valid decisions sorted by timestamp desc.
3. **`recall_decision`**: change `args.query` to `.optional()`:
   ```ts
   args: {
     query: tool.schema.string().optional().describe("topic or keyword. Omit to get most recent decisions."),
     limit: tool.schema.number().default(10).describe("max results"),
   }
   ```
4. **Add `recall_promote`** (M4.5 tool, define now):
   ```ts
   recall_promote: tool({
     description: "Mark a decision as foundational — it will always be included in compaction context. Use for architecture-level decisions that should never be forgotten.",
     args: { topic: tool.schema.string().describe("exact topic of the decision to promote") },
     async execute(args, context) {
       const mem = await readMemory({ worktree: context.worktree, directory: context.directory })
       if (!mem) return "No project memory."
       const d = mem.decisions.find(d => d.topic.toLowerCase() === args.topic.toLowerCase())
       if (!d) return `No decision with topic "${args.topic}".`
       d.foundational = true
       await writeMemory({ worktree: context.worktree, directory: context.directory }, mem)
       return `Promoted: ${d.topic}: ${d.decision}`
     },
   }),
   ```

### 6.2 Silent server memory and separate TUI status

The shipped server target writes `STATE.json` silently. It does not generate a
`HEADER.md`, add memory to OpenCode `instructions`, use
`experimental.chat.system.transform`, or inject current-task/project text into
the composer. A separate TUI target may render only a right-side `memory`
indicator; it is not required for memory or extraction.

### 6.3 M3 acceptance tests

Follow PLAN.md §5.5 with the shipped silent-memory boundary:
1. Confirm idle memory work does not write project/current-task text to the
   composer.
2. Call `get_project_state` → confirm it returns prior task/decisions.
3. Project B isolation → `get_project_state` returns "No project memory."
4. Conflicting decision → old decision `still_valid: false`, `recall_decision("database")` returns new.

### 6.4 Shipped opt-in LLM extraction

The LLM path is not a future milestone. Heuristics remain the default and
durable fallback. Enable extraction directly with:

```bash
TOKENMAXXER_LLM_EXTRACT=1 opencode
```

After installation, `tokenmaxxer opencode [args]` enables the same environment
for its child process. The launcher requires an accessible configured and
connected small model; it does not provide credentials or entitlement.

Use an exact `provider/model` value for `small_model`. The verified example for
this environment is `ollama-cloud/gpt-oss:20b`, not a universal recommendation;
it has no `none` variant and remains a valid explicit choice. Model listings do
not guarantee authentication, entitlement, thinking/tool-choice compatibility,
or structured-result adherence.

Automatic discovery selects active, connected, zero-cost, tool-callable models.
It prefers candidates advertising `none`, but does not require that variant and
may select another eligible candidate. A selected model uses `variant: none`
only when that variant exists; otherwise it is requested without forcing it.

The structured contract requires `active_files` objects with `path` and
`reason`, and `decisions` objects with `topic` and `decision`. A verified run
returned `StructuredOutput`; tokenmaxxer Zod-validated and merged the facts,
persisted an `llm_extraction_cache` entry in `STATE.json`, and retained the
visible `tokenmaxxer extract · …` audit session. The cache key includes the
source session, canonical input, and selected provider/model.

---

## 7. Milestone M4 — Efficiency tools (~0.5 day)

### 7.1 Corrections to PLAN.md M3.5

**Rename `compact_now` → `preview_compaction`:**
```ts
preview_compaction: tool({
  description: "Preview the durable-state block that would be injected at the next compaction. Call when context is getting large to see what would survive before compaction fires.",
  args: {},
  async execute(_args, context) {
    return buildDurableBlock({ worktree: context.worktree, directory: context.directory, client: context.client })
  },
}),
```

**Rename `summarize_files` → `head_files` and add error handling:**
```ts
head_files: tool({
  description: "Read the first N lines of each file. Use instead of calling `read` on large files when you only need to see the top (imports, exports, config). Call `read` on the full file if you need more.",
  args: {
    paths: tool.schema.array(tool.schema.string()).describe("File paths, relative to worktree."),
    lines: tool.schema.number().default(40).describe("Lines to return per file."),
  },
  async execute(args, context) {
    const out: string[] = []
    for (const p of args.paths) {
      try {
        const content = (await context.client.file.read({ query: { path: p } })).data?.content ?? ""
        if (!content) {
          out.push(`### ${p}\n(empty or not found)`)
          continue
        }
        const allLines = content.split("\n")
        const head = allLines.slice(0, args.lines).join("\n")
        out.push(`### ${p}\n${head}${allLines.length > args.lines ? "\n...(truncated)" : ""}`)
      } catch (e) {
        out.push(`### ${p}\n(error: ${e})`)
      }
    }
    return out.join("\n\n")
  },
}),
```

### 7.2 Status tool (`src/tools/status.ts`)

```ts
tokenmaxxer_status: tool({
  description: "Check tokenmaxxer plugin health: memory file path, size, decision count, last write, last compaction.",
  args: {},
  async execute(_args, context) {
    const mem = await readMemory({ worktree: context.worktree, directory: context.directory })
    const path = join(context.worktree, ".opencode", "memory", "STATE.json")
    const size = (await safeRead(path))?.length ?? 0
    return [
      `Project: ${mem?.project_path ?? "none"}`,
      `Memory file: ${path} (${size} bytes)`,
      `Decisions: ${mem?.decisions.length ?? 0} (${mem?.decisions.filter(d => d.still_valid).length ?? 0} valid)`,
      `Active files: ${mem?.active_files.length ?? 0}`,
      `Last updated: ${mem?.last_updated ?? "never"}`,
      `Last git SHA: ${mem?.last_git_sha ?? "unknown"}`,
      `Last compaction: ${lastCompactionTimestamp ?? "none"}`,
    ].join("\n")
  },
}),
```

### 7.3 Compaction dump

Write the injected compaction prompt to a log file for debugging:
```ts
// In compaction hook, after setting output.prompt:
const logPath = join(worktree, ".opencode", "memory", "last_compaction.log")
await atomicWrite(logPath, `[${new Date().toISOString()}]\n${output.prompt}\n---\n`)
```

---

## 8. Milestone M5 — Bounded durable block (~0.5 day)

### 8.1 Implement the policy from PLAN.md M4.5

Full specification in Appendix A.4. The key function:

```ts
export function buildBoundedDurableBlock(mem: MemoryFile): string {
  const lines: string[] = []
  lines.push(`Project: ${mem.project_path}`)
  lines.push(`Last updated: ${mem.last_updated}  git SHA: ${mem.last_git_sha ?? "unknown"}`)
  if (mem.current_task) lines.push(`Current task: ${mem.current_task}`)

  // Active files: cap at 8 by last_touched
  const files = [...mem.active_files]
    .sort((a, b) => b.last_touched.localeCompare(a.last_touched))
    .slice(0, 8)
  if (files.length) {
    lines.push("Active files:")
    for (const f of files) lines.push(`  - ${f.path} — ${f.reason}`)
  }

  // Decisions: tiered inclusion
  const valid = mem.decisions.filter(d => d.still_valid)
  const foundational = valid.filter(d => d.foundational)
  const recent = valid.filter(d => !d.foundational && isRecentSession(d, mem.last_session_id, 3))
  const older = valid
    .filter(d => !d.foundational && !isRecentSession(d, mem.last_session_id, 3))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 5)

  if (foundational.length || recent.length) {
    lines.push("Valid decisions:")
    for (const d of [...foundational, ...recent])
      lines.push(`  - ${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${d.timestamp})`)
  }
  if (older.length) {
    lines.push("Older decisions (one-line):")
    for (const d of older)
      lines.push(`  - ${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"})`)
  }

  if (mem.blockers.length) lines.push(`Blockers: ${mem.blockers.join("; ")}`)
  if (mem.next_steps.length) lines.push(`Next: ${mem.next_steps.join("; ")}`)
  return lines.join("\n")
}
```

### 8.2 `last_used_in_session` tracking

In `writeMemoryOnIdle`, after extracting facts, scan the transcript for `recall_decision` tool calls and topic mentions:

```ts
function markReferencedDecisions(mem: MemoryFile, messages: any[], sessionId: string): void {
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "recall_decision") {
        // A recall_decision call means the model referenced memory
        // Mark all valid decisions as used in this session
        for (const d of mem.decisions) {
          if (d.still_valid) d.last_used_in_session = sessionId
        }
      }
    }
  }
}
```

### 8.3 M5 test

Follow PLAN.md M4.5 test: seed 50 decisions (2 foundational, 3 recent), assert block < 2KB, assert correct tiering.

---

## 9. Milestone M6 — Package & polish (~0.5 day)

> **Moved to last** (was M4 in the plan). Package after all features are stable.

### 9.1 Build

```bash
npm run build  # tsup → dist/index.js + dist/index.d.ts
```

### 9.2 README

Include:
- Install (npm or local plugin)
- Required `opencode.json` config (from §3.1)
- `.gitignore` recommendation: `.opencode/memory/STATE.json`
- Kill switch: `TOKENMAXXER_NO_PROMPT=1`
- Troubleshooting: `tokenmaxxer_status` tool, `last_compaction.log`
- Limitations: heuristic extraction is conservative; optional shipped LLM
  extraction can improve recall but still falls back to heuristics.

### 9.3 Distribution decision

- **npm publish:** `npm publish` — users add `"plugin": ["tokenmaxxer"]` to config.
- **local plugin:** `cp dist/index.js .opencode/plugins/tokenmaxxer.js` — no npm needed.

### 9.4 Version skew mitigation

In `package.json`:
```json
"peerDependencies": {
  "@opencode-ai/plugin": ">=1.0.0 <2.0.0"
}
```

The runtime version check in `src/index.ts` (§4.2) warns on mismatch.

---

## 10. Milestone M7 — Vector index (conditional, only if 8KB cap is hit regularly)

Follow PLAN.md M5. Do not build unless M2-M5 prove insufficient.

---

## Appendix A — Function specifications

### A.1 extractFactsHeuristic

```ts
function extractFactsHeuristic(
  messages: { info: { role: string; [k: string]: any }; parts: any[] }[]
): ExtractedFacts
```

**Algorithm:**

```
current_task:
  - Find first message with info.role === "user"
  - Extract text from its TextParts
  - Truncate to 200 chars
  - null if no user message

active_files:
  - For each message, for each part:
    - If part.type === "tool" and part.tool in {"read", "edit", "write", "bash", "glob", "grep"}:
      - Parse part.input (JSON object) for path-like fields: { path, filePath, file, paths, query, pattern, command }
      - For "bash" parts: extract paths from command string via regex /(\.?\/[\w\-\/.]+)/g
      - For "read"/"edit"/"write": use the "path" field directly
      - Deduplicate, count frequency
  - Sort by frequency desc, take top 5
  - reason = frequency > 1 ? `edited ${n} times` : `read once`
  - last_touched = timestamp of last message that touched it

decisions:
  - Sources to scan (in order):
    1. First user message text (often contains the task decision)
    2. All assistant message text
    3. ToolPart outputs where state.status === "completed" and output text contains decision keywords
  - Decision keyword regex (sentence-level, not just sentence-initial):
    /(?:decision|decided|let's|we'll|we will|chose|picked|going with|go with|settle on|settled on)\s+(?!not|never|against|avoid|skip|reject)\b/i
  - NEGATION DETECTION: if the 3 words before the keyword contain
    /(?:not|never|don't|won't|avoid|skip|reject|against)/i → SKIP this match
  - Topic extraction: take the first noun phrase after the keyword
    (heuristic: words between the keyword and the next punctuation or verb)
    Normalize: lowercase, strip articles, collapse whitespace
  - Dedupe by normalized topic (exact match, NOT substring)
  - foundational auto-detection: if original text matches
    /we (will|'ll) (always|never)|architect(ure)? decision|breaking change|migrat(e|ion|ing) to|this (changes|breaks) the (public )?api/i
    → set foundational: true

blockers:
  - Scan last assistant message text for lines containing:
    /(?:blocked|can't|cannot|fails?|error|stuck|waiting on|depends on)/i
  - Extract the sentence, truncate to 200 chars

next_steps:
  - Scan last assistant message text for:
    - Numbered lists (lines starting with \d+\.)
    - Lines starting with "next:", "then:", "TODO", "step"
  - Take up to 5
```

### A.2 mergeMemory

```ts
function mergeMemory(
  existing: MemoryFile,
  extracted: ExtractedFacts,
  meta: { sessionId: string; gitSha: string | null; timestamp: string }
): MemoryFile
```

**Rules:**
```
current_task:
  - If extracted.current_task !== null → overwrite
  - Else → keep existing

active_files:
  - Replace list entirely with extracted.active_files
  - For files present in both old and new: preserve old.reason if new.reason is generic
  - Set last_touched = meta.timestamp for all new files

decisions:
  - For each new decision in extracted.decisions:
    - Normalize topic: lowercase, trim, collapse whitespace
    - Find existing decisions where normalized topic EXACTLY matches
      (NOT substring — "auth" does not match "authentication")
    - If match found: set old.still_valid = false, append new with still_valid = true
    - If no match: append new with still_valid = true
  - Preserve all existing decisions not superseded

blockers: overwrite with extracted.blockers
next_steps: overwrite with extracted.next_steps
last_updated: meta.timestamp
last_session_id: meta.sessionId
last_git_sha: meta.gitSha
```

### A.3 pruneOld

```ts
function pruneOld(mem: MemoryFile): MemoryFile
```

**Algorithm (returns new object, does not mutate):**
```
1. Deep clone mem
2. Serialize, check if <= 8KB → return clone if so
3. Remove all decisions where still_valid === false
4. Check → return if <= 8KB
5. Cap active_files at 8 entries (sort by last_touched desc, keep top 8)
6. Check → return if <= 8KB
7. Remove decisions older than 30 days (still_valid === true, timestamp < now - 30d)
8. Check → return if <= 8KB
9. Truncate current_task to 200 chars, truncate each active_file.reason to 100 chars
10. Check → return if <= 8KB
11. Keep only 10 most recent decisions (by timestamp), log warning
12. Check → return if <= 8KB
13. If STILL over 8KB: keep only current_task + 5 most recent decisions, log error
    (this is a last resort — should never happen with sane usage)
```

### A.4 buildBoundedDurableBlock (M5)

See §8.1 above. The `isRecentSession` helper:

```ts
function isRecentSession(d: Decision, recentSessions: string[], window: number): boolean {
  if (!d.last_used_in_session) return false
  return recentSessions.slice(0, window).includes(d.last_used_in_session)
}
```

> **Final behavior:** `recent_sessions: string[]` is stored as bounded session
> history, so durable recency uses the last three recorded source sessions.

---

## Appendix B — Test plan

### B.1 Unit tests (vitest)

| Module | Test file | Key tests |
|---|---|---|
| `compaction/prompt.ts` | `test/compaction/prompt.test.ts` | All section headers present; durable block interpolated; empty sections show "None" |
| `memory/writer.ts` | `test/memory/writer.test.ts` | Fixture transcripts → correct facts extracted; negation detection; TRANSCRIPT_WINDOW cap |
| `memory/merge` | `test/memory/merge.test.ts` | Exact topic match (not substring); supersession; current_task overwrite; active_files replace |
| `memory/prune` | `test/memory/prune.test.ts` | Pruning order; 8KB cap; no mutation; last-resort truncation |
| `memory/migrate` | `test/memory/migrate.test.ts` | v1 identity; corrupt data → null; missing version → null |
| `compaction/durable.ts` | `test/compaction/durable.test.ts` | Empty memory → "(no prior memory)"; full memory → correct format; M5 bounded policy |
| `tools/recall.ts` | `test/tools/recall.test.ts` | Empty query → recent N; substring filter; isolation; recall_promote |

### B.2 Mock client

```ts
// test/helpers/mockClient.ts
export function createMockClient(overrides?: Partial<any>) {
  const messages: any[] = []
  const sessions: any[] = []
  return {
    session: {
      messages: async () => ({ data: messages }),
      get: async ({ path }) => ({ data: sessions.find(s => s.id === path.id) }),
      list: async () => ({ data: sessions }),
      prompt: async () => ({ data: {} }),
    },
    app: { log: async () => ({}) },
    file: { read: async ({ query }) => ({ data: { content: "" } }) },
    ...overrides,
  }
}
```

### B.3 Manual acceptance tests

| Milestone | Test | From PLAN.md |
|---|---|---|
| M1 | §4.4 | Post-compaction recall without re-reading files |
| M2 | §5.5 (1-4) | STATE.json exists; isolation; conflict resolution |
| M3 | §5.5 (final) | silent memory; get_project_state returns data |
| M4 | M3.5 test | preview_compaction returns same shape as compaction prompt |
| M5 | M4.5 test | 50 decisions → block < 2KB; correct tiering |

---

## Appendix C — Corrected milestone order

| Milestone | Name | Time | Depends on |
|---|---|---|---|
| Phase 0 | Pre-build spike | 30 min | — |
| M0 | Config tuning | 1 hr | Phase 0 |
| M1 | Compaction hook (Layer 1) | 1 day | M0 |
| M2 | Memory store + writer (Layer 2) | 1-2 days | M1 |
| M3 | Recall tools + silent memory | 1 day | M2 |
| M4 | Efficiency tools + status | 0.5 day | M3 |
| M5 | Bounded durable block | 0.5 day | M4 |
| M6 | Package & polish | 0.5 day | M5 |
| M7 | Vector index (conditional) | — | M6, only if 8KB hit |

**Changes from PLAN.md:**
- Phase 0 spike added (resolve blocking unknowns first).
- M3.5 → M4, M4.5 → M5 (renumbered, no more ".5" confusion).
- M4 (package) moved to M6 (package last, after all features stable).
- Schema migration built at M2 (was deferred).
- M4 duplicate removed (was listed twice in plan).
