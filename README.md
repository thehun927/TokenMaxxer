<div align="center">

# TokenMaxxer

### Durable memory + compaction continuity for [OpenCode](https://opencode.ai)

**Your coding agent should remember what it already learned.**

[![Release](https://img.shields.io/github/v/release/thehun927/TokenMaxxer?label=release)](https://github.com/thehun927/TokenMaxxer/releases/latest)
[![CI](https://github.com/thehun927/TokenMaxxer/actions/workflows/ci.yml/badge.svg)](https://github.com/thehun927/TokenMaxxer/actions/workflows/ci.yml)
[![OpenCode](https://img.shields.io/badge/OpenCode-%3E%3D1.18.15%20%3C2.0.0-7c3aed)](https://opencode.ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Quick start](#quick-start) · [How it works](#how-it-works) · [Tools](#memory-tools) · [TIPS](#tips) · [Reliability](#reliability) · [Development](#development)

</div>

---

TokenMaxxer is an OpenCode plugin built for the point where AI coding sessions usually start to fall apart: **long-running work, context compaction, and coming back to a project later**.

It keeps a small, structured, per-project memory of the things that actually matter — the current task, active files, decisions, blockers, and next steps — then makes that state available to compaction and explicit recall tools.

**No database. No daemon. No automatic memory dump into the composer.** Just bounded durable state, explicit recall, safer compaction, and a tiny TUI signal when memory is actually committed.

## Why TokenMaxxer exists

OpenCode can work for a long time, but context is still finite. When a session is compacted, a huge conversation gets reduced to a summary. When a new session starts, the model does not automatically know what happened yesterday.

That creates familiar failure modes:

| Without durable project memory | With TokenMaxxer |
|---|---|
| Compaction drops an important decision | Durable decisions remain available to compaction and recall |
| The agent re-reads files it already explored | Active-file memory tells it where the work is |
| Settled architecture gets re-litigated | Decision authority preserves what is actually current |
| Failed approaches get repeated | Structured context can carry blockers and prior direction forward |
| A new session starts cold | `get_project_state` can restore the project thread immediately |
| “Memory wrote” is hard to verify | The TUI pulses only after a real durable STATE commit |

TokenMaxxer is not trying to make the model remember everything. **It is trying to preserve the right things.**

## What you get

| | Feature | What it means |
|---|---|---|
| 🧠 | **Durable project memory** | Structured state survives across sessions and compactions. |
| 🗜️ | **Compaction continuity** | Default augment mode preserves OpenCode's native compaction behavior while adding durable project context. |
| 🔒 | **Human decision authority** | Important decisions can be promoted to foundational status only through an explicit interactive CLI review. |
| 🧰 | **7 memory/efficiency tools** | The agent can recall state, query decisions, inspect active files, preview compaction, and check health on demand. |
| 🟢 | **Commit-backed TUI indicator** | `memory  ·` pulses only when a durable STATE write really commits. |
| 🧪 | **Optional structured LLM extraction** | Use a connected small model for stricter extraction, with validation, provenance, audit records, and heuristic fallback. |
| 📦 | **Verified release installer** | Release identity and SHA-256 payloads are verified before installation; writes are transactional with rollback. |
| 🛡️ | **Reliability-first internals** | Atomic writes, cross-process locking, bounded storage, corrupt-state recovery, authoritative reads, diagnostics, and fail-safe fallbacks. |

---

## Quick start

### Requirements

- OpenCode `>=1.18.15 <2.0.0`
- Node.js 18+
- Bash
- `curl` or `wget`
- `sha256sum` or `shasum -a 256`

### Install globally

```bash
curl -fsSL https://github.com/thehun927/TokenMaxxer/releases/latest/download/install.sh | bash
```

Then restart OpenCode.

The installer downloads assets from one exact immutable release, validates the release manifest, verifies SHA-256 checksums, stages the changes, and only then commits them. If a destination update fails mid-install, it rolls back the files it already changed.

It installs:

- the TokenMaxxer server plugin
- the separate TUI plugin
- the TokenMaxxer CLI bundle
- the `tokenmaxxer` launcher in `~/.local/bin`
- a local release receipt used by `tokenmaxxer version`

It also preserves existing OpenCode configuration while adding the TokenMaxxer TUI entry and required runtime dependency ranges when those config files already exist.

### Verify the install

```bash
tokenmaxxer version
```

If `~/.local/bin` is not on your `PATH`:

```bash
~/.local/bin/tokenmaxxer version
```

### Run OpenCode normally

```bash
opencode
```

This uses TokenMaxxer's default **heuristic memory extraction**. No model configuration is required for TokenMaxxer itself.

### Run with structured LLM extraction enabled

```bash
tokenmaxxer opencode [args...]
```

The launcher starts OpenCode with `TOKENMAXXER_LLM_EXTRACT=1` for that child process. You still need a usable small model configured through OpenCode; TokenMaxxer does not provide credentials, entitlement, or model access.

---

## How it works

```text
                         ┌──────────────────────┐
                         │   OpenCode session   │
                         └──────────┬───────────┘
                                    │
                    ┌───────────────┴────────────────┐
                    │                                │
              session.idle                 context compaction
                    │                                │
                    ▼                                ▼
          ┌───────────────────┐           ┌─────────────────────┐
          │ Extract useful    │           │ Read durable state  │
          │ project facts     │           │ + prior summary     │
          └─────────┬─────────┘           └──────────┬──────────┘
                    │                                │
                    ▼                                ▼
          ┌───────────────────┐           ┌─────────────────────┐
          │ Merge + authority │           │ Augment native      │
          │ + 8 KiB budget    │           │ compaction by       │
          └─────────┬─────────┘           │ default             │
                    │                     └──────────┬──────────┘
                    ▼                                │
          ┌───────────────────┐                      │
          │ Atomic STATE      │                      │
          │ transaction       │                      │
          └─────────┬─────────┘                      │
                    │                                │
             successful commit                       │
                    │                                │
                    ▼                                ▼
          ┌───────────────────┐           ┌─────────────────────┐
          │ memory  ● → • → · │           │ Better continuity   │
          │ TUI commit pulse  │           │ after compaction    │
          └───────────────────┘           └─────────────────────┘

        New session ──► get_project_state / recall_decision / get_active_files
```

### Layer 1 — Compaction continuity

TokenMaxxer hooks OpenCode's `experimental.session.compacting` event.

#### Default: augment mode

The default is deliberately conservative:

```text
OpenCode native compaction prompt
              +
TokenMaxxer durable project context
```

TokenMaxxer leaves OpenCode's native prompt in control and appends bounded project memory. This gives compaction extra continuity without taking over the host's default compaction strategy.

#### Optional: replace mode

If you want TokenMaxxer's schema-constrained compaction prompt instead:

```bash
TOKENMAXXER_COMPACTION_MODE=replace opencode
```

Replace mode asks for a structured handoff containing:

- **Current task**
- **Active files**
- **Locked decisions**
- **Open questions**
- **Blockers**
- **Next steps**
- **What NOT to redo**

When available, the previous compaction summary is sanitized and used as another continuity anchor. If the history needed for replacement cannot be read safely, TokenMaxxer falls back to augment mode rather than forcing a weaker replacement.

Legacy compatibility remains available:

```bash
TOKENMAXXER_NO_PROMPT=1   # augment
TOKENMAXXER_NO_PROMPT=0   # replace
```

`TOKENMAXXER_COMPACTION_MODE` takes precedence when set. Invalid values fail safely to `augment`.

### Layer 2 — Durable project memory

On `session.idle`, TokenMaxxer reads the session transcript through OpenCode's host client and extracts a bounded project handoff:

- current task
- active files and why they matter
- decisions and decision lineage
- blockers
- next steps
- provenance for durable facts
- bounded source/audit metadata

That state is merged under a cross-process project transaction and constrained to an exact **8 KiB UTF-8 STATE budget**.

TokenMaxxer prefers project-local storage:

```text
<project>/.opencode/memory/STATE.json
```

If the project path cannot be written, it can fall back to the project's hashed global namespace:

```text
~/.config/opencode/memory/<project-hash>/STATE.json
```

When both candidates exist, TokenMaxxer performs an authoritative read and deterministically chooses the current state using revision first, then mtime, then a project-local tie-break. An unreadable state is not silently treated as an empty state.

### Memory is pull-based on purpose

TokenMaxxer **does not automatically paste project memory into a new composer session**.

Instead, the agent can pull exactly what it needs with TokenMaxxer's tools. This keeps memory useful without turning every new session into another hidden prompt payload.

A simple resumed workflow looks like this:

```text
Session 1
  "Use Postgres for persistence."
       ↓
  session.idle
       ↓
  durable decision written

Session 2
  get_project_state
       ↓
  "Prior project decision: use Postgres ..."
```

---

## Memory tools

TokenMaxxer registers **7 custom tools** in every OpenCode session:

| Tool | Use it when... | What it gives the agent |
|---|---|---|
| `get_project_state` | Resuming work | Current task, active files, authoritative decisions, blockers, and next steps |
| `recall_decision` | A previous architectural/product decision matters | Matching current decisions, or recent decisions when no topic is supplied |
| `get_active_files` | The agent needs to re-orient in the codebase | Files currently associated with the work and why they matter |
| `recall_promote` | A decision should become durable foundational guidance | A **request for human review** — not an automatic promotion |
| `preview_compaction` | Context is getting large | A preview of what TokenMaxxer would contribute to compaction |
| `head_files` | Exploring large files | Cheap first-N-line inspection instead of pulling whole files into context |
| `tokenmaxxer_status` | Debugging or verifying health | Memory source/path, size, revision/decision state, write status, and compaction diagnostics |

### Foundational decisions require a human

An AI-generated decision cannot silently declare itself permanent.

The flow is intentionally explicit:

```text
Agent calls recall_promote
        ↓
Decision is marked as requesting review
        ↓
Human inspects it with the CLI
        ↓
Human types the exact decision ID in an interactive TTY
        ↓
Decision becomes human-reviewed foundational authority
```

Useful commands:

```bash
# Show current authoritative decisions
tokenmaxxer decisions

# Include historical/non-authoritative details and conflicts
tokenmaxxer decisions --all

# Human-review a requested decision and promote it
tokenmaxxer promote <decision-id>

# Explicitly replace one human authority with another candidate
tokenmaxxer supersede <candidate-id> --replaces <authority-id>
```

Use `--project <path>` when running the CLI outside the project directory.

Promotion and supersession require a real interactive terminal. There is no `--yes` bypass.

---

## TUI indicator

The optional TUI plugin adds a deliberately tiny status surface to the right side of the composer:

```text
memory  ·
```

It is **not** a generic activity light.

A successful durable STATE commit creates a tiny commit marker. The TUI detects a fresh marker and plays one finite theme-native pulse:

```text
memory  ●  →  memory  •  →  memory  ·
```

So if a session goes idle but there was no new durable memory commit, the indicator stays quiet. That is expected behavior — the pulse means **"STATE committed"**, not merely **"TokenMaxxer ran."**

The pulse marker contains only a timestamp and never contains transcript, prompt, or memory content.

---

## Optional LLM extraction

Heuristic extraction is the default and permanent fallback. LLM extraction is opt-in:

```bash
TOKENMAXXER_LLM_EXTRACT=1 opencode
```

or:

```bash
tokenmaxxer opencode
```

### Model selection

TokenMaxxer uses OpenCode's own provider/model inventory.

1. A valid top-level `small_model` value such as `provider/model` is treated as an explicit override.
2. Without an override, TokenMaxxer considers connected, active, zero-cost, tool-callable models and prefers candidates that expose a `none` reasoning variant.
3. Automatic discovery does not silently substitute a paid model.
4. If the selected model is unavailable, unauthenticated, incompatible, or returns invalid structured output, TokenMaxxer falls back to heuristics.

List OpenCode's model inventory:

```bash
opencode models
```

Configure one exact model in OpenCode if desired:

```jsonc
{
  "small_model": "provider/model"
}
```

A model appearing in inventory does **not** guarantee that it is authenticated or entitled. If needed:

```bash
opencode auth login
opencode auth list
```

### Why the LLM path is not blindly trusted

Structured extraction is validated before it can merge into durable memory. Durable LLM decisions carry bounded provenance and evidence references, and successful extraction retains an audit session. If the model violates the structured-result contract, the result is rejected and heuristics remain available.

LLM extraction also does not grant human authority. **Human-reviewed foundational state still requires the interactive CLI boundary.**

---

## TIPS

A few habits make TokenMaxxer dramatically more useful:

### 1. Tell the agent to restore state when you resume

TokenMaxxer is pull-based, so a great first prompt in a resumed session is:

```text
Call get_project_state first, then continue from the existing project state.
```

That gives the agent a fast orientation pass without asking it to rediscover the project from scratch.

### 2. Turn on OpenCode pruning

Old tool output is usually the fattest part of a long context. TokenMaxxer works without pruning, but this is a strong companion configuration:

```jsonc
{
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 25000
  },
  "watcher": {
    "ignore": [
      ".opencode/memory/**",
      ".opencode/.tokenmaxxer-memory-activity"
    ]
  }
}
```

`prune: true` removes old tool output before it becomes expensive baggage, while the memory layer preserves the durable project facts that actually need to survive.

### 3. Promote architecture, not trivia

Use `recall_promote` for decisions that should remain stable across many sessions — database choice, public API shape, security boundaries, migration strategy, invariants — not every local implementation detail.

Foundational memory is most valuable when it is scarce and intentional.

### 4. Use `recall_decision` before re-litigating something expensive

Before changing auth, persistence, deployment, schema design, or another architectural choice, have the agent query prior decisions. It is much cheaper to discover *"we already decided this and here is why"* than to repeat the entire investigation.

### 5. Use `head_files` for reconnaissance

When the agent only needs imports, top-level declarations, or a quick shape check, `head_files` avoids spending context on thousands of irrelevant lines.

### 6. Treat the TUI pulse literally

No green pulse after `session.idle` does **not** automatically mean the plugin is broken. The indicator only pulses after the canonical durable commit boundary. If nothing changed, a quiet dot is correct.

For actual health information, use:

```text
tokenmaxxer_status
```

### 7. Keep project memory out of Git

Add this to project `.gitignore`:

```gitignore
.opencode/memory/STATE.json
.opencode/memory/last_compaction_prompt.log
.opencode/memory/last_compaction_result.json
.opencode/memory/*.corrupt.*
```

The state can contain project decisions, session identifiers, and operational metadata. It is runtime memory, not source code.

### 8. Use replace-mode compaction intentionally

The default augment mode is the compatibility-first choice. If you specifically want TokenMaxxer to enforce its structured handoff schema, opt into replace mode and evaluate it on your workload:

```bash
TOKENMAXXER_COMPACTION_MODE=replace opencode
```

You can switch back to augment mode at any time without uninstalling anything.

### 9. Let `tokenmaxxer decisions --all` explain confusing memory

If a decision seems stale or contradictory, inspect authority, supersession, provenance, and unresolved human conflicts before editing STATE by hand:

```bash
tokenmaxxer decisions --all
```

The CLI is designed to make decision lineage inspectable without bypassing the store's transaction and authority rules.

---

## Diagnostics

Start with the tool:

```text
tokenmaxxer_status
```

Useful artifacts include:

| What | Location |
|---|---|
| Project-local memory | `.opencode/memory/STATE.json` |
| Global fallback memory | `~/.config/opencode/memory/<project-hash>/STATE.json` |
| Last TokenMaxxer compaction payload | `.opencode/memory/last_compaction_prompt.log` or global fallback |
| Last successful compaction diagnostic | `.opencode/memory/last_compaction_result.json` or global fallback |
| Corrupt-state backups | alongside the affected STATE file |
| Commit-pulse telemetry | `~/.config/opencode/memory/<project-hash>/.commit-pulse` |
| Release identity | `~/.config/opencode/tokenmaxxer-release.json` |

Check plugin logs when needed:

```bash
grep "tokenmaxxer plugin loaded" ~/.local/share/opencode/log/opencode.log
grep "compaction hook fired" ~/.local/share/opencode/log/opencode.log
```

Diagnostic persistence is best-effort and isolated from memory correctness: a diagnostic write failure does not turn a successful STATE transaction into a failed one.

---

## Reliability

TokenMaxxer treats project memory as state, not as a convenient scratch file.

That means the implementation includes:

- atomic writes
- explicit schema migration
- exact UTF-8 storage budgets
- bounded automatic field creation
- corrupt-file backup/recovery
- authoritative local/global read selection
- monotonic revisions
- cross-process project locking
- source idempotency tracking
- decision supersession and authority resolution
- provenance and evidence contracts
- human-reviewed foundational trust
- bounded diagnostic artifacts
- safe compaction fallbacks
- reproducible release checks
- immutable release manifests and SHA-256 verification
- transactional installer rollback

### CRIP: Concrete Reliability Implementation Plan

Before the first immutable `v0.1.0` release, TokenMaxxer completed a ten-workstream **Concrete Reliability Implementation Plan (CRIP)** covering storage authority, cross-process transactions, decision trust, host contracts, source idempotency, LLM trust boundaries, compaction quality, bounded storage, diagnostics, and release hygiene.

**All 10/10 workstreams reached independently reviewed `Complete — Ship` status.**

The review trail is intentionally public:

- [`docs/CRIP/README.md`](docs/CRIP/README.md) — CRIP index and status
- [`docs/CRIP/assessment.md`](docs/CRIP/assessment.md) — original reliability assessment
- [`docs/CRIP/implementation-plan.md`](docs/CRIP/implementation-plan.md) — ten-workstream implementation plan
- [`docs/CRIP/post-crip-adversarial-review.md`](docs/CRIP/post-crip-adversarial-review.md) — post-program adversarial review
- [`docs/CRIP/post-crip-hardening-plan.md`](docs/CRIP/post-crip-hardening-plan.md) — public follow-up hardening roadmap

The post-CRIP audit deliberately continues attacking edge cases rather than pretending the project is finished forever. That roadmap is part of the reliability story, not something hidden from it.

---

## Manual install / build from source

For development or a source build:

```bash
git clone https://github.com/thehun927/TokenMaxxer.git
cd TokenMaxxer
npm ci
npm run build
```

The build produces self-contained generated targets without code-split chunk files:

```text
dist/index.js   # server plugin
dist/tui.js     # TUI plugin
dist/cli.js     # human-review CLI
```

Copy the server and TUI targets for a global install:

```bash
mkdir -p ~/.config/opencode/plugins
cp dist/index.js ~/.config/opencode/plugins/tokenmaxxer.js
cp dist/tui.js ~/.config/opencode/plugins/tokenmaxxer-tui.js
cp dist/cli.js ~/.config/opencode/plugins/tokenmaxxer-cli.js
```

For the TUI target, add this entry to the `plugin` array in `~/.config/opencode/tui.json` without removing existing entries:

```jsonc
{
  "plugin": [
    "./plugins/tokenmaxxer-tui.js"
  ]
}
```

The OpenCode config package also needs compatible runtime dependencies:

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

Restart OpenCode after installing or replacing plugin targets.

> **Developer note:** the build pipeline includes a Bun-based TUI build step in addition to the Node/npm toolchain. Use the repository's pinned runtime/version files when developing.

---

## Architecture

```text
src/
├── index.ts                  # Plugin entry: hooks, idle writes, compaction diagnostics
├── config.ts                 # Compaction mode configuration + legacy mapping
├── cli.ts                    # Human decision-review CLI
├── tui.tsx                   # Commit-backed OpenCode TUI indicator
├── host/                     # Verified host-contract adapters
├── diagnostics/              # Bounded prompt/result diagnostic artifacts
├── compaction/
│   ├── prompt.ts             # Augment + schema-constrained replacement payloads
│   ├── durable.ts            # Bounded durable context construction
│   ├── history.ts            # Previous-compaction summary recovery
│   └── sanitize.ts           # Previous-summary sanitization
├── memory/
│   ├── schema.ts             # Versioned Zod memory/provenance schemas
│   ├── store.ts              # Authoritative reads + transactional persistence
│   ├── project-lock.ts       # Cross-process project lock
│   ├── budget.ts             # Deterministic 8 KiB fitting/protection policy
│   ├── writer.ts             # Idle extraction + merge pipeline
│   ├── merge.ts              # Durable state merge semantics
│   ├── decision-authority.ts # Authority/conflict resolution
│   ├── decision-review.ts    # Human promotion/supersession boundary
│   ├── extract-llm.ts        # Optional structured LLM extraction
│   ├── provider-inventory.ts # Connected model discovery
│   └── commit-pulse.ts       # Successful-commit telemetry for the TUI
├── tools/
│   ├── recall.ts             # Memory and decision tools
│   ├── efficiency.ts         # preview_compaction + head_files
│   ├── bounds.ts             # Tool result bounds
│   └── status.ts             # tokenmaxxer_status
└── util/                     # Atomic FS, logging, git helpers
```

The server and TUI are intentionally separate. Memory work never needs to render composer text, and the TUI is not required for extraction, recall, or compaction behavior.

---

## Development

```bash
npm ci
npm test
npm run build
npx tsc --noEmit
```

Useful reliability/release checks:

```bash
npm run verify:host-contract
npm run verify:dist
npm run verify:package
npm run verify:reproducible-build
npm run audit:release
npm run release:dry-run
```

Additional project documentation lives under [`docs/`](docs/), including the original design, implementation guide, TUI work, CRIP review trail, reliability plans, release process, and future ideas.

---

## Limitations

TokenMaxxer is intentionally conservative, and a few boundaries are worth understanding:

- **Heuristic extraction favors precision over recall.** Unusual decision phrasing can be missed. LLM extraction can improve structure, but remains optional and validated.
- **Memory is pull-based in new sessions.** The agent needs to call a recall tool such as `get_project_state`; TokenMaxxer does not automatically inject STATE into every composer session.
- **OpenCode event handlers are asynchronous.** An abrupt process exit can prevent detached idle work from finishing. Atomic persistence protects existing state from partial writes.
- **The project has an active post-CRIP hardening roadmap.** The public adversarial review documents remaining edge cases rather than claiming universal correctness.
- **OpenCode APIs evolve.** TokenMaxxer verifies a known host contract and currently declares compatibility with `>=1.18.15 <2.0.0`.

---

## License

[MIT](LICENSE)

---

<div align="center">

**Long sessions should get smarter, not more forgetful.**

If TokenMaxxer saves your agent from re-learning the same project twice, star the repo and put that context window back to work. ⭐

</div>
