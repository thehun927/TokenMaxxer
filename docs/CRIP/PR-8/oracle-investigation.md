# PR-8 Oracle Investigation Handoff

This is an implementation evidence handoff only. It contains no Oracle
findings and no Ship verdict. The independent Oracle owns the release-gate
decision.

## Exact SHAs

- Planning baseline: `7b1b904deb764cfe99c7b239f7cb75f34635688e`
- PR-7 final production baseline: `141bec918d08d8e25a358231c15a16fcc37efb62`
- PR-8 implementation-plan commit: `49028e58cbbcee6bd191e1f31b373661692ae363`
- Exact final implementation SHA verified locally: `abcbce9ae30e4c55b47261cee7971173023cfb79`

The final implementation SHA is a local, unpushed commit. The unrelated
pre-existing `opencode.json` modification and untracked `.opencode/` state were
not included in the implementation commits.

## Wave commits

1. Wave 1 — `c7289249402abd3da4621e2e6f9ce8b1877e6b66`
2. Wave 2 — `f9e079a6ff6f7be6616fc14f85cf8b0bb5f67e78`
3. Wave 3 — `a62d0c1127956f31fe29948168a534dcb291f346`
4. Wave 4 — `34d777c35295af5bd60b200d6932ba2cb3d395da`
5. Wave 5 — `03ba91eb899452a4ff2979037c7ca138b148798b`
6. Wave 6 — `088fe28d08984207cd6974dbc51076c23432374f`
7. Wave 7 — `abcbce9ae30e4c55b47261cee7971173023cfb79`

## Release-matrix coverage

| Cases | Contract | Where tested |
|---|---|---|
| 1 | Exact UTF-8 size equals serialized STATE bytes | `test/memory/pr8-budget-primitives.test.ts`; `test/memory/p0-a-reliability.test.ts` |
| 2 | ASCII and multibyte byte-size distinction | `test/memory/pr8-budget-primitives.test.ts`; `test/memory/p0-a-reliability.test.ts` |
| 3 | Exact 8,192-byte candidate accepted | `test/memory/p0-a-reliability.test.ts` |
| 4 | 8,193-byte candidate rejected | `test/memory/p0-a-reliability.test.ts` |
| 5 | UTF-8 truncation preserves code points | `test/memory/pr8-budget-primitives.test.ts` |
| 6 | Fitting does not mutate input | `test/memory/pr8-budget-primitives.test.ts` |
| 7 | Revision 9 → 10 included before fitting | `test/memory/pr8-storage-budget.test.ts` |
| 8 | Revision 99 → 100 included before fitting | `test/memory/pr8-storage-budget.test.ts` |
| 9 | Already-fitting state remains semantically unchanged | `test/memory/pr8-budget-primitives.test.ts` |
| 10 | Completed audits are disposable first | `test/memory/pr8-budget-primitives.test.ts` |
| 11 | Pending audit survives completed-audit pruning | `test/memory/pr8-budget-primitives.test.ts` |
| 12 | Old cache rows are disposable first | `test/memory/pr8-budget-primitives.test.ts` |
| 13 | Model-health metadata is disposable | `test/memory/pr8-budget-primitives.test.ts` |
| 14 | Cache-quarantine metadata is disposable | `test/memory/pr8-budget-primitives.test.ts` |
| 15 | Old recent sessions are disposable | `test/memory/pr8-budget-primitives.test.ts` |
| 16 | Unprotected processed sources are disposable | `test/memory/pr8-budget-primitives.test.ts` |
| 17 | Protected processed-source key survives | `test/memory/pr8-budget-primitives.test.ts`; `test/memory/pr8-wave7-integration.test.ts` |
| 18 | Invalid non-foundational decisions prune before valid rows | `test/memory/pr8-budget-primitives.test.ts` |
| 19 | Protected human conflict/history survives | `test/memory/pr8-budget-primitives.test.ts` |
| 20 | Least-recently-touched active file prunes first | `test/memory/pr8-budget-primitives.test.ts` |
| 21 | Old non-foundational decisions age-prune | `test/memory/pr8-budget-primitives.test.ts` |
| 22 | Old human foundational decision survives | `test/memory/pr8-budget-primitives.test.ts` |
| 23 | Decision rationale reduces before core authority text | `test/memory/pr8-budget-primitives.test.ts` |
| 24 | Active-file reason reduces before authority | `test/memory/pr8-budget-primitives.test.ts` |
| 25 | Blocker/next-step verbosity reduces under pressure | `test/memory/pr8-budget-primitives.test.ts` |
| 26 | Old decisions prune incrementally, recent rows survive | `test/memory/pr8-budget-primitives.test.ts` |
| 27 | Ephemeral task/files may be discarded before authority | `test/memory/pr8-budget-primitives.test.ts` |
| 28 | Identical inputs produce byte-identical results | `test/memory/pr8-budget-primitives.test.ts` |
| 29 | Protected foundational minimum overflow is typed | `test/memory/pr8-budget-primitives.test.ts`; `test/memory/pr8-wave7-integration.test.ts` |
| 30 | Required protected proof overflow is typed | `test/memory/pr8-budget-primitives.test.ts`; `test/memory/pr8-wave7-integration.test.ts` |
| 31 | Failure returns no over-cap memory object | `test/memory/pr8-budget-primitives.test.ts` |
| 32 | Budget rejection performs no write | `test/memory/pr8-storage-budget.test.ts`; `test/memory/pr8-wave7-integration.test.ts` |
| 33 | Budget rejection does not bump revision | `test/memory/pr8-storage-budget.test.ts`; `test/memory/pr8-wave7-integration.test.ts` |
| 34 | Authoritative source selection remains stable after rejection | `test/memory/store.test.ts`; `test/memory/transaction.test.ts` |
| 35 | Direct exact commit still rejects oversized STATE | `test/memory/p0-a-reliability.test.ts` |
| 36 | Successful mutation returns fitted memory | `test/memory/pr8-storage-budget.test.ts` |
| 37 | Header path uses committed writer flow | `test/memory/writer-header.test.ts`; `test/memory/writer.test.ts` |
| 38 | Lock timeout remains lock-timeout | `test/memory/store.test.ts`; `test/memory/transaction.test.ts` |
| 39 | Unavailable authoritative STATE remains unavailable | `test/memory/store.test.ts`; `test/memory/p0-a-reliability.test.ts` |
| 40 | I/O failure remains commit-failed | `test/memory/store.test.ts`; `test/memory/transaction.test.ts` |
| 41 | Automatic current-task creation bound | `test/memory/pr8-schema-compat.test.ts` |
| 42 | Automatic active-file path/reason bounds | `test/memory/pr8-schema-compat.test.ts` |
| 43 | Automatic decision topic/text/rationale bounds | `test/memory/pr8-schema-compat.test.ts` |
| 44 | Blocker/next-step creation counts and bounds | `test/memory/pr8-schema-compat.test.ts` |
| 45 | Current-v3 fixture remains readable unchanged | `test/memory/pr8-schema-compat.test.ts` |
| 46 | Oversized non-authoritative arrays repair deterministically | `test/memory/pr8-schema-compat.test.ts` |
| 47 | Migration does not invent provenance/evidence | `test/memory/pr8-schema-compat.test.ts` |
| 48 | Human foundational text is not truncated to creation limits | `test/memory/pr8-schema-compat.test.ts` |
| 49 | Beyond-ceiling malformed data fails closed | `test/memory/pr8-schema-compat.test.ts` |
| 50 | Decisions-only LLM schema remains 256/500/500 and 1–3 refs | `test/memory/pr8-schema-compat.test.ts`; `test/memory/extract.test.ts` |
| 51 | Storage bounds do not widen LLM authority | `test/memory/extract.test.ts`; `test/memory/extract-llm.test.ts` |
| 52 | Repeated repaired-v3 loads are deterministic | `test/memory/pr8-schema-compat.test.ts` |
| 53 | Heuristic pressure maps to public write-failed | `test/memory/writer.test.ts`; `test/memory/p0-a-reliability.test.ts` |
| 54 | Final LLM merge protects new source marker | `test/memory/writer-llm.test.ts`; `test/memory/pr8-wave7-integration.test.ts` |
| 55 | Rejected LLM merge writes no facts or marker | `test/memory/writer-llm.test.ts`; `test/memory/pr8-wave7-integration.test.ts` |
| 56 | Rejected source remains retryable | `test/memory/writer-llm.test.ts`; `test/memory/pr8-wave7-integration.test.ts` |
| 57 | Pending audit guard is protected | `test/memory/writer.test.ts`; `test/memory/p0-a-reliability.test.ts` |
| 58 | Audit-guard refusal prevents prompting | `test/memory/writer.test.ts`; `test/memory/writer-llm.test.ts` |
| 59 | Terminal audit metadata is best effort | `test/memory/writer.test.ts`; `test/memory/transaction.test.ts` |
| 60 | Model health is best effort | `test/memory/model-health.test.ts`; `test/memory/transaction.test.ts` |
| 61 | recall_promote protects target decision | `test/tools/recall.test.ts`; `test/memory/pr8-wave7-integration.test.ts` |
| 62 | Review-request refusal maps to write failure | `test/tools/recall.test.ts`; `test/memory/pr8-wave7-integration.test.ts` |
| 63 | Human promotion overflow preserves prior authority | `test/cli.test.ts` |
| 64 | Human supersession overflow preserves prior authority/candidate | `test/cli.test.ts` |
| 65 | Missing-memory sentinel is bounded | `test/compaction/pr8-budget.test.ts`; `test/compaction/durable.test.ts` |
| 66 | Unavailable-memory sentinel is bounded | `test/compaction/pr8-budget.test.ts`; `test/compaction/durable.test.ts` |
| 67 | Smallest block has intact delimiters | `test/compaction/pr8-budget.test.ts`; `test/compaction/durable.test.ts` |
| 68 | Ordinary durable block is ≤4,096 UTF-8 bytes | `test/compaction/pr8-budget.test.ts` |
| 69 | CJK/emoji are budgeted by UTF-8 bytes | `test/compaction/pr8-budget.test.ts` |
| 70 | Framing, DATA prefixes, and newlines count | `test/compaction/pr8-budget.test.ts` |
| 71 | Current task outranks lower-priority files | `test/compaction/pr8-budget.test.ts` |
| 72 | Blockers outrank old decisions | `test/compaction/pr8-budget.test.ts` |
| 73 | Next steps outrank old decisions | `test/compaction/pr8-budget.test.ts` |
| 74 | Human foundational decisions outrank non-foundational rows | `test/compaction/pr8-budget.test.ts` |
| 75 | Recent/recalled decisions outrank older rows | `test/compaction/pr8-budget.test.ts` |
| 76 | Strict prefix stop prevents skip-and-fill | `test/compaction/pr8-budget.test.ts` |
| 77 | Hostile values remain sanitized DATA lines | `test/compaction/pr8-budget.test.ts` |
| 78 | `[llm:eN]` is actual evidence count | `test/compaction/pr8-budget.test.ts`; `test/compaction/durable.test.ts` |
| 79 | Omitted durable decision remains pull-recallable and STATE unchanged | `test/compaction/pr8-budget.test.ts` |
| 80 | Exact final SHA passes full release chain and handoff records evidence | This handoff plus the Wave 8 command results below |

## Release-chain evidence on exact implementation SHA

All commands below were run locally with `HEAD` equal to
`abcbce9ae30e4c55b47261cee7971173023cfb79`:

- `npm test` — **51 test files, 951 tests passed; 0 failed**.
- `npx tsc --noEmit` — passed.
- `npm run verify:host-contract` — passed; peer/dev/installed host version all `1.18.15`.
- `npm run build` — passed; generated `dist/index.js`, `dist/tui.js`, and `dist/cli.js` successfully. Generated tracked files were restored afterward, so the implementation tree remains the exact SHA above.
- `npm run verify-cli-bundle` — passed.
- `npm run smoke:cli` — passed all checks 46–49.
- `bash -n install.sh` — passed.
- `bash -n bin/tokenmaxxer` — passed.
- `git diff --check` — passed.

The focused Wave 7 rerun was 21/21; the integrated memory/compaction/tools/CLI
rerun was 51 files and 951/951 tests before the final `npm test` repetition,
which independently reproduced the same 951/951 result.

## CI run/job

No GitHub CI run/job exists for the exact final SHA: it is local and unpushed.
The latest observed repository CI run was run `31549073394`, successful for
`43ff490f56b06b4e1e89db36ca7c6d2c55a2c0ec` (`Mark PR 8 implementation plan
ready`), and is explicitly **not** evidence for the final implementation SHA.
No CI result is represented here as a final-SHA pass.

## Repository-audit results

The Wave 7 src-only seam audit found:

- zero production callers of `pruneOld()` or `pruneOldForCommit()`;
- every production `mutateMemory()` path routes through central fitting, with
  required source/audit/decision protections where applicable;
- `commitMemoryExact()` is the only STATE writer funnel for mutation paths;
- durable rendering is read-only, framed, sanitized, and independently capped;
- PR-7 augment/replace and DATA sanitization remain intact;
- no PR-9 persistent diagnostics/status work or PR-10 dependency/release work
  was added.

## Unresolved concerns and deviations

- `pruneOld()` and `pruneOldForCommit()` remain exported compatibility/test
  seams. They are not production mutation callers, but a future caller could
  misuse the documented over-cap return unless it routes through `mutateMemory()`.
- Direct exact-commit failure reasons remain collapsed to generic
  `commit-failed` at the public mutation boundary. This is outside PR-8's
  required public outcome taxonomy and is retained for the independent Oracle
  attack surface.
- No exact-final-SHA CI evidence is available because the implementation was
  not pushed. Local release-chain evidence is complete.
- `opencode.json` and untracked `.opencode/` were pre-existing workspace state
  and are not part of PR-8.

## Specific Oracle attack surface from the plan

The independent Oracle should attack exact 8,192/8,193 boundaries; revision
digit growth; 31+ day foundational authority; multiple foundational rows whose
minimum exceeds storage; final LLM marker plus near-cap authority; audit guard
plus near-cap protected state; recall promotion of the next-pruned decision;
human promotion/supersession overflow; long current-v3 semantic fields; emoji,
CJK, combining sequences, hostile delimiters, and framing near 4,096 bytes;
strict-prefix priority under one large candidate; many retained foundationals
with partial injection; concurrent near-cap mutations; read-only/global
fallback; and any future production `pruneOld()` caller that could treat an
over-cap result as successful.

Stop condition: this document is evidence only. No Oracle finding, Ship
verdict, or PR-9 advancement is made here.
