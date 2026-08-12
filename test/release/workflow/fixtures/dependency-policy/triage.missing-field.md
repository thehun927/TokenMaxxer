# Dependency audit triage (fixture, invalid — missing required fields)

This fixture intentionally violates the PR-10 §9.1 triage schema: the second
row omits `dependency path(s)` and `action taken`, and the third row uses an
invalid severity.

| advisory/package | severity | direct or transitive | dependency path(s) | dev/build/runtime scope | bundled into released JS? | executed during release build? | known reachability in TokenMaxxer | non-breaking remediation available? | action taken | residual risk if retained |
|---|---|---|---|---|---|---|---|---|---|---|
| esbuild | moderate | transitive | tokenmaxxer -> tsup -> esbuild | dev | no | yes | not reachable in shipped bundles | yes | upgraded esbuild | none |
| undici | low | transitive | | dev | no | no | not bundled | yes | | none |
| axios | severe | direct | tokenmaxxer -> axios | runtime | yes | yes | reachable | no | keep pinned | low |
