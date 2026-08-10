#!/usr/bin/env bash
set -euo pipefail

# PR 3 §15.46-49 — CLI bundle + launcher smoke test.
#
# Run AFTER `npm run build` (the CLI bundle must exist). These are packaging
# assertions that cannot live in the vitest unit suite without a build-time
# side effect, so they are a CI-only verification step:
#
#   46. Build produces a non-empty dist/cli.js.
#   47. Launcher dispatch preserves `tokenmaxxer opencode` behavior.
#   48. Launcher routes decisions/promote/supersede to the CLI bundle.
#   49. Installer syntax remains valid and installs the CLI bundle path
#       expected by the launcher.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAUNCHER="${ROOT}/bin/tokenmaxxer"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "cli-smoke: FAIL: $*" >&2
  exit 1
}

# ── 46. Build produces a non-empty dist/cli.js ──────────────────────────────
if [ ! -s "${ROOT}/dist/cli.js" ]; then
  fail "dist/cli.js is missing or empty — run 'npm run build' first"
fi
echo "cli-smoke: 46 OK — dist/cli.js is non-empty"

# ── 48. Launcher routes `decisions` to the CLI bundle ───────────────────────
PROJECT="${TMP}/proj"
mkdir -p "${PROJECT}"
decisions_out="$("${LAUNCHER}" decisions --project "${PROJECT}")"
if ! printf '%s' "${decisions_out}" | grep -q "No project memory yet."; then
  fail "decisions output missing 'No project memory yet.'; got: ${decisions_out}"
fi
echo "cli-smoke: 48 OK — decisions routes to the CLI bundle"

# ── 48. Launcher routes `promote` / `supersede` to the CLI bundle ───────────
promote_out="$("${LAUNCHER}" promote no-such-id --project "${PROJECT}" 2>&1 || true)"
if ! printf '%s' "${promote_out}" | grep -qi "no project memory"; then
  fail "promote routing broken; got: ${promote_out}"
fi
supersede_out="$("${LAUNCHER}" supersede no-candidate --replaces no-authority --project "${PROJECT}" 2>&1 || true)"
if ! printf '%s' "${supersede_out}" | grep -qi "no project memory"; then
  fail "supersede routing broken; got: ${supersede_out}"
fi
echo "cli-smoke: 48 OK — promote/supersede route to the CLI bundle"

# ── 47. Launcher preserves `opencode` dispatch ──────────────────────────────
# A fake `opencode` binary proves the launcher execs opencode with forwarded
# args rather than rejecting the subcommand as unknown (usage/exit 2).
FAKEBIN="${TMP}/bin"
mkdir -p "${FAKEBIN}"
cat > "${FAKEBIN}/opencode" <<'EOF'
#!/usr/bin/env bash
printf 'OPENCODE_DISPATCHED %s\n' "$*"
EOF
chmod +x "${FAKEBIN}/opencode"
opencode_out="$(PATH="${FAKEBIN}:${PATH}" "${LAUNCHER}" opencode --version)"
if ! printf '%s' "${opencode_out}" | grep -q "OPENCODE_DISPATCHED --version"; then
  fail "opencode routing broken; got: ${opencode_out}"
fi
echo "cli-smoke: 47 OK — opencode dispatches with forwarded args"

# ── 49. Installer syntax valid and CLI bundle path matches the launcher ─────
bash -n "${ROOT}/install.sh" || fail "install.sh has a bash syntax error"
bash -n "${LAUNCHER}" || fail "bin/tokenmaxxer has a bash syntax error"
if ! grep -q 'CLI_PLUGIN_URL=.*dist/cli\.js' "${ROOT}/install.sh"; then
  fail "install.sh CLI_PLUGIN_URL does not reference dist/cli.js"
fi
echo "cli-smoke: 49 OK — installer syntax valid; CLI_PLUGIN_URL → dist/cli.js"

echo "cli-smoke: OK (46-49)"
