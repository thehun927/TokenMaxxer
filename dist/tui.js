// node_modules/solid-js/dist/server.js
var ERROR = /* @__PURE__ */ Symbol("error");
function castError(err) {
  if (err instanceof Error) return err;
  return new Error(typeof err === "string" ? err : "Unknown error", {
    cause: err
  });
}
function handleError(err, owner = Owner) {
  const fns = owner && owner.context && owner.context[ERROR];
  const error = castError(err);
  if (!fns) throw error;
  try {
    for (const f of fns) f(error);
  } catch (e) {
    handleError(e, owner && owner.owner || null);
  }
}
var Owner = null;
function createOwner() {
  const o = {
    owner: Owner,
    context: Owner ? Owner.context : null,
    owned: null,
    cleanups: null
  };
  if (Owner) {
    if (!Owner.owned) Owner.owned = [o];
    else Owner.owned.push(o);
  }
  return o;
}
function createSignal(value, options) {
  return [() => value, (v) => {
    return value = typeof v === "function" ? v(value) : v;
  }];
}
function createMemo(fn, value) {
  Owner = createOwner();
  let v;
  try {
    v = fn(value);
  } catch (err) {
    handleError(err);
  } finally {
    Owner = Owner.owner;
  }
  return () => v;
}
function onCleanup(fn) {
  if (Owner) {
    if (!Owner.cleanups) Owner.cleanups = [fn];
    else Owner.cleanups.push(fn);
  }
  return fn;
}
function createContext(defaultValue) {
  const id = /* @__PURE__ */ Symbol("context");
  return {
    id,
    Provider: createProvider(id),
    defaultValue
  };
}
function children(fn) {
  const memo = createMemo(() => resolveChildren(fn()));
  memo.toArray = () => {
    const c = memo();
    return Array.isArray(c) ? c : c != null ? [c] : [];
  };
  return memo;
}
function resolveChildren(children2) {
  if (typeof children2 === "function" && !children2.length) return resolveChildren(children2());
  if (Array.isArray(children2)) {
    const results = [];
    for (let i = 0; i < children2.length; i++) {
      const result = resolveChildren(children2[i]);
      Array.isArray(result) ? results.push.apply(results, result) : results.push(result);
    }
    return results;
  }
  return children2;
}
function createProvider(id) {
  return function provider(props) {
    return createMemo(() => {
      Owner.context = {
        ...Owner.context,
        [id]: props.value
      };
      return children(() => props.children);
    });
  };
}
var SuspenseContext = createContext();

// src/memory/activity-state.ts
import { unlink } from "fs/promises";
import { join } from "path";

// src/util/fs.ts
import { mkdir, writeFile, readFile, rename, stat } from "fs/promises";
import { dirname } from "path";
async function safeRead(path) {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

// src/memory/activity-state.ts
var MEMORY_ACTIVITY_STALE_MS = 8e3;
var ACTIVITY_FILE = ".opencode/.tokenmaxxer-memory-activity";
function memoryActivityPath(project) {
  return join(project, ACTIVITY_FILE);
}
async function removeMarker(project) {
  await unlink(memoryActivityPath(project)).catch(() => {
  });
}
async function isMemoryActivityFresh(project, now = Date.now()) {
  let parsed;
  try {
    const raw = await safeRead(memoryActivityPath(project));
    if (!raw) return false;
    parsed = JSON.parse(raw);
  } catch {
    await removeMarker(project);
    return false;
  }
  const updatedAt = parsed?.updated_at;
  const fresh = typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt <= now && now - updatedAt <= MEMORY_ACTIVITY_STALE_MS;
  if (!fresh) await removeMarker(project);
  return fresh;
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

// src/memory/store.ts
import { join as join2 } from "path";
import { createHash } from "crypto";
import { homedir } from "os";
function resolveProjectPath(worktree, directory) {
  if (!worktree || worktree === "/" || worktree === "") {
    return directory;
  }
  return worktree;
}

// src/tui.tsx
import { Fragment, jsx, jsxs } from "@opentui/solid/jsx-runtime";
var POLL_MS = 1e3;
var BLINK_MS = 650;
var OPTIMISTIC_DWELL_MS = 1500;
function projectFromState(path) {
  if (typeof path?.directory !== "string" || !path.directory) return null;
  if (typeof path.worktree !== "string") return path.directory;
  return resolveProjectPath(path.worktree, path.directory);
}
var tui = async (api) => {
  api.slots.register({
    slots: {
      session_prompt_right: (_context, { session_id }) => {
        const [active, setActive] = createSignal(false);
        const [blink, setBlink] = createSignal(true);
        const project = projectFromState(api.state.path);
        let optimisticUntil = 0;
        let optimisticTimer;
        const poll = () => {
          if (!project) return void setActive(false);
          void isMemoryActivityFresh(project).then((durableActive) => {
            setActive(durableActive || optimisticUntil > Date.now());
          }).catch(() => {
            setActive(optimisticUntil > Date.now());
          });
        };
        const stopOptimisticActivity = () => {
          optimisticTimer = void 0;
          poll();
        };
        const unsubscribe = project ? api.event.on("session.idle", (event) => {
          if (event.properties.sessionID !== session_id) return;
          optimisticUntil = Date.now() + OPTIMISTIC_DWELL_MS;
          setActive(true);
          if (optimisticTimer) clearTimeout(optimisticTimer);
          optimisticTimer = setTimeout(stopOptimisticActivity, OPTIMISTIC_DWELL_MS);
        }) : void 0;
        poll();
        const pollTimer = setInterval(poll, POLL_MS);
        const blinkTimer = setInterval(() => setBlink((value) => !value), BLINK_MS);
        onCleanup(() => {
          clearInterval(pollTimer);
          clearInterval(blinkTimer);
          if (optimisticTimer) clearTimeout(optimisticTimer);
          unsubscribe?.();
        });
        return /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx("text", { fg: active() && blink() ? api.theme.current.success : api.theme.current.textMuted, children: "\u25CF" }),
          /* @__PURE__ */ jsx("text", { fg: api.theme.current.textMuted, children: " memory" })
        ] });
      }
    }
  });
};
var TuiPluginModule = {
  id: "tokenmaxxer.tui",
  tui
};
var tui_default = TuiPluginModule;
export {
  tui_default as default
};
