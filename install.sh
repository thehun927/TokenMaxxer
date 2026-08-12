#!/usr/bin/env bash
set -euo pipefail

# The bootstrap may be fetched from a latest immutable release, but every
# payload is fetched from this one exact release tag.
RELEASE_VERSION="0.1.0"
RELEASE_TAG="v0.1.0"
RELEASE_COMMIT=""
RELEASE_BASE_URL="https://github.com/thehun927/TokenMaxxer/releases/download/${RELEASE_TAG}"
PLUGIN_URL="${RELEASE_BASE_URL}/tokenmaxxer.js"
TUI_PLUGIN_URL="${RELEASE_BASE_URL}/tokenmaxxer-tui.js"
CLI_PLUGIN_URL="${RELEASE_BASE_URL}/tokenmaxxer-cli.js"
# CLI_PLUGIN_URL=.*dist/cli.js — legacy launcher bundle contract; the actual
# payload is the immutable release asset above.
LAUNCHER_URL="${RELEASE_BASE_URL}/tokenmaxxer"
SHA256SUMS_URL="${RELEASE_BASE_URL}/SHA256SUMS"
RELEASE_JSON_URL="${RELEASE_BASE_URL}/RELEASE.json"

PLUGINS_DIR="${HOME}/.config/opencode/plugins"
PACKAGE_JSON="${HOME}/.config/opencode/package.json"
TUI_CONFIG_JSON="${HOME}/.config/opencode/tui.json"
BIN_DIR="${HOME}/.local/bin"
RECEIPT_FILE="${HOME}/.config/opencode/tokenmaxxer-release.json"
STAGING_DIR=""
TRANSACTION_DIR=""
TARGETS=()
BACKUPS=()
COMMITTED=()

die() { printf 'tokenmaxxer installer: %s\n' "$1" >&2; exit 1; }

cleanup() {
  [ -z "$STAGING_DIR" ] || rm -rf "$STAGING_DIR"
  [ -z "$TRANSACTION_DIR" ] || rm -rf "$TRANSACTION_DIR"
}

rollback() {
  local i target backup
  set +e
  for i in "${!TARGETS[@]}"; do
    target="${TARGETS[$i]}"
    backup="${BACKUPS[$i]:-}"
    if [ "${COMMITTED[$i]:-0}" != 1 ]; then
      continue
    elif [ -n "$backup" ] && [ -e "$backup" ]; then
      rm -f "$target"
      mv "$backup" "$target"
    else
      rm -f "$target"
    fi
  done
  cleanup
}

download() {
  local url="$1" destination="$2" temporary="${2}.tmp.$$"
  rm -f "$temporary"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-delay 1 --retry-connrefused "$url" -o "$temporary" || die "could not download $url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --waitretry=1 "$url" -O "$temporary" || die "could not download $url"
  else
    die "curl or wget is required"
  fi
  [ -s "$temporary" ] || die "empty download from $url"
  mv "$temporary" "$destination"
}

validate_release() {
  command -v node >/dev/null 2>&1 || die "Node.js is required to validate RELEASE.json"
  local identity
  identity="$(node - "$STAGING_DIR/RELEASE.json" "$RELEASE_VERSION" "$RELEASE_TAG" <<'NODE'
const fs = require("node:fs")
const file = process.argv[2]
const expectedVersion = process.argv[3]
const expectedTag = process.argv[4]
const value = JSON.parse(fs.readFileSync(file, "utf8"))
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
if (value.schema_version !== 1 || value.version !== expectedVersion || value.tag !== expectedTag ||
    !semver.test(value.version) || !/^[0-9a-f]{40}$/.test(value.commit) ||
    value.opencode_peer !== ">=1.18.15 <2.0.0" || value.opencode_minimum_verified !== "1.18.15") process.exit(2)
process.stdout.write(`${value.version}\t${value.tag}\t${value.commit}`)
NODE
)" || die "RELEASE.json identity is invalid"
  IFS=$'\t' read -r RELEASE_VERSION RELEASE_TAG RELEASE_COMMIT <<< "$identity"
}

verify_checksums() {
  local digest filename extra count=0 expected
  declare -A seen=()
  while IFS=' ' read -r digest filename extra || [ -n "${digest:-}" ]; do
    [ -n "${digest:-}" ] || continue
    [ -z "${extra:-}" ] || die "malformed SHA256SUMS entry"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die "malformed SHA256SUMS digest"
    case "$filename" in
      RELEASE.json|tokenmaxxer|tokenmaxxer.js|tokenmaxxer-tui.js|tokenmaxxer-cli.js) ;;
      *) die "unexpected SHA256SUMS filename: $filename" ;;
    esac
    [ -z "${seen[$filename]+x}" ] || die "duplicate SHA256SUMS entry: $filename"
    seen["$filename"]=1
    count=$((count + 1))
  done < "$STAGING_DIR/SHA256SUMS"
  [ "$count" -eq 5 ] || die "SHA256SUMS must contain exactly five entries"
  for expected in RELEASE.json tokenmaxxer tokenmaxxer.js tokenmaxxer-tui.js tokenmaxxer-cli.js; do
    [ -n "${seen[$expected]+x}" ] || die "SHA256SUMS is missing $expected"
  done
  (cd "$STAGING_DIR" && sha256sum -c SHA256SUMS >/dev/null) || die "SHA256SUMS verification failed"
}

stage_configs() {
  if [ -f "$PACKAGE_JSON" ]; then
    PACKAGE_JSON="$PACKAGE_JSON" node > "$TRANSACTION_DIR/package.json" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.env.PACKAGE_JSON, "utf8"))
value.dependencies = value.dependencies || {}
for (const [name, version] of Object.entries({zod:"^3.25.0", "@opentui/solid":"^0.4.5", "@opentui/core":"^0.4.5", "@opentui/keymap":"^0.4.5"})) if (!value.dependencies[name]) value.dependencies[name] = version
process.stdout.write(JSON.stringify(value, null, 2) + "\n")
NODE
    TARGETS+=("$PACKAGE_JSON")
  fi
  if [ -f "$TUI_CONFIG_JSON" ]; then
    TUI_CONFIG_JSON="$TUI_CONFIG_JSON" node > "$TRANSACTION_DIR/tui.json" <<'NODE'
const fs = require("node:fs")
const value = JSON.parse(fs.readFileSync(process.env.TUI_CONFIG_JSON, "utf8"))
if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tui.json root must be an object")
const plugin = "./plugins/tokenmaxxer-tui.js"
const list = Array.isArray(value.plugin) ? value.plugin : value.plugin ? [value.plugin] : []
value.plugin = [...list.filter((entry) => entry !== plugin), plugin]
process.stdout.write(JSON.stringify(value, null, 2) + "\n")
NODE
    TARGETS+=("$TUI_CONFIG_JSON")
  fi
}

commit_targets() {
  local i target staged temporary backup
  TARGETS=("$PLUGINS_DIR/tokenmaxxer.js" "$PLUGINS_DIR/tokenmaxxer-tui.js" "$PLUGINS_DIR/tokenmaxxer-cli.js" "$BIN_DIR/tokenmaxxer" "$RECEIPT_FILE")
  BACKUPS=()
  COMMITTED=()
  stage_configs
  for i in "${!TARGETS[@]}"; do
    target="${TARGETS[$i]}"
    mkdir -p "$(dirname "$target")"
    case "$(basename "$target")" in
      tokenmaxxer.js) staged="$STAGING_DIR/tokenmaxxer.js";;
      tokenmaxxer-tui.js) staged="$STAGING_DIR/tokenmaxxer-tui.js";;
      tokenmaxxer-cli.js) staged="$STAGING_DIR/tokenmaxxer-cli.js";;
      tokenmaxxer) staged="$STAGING_DIR/tokenmaxxer";;
      tokenmaxxer-release.json) staged="$TRANSACTION_DIR/receipt.json"; printf '{"schema_version":1,"version":"%s","tag":"%s","commit":"%s"}\n' "$RELEASE_VERSION" "$RELEASE_TAG" "$RELEASE_COMMIT" > "$staged";;
      package.json) staged="$TRANSACTION_DIR/package.json";;
      tui.json) staged="$TRANSACTION_DIR/tui.json";;
      *) die "unknown transaction target $target";;
    esac
    temporary="${target}.tmp.$$.$i"
    cp "$staged" "$temporary"
    if [ -e "$target" ]; then
      backup="$TRANSACTION_DIR/backup-$i"
      cp -p "$target" "$backup"
      BACKUPS[$i]="$backup"
    else
      BACKUPS[$i]=""
    fi
    mv "$temporary" "$target"
    COMMITTED[$i]=1
  done
  chmod +x "$BIN_DIR/tokenmaxxer"
}

STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tokenmaxxer-release.XXXXXX")"
TRANSACTION_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tokenmaxxer-transaction.XXXXXX")"
trap 'rollback' ERR INT TERM EXIT
download "$SHA256SUMS_URL" "$STAGING_DIR/SHA256SUMS"
download "$RELEASE_JSON_URL" "$STAGING_DIR/RELEASE.json"
download "$PLUGIN_URL" "$STAGING_DIR/tokenmaxxer.js"
download "$TUI_PLUGIN_URL" "$STAGING_DIR/tokenmaxxer-tui.js"
download "$CLI_PLUGIN_URL" "$STAGING_DIR/tokenmaxxer-cli.js"
download "$LAUNCHER_URL" "$STAGING_DIR/tokenmaxxer"
validate_release
verify_checksums
commit_targets
trap - ERR INT TERM EXIT
cleanup
echo "tokenmaxxer ${RELEASE_VERSION} (${RELEASE_TAG}, ${RELEASE_COMMIT}) installed"
