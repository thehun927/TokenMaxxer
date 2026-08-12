# TokenMaxxer Release Procedure

This guide is for the first real GitHub Release. Remediation and Oracle
rereview must not create a real tag or publish a release.

## Prerequisites

- The exact `main` commit has green PR/main CI.
- Repository immutable releases are enabled through GitHub's dedicated
  immutable-release setting.
- The release workflow has an `RELEASE_ADMIN_TOKEN` secret with the minimum
  required Administration: read permission. `GITHUB_TOKEN` with
  `contents: write` is not sufficient for the immutable-status API.
- Node/npm/Bun match the pinned builder: Node `22.23.1`, npm `10.9.8`, Bun
  `1.3.14`.
- The working tree is clean and no published tag is being reused.

## Preflight

Review `package.json` version and run:

```bash
npm ci
npm test
npx tsc --noEmit
npm run verify:host-contract
npm run audit:release
npm run build
npm run verify:dist
npm run verify:package
npm run verify:reproducible-build
npm run release:dry-run
npm run release:verify -- --dir .release --tag "v$(node -p 'require("./package.json").version')" --commit "$(git rev-parse HEAD)"
test -z "$(git ls-files 'dist/**')"
```

## Publish one immutable release

1. Confirm the package version is the intended new version. Never reuse or
   move a published tag; a correction requires a new package version and tag.
2. Confirm the exact commit is the intended `main` commit.
3. Create an annotated tag whose name is exactly `v<package.version>`:

   ```bash
   git tag -a "v$(node -p 'require("./package.json").version')" "$(git rev-parse HEAD)" -m "TokenMaxxer $(node -p 'require("./package.json").version')"
   git push origin "v$(node -p 'require("./package.json").version')"
   ```

4. The tag-only release workflow proves immutable-release availability using
   `RELEASE_ADMIN_TOKEN`, runs identity and full release validation, and calls
   `release:stage` and `release:verify`.
5. The workflow creates a draft first, uploads the complete staged asset set,
   verifies remote asset inventory plus staged identity/checksums, and only
   then publishes the draft.
6. Immediately after publication, the workflow runs `gh release verify` for
   the immutable-release attestation.
7. Confirm `SHA256SUMS` and `RELEASE.json` remain attached to the one canonical
   GitHub Release. Do not publish a second or mutable asset set.

During implementation, remediation, or Oracle rereview, use only
`npm run release:dry-run`; do not create or push a real tag or release.
