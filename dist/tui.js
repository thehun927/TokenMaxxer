// @bun
// src/tui.tsx
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";

// node_modules/solid-js/dist/server.js
var IS_DEV = false;
var equalFn = (a, b) => a === b;
var $PROXY = Symbol("solid-proxy");
var $TRACK = Symbol("solid-track");
var $DEVCOMP = Symbol("solid-dev-component");
var signalOptions = {
  equals: equalFn
};
var ERROR = null;
var runEffects = runQueue;
var STALE = 1;
var PENDING = 2;
var Owner = null;
var Transition = null;
var Scheduler = null;
var ExternalSourceConfig = null;
var Listener = null;
var Updates = null;
var Effects = null;
var ExecCount = 0;
function createSignal(value, options) {
  options = options ? Object.assign({}, signalOptions, options) : signalOptions;
  const s = {
    value,
    observers: null,
    observerSlots: null,
    comparator: options.equals || undefined
  };
  const setter = (value2) => {
    if (typeof value2 === "function") {
      if (Transition && Transition.running && Transition.sources.has(s))
        value2 = value2(s.tValue);
      else
        value2 = value2(s.value);
    }
    return writeSignal(s, value2);
  };
  return [readSignal.bind(s), setter];
}
function untrack(fn) {
  if (!ExternalSourceConfig && Listener === null)
    return fn();
  const listener = Listener;
  Listener = null;
  try {
    if (ExternalSourceConfig)
      return ExternalSourceConfig.untrack(fn);
    return fn();
  } finally {
    Listener = listener;
  }
}
function onCleanup(fn) {
  if (Owner === null)
    ;
  else if (Owner.cleanups === null)
    Owner.cleanups = [fn];
  else
    Owner.cleanups.push(fn);
  return fn;
}
var [transPending, setTransPending] = /* @__PURE__ */ createSignal(false);
function readSignal() {
  const runningTransition = Transition && Transition.running;
  if (this.sources && (runningTransition ? this.tState : this.state)) {
    if ((runningTransition ? this.tState : this.state) === STALE)
      updateComputation(this);
    else {
      const updates = Updates;
      Updates = null;
      runUpdates(() => lookUpstream(this), false);
      Updates = updates;
    }
  }
  if (Listener) {
    const sSlot = this.observers ? this.observers.length : 0;
    if (!Listener.sources) {
      Listener.sources = [this];
      Listener.sourceSlots = [sSlot];
    } else {
      Listener.sources.push(this);
      Listener.sourceSlots.push(sSlot);
    }
    if (!this.observers) {
      this.observers = [Listener];
      this.observerSlots = [Listener.sources.length - 1];
    } else {
      this.observers.push(Listener);
      this.observerSlots.push(Listener.sources.length - 1);
    }
  }
  if (runningTransition && Transition.sources.has(this))
    return this.tValue;
  return this.value;
}
function writeSignal(node, value, isComp) {
  let current = Transition && Transition.running && Transition.sources.has(node) ? node.tValue : node.value;
  if (!node.comparator || !node.comparator(current, value)) {
    if (Transition) {
      const TransitionRunning = Transition.running;
      if (TransitionRunning || !isComp && Transition.sources.has(node)) {
        Transition.sources.add(node);
        node.tValue = value;
      }
      if (!TransitionRunning)
        node.value = value;
    } else
      node.value = value;
    if (node.observers && node.observers.length) {
      runUpdates(() => {
        for (let i = 0;i < node.observers.length; i += 1) {
          const o = node.observers[i];
          const TransitionRunning = Transition && Transition.running;
          if (TransitionRunning && Transition.disposed.has(o))
            continue;
          if (TransitionRunning ? !o.tState : !o.state) {
            if (o.pure)
              Updates.push(o);
            else
              Effects.push(o);
            if (o.observers)
              markDownstream(o);
          }
          if (!TransitionRunning)
            o.state = STALE;
          else
            o.tState = STALE;
        }
        if (Updates.length > 1e6) {
          Updates = [];
          if (IS_DEV)
            ;
          throw new Error;
        }
      }, false);
    }
  }
  return value;
}
function updateComputation(node) {
  if (!node.fn)
    return;
  cleanNode(node);
  const time = ExecCount;
  runComputation(node, Transition && Transition.running && Transition.sources.has(node) ? node.tValue : node.value, time);
  if (Transition && !Transition.running && Transition.sources.has(node)) {
    queueMicrotask(() => {
      runUpdates(() => {
        Transition && (Transition.running = true);
        Listener = Owner = node;
        runComputation(node, node.tValue, time);
        Listener = Owner = null;
      }, false);
    });
  }
}
function runComputation(node, value, time) {
  let nextValue;
  const owner = Owner, listener = Listener;
  Listener = Owner = node;
  try {
    nextValue = node.fn(value);
  } catch (err) {
    if (node.pure) {
      if (Transition && Transition.running) {
        node.tState = STALE;
        node.tOwned && node.tOwned.forEach(cleanNode);
        node.tOwned = undefined;
      } else {
        node.state = STALE;
        node.owned && node.owned.forEach(cleanNode);
        node.owned = null;
      }
    }
    node.updatedAt = time + 1;
    return handleError(err);
  } finally {
    Listener = listener;
    Owner = owner;
  }
  if (!node.updatedAt || node.updatedAt <= time) {
    if (node.updatedAt != null && "observers" in node) {
      writeSignal(node, nextValue, true);
    } else if (Transition && Transition.running && node.pure) {
      if (!Transition.sources.has(node))
        node.value = nextValue;
      Transition.sources.add(node);
      node.tValue = nextValue;
    } else
      node.value = nextValue;
    node.updatedAt = time;
  }
}
function runTop(node) {
  const runningTransition = Transition && Transition.running;
  if ((runningTransition ? node.tState : node.state) === 0)
    return;
  if ((runningTransition ? node.tState : node.state) === PENDING)
    return lookUpstream(node);
  if (node.suspense && untrack(node.suspense.inFallback))
    return node.suspense.effects.push(node);
  const ancestors = [node];
  while ((node = node.owner) && (!node.updatedAt || node.updatedAt < ExecCount)) {
    if (runningTransition && Transition.disposed.has(node))
      return;
    if (runningTransition ? node.tState : node.state)
      ancestors.push(node);
  }
  for (let i = ancestors.length - 1;i >= 0; i--) {
    node = ancestors[i];
    if (runningTransition) {
      let top = node, prev = ancestors[i + 1];
      while ((top = top.owner) && top !== prev) {
        if (Transition.disposed.has(top))
          return;
      }
    }
    if ((runningTransition ? node.tState : node.state) === STALE) {
      updateComputation(node);
    } else if ((runningTransition ? node.tState : node.state) === PENDING) {
      const updates = Updates;
      Updates = null;
      runUpdates(() => lookUpstream(node, ancestors[0]), false);
      Updates = updates;
    }
  }
}
function runUpdates(fn, init) {
  if (Updates)
    return fn();
  let wait = false;
  if (!init)
    Updates = [];
  if (Effects)
    wait = true;
  else
    Effects = [];
  ExecCount++;
  try {
    const res = fn();
    completeUpdates(wait);
    return res;
  } catch (err) {
    if (!wait)
      Effects = null;
    Updates = null;
    handleError(err);
  }
}
function completeUpdates(wait) {
  if (Updates) {
    if (Scheduler && Transition && Transition.running)
      scheduleQueue(Updates);
    else
      runQueue(Updates);
    Updates = null;
  }
  if (wait)
    return;
  let res;
  if (Transition) {
    if (!Transition.promises.size && !Transition.queue.size) {
      const sources = Transition.sources;
      const disposed = Transition.disposed;
      Effects.push.apply(Effects, Transition.effects);
      res = Transition.resolve;
      for (const e2 of Effects) {
        "tState" in e2 && (e2.state = e2.tState);
        delete e2.tState;
      }
      Transition = null;
      runUpdates(() => {
        for (const d of disposed)
          cleanNode(d);
        for (const v of sources) {
          v.value = v.tValue;
          if (v.owned) {
            for (let i = 0, len = v.owned.length;i < len; i++)
              cleanNode(v.owned[i]);
          }
          if (v.tOwned)
            v.owned = v.tOwned;
          delete v.tValue;
          delete v.tOwned;
          v.tState = 0;
        }
        setTransPending(false);
      }, false);
    } else if (Transition.running) {
      Transition.running = false;
      Transition.effects.push.apply(Transition.effects, Effects);
      Effects = null;
      setTransPending(true);
      return;
    }
  }
  const e = Effects;
  Effects = null;
  if (e.length)
    runUpdates(() => runEffects(e), false);
  if (res)
    res();
}
function runQueue(queue) {
  for (let i = 0;i < queue.length; i++)
    runTop(queue[i]);
}
function scheduleQueue(queue) {
  for (let i = 0;i < queue.length; i++) {
    const item = queue[i];
    const tasks = Transition.queue;
    if (!tasks.has(item)) {
      tasks.add(item);
      Scheduler(() => {
        tasks.delete(item);
        runUpdates(() => {
          Transition.running = true;
          runTop(item);
        }, false);
        Transition && (Transition.running = false);
      });
    }
  }
}
function lookUpstream(node, ignore) {
  const runningTransition = Transition && Transition.running;
  if (runningTransition)
    node.tState = 0;
  else
    node.state = 0;
  for (let i = 0;i < node.sources.length; i += 1) {
    const source = node.sources[i];
    if (source.sources) {
      const state = runningTransition ? source.tState : source.state;
      if (state === STALE) {
        if (source !== ignore && (!source.updatedAt || source.updatedAt < ExecCount))
          runTop(source);
      } else if (state === PENDING)
        lookUpstream(source, ignore);
    }
  }
}
function markDownstream(node) {
  const runningTransition = Transition && Transition.running;
  for (let i = 0;i < node.observers.length; i += 1) {
    const o = node.observers[i];
    if (runningTransition ? !o.tState : !o.state) {
      if (runningTransition)
        o.tState = PENDING;
      else
        o.state = PENDING;
      if (o.pure)
        Updates.push(o);
      else
        Effects.push(o);
      o.observers && markDownstream(o);
    }
  }
}
function cleanNode(node) {
  let i;
  if (node.sources) {
    while (node.sources.length) {
      const source = node.sources.pop(), index = node.sourceSlots.pop(), obs = source.observers;
      if (obs && obs.length) {
        const n = obs.pop(), s = source.observerSlots.pop();
        if (index < obs.length) {
          n.sourceSlots[s] = index;
          obs[index] = n;
          source.observerSlots[index] = s;
        }
      }
    }
  }
  if (node.tOwned) {
    for (i = node.tOwned.length - 1;i >= 0; i--)
      cleanNode(node.tOwned[i]);
    delete node.tOwned;
  }
  if (Transition && Transition.running && node.pure) {
    reset(node, true);
  } else if (node.owned) {
    for (i = node.owned.length - 1;i >= 0; i--)
      cleanNode(node.owned[i]);
    node.owned = null;
  }
  if (node.cleanups) {
    for (i = node.cleanups.length - 1;i >= 0; i--)
      node.cleanups[i]();
    node.cleanups = null;
  }
  if (Transition && Transition.running)
    node.tState = 0;
  else
    node.state = 0;
}
function reset(node, top) {
  if (!top) {
    node.tState = 0;
    Transition.disposed.add(node);
  }
  if (node.owned) {
    for (let i = 0;i < node.owned.length; i++)
      reset(node.owned[i]);
  }
}
function castError(err) {
  if (err instanceof Error)
    return err;
  return new Error(typeof err === "string" ? err : "Unknown error", {
    cause: err
  });
}
function runErrors(err, fns, owner) {
  try {
    for (const f of fns)
      f(err);
  } catch (e) {
    handleError(e, owner && owner.owner || null);
  }
}
function handleError(err, owner = Owner) {
  const fns = ERROR && owner && owner.context && owner.context[ERROR];
  const error = castError(err);
  if (!fns)
    throw error;
  if (Effects)
    Effects.push({
      fn() {
        runErrors(error, fns, owner);
      },
      state: STALE
    });
  else
    runErrors(error, fns, owner);
}
var FALLBACK = Symbol("fallback");

// src/util/fs.ts
import { mkdir, writeFile, readFile, rename, rm, stat } from "fs/promises";
async function safeRead(path) {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

// src/memory/paths.ts
import { join } from "path";
import { createHash } from "crypto";
import { homedir } from "os";
function resolveProjectPath(worktree, directory) {
  if (!worktree || worktree === "/" || worktree === "") {
    return directory;
  }
  return worktree;
}
function globalProjectStorageDir(project) {
  return join(homedir(), ".config", "opencode", "memory", projectStorageHash(project));
}
function projectStorageHash(project) {
  return createHash("sha256").update(project).digest("hex").slice(0, 16);
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
  evidence_refs: z.array(z.string().min(1).max(128)).min(1).max(3).optional().superRefine((refs, ctx) => {
    if (refs === undefined) {
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
var boundedNonEmpty = (max) => z.string().max(max).refine((value) => value.trim().length > 0, "must be non-empty");
var evidenceRef = z.string().min(1).max(128).refine((value) => value.trim().length > 0, "evidence ref must be non-empty");
var LLMDecisionSchema = z.object({
  topic: boundedNonEmpty(256),
  decision: boundedNonEmpty(500),
  rationale: boundedNonEmpty(500).optional(),
  evidence_refs: z.array(evidenceRef).min(1).max(3).refine((refs) => new Set(refs).size === refs.length, "evidence refs must be unique")
}).strict();
var LLMDecisionFactsSchema = z.object({
  decisions: z.array(LLMDecisionSchema).max(10)
}).strict();

// src/memory/schema.ts
var MAX_IDENTIFIER = 256;
var MAX_REFERENCE = 128;
var MAX_CACHE_QUARANTINE_COUNT = 1e4;
var MAX_MODEL_HEALTH_RECORDS = 10;
var MAX_PROCESSED_SOURCES = 10;
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
var HumanReviewSchema = z2.object({
  channel: z2.literal("interactive-cli"),
  reviewed_at: z2.string().datetime({ offset: true }).max(64).or(z2.string().max(64))
}).strict();
var ProvenanceSchema = z2.object({
  extractor: ExtractorSchema,
  source_session_id: z2.string().min(1).max(MAX_IDENTIFIER),
  source_audit_session_id: z2.string().min(1).max(MAX_IDENTIFIER).optional(),
  confidence: ConfidenceSchema,
  evidence: z2.array(EvidenceSchema).max(3).default([])
}).strict().superRefine((provenance, ctx) => {
  const { extractor, confidence } = provenance;
  if (extractor === "llm" && confidence !== "llm-corroborated") {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      path: ["confidence"],
      message: "extractor=llm must pair with confidence=llm-corroborated"
    });
  }
  if (extractor === "heuristic" && confidence !== "heuristic") {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      path: ["confidence"],
      message: "extractor=heuristic must pair with confidence=heuristic"
    });
  }
  if (extractor === "human" && confidence !== "human-reviewed") {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      path: ["confidence"],
      message: "extractor=human must pair with confidence=human-reviewed"
    });
  }
  if (extractor === "legacy" && confidence !== "legacy") {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      path: ["confidence"],
      message: "extractor=legacy must pair with confidence=legacy"
    });
  }
  if (extractor === "llm" && confidence === "llm-corroborated") {
    if (!provenance.source_audit_session_id || provenance.source_audit_session_id.length === 0) {
      ctx.addIssue({
        code: z2.ZodIssueCode.custom,
        path: ["source_audit_session_id"],
        message: "LLM provenance requires non-empty source_audit_session_id"
      });
    }
    if (!provenance.evidence || provenance.evidence.length === 0) {
      ctx.addIssue({
        code: z2.ZodIssueCode.custom,
        path: ["evidence"],
        message: "LLM provenance requires at least 1 evidence entry"
      });
    }
    if (provenance.evidence.length > 3) {
      ctx.addIssue({
        code: z2.ZodIssueCode.custom,
        path: ["evidence"],
        message: "LLM provenance evidence must have at most 3 entries"
      });
    }
    if (provenance.evidence.some((e) => e.kind !== "transcript")) {
      ctx.addIssue({
        code: z2.ZodIssueCode.custom,
        path: ["evidence"],
        message: "LLM provenance evidence must be transcript-only"
      });
    }
  }
});
var NonDecisionProvenanceSchema = ProvenanceSchema.superRefine((provenance, ctx) => {
  if (provenance.extractor !== "heuristic" && provenance.extractor !== "legacy") {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      path: ["extractor"],
      message: "non-decision provenance must be heuristic or legacy"
    });
  }
  if (provenance.confidence !== "heuristic" && provenance.confidence !== "legacy") {
    ctx.addIssue({
      code: z2.ZodIssueCode.custom,
      path: ["confidence"],
      message: "non-decision provenance confidence must be heuristic or legacy"
    });
  }
});
var DecisionSchema = z2.object({
  id: z2.string().min(1).max(MAX_IDENTIFIER),
  topic: z2.string(),
  decision: z2.string(),
  rationale: z2.string().optional(),
  timestamp: z2.string().datetime({ offset: true }).or(z2.string()),
  git_sha: z2.string().optional(),
  session_id: z2.string(),
  still_valid: z2.boolean().default(true),
  foundational: z2.boolean().default(false),
  foundational_requested: z2.boolean().default(false),
  last_used_in_session: z2.string().optional(),
  human_review: HumanReviewSchema.optional(),
  superseded_by: z2.string().max(MAX_IDENTIFIER).optional(),
  conflicts_with: z2.array(z2.string().max(MAX_IDENTIFIER)).max(8).optional(),
  derived_from_decision_id: z2.string().max(MAX_IDENTIFIER).optional(),
  human_conflict_quarantined: z2.boolean().default(false),
  provenance: ProvenanceSchema
});
var ActiveFileSchema = z2.object({
  path: z2.string(),
  reason: z2.string(),
  last_touched: z2.string().datetime({ offset: true }).or(z2.string()),
  provenance: NonDecisionProvenanceSchema
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
var ProcessedSourceSchema = z2.object({
  source_key: z2.string().regex(/^v2s:[a-f0-9]{64}$/),
  extraction_key: z2.string().regex(/^v2e:[a-f0-9]{64}$/),
  extraction_contract_version: z2.number().int().positive().max(1e4),
  completed_at: z2.string().datetime({ offset: true }).or(z2.string().max(128))
}).strict();
var LLMExtractionCacheEntrySchema = z2.object({
  cache_key: z2.string(),
  source_session_id: z2.string(),
  canonical_input_sha256: z2.string(),
  provider_id: z2.string(),
  model_id: z2.string(),
  completed_at: z2.string().datetime({ offset: true }).or(z2.string()),
  provenance: ProvenanceSchema.optional(),
  facts: LLMDecisionFactsSchema,
  source_key: z2.string().optional(),
  source_input_sha256: z2.string().optional(),
  prompt_input_sha256: z2.string().optional(),
  extraction_contract_version: z2.number().int().positive().max(1e4).optional(),
  model_variant: z2.string().optional()
});
var AuditTerminalOutcomeSchema = z2.enum(["pending", "success", "failed"]);
var LLMAuditMetadataSchema = z2.object({
  audit_session_id: z2.string().max(256),
  source_session_id: z2.string().max(256),
  cache_key: z2.string().max(512),
  provider_id: z2.string().max(256),
  model_id: z2.string().max(256),
  created_at: z2.string().datetime({ offset: true }).or(z2.string().max(128)),
  terminal_outcome: AuditTerminalOutcomeSchema,
  source_key: z2.string().optional(),
  source_input_sha256: z2.string().optional(),
  prompt_input_sha256: z2.string().optional(),
  extraction_contract_version: z2.number().int().positive().max(1e4).optional(),
  model_variant: z2.string().optional()
});
var MemoryFileBaseSchema = z2.object({
  version: z2.literal(3),
  revision: z2.number().int().nonnegative().default(0),
  project_path: z2.string(),
  last_updated: z2.string().datetime({ offset: true }).or(z2.string()),
  last_git_sha: z2.string().optional(),
  last_session_id: z2.string().optional(),
  current_task: z2.string().optional(),
  current_task_provenance: NonDecisionProvenanceSchema.optional(),
  active_files: z2.array(ActiveFileSchema).default([]),
  decisions: z2.array(DecisionSchema).default([]),
  blockers: z2.array(z2.string()).default([]),
  next_steps: z2.array(z2.string()).default([]),
  recent_sessions: z2.array(z2.string()).max(10).default([]),
  llm_extraction_cache: z2.array(LLMExtractionCacheEntrySchema).max(10).optional(),
  llm_extraction_audits: z2.array(LLMAuditMetadataSchema).max(20).optional(),
  model_health: z2.array(ModelHealthSchema).max(MAX_MODEL_HEALTH_RECORDS).optional(),
  llm_extraction_cache_quarantine: CacheQuarantineMetadataSchema.optional(),
  processed_sources: z2.array(ProcessedSourceSchema).max(MAX_PROCESSED_SOURCES).default([])
});
var DUPLICATE_DECISION_ID = "DUPLICATE_DECISION_ID";
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
  for (const [index, decision] of memory.decisions.entries()) {
    const path = (field) => ["decisions", index, field];
    const claimsHumanTrust = decision.provenance?.extractor === "human" || decision.provenance?.confidence === "human-reviewed" || decision.human_review !== undefined;
    if (claimsHumanTrust) {
      const trustOk = decision.foundational === true && decision.provenance?.extractor === "human" && decision.provenance?.confidence === "human-reviewed" && decision.human_review?.channel === "interactive-cli";
      if (!trustOk) {
        ctx.addIssue({
          code: z2.ZodIssueCode.custom,
          path: path("provenance"),
          message: "a human trust claim requires foundational=true, extractor=human, " + "confidence=human-reviewed, and human_review.channel=interactive-cli"
        });
      }
    }
    if (decision.superseded_by === decision.id) {
      ctx.addIssue({
        code: z2.ZodIssueCode.custom,
        path: path("superseded_by"),
        message: "a decision cannot supersede itself"
      });
    }
    if (decision.conflicts_with?.includes(decision.id)) {
      ctx.addIssue({
        code: z2.ZodIssueCode.custom,
        path: path("conflicts_with"),
        message: "a decision cannot conflict with itself"
      });
    }
    if (decision.conflicts_with) {
      const seen = new Set;
      for (const id of decision.conflicts_with) {
        if (seen.has(id)) {
          ctx.addIssue({
            code: z2.ZodIssueCode.custom,
            path: path("conflicts_with"),
            message: `duplicate conflict id: ${id}`
          });
        }
        seen.add(id);
      }
    }
  }
  const seenDecisionIds = new Set;
  for (const [index, decision] of memory.decisions.entries()) {
    if (seenDecisionIds.has(decision.id)) {
      ctx.addIssue({
        code: z2.ZodIssueCode.custom,
        path: ["decisions", index, "id"],
        params: { issue: DUPLICATE_DECISION_ID },
        message: `duplicate decision id: ${decision.id}`
      });
    }
    seenDecisionIds.add(decision.id);
  }
});

// src/memory/project-lock.ts
import { z as z3 } from "zod";
var ProjectLockOwnerSchema = z3.object({
  version: z3.literal(1),
  pid: z3.number().int().positive().max(2147483647),
  hostname: z3.string().min(1).max(255),
  acquired_at: z3.string().max(64),
  nonce: z3.string().min(1).max(64)
}).strict();

// src/memory/store.ts
var cache = new Map;

// src/memory/commit-pulse.ts
import { unlink } from "fs/promises";
import { join as join2 } from "path";
var MEMORY_COMMIT_RECENT_MS = 2000;
var COMMIT_PULSE_FILE = ".commit-pulse";
function memoryCommitPulsePath(project) {
  return join2(globalProjectStorageDir(project), COMMIT_PULSE_FILE);
}
async function readRecentMemoryCommit(project, now = Date.now()) {
  const path = memoryCommitPulsePath(project);
  let raw;
  try {
    raw = await safeRead(path);
  } catch {
    return null;
  }
  if (raw === null)
    return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await unlink(path).catch(() => {});
    return null;
  }
  const committedAt = parsed?.committed_at;
  const fresh = typeof committedAt === "number" && Number.isFinite(committedAt) && committedAt <= now && now - committedAt <= MEMORY_COMMIT_RECENT_MS;
  if (!fresh) {
    await unlink(path).catch(() => {});
    return null;
  }
  return committedAt;
}

// src/tui.tsx
var POLL_MS = 500;
var BRIGHT_MS = 350;
var FADE_MS = 450;
function projectFromState(path) {
  if (typeof path?.directory !== "string" || !path.directory)
    return null;
  if (typeof path.worktree !== "string")
    return path.directory;
  return resolveProjectPath(path.worktree, path.directory);
}
var tui = async (api) => {
  api.slots.register({
    slots: {
      session_prompt_right: (_context, {
        session_id
      }) => {
        const [pulseStage, setPulseStage] = createSignal("idle");
        const project = projectFromState(api.state.path);
        let lastSeenCommitAt = 0;
        let pollInFlight = false;
        let pulseTimer;
        let pollTimer;
        let unsubscribe;
        const startPulse = () => {
          if (pulseTimer)
            clearTimeout(pulseTimer);
          setPulseStage("bright");
          pulseTimer = setTimeout(() => {
            setPulseStage("fade");
            pulseTimer = setTimeout(() => {
              setPulseStage("idle");
              pulseTimer = undefined;
            }, FADE_MS);
          }, BRIGHT_MS);
        };
        const poll = () => {
          if (!project || pollInFlight)
            return;
          pollInFlight = true;
          readRecentMemoryCommit(project).then((committedAt) => {
            if (committedAt !== null && committedAt > lastSeenCommitAt) {
              lastSeenCommitAt = committedAt;
              startPulse();
            }
          }).catch(() => {}).finally(() => {
            pollInFlight = false;
          });
        };
        unsubscribe = project ? api.event.on("session.idle", (event) => {
          if (event.properties.sessionID !== session_id)
            return;
          poll();
        }) : undefined;
        poll();
        pollTimer = setInterval(poll, POLL_MS);
        onCleanup(() => {
          if (pollTimer)
            clearInterval(pollTimer);
          if (pulseTimer)
            clearTimeout(pulseTimer);
          unsubscribe?.();
        });
        const muted = api.theme.current.textMuted;
        return (() => {
          var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$4 = _$createElement("text");
          _$insertNode(_el$, _el$2);
          _$insertNode(_el$, _el$4);
          _$setProp(_el$, "flexDirection", "row");
          _$insertNode(_el$2, _$createTextNode(`memory `));
          _$setProp(_el$2, "fg", muted);
          _$insert(_el$4, (() => {
            var _c$ = _$memo(() => pulseStage() === "bright");
            return () => _c$() ? "\u25CF" : pulseStage() === "fade" ? "\u2022" : "\xB7";
          })());
          _$effect((_$p) => _$setProp(_el$4, "fg", pulseStage() === "idle" ? muted : api.theme.current.success, _$p));
          return _el$;
        })();
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
