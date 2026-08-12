# PR-10 Oracle Second Rereview Evidence

Evidence handoff after the two residual blockers in
`docs/CRIP/PR-10/oracle-final-rereview.md`. This is not an Oracle Ship verdict
or CRIP completion declaration.

## Identities

- Prior final rereview: `752b72f4c071c688c5591e170c48d3d83ff41110`
- Residual remediation base: `752b72f4c071c688c5591e170c48d3d83ff41110`
- Package version: `0.1.0`
- No real tag or GitHub Release was created.

## R1 — README generated-dist/manual-install truth

Closed. The manual clone path now explicitly runs:

```text
git clone ...
cd TokenMaxxer
npm ci
npm run build
mkdir -p ~/.config/opencode/plugins
cp dist/index.js ...
cp dist/tui.js ...
```

The one-liner now describes the actual immutable release assets:
`tokenmaxxer.js`, `tokenmaxxer-tui.js`, `tokenmaxxer-cli.js`, and
`tokenmaxxer`. It no longer claims the installer downloads repository
`dist/index.js` or `dist/tui.js` paths.

Regression evidence:

- `test/release/workflow/residual-r1-manual-install.test.ts`: 2 passed.
- `test/release/workflow/stale-doc-claims.test.ts`: 9 passed.

## R2 — tag workflow complete dependency release gate

Closed. The tag-only release workflow's full validation now invokes:

```text
npm run audit:release
```

The committed package script expands to both the high/critical gate and the
production-scope low gate:

```text
npm audit --audit-level=high
npm audit --omit=dev --audit-level=low
```

The focused regression verifies ordinary CI and tag release use the same
committed script, and preserves tag-only triggering, the Administration-read
credential/fail-closed guard, draft-first ordering, prepublish inventory and
checksum verification, and postpublish `gh release verify`.

- `test/release/workflow/release-audit-gate.test.ts`: 10 passed.
- Existing workflow contract: 23 passed.
- Immutable-release contract: 19 passed.
- YAML parsing for both workflows: passed.

## Final local validation

Sequential final micro-wave chain passed:

- `npm ci`
- `npm test`: 81 files, 1334 passed
- `npx tsc --noEmit`
- `npm run verify:host-contract`
- `npm run audit:release`: 5 low, 0 moderate, 0 high, 0 critical; production
  omit-dev audit passed
- `npm run build`
- `npm run verify:dist`
- `npm run check:tui-bundle`
- `npm run verify-cli-bundle`
- `npm run smoke:cli`
- `bash -n install.sh`
- `bash -n bin/tokenmaxxer`
- `npm run verify:package`
- `npm run verify:reproducible-build`
- `npm run release:dry-run`
- `npm run release:verify` with exact package/tag/commit identity
- focused R1/R2/workflow contracts: 50 passed
- YAML parse, `git diff --check`, and empty tracked `dist/**`: passed

The exact release staging set remained 11 assets with 10 SHA256SUMS payload
entries. No real tag, GitHub Release, asset upload, or publication was
performed during this micro-wave.

## Handoff boundary

The two documented residuals are remediated and evidenced. The independent
Oracle owns the final rereview and release gate. This document does not issue
a Ship verdict, publish a release, or declare CRIP complete.
