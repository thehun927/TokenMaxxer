# PR 4 Oracle Final Re-Review — Wave 9

> **Reviewed implementation:** `c41e7d79c5c87d9f95df902d03a748f0047a9cc9`  
> **Prior findings:** `docs/CRIP/PR-4/oracle-findings.md`  
> **Observed GitHub Actions run:** `31445696398`

## 1. Verdict

**Ship.**

Wave 9 closes both PR 4 release-gate blockers from the initial oracle review. No new release-blocking regression was found in the focused final pass.

---

## 2. Prior blocker closure

### Blocker 1 — `head_files` error/empty paths bypassed the output cap

**Closed.**

`_headFiles()` now represents successful, empty, and error outcomes using the same `HeadFileSection[]` collection and returns exactly one `formatHeadFilesOutput(sections)` result. The previous independent `notes` channel no longer exists, so there is no text appended after the total truncation marker.

Host exceptions are reduced through `boundedHostError()` before becoming model-visible section content. Normal `Error` values are represented as bounded `name: message` text capped at 256 characters; arbitrary non-Error thrown values are stringified and sliced to the same cap.

The previous deterministic reproductions are now covered end-to-end in `test/tools/efficiency.test.ts`:

1. a single 100 KB host error remains bounded;
2. six successful sections large enough to trigger the total cap followed by a throwing seventh path produce no content after the total marker;
3. sixteen empty and sixteen throwing-path fanout cases remain bounded;
4. hidden tail text from a 100 KB error never surfaces.

The formatter tests also cover empty/error-only section input and max-fanout section lists.

This closes release-gate cases 7, 22, and 23 at the actual `_headFiles()` boundary rather than only at the formatter helper.

### Blocker 2 — minimum-host compile fixture was not enforced by committed CI

**Closed.**

`.github/workflows/ci.yml` now contains an explicit step:

```yaml
- name: Verify host contract (peer range + minimum package + fixture)
  run: npm run verify:host-contract
```

The exact observed Actions run for `c41e7d7`, run `31445696398`, executed that step successfully. Its log proves:

```text
peer range = ">=1.18.15 <2.0.0"
dev dep = "1.18.15"
installed = "1.18.15"
tsc -p tsconfig.host-contract.json --noEmit -> success
```

Wave 9 additionally invokes the dedicated host-contract compile fixture from `test/host/package-meta.test.ts`, so ordinary `npm test` also exercises cases 43-44 before the explicit CI step runs. The explicit workflow step remains the canonical CI contract; the Vitest invocation is defense in depth.

---

## 3. Exact CI release signal

GitHub Actions run `31445696398` completed successfully on `c41e7d7`.

The verified sequence was:

```text
npm ci                                      PASS
npm test                                    PASS
npx tsc --noEmit                            PASS
npm run verify:host-contract                PASS
npm run build                               PASS
self-contained bundle verification          PASS
npm run verify-cli-bundle                   PASS
npm run smoke:cli                           PASS
installer / launcher syntax                 PASS
```

Vitest reported:

```text
37 test files total
36 passed
1 expected pre-build launcher test skipped
485 tests passed
1 skipped
486 total
```

The previously observed timing-sensitive `activity-state` test also passed on this exact candidate.

---

## 4. Regression checks retained from the initial review

The Wave 9 changes do not reopen the host-boundary properties that were already accepted:

- `HostClient` remains derived from `PluginInput["client"]`;
- production tools do not read `context.client`;
- `registerEfficiencyTools(client)` still closes over the initializer client;
- `head_files` still routes through `client.file.read()` using the current invocation `context.directory`;
- there is still no raw filesystem fallback in `head_files`;
- model-callable recall/review/head-file input schemas remain bounded;
- the runtime host gate still rejects `1.18.14`, malformed/prerelease values, and 2.x while accepting `1.18.15` and supported later 1.x;
- missing health still follows the deliberate pinned-compatibility path for the verified v1.18.15 generated client;
- unsupported structured-output hosts still retain already-committed heuristic memory and create no audit session / structured prompt;
- PR 1 storage, PR 2 lock/transaction, and PR 3 authority/review tests remain green in the full suite.

---

## 5. Non-blocking follow-up

Some Wave 9 comments and the append-only blocker log still contain wording from the pre-push state saying the workflow edit "cannot be pushed" or is only local. That statement is now stale: `c41e7d7` includes the workflow change and Actions executed it successfully.

This is documentation residue only and does not affect the release contract. It can be cleaned up in normal documentation maintenance; the historical append-only blocker log may instead retain the old entry with a later note clarifying that the push subsequently succeeded.

A very pathological thrown object with hostile property accessors or a throwing `toString()` could still make `boundedHostError()` itself throw. Normal host/SDK failures use ordinary error objects, and this is not a realistic PR 4 release blocker, but a future general-purpose sanitizer could be made fully exception-proof if desired.

---

## 6. Final release-gate conclusion

PR 4 now satisfies the concrete host-contract invariants and the 50-case release-gate intent:

- legitimate client provenance;
- genuine minimum `ToolContext` typing;
- invocation-directory file routing;
- bounded model inputs and `head_files` output;
- verified package/runtime version contract;
- graceful optional-LLM degradation;
- CI-enforced compilation against the exact minimum supported OpenCode package;
- green regression/build/CLI release signal.

**PR 4 is complete and cleared to Ship.**
