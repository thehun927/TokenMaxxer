#!/usr/bin/env bash
# Fixture: staged release installer (valid) — PR-10 §7 contract shape.
# This is a TEST-ONLY fixture under test/release/installer/. It documents the
# exact-tag URL pinning contract the production install.sh must implement in
# Wave 5: every payload URL is pinned to the embedded exact release tag and
# no payload URL fetches `main` or a second `latest` lookup.

set -euo pipefail

RELEASE_VERSION="0.1.0"
RELEASE_TAG="v0.1.0"
RELEASE_COMMIT="0123456789abcdef0123456789abcdef01234567"
RELEASE_BASE_URL="https://github.com/thehun927/TokenMaxxer/releases/download/${RELEASE_TAG}"

PLUGIN_URL="${RELEASE_BASE_URL}/tokenmaxxer.js"
TUI_PLUGIN_URL="${RELEASE_BASE_URL}/tokenmaxxer-tui.js"
CLI_PLUGIN_URL="${RELEASE_BASE_URL}/tokenmaxxer-cli.js"
LAUNCHER_URL="${RELEASE_BASE_URL}/tokenmaxxer"
SHA256SUMS_URL="${RELEASE_BASE_URL}/SHA256SUMS"
RELEASE_JSON_URL="${RELEASE_BASE_URL}/RELEASE.json"

download() {
  local url="$1"
  local destination="$2"
  local temporary
  temporary="$(mktemp "${destination}.tmp.XXXXXX")"
  if command -v curl &>/dev/null; then
    curl -fsSL --retry 3 --retry-delay 1 --retry-connrefused "$url" -o "$temporary"
  elif command -v wget &>/dev/null; then
    wget -q --tries=3 --waitretry=1 "$url" -O "$temporary"
  else
    rm -f "$temporary"
    echo "  ✗ Need curl or wget to download." >&2
    exit 1
  fi
  mv "$temporary" "$destination"
}

# Download phase — no mutation of an existing install.
STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT

download "$SHA256SUMS_URL" "$STAGING_DIR/SHA256SUMS"
download "$RELEASE_JSON_URL" "$STAGING_DIR/RELEASE.json"
download "$PLUGIN_URL" "$STAGING_DIR/tokenmaxxer.js"
download "$TUI_PLUGIN_URL" "$STAGING_DIR/tokenmaxxer-tui.js"
download "$CLI_PLUGIN_URL" "$STAGING_DIR/tokenmaxxer-cli.js"
download "$LAUNCHER_URL" "$STAGING_DIR/tokenmaxxer"

# Verify every payload before touching the existing install.
(
  cd "$STAGING_DIR"
  sha256sum -c SHA256SUMS
)

echo "tokenmaxxer ${RELEASE_VERSION} (${RELEASE_TAG}, ${RELEASE_COMMIT})"
