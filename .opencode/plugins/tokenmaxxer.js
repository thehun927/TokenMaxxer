// src/config.ts
function loadOptions(_ctx) {
  return {
    // Kill switch: set TOKENMAXXER_NO_PROMPT=1 to skip prompt replacement,
    // still inject durable block via output.context
    compactionPrompt: process.env.TOKENMAXXER_NO_PROMPT !== "1",
    headerInjection: "instructions",
    memoryKey: "worktree"
  };
}

// src/compaction/prompt.ts
function buildCompactionPrompt(durable) {
  return `You are generating a continuation prompt for an opencode session that has run out of context window space. The summary you produce REPLACES the entire conversation history for the agent that resumes this work, so it must be self-sufficient.

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
import { z } from "zod";
var DecisionSchema = z.object({
  id: z.string(),
  topic: z.string(),
  decision: z.string(),
  rationale: z.string().optional(),
  timestamp: z.string().datetime({ offset: true }).or(z.string()),
  // ISO 8601
  git_sha: z.string().optional(),
  session_id: z.string(),
  still_valid: z.boolean().default(true),
  foundational: z.boolean().optional(),
  // M4.5: promoted by model or auto-detected (undefined = false)
  last_used_in_session: z.string().optional()
  // M4.5: set by writer when decision is referenced
});
var ActiveFileSchema = z.object({
  path: z.string(),
  reason: z.string(),
  last_touched: z.string().datetime({ offset: true }).or(z.string())
  // ISO 8601
});
var MemoryFileSchema = z.object({
  version: z.literal(1),
  project_path: z.string(),
  last_updated: z.string().datetime({ offset: true }).or(z.string()),
  // ISO 8601
  last_git_sha: z.string().optional(),
  last_session_id: z.string().optional(),
  current_task: z.string().optional(),
  active_files: z.array(ActiveFileSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  blockers: z.array(z.string()).default([]),
  next_steps: z.array(z.string()).default([])
});
function emptyMemory(worktree) {
  return {
    version: 1,
    project_path: worktree,
    last_updated: (/* @__PURE__ */ new Date()).toISOString(),
    active_files: [],
    decisions: [],
    blockers: [],
    next_steps: []
  };
}

// src/memory/migrate.ts
var migrations = {
  // 1: (d) => d,  // v1 is identity — no migration needed
};
function loadAndMigrate(raw) {
  if (raw === null || raw === void 0) return null;
  if (typeof raw !== "object") return null;
  const obj = raw;
  const version = typeof obj.version === "number" ? obj.version : 0;
  let data = obj;
  for (let v = version; v < 1; v++) {
    const fn = migrations[v];
    if (!fn) {
      return null;
    }
    data = fn(data);
  }
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
var MAX_BYTES = 8192;
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
async function writeMemory({ worktree, directory }, mem) {
  const project = resolveProjectPath(worktree, directory);
  const path = memoryPath(project);
  const json = JSON.stringify(mem, null, 2);
  if (json.length > MAX_BYTES) {
    console.warn(`tokenmaxxer: STATE.json still ${json.length} bytes after pruning`);
  }
  try {
    await atomicWrite(path, json);
  } catch {
    try {
      await atomicWrite(globalPath(project), json);
    } catch {
    }
    cache.delete(project);
    return;
  }
  cache.delete(project);
}
async function backupCorrupt(path, content) {
  try {
    await atomicWrite(`${path}.corrupt.${Date.now()}`, content);
  } catch {
  }
}

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

// src/compaction/durable.ts
async function buildDurableBlock(opts) {
  try {
    const mem = await readMemory({ worktree: opts.worktree, directory: opts.directory });
    if (!mem) return "(no prior project memory)";
    const lines = [];
    lines.push(`Project: ${mem.project_path}`);
    lines.push(`Last updated: ${mem.last_updated}  git SHA: ${mem.last_git_sha ?? "unknown"}`);
    if (mem.current_task) {
      lines.push(`Current task: ${mem.current_task}`);
    }
    const activeFiles = [...mem.active_files].sort((a, b) => b.last_touched.localeCompare(a.last_touched)).slice(0, 8);
    if (activeFiles.length) {
      lines.push("Active files:");
      for (const f of activeFiles) {
        lines.push(`  - ${f.path} \u2014 ${f.reason}`);
      }
    }
    const valid = mem.decisions.filter((d) => d.still_valid);
    const foundational = valid.filter((d) => d.foundational);
    const recent = valid.filter(
      (d) => !d.foundational && isRecentSession(d, mem.last_session_id)
    );
    const older = valid.filter(
      (d) => !d.foundational && !isRecentSession(d, mem.last_session_id)
    ).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5);
    if (foundational.length || recent.length) {
      lines.push("Valid decisions:");
      for (const d of [...foundational, ...recent]) {
        lines.push(
          `  - ${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${d.timestamp})`
        );
      }
    }
    if (older.length) {
      lines.push("Older decisions:");
      for (const d of older) {
        const date = d.timestamp.slice(0, 10);
        lines.push(`  - ${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${date})`);
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
function isRecentSession(d, lastSessionId) {
  if (!d.last_used_in_session) return false;
  return d.last_used_in_session === lastSessionId;
}

// src/util/git.ts
async function getCurrentGitSha(worktree) {
  try {
    const Bun = globalThis.Bun;
    if (Bun?.$) {
      const proc = Bun.$`git -C ${worktree} rev-parse HEAD`;
      const result = await proc;
      const sha = result.stdout?.trim();
      if (sha && /^[0-9a-f]{7,40}$/.test(sha)) return sha;
      return null;
    }
  } catch {
  }
  try {
    const { execSync } = await import("child_process");
    const sha = execSync("git rev-parse HEAD", {
      cwd: worktree,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    if (sha && /^[0-9a-f]{7,40}$/.test(sha)) return sha;
    return null;
  } catch {
    return null;
  }
}

// src/memory/writer.ts
import { join as join2 } from "path";
var TRANSCRIPT_WINDOW = 50;
async function writeMemoryOnIdle(opts) {
  try {
    const { client, worktree, directory, sessionId } = opts;
    const c = client;
    if (!c.session?.messages) return;
    const result = await c.session.messages({ path: { id: sessionId } });
    const allMessages = result.data;
    if (!allMessages || allMessages.length === 0) return;
    const messages = allMessages.slice(-TRANSCRIPT_WINDOW);
    const gitSha = await getCurrentGitSha(worktree);
    const existing = await readMemory({ worktree, directory }) ?? emptyMemory(worktree);
    const extracted = extractFactsHeuristic(messages);
    markReferencedDecisions(existing, allMessages, sessionId);
    const merged = mergeMemory(existing, extracted, {
      sessionId,
      gitSha,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    const pruned = pruneOld(merged);
    await writeMemory({ worktree, directory }, pruned);
    await generateHeader(worktree, directory, pruned);
  } catch {
  }
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
  const firstUser = messages.find((m) => m.info.role === "user");
  if (!firstUser) return null;
  const text = getMessageText(firstUser);
  return text.slice(0, 200) || null;
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
          fileCounts.set(p, (fileCounts.get(p) ?? 0) + 1);
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
    allDecisions.push(...scanTextForDecisions(getMessageText(firstUser)));
  }
  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      allDecisions.push(...scanTextForDecisions(getMessageText(msg)));
    }
  }
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool") {
        const state = part.state;
        if (state && state.status === "completed") {
          const outputText = extractToolOutputText(part);
          if (outputText) {
            allDecisions.push(...scanTextForDecisions(outputText));
          }
        }
      }
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
      const foundational = FOUNDATIONAL_RE.test(trimmedSentence);
      const decision = trimmedSentence;
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
function extractToolOutputText(part) {
  if (part.type !== "tool") return null;
  const state = part.state;
  if (!state) return null;
  if (typeof state.output === "string") return state.output;
  if (typeof state.error === "string") return state.error;
  return null;
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
function mergeMemory(existing, extracted, meta) {
  const current_task = extracted.current_task !== null ? extracted.current_task : existing.current_task;
  const oldFileMap = new Map(existing.active_files.map((f) => [f.path, f.reason]));
  const active_files = extracted.active_files.map((f) => {
    const oldReason = oldFileMap.get(f.path);
    const isGeneric = f.reason === "read once" || f.reason.startsWith("edited ");
    return {
      path: f.path,
      reason: oldReason && isGeneric ? oldReason : f.reason,
      last_touched: meta.timestamp
    };
  });
  const existingDecisions = existing.decisions.map((d) => ({ ...d }));
  const existingTopicMap = /* @__PURE__ */ new Map();
  for (let i = 0; i < existingDecisions.length; i++) {
    const normalized = existingDecisions[i].topic.toLowerCase().trim().replace(/\s+/g, " ");
    existingTopicMap.set(normalized, i);
  }
  for (const newDec of extracted.decisions) {
    const normalizedTopic = newDec.topic.toLowerCase().trim().replace(/\s+/g, " ");
    const existingIdx = existingTopicMap.get(normalizedTopic);
    const decision = {
      id: cryptoRandomUUID(),
      topic: newDec.topic,
      decision: newDec.decision,
      rationale: newDec.rationale,
      timestamp: meta.timestamp,
      git_sha: meta.gitSha ?? void 0,
      session_id: meta.sessionId,
      still_valid: true,
      foundational: newDec.foundational ?? false
    };
    if (existingIdx !== void 0) {
      if (typeof existingDecisions[existingIdx]?.id === "string") {
        existingDecisions[existingIdx].still_valid = false;
      }
      existingDecisions.push(decision);
    } else {
      existingDecisions.push(decision);
    }
  }
  return {
    version: 1,
    project_path: existing.project_path,
    last_updated: meta.timestamp,
    last_git_sha: meta.gitSha ?? existing.last_git_sha,
    last_session_id: meta.sessionId,
    current_task,
    active_files,
    decisions: existingDecisions,
    blockers: extracted.blockers,
    next_steps: extracted.next_steps
  };
}
function cryptoRandomUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}
var MAX_BYTES2 = 8192;
var THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1e3;
function pruneOld(mem) {
  const cloned = {
    version: mem.version,
    project_path: mem.project_path,
    last_updated: mem.last_updated,
    last_git_sha: mem.last_git_sha,
    last_session_id: mem.last_session_id,
    current_task: mem.current_task,
    active_files: mem.active_files.map((f) => ({ ...f })),
    decisions: mem.decisions.map((d) => ({ ...d })),
    blockers: [...mem.blockers],
    next_steps: [...mem.next_steps]
  };
  if (jsonSize(cloned) <= MAX_BYTES2) return cloned;
  cloned.decisions = cloned.decisions.filter((d) => d.still_valid);
  if (jsonSize(cloned) <= MAX_BYTES2) return cloned;
  cloned.active_files = [...cloned.active_files].sort((a, b) => b.last_touched.localeCompare(a.last_touched)).slice(0, 8);
  if (jsonSize(cloned) <= MAX_BYTES2) return cloned;
  const now = Date.now();
  cloned.decisions = cloned.decisions.filter((d) => {
    const ts = new Date(d.timestamp).getTime();
    return now - ts < THIRTY_DAYS_MS;
  });
  if (jsonSize(cloned) <= MAX_BYTES2) return cloned;
  if (cloned.current_task && cloned.current_task.length > 200) {
    cloned.current_task = cloned.current_task.slice(0, 200);
  }
  cloned.active_files = cloned.active_files.map((f) => ({
    ...f,
    reason: f.reason.length > 100 ? f.reason.slice(0, 100) : f.reason
  }));
  if (jsonSize(cloned) <= MAX_BYTES2) return cloned;
  cloned.decisions = [...cloned.decisions].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 10);
  if (jsonSize(cloned) <= MAX_BYTES2) {
    console.warn("tokenmaxxer: pruned decisions to 10 most recent to fit 8KB cap");
    return cloned;
  }
  cloned.decisions = [...cloned.decisions].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5);
  cloned.active_files = [];
  cloned.blockers = [];
  cloned.next_steps = [];
  if (jsonSize(cloned) > MAX_BYTES2) {
    console.error("tokenmaxxer: STILL over 8KB after all pruning \u2014 truncating to current_task + 5 decisions");
  }
  return cloned;
}
function jsonSize(mem) {
  return JSON.stringify(mem).length;
}
async function generateHeader(worktree, directory, mem) {
  const project = resolveProjectPath(worktree, directory);
  const headerPath = join2(project, ".opencode", "memory", "HEADER.md");
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
    `Task: ${mem.current_task ?? "\u2014"}`,
    `Active files: ${mem.active_files.map((f) => f.path).join(", ") || "none"}`,
    `Decisions: ${validDecisions.map((d) => d.topic).join(", ") || "none"}`,
    `Blockers: ${mem.blockers.join("; ") || "none"}`,
    `Next: ${mem.next_steps.join("; ") || "none"}`
  ].join("\n");
}

// src/tools/recall.ts
async function _recallDecision(args, context) {
  try {
    const mem = await readMemory({ worktree: context.worktree, directory: context.directory });
    if (!mem) return "No project memory yet.";
    const hits = queryDecisions(mem, args.query, args.limit);
    const prefix = `Project: ${mem.project_path}
`;
    if (!hits.length) return `${prefix}No valid decisions matching "${args.query}".`;
    return prefix + hits.map((d) => `${d.topic}: ${d.decision} (SHA ${d.git_sha ?? "?"}, ${d.timestamp})`).join("\n");
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
` + active.map((f) => `${f.path} \u2014 ${f.reason}`).join("\n");
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
    const mem = await readMemory({ worktree: context.worktree, directory: context.directory });
    if (!mem) return "No project memory.";
    const d = mem.decisions.find(
      (d2) => d2.topic.toLowerCase() === args.topic.toLowerCase()
    );
    if (!d) return `No decision with topic "${args.topic}".`;
    d.foundational = true;
    await writeMemory({ worktree: context.worktree, directory: context.directory }, mem);
    return `Promoted: ${d.topic}: ${d.decision}`;
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
import { join as join3 } from "path";
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
    const path = join3(project, ".opencode", "memory", "STATE.json");
    const content = await safeRead(path);
    const size = content?.length ?? 0;
    return [
      `Project: ${mem?.project_path ?? "none"}`,
      `Memory file: ${path} (${size} bytes)`,
      `Decisions: ${mem?.decisions.length ?? 0} (${mem?.decisions.filter((d) => d.still_valid).length ?? 0} valid)`,
      `Active files: ${mem?.active_files.length ?? 0}`,
      `Last updated: ${mem?.last_updated ?? "never"}`,
      `Last git SHA: ${mem?.last_git_sha ?? "unknown"}`,
      `Last compaction: ${lastCompactionTimestamp ?? "none"}`
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
import { join as join4 } from "path";
var TokenmaxxerPlugin = async (ctx) => {
  const { client, directory, worktree } = ctx;
  const options = loadOptions(ctx);
  const project = resolveProjectPath(worktree, directory);
  await log(client, "info", "tokenmaxxer plugin loaded", {
    worktree,
    directory,
    resolved: project
  });
  try {
    const c = client;
    const info = await c.app?.info?.();
    const version = info?.data?.version;
    if (version) {
      const major = parseInt(version.split(".")[0] ?? "0", 10);
      if (major < 1) {
        await log(client, "warn", `opencode ${version} may be unsupported (requires >=1.0.0)`);
      }
    }
  } catch {
  }
  try {
    const project2 = resolveProjectPath(worktree, directory);
    const headerPath = join4(project2, ".opencode", "memory", "HEADER.md");
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
          const project2 = resolveProjectPath(worktree, directory);
          const logPath = join4(project2, ".opencode", "memory", "last_compaction.log");
          const entry = `[${(/* @__PURE__ */ new Date()).toISOString()}] session=${input.sessionID}
${output.prompt ?? "(durable via context)"}
---
`;
          await atomicWrite(logPath, entry);
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
          await writeMemoryOnIdle({ client, worktree, directory, sessionId });
        } else if (event.type === "session.created") {
        }
      } catch (e) {
        await log(client, "error", "event handler failed", { type: event.type, error: String(e) });
      }
    },
    // Layer 2: custom tools (recall + efficiency + status)
    ...registerTools(ctx),
    ...registerEfficiencyTools(),
    ...registerStatusTools(),
    // Alternative header-injection path (experimental, undocumented).
    // Only active when options.headerInjection === "system_transform".
    // Falls back to the documented `instructions` + HEADER.md path otherwise.
    ...options.headerInjection === "system_transform" ? {
      "experimental.chat.system.transform": async (_input, output) => {
        try {
          const mem = await readMemory({ worktree, directory });
          if (!mem) return;
          output.system.push(
            `Project: ${mem.project_path} | Last: ${mem.last_updated} (SHA ${mem.last_git_sha ?? "?"}) | Task: ${mem.current_task ?? "\u2014"} | Call get_project_state for details.`
          );
        } catch (e) {
          await log(client, "error", "system.transform failed", { error: String(e) });
        }
      }
    } : {}
  };
};
var index_default = TokenmaxxerPlugin;
export {
  TokenmaxxerPlugin,
  index_default as default
};
