# PR 3 Implementation Plan — Decision Authority and Promotion Trust

> **Status:** ready for implementation  
> **Repository baseline:** `5b93492f5cc81e7e2bceb6dee482e43df00d8c41`  
> **Code baseline:** `e2d2da57c3655ee70ab4745ed8a0811195aa3eac` (PR 2 Wave 8; subsequent commits were documentation-only)  
> **Resolves:** I2, I3, I4, I5  
> **Depends on:** PR 1 storage authority + PR 2 cross-process transactions (**Ship**)  
> **Followed by:** PR 4 OpenCode host contract  
> **Program authority:** [`../implementation-plan.md`](../implementation-plan.md)

## Executive summary

PR 1 made STATE selection trustworthy. PR 2 made STATE mutation transactional across processes. PR 3 makes the **meaning of a durable decision trustworthy**.

Today TokenMaxxer can still expose more than one valid decision for the same topic, promote a stale/invalid decision by topic, let a model-callable tool mint `human-reviewed` provenance directly, and prune a supposedly foundational decision under ordinary age/count pressure.

PR 3 establishes one explicit authority model:

```text
one normalized topic
        ↓
zero or one authoritative valid decision
        ↓
all competing observations are historical/candidate records
        ↓
trusted human foundational state requires interactive human confirmation
```

The intended trust ladder remains:

```text
legacy
  < heuristic observation
  < LLM-corroborated decision with exact source evidence
  < explicitly human-reviewed foundational decision
```

This PR does **not** redesign the complete LLM durable-fact boundary (PR 6), the hard storage-budget result type (PR 8), or host compatibility/tool bounds (PR 4). It only makes decision authority, review, supersession, and retention unambiguous.

---

# 1. Current-state findings this PR must close

The post-PR2 code already contains useful groundwork (`foundational_requested`, transactional promotion, exact revision ownership), but the decision semantics are still unsafe.

## 1.1 `mergeMemory()` only tracks one existing row per topic

Current decision merging builds:

```ts
const existingTopicMap = new Map<string, number>()
```

and later stores one index per normalized topic. If historical bugs already left multiple valid rows for one topic, only the final mapped row participates in supersession.

That permits this sequence:

```text
heuristic X          -> X valid
agreeing LLM X       -> X heuristic valid + X LLM valid
later heuristic Y    -> only one X row invalidated
                     -> stale X can remain valid beside Y
```

PR 3 must reason over **all rows in a normalized topic group**, never a single mapped index.

## 1.2 Agreeing LLM output currently creates another valid authority

When the existing row is heuristic and the LLM agrees, the current code leaves the heuristic valid and appends a second `still_valid=true` LLM row.

Corroboration must enrich the same authority instead of multiplying authorities.

## 1.3 `recall_promote` targets by topic, not by stable decision ID

The current tool:

```ts
base.decisions.find(candidate => candidate.topic.toLowerCase() === args.topic.toLowerCase())
```

has no `still_valid`/authority check. A stale historical row can therefore be selected.

Worse, after selecting one row, the mutation maps **every same-topic row** to the same promoted object. With duplicate historical rows this can collapse distinct history into repeated copies of one ID/value.

Promotion must operate on one exact decision ID and must never rewrite unrelated rows.

## 1.4 A model-callable tool still mints human trust

`recall_promote` currently sets:

```ts
foundational = true
provenance.extractor = "human"
provenance.confidence = "human-reviewed"
```

A model tool call is not evidence of human review. PR 3 must make model promotion a **review request only**.

## 1.5 Existing `human-reviewed` records cannot be blindly grandfathered

Before PR 3, the model-callable promotion path could create `human-reviewed` provenance. Therefore a v3 STATE row that says `extractor="human"` / `confidence="human-reviewed"` but lacks a new explicit human-review record cannot be trusted as proof of human action.

The migration/load boundary must conservatively reclassify those pre-PR3 claims for review.

## 1.6 Recall does not expose IDs

`recall_decision` returns topic, decision, SHA, timestamp, and provenance but not the stable `Decision.id`. Exact-ID review cannot work reliably until recall and the human CLI expose IDs.

## 1.7 Ordinary pruning can delete foundational state

`pruneOld()` currently:

- removes all invalid decisions;
- drops decisions older than 30 days;
- keeps only 10 recent decisions;
- finally keeps only 5 recent decisions.

None of those stages protects foundational decisions.

## 1.8 There is no independent human confirmation path

`bin/tokenmaxxer` currently supports only:

```bash
tokenmaxxer opencode [args...]
```

PR 3 needs a local human-controlled review path that reuses the same storage and cross-process transaction primitives rather than implementing a second STATE writer.

---

# 2. Hard invariants

PR 3 is complete only when all of these are true:

```text
1. One normalized topic exposes at most one authoritative valid decision.
2. Historical duplicate-valid state never leaks multiple authorities through recall.
3. An invalid or non-authoritative decision cannot receive ordinary promotion.
4. A trusted human-reviewed foundational decision cannot be silently superseded by automation.
5. Model-callable code cannot mint trusted human-reviewed provenance.
6. Trusted human-reviewed provenance requires an explicit interactive human review record.
7. Human confirmation targets one stable decision ID and revalidates it inside the PR 2 transaction.
8. No filesystem project lock is held while waiting for human input.
9. Ordinary age/count pruning cannot silently remove a current foundational decision.
10. Explicit human supersession is the only path that can replace a trusted human foundational authority.
```

A key distinction:

```text
foundational_requested = request for review
foundational = confirmed retention intent
human-reviewed = trust claim backed by interactive human review metadata
```

These values must no longer be synonyms.

---

# 3. Files

## New production files

- `src/memory/decision-authority.ts`
- `src/memory/decision-review.ts`
- `src/cli.ts`

## Existing production files

- `src/memory/schema.ts`
- `src/memory/migrate.ts`
- `src/memory/writer.ts`
- `src/memory/reader.ts`
- `src/tools/recall.ts`
- `bin/tokenmaxxer`
- `package.json`
- `install.sh`

## Tests

- new `test/memory/decision-authority.test.ts`
- new `test/memory/decision-review.test.ts`
- new `test/cli.test.ts`
- update `test/memory/merge.test.ts`
- update `test/memory/prune.test.ts`
- update `test/memory/migrate.test.ts`
- update `test/tools/recall.test.ts`
- concurrency coverage using the existing PR 2 transaction fixtures where appropriate

Do not put decision-authority rules back into `store.ts`; PR 2 owns transaction mechanics, not decision semantics.

---

# 4. Extend the decision schema with explicit review/history metadata

Keep STATE version 3 for this PR. The new fields are additive, and `loadAndMigrate()` will perform a compatibility repair before v3 validation.

Add:

```ts
export const HumanReviewSchema = z.object({
  channel: z.literal("interactive-cli"),
  reviewed_at: z.string().datetime({ offset: true }).or(z.string()),
}).strict()
```

Extend `DecisionSchema`:

```ts
foundational: z.boolean().default(false),
foundational_requested: z.boolean().default(false),
human_review: HumanReviewSchema.optional(),
superseded_by: z.string().max(MAX_IDENTIFIER).optional(),
conflicts_with: z.array(z.string().max(MAX_IDENTIFIER)).max(8).optional(),
derived_from_decision_id: z.string().max(MAX_IDENTIFIER).optional(),
```

Meanings:

- `human_review` — proof that the trusted review boundary was crossed.
- `superseded_by` — historical lineage for a deliberate replacement.
- `conflicts_with` — candidate/history record that disagrees with one or more protected authorities.
- `derived_from_decision_id` — used when explicit human supersession creates a new human authority from a previously invalid conflict candidate.

Do not store OS usernames, terminal contents, commands, prompts, or other unnecessary identity data.

## 4.1 Add validation invariants

Extend `MemoryFileSchema.superRefine()` so a newly persisted human trust claim is self-consistent.

If a decision has:

```text
provenance.extractor == "human"
OR provenance.confidence == "human-reviewed"
OR human_review is present
```

then require all of:

```text
foundational == true
provenance.extractor == "human"
provenance.confidence == "human-reviewed"
human_review.channel == "interactive-cli"
```

Also reject obvious malformed lineage:

- `superseded_by === id`;
- `conflicts_with` containing its own `id`;
- duplicate IDs inside `conflicts_with` after normalization/construction.

This validation is the final persistence guard against future code accidentally minting a human trust claim without the review record.

---

# 5. Repair pre-PR3 unverified human-review claims on load

Because the old model tool could create `human-reviewed`, existing v3 rows without `human_review` are **unverified legacy claims**.

Before final `MemoryFileSchema.safeParse()` in `loadAndMigrate()`, repair any decision where:

```text
extractor == "human" OR confidence == "human-reviewed"
```

and `human_review` is absent.

Conservative repair:

```ts
{
  ...decision,
  foundational: false,
  foundational_requested: true,
  provenance: {
    ...decision.provenance,
    extractor: "legacy",
    confidence: "legacy",
  },
}
```

Preserve:

- decision ID;
- topic/decision/rationale;
- timestamp/session/git SHA;
- existing source/evidence references;
- historical row ordering.

Do not claim those prior promotions were definitely model-generated or definitely human-generated. The point is that the old format cannot prove which one occurred, so it must be re-confirmed before receiving trusted human authority.

This compatibility repair must happen in memory immediately on read and will persist naturally on the next successful STATE mutation.

Required migration diagnostic behavior should remain bounded and non-sensitive; do not add transcript or command text.

---

# 6. Create `decision-authority.ts`

Centralize every rule that answers "which decision is authoritative?".

Suggested public API:

```ts
export type DecisionAuthorityConflict = {
  normalized_topic: string
  decision_ids: string[]
  kind: "conflicting-human-foundational"
}

export type DecisionAuthorityResolution = {
  decisions: Decision[]
  authorities: Decision[]
  conflicts: DecisionAuthorityConflict[]
}

export function normalizeDecisionTopic(topic: string): string
export function normalizeDecisionText(decision: string): string
export function isTrustedHumanFoundational(decision: Decision): boolean
export function resolveDecisionAuthorities(
  decisions: readonly Decision[],
): DecisionAuthorityResolution
```

Normalization should be deterministic and locale-independent:

```ts
value
  .normalize("NFKC")
  .toLowerCase()
  .trim()
  .replace(/\s+/g, " ")
```

Topic equality for authority is **exact normalized equality**, never substring equality.

## 6.1 Trusted human definition

A decision is trusted human foundational only when all are true:

```ts
decision.still_valid === true
decision.foundational === true
decision.provenance?.extractor === "human"
decision.provenance?.confidence === "human-reviewed"
decision.human_review?.channel === "interactive-cli"
```

The helper, not a loose check of `foundational`, becomes the automation-veto boundary.

## 6.2 Resolve duplicate valid rows deterministically

Group all `still_valid === true` rows by normalized topic.

### One row

That row is the authority.

### Multiple rows with equivalent normalized decision text

They represent duplicate observations, not competing authorities.

Selection/reconciliation rules:

1. a trusted human-reviewed row wins if present;
2. otherwise preserve the oldest semantic authority ID (timestamp asc, then lexical ID) so later corroboration does not churn identity;
3. copy the strongest trustworthy provenance/rationale onto the winner when reconciliation is persisted;
4. mark duplicate rows historical (`still_valid=false`, `superseded_by=<winner-id>`).

This is how an existing heuristic X + agreeing LLM X becomes **one authority with one stable ID**, not two valid rows.

### Multiple conflicting non-human rows

This is legacy/broken state. Choose one deterministic authority:

1. newest timestamp first;
2. trust rank as tie-breaker (`llm-corroborated > heuristic > legacy`);
3. lexical ID as final tie-breaker.

Mark the other rows historical and point `superseded_by` at the selected authority.

Recency is primary here because duplicate-valid conflicts usually mean a later real decision failed to invalidate an older row.

### Exactly one trusted human foundational row plus conflicts

The trusted human row remains the authority regardless of newer automated rows.

Competing rows become invalid conflict candidates with:

```ts
conflicts_with: [humanAuthority.id]
```

Do not set `superseded_by` because the human authority did not adopt those competing values.

### Multiple conflicting trusted human foundational rows

Never silently pick one.

This should only occur in inconsistent legacy/manually edited state after PR 3, because the new human workflow will prevent it.

Reconciliation behavior:

- no automated authority is selected for that topic;
- mark the conflicting rows non-authoritative (`still_valid=false`) in the reconciled representation;
- preserve `foundational=true` and human-review metadata;
- add reciprocal bounded `conflicts_with` IDs;
- emit one `conflicting-human-foundational` conflict record for readers/CLI.

This is **conflict quarantine**, not supersession. Only explicit human resolution may create a new authority.

## 6.3 Read view vs persistence

`resolveDecisionAuthorities()` is pure and returns copies.

Read-only tools use its `authorities`/`conflicts` view immediately, so legacy duplicate-valid files cannot leak two authorities even before a write occurs.

`mergeDecisions()` (next section) begins from the reconciled decision array, so the next decision-bearing mutation persists the repaired `still_valid`, conflict, and lineage state transactionally.

Do not mutate STATE merely because a read occurred.

---

# 7. Extract `mergeDecisions()` from `mergeMemory()`

Suggested API:

```ts
export function mergeDecisions(
  existing: readonly Decision[],
  incoming: readonly ExtractedDecision[],
  meta: DecisionMergeMeta,
): Decision[]
```

`mergeMemory()` remains responsible for task/files/blockers/next steps, but delegates all decision behavior to this module.

Every incoming item must be processed against the **current reconciled group**, not against a stale topic-index map.

## 7.1 Heuristic decision rules

For incoming heuristic decision H on normalized topic T:

### No authority and no unresolved human conflict

Create one valid heuristic authority.

### Equivalent to current non-human authority

Do not append another valid row.

- keep the existing authority ID;
- fill a missing rationale if the incoming one is useful;
- do not downgrade stronger LLM provenance to heuristic;
- OR `foundational_requested` so a request is not lost.

### Conflicts with current non-human authority

A current heuristic observation can represent a real user decision change in a later session.

- create one new valid heuristic authority;
- invalidate **all** prior valid same-topic non-human authority rows;
- set their `superseded_by` to the new ID.

### Equivalent to trusted human foundational authority

Keep the human authority unchanged. Do not downgrade provenance or create a duplicate.

### Conflicts with trusted human foundational authority

Automation may not replace it.

Create an invalid candidate/history row:

```ts
still_valid: false
foundational: false
conflicts_with: [humanAuthority.id]
```

The candidate remains available to the human CLI with `decisions --all` for explicit review/supersession.

### Topic has unresolved conflicting-human-foundational state

Do not let heuristic extraction resolve it.

Incoming observation becomes another invalid conflict candidate linked to the unresolved human IDs.

## 7.2 LLM decision rules

The existing evidence gate remains mandatory. An LLM decision without resolved exact evidence does not enter decision merging.

### No authority / new topic

An evidence-backed LLM decision may create one valid authority.

### Equivalent to current non-human authority

Corroborate **in place**:

- keep the existing decision ID;
- keep the semantic decision text;
- keep the authority creation timestamp;
- upgrade `provenance` to the evidence-backed LLM provenance when stronger;
- fill missing rationale if appropriate;
- do not append a second valid row.

The strongest current provenance represents the current evidence level for the authority; the stable decision ID represents semantic continuity.

### Equivalent to trusted human authority

No-op for authority/trust. Human provenance must not be replaced by LLM provenance.

### Conflicts with heuristic, LLM, or trusted human authority

Do not automatically displace the current authority.

Append an invalid evidence-backed candidate with `conflicts_with=[authority.id]`.

This is particularly important for the normal idle lifecycle where the heuristic write occurs first and the LLM result arrives later for the same source session.

### Conflicts with a legacy-only authority

An evidence-backed LLM observation may supersede a legacy-only authority because the trust ladder is strictly stronger and legacy state has no evidence contract.

Persist lineage via `superseded_by`.

## 7.3 Foundational requests from extraction

Neither heuristic nor LLM extraction may set `foundational=true` or human provenance.

If extraction marks a decision foundational, map that only to:

```ts
foundational_requested = true
```

---

# 8. Make readers authority-aware and expose stable IDs

Update `src/memory/reader.ts`.

`queryDecisions()` must operate on:

```ts
resolveDecisionAuthorities(mem.decisions).authorities
```

not raw `still_valid` filtering.

Add:

```ts
export function getDecisionById(
  mem: MemoryFile,
  decisionId: string,
): Decision | undefined

export function getDecisionAuthorityConflicts(
  mem: MemoryFile,
): DecisionAuthorityConflict[]
```

## 8.1 Recall output

`recall_decision` must show the stable ID for every returned authority, for example:

```text
database: Use PostgreSQL [id=0e4f... confidence=llm-corroborated foundational=false requested=true]
```

Keep existing SHA/timestamp/provenance context as useful, but the ID must be unambiguous and copyable.

## 8.2 Project state output

`get_project_state` should include an explicit bounded conflict line when decision authority is unresolved, for example:

```text
Decision conflicts: database (human-foundational conflict: id-a, id-b)
```

Do not dump every historical invalid row into normal project state.

---

# 9. Redesign `recall_promote` as a review request

The model-callable tool must no longer perform promotion.

Preferred args:

```ts
{
  decision_id?: string
  topic?: string // one-release compatibility path only
}
```

Runtime requires exactly one selector.

## 9.1 Exact-ID path

Resolve the authority view transactionally.

The target must:

- exist by exact ID;
- be the current authority for its normalized topic;
- be `still_valid=true` in the reconciled view;
- not be inside unresolved human-foundational conflict.

The only mutation is:

```ts
foundational_requested = true
```

Do not modify:

- `foundational`;
- `provenance.extractor`;
- `provenance.confidence`;
- `human_review`.

Return language such as:

```text
Foundational review requested for <id>. Human confirmation required:
tokenmaxxer promote <id>
```

If already trusted human foundational, return a no-op message.

## 9.2 Temporary topic compatibility path

For one compatibility window, `topic` may resolve an exact normalized topic **only if exactly one authority exists and no authority conflict exists**.

Otherwise refuse with a bounded ambiguity/error message and tell the caller to use the ID from `recall_decision`.

Do not use substring matching for promotion compatibility.

## 9.3 Remove the stale pre-read dependency

The request operation can use one `mutateMemory()` transaction and return a typed callback outcome (`requested`, `already-reviewed`, `not-found`, `not-authoritative`, `conflict`).

There is no need for a separate pre-read before mutation merely to decide whether the target is eligible.

The existing process-local queue may remain as an outer coalescing layer, but the PR 2 filesystem transaction is authoritative.

---

# 10. Add shared decision-review mutation helpers

Create `src/memory/decision-review.ts` so the CLI and model tool use one eligibility definition.

Suggested pure mutation helpers:

```ts
export function requestFoundationalReview(
  memory: MemoryFile,
  selector: DecisionSelector,
): DecisionReviewMutation

export function confirmFoundationalReview(
  memory: MemoryFile,
  decisionId: string,
  reviewedAt: string,
): DecisionReviewMutation

export function supersedeHumanAuthority(
  memory: MemoryFile,
  args: {
    authorityId: string
    candidateId: string
    reviewedAt: string
  },
): DecisionReviewMutation
```

These functions are synchronous and contain no I/O. Callers wrap them in `mutateMemory()`.

This keeps the PR 2 rule intact: no network or interactive work under the filesystem lock.

---

# 11. Add a real human-controlled CLI confirmation boundary

A plain CLI command is not enough if a model can execute ordinary shell commands. Trusted human review must require an interactive terminal confirmation that a non-interactive model/tool invocation cannot silently satisfy.

Create `src/cli.ts` with three commands:

```bash
tokenmaxxer decisions [--all] [--project <path>]
tokenmaxxer promote <decision-id> [--project <path>]
tokenmaxxer supersede <candidate-id> --replaces <authority-id> [--project <path>]
```

Default project is the absolute `process.cwd()`. `--project` is resolved to an absolute path before passing into the shared storage-path logic.

## 11.1 `decisions`

Read-only; may run non-interactively.

Default output shows authoritative decisions with:

- ID;
- topic;
- decision;
- effective trust/provenance;
- foundational/requested state;
- timestamp.

`--all` additionally shows historical invalid rows, conflict candidates, lineage, and unresolved human conflicts.

If authoritative STATE is unavailable, distinguish that from "no memory" rather than using the read-only `readMemory()` collapse.

## 11.2 `promote <id>`

Flow:

```text
read authoritative state
        ↓
resolve exact current authority ID
        ↓
print exact topic + decision + provenance
        ↓
REQUIRE interactive TTY
        ↓
ask user to type the exact decision ID
        ↓
confirmation succeeds
        ↓
mutateMemory() acquires lock
        ↓
re-read newest state under lock
        ↓
re-resolve/revalidate same ID as authority
        ↓
set human review + foundational state
        ↓
commit revision N+1
```

Human confirmation happens **before** the project lock is acquired.

Inside the transaction, revalidate the exact ID again. If an idle write or other process changed/superseded the decision while the user was reading the prompt, fail closed with a `decision-changed-during-review` result.

On success:

```ts
foundational = true
foundational_requested = false
human_review = {
  channel: "interactive-cli",
  reviewed_at: reviewedAt,
}
provenance = {
  ...existing.provenance,
  extractor: "human",
  confidence: "human-reviewed",
}
```

Preserve the underlying source session, audit ID, and evidence references: the human is reviewing that source-backed decision, not inventing new source evidence.

## 11.3 Human confirmation requirements

For `promote` and `supersede`:

- require `stdin.isTTY` and `stdout.isTTY` (or an equivalent real interactive-terminal check);
- require the user to type the exact displayed decision ID/confirmation token;
- no `--yes`;
- no environment-variable bypass;
- no piped confirmation;
- no hidden auto-confirm path for tests.

Tests should inject an I/O adapter into CLI core logic rather than weakening production confirmation.

This is a product-level explicit-human-action boundary, not a cryptographic identity system. The guarantee is that TokenMaxxer itself will not treat an ordinary non-interactive model/tool invocation as human review.

## 11.4 Explicit human supersession

A trusted human foundational authority must still be changeable when the human intentionally changes architecture.

`supersede` is a distinct action, not ordinary promotion of an invalid row.

Requirements:

- `<authority-id>` is the current trusted human foundational authority;
- `<candidate-id>` is an invalid same-topic conflict candidate;
- candidate conflict metadata links it to the authority;
- interactive confirmation is required;
- transaction revalidates both exact IDs after confirmation.

On success:

1. old authority becomes `still_valid=false`, `foundational=false`, `superseded_by=<new-human-id>`;
2. candidate remains historical/invalid and receives `superseded_by=<new-human-id>`;
3. create a **new** human-reviewed valid authority with a new stable ID, copying the candidate topic/decision/rationale and source evidence;
4. set `derived_from_decision_id=<candidate-id>`;
5. set `human_review.channel="interactive-cli"` and human provenance.

Creating a new authority rather than reactivating the invalid candidate preserves the invariant that ordinary invalid decisions are never promoted in place and keeps the audit trail explicit.

---

# 12. Wire the CLI into both installation paths

The launcher currently only wraps OpenCode. Extend it without duplicating storage logic.

## 12.1 Build a CLI bundle

Add `src/cli.ts` as a tsup entry producing:

```text
dist/cli.js
dist/cli.d.ts
```

Add those files to the package `files` list.

The CLI bundle imports the shared reader/store/decision-review code. It must not implement its own STATE JSON writer or project-lock algorithm.

## 12.2 Update `bin/tokenmaxxer`

Dispatch:

```text
opencode      -> existing launcher behavior; TOKENMAXXER_LLM_EXTRACT=1
decisions     -> node <cli bundle> decisions ...
promote       -> node <cli bundle> promote ...
supersede     -> node <cli bundle> supersede ...
```

For an npm/package installation, prefer the bundle relative to the launcher (`../dist/cli.js`).

For the current raw installer layout, fall back to the installed OpenCode plugin directory copy (for example `~/.config/opencode/plugins/tokenmaxxer-cli.js`).

If the CLI bundle is absent, fail with a clear reinstall/update message. Do not silently fall back to modifying STATE in shell.

## 12.3 Update `install.sh`

Download the CLI bundle alongside server/TUI bundles using the existing installer mechanics.

This does **not** solve mutable-main/checksum distribution; that remains PR 10. PR 3 only ensures the new trust boundary is actually available to users of the current installer.

---

# 13. Foundational retention in `pruneOld()`

PR 3 must stop ordinary pruning from contradicting confirmed foundational state.

Define:

```ts
function retentionProtected(decision: Decision): boolean {
  return decision.foundational === true
}
```

Because the compatibility repair removes unverified pre-PR3 `foundational=true` promotion claims, post-repair `foundational` is a meaningful retention signal.

## 13.1 Invalid-decision pruning

Change:

```ts
filter(d => d.still_valid)
```

so invalid non-foundational history is removed first, while any still-foundational conflict record is retained.

Explicit human supersession clears `foundational` on the old authority, so deliberately superseded history becomes normally prunable again.

## 13.2 30-day pruning

Never age-prune a foundational decision.

## 13.3 10/5 pressure stages

Use deterministic protected-first selection:

```text
all foundational decisions
+ newest non-foundational decisions up to the ordinary target
```

If foundational count itself exceeds 10 or 5, keep all foundational rows; the numeric stage is a target for disposable rows, not permission to delete protected state.

## 13.4 Irreducible overflow

PR 8 will introduce the final typed `foundational-state-exceeds-budget` pruning contract.

Until then, PR 3 must choose safety over silent loss:

- `pruneOld()` may return a state still over the cap when protected state alone is irreducible;
- the existing `commitMemoryExact()` size guard rejects the commit;
- prior STATE remains intact;
- caller surfaces the existing bounded write/commit failure.

Do **not** silently delete a confirmed foundational decision to make the current 8KB cap pass.

---

# 14. Concurrency and TOCTOU rules

PR 2 remains the mutation boundary.

Every state-changing review action uses `mutateMemory()`.

## Model request

```text
LOCK -> re-read + verify exact authority + set requested -> commit -> UNLOCK
```

## Human promotion/supersession

```text
read for display
        ↓
interactive human confirmation (NO LOCK)
        ↓
LOCK -> re-read + re-resolve exact IDs + verify unchanged eligibility
        ↓
commit human review/supersession
        ↓
UNLOCK
```

If anything changed during the confirmation window, abort and require the user to inspect the new state.

Never hold the filesystem lock while waiting on stdin/TTY.

---

# 15. Required release-gate tests

These are minimum tests, not optional examples.

## Authority normalization / legacy repair

1. Topic normalization is case/whitespace/NFKC deterministic and exact (`auth` does not equal `authentication`).
2. Two equivalent valid heuristic rows resolve to one authority.
3. Heuristic X + agreeing LLM X resolves to one valid authority with one stable ID and stronger LLM provenance.
4. Heuristic X + agreeing LLM X + later heuristic Y leaves only Y authoritative.
5. Three duplicate-valid legacy rows normalize deterministically independent of array-map overwrite behavior.
6. Conflicting non-human legacy rows select the newest authority deterministically.
7. Exactly one trusted human foundational row wins over conflicting automated rows.
8. Multiple conflicting trusted human foundational rows produce **no automatic authority** and an explicit conflict.
9. Pre-PR3 `human-reviewed` row without `human_review` is reclassified to legacy + `foundational_requested=true` + `foundational=false`.
10. A newly constructed persisted `human-reviewed` row without `human_review` fails schema validation.

## Merge semantics

11. Heuristic equivalent observation does not create a duplicate authority.
12. Heuristic conflict supersedes all prior valid non-human same-topic rows, not one mapped index.
13. Heuristic conflict with trusted human authority creates an invalid candidate and leaves human authority unchanged.
14. Evidence-backed LLM equivalent observation upgrades/enriches the same authority in place.
15. LLM conflict with heuristic authority remains an invalid conflict candidate.
16. LLM conflict with trusted human authority remains an invalid conflict candidate.
17. Evidence-backed LLM conflict may supersede legacy-only authority according to the documented trust rule.
18. Extraction `foundational` signal only sets `foundational_requested`, never trusted foundation/human provenance.

## Reader / model tool

19. `recall_decision` exposes stable decision IDs.
20. Reader never returns two authorities for one normalized topic, even from duplicate-valid raw memory.
21. `get_project_state` surfaces unresolved human authority conflict without dumping all history.
22. `recall_promote({decision_id})` sets only `foundational_requested=true`.
23. Invalid exact ID cannot request promotion.
24. Existing but non-authoritative duplicate ID cannot request promotion.
25. Already trusted human foundational target is a no-op.
26. Topic compatibility succeeds only for one unambiguous exact normalized authority.
27. Topic compatibility refuses ambiguous/unresolved state.
28. Model tool cannot produce `extractor="human"`, `confidence="human-reviewed"`, or `human_review`.

## Human CLI

29. `tokenmaxxer decisions` lists authoritative IDs and requested state.
30. `tokenmaxxer decisions --all` shows invalid conflict candidates and lineage.
31. Non-interactive `tokenmaxxer promote` refuses to mint human trust.
32. Piped confirmation is refused.
33. Interactive confirmation with wrong/cancelled ID leaves STATE byte-for-byte unchanged.
34. Interactive confirmation of the exact current authority creates human review + foundational state transactionally.
35. Human promotion preserves underlying source/audit/evidence provenance while changing extractor/confidence to human-reviewed.
36. If target is superseded between display and confirmation, transaction revalidation aborts without promoting stale ID.
37. Concurrent idle write + CLI promotion both survive and revision advances for both logical mutations.
38. `supersede` refuses unrelated-topic candidate.
39. `supersede` refuses a candidate not linked to the current human authority.
40. Successful human supersession invalidates/unfoundationalizes old authority, preserves candidate history, creates one new human authority, and leaves exactly one authority for the topic.

## Pruning

41. A 31-day-old confirmed foundational decision survives age pruning.
42. 10-decision pressure keeps all foundational decisions before recent non-foundational rows.
43. 5-decision last-resort pressure keeps all foundational decisions before recent non-foundational rows.
44. Explicitly superseded old human authority (foundational cleared) becomes normally prunable.
45. Irreducible protected state over 8KB causes commit failure and leaves prior STATE intact; no foundational row is silently removed.

## Packaging / launcher

46. Build produces non-empty `dist/cli.js` with no generated chunk imports under the repository's bundle strategy.
47. Launcher dispatch preserves existing `tokenmaxxer opencode` behavior.
48. Launcher routes `decisions/promote/supersede` to the CLI bundle.
49. Installer syntax remains valid and installs the CLI bundle path expected by the launcher.

---

# 16. Implementation order

Implement in waves so each semantic boundary is testable independently.

## Wave 1 — failing regression fixtures

Before production changes, add failing tests for:

- agreeing LLM duplicate authority;
- later heuristic leaving stale duplicate valid;
- invalid/stale topic promotion;
- model tool minting human-reviewed;
- 31-day foundational pruning;
- old unverified human-review claim;
- non-interactive human promotion refusal.

Do not begin by updating snapshots to the desired output.

## Wave 2 — schema + compatibility repair

- add review/history fields;
- add schema consistency refinement;
- repair unverified pre-PR3 human-review claims in `loadAndMigrate()`;
- migration tests.

## Wave 3 — decision authority module

- normalization;
- trusted-human predicate;
- reconciliation;
- duplicate/conflict rules;
- pure authority tests.

## Wave 4 — merge integration

- extract `mergeDecisions()`;
- remove one-index topic map logic;
- implement heuristic/LLM rules;
- expand merge tests.

## Wave 5 — authority-aware reads + review request tool

- IDs in recall;
- conflict rendering;
- model tool exact-ID request semantics;
- temporary topic compatibility path;
- remove direct human provenance mutation from tool code.

## Wave 6 — human CLI

- decision-review pure helpers;
- `src/cli.ts`;
- TTY confirmation adapter;
- TOCTOU revalidation;
- explicit supersession;
- launcher/build/installer wiring.

## Wave 7 — foundational pruning

- protect foundational rows across ordinary prune stages;
- verify irreducible over-cap failure remains fail-closed;
- do not implement PR 8's final typed budget result yet.

## Wave 8 — adversarial/integration pass

- concurrent idle + promotion;
- duplicate legacy state through real reader;
- CLI build/launcher smoke;
- full suite and documentation.

Maintain `docs/CRIP/PR-3/blockers.md` as an append-only implementation decision/blocker log once implementation begins, following the PR 2 convention.

---

# 17. Out of scope

Do not pull these into PR 3:

- PR 4 host-client closure / peer dependency lower bound / general tool argument bounds;
- PR 5 immutable source transcript identity and truthful idle outcomes;
- PR 6 removal of LLM mutation rights for current task/files/blockers/next steps;
- PR 7 compaction augment-vs-replace and anti-drift prompt contract;
- PR 8 final guaranteed prune result type and independent injection budget;
- PR 9 compaction/diagnostic artifact redesign;
- PR 10 immutable release/checksum installer architecture.

PR 3 may touch `install.sh` and package build entries **only** to make its human review CLI reachable through existing supported installation paths.

---

# 18. Verification commands

At minimum:

```bash
npm ci
npm test
npx tsc --noEmit
npm run build
bash -n install.sh
```

Also verify the CLI bundle explicitly:

```bash
test -s dist/cli.js
```

and extend the existing self-contained/generated-chunk build check to include `dist/cli.js`.

Run the authority/merge/review/concurrency subsets repeatedly (minimum 5 adversarial repetitions) before the oracle handoff.

---

# 19. Oracle handoff checklist

Before creating `docs/CRIP/PR-3/oracle-investigation.md`, the implementation team should provide:

- implementation commit range;
- exact code baseline;
- full CI run ID/result;
- total test count;
- PR 3 blocker/decision log;
- summary of compatibility repair behavior for old `human-reviewed` rows;
- confirmation that model tool code contains no human-trust mutation;
- confirmation that human confirmation is outside the project lock;
- confirmation that the transaction revalidates the exact ID after confirmation;
- confirmation that no ordinary prune stage deletes current foundational rows;
- the exact CLI commands and installed bundle path.

The oracle should specifically attack:

1. duplicate-valid legacy states;
2. agreeing LLM then later conflicting heuristic;
3. stale/invalid exact-ID review requests;
4. model attempts to mint human trust;
5. non-interactive shell attempts to invoke human promotion;
6. TOCTOU between human display and confirmation;
7. automation conflicts with human foundation;
8. explicit human supersession races;
9. pruning under high foundational pressure;
10. CLI/install path behavior in both npm-relative and raw-installer layouts.

---

# 20. Definition of done

PR 3 is ready for independent review when all of the following hold:

```text
- one normalized topic exposes <= 1 authority;
- agreeing observations corroborate one stable ID instead of duplicating it;
- conflicting automated observations cannot silently replace human foundation;
- recall exposes exact IDs;
- model promotion is only a request;
- trusted human review is structurally impossible without interactive review metadata;
- pre-PR3 unverified human claims are conservatively reclassified for review;
- human confirmation occurs outside the lock and revalidates inside the transaction;
- invalid/non-authoritative IDs cannot receive ordinary promotion;
- explicit human supersession has a preserved lineage/audit trail;
- ordinary pruning preserves current foundational decisions;
- full CI and adversarial concurrency tests are green.
```

At that point `still_valid`, `foundational`, `foundational_requested`, and `human-reviewed` each have one clear meaning, and TokenMaxxer can proceed to PR 4 with a trustworthy decision layer.