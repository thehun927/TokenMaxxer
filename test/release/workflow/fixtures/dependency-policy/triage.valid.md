# Dependency audit triage (fixture, valid)

Advisory triage for the implementation-head `npm audit` snapshot. Each finding
must carry all required PR-10 §9.1 fields.

| advisory/package | severity | direct or transitive | dependency path(s) | dev/build/runtime scope | bundled into released JS? | executed during release build? | known reachability in TokenMaxxer | non-breaking remediation available? | action taken | residual risk if retained |
|---|---|---|---|---|---|---|---|---|---|---|
| esbuild | moderate | transitive | tokenmaxxer -> tsup -> esbuild | dev | no | yes | not reachable in shipped bundles | yes | upgraded esbuild within compatible range | none |
| undici | low | transitive | tokenmaxxer -> opencode -> undici | dev | no | no | not bundled into release payloads | yes | refreshed lockfile | none |
| axios | high | transitive | tokenmaxxer -> opencode -> axios | dev | no | no | not reachable at runtime in shipped plugin | yes | upgraded axios to patched minor | none |
| zod | low | direct | tokenmaxxer -> zod | runtime | yes | yes | used for state schema validation | yes | kept pinned range, documented | low; dev-only exploit path |
