// src/config.ts
function loadOptions(_ctx) {
  return {
    // Kill switch: set TOKENMAXXER_NO_PROMPT=1 to skip prompt replacement,
    // still inject durable block via output.context
    compactionPrompt: process.env.TOKENMAXXER_NO_PROMPT !== "1"
  };
}

// src/compaction/prompt.ts
function buildCompactionPrompt(durable) {
  return `You are generating a continuation prompt for an opencode session that has run out of context window space. The summary you produce REPLACES the entire conversation history for the agent that resumes this work, so it must be self-sufficient.

CRITICAL: You are ONLY generating a text summary. Do NOT make tool calls. Do NOT write files. Do NOT read files. Do NOT run commands. Output ONLY the summary text below \u2014 nothing else.

Produce a summary with EXACTLY these sections, in this order, each prefixed with its header:

## Current task
One paragraph: what we are doing and why. If no clear task, say "No active task."

## Active files
A bullet list. Each line: \`<path> \u2014 <why it matters to the current task>\`. Only files the task depends on. Omit files merely read for exploration.

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
- If a section would be empty, write the "None"/"No active task" literal \u2014 do not omit the section header.
- Treat the DURABLE CONTEXT block below as **recorded observations from prior sessions**. They are useful but may be stale or incomplete. Verify against the conversation if they conflict. Check git SHAs and timestamps before relying on a decision.

### DURABLE CONTEXT
${durable}`;
}

// src/memory/schema.ts
import { z as z2 } from "zod";

// src/memory/extract-schema.ts
import { z } from "zod";
var ExtractedActiveFileSchema = z.object({
  path: z.string(),
  reason: z.string()
}).strict();
var ExtractedDecisionSchema = z.object({
  topic: z.string(),
  decision: z.string(),
  /** References to labelled source-transcript candidates, never raw quotes. */
  evidence_refs: z.array(z.string().min(1).max(128)).min(1).max(3).optional().superRefine((refs, ctx) => {
    if (refs === void 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "evidence refs are required" });
      return;
    }
    if (new Set(refs).size !== refs.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "evidence refs must be unique" });
    }
  }),
  rationale: z.string().optional(),
  foundational: z.boolean().optional()
}).strict();
var ExtractedFactsSchema = z.object({
  current_task: z.string().nullable(),
  active_files: z.array(ExtractedActiveFileSchema).max(5),
  decisions: z.array(ExtractedDecisionSchema),
  blockers: z.array(z.string()),
  next_steps: z.array(z.string()).max(5)
}).strict();
var ExtractedFactsJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    current_task: {
      type: ["string", "null"]
    },
    active_files: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          reason: { type: "string" }
        },
        required: ["path", "reason"]
      }
    },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string" },
          decision: { type: "string" },
          evidence_refs: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 128 }
          },
          rationale: { type: "string" },
          foundational: { type: "boolean" }
        },
        required: ["topic", "decision", "evidence_refs"]
      }
    },
    blockers: {
      type: "array",
      items: { type: "string" }
    },
    next_steps: {
      type: "array",
      maxItems: 5,
      items: { type: "string" }
    }
  },
  required: [
    "current_task",
    "active_files",
    "decisions",
    "blockers",
    "next_steps"
  ]
};
function validateStructuredResult(result) {
  const parsed = ExtractedFactsSchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

// src/memory/schema.ts
var MAX_IDENTIFIER = 256;
var MAX_REFERENCE = 128;
var MAX_CACHE_QUARANTINE_COUNT = 1e4;
var MAX_MODEL_HEALTH_RECORDS = 10;
var EvidenceKindSchema = z2.enum(["transcript", "heuristic-candidate"]);
var EvidenceSchema = z2.object({
  kind: EvidenceKindSchema,
  ref: z2.string().min(1).max(MAX_REFERENCE),
  digest: z2.string().regex(/^[a-f0-9]{64}$/i)
}).strict();
var ExtractorSchema = z2.enum(["heuristic", "llm", "human", "legacy"]);
var ConfidenceSchema = z2.enum([
  "heuristic",
  "llm-corroborated",
  "human-reviewed",
  "legacy"
]);
var ProvenanceSchema = z2.object({
  extractor: ExtractorSchema,
  source_session_id: z2.string().min(1).max(MAX_IDENTIFIER),
  source_audit_session_id: z2.string().min(1).max(MAX_IDENTIFIER).optional(),
  confidence: ConfidenceSchema,
  evidence: z2.array(EvidenceSchema).max(3).default([])
}).strict();
var DecisionSchema = z2.object({
  id: z2.string(),
  topic: z2.string(),
  decision: z2.string(),
  rationale: z2.string().optional(),
  timestamp: z2.string().datetime({ offset: true }).or(z2.string()),
  // ISO 8601
  git_sha: z2.string().optional(),
  session_id: z2.string(),
  still_valid: z2.boolean().default(true),
  foundational: z2.boolean().optional(),
  // M4.5: promoted by model or auto-detected (undefined = false)
  foundational_requested: z2.boolean().default(false),
  // Human promotion request; not a promotion itself.
  last_used_in_session: z2.string().optional(),
  // M4.5: set by writer when decision is referenced
  provenance: ProvenanceSchema
});
var ActiveFileSchema = z2.object({
  path: z2.string(),
  reason: z2.string(),
  last_touched: z2.string().datetime({ offset: true }).or(z2.string()),
  // ISO 8601
  provenance: ProvenanceSchema
});
var ModelHealthOutcomeSchema = z2.enum([
  "success",
  "structured-shape-failure",
  "validation-failure",
  "transport-auth-failure",
  "timeout"
]);
var ModelHealthSchema = z2.object({
  provider_id: z2.string().min(1).max(MAX_IDENTIFIER),
  model_id: z2.string().min(1).max(MAX_IDENTIFIER),
  last_outcome: ModelHealthOutcomeSchema,
  failure_streak: z2.number().int().min(0).max(32).default(0),
  last_outcome_at: z2.string().datetime({ offset: true }).or(z2.string().max(128)).optional(),
  cooldown_until: z2.string().datetime({ offset: true }).or(z2.string().max(128)).optional(),
  failure_reason: z2.string().max(MAX_REFERENCE).optional()
});
var CacheQuarantineMetadataSchema = z2.object({
  count: z2.number().int().min(0).max(MAX_CACHE_QUARANTINE_COUNT),
  reason: z2.string().max(MAX_REFERENCE).optional()
});
var LLMExtractionCacheEntrySchema = z2.object({
  cache_key: z2.string(),
  source_session_id: z2.string(),
  canonical_input_sha256: z2.string(),
  provider_id: z2.string(),
  model_id: z2.string(),
  completed_at: z2.string().datetime({ offset: true }).or(z2.string()),
  /** Required for an evidence-backed v3 cache hit; optional for construction by the pre-v3 writer. */
  provenance: ProvenanceSchema.optional(),
  facts: ExtractedFactsSchema
});
var AuditTerminalOutcomeSchema = z2.enum(["pending", "success", "failed"]);
var LLMAuditMetadataSchema = z2.object({
  audit_session_id: z2.string().max(256),
  source_session_id: z2.string().max(256),
  cache_key: z2.string().max(512),
  provider_id: z2.string().max(256),
  model_id: z2.string().max(256),
  created_at: z2.string().datetime({ offset: true }).or(z2.string().max(128)),
  terminal_outcome: AuditTerminalOutcomeSchema
});
var MemoryFileBaseSchema = z2.object({
  version: z2.literal(3),
  project_path: z2.string(),
  last_updated: z2.string().datetime({ offset: true }).or(z2.string()),
  // ISO 8601
  last_git_sha: z2.string().optional(),
  last_session_id: z2.string().optional(),
  current_task: z2.string().optional(),
  current_task_provenance: ProvenanceSchema.optional(),
  active_files: z2.array(ActiveFileSchema).default([]),
  decisions: z2.array(DecisionSchema).default([]),
  blockers: z2.array(z2.string()).default([]),
  next_steps: z2.array(z2.string()).default([]),
  recent_sessions: z2.array(z2.string()).max(10).default([]),
  llm_extraction_cache: z2.array(LLMExtractionCacheEntrySchema).max(10).optional(),
  /** Additive v2 guard metadata; absent in older STATE.json files. */
  llm_extraction_audits: z2.array(LLMAuditMetadataSchema).max(20).optional(),
  /** Bounded local provider/model health records used by extraction gating. */
  model_health: z2.array(ModelHealthSchema).max(MAX_MODEL_HEALTH_RECORDS).optional(),
  /** Count/reason only; quarantined cache payloads are never retained. */
  llm_extraction_cache_quarantine: CacheQuarantineMetadataSchema.optional()
});
var MemoryFileSchema = MemoryFileBaseSchema.superRefine((memory, ctx) => {
  for (const [index, entry] of (memory.llm_extraction_cache ?? []).entries()) {
    const provenance = entry.provenance;
    if (!provenance || provenance.extractor !== "llm" || provenance.confidence !== "llm-corroborated" || !provenance.source_audit_session_id || provenance.evidence.length === 0) {
      ctx.addIssue({
        code: z2.ZodIssueCode.custom,
        path: ["llm_extraction_cache", index, "provenance"],
        message: "cache entry lacks evidence-backed provenance"
      });
    }
  }
});
function emptyMemory(worktree) {
  return {
    version: 3,
    project_path: worktree,
    last_updated: (/* @__PURE__ */ new Date()).toISOString(),
    active_files: [],
    decisions: [],
    blockers: [],
    next_steps: [],
    recent_sessions: []
  };
}

// src/memory/migrate.ts
var CURRENT_VERSION = 3;
var LEGACY_SOURCE_SESSION = "legacy";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function legacySourceSession(value) {
  const source = nonEmptyString(value);
  if (!source) return LEGACY_SOURCE_SESSION;
  return source.slice(0, 256);
}
function legacyProvenance(sourceSessionID) {
  return {
    extractor: "legacy",
    source_session_id: legacySourceSession(sourceSessionID),
    confidence: "legacy",
    evidence: []
  };
}
function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}
function migrateDecision(value, fallbackSource) {
  if (!isRecord(value)) return value;
  return {
    ...value,
    foundational_requested: hasOwn(value, "foundational_requested") ? value.foundational_requested : false,
    provenance: legacyProvenance(value.session_id ?? fallbackSource)
  };
}
function migrateActiveFile(value, fallbackSource) {
  if (!isRecord(value)) return value;
  return {
    ...value,
    provenance: legacyProvenance(fallbackSource)
  };
}
function migrateCurrentTask(data, fallbackSource) {
  if (typeof data.current_task !== "string") return data;
  return {
    ...data,
    // Keep current_task as the existing string for old readers.  Provenance is
    // additive rather than a replacement object/union.
    current_task_provenance: legacyProvenance(fallbackSource)
  };
}
function isEvidenceBackedCacheEntry(value) {
  if (!isRecord(value)) return false;
  const parsed = LLMExtractionCacheEntrySchema.safeParse(value);
  if (!parsed.success) return false;
  const provenance = parsed.data.provenance;
  return Boolean(
    provenance && provenance.extractor === "llm" && provenance.confidence === "llm-corroborated" && provenance.source_audit_session_id && provenance.evidence.length > 0
  );
}
function existingQuarantineCount(value) {
  const parsed = CacheQuarantineMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data.count : 0;
}
function quarantineUnprovenCache(data) {
  if (!Array.isArray(data.llm_extraction_cache)) return data;
  const retained = data.llm_extraction_cache.filter(isEvidenceBackedCacheEntry);
  const quarantined = data.llm_extraction_cache.length - retained.length;
  const result = { ...data };
  if (retained.length > 0) {
    result.llm_extraction_cache = retained;
  } else {
    delete result.llm_extraction_cache;
  }
  if (quarantined > 0) {
    const count = Math.min(
      1e4,
      existingQuarantineCount(data.llm_extraction_cache_quarantine) + quarantined
    );
    result.llm_extraction_cache_quarantine = {
      count,
      reason: "missing-evidence-backed-provenance"
    };
  }
  return result;
}
function migrateV1ToV2(data) {
  return {
    ...data,
    version: 2,
    recent_sessions: hasOwn(data, "recent_sessions") ? data.recent_sessions : []
  };
}
function migrateV2ToV3(data) {
  const fallbackSource = data.last_session_id;
  const withFacts = {
    ...data,
    version: CURRENT_VERSION,
    active_files: Array.isArray(data.active_files) ? data.active_files.map((file) => migrateActiveFile(file, fallbackSource)) : data.active_files,
    decisions: Array.isArray(data.decisions) ? data.decisions.map((decision) => migrateDecision(decision, fallbackSource)) : data.decisions
  };
  return quarantineUnprovenCache(migrateCurrentTask(withFacts, fallbackSource));
}
function loadAndMigrate(raw) {
  if (raw === null || raw === void 0) return null;
  if (!isRecord(raw)) return null;
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version)) return null;
  let data = raw;
  if (version === 1) {
    data = migrateV1ToV2(data);
  }
  if (data.version === 2) {
    data = migrateV2ToV3(data);
  }
  if (data.version !== CURRENT_VERSION) return null;
  const parsed = MemoryFileSchema.safeParse(data);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

// src/util/fs.ts
import { mkdir, writeFile, readFile, rename, stat } from "fs/promises";
import { dirname } from "path";
async function ensureDir(path) {
  await mkdir(dirname(path), { recursive: true }).catch(() => {
  });
}
async function atomicWrite(path, content) {
  const tmp = `${path}.tmp.${process.pid}`;
  await ensureDir(path);
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, path);
}
async function safeRead(path) {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}
async function getMtime(path) {
  try {
    const s = await stat(path);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

// src/memory/store.ts
import { join } from "path";
import { createHash } from "crypto";
import { homedir } from "os";

// src/util/log.ts
async function log(client, level, message, extra) {
  try {
    const c = client;
    await c.app?.log({
      body: { service: "tokenmaxxer", level, message, extra }
    });
  } catch {
  }
}

// src/memory/memory-size.ts
var MEMORY_MAX_BYTES = 8192;
function serializeMemory(mem) {
  return JSON.stringify(mem, null, 2);
}
function memorySizeBytes(mem) {
  return Buffer.byteLength(serializeMemory(mem), "utf8");
}

// src/memory/store.ts
var cache = /* @__PURE__ */ new Map();
function memoryPath(worktree) {
  return join(worktree, ".opencode", "memory", "STATE.json");
}
function globalPath(worktree) {
  const hash = createHash("sha256").update(worktree).digest("hex").slice(0, 16);
  return join(homedir(), ".config", "opencode", "memory", hash, "STATE.json");
}
function resolveProjectPath(worktree, directory) {
  if (!worktree || worktree === "/" || worktree === "") {
    return directory;
  }
  return worktree;
}
async function readMemory({
  worktree,
  directory
}) {
  const project = resolveProjectPath(worktree, directory);
  const path = memoryPath(project);
  const mtime = await getMtime(path);
  const cached = cache.get(project);
  if (cached && mtime !== null && cached.mtime === mtime) {
    return cached.mem;
  }
  if (cached && mtime === null && cached.mem === null) {
    return null;
  }
  const raw = await safeRead(path);
  if (raw === null) {
    cache.set(project, { mem: null, mtime: mtime ?? 0 });
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await backupCorrupt(path, raw);
    const empty = emptyMemory(project);
    cache.set(project, { mem: empty, mtime: mtime ?? 0 });
    return empty;
  }
  const mem = loadAndMigrate(parsed);
  if (mem === null) {
    await backupCorrupt(path, raw);
    const empty = emptyMemory(project);
    cache.set(project, { mem: empty, mtime: mtime ?? 0 });
    return empty;
  }
  cache.set(project, { mem, mtime: mtime ?? 0 });
  return mem;
}
async function writeMemory({ worktree, directory, client }, mem) {
  const project = resolveProjectPath(worktree, directory);
  const validated = MemoryFileSchema.safeParse(mem);
  if (!validated.success) {
    return false;
  }
  const path = memoryPath(project);
  const json = serializeMemory(validated.data);
  const bytes = memorySizeBytes(validated.data);
  if (bytes > MEMORY_MAX_BYTES) {
    void log(client, "error", `tokenmaxxer: STATE.json write rejected: exceeds ${MEMORY_MAX_BYTES}-byte cap`, {
      bytes,
      max_bytes: MEMORY_MAX_BYTES
    });
    cache.delete(project);
    return false;
  }
  try {
    await atomicWrite(path, json);
  } catch {
    try {
      await atomicWrite(globalPath(project), json);
    } catch {
      cache.delete(project);
      return false;
    }
    cache.delete(project);
    return true;
  }
  cache.delete(project);
  return true;
}
async function backupCorrupt(path, content) {
  try {
    await atomicWrite(`${path}.corrupt.${Date.now()}`, content);
  } catch {
  }
}

// src/compaction/durable.ts
async function buildDurableBlock(opts) {
  try {
    const mem = await readMemory({ worktree: opts.worktree, directory: opts.directory });
    if (!mem) return "(no prior project memory)";
    const lines = [];
    lines.push(`Project: ${mem.project_path}`);
    lines.push(`Last updated: ${mem.last_updated}  git SHA: ${mem.last_git_sha ?? "unknown"}`);
    if (mem.current_task) {
      lines.push(`Current task: ${mem.current_task}${formatProvenance(mem.current_task_provenance)}`);
    }
    const activeFiles = [...mem.active_files].sort((a, b) => b.last_touched.localeCompare(a.last_touched)).slice(0, 8);
    if (activeFiles.length) {
      lines.push("Active files:");
      for (const f of activeFiles) {
        lines.push(`  - ${f.path} \u2014 ${f.reason}${formatProvenance(f.provenance)}`);
      }
    }
    const valid = mem.decisions.filter((d) => d.still_valid);
    const foundational = valid.filter((d) => d.foundational);
    const recentSessions = mem.recent_sessions ?? [
      ...new Set(valid.map((d) => d.last_used_in_session).filter((id) => Boolean(id)))
    ];
    const recent = valid.filter(
      (d) => !d.foundational && isRecentSession(d, recentSessions)
    );
    const older = valid.filter(
      (d) => !d.foundational && !isRecentSession(d, recentSessions)
    ).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5);
    if (foundational.length || recent.length) {
      lines.push("Valid decisions:");
      for (const d of [...foundational, ...recent]) {
        lines.push(
          `  - ${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${d.timestamp})`,
          `    ${formatProvenance(d.provenance)}`
        );
      }
    }
    if (older.length) {
      lines.push("Older decisions:");
      for (const d of older) {
        const date = d.timestamp.slice(0, 10);
        lines.push(`  - ${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${date})${formatProvenance(d.provenance)}`);
      }
    }
    if (mem.blockers.length) {
      lines.push(`Blockers: ${mem.blockers.join("; ")}`);
    }
    if (mem.next_steps.length) {
      lines.push(`Next: ${mem.next_steps.join("; ")}`);
    }
    return lines.join("\n");
  } catch (e) {
    await log(opts.client, "warn", "buildDurableBlock failed", { error: String(e) });
    return "(memory unavailable)";
  }
}
function isRecentSession(d, recentSessions) {
  if (!d.last_used_in_session) return false;
  return recentSessions.slice(-3).includes(d.last_used_in_session);
}
function formatProvenance(provenance) {
  if (!provenance) return " (source=unknown confidence=unknown evidence=0)";
  return ` (source=${provenance.source_session_id}${provenance.source_audit_session_id ? ` audit=${provenance.source_audit_session_id}` : ""} confidence=${provenance.confidence} evidence=${provenance.evidence?.length ?? 0})`;
}

// src/memory/lock.ts
var queues = /* @__PURE__ */ new Map();
var MAX_QUEUE_STATES = 64;
var MAX_OUTCOME_LENGTH = 48;
function stateFor(project) {
  const existing = queues.get(project);
  if (existing) {
    existing.touchedAt = Date.now();
    return existing;
  }
  const created = {
    tail: Promise.resolve(),
    queued: 0,
    active: 0,
    inFlight: /* @__PURE__ */ new Map(),
    lastOutcome: null,
    touchedAt: Date.now()
  };
  queues.set(project, created);
  return created;
}
function pruneIdleStates() {
  if (queues.size <= MAX_QUEUE_STATES) return;
  for (const [project, state] of [...queues.entries()].filter(([, state2]) => state2.inFlight.size === 0 && state2.active === 0).sort(([, a], [, b]) => a.touchedAt - b.touchedAt)) {
    if (queues.size <= MAX_QUEUE_STATES) break;
    queues.delete(project);
  }
}
function boundedOutcome(outcome) {
  return outcome.slice(0, MAX_OUTCOME_LENGTH);
}
function enqueueProjectJob(project, sourceSessionID, job) {
  const state = stateFor(project);
  const existing = state.inFlight.get(sourceSessionID);
  if (existing) return existing;
  state.queued += 1;
  const run = state.tail.then(async () => {
    state.queued = Math.max(0, state.queued - 1);
    state.active += 1;
    try {
      return await job();
    } catch (error) {
      state.lastOutcome = "failed";
      throw error;
    } finally {
      state.active = Math.max(0, state.active - 1);
      state.inFlight.delete(sourceSessionID);
      state.touchedAt = Date.now();
      pruneIdleStates();
    }
  });
  state.tail = run.then(() => void 0, () => void 0);
  state.inFlight.set(sourceSessionID, run);
  pruneIdleStates();
  return run;
}
function setProjectQueueOutcome(project, outcome) {
  const state = stateFor(project);
  state.lastOutcome = boundedOutcome(outcome);
  state.touchedAt = Date.now();
}
function getProjectQueueStatus(project) {
  const state = queues.get(project);
  if (!state) {
    return {
      project,
      queueDepth: 0,
      inFlight: 0,
      active: 0,
      lastOutcome: null
    };
  }
  return {
    project,
    queueDepth: state.queued,
    inFlight: state.inFlight.size,
    active: state.active,
    lastOutcome: state.lastOutcome
  };
}

// src/util/git.ts
import { execFile } from "child_process";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
async function getCurrentGitSha(worktree) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", worktree, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      shell: false
    });
    const sha = stdout.trim();
    if (sha && /^[0-9a-f]{7,40}$/.test(sha)) return sha;
    return null;
  } catch {
    return null;
  }
}

// src/memory/writer.ts
import { basename, join as join3 } from "path";
import { randomUUID } from "crypto";

// src/memory/extract-prompt.ts
import { createHash as createHash2 } from "crypto";
var MAX_PRIOR_STATE_CHARS = 8e3;
var MAX_TRANSCRIPT_MESSAGES = 20;
var MAX_MESSAGE_CHARS = 500;
var MAX_FILE_CANDIDATES = 20;
var MAX_EVIDENCE_REF_CHARS = 128;
var FILE_TOOL_NAMES = /* @__PURE__ */ new Set(["read", "edit", "write", "glob", "grep", "bash"]);
function withoutExtractionCache(priorState) {
  if (priorState === null) return {};
  const snapshot = { ...priorState };
  delete snapshot.llm_extraction_cache;
  delete snapshot.llm_extraction_audits;
  delete snapshot.llm_extraction_cache_quarantine;
  delete snapshot.model_health;
  return snapshot;
}
function stableJson(value) {
  if (value === void 0) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const object = value;
  const entries = Object.keys(object).filter((key) => object[key] !== void 0).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`);
  return `{${entries.join(",")}}`;
}
function sha256Hex(value) {
  return createHash2("sha256").update(value, "utf8").digest("hex");
}
function makeTranscriptEvidenceRef(messageID) {
  return `tr-${sha256Hex(messageID).slice(0, 16)}`.slice(0, MAX_EVIDENCE_REF_CHARS);
}
function cloneJsonValue(value) {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value && typeof value === "object") {
    const clone = {};
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child !== void 0) clone[key] = cloneJsonValue(child);
    }
    return clone;
  }
  return value;
}
function findStringLocations(value, path = "$", parent, key, locations = []) {
  if (typeof value === "string" && parent !== void 0 && key !== void 0) {
    locations.push({ parent, key, value, path });
    return locations;
  }
  if (Array.isArray(value)) {
    value.forEach(
      (child, index) => findStringLocations(child, `${path}[${index}]`, value, index, locations)
    );
    return locations;
  }
  if (value && typeof value === "object") {
    for (const childKey of Object.keys(value).sort()) {
      findStringLocations(
        value[childKey],
        `${path}.${childKey}`,
        value,
        childKey,
        locations
      );
    }
  }
  return locations;
}
function findArrayLocations(value, path = "$", locations = []) {
  if (Array.isArray(value)) {
    locations.push({ value, path });
    value.forEach((child, index) => findArrayLocations(child, `${path}[${index}]`, locations));
    return locations;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value).sort()) {
      findArrayLocations(value[key], `${path}.${key}`, locations);
    }
  }
  return locations;
}
function findObjectLocations(value, path = "$", locations = []) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => findObjectLocations(child, `${path}[${index}]`, locations));
    return locations;
  }
  if (value && typeof value === "object") {
    const object = value;
    locations.push({ value: object, path });
    for (const key of Object.keys(object).sort()) {
      findObjectLocations(object[key], `${path}.${key}`, locations);
    }
  }
  return locations;
}
function capPriorStateJson(snapshot) {
  const capped = cloneJsonValue(snapshot);
  while (true) {
    const serialized = stableJson(capped);
    if (serialized.length <= MAX_PRIOR_STATE_CHARS) return serialized;
    const strings = findStringLocations(capped).sort(
      (a, b) => b.value.length - a.value.length || a.path.localeCompare(b.path)
    );
    const longest = strings[0];
    if (longest) {
      const reduction = Math.max(serialized.length - MAX_PRIOR_STATE_CHARS, 1);
      const nextLength = Math.max(0, longest.value.length - reduction);
      if (Array.isArray(longest.parent)) {
        longest.parent[longest.key] = longest.value.slice(0, nextLength);
      } else {
        longest.parent[longest.key] = longest.value.slice(0, nextLength);
      }
      continue;
    }
    const arrays = findArrayLocations(capped).filter((location) => location.value.length > 0).sort((a, b) => b.value.length - a.value.length || a.path.localeCompare(b.path));
    const largestArray = arrays[0];
    if (largestArray) {
      const remove = Math.max(1, Math.ceil(largestArray.value.length / 2));
      largestArray.value.splice(largestArray.value.length - remove, remove);
      continue;
    }
    const objects = findObjectLocations(capped).filter((location) => Object.keys(location.value).length > 0).sort(
      (a, b) => Object.keys(b.value).length - Object.keys(a.value).length || a.path.localeCompare(b.path)
    );
    const largestObject = objects[0];
    if (largestObject) {
      const keys = Object.keys(largestObject.value).sort();
      const remove = Math.max(1, Math.ceil(keys.length / 2));
      for (const key of keys.slice(-remove)) delete largestObject.value[key];
      continue;
    }
    return "{}";
  }
}
function normalizedTextCandidate(message) {
  const role = message.info.role.trim().toLowerCase();
  if (role !== "user" && role !== "assistant") return null;
  const text = message.parts.filter(
    (part) => part.type === "text" && typeof part.text === "string"
  ).map((part) => part.text).join("\n").replace(/\r\n?/g, "\n").trim();
  if (!text) return null;
  return { role, text: text.slice(0, MAX_MESSAGE_CHARS) };
}
function digestTranscriptEvidenceCandidate(candidate) {
  return sha256Hex(stableJson({
    ref: candidate.ref,
    role: candidate.role,
    text: candidate.text
  }));
}
function buildTranscriptEvidenceCandidates(messages) {
  const seenRefs = /* @__PURE__ */ new Map();
  const candidates = [];
  for (const message of messages) {
    const normalized = normalizedTextCandidate(message);
    if (!normalized) continue;
    const baseRef = makeTranscriptEvidenceRef(message.info.id);
    const occurrence = (seenRefs.get(baseRef) ?? 0) + 1;
    seenRefs.set(baseRef, occurrence);
    const ref = occurrence === 1 ? baseRef : `${baseRef}-${occurrence}`.slice(0, MAX_EVIDENCE_REF_CHARS);
    const candidate = {
      ref,
      role: normalized.role,
      text: normalized.text
    };
    candidates.push({
      ...candidate,
      digest: digestTranscriptEvidenceCandidate(candidate)
    });
  }
  return candidates.slice(-MAX_TRANSCRIPT_MESSAGES);
}
function buildTranscriptEvidenceCandidateMap(messages) {
  const map = {};
  for (const candidate of buildTranscriptEvidenceCandidates(messages)) {
    map[candidate.ref] = candidate;
  }
  return map;
}
function compressTranscript(messages) {
  return buildTranscriptEvidenceCandidates(messages).map((candidate) => `[${candidate.ref}] [${candidate.role}] ${candidate.text}`).join("\n");
}
function extractFileCandidates(messages) {
  const candidates = /* @__PURE__ */ new Set();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const toolName = part.tool;
      if (typeof toolName !== "string" || !FILE_TOOL_NAMES.has(toolName)) continue;
      const state = part.state;
      if (!state || typeof state !== "object") continue;
      const input = state.input;
      if (!input || typeof input !== "object") continue;
      const values = [];
      const record = input;
      for (const key of ["filePath", "path", "file"]) {
        const value = record[key];
        if (typeof value === "string") values.push(value);
      }
      for (const key of ["paths", "query"]) {
        if (!Array.isArray(record[key])) continue;
        for (const value of record[key]) {
          if (typeof value === "string") values.push(value);
        }
      }
      if (typeof record.pattern === "string") values.push(record.pattern);
      if (toolName === "bash" && typeof record.command === "string") {
        for (const match of record.command.matchAll(
          /(?:\.?\/)?(?:[\w.-]+\/)+[\w.-]+\.\w+/g
        )) {
          values.push(match[0]);
        }
      }
      for (const value of values) {
        const normalized = normalizeFileCandidate(value);
        if (normalized) candidates.add(normalized);
      }
    }
  }
  return [...candidates].sort().slice(0, MAX_FILE_CANDIDATES);
}
function normalizeFileCandidate(value) {
  let path = value.trim().replace(/^['"]|['"]$/g, "");
  path = path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
  path = path.replace(/[;,]+$/, "");
  if (!path || path.startsWith("-") || path.includes("\0")) return null;
  if (path.includes("://") || path.includes("github.com/")) return null;
  if (path.startsWith("/dev/") || path.startsWith("/usr/") || path.startsWith("/bin/") || path.startsWith("/lib/") || path.startsWith("/etc/") || path.startsWith("/proc/") || path.startsWith("/sys/") || path.startsWith("/tmp/opencode")) {
    return null;
  }
  if (path.startsWith("node_modules/") || path.includes("opencode.db")) return null;
  const sourcePrefix = ["src/", "test/", "tests/", "docs/", "lib/", "scripts/"];
  if (!/\.\w+(?:$|[/*])/.test(path) && !sourcePrefix.some((prefix) => path.startsWith(prefix))) {
    return null;
  }
  return path;
}
function serializeCanonicalInput(input) {
  return stableJson({
    prior_state: input.priorStateJson,
    source_transcript: input.compressedTranscript,
    file_candidates: input.fileCandidates
  });
}
function buildCanonicalInput(messages, priorState) {
  const priorStateJson = capPriorStateJson(
    withoutExtractionCache(priorState)
  );
  const compressedTranscript = compressTranscript(messages);
  const fileCandidates = extractFileCandidates(messages);
  const canonical = serializeCanonicalInput({
    priorStateJson,
    compressedTranscript,
    fileCandidates
  });
  return {
    priorStateJson,
    compressedTranscript,
    fileCandidates,
    sha256: sha256Hex(canonical)
  };
}
function makeExtractionCacheKey(sourceSessionID, canonicalInputSha256, model) {
  return `${sourceSessionID}:${canonicalInputSha256}:${model.providerID}/${model.modelID}`;
}
function buildExtractionPrompt(input) {
  return `You are a fact extractor for a coding session. Use the current-session evidence below to produce the values required by the StructuredOutput schema supplied with this request.

The prior STATE.json snapshot is potentially stale context. Return only current-session facts or deltas; do not copy old facts merely because they appear in prior state. Use file candidates as corroborating candidates, not as proof that a file was changed.

Rules:
- current_task: describe what the current session is working on; use null when unclear.
- active_files: must be an array of objects, each exactly \`{ "path": "relative/path", "reason": "short evidence-based reason" }\`; include only files read, edited, or written in this source session; max 5, relative paths; use an empty array if no qualifying files.
- decisions: must be an array of objects, each with required \`{ "topic": "short subject", "decision": "explicit decision", "evidence_refs": ["evidence ID"] }\`; \`evidence_refs\` must contain 1\u20133 unique IDs copied exactly from the labels in the COMPRESSED SOURCE TRANSCRIPT. Optional \`rationale\` and \`foundational\` must not replace evidence; include only explicit decisions (for example, "let's use X" or "decided to go with Y"); otherwise use an empty array. Do not include discussions, descriptions, or hypothetical decisions.
- blockers: only blockers supported by the current session; otherwise use an empty array.
- next_steps: only next steps stated by the current session; max 5.
- Every decision must cite one to three labelled source-transcript evidence IDs. Cite IDs only, never raw quotes or excerpts.
- Evidence IDs may point only to eligible user/assistant source-text labels in COMPRESSED SOURCE TRANSCRIPT. Never cite prior STATE.json, FILE CANDIDATES, these instructions, model/audit prose, or the model's own response.
- Do not include code snippets, tool outputs, or file contents.
- Do not answer with assistant text or free-form JSON. Return the result through the required StructuredOutput tool.

CAPPED PRIOR STATE.json (potentially stale):
${input.priorStateJson}

COMPRESSED SOURCE TRANSCRIPT:
${input.compressedTranscript || "(none)"}

FILE CANDIDATES:
${input.fileCandidates.join("\n") || "(none)"}`;
}

// src/memory/llm-adapter.ts
var VERIFIED_HOST_CONTRACT_VERSION = "1.18.15";
var MINIMUM_HOST_CONTRACT = "1.18";
var LLMAdapterError = class extends Error {
  code;
  stage;
  receivedKeys;
  /** Sanitized metadata only; raw SDK causes must not be retained. */
  errorMetadata;
  constructor(args) {
    super(args.message);
    this.name = "LLMAdapterError";
    this.code = args.code;
    this.stage = args.stage;
    this.receivedKeys = args.receivedKeys?.slice(0, 16).map((key) => key.slice(0, 64));
    this.errorMetadata = args.errorMetadata;
  }
};
var cachedHealthGate;
var healthGateInFlight;
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function clientOf(value) {
  return isRecord2(value) ? value : null;
}
function boundedKeys(value) {
  if (!isRecord2(value)) return void 0;
  return Object.keys(value).slice(0, 16).map((key) => key.slice(0, 64));
}
function sanitizeError(value) {
  const bounded = (item, fallback) => typeof item === "string" && item.length > 0 ? item.slice(0, 200) : fallback;
  if (value instanceof Error) {
    return { name: bounded(value.name, "Error"), message: bounded(value.message, "Unknown error") };
  }
  if (typeof value === "string") return { name: "Error", message: bounded(value, "Unknown error") };
  if (isRecord2(value)) {
    return {
      name: bounded(value.name, "Error"),
      message: bounded(value.message, "Unknown error")
    };
  }
  return { name: "Error", message: "Unknown error" };
}
function adapterError(args) {
  return new LLMAdapterError({
    code: args.code,
    stage: args.stage,
    message: args.message,
    ...args.received !== void 0 ? { receivedKeys: boundedKeys(args.received) } : {},
    ...args.cause !== void 0 ? { errorMetadata: sanitizeError(args.cause) } : {}
  });
}
function driftFailure(client, error) {
  void log(client, "debug", "sdk_response_shape_drift", {
    stage: error.stage,
    reason: error.code,
    ...error.receivedKeys ? { received_keys: error.receivedKeys } : {}
  });
  return { ok: false, error };
}
async function createAuditSession(clientValue, request) {
  const client = clientOf(clientValue);
  const create = client?.session?.create;
  if (!client || typeof create !== "function") {
    return {
      ok: false,
      error: adapterError({
        code: "unavailable-client",
        stage: "session-create",
        message: "host session create endpoint is unavailable"
      })
    };
  }
  try {
    const response = await create.call(client.session, {
      body: {
        title: request.title,
        metadata: {
          tokenmaxxer: {
            kind: "llm-extraction",
            sourceSessionID: request.sourceSessionID
          }
        }
      },
      query: { directory: request.directory }
    });
    if (!isRecord2(response)) {
      return driftFailure(clientValue, adapterError({
        code: "response-shape-drift",
        stage: "session-create",
        message: "host session create response is not an object",
        received: response
      }));
    }
    if (response.error != null) {
      return {
        ok: false,
        error: adapterError({
          code: "error-response",
          stage: "session-create",
          message: "host session create returned an error",
          cause: response.error
        })
      };
    }
    if (!isRecord2(response.data) || typeof response.data.id !== "string" || response.data.id.length === 0) {
      return driftFailure(clientValue, adapterError({
        code: "response-shape-drift",
        stage: "session-create",
        message: "host session create envelope lacks data.id",
        received: response
      }));
    }
    return { ok: true, value: response.data.id };
  } catch (error) {
    return {
      ok: false,
      error: adapterError({
        code: "request-error",
        stage: "session-create",
        message: "host session create request failed",
        cause: error
      })
    };
  }
}
async function requestStructuredOutput(clientValue, request) {
  const client = clientOf(clientValue);
  const prompt = client?.session?.prompt;
  if (!client || typeof prompt !== "function") {
    return {
      ok: false,
      error: adapterError({
        code: "unavailable-client",
        stage: "structured-prompt",
        message: "host session prompt endpoint is unavailable"
      })
    };
  }
  try {
    const response = await prompt.call(client.session, {
      path: { id: request.sessionID },
      query: { directory: request.directory },
      body: {
        model: request.model,
        parts: [{ type: "text", text: request.prompt }],
        format: { type: "json_schema", schema: request.schema },
        ...request.variant !== void 0 ? { variant: request.variant } : {}
      }
    });
    if (!isRecord2(response)) {
      return driftFailure(clientValue, adapterError({
        code: "response-shape-drift",
        stage: "structured-prompt",
        message: "host structured response is not an object",
        received: response
      }));
    }
    if (response.error != null) {
      return {
        ok: false,
        error: adapterError({
          code: "error-response",
          stage: "structured-prompt",
          message: "host structured request returned an error",
          cause: response.error
        })
      };
    }
    if (!isRecord2(response.data) || !isRecord2(response.data.info)) {
      return driftFailure(clientValue, adapterError({
        code: "response-shape-drift",
        stage: "structured-prompt",
        message: "host structured response envelope lacks data.info",
        received: response
      }));
    }
    if (response.data.info.error != null) {
      return {
        ok: false,
        error: adapterError({
          code: "error-response",
          stage: "structured-prompt",
          message: "host structured response info returned an error",
          cause: response.data.info.error
        })
      };
    }
    if (!Object.prototype.hasOwnProperty.call(response.data.info, "structured")) {
      return driftFailure(clientValue, adapterError({
        code: "structured-output-drift",
        stage: "structured-prompt",
        message: "host structured response envelope lacks data.info.structured",
        received: response.data.info
      }));
    }
    if (!isRecord2(response.data.info.structured)) {
      return driftFailure(clientValue, adapterError({
        code: "structured-output-drift",
        stage: "structured-prompt",
        message: "host structured response data.info.structured is not an object",
        received: response.data.info
      }));
    }
    return { ok: true, value: response.data.info.structured };
  } catch (error) {
    return {
      ok: false,
      error: adapterError({
        code: "request-error",
        stage: "structured-prompt",
        message: "host structured request failed",
        cause: error
      })
    };
  }
}
function parseHostVersion(version) {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) ? { major, minor } : null;
}
function healthGateFromResponse(response) {
  if (!isRecord2(response) || response.error != null || !isRecord2(response.data)) {
    return { allowed: false, source: "health", reason: "malformed-health" };
  }
  const health = response.data;
  if (!Object.prototype.hasOwnProperty.call(health, "healthy") || !Object.prototype.hasOwnProperty.call(health, "version")) {
    return { allowed: false, source: "health", reason: "malformed-health" };
  }
  if (health.healthy !== true) {
    return { allowed: false, source: "health", reason: "unhealthy" };
  }
  if (typeof health.version !== "string") {
    return { allowed: false, source: "health", reason: "malformed-health" };
  }
  const parsed = parseHostVersion(health.version);
  const minimum = parseHostVersion(MINIMUM_HOST_CONTRACT);
  if (!parsed || !minimum || parsed.major !== minimum.major || parsed.minor < minimum.minor) {
    return {
      allowed: false,
      source: "health",
      reason: "unsupported-version",
      hostVersion: health.version.slice(0, 64)
    };
  }
  return {
    allowed: true,
    source: "health",
    reason: "verified",
    hostVersion: health.version.slice(0, 64)
  };
}
async function readHostHealth(clientValue) {
  const client = clientOf(clientValue);
  const health = client?.global?.health;
  if (typeof health !== "function") {
    return {
      allowed: true,
      source: "pinned-compatibility",
      reason: "health-surface-unavailable"
    };
  }
  try {
    return healthGateFromResponse(await health.call(client?.global));
  } catch {
    return {
      allowed: false,
      source: "health",
      reason: "health-request-failed"
    };
  }
}
async function getHostStructuredContractGate(clientValue) {
  if (cachedHealthGate) return cachedHealthGate;
  healthGateInFlight ??= readHostHealth(clientValue);
  try {
    cachedHealthGate = await healthGateInFlight;
  } finally {
    healthGateInFlight = void 0;
  }
  void log(clientValue, cachedHealthGate.allowed ? "debug" : "warn", "sdk_host_version_gate", {
    reason: cachedHealthGate.reason,
    expected: `>=${MINIMUM_HOST_CONTRACT} (verified ${VERIFIED_HOST_CONTRACT_VERSION})`,
    ...cachedHealthGate.hostVersion ? { host_version: cachedHealthGate.hostVersion } : {}
  });
  return cachedHealthGate;
}

// src/memory/provider-inventory.ts
var MAX_DIAGNOSTICS = 16;
var MAX_IDENTIFIER2 = 256;
var MAX_VARIANTS = 32;
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedIdentifier(value) {
  if (typeof value !== "string") return void 0;
  const result = value.trim();
  if (!result || result.length > MAX_IDENTIFIER2 || /\s/.test(result)) return void 0;
  return result;
}
function receivedKeys(value) {
  if (!isRecord3(value)) return void 0;
  return Object.keys(value).slice(0, 12).map((key) => key.slice(0, 64));
}
function addDiagnostic(diagnostics, diagnostic) {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(diagnostic);
}
function readIdentifier(value, keys) {
  let malformed = false;
  const values = keys.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).map((key) => {
    const raw = value[key];
    if (raw === void 0 || boundedIdentifier(raw) === void 0) malformed = true;
    return boundedIdentifier(raw);
  }).filter((candidate) => candidate !== void 0);
  const distinct = [...new Set(values)];
  return {
    id: distinct[0],
    ambiguous: distinct.length > 1,
    malformed
  };
}
function connectedList(data, diagnostics) {
  if (!Object.prototype.hasOwnProperty.call(data, "connected")) return void 0;
  const value = data.connected;
  if (Array.isArray(value)) {
    const ids = [];
    for (const [index, item] of value.entries()) {
      const objectIdentifier = isRecord3(item) ? readIdentifier(item, ["id", "providerID", "provider_id"]) : void 0;
      const id = typeof item === "string" ? boundedIdentifier(item) : objectIdentifier && !objectIdentifier.malformed && !objectIdentifier.ambiguous ? objectIdentifier.id : void 0;
      if (!id) {
        addDiagnostic(diagnostics, {
          code: "malformed-connected",
          path: `data.connected[${index}]`,
          ...receivedKeys(item) ? { received_keys: receivedKeys(item) } : {}
        });
        continue;
      }
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }
  if (isRecord3(value)) {
    const ids = [];
    for (const [id, connected] of Object.entries(value).slice(0, 128)) {
      if (connected === true && boundedIdentifier(id)) ids.push(id);
    }
    if (Object.values(value).some((item) => typeof item !== "boolean")) {
      addDiagnostic(diagnostics, { code: "malformed-connected", path: "data.connected" });
    }
    return ids;
  }
  addDiagnostic(diagnostics, {
    code: "malformed-connected",
    path: "data.connected",
    ...receivedKeys(value) ? { received_keys: receivedKeys(value) } : {}
  });
  return void 0;
}
function readVariants(value) {
  const raw = value.variants;
  const variants = [];
  if (isRecord3(raw)) {
    for (const [name, variant] of Object.entries(raw)) {
      if (variants.length >= MAX_VARIANTS) break;
      if (boundedIdentifier(name) && variant !== false && variant !== null && variant !== void 0) {
        variants.push(name);
      }
    }
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (variants.length >= MAX_VARIANTS) break;
      const name = typeof item === "string" ? boundedIdentifier(item) : isRecord3(item) ? readIdentifier(item, ["id", "name", "variant"]).id : void 0;
      if (name && !variants.includes(name)) variants.push(name);
    }
  }
  return variants;
}
function boundedMetadata(value) {
  const metadata = {};
  const keys = ["status", "active", "name", "source", "providerID", "provider_id"];
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.length > 0) metadata[key] = item.slice(0, 128);
    if (typeof item === "number" && Number.isFinite(item)) metadata[key] = item;
    if (typeof item === "boolean") metadata[key] = item;
  }
  return metadata;
}
function normalizeModel(provider, modelKey, raw, path, diagnostics) {
  if (!isRecord3(raw)) {
    addDiagnostic(diagnostics, { code: "malformed-model", path, ...receivedKeys(raw) ? { received_keys: receivedKeys(raw) } : {} });
    return void 0;
  }
  const identifiers = readIdentifier(raw, ["id", "modelID", "model_id"]);
  if (identifiers.malformed || identifiers.ambiguous || modelKey && identifiers.id && modelKey !== identifiers.id) {
    addDiagnostic(diagnostics, {
      code: identifiers.malformed ? "malformed-model" : "ambiguous-model-id",
      path,
      ...receivedKeys(raw) ? { received_keys: receivedKeys(raw) } : {}
    });
    return void 0;
  }
  const model = identifiers.id ?? boundedIdentifier(modelKey);
  if (!model) {
    addDiagnostic(diagnostics, {
      code: "malformed-model",
      path,
      ...receivedKeys(raw) ? { received_keys: receivedKeys(raw) } : {}
    });
    return void 0;
  }
  const active = raw.active === void 0 ? raw.status === void 0 || raw.status === "active" : raw.active === true;
  const toolCallable = raw.tool_call === true || isRecord3(raw.capabilities) && raw.capabilities.toolcall === true;
  const cost = isRecord3(raw.cost) ? raw.cost : void 0;
  const zeroCost = cost !== void 0 && cost.input === 0 && cost.output === 0;
  return {
    provider,
    model,
    connected: true,
    active,
    tool_callable: toolCallable,
    zero_cost: zeroCost,
    variants: readVariants(raw),
    metadata: boundedMetadata(raw)
  };
}
function normalizeProvider(raw, index, connectedIDs, diagnostics) {
  if (!isRecord3(raw)) {
    addDiagnostic(diagnostics, { code: "malformed-provider", path: `data.all[${index}]` });
    return void 0;
  }
  const identifiers = readIdentifier(raw, ["id", "providerID", "provider_id"]);
  if (identifiers.malformed || identifiers.ambiguous || !identifiers.id) {
    addDiagnostic(diagnostics, {
      code: identifiers.ambiguous ? "ambiguous-provider-id" : "malformed-provider",
      path: `data.all[${index}]`,
      ...receivedKeys(raw) ? { received_keys: receivedKeys(raw) } : {}
    });
    return void 0;
  }
  const modelSource = raw.models;
  const modelEntries = [];
  if (isRecord3(modelSource)) {
    for (const [key, value] of Object.entries(modelSource).slice(0, 256)) modelEntries.push([key, value]);
  } else if (Array.isArray(modelSource)) {
    for (const value of modelSource.slice(0, 256)) modelEntries.push([void 0, value]);
  } else {
    addDiagnostic(diagnostics, {
      code: "malformed-models",
      path: `data.all[${index}].models`,
      ...receivedKeys(modelSource) ? { received_keys: receivedKeys(modelSource) } : {}
    });
    return void 0;
  }
  if (connectedIDs === void 0 && raw.connected !== void 0 && typeof raw.connected !== "boolean") {
    addDiagnostic(diagnostics, {
      code: "malformed-provider",
      path: `data.all[${index}].connected`,
      ...receivedKeys(raw) ? { received_keys: receivedKeys(raw) } : {}
    });
    return void 0;
  }
  const connected = connectedIDs === void 0 ? raw.connected !== false : connectedIDs.includes(identifiers.id);
  const models = [];
  for (const [modelKey, value] of modelEntries) {
    const model = normalizeModel(
      identifiers.id,
      modelKey,
      value,
      `data.all[${index}].models${modelKey ? `.${modelKey.slice(0, 64)}` : "[]"}`,
      diagnostics
    );
    if (model) models.push({ ...model, connected });
  }
  return { provider: identifiers.id, connected, models };
}
function emptyInventory(diagnostics) {
  return { providers: [], models: [], candidates: [], diagnostics };
}
function normalizeProviderInventory(value) {
  const diagnostics = [];
  if (!isRecord3(value) || value.error != null) {
    addDiagnostic(diagnostics, { code: "malformed-envelope", path: "response" });
    return emptyInventory(diagnostics);
  }
  const data = isRecord3(value.data) ? value.data : value;
  const providersValue = data.all ?? data.providers;
  if (!Array.isArray(providersValue)) {
    addDiagnostic(diagnostics, {
      code: "malformed-envelope",
      path: "data.all",
      ...receivedKeys(data) ? { received_keys: receivedKeys(data) } : {}
    });
    return emptyInventory(diagnostics);
  }
  const hasConnectedField = Object.prototype.hasOwnProperty.call(data, "connected");
  const connectedIDs = connectedList(data, diagnostics);
  if (hasConnectedField && connectedIDs === void 0) return emptyInventory(diagnostics);
  const providers = [];
  for (const [index, provider] of providersValue.slice(0, 256).entries()) {
    const normalized = normalizeProvider(provider, index, connectedIDs, diagnostics);
    if (normalized) providers.push(normalized);
  }
  if (providers.length === 0) return emptyInventory(diagnostics);
  return {
    providers,
    models: providers.flatMap((provider) => provider.models),
    candidates: providers.flatMap((provider) => provider.models),
    ...connectedIDs !== void 0 ? { connected_provider_ids: connectedIDs } : {},
    ...connectedIDs !== void 0 ? { connected: connectedIDs } : {},
    diagnostics
  };
}
function hasVariant(model, variant) {
  return model.variants.includes(variant);
}
function isEligibleAutomaticModel(model) {
  return model.connected && model.active && model.tool_callable && model.zero_cost;
}

// src/memory/extract-llm.ts
var MODEL_HEALTH_MAX_RECORDS = MAX_MODEL_HEALTH_RECORDS;
var MODEL_HEALTH_BASE_COOLDOWN_MS = 3e4;
var MODEL_HEALTH_MAX_COOLDOWN_MS = 15 * 6e4;
function getModelHealth(memory, model) {
  const providerID = model.providerID.slice(0, 256);
  const modelID = model.modelID.slice(0, 256);
  return memory?.model_health?.find((health) => health.provider_id === providerID && health.model_id === modelID);
}
function upsertModelHealth(memory, report, now = Date.now()) {
  const providerID = report.providerID.slice(0, 256);
  const modelID = report.modelID.slice(0, 256);
  const current = getModelHealth(memory, { providerID, modelID });
  const success = report.outcome === "success";
  const failureStreak = success ? 0 : Math.min(32, (current?.failure_streak ?? 0) + 1);
  const cooldownUntil = success ? void 0 : new Date(now + Math.min(
    MODEL_HEALTH_MAX_COOLDOWN_MS,
    MODEL_HEALTH_BASE_COOLDOWN_MS * 2 ** Math.max(0, failureStreak - 1)
  )).toISOString();
  const next = {
    provider_id: providerID,
    model_id: modelID,
    last_outcome: report.outcome,
    failure_streak: failureStreak,
    last_outcome_at: new Date(now).toISOString(),
    ...cooldownUntil ? { cooldown_until: cooldownUntil } : {},
    ...!success && report.reason ? { failure_reason: report.reason.slice(0, 128) } : {}
  };
  const records = (memory.model_health ?? []).filter((health) => !(health.provider_id === providerID && health.model_id === modelID));
  return {
    ...memory,
    model_health: [...records, next].slice(-MODEL_HEALTH_MAX_RECORDS)
  };
}
var MAX_DIAGNOSTIC_TEXT = 200;
var LLM_REQUEST_TIMEOUT_MS = 12e4;
var lastModelResolution = {
  candidate_count: 0,
  selection: "none"
};
function getLastLLMModelResolution() {
  return { ...lastModelResolution };
}
function sanitizeError2(error) {
  const bounded = (value, fallback) => {
    if (typeof value !== "string" || value.length === 0) return fallback;
    return value.slice(0, MAX_DIAGNOSTIC_TEXT);
  };
  if (error instanceof Error) {
    return {
      name: bounded(error.name, "Error"),
      message: bounded(error.message, "Unknown error")
    };
  }
  if (typeof error === "string") {
    return { name: "Error", message: bounded(error, "Unknown error") };
  }
  if (isRecord4(error)) {
    return {
      name: bounded(error.name, "Error"),
      message: bounded(error.message, "Unknown error")
    };
  }
  return { name: "Error", message: "Unknown error" };
}
var retainedExtractionSessionIDs = /* @__PURE__ */ new Set();
var MAX_RETAINED_EXTRACTION_SESSION_IDS = 256;
function retainExtractionSession(sessionID) {
  retainedExtractionSessionIDs.add(sessionID);
  while (retainedExtractionSessionIDs.size > MAX_RETAINED_EXTRACTION_SESSION_IDS) {
    const oldest = retainedExtractionSessionIDs.values().next();
    if (oldest.done) break;
    retainedExtractionSessionIDs.delete(oldest.value);
  }
}
var extractionInFlight = /* @__PURE__ */ new Map();
var evidenceAcceptedCount = 0;
var evidenceRejectedCount = 0;
function isRetainedExtractionSession(sessionID) {
  return retainedExtractionSessionIDs.has(sessionID);
}
async function isPersistedRetainedExtractionSession(args) {
  try {
    const memory = await readMemory({ worktree: args.worktree, directory: args.directory });
    return (memory?.llm_extraction_audits ?? []).some(
      (audit) => audit.audit_session_id === args.sessionID
    );
  } catch {
    return false;
  }
}
function getLLMEvidenceStats() {
  return {
    accepted: evidenceAcceptedCount,
    rejected: evidenceRejectedCount
  };
}
function parseSmallModel(smallModel) {
  if (typeof smallModel !== "string") return void 0;
  const value = smallModel.trim();
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return void 0;
  const providerID = value.slice(0, separator).trim();
  const modelID = value.slice(separator + 1).trim();
  if (!providerID || !modelID || /\s/.test(providerID) || /\s/.test(modelID)) return void 0;
  return { providerID, modelID };
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isModelCoolingDown(memory, model, now = Date.now()) {
  if (!memory || !model) return false;
  const providerID = ("providerID" in model ? model.providerID : model.provider).slice(0, 256);
  const modelID = ("modelID" in model ? model.modelID : model.model).slice(0, 256);
  const health = memory.model_health?.find((candidate) => candidate.provider_id === providerID && candidate.model_id === modelID);
  if (!health?.cooldown_until) return false;
  const until = Date.parse(health.cooldown_until);
  return Number.isFinite(until) && until > now;
}
function reportInventoryDiagnostics(client, inventory) {
  if (!inventory?.diagnostics.length) return;
  void log(client, "debug", "provider_inventory_shape_drift", {
    adapter: "v1-provider-inventory",
    diagnostics: inventory.diagnostics.slice(0, 16)
  });
}
function readConfiguredModel(result) {
  if (!isRecord4(result) || result.error != null || !isRecord4(result.data)) return void 0;
  const smallModel = result.data.small_model;
  return parseSmallModel(typeof smallModel === "string" ? smallModel : void 0);
}
async function resolveConfiguredModelVariant(client, directory, model, allowUnavailable = false) {
  if (!client.provider?.list) return { model };
  try {
    const inventory = normalizeProviderInventory(
      await client.provider.list({ query: { directory } })
    );
    reportInventoryDiagnostics(client, inventory);
    if (inventory.providers.length === 0) {
      return allowUnavailable ? { model } : { reason: "model inventory response is malformed" };
    }
    const provider = inventory.providers.find((candidate) => candidate.provider === model.providerID);
    if (!provider) return allowUnavailable ? { model } : { reason: "provider is not available" };
    if (!provider.connected) {
      return allowUnavailable ? { model } : { reason: "provider is not connected" };
    }
    const inventoryModel = provider.models.find((candidate) => candidate.model === model.modelID);
    if (!inventoryModel) return allowUnavailable ? { model } : { reason: "model is not available" };
    return {
      model: hasVariant(inventoryModel, "none") ? { ...model, variant: "none" } : model
    };
  } catch {
    return { model };
  }
}
async function discoverFreeSmallModel(client, directory, memory) {
  if (!client.provider?.list) return { reason: "model inventory is unavailable" };
  try {
    const inventory = normalizeProviderInventory(
      await client.provider.list({ query: { directory } })
    );
    reportInventoryDiagnostics(client, inventory);
    if (inventory.providers.length === 0) {
      return { reason: "model inventory response is malformed" };
    }
    let firstEligible;
    const eligible = inventory.models.filter(isEligibleAutomaticModel);
    const healthyEligible = eligible.filter((candidate) => !isModelCoolingDown(memory, candidate));
    lastModelResolution = {
      candidate_count: eligible.length,
      selection: "none"
    };
    for (const candidate of healthyEligible) {
      const selected = {
        providerID: candidate.provider,
        modelID: candidate.model,
        ...hasVariant(candidate, "none") ? { variant: "none" } : {}
      };
      if (selected.variant === "none") {
        return { model: selected, reason: "eligible model discovered" };
      }
      firstEligible ??= selected;
    }
    if (firstEligible) {
      return { model: firstEligible, reason: "eligible model discovered" };
    }
    if (eligible.length > 0 && healthyEligible.length === 0) {
      const cooled = eligible[0];
      if (cooled) {
        lastModelResolution = {
          candidate_count: eligible.length,
          selected_provider: cooled.provider,
          selected_model: cooled.model,
          selection: "automatic",
          ...hasVariant(cooled, "none") ? { variant: "none" } : {},
          reason: "all eligible models are on cooldown"
        };
      }
      return { reason: "all eligible models are on cooldown" };
    }
    return {
      reason: inventory.connected_provider_ids !== void 0 ? "no connected provider has a suitable free tool model" : "no eligible free model found"
    };
  } catch {
    return { reason: "model inventory request failed" };
  }
}
async function getLLMConfig(clientValue, directory = "", options) {
  if (process.env.TOKENMAXXER_LLM_EXTRACT !== "1") {
    return { enabled: false, reason: "TOKENMAXXER_LLM_EXTRACT is disabled" };
  }
  if (!options?.ignoreHealth) {
    const hostGate = await getHostStructuredContractGate(clientValue);
    if (!hostGate.allowed) {
      return {
        enabled: false,
        reason: `host structured contract gate: ${hostGate.reason}`
      };
    }
  }
  const client = clientValue ?? {};
  let configuredModel;
  if (client.config?.get) {
    try {
      configuredModel = readConfiguredModel(
        await client.config.get({ query: { directory } })
      );
    } catch {
    }
  }
  if (configuredModel) {
    const resolved = await resolveConfiguredModelVariant(
      client,
      directory,
      configuredModel,
      options?.ignoreHealth
    );
    lastModelResolution = {
      candidate_count: 1,
      selected_provider: configuredModel.providerID,
      selected_model: configuredModel.modelID,
      selection: "explicit",
      ...resolved.model?.variant ? { variant: resolved.model.variant } : {},
      ...resolved.reason ? { reason: resolved.reason } : {}
    };
    if (resolved.reason) return { enabled: false, reason: resolved.reason };
    if (!options?.ignoreHealth && isModelCoolingDown(options?.memory, resolved.model)) {
      lastModelResolution = {
        ...lastModelResolution,
        reason: "configured model is on cooldown"
      };
      return { enabled: false, reason: "configured model is on cooldown" };
    }
    return {
      enabled: true,
      model: resolved.model
    };
  }
  const discovered = await discoverFreeSmallModel(
    client,
    directory,
    options?.ignoreHealth ? null : options?.memory
  );
  if (discovered.model) {
    lastModelResolution = {
      ...lastModelResolution,
      selected_provider: discovered.model.providerID,
      selected_model: discovered.model.modelID,
      selection: "automatic",
      ...discovered.model.variant ? { variant: discovered.model.variant } : {}
    };
  } else {
    lastModelResolution = {
      ...lastModelResolution,
      selection: "none",
      reason: discovered.reason
    };
  }
  return discovered.model ? { enabled: true, model: discovered.model } : { enabled: false, reason: discovered.reason };
}
function adapterFailureReason(error, stage) {
  if (error.code === "request-error") return "request-error";
  if (error.code === "error-response") return "error-response";
  if (stage === "structured-prompt") {
    return "response-shape-drift";
  }
  return "malformed-response";
}
function adapterFailureError(error) {
  return error.errorMetadata;
}
function emitDiagnostic(callback, diagnostic) {
  if (!callback) return;
  try {
    Promise.resolve(callback(diagnostic)).catch(() => {
    });
  } catch {
  }
}
function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
function candidateContext(options) {
  const candidates = options?.evidenceCandidateMap ?? options?.evidenceCandidates ?? {};
  const digests = options?.evidenceDigestMap ?? options?.evidenceDigests ?? {};
  return { candidates, digests };
}
function resolveEvidenceReferences(refs, options) {
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 3) {
    return { evidence: [], reason: "missing-evidence" };
  }
  if (!refs.every((ref) => typeof ref === "string" && ref.length > 0 && ref.length <= 128)) {
    return { evidence: [], reason: "unknown-reference" };
  }
  if (new Set(refs).size !== refs.length) {
    return { evidence: [], reason: "invalid-candidate" };
  }
  const { candidates, digests } = candidateContext(options);
  const evidence = [];
  for (const ref of refs) {
    const candidate = candidates[ref];
    if (!candidate || candidate.ref !== ref) {
      return { evidence: [], reason: "unknown-reference" };
    }
    if (candidate.kind !== "transcript" && candidate.kind !== "heuristic-candidate" || !isSha256(candidate.digest)) {
      return { evidence: [], reason: "invalid-candidate" };
    }
    const expectedDigest = digests[ref];
    if (expectedDigest !== void 0 && expectedDigest !== candidate.digest) {
      return { evidence: [], reason: "digest-mismatch" };
    }
    evidence.push({
      kind: candidate.kind,
      ref,
      digest: candidate.digest
    });
  }
  return { evidence };
}
function corroborateLLMFacts(facts, options) {
  const decisions = facts.decisions;
  if (decisions.length === 0) return facts;
  const accepted = [];
  for (const decision of decisions) {
    const resolved = resolveEvidenceReferences(decision.evidence_refs, options);
    if (resolved.reason) {
      evidenceRejectedCount = Math.min(Number.MAX_SAFE_INTEGER, evidenceRejectedCount + 1);
      emitDiagnostic(options?.onDiagnostic, {
        kind: "evidence-rejected",
        reason: resolved.reason,
        evidence_count: Array.isArray(decision.evidence_refs) ? Math.min(decision.evidence_refs.length, 3) : 0,
        candidate_count: Math.min(
          Object.keys(candidateContext(options).candidates).length,
          128
        )
      });
      continue;
    }
    evidenceAcceptedCount = Math.min(Number.MAX_SAFE_INTEGER, evidenceAcceptedCount + 1);
    accepted.push(decision);
  }
  if (accepted.length === 0) return null;
  return {
    ...facts,
    decisions: accepted
  };
}
function reportUnvalidatedEvidenceFailures(structured, options) {
  if (!isRecord4(structured) || !Array.isArray(structured.decisions)) return;
  for (const decision of structured.decisions) {
    if (!isRecord4(decision)) continue;
    const resolved = resolveEvidenceReferences(decision.evidence_refs, options);
    if (!resolved.reason) continue;
    evidenceRejectedCount = Math.min(Number.MAX_SAFE_INTEGER, evidenceRejectedCount + 1);
    emitDiagnostic(options?.onDiagnostic, {
      kind: "evidence-rejected",
      reason: resolved.reason,
      evidence_count: Array.isArray(decision.evidence_refs) ? Math.min(decision.evidence_refs.length, 3) : 0,
      candidate_count: Math.min(
        Object.keys(candidateContext(options).candidates).length,
        128
      )
    });
  }
}
function isTimeoutError(error) {
  if (isRecord4(error) && (error.name === "TimeoutError" || error.code === "ETIMEDOUT")) return true;
  return error instanceof Error && /timed? ?out|timeout/i.test(error.message);
}
function adapterHealthOutcome(error) {
  if (error.errorMetadata && isTimeoutError(error.errorMetadata)) return "timeout";
  if (error.code === "response-shape-drift" || error.code === "structured-output-drift") {
    return "structured-shape-failure";
  }
  return "transport-auth-failure";
}
async function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("structured request timed out");
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
async function notifyHealthOutcome(callback, report) {
  if (!callback) return;
  try {
    await callback(report);
  } catch {
  }
}
async function extractFactsLLM(canonicalInput, sourceSessionID, projectName, clientValue, config, options) {
  if (!config.enabled || !config.model) return null;
  if (options?.cachedFacts) return options.cachedFacts;
  const projectKey = options?.projectKey ?? options?.directory ?? projectName;
  const inFlightKey = `${projectKey}\0${sourceSessionID}`;
  const existing = extractionInFlight.get(inFlightKey);
  if (existing) return existing;
  let promise;
  promise = (async () => {
    try {
      return await extractFactsLLMOnce(
        canonicalInput,
        sourceSessionID,
        projectName,
        clientValue,
        config,
        options
      );
    } finally {
      if (extractionInFlight.get(inFlightKey) === promise) {
        extractionInFlight.delete(inFlightKey);
      }
    }
  })();
  extractionInFlight.set(inFlightKey, promise);
  return promise;
}
async function extractFactsLLMOnce(canonicalInput, sourceSessionID, projectName, clientValue, config, options) {
  if (!config.enabled || !config.model) return null;
  const client = clientValue ?? {};
  if (!client.session?.create || !client.session.prompt) {
    emitDiagnostic(options?.onDiagnostic, {
      kind: "unavailable-client",
      reason: "missing-session-endpoint"
    });
    return null;
  }
  let extractionSessionID;
  try {
    const created = await withTimeout(
      createAuditSession(client, {
        directory: options?.directory ?? "",
        title: `tokenmaxxer extract \xB7 ${projectName} \xB7 ${sourceSessionID.slice(-8)}`,
        sourceSessionID
      }),
      options?.requestTimeoutMs ?? LLM_REQUEST_TIMEOUT_MS
    );
    if (!created.ok) {
      const reason = adapterFailureReason(created.error, "session-create");
      emitDiagnostic(options?.onDiagnostic, {
        kind: "session-create-failed",
        reason: reason === "response-shape-drift" ? "malformed-response" : reason,
        ...adapterFailureError(created.error) ? { error: adapterFailureError(created.error) } : {}
      });
      return null;
    }
    extractionSessionID = created.value;
    retainExtractionSession(extractionSessionID);
    const audit = {
      audit_session_id: extractionSessionID,
      source_session_id: sourceSessionID,
      cache_key: makeExtractionCacheKey(
        sourceSessionID,
        canonicalInput.sha256,
        config.model
      ),
      provider_id: config.model.providerID,
      model_id: config.model.modelID,
      created_at: (/* @__PURE__ */ new Date()).toISOString(),
      terminal_outcome: "pending"
    };
    if (options?.onAuditCreated) {
      try {
        const persisted = await options.onAuditCreated(audit);
        if (persisted === false) {
          emitDiagnostic(options.onDiagnostic, { kind: "audit-registration-failed" });
          return null;
        }
      } catch {
        emitDiagnostic(options.onDiagnostic, { kind: "audit-registration-failed" });
        return null;
      }
    }
  } catch (error) {
    emitDiagnostic(options?.onDiagnostic, {
      kind: "session-create-failed",
      reason: "request-error",
      error: sanitizeError2(error)
    });
    return null;
  }
  let terminalOutcome = "transport-auth-failure";
  let terminalReason = "request-error";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await withTimeout(
        requestStructuredOutput(client, {
          sessionID: extractionSessionID,
          directory: options?.directory ?? "",
          model: {
            providerID: config.model.providerID,
            modelID: config.model.modelID
          },
          prompt: buildExtractionPrompt(canonicalInput),
          schema: ExtractedFactsJsonSchema,
          ...config.model.variant !== void 0 ? { variant: config.model.variant } : {}
        }),
        options?.requestTimeoutMs ?? LLM_REQUEST_TIMEOUT_MS
      );
      if (!result.ok) {
        terminalOutcome = adapterHealthOutcome(result.error);
        terminalReason = terminalOutcome === "timeout" ? "timeout" : result.error.code;
        emitDiagnostic(options?.onDiagnostic, {
          kind: "structured-output-failed",
          attempt: attempt + 1,
          reason: adapterFailureReason(result.error, "structured-prompt"),
          ...adapterFailureError(result.error) ? { error: adapterFailureError(result.error) } : {}
        });
        continue;
      }
      const structured = result.value;
      const facts = validateStructuredResult(structured);
      if (facts) {
        const corroborated = corroborateLLMFacts(facts, options);
        if (corroborated) {
          await notifyAuditTerminal(options?.onAuditTerminal, extractionSessionID, "success");
          await notifyHealthOutcome(options?.onHealthOutcome, {
            providerID: config.model.providerID,
            modelID: config.model.modelID,
            outcome: "success",
            reason: "accepted-extraction"
          });
          return corroborated;
        }
        terminalOutcome = "validation-failure";
        terminalReason = "evidence-rejection";
        emitDiagnostic(options?.onDiagnostic, {
          kind: "structured-output-failed",
          attempt: attempt + 1,
          reason: "invalid-structured-output"
        });
        continue;
      }
      reportUnvalidatedEvidenceFailures(structured, options);
      terminalOutcome = "validation-failure";
      terminalReason = "structured-validation-failure";
      emitDiagnostic(options?.onDiagnostic, {
        kind: "structured-output-failed",
        attempt: attempt + 1,
        reason: structured === void 0 ? "malformed-response" : "invalid-structured-output"
      });
    } catch (error) {
      terminalOutcome = isTimeoutError(error) ? "timeout" : "transport-auth-failure";
      terminalReason = isTimeoutError(error) ? "timeout" : "request-error";
      emitDiagnostic(options?.onDiagnostic, {
        kind: "structured-output-failed",
        attempt: attempt + 1,
        reason: "request-error",
        error: sanitizeError2(error)
      });
    }
  }
  emitDiagnostic(options?.onDiagnostic, { kind: "retries-exhausted", attempts: 2 });
  await notifyAuditTerminal(options?.onAuditTerminal, extractionSessionID, "failed");
  await notifyHealthOutcome(options?.onHealthOutcome, {
    providerID: config.model.providerID,
    modelID: config.model.modelID,
    outcome: terminalOutcome,
    reason: terminalReason
  });
  return null;
}
async function notifyAuditTerminal(callback, auditSessionID, outcome) {
  if (!callback) return;
  try {
    await callback(auditSessionID, outcome);
  } catch {
  }
}
function hasEvidenceBackedProvenance(entry, options) {
  const provenance = entry.provenance;
  if (!provenance || provenance.extractor !== "llm" || provenance.confidence !== "llm-corroborated" || !provenance.source_audit_session_id || provenance.evidence.length === 0) return false;
  const evidenceByRef = new Map(provenance.evidence.map((evidence) => [evidence.ref, evidence]));
  for (const decision of entry.facts.decisions) {
    if (!Array.isArray(decision.evidence_refs) || decision.evidence_refs.length < 1) return false;
    for (const ref of decision.evidence_refs) {
      const evidence = evidenceByRef.get(ref);
      if (!evidence) return false;
    }
  }
  if (!options) return true;
  const { candidates, digests } = candidateContext(options);
  return provenance.evidence.every((evidence) => {
    const candidate = candidates[evidence.ref];
    return Boolean(
      candidate && candidate.ref === evidence.ref && candidate.kind === evidence.kind && candidate.digest === evidence.digest && (digests[evidence.ref] === void 0 || digests[evidence.ref] === evidence.digest)
    );
  });
}
function readExtractionCacheEntry(memory, cacheKey, options) {
  for (const candidate of [...memory?.llm_extraction_cache ?? []].reverse()) {
    const parsed = LLMExtractionCacheEntrySchema.safeParse(candidate);
    if (parsed.success && parsed.data.cache_key === cacheKey && hasEvidenceBackedProvenance(parsed.data, options)) return parsed.data;
  }
  return null;
}
function makeExtractionCacheEntry(args) {
  const provenance = args.provenance ?? (args.auditSessionID && args.evidence && args.evidence.length > 0 ? {
    extractor: "llm",
    source_session_id: args.sourceSessionID,
    source_audit_session_id: args.auditSessionID,
    confidence: "llm-corroborated",
    evidence: args.evidence.slice(0, 3)
  } : void 0);
  return {
    cache_key: makeExtractionCacheKey(
      args.sourceSessionID,
      args.canonicalInput.sha256,
      args.model
    ),
    source_session_id: args.sourceSessionID,
    canonical_input_sha256: args.canonicalInput.sha256,
    provider_id: args.model.providerID,
    model_id: args.model.modelID,
    completed_at: args.completedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    ...provenance ? { provenance } : {},
    facts: args.facts
  };
}
function upsertExtractionCache(memory, entry) {
  const parsed = LLMExtractionCacheEntrySchema.safeParse(entry);
  if (!parsed.success || !hasEvidenceBackedProvenance(parsed.data)) return memory;
  const entries = (memory.llm_extraction_cache ?? []).map((candidate) => LLMExtractionCacheEntrySchema.safeParse(candidate)).filter((candidate) => candidate.success).map((candidate) => candidate.data).filter((candidate) => candidate.cache_key !== parsed.data.cache_key);
  return {
    ...memory,
    llm_extraction_cache: [...entries, parsed.data].slice(-10)
  };
}
function extractionCacheKey(sourceSessionID, canonicalInput, model) {
  return makeExtractionCacheKey(sourceSessionID, canonicalInput.sha256, model);
}

// src/memory/activity-state.ts
import { unlink } from "fs/promises";
import { join as join2 } from "path";
var REFRESH_MS = 2e3;
var ACTIVITY_FILE = ".opencode/.tokenmaxxer-memory-activity";
var states = /* @__PURE__ */ new Map();
function memoryActivityPath(project) {
  return join2(project, ACTIVITY_FILE);
}
async function removeMarker(project) {
  await unlink(memoryActivityPath(project)).catch(() => {
  });
}
async function refreshMarker(project, generation) {
  const state = states.get(project);
  if (!state || state.references === 0 || state.generation !== generation) return;
  try {
    await atomicWrite(memoryActivityPath(project), JSON.stringify({ updated_at: Date.now() }));
    if (!states.has(project)) await removeMarker(project);
  } catch {
  }
}
function beginMemoryActivity(project) {
  const state = states.get(project) ?? { references: 0, generation: 0 };
  state.references += 1;
  state.generation += 1;
  const generation = state.generation;
  states.set(project, state);
  void refreshMarker(project, generation);
  if (!state.timer) {
    state.timer = setInterval(() => void refreshMarker(project, state.generation), REFRESH_MS);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    state.references = Math.max(0, state.references - 1);
    if (state.references > 0) return;
    state.generation += 1;
    if (state.timer) clearInterval(state.timer);
    state.timer = void 0;
    states.delete(project);
    void removeMarker(project);
  };
}

// src/memory/writer.ts
var TRANSCRIPT_WINDOW = 50;
var MAX_DIAGNOSTIC_VALUE = 200;
function boundedDiagnosticValue(value) {
  return value.length <= MAX_DIAGNOSTIC_VALUE ? value : `${value.slice(0, MAX_DIAGNOSTIC_VALUE - 3)}...`;
}
function logLLMDiagnostic(client, diagnostic) {
  const level = diagnostic.kind === "structured-output-failed" || diagnostic.kind === "unavailable-client" ? "debug" : "warn";
  const extra = { kind: diagnostic.kind };
  if ("reason" in diagnostic) extra.reason = boundedDiagnosticValue(diagnostic.reason);
  if ("attempt" in diagnostic) extra.attempt = diagnostic.attempt;
  if ("attempts" in diagnostic) extra.attempts = diagnostic.attempts;
  if ("evidence_count" in diagnostic) extra.evidence_count = diagnostic.evidence_count;
  if ("candidate_count" in diagnostic) extra.candidate_count = diagnostic.candidate_count;
  if ("error" in diagnostic && diagnostic.error) extra.error = diagnostic.error;
  void log(client, level, "llm extraction diagnostic", extra);
}
function heuristicCandidateRef(kind, value) {
  return `hc-${sha256Hex(stableJson({ kind, value })).slice(0, 16)}`;
}
function heuristicCandidate(kind, value) {
  const ref = heuristicCandidateRef(kind, value);
  return {
    kind: "heuristic-candidate",
    ref,
    digest: sha256Hex(stableJson({ kind, ref, value }))
  };
}
function buildHeuristicEvidenceCandidateMap(facts) {
  const map = {};
  if (facts.current_task) {
    const candidate = heuristicCandidate("current-task", facts.current_task);
    map[candidate.ref] = candidate;
  }
  for (const file of facts.active_files.slice(0, 5)) {
    const candidate = heuristicCandidate("active-file", file);
    map[candidate.ref] = candidate;
  }
  for (const decision of facts.decisions.slice(0, 5)) {
    const candidate = heuristicCandidate("decision", {
      topic: decision.topic,
      decision: decision.decision
    });
    map[candidate.ref] = candidate;
  }
  return map;
}
function transcriptCandidateMap(messages) {
  const source = buildTranscriptEvidenceCandidateMap(messages);
  const map = {};
  for (const [ref, candidate] of Object.entries(source)) {
    map[ref] = {
      kind: "transcript",
      ref,
      digest: candidate.digest,
      text: candidate.text,
      role: candidate.role
    };
  }
  return map;
}
function mergeEvidenceCandidateMaps(...maps) {
  const merged = {};
  for (const map of maps) {
    for (const [ref, candidate] of Object.entries(map)) {
      if (!merged[ref]) merged[ref] = candidate;
    }
  }
  return merged;
}
function evidenceDigestMap(candidates) {
  const digests = {};
  for (const ref of Object.keys(candidates).sort()) {
    const digest = candidates[ref]?.digest;
    if (digest) digests[ref] = digest;
  }
  return digests;
}
function candidateEvidence(refs, candidates) {
  return resolveEvidenceReferences(refs, {
    evidenceCandidateMap: candidates,
    evidenceDigestMap: evidenceDigestMap(candidates)
  }).evidence;
}
function firstCandidateEvidence(candidates) {
  const ref = Object.keys(candidates).sort()[0];
  if (!ref) return [];
  const candidate = candidates[ref];
  return candidate ? [{ kind: candidate.kind, ref, digest: candidate.digest }] : [];
}
async function writeMemoryOnIdle(opts) {
  const project = resolveProjectPath(opts.worktree, opts.directory);
  const stopActivity = beginMemoryActivity(project);
  try {
    const outcome = await enqueueProjectJob(
      project,
      opts.sessionId,
      () => writeMemoryOnIdleSerialized(opts)
    );
    setProjectQueueOutcome(project, outcome);
    return outcome;
  } catch {
    setProjectQueueOutcome(project, "queue-failed");
    return "queue-failed";
  } finally {
    stopActivity();
  }
}
async function writeMemoryOnIdleSerialized(opts) {
  try {
    const { client, worktree, directory, sessionId } = opts;
    const c = client;
    if (!c.session?.messages) return "no-messages";
    const result = await c.session.messages({ path: { id: sessionId } });
    const allMessages = result.data;
    if (!allMessages || allMessages.length === 0) return "no-messages";
    const messages = allMessages.slice(-TRANSCRIPT_WINDOW);
    const existing = await readMemory({ worktree, directory }) ?? emptyMemory(worktree);
    const canonicalPrior = { ...existing, llm_extraction_audits: void 0 };
    const canonicalInput = buildCanonicalInput(messages, canonicalPrior);
    const gitSha = await getCurrentGitSha(worktree);
    const extracted = extractFactsHeuristic(messages);
    const candidates = mergeEvidenceCandidateMaps(
      transcriptCandidateMap(messages),
      buildHeuristicEvidenceCandidateMap(extracted)
    );
    const digests = evidenceDigestMap(candidates);
    markReferencedDecisions(existing, allMessages, sessionId);
    const merged = mergeMemory(existing, extracted, {
      sessionId,
      gitSha,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      origin: "heuristic",
      evidenceCandidates: candidates
    });
    const pruned = pruneOld(recordRecentSession(merged, sessionId), client);
    const heuristicPersisted = await writeMemory({ worktree, directory, client }, pruned);
    if (heuristicPersisted === false) return "write-failed";
    await generateHeader(worktree, directory, pruned);
    if (process.env.TOKENMAXXER_LLM_EXTRACT !== "1") {
      void log(client, "debug", "llm extraction skipped: TOKENMAXXER_LLM_EXTRACT is disabled", {
        reason: "TOKENMAXXER_LLM_EXTRACT is disabled"
      });
      return "heuristic-only";
    }
    const cacheConfig = await getLLMConfig(client, directory, { ignoreHealth: true });
    if (!cacheConfig.model) {
      void log(client, "info", "llm extraction skipped: model unavailable", {
        reason: boundedDiagnosticValue(cacheConfig.reason ?? "model resolution returned no model")
      });
      return "heuristic-only";
    }
    void log(client, "info", "llm extraction model resolved", {
      provider: boundedDiagnosticValue(cacheConfig.model.providerID),
      model: boundedDiagnosticValue(cacheConfig.model.modelID)
    });
    const cacheKey = extractionCacheKey(sessionId, canonicalInput, cacheConfig.model);
    const afterHeuristic = await readMemory({ worktree, directory }) ?? pruned;
    const cachedEntry = readExtractionCacheEntry(afterHeuristic, cacheKey, {
      evidenceCandidateMap: candidates,
      evidenceDigestMap: digests
    });
    if (cachedEntry) {
      void log(client, "debug", "llm extraction cache hit");
      const merged2 = await mergeAsyncFacts(opts, cachedEntry.facts, gitSha, sessionId, {
        origin: "llm",
        auditSessionID: cachedEntry.provenance?.source_audit_session_id,
        evidenceCandidates: candidates,
        provenanceEvidence: cachedEntry.provenance?.evidence
      });
      if (!merged2) return "llm-failed";
      void log(client, "info", "llm extraction facts merged");
      return "cache-hit";
    }
    const llmConfig = await getLLMConfig(client, directory, { memory: afterHeuristic });
    if (!llmConfig.enabled || !llmConfig.model) {
      void log(client, "info", "llm extraction skipped: model unavailable", {
        reason: boundedDiagnosticValue(llmConfig.reason ?? "model resolution returned no model")
      });
      return "heuristic-only";
    }
    const selectedCacheKey = extractionCacheKey(sessionId, canonicalInput, llmConfig.model);
    if (selectedCacheKey !== cacheKey) {
      const selectedCachedEntry = readExtractionCacheEntry(afterHeuristic, selectedCacheKey, {
        evidenceCandidateMap: candidates,
        evidenceDigestMap: digests
      });
      if (selectedCachedEntry) {
        const merged2 = await mergeAsyncFacts(opts, selectedCachedEntry.facts, gitSha, sessionId, {
          origin: "llm",
          auditSessionID: selectedCachedEntry.provenance?.source_audit_session_id,
          evidenceCandidates: candidates,
          provenanceEvidence: selectedCachedEntry.provenance?.evidence
        });
        if (!merged2) return "llm-failed";
        return "cache-hit";
      }
    }
    const project = resolveProjectPath(worktree, directory);
    const projectName = basename(project) || project;
    let extractionAuditSessionID;
    const persistAudit = async (audit) => {
      extractionAuditSessionID = audit.audit_session_id;
      const latest2 = await readMemory({ worktree, directory }) ?? afterHeuristic;
      const guarded = upsertAuditMetadata(latest2, audit);
      return writeMemory({ worktree, directory, client }, pruneOld(guarded, client));
    };
    const persistTerminal = async (auditSessionID, outcome) => {
      const latest2 = await readMemory({ worktree, directory });
      if (!latest2) return;
      const updated = setAuditTerminalOutcome(latest2, auditSessionID, outcome);
      await writeMemory({ worktree, directory, client }, pruneOld(updated, client));
    };
    void log(client, "debug", "llm extraction audit session requested");
    const llmFacts = await extractFactsLLM(
      canonicalInput,
      sessionId,
      projectName,
      client,
      llmConfig,
      {
        directory,
        projectKey: project,
        evidenceCandidateMap: candidates,
        evidenceDigestMap: digests,
        onDiagnostic: (diagnostic) => logLLMDiagnostic(client, diagnostic),
        onAuditCreated: persistAudit,
        onAuditTerminal: persistTerminal,
        onHealthOutcome: async (report) => {
          const latest2 = await readMemory({ worktree, directory });
          if (!latest2) return;
          const updated = upsertModelHealth(latest2, report);
          await writeMemory({ worktree, directory, client }, pruneOld(updated, client));
        }
      }
    );
    if (!llmFacts) {
      void log(client, "warn", "llm extraction returned no facts");
      return "llm-failed";
    }
    const latest = await readMemory({ worktree, directory }) ?? pruned;
    const cacheAlreadyCommitted = readExtractionCacheEntry(latest, selectedCacheKey, {
      evidenceCandidateMap: candidates,
      evidenceDigestMap: digests
    });
    if (cacheAlreadyCommitted) {
      const merged2 = await mergeAsyncFacts(opts, cacheAlreadyCommitted.facts, gitSha, sessionId, {
        origin: "llm",
        auditSessionID: cacheAlreadyCommitted.provenance?.source_audit_session_id,
        evidenceCandidates: candidates,
        provenanceEvidence: cacheAlreadyCommitted.provenance?.evidence
      });
      if (!merged2) return "llm-failed";
      return "cache-hit";
    }
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const mergedLLM = mergeMemory(latest, llmFacts, {
      sessionId,
      gitSha,
      timestamp,
      origin: "llm",
      auditSessionID: extractionAuditSessionID,
      evidenceCandidates: candidates
    });
    const decisionEvidence = [
      ...llmFacts.decisions.flatMap((decision) => candidateEvidence(
        decision.evidence_refs,
        candidates
      ))
    ].filter((evidence, index, all) => all.findIndex((candidate) => candidate.ref === evidence.ref) === index);
    const cacheEvidence = decisionEvidence.length > 0 ? decisionEvidence : firstCandidateEvidence(candidates);
    const cacheCanRepresentAllEvidence = decisionEvidence.length <= 3;
    const withCache = cacheCanRepresentAllEvidence && cacheEvidence.length > 0 && extractionAuditSessionID ? upsertExtractionCache(
      recordRecentSession(mergedLLM, sessionId),
      makeExtractionCacheEntry({
        sourceSessionID: sessionId,
        canonicalInput,
        model: llmConfig.model,
        facts: llmFacts,
        auditSessionID: extractionAuditSessionID,
        evidence: cacheEvidence,
        completedAt: timestamp
      })
    ) : recordRecentSession(mergedLLM, sessionId);
    const finalMemory = pruneOld(withCache, client);
    const committed = await writeMemory({ worktree, directory, client }, finalMemory);
    if (committed === false) return "llm-failed";
    await generateHeader(worktree, directory, finalMemory);
    void log(client, "info", "llm extraction facts merged");
    return "llm-success";
  } catch {
    return "heuristic-only";
  }
}
function upsertAuditMetadata(mem, audit) {
  const audits = (mem.llm_extraction_audits ?? []).filter((candidate) => candidate.audit_session_id !== audit.audit_session_id);
  return {
    ...mem,
    llm_extraction_audits: boundedAuditMetadata([...audits, audit])
  };
}
function boundedAuditMetadata(audits) {
  const active = audits.filter((audit) => audit.terminal_outcome === "pending");
  const completed = audits.filter((audit) => audit.terminal_outcome !== "pending");
  const retainedActive = mostRecentAuditRecords(active, 20);
  const completedSlots = Math.max(0, 20 - retainedActive.length);
  return [...mostRecentAuditRecords(completed, completedSlots), ...retainedActive];
}
function mostRecentAuditRecords(audits, limit) {
  if (limit >= audits.length) return audits;
  return audits.map((audit, index) => ({ audit, index })).sort((left, right) => left.audit.created_at.localeCompare(right.audit.created_at) || left.index - right.index).slice(-limit).sort((left, right) => left.index - right.index).map(({ audit }) => audit);
}
function setAuditTerminalOutcome(mem, auditSessionID, outcome) {
  return {
    ...mem,
    llm_extraction_audits: (mem.llm_extraction_audits ?? []).map((audit) => audit.audit_session_id === auditSessionID ? { ...audit, terminal_outcome: outcome } : audit)
  };
}
async function mergeAsyncFacts(opts, facts, gitSha, sessionId, mergeOptions) {
  const latest = await readMemory({ worktree: opts.worktree, directory: opts.directory }) ?? emptyMemory(opts.worktree);
  const merged = mergeMemory(latest, facts, {
    sessionId,
    gitSha,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    ...mergeOptions
  });
  const finalMemory = pruneOld(recordRecentSession(merged, sessionId), opts.client);
  const persisted = await writeMemory(
    { worktree: opts.worktree, directory: opts.directory, client: opts.client },
    finalMemory
  );
  if (!persisted) return false;
  await generateHeader(opts.worktree, opts.directory, finalMemory);
  return true;
}
var DECISION_KEYWORD_RE = /(?:^|[,;]\s+|\.+\s+)(?:decision|decided|let's|we'll|we will|chose|picked|going with|go with|settle on|settled on)\s+(?!not|never|against|avoid|skip|reject)\b/i;
var NEGATION_WORDS_RE = /(?:not|never|don't|won't|avoid|skip|reject|against)/i;
var FOUNDATIONAL_RE = /we (will|'ll) (always|never)|architect(?:ure)? decision|breaking change|migrat(?:e|ion|ing) to|this (?:changes|breaks) the (?:public )?api/i;
function extractFactsHeuristic(messages) {
  const current_task = extractCurrentTask(messages);
  const active_files = extractActiveFiles(messages);
  const decisions = extractDecisions(messages);
  const blockers = extractBlockers(messages);
  const next_steps = extractNextSteps(messages);
  return { current_task, active_files, decisions, blockers, next_steps };
}
function extractCurrentTask(messages) {
  for (const msg of messages) {
    if (msg.info.role !== "user") continue;
    const text = getMessageText(msg);
    if (!text) continue;
    if (/^\s*<task|^\s*<summary|^\s*<task_result/.test(text)) continue;
    if (/^\s*[{[]/.test(text)) continue;
    const cleaned = stripCodeBlocks(text);
    const firstLine = cleaned.split("\n").find((l) => l.trim().length > 10);
    if (firstLine) {
      return firstLine.trim().slice(0, 200);
    }
  }
  return null;
}
function extractActiveFiles(messages) {
  const fileCounts = /* @__PURE__ */ new Map();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue;
      const toolName = part.tool;
      const input = part.state?.input || {};
      if (toolName === "read" || toolName === "edit" || toolName === "write" || toolName === "glob" || toolName === "grep" || toolName === "bash") {
        const paths = extractPaths(toolName, input);
        for (const p of paths) {
          const normalized = normalizePath(p);
          if (normalized) {
            fileCounts.set(normalized, (fileCounts.get(normalized) ?? 0) + 1);
          }
        }
      }
    }
  }
  const sorted = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return sorted.map(([path, count]) => ({
    path,
    reason: count > 1 ? `edited ${count} times` : "read once"
  }));
}
function normalizePath(p) {
  let path = p.replace(/^\.\//, "");
  if (path.includes("://")) return null;
  if (path.includes("github.com/")) return null;
  if (path.includes("raw.githubusercontent")) return null;
  if (path.startsWith("/dev/") || path.startsWith("/usr/") || path.startsWith("/bin/")) return null;
  if (path.startsWith("/lib/") || path.startsWith("/etc/") || path.startsWith("/proc/")) return null;
  if (path.startsWith("/sys/") || path.startsWith("/tmp/opencode")) return null;
  if (path.includes("opencode.db") || path.includes("opencode/log/")) return null;
  if (path.includes(".local/share/opencode")) return null;
  if (path.startsWith("node_modules")) return null;
  if (!/\.\w+$/.test(path)) {
    const sourcePrefixes = ["src/", "test/", "docs/", "lib/", "scripts/"];
    if (!sourcePrefixes.some((prefix) => path.startsWith(prefix))) {
      return null;
    }
  }
  if (!path.includes("/") && !path.startsWith("/")) return null;
  if (!path.includes("/") && !path.includes(".")) return null;
  return path;
}
function extractPaths(tool4, input) {
  const paths = [];
  for (const key of ["filePath", "path", "file"]) {
    const val = input[key];
    if (typeof val === "string" && val.length > 0) {
      paths.push(val);
    }
  }
  for (const key of ["paths", "query"]) {
    const val = input[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string" && item.length > 0) {
          paths.push(item);
        }
      }
    }
  }
  const pattern = input["pattern"];
  if (typeof pattern === "string" && pattern.length > 0) {
    if (pattern.includes("/") || pattern.includes(".")) {
      paths.push(pattern);
    }
  }
  if (tool4 === "bash") {
    const command = input["command"];
    if (typeof command === "string") {
      const pathMatches = command.matchAll(
        /(?:\.?\/)?(?:[\w-]+\/)+[\w.-]+\.\w+/g
      );
      for (const m of pathMatches) {
        const p = m[0];
        if (p.includes("://") || // URLs
        p.startsWith("node_modules") || p === "/dev/null" || p === "/dev/stdin" || p === "/dev/stdout" || p === "/dev/stderr" || p.startsWith("/usr/") || // system paths
        p.startsWith("/bin/") || p.startsWith("/lib/") || p.startsWith("/etc/") || p.startsWith("/proc/") || p.startsWith("/sys/") || p.startsWith("/tmp/opencode")) {
          continue;
        }
        paths.push(p);
      }
    }
  }
  return paths;
}
function extractDecisions(messages) {
  const allDecisions = [];
  const firstUser = messages.find((m) => m.info.role === "user");
  if (firstUser) {
    allDecisions.push(...scanTextForDecisions(stripCodeBlocks(getMessageText(firstUser))));
  }
  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      const text = stripCodeBlocks(getMessageText(msg));
      allDecisions.push(...scanTextForDecisions(text));
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const deduped = [];
  for (const d of allDecisions) {
    const normalized = d.topic.toLowerCase().trim().replace(/\s+/g, " ");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      deduped.push({
        topic: d.topic,
        decision: d.decision,
        rationale: d.rationale,
        foundational: d.foundational
      });
    }
  }
  return deduped;
}
function scanTextForDecisions(text) {
  if (!text || text.length === 0) return [];
  const decisions = [];
  const seenSentences = /* @__PURE__ */ new Set();
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) continue;
    if (trimmedSentence.startsWith("`") || trimmedSentence.startsWith(">") || trimmedSentence.startsWith("*") || trimmedSentence.startsWith("-")) {
      if (!/^(let's|we'll|we will|decision|decided|chose|picked|going with|go with|settle on|settled on)\b/i.test(trimmedSentence)) {
        continue;
      }
    }
    if (/\b(?:regex|pattern|heuristic|extraction|negation|keyword)\b/i.test(trimmedSentence)) {
      continue;
    }
    const allMatches = [...trimmedSentence.matchAll(
      new RegExp(DECISION_KEYWORD_RE.source, DECISION_KEYWORD_RE.flags.replace("i", "") + "gi")
    )];
    for (const match of allMatches) {
      const keywordIndex = match.index;
      const keywordText = match[0];
      const keywordEnd = keywordIndex + keywordText.length;
      const beforeText = trimmedSentence.slice(0, keywordIndex).trim();
      const beforeWords = beforeText.split(/\s+/);
      const lastThreeBefore = beforeWords.slice(-3).join(" ");
      if (NEGATION_WORDS_RE.test(lastThreeBefore)) {
        continue;
      }
      if (/not|never|don't|won't|avoid|skip|reject|against/i.test(keywordText)) {
        continue;
      }
      const afterText = trimmedSentence.slice(keywordEnd).trim();
      const afterWords = afterText.split(/\s+/);
      const firstThreeAfter = afterWords.slice(0, 3).join(" ");
      if (NEGATION_WORDS_RE.test(firstThreeAfter)) {
        continue;
      }
      const topic = extractTopicPhrase(afterText);
      if (!topic) continue;
      if (!isPlausibleTopic(topic.normalized)) continue;
      const foundational = FOUNDATIONAL_RE.test(trimmedSentence);
      const decision = trimmedSentence;
      if (!isPlausibleDecision(decision)) continue;
      const sentenceKey = decision.slice(0, 100);
      if (seenSentences.has(sentenceKey)) continue;
      seenSentences.add(sentenceKey);
      decisions.push({
        topic: topic.normalized,
        decision: decision.slice(0, 500),
        // cap decision text length
        foundational
      });
    }
  }
  return decisions;
}
function isPlausibleTopic(topic) {
  if (topic.length < 3) return false;
  if (!/^[a-z0-9\s-]+$/i.test(topic)) return false;
  const COMMON_WORDS = /* @__PURE__ */ new Set([
    "know",
    "go",
    "schema",
    "topics",
    "keywords",
    "regex",
    "pattern",
    "heuristic",
    "extraction",
    "negation",
    "keyword",
    "decision",
    "the",
    "this",
    "that",
    "what",
    "which",
    "how",
    "why",
    "when",
    "use",
    "using",
    "used",
    "set",
    "get",
    "put",
    "run",
    "try",
    "fix",
    "test",
    "code",
    "file",
    "data",
    "type",
    "name",
    "path",
    "line",
    "word",
    "text",
    "part",
    "step",
    "next",
    "last",
    "first",
    "new",
    "old",
    "add",
    "del",
    "mod",
    "put",
    "see",
    "say",
    "one",
    "two",
    "all",
    "any",
    "some",
    "each",
    "both"
  ]);
  if (COMMON_WORDS.has(topic.toLowerCase())) return false;
  return true;
}
function isPlausibleDecision(decision) {
  if (decision.includes('\\"') || decision.includes("\\\\")) return false;
  if (/"\w+":\s*"/.test(decision)) return false;
  if (decision.startsWith('"') || decision.startsWith("'")) return false;
  return true;
}
function extractTopicPhrase(afterKeyword) {
  let words = afterKeyword.trim().split(/\s+/);
  if (words.length === 0) return null;
  while (words.length > 0) {
    const first = words[0].toLowerCase();
    if (first === "to" || first === "the" || first === "a" || first === "an" || first === "that" || first === "use" || first === "using" || first === "go" || first === "with" || first === "build" || first === "set" || first === "up" || first === "start" || first === "create" || first === "implement" || first === "for" || first === "on" || first === "in" || first === "our") {
      words = words.slice(1);
    } else {
      break;
    }
  }
  if (words.length === 0) return null;
  const stopWords = /* @__PURE__ */ new Set([
    "is",
    "are",
    "was",
    "were",
    "be",
    "being",
    "been",
    "has",
    "have",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "shall",
    "should",
    "can",
    "could",
    "may",
    "might",
    "must",
    "to",
    "for",
    "with",
    "from",
    "by",
    "on",
    "in",
    "at",
    "that",
    "which",
    "who",
    "whom",
    "whose",
    "and",
    "or",
    "but",
    "nor",
    "so",
    "yet",
    "because",
    "since",
    "although",
    "though",
    "while",
    "if",
    "unless",
    "until",
    "when",
    "where",
    "as"
  ]);
  const topicWords = [];
  for (const word of words) {
    if (/[.!?;:]$/.test(word)) {
      const clean = word.replace(/[.!?;:]+$/, "");
      if (clean.length > 0 && !stopWords.has(clean.toLowerCase())) {
        topicWords.push(clean);
      }
      break;
    }
    if (stopWords.has(word.toLowerCase())) {
      break;
    }
    topicWords.push(word);
  }
  if (topicWords.length === 0) return null;
  const raw = topicWords.join(" ");
  let normalized = raw.toLowerCase().replace(/^(the|a|an|our)\s+/i, "").replace(/\s+/g, " ").trim();
  return { raw, normalized };
}
function extractBlockers(messages) {
  const lastAssistant = [...messages].reverse().find((m) => m.info.role === "assistant");
  if (!lastAssistant) return [];
  const text = getMessageText(lastAssistant);
  if (!text) return [];
  const blockers = [];
  const lines = text.split(/\n+/);
  for (const line of lines) {
    if (/blocked|can't|cannot|fails?|error|stuck|waiting on|depends on/i.test(line)) {
      blockers.push(line.trim().slice(0, 200));
    }
  }
  return blockers;
}
function extractNextSteps(messages) {
  const lastAssistant = [...messages].reverse().find((m) => m.info.role === "assistant");
  if (!lastAssistant) return [];
  const text = getMessageText(lastAssistant);
  if (!text) return [];
  const steps = [];
  const lines = text.split(/\n+/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\d+\.\s/.test(trimmed)) {
      steps.push(trimmed.slice(0, 200));
      continue;
    }
    if (/^(next|then|step|todo)[\s:]/i.test(trimmed)) {
      steps.push(trimmed.slice(0, 200));
      continue;
    }
  }
  return steps.slice(0, 5);
}
function getMessageText(msg) {
  return msg.parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}
function stripCodeBlocks(text) {
  let stripped = text.replace(/```[\s\S]*?```/g, "");
  stripped = stripped.replace(/`[^`]+`/g, "");
  stripped = stripped.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("}") || trimmed.startsWith('"') || trimmed.startsWith("[") || trimmed.startsWith("]")) {
      return false;
    }
    return true;
  }).join("\n");
  return stripped;
}
function markReferencedDecisions(mem, messages, sessionId) {
  let recalled = false;
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "recall_decision") {
        recalled = true;
        break;
      }
    }
    if (recalled) break;
  }
  if (recalled) {
    for (const d of mem.decisions) {
      if (d.still_valid) {
        d.last_used_in_session = sessionId;
      }
    }
  }
}
function normalizedFact(value) {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}
function makeProvenance(meta, evidence) {
  const llm = meta.origin === "llm";
  return {
    extractor: llm ? "llm" : "heuristic",
    source_session_id: meta.sessionId,
    ...llm && meta.auditSessionID ? { source_audit_session_id: meta.auditSessionID } : {},
    confidence: llm ? "llm-corroborated" : "heuristic",
    evidence: evidence.slice(0, 3)
  };
}
function heuristicEvidenceFor(value, candidates) {
  if (!candidates) return [];
  const needle = normalizedFact(value.decision ?? value.path ?? value.topic ?? "");
  const transcript = Object.values(candidates).find((candidate2) => candidate2.kind === "transcript" && typeof candidate2.text === "string" && normalizedFact(candidate2.text).includes(needle));
  if (transcript) {
    return [{ kind: transcript.kind, ref: transcript.ref, digest: transcript.digest }];
  }
  const kind = value.topic !== void 0 ? "decision" : value.path !== void 0 ? "active-file" : "current-task";
  const ref = heuristicCandidateRef(kind, value.topic !== void 0 ? { topic: value.topic, decision: value.decision } : value.path !== void 0 ? { path: value.path, reason: value.reason } : value.decision);
  const candidate = candidates[ref];
  return candidate ? [{ kind: candidate.kind, ref: candidate.ref, digest: candidate.digest }] : [];
}
function llmEvidenceFor(refs, meta) {
  if (!meta.evidenceCandidates) return null;
  const evidence = candidateEvidence(refs, meta.evidenceCandidates);
  return evidence.length > 0 ? evidence : null;
}
function mergeMemory(existing, extracted, meta) {
  const origin = meta.origin ?? "heuristic";
  let current_task = existing.current_task;
  let current_task_provenance = existing.current_task_provenance;
  if (extracted.current_task !== null) {
    const preserveHeuristicTask = origin === "llm" && Boolean(existing.current_task) && existing.current_task_provenance?.extractor === "heuristic";
    if (!preserveHeuristicTask) {
      current_task = extracted.current_task;
      const evidence = origin === "llm" ? meta.provenanceEvidence ?? firstCandidateEvidence(meta.evidenceCandidates ?? {}) : heuristicEvidenceFor({ decision: extracted.current_task }, meta.evidenceCandidates);
      current_task_provenance = makeProvenance(meta, evidence);
    }
  }
  const oldFileMap = new Map(existing.active_files.map((f) => [f.path, f]));
  const incomingFiles = extracted.active_files.map((f) => {
    const old = oldFileMap.get(f.path);
    const oldReason = old?.reason;
    const isGeneric = f.reason === "read once" || f.reason.startsWith("edited ");
    const evidence = origin === "llm" ? meta.provenanceEvidence ?? firstCandidateEvidence(meta.evidenceCandidates ?? {}) : heuristicEvidenceFor(f, meta.evidenceCandidates);
    return {
      path: f.path,
      reason: oldReason && isGeneric ? oldReason : f.reason,
      last_touched: origin === "llm" && old ? old.last_touched : meta.timestamp,
      provenance: origin === "llm" && old?.provenance?.extractor === "heuristic" ? old.provenance : makeProvenance(meta, evidence)
    };
  });
  const active_files = origin === "llm" ? [
    ...existing.active_files,
    ...incomingFiles.filter((file) => !oldFileMap.has(file.path))
  ] : incomingFiles;
  const existingDecisions = existing.decisions.map((d) => ({ ...d }));
  const existingTopicMap = /* @__PURE__ */ new Map();
  for (let i = 0; i < existingDecisions.length; i++) {
    const normalized = normalizedFact(existingDecisions[i].topic);
    existingTopicMap.set(normalized, i);
  }
  for (const newDec of extracted.decisions) {
    const normalizedTopic = normalizedFact(newDec.topic);
    const existingIdx = existingTopicMap.get(normalizedTopic);
    const evidence = origin === "llm" ? llmEvidenceFor(newDec.evidence_refs, meta) : heuristicEvidenceFor(newDec, meta.evidenceCandidates);
    if (origin === "llm" && !evidence) continue;
    const decision = {
      id: randomUUID(),
      topic: newDec.topic,
      decision: newDec.decision,
      rationale: newDec.rationale,
      timestamp: meta.timestamp,
      git_sha: meta.gitSha ?? void 0,
      session_id: meta.sessionId,
      still_valid: true,
      // Foundational status is human-reviewed state. Both model and heuristic
      // extraction may request it, but neither extraction path may promote it.
      foundational: false,
      foundational_requested: origin === "llm" ? Boolean(newDec.foundational) : Boolean(newDec.foundational) || Boolean(newDec.foundational_requested),
      provenance: makeProvenance(meta, evidence ?? [])
    };
    if (existingIdx !== void 0) {
      const old = existingDecisions[existingIdx];
      const oldIsHeuristic = old?.provenance?.extractor === "heuristic" || old?.provenance?.confidence === "heuristic";
      if (origin === "llm" && old?.still_valid && oldIsHeuristic) {
        decision.still_valid = normalizedFact(decision.decision) === normalizedFact(old.decision);
      } else if (typeof old?.id === "string") {
        old.still_valid = false;
      }
      existingDecisions.push(decision);
    } else {
      existingDecisions.push(decision);
    }
  }
  return {
    ...existing,
    version: 3,
    project_path: existing.project_path,
    last_updated: meta.timestamp,
    last_git_sha: meta.gitSha ?? existing.last_git_sha,
    last_session_id: meta.sessionId,
    current_task,
    current_task_provenance,
    active_files,
    decisions: existingDecisions,
    blockers: extracted.blockers,
    next_steps: extracted.next_steps,
    recent_sessions: existing.recent_sessions ?? []
  };
}
function recordRecentSession(mem, sessionId) {
  const recentSessions = [...new Set(mem.recent_sessions ?? [])];
  if (!recentSessions.includes(sessionId)) {
    recentSessions.push(sessionId);
  }
  return {
    ...mem,
    recent_sessions: recentSessions.slice(-10)
  };
}
var THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1e3;
var STALE_PENDING_AUDIT_AGE_MS = 2 * LLM_REQUEST_TIMEOUT_MS;
function removeOldestCompletedAudit(mem) {
  const audits = mem.llm_extraction_audits;
  if (!audits?.length) return false;
  let oldestIndex = -1;
  for (let index = 0; index < audits.length; index++) {
    const audit = audits[index];
    if (!audit || audit.terminal_outcome === "pending") continue;
    if (oldestIndex === -1) {
      oldestIndex = index;
      continue;
    }
    const oldest = audits[oldestIndex];
    if (oldest && audit.created_at.localeCompare(oldest.created_at) < 0) {
      oldestIndex = index;
    }
  }
  if (oldestIndex === -1) return false;
  audits.splice(oldestIndex, 1);
  return true;
}
function removeOldestCacheEntry(mem) {
  const entries = mem.llm_extraction_cache;
  if (!entries?.length) return false;
  let oldestIndex = 0;
  for (let index = 1; index < entries.length; index++) {
    const current = entries[index];
    const oldest = entries[oldestIndex];
    if (current && oldest && (current.completed_at.localeCompare(oldest.completed_at) < 0 || current.completed_at === oldest.completed_at && index < oldestIndex)) {
      oldestIndex = index;
    }
  }
  entries.splice(oldestIndex, 1);
  return true;
}
function removeOldestModelHealth(mem) {
  const records = mem.model_health;
  if (!records?.length) return false;
  let oldestIndex = 0;
  for (let index = 1; index < records.length; index++) {
    const current = records[index];
    const oldest = records[oldestIndex];
    if (current && oldest && ((current.last_outcome_at ?? "").localeCompare(oldest.last_outcome_at ?? "") < 0 || (current.last_outcome_at ?? "") === (oldest.last_outcome_at ?? "") && index < oldestIndex)) {
      oldestIndex = index;
    }
  }
  records.splice(oldestIndex, 1);
  return true;
}
function removeOldestRecentSession(mem) {
  if (!mem.recent_sessions?.length) return false;
  mem.recent_sessions.shift();
  return true;
}
function reclassifyStalePendingAudits(audits, now) {
  return audits.map((audit) => {
    const createdAt = new Date(audit.created_at).getTime();
    const stale = audit.terminal_outcome === "pending" && Number.isFinite(createdAt) && now - createdAt > STALE_PENDING_AUDIT_AGE_MS;
    return stale ? { ...audit, terminal_outcome: "failed" } : audit;
  });
}
function removeDisposableMetadata(mem) {
  if (removeOldestCompletedAudit(mem)) return true;
  if (removeOldestCacheEntry(mem)) return true;
  if (removeOldestModelHealth(mem)) return true;
  if (mem.llm_extraction_cache_quarantine) {
    delete mem.llm_extraction_cache_quarantine;
    return true;
  }
  return removeOldestRecentSession(mem);
}
function boundedModelHealth(memories) {
  if (memories.length <= MODEL_HEALTH_MAX_RECORDS) return memories;
  return memories.map((health, index) => ({ health, index })).sort((left, right) => (left.health.last_outcome_at ?? "").localeCompare(right.health.last_outcome_at ?? "") || left.index - right.index).slice(-MODEL_HEALTH_MAX_RECORDS).sort((left, right) => left.index - right.index).map(({ health }) => health);
}
function pruneOld(mem, client, now = Date.now()) {
  const cloned = {
    version: mem.version,
    project_path: mem.project_path,
    last_updated: mem.last_updated,
    last_git_sha: mem.last_git_sha,
    last_session_id: mem.last_session_id,
    current_task: mem.current_task,
    current_task_provenance: mem.current_task_provenance ? {
      ...mem.current_task_provenance,
      evidence: [...mem.current_task_provenance.evidence ?? []]
    } : void 0,
    active_files: mem.active_files.map((f) => ({ ...f })),
    decisions: mem.decisions.map((d) => ({ ...d })),
    blockers: [...mem.blockers],
    next_steps: [...mem.next_steps],
    recent_sessions: [...mem.recent_sessions ?? []],
    llm_extraction_cache: mem.llm_extraction_cache?.map((entry) => ({
      ...entry,
      facts: {
        ...entry.facts,
        active_files: entry.facts.active_files.map((file) => ({ ...file })),
        decisions: entry.facts.decisions.map((decision) => ({ ...decision })),
        blockers: [...entry.facts.blockers],
        next_steps: [...entry.facts.next_steps]
      }
    })),
    llm_extraction_audits: mem.llm_extraction_audits ? boundedAuditMetadata(reclassifyStalePendingAudits(
      mem.llm_extraction_audits.map((audit) => ({ ...audit })),
      now
    )) : void 0,
    model_health: mem.model_health ? boundedModelHealth(mem.model_health.map((health) => ({ ...health }))) : void 0,
    llm_extraction_cache_quarantine: mem.llm_extraction_cache_quarantine ? { ...mem.llm_extraction_cache_quarantine } : void 0
  };
  while (jsonSize(cloned) > MEMORY_MAX_BYTES && removeDisposableMetadata(cloned)) {
  }
  if (jsonSize(cloned) <= MEMORY_MAX_BYTES) return cloned;
  cloned.decisions = cloned.decisions.filter((d) => d.still_valid);
  if (jsonSize(cloned) <= MEMORY_MAX_BYTES) return cloned;
  cloned.active_files = [...cloned.active_files].sort((a, b) => b.last_touched.localeCompare(a.last_touched)).slice(0, 8);
  if (jsonSize(cloned) <= MEMORY_MAX_BYTES) return cloned;
  cloned.decisions = cloned.decisions.filter((d) => {
    const ts = new Date(d.timestamp).getTime();
    return now - ts < THIRTY_DAYS_MS;
  });
  if (jsonSize(cloned) <= MEMORY_MAX_BYTES) return cloned;
  if (cloned.current_task && cloned.current_task.length > 200) {
    cloned.current_task = cloned.current_task.slice(0, 200);
  }
  cloned.active_files = cloned.active_files.map((f) => ({
    ...f,
    reason: f.reason.length > 100 ? f.reason.slice(0, 100) : f.reason
  }));
  if (jsonSize(cloned) <= MEMORY_MAX_BYTES) return cloned;
  cloned.decisions = [...cloned.decisions].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 10);
  if (jsonSize(cloned) <= MEMORY_MAX_BYTES) {
    void log(client, "warn", "tokenmaxxer: pruned decisions to 10 most recent to fit 8KB cap");
    return cloned;
  }
  cloned.decisions = [...cloned.decisions].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5);
  cloned.active_files = [];
  cloned.blockers = [];
  cloned.next_steps = [];
  if (jsonSize(cloned) > MEMORY_MAX_BYTES) {
    void log(client, "error", "tokenmaxxer: STILL over 8KB after all pruning \u2014 truncating to current_task + 5 decisions");
  }
  return cloned;
}
function jsonSize(mem) {
  return memorySizeBytes(mem);
}
async function generateHeader(worktree, directory, mem) {
  const project = resolveProjectPath(worktree, directory);
  const headerPath = join3(project, ".opencode", "memory", "HEADER.md");
  const content = `<!-- tokenmaxxer project memory header \u2014 auto-generated, do not edit -->
# Project: ${mem.project_path}
Last session: ${mem.last_updated} (git SHA ${mem.last_git_sha ?? "unknown"})
Current task: ${mem.current_task ?? "\u2014"}
This project has accumulated memory. Call the \`get_project_state\` tool to load prior decisions, active files, and next steps before assuming continuity.
`;
  await atomicWrite(headerPath, content);
}

// src/tools/recall.ts
import { tool } from "@opencode-ai/plugin";

// src/memory/reader.ts
function provenanceLabel(value) {
  const provenance = value.provenance;
  if (!provenance) return "source=unknown confidence=unknown evidence=0";
  return [
    `source=${provenance.source_session_id}`,
    ...provenance.source_audit_session_id ? [`audit=${provenance.source_audit_session_id}`] : [],
    `confidence=${provenance.confidence}`,
    `evidence=${provenance.evidence?.length ?? 0}`
  ].join(" ");
}
function formatDecisionProvenance(decision) {
  return provenanceLabel(decision);
}
function formatActiveFileProvenance(file) {
  return provenanceLabel(file);
}
function queryDecisions(mem, query, limit) {
  const valid = mem.decisions.filter((d) => d.still_valid);
  if (!query || query.trim().length === 0) {
    return [...valid].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
  }
  const q = query.toLowerCase().trim();
  return valid.filter((d) => d.topic.toLowerCase().includes(q)).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}
function getActiveFiles(mem) {
  return mem.active_files;
}
function getProjectState(mem) {
  const validDecisions = mem.decisions.filter((d) => d.still_valid);
  return [
    `Project: ${mem.project_path}`,
    `Last: ${mem.last_updated} (SHA ${mem.last_git_sha ?? "?"})`,
    `Task: ${mem.current_task ?? "\u2014"}${mem.current_task_provenance ? ` (source=${mem.current_task_provenance.source_session_id} confidence=${mem.current_task_provenance.confidence} evidence=${mem.current_task_provenance.evidence?.length ?? 0})` : ""}`,
    `Active files: ${mem.active_files.map((f) => `${f.path} [${formatActiveFileProvenance(f)}]`).join(", ") || "none"}`,
    `Decisions: ${validDecisions.map((d) => `${d.topic} [${formatDecisionProvenance(d)}]`).join(", ") || "none"}`,
    `Blockers: ${mem.blockers.join("; ") || "none"}`,
    `Next: ${mem.next_steps.join("; ") || "none"}`
  ].join("\n");
}

// src/tools/recall.ts
function decisionProvenanceLabel(value) {
  const provenance = value.provenance;
  if (!provenance) return "";
  return `source=${provenance.source_session_id}${provenance.source_audit_session_id ? ` audit=${provenance.source_audit_session_id}` : ""} confidence=${provenance.confidence} evidence=${provenance.evidence?.length ?? 0}`;
}
async function _recallDecision(args, context) {
  try {
    const mem = await readMemory({ worktree: context.worktree, directory: context.directory });
    if (!mem) return "No project memory yet.";
    const hits = queryDecisions(mem, args.query, args.limit);
    const prefix = `Project: ${mem.project_path}
`;
    if (!hits.length) return `${prefix}No valid decisions matching "${args.query}".`;
    return prefix + hits.map((d) => `${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${d.timestamp})${d.provenance ? ` [${decisionProvenanceLabel(d)}]` : ""}`).join("\n");
  } catch (e) {
    return `Error recalling decisions: ${String(e)}`;
  }
}
async function _getActiveFiles(_args, context) {
  try {
    const mem = await readMemory({ worktree: context.worktree, directory: context.directory });
    if (!mem) return "No active files recorded.";
    const active = getActiveFiles(mem);
    if (!active.length) return "No active files recorded.";
    return `Project: ${mem.project_path}
` + active.map((f) => `${f.path} \u2014 ${f.reason}${f.provenance ? ` [${decisionProvenanceLabel(f)}]` : ""}`).join("\n");
  } catch (e) {
    return `Error getting active files: ${String(e)}`;
  }
}
async function _getProjectState(_args, context) {
  try {
    const mem = await readMemory({ worktree: context.worktree, directory: context.directory });
    if (!mem) return "No project memory. This looks like a fresh start.";
    return getProjectState(mem);
  } catch (e) {
    return `Error getting project state: ${String(e)}`;
  }
}
async function _recallPromote(args, context) {
  try {
    const project = typeof resolveProjectPath === "function" ? resolveProjectPath(context.worktree, context.directory) : context.worktree && context.worktree !== "/" ? context.worktree : context.directory;
    const operationKey = `recall-promote:${args.topic.trim().toLowerCase().slice(0, 256)}`;
    return await enqueueProjectJob(project, operationKey, async () => {
      const mem = await readMemory({ worktree: context.worktree, directory: context.directory });
      if (!mem) return "No project memory.";
      const d = mem.decisions.find(
        (d2) => d2.topic.toLowerCase() === args.topic.toLowerCase()
      );
      if (!d) return `No decision with topic "${args.topic}".`;
      d.foundational = true;
      d.foundational_requested = false;
      const reviewSession = context.sessionID ?? context.sessionId ?? d.session_id ?? "human-review";
      d.provenance = {
        ...d.provenance ?? {
          extractor: "legacy",
          source_session_id: d.session_id || "legacy",
          confidence: "legacy",
          evidence: []
        },
        extractor: "human",
        source_session_id: reviewSession,
        confidence: "human-reviewed"
      };
      const persisted = await writeMemory({ worktree: context.worktree, directory: context.directory }, mem);
      if (persisted === false) return "Promotion was not persisted.";
      return `Promoted: ${d.topic}: ${d.decision}${d.provenance ? ` [${decisionProvenanceLabel(d)}]` : ""}`;
    });
  } catch (e) {
    return `Error promoting decision: ${String(e)}`;
  }
}
function registerTools(_ctx) {
  return {
    tool: {
      recall_decision: tool({
        description: "Recall a prior decision for this project. CALL THIS before assuming continuity with a previous session. Returns the decision and its date/git-SHA so you can judge staleness.",
        args: {
          query: tool.schema.string().optional().describe("topic or keyword. Omit to get most recent decisions."),
          limit: tool.schema.number().default(10).describe("max results")
        },
        async execute(args, context) {
          return _recallDecision(args, context);
        }
      }),
      get_active_files: tool({
        description: "List files actively being worked on in this project, with why each matters. Use to avoid re-discovering them.",
        args: {},
        async execute(args, context) {
          return _getActiveFiles(args, context);
        }
      }),
      get_project_state: tool({
        description: "Full project memory header: current task, active files, valid decisions, blockers, next steps. Call once at session start if resuming work.",
        args: {},
        async execute(args, context) {
          return _getProjectState(args, context);
        }
      }),
      recall_promote: tool({
        description: "Mark a decision as foundational \u2014 it will always be included in compaction context. Use for architecture-level decisions that should never be forgotten.",
        args: {
          topic: tool.schema.string().describe("exact topic of the decision to promote")
        },
        async execute(args, context) {
          return _recallPromote(args, context);
        }
      })
    }
  };
}

// src/tools/efficiency.ts
import { tool as tool2 } from "@opencode-ai/plugin";
async function _previewCompaction(_args, context) {
  try {
    return await buildDurableBlock({
      worktree: context.worktree,
      directory: context.directory,
      client: context.client
    });
  } catch (e) {
    return `Error previewing compaction: ${String(e)}`;
  }
}
async function _headFiles(args, context) {
  const out = [];
  for (const p of args.paths) {
    try {
      const content = (await context.client.file.read({ query: { path: p } })).data?.content ?? "";
      if (!content) {
        out.push(`### ${p}
(empty or not found)`);
        continue;
      }
      const allLines = content.split("\n");
      const head = allLines.slice(0, args.lines).join("\n");
      out.push(
        `### ${p}
${head}${allLines.length > args.lines ? "\n...(truncated)" : ""}`
      );
    } catch (e) {
      out.push(`### ${p}
(error: ${e})`);
    }
  }
  return out.join("\n\n");
}
function registerEfficiencyTools() {
  return {
    tool: {
      preview_compaction: tool2({
        description: "Preview the durable-state block that would be injected at the next compaction. Call when context is getting large to see what would survive before compaction fires.",
        args: {},
        async execute(_args, context) {
          return _previewCompaction(
            _args,
            {
              worktree: context.worktree,
              directory: context.directory,
              client: context.client
            }
          );
        }
      }),
      head_files: tool2({
        description: "Read the first N lines of each file. Use instead of calling `read` on large files when you only need to see the top (imports, exports, config). Call `read` on the full file if you need more.",
        args: {
          paths: tool2.schema.array(tool2.schema.string()).describe("File paths, relative to worktree."),
          lines: tool2.schema.number().default(40).describe("Lines to return per file")
        },
        async execute(args, context) {
          return _headFiles(args, {
            worktree: context.worktree,
            directory: context.directory,
            client: context.client
          });
        }
      })
    }
  };
}

// src/tools/status.ts
import { tool as tool3 } from "@opencode-ai/plugin";
import { join as join4 } from "path";
var lastCompactionTimestamp = null;
function setLastCompaction(ts) {
  lastCompactionTimestamp = ts;
}
async function _tokenmaxxerStatus(_args, context) {
  try {
    const mem = await readMemory({
      worktree: context.worktree,
      directory: context.directory
    });
    const project = resolveProjectPath(context.worktree, context.directory);
    const path = join4(project, ".opencode", "memory", "STATE.json");
    const content = await safeRead(path);
    const size = content === null ? 0 : Buffer.byteLength(content, "utf8");
    const queue = getProjectQueueStatus(project);
    const evidenceStats = getLLMEvidenceStats();
    const decisions = mem?.decisions ?? [];
    const legacyFacts = decisions.filter((d) => d.provenance?.confidence === "legacy").length + (mem?.active_files.filter((f) => f.provenance?.confidence === "legacy").length ?? 0) + (mem?.current_task_provenance?.confidence === "legacy" ? 1 : 0);
    const quarantined = mem?.llm_extraction_cache_quarantine?.count ?? 0;
    const resolution = getLastLLMModelResolution();
    const selectedHealth = [...mem?.model_health ?? []].reverse()[0];
    const selectedModel = selectedHealth ? `${selectedHealth.provider_id}/${selectedHealth.model_id}` : "none";
    const provenanceSummary = mem ? [
      mem.current_task_provenance ? `task source=${mem.current_task_provenance.source_session_id} confidence=${mem.current_task_provenance.confidence} evidence=${mem.current_task_provenance.evidence?.length ?? 0}` : "task source=unknown confidence=unknown evidence=0",
      ...mem.active_files.slice(0, 3).map((file) => `file:${file.path} source=${file.provenance?.source_session_id ?? "unknown"} confidence=${file.provenance?.confidence ?? "unknown"} evidence=${file.provenance?.evidence?.length ?? 0}`),
      ...mem.decisions.slice(0, 3).map((decision) => `decision:${decision.topic} source=${decision.provenance?.source_session_id ?? "unknown"}${decision.provenance?.source_audit_session_id ? ` audit=${decision.provenance.source_audit_session_id}` : ""} confidence=${decision.provenance?.confidence ?? "unknown"} evidence=${decision.provenance?.evidence?.length ?? 0}`)
    ].join("; ") : "none";
    return [
      `Project: ${mem?.project_path ?? "none"}`,
      `Memory file: ${path} (${size} bytes)`,
      `Decisions: ${mem?.decisions.length ?? 0} (${mem?.decisions.filter((d) => d.still_valid).length ?? 0} valid)`,
      `Active files: ${mem?.active_files.length ?? 0}`,
      `Last updated: ${mem?.last_updated ?? "never"}`,
      `Last git SHA: ${mem?.last_git_sha ?? "unknown"}`,
      `Last compaction: ${lastCompactionTimestamp ?? "none"}`,
      `Queue depth: ${queue.queueDepth}`,
      `In-flight: ${queue.inFlight}`,
      `Last idle outcome: ${queue.lastOutcome ?? "none"}`,
      `LLM evidence (process-wide): ${evidenceStats.accepted} accepted, ${evidenceStats.rejected} rejected`,
      `Legacy facts: ${legacyFacts}`,
      `Quarantined cache rows: ${quarantined}`,
      `LLM candidates (process-wide): ${resolution.candidate_count}`,
      `LLM selected: ${selectedModel} (${selectedHealth ? "durable-health" : "none"})`,
      `LLM variant (process-wide): ${resolution.variant ?? "none"}`,
      `LLM health: ${selectedHealth?.last_outcome ?? "none"} cooldown=${selectedHealth?.cooldown_until ?? "none"} reason=${selectedHealth?.failure_reason ?? "none"}`,
      `Provenance: ${provenanceSummary}`
    ].join("\n");
  } catch (e) {
    return `Error checking status: ${String(e)}`;
  }
}
function registerStatusTools() {
  return {
    tool: {
      tokenmaxxer_status: tool3({
        description: "Check tokenmaxxer plugin health: memory file path, size, decision count, last write, last compaction.",
        args: {},
        async execute(_args, context) {
          return _tokenmaxxerStatus(_args, context);
        }
      })
    }
  };
}

// src/index.ts
import { join as join5 } from "path";
var TokenmaxxerPlugin = async (ctx) => {
  const { client, directory, worktree } = ctx;
  const options = loadOptions(ctx);
  const project = resolveProjectPath(worktree, directory);
  try {
    const headerPath = join5(project, ".opencode", "memory", "HEADER.md");
    if (await safeRead(headerPath) === null) {
      await atomicWrite(
        headerPath,
        "<!-- tokenmaxxer: no prior memory yet. This file will be populated after your first session. -->\n"
      );
    }
  } catch {
  }
  return {
    // Layer 1: compaction-quality hook
    "experimental.session.compacting": async (input, output) => {
      try {
        const durable = await buildDurableBlock({ worktree, directory, client });
        if (options.compactionPrompt) {
          output.prompt = buildCompactionPrompt(durable);
        } else {
          output.context.push(durable);
        }
        setLastCompaction((/* @__PURE__ */ new Date()).toISOString());
        await log(client, "info", "compaction hook fired", {
          session: input.sessionID,
          promptReplaced: options.compactionPrompt,
          durableLength: durable.length
        });
        try {
          const logPath = join5(project, ".opencode", "memory", "last_compaction.log");
          const snapshot = `[${(/* @__PURE__ */ new Date()).toISOString()}] session=${input.sessionID}
${output.prompt ?? "(durable via context)"}
---
`;
          await atomicWrite(logPath, snapshot);
        } catch {
        }
      } catch (e) {
        await log(client, "error", "compaction hook failed", { error: String(e) });
      }
    },
    // Layer 2: event handlers
    event: async ({ event }) => {
      try {
        if (event.type === "session.idle") {
          const sessionId = event.properties?.sessionID;
          if (!sessionId) {
            await log(client, "warn", "session.idle missing sessionID");
            return;
          }
          if (isRetainedExtractionSession(sessionId)) return;
          if (await isPersistedRetainedExtractionSession({
            sessionID: sessionId,
            worktree,
            directory
          })) return;
          await writeMemoryOnIdle({ client, worktree, directory, sessionId });
        }
      } catch (e) {
        await log(client, "error", "event handler failed", { type: event.type, error: String(e) });
      }
    },
    // Layer 2: custom tools (recall + efficiency + status)
    ...registerTools(ctx),
    ...registerEfficiencyTools(),
    ...registerStatusTools()
  };
};
var index_default = TokenmaxxerPlugin;
export {
  TokenmaxxerPlugin,
  index_default as default
};
