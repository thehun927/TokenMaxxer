#!/usr/bin/env bash
set -euo pipefail

# tokenmaxxer — opencode plugin for session longevity & cross-session memory
# One-liner install: curl -fsSL https://raw.githubusercontent.com/thehun927/TokenMaxxer/main/install.sh | bash

PLUGINS_DIR="${HOME}/.config/opencode/plugins"
PACKAGE_JSON="${HOME}/.config/opencode/package.json"
PLUGIN_URL="https://raw.githubusercontent.com/thehun927/TokenMaxxer/main/dist/index.js"
PLUGIN_FILE="${PLUGINS_DIR}/tokenmaxxer.js"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                    tokenmaxxer installer                     ║"
echo "║         session longevity & cross-session memory             ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# 1. Create plugins directory
mkdir -p "$PLUGINS_DIR"
echo "  ✓ Plugins directory: $PLUGINS_DIR"

# 2. Download the plugin
echo "  ↓ Downloading plugin..."
if command -v curl &>/dev/null; then
  curl -fsSL "$PLUGIN_URL" -o "$PLUGIN_FILE"
elif command -v wget &>/dev/null; then
  wget -q "$PLUGIN_URL" -O "$PLUGIN_FILE"
else
  echo "  ✗ Need curl or wget to download."
  exit 1
fi
echo "  ✓ Plugin installed: $PLUGIN_FILE"

# 3. Ensure zod is in the global package.json
if [ -f "$PACKAGE_JSON" ]; then
  if ! grep -q '"zod"' "$PACKAGE_JSON" 2>/dev/null; then
    # Add zod to dependencies
    TMP=$(mktemp)
    if command -v node &>/dev/null; then
      node -e "
        const fs = require('fs');
        const pkg = JSON.parse(fs.readFileSync('$PACKAGE_JSON', 'utf-8'));
        pkg.dependencies = pkg.dependencies || {};
        pkg.dependencies.zod = '^3.25.0';
        fs.writeFileSync('$PACKAGE_JSON', JSON.stringify(pkg, null, 2) + '\n');
      "
      echo "  ✓ Added zod to global package.json"
    else
      echo "  ⚠ Could not add zod to package.json (node not found)."
      echo "    Manually add \"zod\": \"^3.25.0\" to $PACKAGE_JSON dependencies."
    fi
  else
    echo "  ✓ zod already in global package.json"
  fi
else
  echo "  ⚠ No global package.json found at $PACKAGE_JSON"
  echo "    opencode will create it on next start and run bun install."
fi

# 4. Print per-project config instructions
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Installation complete! Layer 1 (compaction hook) is active. ║"
echo "║                                                              ║"
echo "║  For Layer 2 (memory + tools), add this to each project's    ║"
echo "║  opencode.json:                                              ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  {                                                           ║"
echo "║    \"compaction\": { \"auto\": true, \"prune\": true,             ║"
echo "║                      \"reserved\": 15000 },                    ║"
echo "║    \"instructions\": [\"AGENTS.md\",                             ║"
echo "║                     \".opencode/memory/HEADER.md\"],            ║"
echo "║    \"watcher\": {                                               ║"
echo "║      \"ignore\": [\".opencode/memory/**\"]                       ║"
echo "║    }                                                         ║"
echo "║  }                                                           ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Then restart opencode in that project.                      ║"
echo "║                                                              ║"
echo "║  Kill switch: TOKENMAXXER_NO_PROMPT=1                        ║"
echo "║  Debug: call the tokenmaxxer_status tool                     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
