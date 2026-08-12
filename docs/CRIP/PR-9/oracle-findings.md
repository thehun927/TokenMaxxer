# PR-9 Oracle Findings

**Verdict: Block**

Independent Oracle release-gate review for CRIP PR 9 — Accurate Diagnostics and Artifact Storage.

## Reviewed identities

- Planning baseline: `4df7873856e5f5714e45c120e1224e28450f4ee7`
- Concrete-plan/status head: `d0f803156bea258671d64438733d3b187b639be1`
- Final implementation: `29636b7f53abdac10fabeebbc574e5297268c426`
- CI-tested handoff child: `476b26f0370dffc00641d5cf28c6ec3209d66590`
- Final evidence head before Oracle: `5ff5a1bb0e82a06b6b17e5d9bb8395b34c918ab0`
- Handoff: `docs/CRIP/PR-9/oracle-investigation.md`

`476b26f...` differs from `29636b7...` only by append-only PR-9 evidence documentation (`blockers.md` and `oracle-investigation.md`), so the green CI run is valid evidence for the implementation source/test tree.

## What held up

The implementation correctly establishes the intended major PR-9 architecture:

- module-global `lastCompactionTimestamp` / `setLastCompaction` are removed from production;
- `experimental.session.compacting` records prompt/input diagnostics only;
- `session.compacted` is the successful-compaction observation used for result metadata;
- prompt and result artifacts are separate names and representations;
- the result artifact stores metadata only, not summary/conversation bodies;
- diagnostic artifact persistence is project-local first with hashed-global fallback;
- reads are uncached and resolve local/global candidates by mtime with project-local tie-break;
- result-artifact failure does not mutate STATE or pulse the TUI;
- status consumes persisted per-project artifacts rather than a process-global timestamp;
- terminal audit/model-health persistence remains best effort while audit-guard creation remains required/fail-closed;
- file activity now distinguishes reads, edits, writes, searches and shell references using completed tool calls only;
- current-session activity reasons replace stale generic file reasons;
- `.commit-pulse` / TMTUI semantics were not changed.

The blockers below are narrow diagnostics-integrity issues, not a rejection of the architecture.

---

## B1 — last-only compaction artifacts can regress under overlapping host callbacks

**Severity: release blocker**

The minimum supported OpenCode host does **not await plugin `event` callbacks**. In v1.18.15 the event listener iterates hooks and invokes:

```ts
void hook["event"]?.(...)
```

Therefore two `session.compacted` events for sessions in the same project may overlap.

TokenMaxxer currently handles a successful result as:

```text
receive session.compacted(A)
  -> await readPreviousCompactionSummary(A)
  -> build result
  -> blind atomic replace last_compaction_result.json
```

There is no per-project/artifact ordering guard around this last-only publication. `completed_at` is also created **after** the async history read rather than captured at event receipt.

A deterministic race is therefore possible:

```text
A completion event arrives first
A history read blocks

B completion event arrives second
B history read finishes quickly
B writes last_compaction_result.json = B

A history read resumes
A writes last_compaction_result.json = A

status now reports A as the "last completed compaction"
```

That is precisely the kind of durable diagnostic unreality PR 9 is intended to remove.

The same class exists for the last-only prompt snapshot when two compaction hooks in one project overlap: the artifact reflects whichever async hook finishes its diagnostic write last, not necessarily the newest observation.

The current regression `repeated successful compaction replaces last-only result` awaits event A fully before invoking event B, so it cannot detect the supported-host concurrency model.

### Required remediation

Introduce monotonic last-only publication semantics for compaction diagnostics.

Requirements:

1. capture an ordering observation at hook/event receipt **before** async history/diagnostic work;
2. perform history retrieval outside any filesystem lock;
3. before replacing a last-only artifact, serialize the short read/compare/write publication step per project/artifact;
4. never allow an older observation to replace a newer persisted observation;
5. cover same-process overlapping callbacks; do not assume OpenCode awaits `event` handlers;
6. preferably make the short publication ordering safe across two OpenCode processes using the same project as well, because these are durable per-project artifacts;
7. diagnostic ordering machinery must remain independent of STATE revision and must not hold the STATE mutation lock across history/network work.

Add adversarial tests with deferred promises:

- older result event starts first, newer finishes first, older finishes last -> newer remains persisted;
- equivalent overlapping prompt-hook case -> newer prompt observation remains persisted;
- publication failure remains non-fatal.

---

## B2 — prompt artifact hard bound and structured header can be defeated by raw metadata

**Severity: release blocker**

`buildCompactionPromptArtifact()` bounds the session ID and fallback reason, but it interpolates `requestedMode` and `effectiveMode` directly into the structured header.

In the production hook, `requestedMode` is the raw value of:

```ts
process.env.TOKENMAXXER_COMPACTION_MODE
```

when that variable is present. `loadOptions()` correctly maps an invalid value to effective mode `augment`, but the raw invalid value is still copied into the diagnostic header.

Consequences:

### 1. The declared 96 KiB builder invariant is not actually hard

A sufficiently large invalid environment value can make the **header alone** exceed `COMPACTION_PROMPT_ARTIFACT_MAX_BYTES`.

The implementation then computes a negative payload budget. Re-truncating the payload cannot shrink the oversized header, so `buildCompactionPromptArtifact()` can return content larger than 96 KiB. `writeDiagnosticArtifact()` then rejects it as `too-large`, and the prompt diagnostic disappears.

The release contract says the whole artifact — header + payload + newlines — must always be within the hard bound.

### 2. Header framing is injectable

`requestedMode`, and potentially arbitrary error-derived metadata, are text lines. Newline/control characters are not normalized before interpolation. An invalid value such as conceptually:

```text
bad-mode\npayload_truncated=false\n--- payload ---
```

can create fake header fields or an early payload marker in the diagnostic snapshot.

This does not alter the compaction prompt sent to OpenCode, but it makes the artifact itself structurally misleading, which is directly in PR-9 scope.

### Required remediation

Treat every text-header metadata value as bounded single-line diagnostic data:

- `requested_mode` gets a small explicit cap;
- `effective_mode` should be rendered from the trusted union (`augment|replace`) and still use the common single-line encoder;
- session ID, fallback reason and future header text go through the same CR/LF/control normalization;
- preserve useful text with visible escaping/truncation rather than allowing structural line injection;
- reserve the full real header/footer byte cost before payload selection;
- if metadata itself ever approaches the artifact ceiling, the builder must still return `<= 96 KiB` rather than relying on the filesystem writer to reject it.

Add tests for:

- 200 KiB invalid `TOKENMAXXER_COMPACTION_MODE`;
- multiline requested mode;
- multiline fallback reason;
- emoji/multibyte metadata;
- final builder output always `<= COMPACTION_PROMPT_ARTIFACT_MAX_BYTES`.

---

## B3 — result runtime validation does not enforce the declared persisted bounds

**Severity: release blocker**

The PR-9 plan explicitly requires runtime validation of result artifacts with bounds including:

```text
session_id <= 256 chars
reason     <= 500 chars
sha256     exactly 64 lowercase hex
whole JSON <= 4096 UTF-8 bytes
```

The writer-side builder enforces the normal session/reason limits, but `validateCompactionResultDiagnostic()` does not enforce the session-ID or unavailable-reason bounds when reading persisted content. It also does not reject an over-4096-byte result file.

That matters because status treats a runtime-valid result as durable truth and directly renders:

```text
Compaction session: <session_id>
Compaction summary metadata: unavailable (<reason>)
```

A manually damaged, legacy, or externally modified JSON artifact with the right `version`, `host_event`, and field types can therefore be accepted as valid while containing an arbitrarily large session ID/reason. Status can then emit unbounded or misleading output instead of classifying the diagnostic artifact as invalid.

`summary.bytes` is likewise only checked for finiteness; negative/non-integer values can be accepted as factual byte counts.

### Required remediation

Make the read-side validator authoritative for the persisted result schema, not merely the builder:

- reject `session_id.length > 256`;
- reject `summary.reason.length > 500`;
- reject result JSON whose UTF-8 size exceeds 4096 bytes before/while parsing;
- require `summary.bytes` to be a non-negative safe integer;
- strongly validate `completed_at` as the expected timestamp representation rather than accepting any string;
- retain exact 64-lowercase-hex SHA validation.

Status should continue to report such rows as:

```text
unavailable (invalid diagnostic artifact)
```

without failing the rest of status.

Add corrupt-artifact regressions for oversized session/reason/whole-JSON, negative bytes and malformed timestamps.

---

## B4 — explicit PR-9 arbitrary-error call-site audit is incomplete

**Severity: focused blocker; may be fixed with B2/B3 bounds cleanup**

The concrete PR-9 plan explicitly required the implementation to review and bound arbitrary host/filesystem text at least at the compaction-hook outer error seam.

Several new focused paths do use bounded error values, and writer HEADER/terminal/model-health errors are improved. However `src/index.ts` still contains outer catch paths such as:

```ts
await log(client, "error", "compaction hook failed", { error: String(e) })
```

and:

```ts
await log(client, "error", "event handler failed", { type: event.type, error: String(e) })
```

Those can forward arbitrarily large thrown text through `client.app.log`, contrary to the explicit PR-9 call-site audit contract.

Do not redesign the generic logging transport. Use the same shared bounded diagnostic-error helper at these arbitrary-error call sites.

Add one hostile multi-kilobyte throw regression for the outer compaction hook and one for the event handler.

---

## Exact CI evidence

GitHub Actions run `31619120327`, job `94189200265`, checked out:

`476b26f0370dffc00641d5cf28c6ec3209d66590`

Result:

```text
Test Files          64 passed + 1 expected skip = 65 total
Tests               1150 passed + 1 expected skip = 1151 total
TypeScript          PASS
Host contract       PASS
Distribution build  PASS
TUI bundle           PASS
Bundle self-contain PASS
CLI verification    PASS
CLI smoke            PASS
Shell syntax        PASS
```

The host contract check confirms peer `>=1.18.15 <2.0.0`, dev/installed minimum `1.18.15`.

Nine dependency audit findings remain visible during `npm ci` (4 low, 3 moderate, 1 high, 1 critical). They remain PR-10 dependency/release-hygiene scope and are not the reason for this PR-9 Block verdict.

The Actions Node-runtime deprecation warning likewise remains PR-10 workflow hygiene.

---

## Focused remediation wave

Keep remediation narrow:

```text
B1  monotonic/serialized last-only artifact publication under overlapping callbacks
B2  bounded + single-line encoded prompt metadata; hard header-inclusive 96 KiB guarantee
B3  enforce complete result runtime bounds on read/status
B4  finish arbitrary-error call-site bounding in index.ts
```

Required focused regression additions:

1. overlapping same-project `session.compacted` callbacks cannot regress the result artifact;
2. overlapping same-project compaction-hook diagnostics cannot regress the prompt snapshot;
3. gigantic/multiline invalid requested mode cannot exceed or spoof the 96-KiB artifact;
4. multiline fallback/error metadata cannot inject prompt header fields;
5. oversized/corrupt result artifacts are invalid rather than rendered as trusted durable status;
6. outer compaction/event thrown error values are bounded;
7. existing read-only/global fallback, summary-body non-persistence, file-activity classification, audit-guard fail-closed, PR-7/8 and TMTUI suites remain green.

After remediation, run the complete release chain on the exact implementation head and publish `docs/CRIP/PR-9/oracle-rereview.md` as evidence for the next independent pass.

## Final decision

**Block.**

PR 9 should not advance to PR 10 until the four focused diagnostics-integrity gaps above are closed and the exact remediation tree is green.
