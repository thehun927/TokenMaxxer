# TokenMaxxer — Post-CRIP Comprehensive Adversarial Review

> **Review date:** 2026-08-13  
> **Repository:** `thehun927/TokenMaxxer`  
> **Audited main baseline:** `38f7ca0ce0e32f55979f9dd548c3d2990b115bd7`  
> **Audited production/release source tree:** `c5b2cd2f0bcc56ad41ac2b9b4f335019990f75b9`  
> **Original assessment:** [`assessment.md`](./assessment.md)  
> **CRIP program status:** **Complete — Ship, 10/10**

## Executive verdict

CRIP materially succeeded. The original codebase contained multiple ways to lose durable memory, create ambiguous decision authority, mint false human trust, accept weak LLM provenance, overrun storage/injection budgets, misreport state, and ship mutable/unverified release artifacts. The post-CRIP implementation eliminates the majority of those failures at their canonical boundaries and has substantially stronger tests, durable state semantics, trust enforcement, host isolation, compaction behavior, diagnostics, and release construction.

This adversarial review does **not** find a return of the original Critical failures in the normal canonical path. It does, however, find several places where the new invariants are narrower than their documentation implies or where a secondary surface bypasses the canonical primitive.

**Post-CRIP residual/new finding profile:**

| Severity | Count |
|---|---:|
| Critical | **0** |
| High | **3** |
| Medium | **6** |
| Low / maintainability | **2** |

The three High findings are the important result of this review:

1. **A1 — physical project identity is not canonicalized.** Two path aliases to the same physical repository can acquire different cross-process locks and different global fallback namespaces, recreating the original I1 lost-update failure under a symlink/alias condition.
2. **A2 — compaction bypasses the decision-authority/trust resolver.** Recall is authority-aware, but automatic durable-context injection filters raw `still_valid`/`foundational` rows and can therefore inject contradictory same-topic rows or over-prioritize untrusted legacy foundational state.
3. **A3 — completed-source idempotency has a cross-process TOCTOU window.** The first heuristic transaction does not re-check completion on its lock-read base, so a call can return `cache-hit` after it actually committed a heuristic revision.

CRIP should remain recorded as **10/10 Complete — Ship**. These findings are a post-program hardening tranche, not evidence that the ten workstreams were fictitious or unreviewed. But the reliability invariants should no longer be described as universally satisfied until A1–A3 are remediated.

---

# 1. Review scope and method

This pass started from the original [`assessment.md`](./assessment.md), reconstructed every named finding, and then independently traced the current implementation rather than trusting PR closeout prose.

The review covered:

- project identity and storage path derivation;
- local/global STATE authority and typed read failures;
- process-local and cross-process serialization;
- revision ownership and atomic replacement;
- decision authority, conflict quarantine, exact IDs, human review and lineage;
- LLM evidence/trust contracts, audits, cache and source completion;
- source-version idempotency across reload and concurrency;
- memory budget fitting and protected retention;
- compaction sanitization, authority selection, byte ceilings and anti-drift;
- host/client boundary and minimum-version verification;
- recall recency and file-operation semantics;
- diagnostics/status/artifact persistence;
- TMTUI commit-pulse telemetry and its release-gate tests;
- generated distribution/package/reproducibility gates;
- installer integrity/transaction semantics;
- real `v0.1.0` GitHub Release behavior, not only structural workflow tests.

The review deliberately attacked boundary assumptions: different processes, different path spellings for the same project, schema-valid legacy states, stale-but-valid rows, first non-git run, old completed sources after ledger pressure, absent host-health surfaces, asynchronous telemetry, and post-publication GitHub behavior.

---

# 2. Original assessment — post-CRIP status matrix

| Original | Original concern | Post-CRIP status | Adversarial conclusion |
|---|---|---|---|
| **I1** | Cross-process lost updates | **Partially closed** | Canonical project paths are serialized correctly by the filesystem project lock. **A1** shows physical aliases can derive different locks for the same underlying STATE file. |
| **C1** | Local/global storage authority | **Mostly closed** | Local/global candidates are both read and resolved by revision → mtime → local tie-break. **A1** can still split one physical project across multiple global namespaces. |
| **I8** | Unreadable treated as missing | **Closed** | `readMemoryState` has typed `ok | missing | unavailable`; mutation fails closed on unavailable. |
| **I2** | Multiple valid authorities per topic | **Partially closed** | Merge and recall use centralized authority resolution. **A2** shows compaction directly consumes raw valid rows instead of the authority view. |
| **I3** | Promote stale invalid decision | **Closed** | Review is exact stable-ID based and revalidated inside the mutation transaction. |
| **I4** | Model can mint `human-reviewed` | **Closed** | Model-callable path can request review only. Trusted human foundation requires interactive CLI proof. |
| **I5** | Foundational state silently pruned | **Core closed** | Budget fitting protects foundational/conflict/operation-required decisions and fails typed when irreducible state cannot fit. **A2** identifies a trust-classification caveat: raw legacy `foundational=true` also receives protection. |
| **I6** | LLM trust incomplete for non-decision facts | **Closed** | Durable LLM semantic authority is decisions-only. `current_task` and `active_files` accept only heuristic/legacy durable provenance. LLM decisions require transcript evidence. |
| **I7** | Cache/source idempotency self-invalidates | **Partially closed** | Source identity is separated from prompt identity and final LLM completion is atomic. **A3** finds a first-heuristic TOCTOU; **A4** finds the durable completion horizon is only ten source versions. |
| **G3** | Host client boundary wrong | **Closed** | Tools close over the plugin client; invocation directory/worktree and host file API are used. |
| **N1** | Host support overstated / health fail-open | **Partially closed** | Peer floor is now `>=1.18.15 <2.0.0` and minimum-host compile is real. **A6** retains a fail-open branch when the health surface is absent without proving the runtime is the verified pinned contract. |
| **G5** | Recall marks every decision recent | **Closed** | Recency comes from structured completed recall input and authority-aware result IDs. |
| **C2** | Failure reported as success/heuristic-only | **Partially closed** | Public idle outcomes are typed and centralized. **A3** can still return `cache-hit` after a heuristic durable mutation. |
| **G4** | No total compaction injection budget | **Closed for bytes/sanitization** | Automatic durable block is deterministic, sanitized and bounded to 4,096 UTF-8 bytes. **A2** is a semantic-authority problem, not a byte-budget regression. |
| **I9** | Non-git state records `/` | **Mostly closed** | Durable storage/state uses the resolved directory. **A5** shows first-run LLM canonical prior still constructs `emptyMemory(worktree)` and can expose `/` in the prompt identity. |
| **I10** | HEADER failure overturns successful STATE | **Closed** | HEADER is derivative best-effort after successful STATE mutation. |
| **I11** | Atomic temp-name collision | **Closed** | Atomic writes use unique randomized temp siblings instead of PID-only naming. |
| **I12** | Prune result can still exceed 8 KB | **Closed** | `fitMemoryToBudget` is central and exact; commit rejects any representation above 8,192 UTF-8 bytes. |
| **I13** | Mutable/unverified installer | **Core closed** | Release installer is exact-tag pinned, verifies `RELEASE.json` + SHA256 manifest, stages before mutation and rolls back transactionally. The first real release is now immutable and attested. **A8/A9** are release reliability/portability residuals. |
| **G6** | Audit/health writes silently swallowed | **Substantially closed** | Required audit guard fails closed before prompting; optional terminal/health writes use typed transactions and bounded warnings. |
| **G7** | Reads/searches mislabeled edits | **Closed** | File activity is split into observed operation categories rather than one edit label. |
| **G8** | Last compaction process-global/local-only | **Closed for persistence** | Prompt/result artifacts are per-project, durable, local/global fallback aware and separately typed. Cross-process last-only ordering remains intentionally best effort. |
| **N2** | Status reports wrong memory path/size | **Core closed** | Status consumes authoritative selected path/source/revision/size. **A10** is a lower-severity decision-authority reporting mismatch. |
| **N3** | Mocks invent unsupported host fields | **Closed** | CI installs/verifies the real minimum host package and compiles its contract. |
| **N4** | Dist parity not enforced | **Closed** | `dist/**` is generated-only; CI validates exact inventory, reproducibility and package contents. |
| **N5** | Dependency audit unresolved | **Closed for release policy** | Release gate runs full-tree high/critical plus production-scope low audit; current production tree is clean. |
| **H1** | Nullable compaction setter mismatch | **Closed** | Compaction mode/output path no longer depends on the obsolete nullable setter design. |
| **CI missing** | Claimed no CI | **Original claim was false/stale** | CI is extensive. Real release execution nevertheless exposed **A7/A8**, proving lifecycle behavior still needs tests beyond structural assertions. |

---

# 3. Current invariant scorecard

The original CRIP implementation plan converged on seven program invariants. The post-CRIP state is:

| Invariant | Status | Reason |
|---|---|---|
| One authoritative durable storage state per project | **Partial** | Correct for one canonical path identity; **A1** can split a physical project across alias-derived namespaces. |
| One cross-process serialized mutation transaction per project | **Partial** | Correct for one canonical project key; **A1** can derive different locks for the same physical STATE file. |
| One authoritative valid decision per normalized topic | **Partial across surfaces** | Reader/merge paths are correct; **A2** automatic compaction does not consume the authority view. |
| One trustworthy meaning for every provenance confidence level | **Strong, with one priority caveat** | Human/LLM provenance is strongly enforced; **A2** raw `foundational` is still used as a retention/injection priority even without the human trust tuple. |
| One immutable processing identity per source transcript version | **Partial** | Identity itself is stable; **A3** races completion check and **A4** evicts proof after ten entries. |
| One bounded, sanitized durable-context injection policy | **Bytes/security closed; semantic authority partial** | 4,096-byte sanitized block is strong; **A2** can select the wrong semantic rows. |
| Repeated compaction preserves applicable constraints/state | **Strong** | Augment-default, previous-summary anchoring, fallback and anti-drift are implemented; subject to **A2** authority selection. |

---

# 4. High findings

## A1 — Project identity is lexical, not physical; path aliases can bypass the cross-process lock

**Severity: High**  
**Original findings affected:** I1, C1  
**Primary file:** `src/memory/paths.ts`

`resolveProjectPath()` fixes the original non-git `/` problem by selecting `directory` when the host worktree is unusable. But the selected project string is then used directly as durable identity:

```ts
export function resolveProjectPath(worktree: string, directory: string): string {
  if (!worktree || worktree === "/" || worktree === "") return directory
  return worktree
}

export function projectStorageHash(project: string): string {
  return createHash("sha256").update(project).digest("hex").slice(0, 16)
}
```

There is no `realpath()`/physical canonicalization step.

### Adversarial sequence

On a filesystem with `/alias/repo -> /real/repo`:

```text
Process A project key: /real/repo
Process B project key: /alias/repo

local STATE(A): /real/repo/.opencode/memory/STATE.json
local STATE(B): /alias/repo/.opencode/memory/STATE.json
                 -> same physical file

lock(A): ~/.config/opencode/memory/hash(/real/repo)/.state-lock
lock(B): ~/.config/opencode/memory/hash(/alias/repo)/.state-lock
         -> different physical locks
```

A and B can therefore both acquire their own lock, both read the same underlying local STATE, each produce `revision=N+1`, and last-writer-win via atomic rename. The exact failure I1 was designed to eliminate is reachable again through path aliasing.

The same lexical identity split also creates separate global fallback directories for one physical project.

### Why current tests miss it

Path tests prove deterministic hashing and ordinary non-git fallback, but do not create two aliases to one real directory and run child-process transactions through both identities.

### Required remediation

Define one canonical **physical project identity** once per plugin/session:

- resolve absolute path;
- use filesystem realpath when the project exists;
- define an explicit deterministic fallback when realpath cannot be obtained;
- derive global storage namespace and project lock from the canonical identity;
- keep user-facing/persisted display path separate if preserving the original lexical path is useful.

Acceptance test must create a real directory plus symlink alias, launch two processes against the two spellings, and prove both mutations survive with final revision `N+2` under one shared lock identity.

---

## A2 — Automatic compaction bypasses the authoritative decision view and the trusted-foundation predicate

**Severity: High**  
**Original findings affected:** I2, I5; trust-ladder/injection invariants  
**Primary files:** `src/compaction/durable.ts`, `src/memory/reader.ts`, `src/memory/decision-authority.ts`, `src/memory/budget.ts`, `src/memory/schema.ts`

CRIP created a strong central authority resolver. Recall explicitly consumes:

```ts
resolveDecisionAuthorities(mem.decisions).authorities
```

Automatic compaction does not. It currently uses:

```ts
const valid = (mem.decisions ?? []).filter((d) => d.still_valid)
const foundational = valid.filter((d) => d.foundational)
```

### Contradictory-authority attack

A schema-valid STATE can contain two distinct-ID, same-normalized-topic rows with `still_valid=true` and conflicting text. This is particularly relevant for legacy/pre-reconciliation state: `loadAndMigrate()` repairs malformed trust/IDs/provenance but does not rewrite every semantically conflicting same-topic group on read.

The result is surface divergence:

```text
recall_decision / project-state reader
    -> resolveDecisionAuthorities
    -> one deterministic authority (or zero under protected human conflict)

compaction durable injection
    -> raw still_valid filter
    -> can inject both contradictory rows
```

That violates the program's "one authoritative valid decision per normalized topic" invariant specifically on the highest-leverage automatic injection surface.

### Raw `foundational` also outranks the actual trust predicate

The canonical human-trust boundary is correctly strict:

```text
still_valid
AND foundational
AND extractor=human
AND confidence=human-reviewed
AND human_review.channel=interactive-cli
```

But compaction priority and budget protection use the raw `decision.foundational` boolean. The schema rejects malformed **human trust claims**, but it does not define the converse rule `foundational=true => trusted human tuple`. A legacy/heuristic-provenance row can therefore remain schema-valid with `foundational=true`; migration can preserve old foundational flags while assigning legacy provenance.

That row can receive:

- priority-5 automatic compaction treatment labelled conceptually as foundational;
- protected budget retention;
- irreducible "foundational-state-exceeds-budget" classification;

without being a trusted human-reviewed foundation.

This does not let a model mint `human-reviewed` provenance—CRIP correctly closed I4—but it weakens the meaning of the **foundational priority class**.

### Required remediation

- Build compaction decision candidates from `resolveDecisionAuthorities(...).authorities`, not raw `still_valid` rows.
- Treat priority-5 as `isTrustedHumanFoundational(decision)`, not `decision.foundational` alone.
- Define a migration/compatibility policy for legacy `foundational=true` rows:
  - either demote them to `foundational_requested=true`, or
  - retain the bit as legacy retention intent but never treat it as human authority.
- Make budget protection distinguish trusted human foundation from compatibility-only legacy retention.
- Add a cross-surface invariant test: the same MemoryFile given to recall and compaction must expose the same authoritative decision IDs; a quarantined conflicting-human topic must not auto-inject an automated authority.

---

## A3 — Completed-source fast path is checked outside the heuristic transaction, so `cache-hit` can commit

**Severity: High**  
**Original findings affected:** I7, C2  
**Primary file:** `src/memory/writer.ts`

The PR5 design correctly made `processed_sources` the completion authority and final LLM merge correctly rechecks it inside its transaction. The first heuristic transaction does not.

Current sequence:

1. Read authoritative state outside the transaction.
2. Check `findProcessedSource(existing, sourceVersionKey)`.
3. If absent, call `mutateMemory()`.
4. The callback immediately applies reference/heuristic merge to the **lock-read** `base`; it does not re-check the source marker.
5. After the heuristic commit, re-read state and check completion again.
6. If another process completed the source, return `cache-hit`.

### Adversarial interleaving

```text
B: pre-lock read says source S incomplete
A: acquires lock, completes source S, writes processed_sources[S]
B: acquires lock
B: transaction re-read base now CONTAINS processed_sources[S]
B: callback does not check it
B: merges heuristic state and commits revision +1
B: post-commit read sees processed_sources[S]
B: returns "cache-hit"
```

So the externally reported completed-source fast path is not a durable no-op. It can mutate current task/files/recency/decisions and advance revision before returning `cache-hit`.

The final LLM transaction already contains the correct pattern:

```ts
const completed = findProcessedSource(base, args.sourceVersionKey)
if (completed) return { kind: "noop", ... }
```

The heuristic transaction needs the same authority check.

### Required remediation

At the first line of the heuristic `mutateMemory` callback:

```text
if sourceVersionKey already exists in lock-read base:
    return typed noop/cache-hit
```

Then ensure that path causes:

- no heuristic merge;
- no revision bump;
- no HEADER rewrite;
- no audit/model work;
- no pulse;
- public outcome exactly `cache-hit`.

The acceptance test must use a barrier/fault-injection seam that completes the source **between the outer pre-read and B's lock acquisition**. Same-process queue coalescing is insufficient; this must exercise the filesystem lock/inter-process race.

---

# 5. Medium findings

## A4 — Durable completion proof has a ten-source horizon

**Severity: Medium**  
**Original finding affected:** I7  
**Files:** `src/memory/schema.ts`, `src/memory/source-processing.ts`

`MAX_PROCESSED_SOURCES = 10`. The eleventh distinct completed source evicts the oldest completion record.

Therefore "an already completed source version is a durable no-op across reload" is true only while the source remains in the ten-entry ledger. Replaying an older source version after enough newer completions makes it processable again.

This can cause repeat heuristic effects, repeat model spend, or stale observations re-entering current state. It is not a direct corruption bug, and the cap exists for valid 8 KB reasons, but the current absolute invariant wording is stronger than the implementation.

**Remediation decision:** either explicitly document a bounded idempotency horizon or design a more scalable exact completion representation. Any replacement must preserve changed-source processability and must not use a false-positive structure that can suppress legitimate new source versions.

---

## A5 — First non-git LLM canonical prior can still identify the project as `/`

**Severity: Medium**  
**Original finding affected:** I9  
**File:** `src/memory/writer.ts`

Durable non-git persistence is fixed. But `prepareIdleSource()` currently does:

```ts
const existing = existingState.memory ?? emptyMemory(worktree)
```

On a first non-git session where OpenCode supplies `worktree="/"`, no existing state means the LLM canonical prior gets `project_path: "/"`. Later durable heuristic processing correctly resolves the project and writes the real directory.

The residual affects prompt semantics and prompt identity/hash rather than durable STATE.

**Fix:** resolve the project once in preparation and call `emptyMemory(project)`. Add an LLM-enabled first-run non-git test asserting canonical prompt/state identity uses the directory.

---

## A6 — Missing host health surface still fails open without proving the runtime is the verified contract

**Severity: Medium**  
**Original finding affected:** N1  
**File:** `src/memory/llm-adapter.ts`

When `client.global.health` is present, the adapter validates healthy status and the full supported semver range. When the method is absent it returns:

```text
allowed=true
source=pinned-compatibility
reason=health-surface-unavailable
```

The comment says this is safe under the exact pinned `1.18.15` package contract, but the shipped peer range allows any host `>=1.18.15 <2.0.0`; the runtime branch does not prove that a no-health client is exactly the verified floor contract.

The risk is limited because structured output is optional and the adapter strictly validates returned envelopes. A drifted host should therefore fail extraction rather than corrupt arbitrary state. Still, the compatibility gate claims more certainty than it possesses.

**Fix:** only use pinned-compatibility when the runtime version/package identity can actually be proven; otherwise disable optional LLM extraction on an unknown no-health host while leaving heuristic memory fully operational.

---

## A7 — Release-blocking TMTUI telemetry test has a real timing race

**Severity: Medium**  
**Area:** test/release reliability  
**Files:** `test/memory/tmtui3-pulse-store.test.ts`, `src/memory/store.ts`, `src/memory/commit-pulse.ts`

The real `v0.1.0` tag workflow run `31662585041` failed because:

```text
EEXIST: file already exists, mkdir .../.commit-pulse
```

The test seeds state through `writeMemory()`, then immediately tries to make `.commit-pulse` a directory so the next marker write will fail. Production intentionally fires commit telemetry asynchronously:

```ts
void recordMemoryCommit(project)
```

So the test races the still-running successful seed pulse:

- if test `mkdir()` wins, the intended failure setup succeeds;
- if asynchronous marker creation wins, `.commit-pulse` is already a file and `mkdir()` gets `EEXIST`.

This is not a production STATE correctness failure; telemetry is explicitly best effort. It is a nondeterministic **release gate**, which is still material because a healthy immutable release should not depend on scheduler timing.

**Fix:** make the test establish its blocked marker state deterministically rather than racing a previous fire-and-forget pulse. Add repeat/stress execution of the focused telemetry tests.

---

## A8 — Post-publish immutable attestation verification assumes zero propagation delay

**Severity: Medium**  
**Original finding affected:** I13 operational closure  
**File:** `.github/workflows/release.yml`

The corrected real `v0.1.0` workflow run `31662898531` passed every safety gate through publication:

- immutable releases enabled;
- exact tag/version/commit/main ancestry;
- full test/type/build/audit/package/reproducibility validation;
- staging and release-set verification;
- draft creation;
- asset upload;
- exact inventory/checksum verification;
- draft publication.

It then immediately executed:

```bash
gh release verify "$GITHUB_REF_NAME"
```

and failed because GitHub had not yet made the release attestation queryable. The release is now visible as `immutable: true`, and the GitHub-generated release attestation now exists and covers the tag plus published asset digests.

This is therefore a workflow reliability problem, not a release-integrity failure: the irreversible secure operation succeeded but CI ended red because verification raced the platform's post-publication attestation availability.

**Fix:** bounded retry/backoff around the post-publish `gh release verify`, with a final fail-closed result after a reasonable timeout. Structural tests should require the retry/poll contract rather than merely requiring verify to be the next command.

**Operational caution:** once a release has published and become immutable, do not retry the whole create/upload/publish job blindly. Post-publish verification must be restartable independently of release creation.

---

## A9 — Installer checksum portability and shell portability are inconsistent

**Severity: Medium**  
**Original finding affected:** I13 portability, not integrity  
**File:** `install.sh`

The installer deliberately supports both:

```text
sha256sum
or
shasum -a 256
```

but checksum parsing uses:

```bash
declare -A seen=()
```

which requires Bash 4+ associative arrays. The script does not explicitly enforce/document a Bash 4+ minimum before reaching that logic.

Thus a platform can satisfy the script's checksum-tool portability branch but still fail because its `bash` is older than the shell feature set the script assumes.

This does not weaken checksum verification—failure is safe—but it makes the install compatibility contract less truthful than the implementation.

**Preferred fix:** remove associative-array dependency from manifest uniqueness checking and keep the installer portable. Alternative: explicitly guard `BASH_VERSINFO` and document Bash 4+ as a hard prerequisite.

---

# 6. Low / maintainability findings

## A10 — Status decision counts are raw, while recall is authority-aware

**Severity: Low**  
**Original finding related:** N2 diagnostics truthfulness  
**File:** `src/tools/status.ts`

Status currently reports:

```text
Decisions: <raw count> (<raw still_valid count> valid)
```

and takes provenance snippets from raw `mem.decisions.slice(0, 3)`. Recall/project-state reading uses `resolveDecisionAuthorities()`.

For a schema-valid legacy conflict state, status can therefore describe two raw valid rows while recall exposes one authority; under a protected human conflict it can show raw rows rather than the zero-authority quarantine view.

No mutation is affected. The fix is to report `authorities`, `conflicts`, and history/raw counts with explicit labels.

---

## A11 — `writer.ts` has become a reliability concentration point

**Severity: Low / maintainability**  
**Original assessment observation:** oversized writer/extraction modules  
**File:** `src/memory/writer.ts`

CRIP improved behavior but substantially increased orchestration density. `writer.ts` now owns source preparation, identity construction, heuristic extraction, operation activity, recency, queue/outcome lifecycle, audit persistence, model health, LLM orchestration, cache/completion logic, merge transactions and HEADER updates.

A3 is exactly the kind of defect large orchestrators produce: all primitives are individually correct, but one check occurs on the wrong side of a transaction boundary.

Do **not** refactor this before A1–A9 correctness fixes. Afterward, split along stable invariant boundaries:

```text
source lifecycle / idempotency coordinator
heuristic extraction + operation activity
LLM audit/model-health transaction helpers
high-level idle state machine
```

Keep transaction and authority primitives small and centralized.

---

# 7. What held up under adversarial review

The strongest result is not simply the test count; it is that many original attack paths now terminate at a single canonical fail-closed primitive.

## Storage and transactions

- Local and global STATE are both read.
- Higher revision wins; mtime and local preference are deterministic tie-breaks.
- Unreadable is typed separately from missing.
- Mutation re-reads bypass-cache under the project filesystem lock.
- Revision increments exactly once in the transaction.
- Budget fitting is central.
- Exact commit re-validates schema and exact UTF-8 byte size.
- Atomic writes use unique temp names.
- Lock stale recovery uses owner identity/nonce semantics rather than naive timeout deletion.

## Decision/trust model

- Normalized topic authority is centralized.
- Stable IDs are the human-review address.
- Duplicate decision IDs are rejected/repaired deterministically.
- A model cannot directly create human-reviewed trust.
- Trusted human foundation requires the full interactive review tuple.
- Conflicting trusted humans produce durable quarantine with zero automated authority.
- LLM decision provenance requires transcript evidence and retained audit identity.
- Non-decision durable semantic fields cannot carry LLM-corroborated provenance.

## Compaction/budgets

- Default behavior augments native compaction.
- Replace mode has previous-summary recovery and safe fallback.
- Durable memory is sanitized as DATA.
- Automatic durable block is capped at 4,096 UTF-8 bytes including framing.
- STATE is capped at 8,192 UTF-8 bytes at the actual committed revision.
- Required proof and protected decision IDs cause typed budget rejection rather than silent deletion.

## Host/diagnostics

- Host client is closed over from plugin input, not invented in ToolContext.
- Minimum host package contract is compiled in CI.
- File activity labels distinguish read/edit/write/search/shell-reference semantics.
- Status reads the authoritative selected memory file path/source/revision/size.
- Compaction prompt and result diagnostics are persisted separately and bounded.
- Required extraction audit guard fails closed before model prompting.

## Release integrity

The real first release is particularly useful evidence because it exercised platform behavior that unit/structural tests could not fully model.

At the time this review was completed:

- `v0.1.0` is the corrected annotated tag targeting `c5b2cd2f0bcc56ad41ac2b9b4f335019990f75b9`;
- GitHub Release `v0.1.0` is published and reports `immutable: true`;
- the release contains the staged asset set with GitHub-reported SHA256 digests;
- a GitHub-generated release attestation exists and binds the release/tag plus asset digests;
- the workflow's red conclusion is due to A8's immediate verification race after successful publication, not because the release remained mutable or unattested.

So the original I13 integrity failure is genuinely closed. The remaining release findings are reliability/portability cleanup, not a reason to delete or recreate the immutable release.

---

# 8. Recommended remediation order

## Hardening Wave A — restore universal core invariants

These three should be treated as one post-CRIP reliability tranche and independently reviewed:

### A.1 Canonical physical project identity

Own:

- `src/memory/paths.ts`
- project identity propagation/tests

Acceptance:

- physical repo + symlink alias map to one project storage identity;
- both aliases share one filesystem lock;
- two-process mutation ends at revision `N+2` with both updates;
- non-git and read-only fallback remain correct.

### A.2 Authority-aware compaction + trusted-foundation semantics

Own:

- `src/compaction/durable.ts`
- authority/trust helper reuse;
- budget trust classification/migration policy if required.

Acceptance:

- recall and compaction expose identical authoritative decision IDs;
- conflicting trusted humans inject no automated authority;
- raw legacy `foundational=true` cannot masquerade as trusted human priority;
- 4,096-byte deterministic injection and 8,192-byte storage invariants remain unchanged.

### A.3 In-transaction source completion recheck

Own:

- first heuristic transaction in `writer.ts`;
- cross-process idempotency tests.

Acceptance:

- completion inserted between outer pre-read and lock acquisition produces transaction `noop`;
- no revision/header/pulse/audit/model work;
- returned outcome `cache-hit` is literally a durable no-op.

## Hardening Wave B — release/lifecycle reliability

These are smaller and can follow quickly:

- **A7:** deterministic TMTUI telemetry-failure test.
- **A8:** bounded post-publish attestation retry/poll; make verification independently retryable.
- **A9:** portable checksum-manifest implementation or explicit Bash version contract.

Do these before relying on the next release workflow as a binary green/red oracle.

## Hardening Wave C — bounded semantics and compatibility decisions

- **A4:** explicitly decide whether ten-source idempotency is acceptable or redesign the ledger.
- **A5:** fix first non-git canonical prior.
- **A6:** make no-health runtime gating prove the pinned contract or fail optional LLM closed.
- **A10:** authority-aware status labels.
- **A11:** refactor writer only after behavioral fixes are frozen.

---

# 9. Suggested adversarial regression matrix

A post-CRIP hardening branch should add tests for cases the ten-PR program did not fully cover:

| Case | Required proof |
|---|---|
| Same physical project through real path + symlink | Same project hash/lock and final revision `N+2` |
| Same-topic schema-valid conflicting non-human rows | Recall and compaction expose one same authority |
| Persisted trusted-human conflict + automated row | Zero automatic decision injection for topic |
| Legacy `foundational=true` without human tuple | Never receives human-authority label/priority |
| Completion appears after pre-read but before heuristic lock | `cache-hit`, zero durable mutation |
| Replay source older than processed ledger capacity | Behavior matches explicitly documented idempotency policy |
| First non-git LLM-enabled idle | Canonical project path is directory, never `/` |
| No host health surface on unproven peer version | Optional LLM disabled; heuristic memory unaffected |
| TMTUI pulse failure test repeated many times | Deterministic pass; no timing dependence |
| Immutable release attestation delayed after publish | Bounded retry eventually verifies without re-running publication |
| Installer under minimum supported Bash | Either succeeds portably or exits with explicit prerequisite before mutation |

---

# 10. Final conclusion

The original assessment was directionally correct to focus on **boundary invariants**, and CRIP fixed most of them in meaningful—not cosmetic—ways. The current system is dramatically more trustworthy than the assessment baseline:

- durable writes are transactional rather than merely atomic;
- state authority is typed and revisioned;
- trust is explicit and evidence-bound;
- human review has a real interactive boundary;
- compaction/storage are byte-bounded;
- diagnostics are durable and separated;
- release artifacts are reproducible, checksummed, immutable and attested.

The remaining problems are mostly **second-order boundary failures created by assumptions around otherwise-correct primitives**:

```text
correct project lock      + noncanonical project identity  -> lock bypass
correct authority resolver + compaction raw-row filtering   -> semantic bypass
correct completion ledger + pre-lock completion check       -> TOCTOU mutation
correct immutable release + immediate attestation verify    -> red successful release
correct best-effort pulse + racing test setup               -> flaky release gate
```

That is exactly the class of issue a post-program adversarial audit should find.

**Final assessment:** CRIP achieved its main architectural objective, but A1–A3 should be treated as the next reliability gate before claiming the core invariants are universal across path aliases, legacy state, and cross-process source races. A4–A11 are important hardening/operational follow-ups, with A7/A8 worth fixing promptly because they directly affect release confidence.
