# Idea: `tokenmaxxer doctor`

## Summary

Add a `tokenmaxxer doctor` command that performs a lightweight health check of the OpenCode + TokenMaxxer runtime environment and reports actionable warnings before obscure startup failures occur.

The motivating incident was an OpenCode TUI failure on Linux:

```text
Failed to initialize OpenTUI render library: Failed to open library "/$bunfs/root/libopentui-h3hyjpa5.so": /$bunfs/root/libopentui-h3hyjpa5.so: cannot open shared object file: No such file or directory
```

The OpenCode installation itself was healthy. The actual cause was an exhausted per-user quota on `/tmp`, which prevented Bun from extracting an embedded native OpenTUI library before `dlopen`.

A disk-backed `TMPDIR` immediately resolved the problem:

```bash
export TMPDIR="$HOME/.cache/opencode-tmp"
mkdir -p "$TMPDIR"
opencode
```

This is a good example of a failure that looks like a broken native dependency or plugin problem but is actually an environmental health issue.

## Goal

Provide a fast, read-only diagnostic command that answers:

> Is the local environment healthy enough for OpenCode and TokenMaxxer to start and operate normally?

The command should identify common host/runtime failures and give specific remediation guidance without modifying the system by default.

## Proposed command

```bash
tokenmaxxer doctor
```

Optional future flags:

```bash
tokenmaxxer doctor --verbose
tokenmaxxer doctor --json
tokenmaxxer doctor --fix
```

`--fix` should be considered separately and should never be the default behavior.

## Initial checks

### 1. OpenCode executable

Check:

- `opencode` exists on `PATH`
- executable path
- OpenCode version
- basic non-interactive invocation if safe

Example:

```text
PASS  OpenCode found: /home/user/.opencode/bin/opencode
PASS  OpenCode version: 1.18.16
```

### 2. Temporary-directory health

This should be a first-class check because Bun standalone executables may need to extract embedded native assets before loading them.

Inspect:

- effective `TMPDIR`
- fallback temp location when `TMPDIR` is unset
- whether the directory exists
- whether it is writable
- whether a small temporary file can actually be created
- available filesystem space
- inode availability where practical
- mount type/options where practical
- tmpfs size where applicable
- user quota status where available

The write test is important. `df` may report free filesystem space while a per-user quota is already exhausted.

Example failure:

```text
FAIL  Temporary directory is not usable: /tmp
      create-file test failed: Disk quota exceeded

      Bun standalone binaries may be unable to extract embedded native
      libraries, causing misleading errors such as:
      Failed to open library "/$bunfs/root/libopentui-*.so"

      Suggested workaround:
        mkdir -p "$HOME/.cache/opencode-tmp"
        export TMPDIR="$HOME/.cache/opencode-tmp"
```

### 3. OpenCode temp usage

Report unusually large OpenCode-owned temporary files/directories when visible to the current user.

Potential locations include:

```text
/tmp/opencode
$TMPDIR/opencode
```

Flag especially large artifacts such as stale database backups.

Example:

```text
WARN  OpenCode temporary data is using 1.8 GiB
      Largest file: /tmp/opencode/opencode-backup-1786161398.db (1.3 GiB)
```

Do not delete anything automatically in the default doctor command.

### 4. TokenMaxxer installation

Check:

- launcher exists
- server plugin exists
- TUI plugin exists
- CLI bundle exists
- files are readable
- expected config entries exist
- duplicate plugin entries are not present

Relevant paths currently include:

```text
~/.local/bin/tokenmaxxer
~/.config/opencode/plugins/tokenmaxxer.js
~/.config/opencode/plugins/tokenmaxxer-tui.js
~/.config/opencode/plugins/tokenmaxxer-cli.js
~/.config/opencode/tui.json
~/.config/opencode/package.json
```

### 5. OpenCode / OpenTUI dependency state

Inspect the user OpenCode package configuration for:

- expected dependency presence
- obviously conflicting or malformed versions
- missing installed dependency tree where detectable
- invalid JSON

This check should report evidence rather than assume that every version difference is a problem.

### 6. TokenMaxxer memory-store health

Check the current project when run inside a project directory:

- memory directory is resolvable
- directory is readable/writable
- state files parse successfully
- no obviously corrupt or truncated JSON/state files
- activity marker behavior is sane
- filesystem permissions permit normal writes

The doctor command should avoid mutating memory state just to test it unless a disposable probe file can be safely created and removed.

### 7. Configuration validation

Validate relevant files when present:

```text
~/.config/opencode/package.json
~/.config/opencode/tui.json
./opencode.json
```

Report:

- invalid JSON
- unexpected root types
- duplicate plugin registrations
- missing referenced plugin files

### 8. Disk-space sanity

Check free space for locations TokenMaxxer/OpenCode actively use, especially:

- `$HOME`
- effective temp directory
- project filesystem
- TokenMaxxer memory/state location

Use conservative thresholds and label low-space findings as warnings unless writes are actually failing.

## Output model

Use simple severity levels:

```text
PASS
INFO
WARN
FAIL
```

Suggested summary:

```text
TokenMaxxer Doctor

PASS  OpenCode 1.18.16 found
PASS  TokenMaxxer plugin files present
FAIL  /tmp write test: Disk quota exceeded
WARN  /tmp/opencode is using 1.8 GiB
PASS  Memory store is readable and writable
PASS  OpenCode config parses successfully

Result: 1 failure, 1 warning
```

Exit codes could be:

```text
0  healthy; informational findings only
1  warnings present
2  one or more failures detected
```

If stable scripting compatibility becomes important, `--json` should expose structured check IDs rather than requiring callers to parse human-readable messages.

## Design principles

### Read-only by default

`tokenmaxxer doctor` should diagnose, not silently repair or delete files.

### Test capability, not just metadata

Where safe, prefer a direct behavioral probe over an indirect assumption.

For temp storage, for example:

```text
Bad check:  df says 2 GiB free
Good check: create + fsync + remove a tiny file successfully
```

This catches quota failures that ordinary free-space checks miss.

### Explain misleading upstream errors

Where TokenMaxxer recognizes a known failure pattern, it should explain the mechanism rather than merely say that a check failed.

For example:

```text
Bun may report /$bunfs/root/libopentui-*.so as missing when the real
failure is inability to extract that embedded library into temporary storage.
```

### Avoid overclaiming root cause

Doctor output should distinguish between:

- confirmed failure
- likely consequence
- suggested remediation

Example:

```text
FAIL  Cannot create files in /tmp: Disk quota exceeded
INFO  This can cause Bun/OpenTUI native-library extraction failures.
```

That is preferable to claiming every OpenTUI error is caused by `/tmp`.

## Implementation sketch

The command can live in the existing human CLI bundle and expose independent checks with stable IDs, for example:

```text
opencode.executable
opencode.version
temp.path
temp.write
temp.space
temp.quota
opencode.temp_usage
tokenmaxxer.installation
tokenmaxxer.tui_config
tokenmaxxer.dependencies
tokenmaxxer.memory_store
config.package_json
config.tui_json
config.project
```

Each check could return a common structure:

```ts
type DoctorResult = {
  id: string
  severity: "pass" | "info" | "warn" | "fail"
  summary: string
  detail?: string
  remediation?: string[]
}
```

Platform-specific probes should degrade gracefully. For example, quota inspection may differ across Linux distributions and filesystems; failure to query quota metadata should not itself be treated as a health failure if the direct temp-file write probe succeeds.

## Test cases

At minimum, cover:

1. Healthy Linux environment.
2. `TMPDIR` unset and `/tmp` healthy.
3. Custom healthy `TMPDIR`.
4. Temp directory does not exist.
5. Temp directory is not writable.
6. Filesystem has no free space.
7. Per-user quota exhausted while `df` still shows free space.
8. Invalid `tui.json`.
9. Missing TokenMaxxer TUI plugin file.
10. Broken/malformed TokenMaxxer memory state.
11. OpenCode absent from `PATH`.
12. JSON output remains machine-readable when checks fail.

## Origin / motivating incident

On Linux, OpenCode failed to initialize its TUI with a missing `/$bunfs/root/libopentui-*.so` message.

Investigation showed:

- `/tmp` was a quota-enabled tmpfs.
- The user's quota was exhausted.
- `/tmp/opencode` held roughly 1.8 GiB.
- A single OpenCode backup database consumed roughly 1.3 GiB.
- Direct writes to `/tmp` failed with `Disk quota exceeded`.
- Running OpenCode with a disk-backed `TMPDIR` launched successfully with no TUI error.

This failure mode is worth detecting because it presents as an OpenTUI/native-library problem even though the underlying OpenCode binary and embedded library are intact.

## Status

Idea only. No implementation yet.
