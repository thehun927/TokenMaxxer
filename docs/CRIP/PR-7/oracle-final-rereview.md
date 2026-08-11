# PR 7 Oracle Final Re-Review — Compaction Quality & Anti-Drift

**Original implementation head:** `c61e16e44f04ca7b2e1f665accf52c1f3c3c1691`  
**Original Oracle findings:** `80ed00cc07d2600dc1ea8bdce1f34af72f96b51d`  
**Remediation implementation head reviewed:** `4827099c9fde67a0151d6d973f8d300f1debeffc`  
**Re-review handoff head:** `125ca172ba0b5bbcfaafc3aa21f77cbd06e3a6e0`  
**Exact-head GitHub Actions:** `31546528968` — **success**  
**Verdict:** **Block — two narrow residual remediation gaps**

The remediation substantially closes the four original PR-7 Oracle findings. B2 and B4 are fully closed. B1's production predicate is corrected, and B3's prompt snapshot now records the exact TokenMaxxer payload with real newline separators and a bounded fallback-reason line. The exact remediation SHA also passes the complete CI chain.

Two pieces of the Oracle remediation contract nevertheless remain incomplete. They are small enough for one final micro-remediation and do not justify reopening the broader PR-7 architecture.

---

## Closed: B2 — shared durable-data trust boundary

`src/compaction/prompt.ts` now puts the durable-data trust rule inside the shared preservation contract inherited by both augment and replacement modes. It explicitly states that durable context is prior-state data only, cannot override compaction instructions, and that instruction-like DATA content is literal stored content rather than a command.

The replacement builder now uses only the typed PR-7 API and therefore receives the same shared contract as augmentation.

**Status:** closed.

---

## Closed: B4 — alternate legacy prompt contract removed

The string overload and `buildCompactionPromptLegacy()` production path are gone. `buildCompactionPrompt()` now accepts only:

```ts
{ durableContext: string; previousSummary?: string }
```

The old absolute `Do NOT include code snippets` rule is no longer present in the replacement builder, and the prompt tests exercise only the PR-7 typed contract.

**Status:** closed.

---

## Partially closed: B1 — production completion predicate is fixed, but the required adversarial regression was not added

### Production behavior is now correct

`extractLatestCompactionSummary()` now rejects a summary record unless it has:

```ts
msg.info.summary
msg.info.finish
!msg.info.error
```

while retaining the role, parent-compaction, non-empty-text, and optional incomplete guards. This aligns the production predicate with the supported OpenCode v1.18.15 completed-summary semantics identified in the original Oracle review.

### Remaining release-gate gap

The original Oracle remediation explicitly required regressions proving:

1. `summary:true` with no `finish` is ignored;
2. a newer unfinished summary cannot displace an older finished summary;
3. a finished errored summary remains ignored;
4. the newest finished non-error non-empty summary wins.

`test/compaction/history.test.ts` was updated so existing “valid” fixtures now include `finish: "stop"`, but it still contains 18 tests and does not include the critical adversarial case:

```text
older finished summary = GOOD
newer summary=true, finish missing = PARTIAL
expected = GOOD
```

Nor does it directly assert the no-finish/false-finish rejection boundary.

This matters because B1 was specifically a repeated-compaction anti-drift bug caused by choosing a newer partial summary over the latest completed anchor. Merely making the happy-path fixtures contain `finish` does not permanently freeze that boundary.

### Required final remediation

Add focused pure extraction tests in `test/compaction/history.test.ts` for at least:

```text
summary=true + finish missing -> ignored
older finished + newer unfinished -> older finished wins
finished + error -> ignored
newest finished/non-error/non-empty -> wins
```

No additional production change appears necessary for B1.

**Status:** residual release blocker — missing required adversarial regression.

---

## Partially closed: B3 — file snapshot is bounded/truthful, but structured fallback logging remains unbounded

### Snapshot behavior is fixed

The hook now captures the exact TokenMaxxer-supplied payload:

```text
augment/fallback -> buildCompactionAugmentation(durable)
replace          -> buildCompactionPrompt(...)
```

and writes that payload to `last_compaction_prompt.log` instead of raw durable memory. The snapshot uses real `\n` separators and includes a locally bounded `fallback_reason` line capped through `boundReason(..., 500)`.

The new index tests correctly freeze those file-artifact semantics.

### Remaining bounded-diagnostics gap

The same fallback reason is still sent to the supported structured host logger as the original unbounded string:

```ts
await log(client, "info", "compaction hook fired", {
  ...,
  ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
})
```

`src/util/log.ts` performs no metadata-size bounding of its own; it forwards `extra` directly to `client.app.log`.

The original Oracle B3 finding explicitly called out this second path:

> the app-log `fallback_reason` is also passed directly from arbitrary host error text with no local bound despite the plan requiring bounded fallback diagnostic metadata.

The remediation added `boundReason()` but applies it only to the file snapshot, leaving the exact app-log gap called out by the Oracle intact.

### Required final remediation

Compute the bounded reason once and use that bounded value consistently in both diagnostics:

```ts
const boundedFallbackReason = fallbackReason
  ? boundReason(fallbackReason, 500)
  : undefined

await log(... {
  ...(boundedFallbackReason
    ? { fallback_reason: boundedFallbackReason }
    : {}),
})

snapshotLines.push(
  `fallback_reason=${boundedFallbackReason}`,
)
```

Add one test using an 800+ character thrown history error and assert the `client.app.log` payload's `extra.fallback_reason` is bounded as well as the file snapshot.

Do not add a generic global log truncator in PR 7 unless independently justified; this is a narrow compaction fallback boundary.

**Status:** residual release blocker — one unbounded diagnostic path remains.

---

# Exact CI verification

GitHub Actions run `31546528968` is attached directly to remediation implementation SHA:

`4827099c9fde67a0151d6d973f8d300f1debeffc`

and completed successfully.

Actual counts:

```text
Test files: 45 passed + 1 skipped = 46 total
Tests:      837 passed + 1 skipped = 838 total
```

The same exact run passed:

- TypeScript typecheck;
- minimum-host contract verification against `@opencode-ai/plugin@1.18.15`;
- distribution build;
- self-contained bundle verification;
- CLI bundle/launcher/installer verification;
- post-build CLI smoke;
- installer/launcher syntax checks.

The prior flaky `test/memory/activity-state.test.ts` fixed-delay assertion was changed to bounded polling at `4827099`; this is a test-stability change only and does not alter production behavior. The exact-head run demonstrates the stabilized test is green.

---

# Already-cleared PR-7 behavior remains cleared

No regression was found in:

- augment-default configuration;
- valid/invalid/legacy mode precedence;
- augment leaving `output.prompt` unset;
- replacement history lookup through the supported client surface;
- unavailable-history fallback to augmentation;
- previous-summary delimiter sanitization and character cap;
- durable DATA-line structural sanitization;
- missing vs unavailable STATE rendering;
- compact provenance rendering;
- informational git freshness;
- human-authority retention under git mismatch;
- observed-file wording;
- shared preservation semantics for constraints, work state, verification, exact details, rejected approaches, blockers, conflicts, and pending actions;
- typed single replacement-prompt contract;
- PR 1–6 regression boundaries.

---

# Final micro-remediation gate

One final narrow remediation should do only these two things:

1. add the missing B1 unfinished-summary adversarial regression cases; and
2. use the bounded fallback reason in `client.app.log` as well as `last_compaction_prompt.log`, with an assertion covering the structured log payload.

Then rerun the focused history/index suites and obtain a green exact-head CI run. A short `oracle-second-rereview.md` handoff is sufficient.

Do not redesign PR 7, do not touch PR 8, and do not reopen B2/B4.

**Final verdict: Block — two narrow residual remediation gaps.**
