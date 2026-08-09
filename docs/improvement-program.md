# Improvement program

## Purpose and baseline

This document is the execution record for the ten Oracle findings that remain
after the current reliability work. It turns the reconciled review into a
dependency-ordered implementation program; it does not authorize any of the
implementation work in this documentation-only change.

The planning baseline recorded by the review is 192 passing tests and a clean
TypeScript check. The repository already builds self-contained server and TUI
bundles locally (`package.json` uses tsup with `--no-splitting`), but the public
raw-GitHub installation path still points at ignored build output. Durable
memory is schema version 3 and already has bounded audit, cache, and model
health fields. Those facts matter: the program should correct enforcement and
scope without inventing another memory format.

### Locked constraints

- Heuristic extraction remains the first and durable write path. A failed or
  disabled optional extraction must leave useful heuristic memory behind.
- LLM extraction is opt-in, structured-output-only, and evidence-backed. Only
  Zod-validated structured facts with resolvable reference/digest evidence may
  merge or create a reusable cache entry; prose and free-form JSON are never a
  fallback.
- Server memory is silent. It must not inject project text, current-task text,
  or truncated transcript text into the composer or system prompt.
- The optional TUI signal remains a separate module and a right-side status
  surface. No finding authorizes a prompt, toast, or left/main-panel UI.
- No paid model fallback, automatic LLM enablement, or host fork is introduced.
- This program is planning only. It authorizes no source, test, configuration,
  or generated-output implementation changes.

## Improvement register

### F1 — Raw-GitHub distribution cannot fetch the advertised bundles

- **Severity:** High / release blocker.
- **Evidence:** `.gitignore` excludes `dist/`; `install.sh` downloads
  `dist/index.js` and `dist/tui.js` from the `main` branch; `package.json`
  declares those paths in `main` and `exports`; `README.md` documents them; the
  current local `dist/` contains the build output but is not a repository
  artifact.
- **Impact:** A fresh user following the one-line installer receives a 404 or
  an unavailable plugin even though a local build works. The server and the
  right-side TUI fail as a distribution pair.
- **Desired behavior:** The repository contains the self-contained runtime
  bundles named by the installer, with no shared chunk dependency. Build,
  package metadata, installer URLs, and documentation all describe the same
  files. A clean checkout can be installed without a local TypeScript toolchain
  or an untracked build directory.

### F2 — The 8 KB state limit is advisory and pending audits can consume it

- **Severity:** Critical / durable-state integrity.
- **Evidence:** `src/memory/store.ts` and `src/memory/writer.ts` each define an
  8,192 limit, but compare JavaScript string length and only warn or continue
  after pruning; `src/memory/writer.ts` has the pruning order and final
  oversized path; `src/memory/schema.ts` caps `llm_extraction_audits` at 20;
  `src/memory/extract-llm.ts` uses a 120-second request timeout; migration and
  recovery are in `src/memory/migrate.ts` and `src/memory/store.ts`.
- **Impact:** Multibyte content can exceed the intended byte budget while
  appearing to fit. A process exit or timeout can leave `pending` audit guards
  that never expire, crowd out durable facts, or make a later state read fail
  schema validation. Persisting an oversized file weakens the compaction
  contract and can cause avoidable quarantine/data loss.
- **Desired behavior:** 8,192 UTF-8 bytes is a hard invariant at every durable
  write. Pending audits older than two request-timeout windows are reclassified
  as failed before pruning. Operational metadata is reduced before durable
  facts, and an unrepresentable state is rejected rather than written.

### F3 — Generated `HEADER.md` creates Git noise

- **Severity:** Medium / repository hygiene and contract clarity.
- **Evidence:** `src/index.ts` creates a first-session
  `.opencode/memory/HEADER.md`; `src/memory/writer.ts` regenerates it after
  writes; the root `.gitignore` does not ignore it; `docs/IMPLEMENTATION.md`
  and `docs/v1.1-plan.md` already describe memory as silent and not requiring a
  generated instructions header.
- **Impact:** Normal sessions can dirty a project with an unused generated
  file. The file must not become an instructions or composer transport, but
  that boundary does not by itself prove that the producer has no external
  consumer.
- **Desired behavior:** In Phase 2, add `.opencode/memory/HEADER.md` to the
  root `.gitignore` and remove only the already tracked copy with
  `git rm --cached`. Leave `generateHeader` and the first-run producer intact;
  any producer removal requires a separate, explicit external-consumer
  investigation. Existing `STATE.json` and explicit tools remain the durable
  interface, and generated headers are harmless because Git ignores them.

### F4 — Decision IDs use a non-cryptographic UUID substitute

- **Severity:** High / identifier correctness.
- **Evidence:** `src/memory/writer.ts` defines `cryptoRandomUUID()` with
  `Math.random()` and uses it when appending decisions; the function comment
  calls the result crypto-safe although it is not.
- **Impact:** IDs have weaker collision/unpredictability properties than their
  format implies. Collisions become more plausible in long-lived or concurrent
  state and can make promotion or invalidation target the wrong fact.
- **Desired behavior:** New decision IDs come from the platform cryptographic
  UUID API (`node:crypto` `randomUUID` or an equivalent host-supported native
  primitive). Existing IDs are read unchanged; no rewrite or migration is
  needed.

### F5 — Retained extraction-session IDs grow without a bound

- **Severity:** High / process-lifetime resource leak.
- **Evidence:** `src/memory/extract-llm.ts` stores every retained audit session in
  the module-level `retainedExtractionSessionIDs` `Set` and never evicts an ID;
  `src/index.ts` checks that set before the durable audit lookup. The durable
  fallback is `llm_extraction_audits` in `src/memory/schema.ts` and
  `src/memory/writer.ts`.
- **Impact:** A long-running OpenCode process retains an unbounded number of
  strings. The in-memory guard is only an optimization, but its leak is
  permanent for the process and obscures the intended reload-safe durable
  guard.
- **Desired behavior:** The process-local set is bounded and deterministic.
  Evicted IDs still use the current project's durable audit metadata as the
  reload/fallback guard, so bounding the optimization does not re-enable
  recursive extraction events.

### F6 — Model status can describe another project

- **Severity:** High / project isolation and operator trust.
- **Evidence:** `src/memory/extract-llm.ts` keeps `lastModelResolution` and
  evidence counters at module scope; `src/tools/status.ts` combines that global
  resolution with the current project's `STATE.json` and `model_health`.
  Durable health records are defined in `src/memory/schema.ts` and updated by
  `src/memory/writer.ts`.
- **Impact:** After activity in project A, a status call in project B can show
  A's selected provider/model or imply health that was never observed in B.
  Process-wide evidence totals are also easy to mistake for project-local
  facts.
- **Desired behavior:** Selected-model health/status is derived from the
  current project's durable `model_health` records. Process-local candidate and
  evidence counters, if retained for diagnostics, are explicitly labeled as
  process-wide and never presented as the current project's durable model
  status. Projects remain isolated without adding raw provider payloads.

### F7 — The activity marker triggers watcher and Git noise

- **Severity:** Medium / runtime hygiene.
- **Evidence:** `src/memory/activity-state.ts` writes
  `.opencode/.tokenmaxxer-memory-activity`; `opencode.json` ignores
  `.opencode/memory/**` but not this marker's exact path; the root `.gitignore`
  does not ignore the marker. The TUI reader is `src/tui.tsx` and its existing
  unit seam is `test/memory/activity-state.test.ts`.
- **Impact:** A timestamp-only heartbeat outside the ignored memory directory
  can wake the file watcher and appear as an uncommitted project change every
  few seconds during slow extraction. The status light is best effort, so this
  noise has no product value.
- **Desired behavior:** Keep the marker outside `.opencode/memory` so it does
  not collide with durable data, but ignore the exact root-project path in both
  `.gitignore` and `opencode.json` watcher rules. Malformed, stale, or missing
  markers continue to mean inactive; the TUI remains right-side only.

### F8 — Installer guidance still says 15,000 while current guidance says 25,000

- **Severity:** Medium / configuration consistency.
- **Evidence:** `install.sh` prints a `reserved: 15000` example; root
  `opencode.json`, `README.md`, and the current setup guidance use 25,000.
- **Impact:** A fresh install can cause users to copy a lower headroom value than
  the maintained recommendation, producing inconsistent compaction behavior
  and support reports that are difficult to compare.
- **Desired behavior:** One current recommendation, 25,000, appears in the
  installer output and normative documentation. Historical journal entries may
  retain the old value only when clearly labeled historical; they must not read
  as current instructions.

### F9 — Dead configuration, exports, stale plans, and empty directories remain

- **Severity:** Medium / maintenance correctness.
- **Evidence:** `memoryKey` is returned by `src/config.ts` and declared in
  `src/types.ts` but no runtime path consumes it; its obsolete contract remains
  in `docs/IMPLEMENTATION.md`. `src/inject/` and `src/opencode/` are empty.
  Confirmed source/test-uncoupled dead symbols are `getSize` in
  `src/util/fs.ts`, `extractToolOutputText` in `src/memory/writer.ts`,
  `getQueueStatus` in `src/memory/lock.ts`, `decodeProviderInventory` in
  `src/memory/provider-inventory.ts`, `buildEvidenceCandidateMap` and
  `buildEvidenceRefDigestMap` in `src/memory/extract-prompt.ts`, and
  `getLLMExtractionInFlightCount` in `src/memory/extract-llm.ts`. These sit
  alongside the unused `memoryKey` contract and the empty `src/inject/` and
  `src/opencode/` directories.
  Historical or superseded implementation claims remain in
  `docs/PLAN.md`, `docs/IMPLEMENTATION.md`, and selected package/build guidance
  in `README.md`.
- **Impact:** Users and future maintainers can believe directory-scoped memory
  exists when all paths use the resolved project key. Empty scaffolding and
  aliases increase search surface, while stale plans can cause implementation
  to regress the silent-memory boundary or build only one target.
- **Desired behavior:** After Phase 1, run a repository-wide reference check
  and then remove only the confirmed-unused `memoryKey`, dead symbols, and
  empty directories; do not silently implement a new keying mode. Bring stale
  plan/build/package statements into agreement with shipped behavior while
  preserving historical context where it is useful.

### F10 — `last_compaction.log` semantics are not explicit

- **Severity:** Low / diagnostics contract.
- **Evidence:** `src/index.ts` writes `.opencode/memory/last_compaction.log`
  through an atomic replacement after the compaction hook; `src/tools/status.ts`
  exposes a process-local `lastCompactionTimestamp`; public documentation did
  not state whether the file is a history or a snapshot.
- **Impact:** Operators may expect an append-only audit history, or interpret a
  missing/empty file after a restart or a different project as proof that the
  hook did not run. Unbounded logging would also create avoidable repository and
  privacy concerns.
- **Desired behavior:** Make the file a best-effort, project-local snapshot of
  the most recent successful hook write. Replacement is atomic and last-only;
  it is not a durable history. Status timestamps are process-local diagnostics,
  while the file survives process restart when its write succeeds.

## Resolved plan choices

These choices are fixed for planning and implementation unless an Oracle gate
finds a compatibility defect:

1. **Distribution:** Track the self-contained build artifacts required by the
   package and raw installer. The runtime contract specifically requires
   `dist/index.js` and `dist/tui.js`; the matching declaration outputs
   (`dist/index.d.ts` and `dist/tui.d.ts`) are tracked as well because the
   package exports them. Keep code splitting disabled and do not introduce a
   release service or package-publish system.
2. **State cap:** Enforce a hard 8,192-byte limit using UTF-8 byte length, not
   JavaScript character length. Before reducing durable facts, expire pending
   audits older than two `LLM_REQUEST_TIMEOUT_MS` windows, discard oldest
   completed audit metadata and other disposable operational metadata, then
   prune facts using the existing priority rules. If the final serialized state
   still exceeds the limit, fail closed and do not persist it.
3. **Marker:** Keep the activity marker at the existing project-root
   `.opencode/.tokenmaxxer-memory-activity` path, outside `.opencode/memory`, and
   add that exact path to the root `.gitignore` and `watcher.ignore`.
4. **Model status:** Treat the current project's durable `model_health` records
   as the source for selected-model health/status. Keep any process-wide
   resolution/evidence diagnostics clearly labeled and non-authoritative for a
   project status call. If the current project has no durable health row, report
   no selected health rather than borrowing the process-global selection. Do not
   add a durable field unless implementation proves one is necessary.
5. **Header:** Keep the existing generated-header producer and first-run
   placeholder. In Phase 2, add `.opencode/memory/HEADER.md` to the root
   `.gitignore` and remove only the tracked copy with `git rm --cached`; do not
   remove the producer without a separate explicit external-consumer
   investigation, and do not restore instructions or composer injection.

## The only two implementation decision gates

No other product decision is open in this program. These two defaults should be
confirmed at the named Oracle gates before code is merged:

1. **F10, last-compaction log:** **Recommended default: retain last-only
   semantics.** Keep one atomically replaced snapshot per project. Do not turn
   it into an append-only history unless an operator explicitly accepts the
   storage and diagnostic change.
2. **F5, retained extraction IDs:** **Recommended default: cap the process-local
   set at 256 IDs.** Evict the oldest insertion-order IDs when the cap is
   reached; retain durable audit lookup as the authoritative fallback. This
   bounds memory while preserving reload safety.

## Dependency-ordered delivery phases

Each phase has one implementation owner boundary, focused validation, a separate
commit shape, and an Oracle review. Do not start the next phase until the prior
gate is reconciled. The phase names are delivery boundaries, not additional
decision points.

### Phase 0 — local correctness and hygiene

- **Findings:** F4, F7, and F10. F3 header ignore/untracking and all F9 cleanup
  are deliberately deferred to Phase 2 with the distribution work, after the
  reliability changes have settled.
- **Owner boundary:** Core runtime fixer owns identifier generation, marker
  ignore rules, and status/log contract comments. No header producer, dead-code
  cleanup, memory pruning, model-selection, bundle, or installer behavior is
  changed here.
- **Dependencies:** None. Preserve the existing schema v3 and the existing
  heuristic/LLM boundary.
- **Likely files:** `src/memory/writer.ts`, `src/index.ts`, `src/tools/status.ts`,
  `.gitignore`, `opencode.json`, `test/memory/merge.test.ts`,
  `test/memory/writer.test.ts`, `test/memory/activity-state.test.ts`,
  `test/index.test.ts`, and `test/tools/status.test.ts`.
- **Commit shape:** `fix: clean memory runtime hygiene` — native IDs, exact
  marker ignores, and explicit last-only log behavior with focused tests.
- **Rollback:** Revert this commit. Existing UUID-shaped IDs remain readable;
  the kill switch `TOKENMAXXER_NO_PROMPT=1` remains available if compaction
  behavior is questioned. Phase 0 makes no change to the unused configuration
  option or directory-scoping contract.
- **Oracle Gate 1 — compatibility and behavior preservation:** Verify that
  existing state reads, decision promotion, silent server operation, and the
  separate right-side TUI still behave exactly as before. Also verify that
  marker ignores and last-only logging do not alter extraction or composer
  output.

### Phase 1 — durable invariants and project-correct status

- **Findings:** F2, F5, and F6.
- **Owner boundary:** Memory reliability fixer owns serialization, pruning,
  audit lifecycle, process-local bounds, and status reads. No package, installer,
  generated bundle, or documentation cleanup is mixed into this commit except
  the required tests and journal note.
- **Dependencies:** Phase 0 is complete. Use the existing v3 audit outcome and
  `model_health` fields; do not add a field or version migration merely to
  enforce a byte cap or scope a status read.
- **Implementation order:** First centralize UTF-8 size measurement and the
  fail-closed write guard; then expire stale pending audits and make metadata
  pruning precede durable fact pruning; then bound the retained-ID set; finally
  make status derive its model health from the current project's durable state.
  Re-read state after each asynchronous audit terminal update so pruning cannot
  resurrect stale metadata.
- **Likely files:** `src/memory/store.ts`, `src/memory/writer.ts`,
  `src/memory/extract-llm.ts`, `src/memory/schema.ts` only if a validation helper
  is needed, `src/tools/status.ts`, `test/memory/prune.test.ts`,
  `test/memory/schema.test.ts`, `test/memory/migrate.test.ts`,
  `test/memory/p0-a-reliability.test.ts`, `test/memory/writer-llm.test.ts`,
  `test/memory/extract-llm.test.ts`, `test/memory/model-health.test.ts`,
  `test/tools/status.test.ts`, and `test/index.test.ts`.
- **Commit shape:** `fix: enforce bounded durable memory and project status` —
  UTF-8 cap, stale audit lifecycle, 256-ID decision-gate default, and
  project-isolated status tests.
- **Rollback:** Snapshot a user's `.opencode/memory/STATE.json` before rollout.
  Revert the phase if valid states are rejected or cross-project status is
  wrong; keep heuristic extraction enabled and disable opt-in LLM extraction
  while investigating. Do not hand-edit a v3 file to restore an expired
  pending guard; a terminal audit state is safer than an immortal guard.
- **Oracle Gate 2 — data loss, migration, and cross-project correctness:**
  Review multibyte byte accounting, pending-audit expiry, metadata-first
  pruning, fail-closed writes, reload suppression, ID eviction, and two real
  project directories. Confirm that no schema bump or migration was smuggled
  in and that no global model/evidence diagnostic is reported as project data.

### Phase 2 — distribution, generated-file cleanup, and repository contracts

- **Findings:** F1, F3, F8, and all F9 cleanup. F9's confirmed dead-code
  register is `memoryKey`, `getSize`, `extractToolOutputText`,
  `getQueueStatus`, `decodeProviderInventory`,
  `buildEvidenceCandidateMap`, `buildEvidenceRefDigestMap`, and
  `getLLMExtractionInFlightCount`, plus the empty directories.
- **Owner boundary:** Release/repository hygiene fixer owns generated artifacts,
  installer smoke, CI, package metadata, and documentation reconciliation. It
  must not remove or alter the F3 header producer: only the ignore rule and
  tracked-copy untracking are in scope. Any producer change requires a separate
  explicit external-consumer investigation.
- **Dependencies:** Phases 0 and 1 must pass their gates. Build the exact
  post-Phase-1 source, so tracked bundles cannot hide a runtime change from the
  reliability review.
- **Implementation order:** After Phase 1, run a repository-wide reference
  check for every F9 symbol and only then remove the confirmed-unused symbols,
  `memoryKey`, and empty directories. Add `.opencode/memory/HEADER.md` to the
  root `.gitignore` and remove only the tracked copy with `git rm --cached`;
  leave `generateHeader` and the first-run producer unchanged. Update
  `README.md`, `docs/PLAN.md`, `docs/IMPLEMENTATION.md`, and `docs/v1.1-plan.md`
  to remove stale claims;
  align `package.json` paths and an explicit package file allowlist with the
  four dist outputs; correct `install.sh` to 25,000; add CI; build and track the
  self-contained artifacts; then run clean-checkout and installer smoke.
- **Likely files:** `.gitignore`, `src/config.ts`, `src/types.ts`,
  `src/util/fs.ts`, `src/memory/writer.ts`, `src/memory/lock.ts`,
  `src/memory/provider-inventory.ts`, `src/memory/extract-prompt.ts`,
  `src/memory/extract-llm.ts`, the empty `src/inject/` and `src/opencode/`
  directories,
  `package.json`, `install.sh`, `README.md`,
  `docs/PLAN.md`, `docs/IMPLEMENTATION.md`, `docs/v1.1-plan.md`,
  `.github/workflows/ci.yml`, the legacy `.opencode/memory/HEADER.md`, and
  generated `dist/index.js`, `dist/tui.js`, `dist/index.d.ts`, and
  `dist/tui.d.ts`. `package-lock.json` changes only if package metadata
  validation actually requires a lock update.
- **Package/CI contract:** Keep `main`, `exports`, and `bin` pointing at files
  that exist in the tracked bundle. Add a narrow package `files` allowlist for
  `bin`, `dist`, and the user-facing README; do not create a publish service.
  CI must run `npm ci`, `npm test`,
  `npx tsc --noEmit`, `npm run build`, verify both runtime bundles are nonempty
  and contain no split-chunk dependency, run `bash -n install.sh`, and perform
  an installer smoke in an isolated `HOME` against the raw-GitHub artifacts on
  the main branch.
- **Commit shape:** `chore: publish self-contained bundles and align repository contracts` —
  generated artifacts, package/installer/docs alignment, CI smoke, header
  cleanup, and reference-checked dead-code removal in one reviewable repository
  contract change. The header producer remains in the commit's source tree.
- **Rollback:** Revert the phase commit and restore the prior known-good
  bundles. Because installer downloads are atomic, a failed download leaves the
  user's old plugin file intact; a successfully downloaded bad bundle requires
  reinstalling the previous tracked bundle. Documentation and ignore-rule
  rollback is independent of durable state.
- **Oracle Gate 3 — published artifact and clean-worktree review:** Fetch both
  raw URLs from a clean checkout, import the server and TUI modules, run the
  isolated installer, inspect package contents, and verify a normal session
  leaves Git status clean after a memory write even though the generated
  `HEADER.md` remains present and ignored; the activity marker likewise creates
  no Git/watcher noise. Confirm the CI build is reproducible and that package/
  docs claims name both targets.

## Per-finding implementation and acceptance matrix

The commands below are implementation-phase checks, not commands to run for
this documentation-only change. Each row also includes the production check
needed beyond unit coverage.

| Finding | Implementation and automated acceptance | Manual production acceptance |
|---|---|---|
| **F1** | Build with `npm run build`; assert nonempty `dist/index.js` and `dist/tui.js`, the two declaration files named by `package.json`, and no chunk files/references. Run `npm ci`, `npm test`, `npx tsc --noEmit`, and `bash -n install.sh` in CI. Run the isolated installer smoke against the raw `main` URLs. | From a clean temporary `HOME`, run the published `install.sh`; confirm server and TUI files, dependencies, and TUI registration are installed. Start OpenCode and confirm the server loads and the right-side indicator module is present. |
| **F2** | Extend `test/memory/prune.test.ts`, `test/memory/schema.test.ts`, `test/memory/migrate.test.ts`, `test/memory/writer-llm.test.ts`, and `test/memory/p0-a-reliability.test.ts` for multibyte UTF-8, exact 8,192-byte boundaries, stale pending expiry, metadata-first pruning, and rejected oversized writes. Run `npm test -- test/memory/prune.test.ts test/memory/schema.test.ts test/memory/migrate.test.ts test/memory/writer-llm.test.ts test/memory/p0-a-reliability.test.ts`. | Create a large state containing non-ASCII facts and an interrupted/slow audit; after the two-timeout expiry, confirm `STATE.json` is valid JSON, `wc -c` is at most 8192, stale guards are terminal/prunable, current durable facts win over disposable metadata, and an impossible state is not written. |
| **F3** | Add `.opencode/memory/HEADER.md` to the root `.gitignore` and remove only the tracked copy with `git rm --cached`; do not remove `generateHeader` or the first-run producer without a separate external-consumer investigation. Update the silent-memory documentation and run `git diff --check`. | Run a memory write in a clean project, confirm the generated `HEADER.md` may still exist but `git status --short` is clean, and verify tools/compaction still recall state. Confirm no instructions or composer entry is added. |
| **F4** | Replace the local generator with native UUID generation and test the UUID v4 shape plus distinct IDs in `test/memory/merge.test.ts` and `test/memory/writer.test.ts`. Run `npm test -- test/memory/merge.test.ts test/memory/writer.test.ts`. | Create several decisions, inspect their IDs, and confirm they are native UUIDs without rewriting older state or changing promotion/invalidation behavior. |
| **F5** | Add a 257+ ID lifecycle test to `test/memory/extract-llm.test.ts` or `test/index.test.ts`; verify oldest insertion-order eviction and durable lookup for an evicted ID. Run `npm test -- test/memory/extract-llm.test.ts test/index.test.ts test/memory/p0-a-reliability.test.ts`. | Run enough opt-in extraction/audit activity to cross the cap, then confirm process memory remains bounded, a new idle event for an evicted audit is still suppressed by durable metadata, and a restart reconstructs the guard from current-project state. |
| **F6** | Change status tests to create two temporary project states with different `model_health` records and global diagnostics. Run `npm test -- test/tools/status.test.ts test/memory/model-health.test.ts test/memory/extract.test.ts test/index.test.ts`; verify process-wide counters are labeled and not used as selected-project health. | In two real projects, run extraction or health failures in only one; call `tokenmaxxer_status` in both and confirm each reports only its own durable model outcome/cooldown, while any process-wide evidence count is explicitly identified as such. |
| **F7** | Add exact path assertions to `test/memory/activity-state.test.ts`; run `npm test -- test/memory/activity-state.test.ts` and import the built TUI with `node --input-type=module -e "import('./dist/tui.js').then(m => { if (!m.default) process.exit(1) })"`. Confirm `.gitignore` and `opencode.json` contain the exact marker path. | During a slow idle/LLM job, confirm the muted right-side light blinks and stays in its slot. Confirm the marker is removed after completion, stale/malformed markers are inactive, and neither the watcher nor `git status` reports the heartbeat. |
| **F8** | Update the installer text and normative docs to 25,000 while labeling the journal's old value historical. Run `bash -n install.sh`, `git diff --check`, and the CI/docs consistency check that rejects an unlabeled normative `reserved: 15000`. | Run the installer and compare its printed tuning example with `opencode.json` and README guidance; confirm all current instructions say 25,000 and historical journal text is not presented as a recommendation. |
| **F9** | After Phase 1, run `git grep`/repository-wide reference checks for `memoryKey`, `getSize`, `extractToolOutputText`, `getQueueStatus`, `decodeProviderInventory`, `buildEvidenceCandidateMap`, `buildEvidenceRefDigestMap`, and `getLLMExtractionInFlightCount`; only then remove confirmed-unused symbols and empty `src/inject/`/`src/opencode/` directories. Reconcile `README.md`, `docs/PLAN.md`, `docs/IMPLEMENTATION.md`, `docs/v1.1-plan.md`, `package.json`, and build instructions. Run `npm test`, `npx tsc --noEmit`, `npm run build`, and the reference check. | Install/use the package from a clean checkout, call memory tools, and verify project resolution still uses the documented worktree/directory fallback. Read the current docs end to end for no directory-mode promise, no generated-header transport, preserved header generation, and both server/TUI outputs. |
| **F10** | Add a successive-compaction test in `test/index.test.ts` that proves atomic replacement leaves only the newest session entry; add status reset/meaning coverage in `test/tools/status.test.ts`. Run `npm test -- test/index.test.ts test/tools/status.test.ts`. | Trigger compaction twice in one project and inspect `last_compaction.log`: only the newest snapshot remains, it is readable after restart, and a missing log is treated as best-effort diagnostic absence rather than proof that the hook did not run. |

## Risks and non-goals

### Risks and mitigations

- **Pruning can discard information.** Take a state backup before Phase 1,
  preserve valid durable facts ahead of operational metadata, expire only stale
  pending guards, and fail closed rather than write an invalid oversized file.
  Add fixtures for every reduction order and multibyte data.
- **Pending expiry can race a slow provider.** Two full request-timeout windows
  is intentionally conservative. A late result must re-read state and may only
  merge through the existing evidence/cache checks; it must not turn an expired
  guard into an unvalidated cache hit.
- **Project status can regress during a reload.** Durable `model_health` is the
  authority; process-global resolution is diagnostic only. Test real temporary
  project paths and a module reset before the Oracle gate.
- **Tracked generated bundles can drift from source.** CI rebuilds them and
  checks exact self-contained outputs. The raw installer smoke is run from a
  clean checkout rather than trusting a developer's local `dist/`.
- **Ignoring the header can hide an external consumer.** The producer and
  first-run path therefore remain unchanged. `git rm --cached` removes only the
  tracked copy, and any producer change waits for a separate explicit
  external-consumer investigation.
- **Ignore rules can hide useful diagnostics.** They hide only generated
  runtime files; user-authored files and durable state remain available through
  explicit tools and documented paths.

### Non-goals

- No schema bump is allowed unless implementation introduces a genuinely new
  durable field. The current plan uses existing v3 audit outcomes and
  `model_health`, so no bump or migration is expected.
- No automatic LLM extraction, paid fallback, relaxed structured-output
  validation, evidence bypass, or heuristic replacement.
- No composer/system-prompt injection, generated instructions file, or TUI
  layout redesign; the indicator remains right-side only.
- No removal of `generateHeader` or its first-run producer is authorized by this
  program; that requires a separate explicit external-consumer investigation.
- No vector database, general RAG, per-turn history rewrite, OpenCode fork, or
  new release/publish service.
- No conversion of `last_compaction.log` into a transcript/history store and no
  persistence of the process-local evidence counters.
- No rewrite of existing UUIDs, no silent implementation of the unused
  `memoryKey` directory mode, and no broad refactor of the monolithic extractor
  beyond the bounded changes named above.
