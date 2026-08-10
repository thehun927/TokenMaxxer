#!/usr/bin/env bash
set -euo pipefail

# tokenmaxxer — opencode plugin for session longevity & cross-session memory
# One-liner install: curl -fsSL https://raw.githubusercontent.com/thehun927/TokenMaxxer/main/install.sh | bash

PLUGINS_DIR="${HOME}/.config/opencode/plugins"
PACKAGE_JSON="${HOME}/.config/opencode/package.json"
TUI_CONFIG_JSON="${HOME}/.config/opencode/tui.json"
BIN_DIR="${HOME}/.local/bin"
PLUGIN_URL="https://raw.githubusercontent.com/thehun927/TokenMaxxer/main/dist/index.js"
PLUGIN_FILE="${PLUGINS_DIR}/tokenmaxxer.js"
TUI_PLUGIN_URL="https://raw.githubusercontent.com/thehun927/TokenMaxxer/main/dist/tui.js"
TUI_PLUGIN_FILE="${PLUGINS_DIR}/tokenmaxxer-tui.js"
CLI_PLUGIN_URL="https://raw.githubusercontent.com/thehun927/TokenMaxxer/main/dist/cli.js"
CLI_PLUGIN_FILE="${PLUGINS_DIR}/tokenmaxxer-cli.js"
LAUNCHER_URL="https://raw.githubusercontent.com/thehun927/TokenMaxxer/main/bin/tokenmaxxer"
LAUNCHER_FILE="${BIN_DIR}/tokenmaxxer"

download() {
  local url="$1"
  local destination="$2"
  local temporary

  temporary="$(mktemp "${destination}.tmp.XXXXXX")"
  if command -v curl &>/dev/null; then
    if ! curl -fsSL --retry 3 --retry-delay 1 --retry-connrefused "$url" -o "$temporary"; then
      rm -f "$temporary"
      echo "  ✗ Could not download $url"
      exit 1
    fi
  elif command -v wget &>/dev/null; then
    if ! wget -q --tries=3 --waitretry=1 "$url" -O "$temporary"; then
      rm -f "$temporary"
      echo "  ✗ Could not download $url"
      exit 1
    fi
  else
    rm -f "$temporary"
    echo "  ✗ Need curl or wget to download."
    exit 1
  fi

  mv "$temporary" "$destination"
}

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                    tokenmaxxer installer                     ║"
echo "║         session longevity & cross-session memory             ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# 1. Install the user launcher
mkdir -p "$BIN_DIR"
echo "  ↓ Downloading tokenmaxxer launcher..."
download "$LAUNCHER_URL" "$LAUNCHER_FILE"
chmod +x "$LAUNCHER_FILE"
echo "  ✓ Launcher installed: $LAUNCHER_FILE"

case ":${PATH:-}:" in
  *":${BIN_DIR}:"*)
    ;;
  *)
    echo "  ⚠ ~/.local/bin is not on your PATH."
    echo "    Add this line to your shell profile:"
    echo '    export PATH="$HOME/.local/bin:$PATH"'
    ;;
esac

# 2. Create plugins directory
mkdir -p "$PLUGINS_DIR"
echo "  ✓ Plugins directory: $PLUGINS_DIR"

# 3. Download the plugin
echo "  ↓ Downloading plugin..."
download "$PLUGIN_URL" "$PLUGIN_FILE"
echo "  ✓ Plugin installed: $PLUGIN_FILE"

# 4. Download the separate TUI plugin target
echo "  ↓ Downloading TUI plugin..."
download "$TUI_PLUGIN_URL" "$TUI_PLUGIN_FILE"
echo "  ✓ TUI plugin installed: $TUI_PLUGIN_FILE"

# 4b. Download the separate CLI bundle (human review boundary)
echo "  ↓ Downloading CLI bundle..."
download "$CLI_PLUGIN_URL" "$CLI_PLUGIN_FILE"
echo "  ✓ CLI bundle installed: $CLI_PLUGIN_FILE"

# 5. Ensure the server and TUI dependencies are in the global package.json
if [ -f "$PACKAGE_JSON" ]; then
  if command -v node &>/dev/null; then
    if PACKAGE_JSON="$PACKAGE_JSON" node <<'NODE'
const fs = require('fs');

const packagePath = process.env.PACKAGE_JSON;
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
pkg.dependencies = pkg.dependencies || {};

const required = {
  zod: '^3.25.0',
  '@opentui/solid': '^0.4.5',
  '@opentui/core': '^0.4.5',
  '@opentui/keymap': '^0.4.5',
};

for (const [name, version] of Object.entries(required)) {
  if (!pkg.dependencies[name]) pkg.dependencies[name] = version;
}

fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
NODE
    then
      echo "  ✓ Ensured zod and OpenTUI dependencies in global package.json"
    else
      echo "  ⚠ Could not update $PACKAGE_JSON (invalid or unreadable JSON)."
      echo "    Manually add zod \"^3.25.0\" and @opentui/solid, @opentui/core, @opentui/keymap \"^0.4.5\" to its dependencies."
    fi
  else
    echo "  ⚠ Could not add zod to package.json (node not found)."
    echo "    Manually add \"zod\": \"^3.25.0\" to $PACKAGE_JSON dependencies."
    echo "    Also add \"@opentui/solid\": \"^0.4.5\", \"@opentui/core\": \"^0.4.5\", and \"@opentui/keymap\": \"^0.4.5\"."
  fi
else
  echo "  ⚠ No global package.json found at $PACKAGE_JSON"
  echo "    opencode will create it on next start and run bun install."
fi

# 6. Add the TUI plugin to tui.json without removing or duplicating entries
if command -v node &>/dev/null; then
  if TUI_CONFIG_JSON="$TUI_CONFIG_JSON" node <<'NODE'
const fs = require('fs');

const configPath = process.env.TUI_CONFIG_JSON;
const pluginPath = './plugins/tokenmaxxer-tui.js';
let config = {};

if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('the root value must be a JSON object');
  }
}

const plugins = config.plugin === undefined
  ? []
  : Array.isArray(config.plugin)
    ? config.plugin
    : [config.plugin];
config.plugin = plugins.filter((entry) => entry !== pluginPath);
config.plugin.push(pluginPath);

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
NODE
  then
    echo "  ✓ TUI plugin enabled in $TUI_CONFIG_JSON"
  else
    echo "  ⚠ Could not update $TUI_CONFIG_JSON; it was not changed."
    echo "    Manually add \"./plugins/tokenmaxxer-tui.js\" once to its plugin array, keeping existing entries."
  fi
else
  echo "  ⚠ Node not found; could not update $TUI_CONFIG_JSON."
  echo "    Manually add \"./plugins/tokenmaxxer-tui.js\" once to its plugin array, keeping existing entries."
fi

# 7. Print success
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ✓ Installation complete!                                    ║"
echo "║                                                              ║"
echo "║  Both server layers are active in all projects:              ║"
echo "║  • Layer 1: compaction hook fires on /compact               ║"
echo "║  • Layer 2: memory + tools work on session idle              ║"
echo "║  • 7 custom tools registered (get_project_state, etc.)      ║"
echo "║  • TUI: right-side memory indicator only                     ║"
echo "║  • Human CLI: tokenmaxxer decisions/promote/supersede        ║"
echo "║                                                              ║"
echo "║  No per-project config required. Just restart opencode.      ║"
echo "║                                                              ║"
echo "║  Optional tuning (opencode.json):                           ║"
echo "║    \"compaction\": { \"prune\": true, \"reserved\": 25000 }       ║"
echo "║    \"watcher\": { \"ignore\": [\".opencode/memory/**\"] }        ║"
echo "║                                                              ║"
echo "║  Kill switch: TOKENMAXXER_NO_PROMPT=1                        ║"
echo "║  Debug: call the tokenmaxxer_status tool                     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
