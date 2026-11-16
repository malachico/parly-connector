#!/bin/sh
# The Parly plugin for OpenCode (macOS, Linux): parly.js in OpenCode's global plugins folder, which it loads at
# start, and the scripts it runs beside it in parly/bin.
#
#   curl -fsSL <site>/plugins/opencode-install.sh | sh -s <site>
set -e
SITE=${1:?usage: sh opencode-install.sh <site address>}
command -v node >/dev/null || { echo "Parly needs Node 22 or later, and node isn't on your PATH." >&2; exit 1; }
DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
mkdir -p "$DIR/parly/bin"
curl -fsSLo "$DIR/parly.js" "$SITE/plugins/opencode/parly.js"
for f in common.mjs hub-connect.mjs hub-events.mjs hub-mcp.mjs workers.mjs; do curl -fsSLo "$DIR/parly/bin/$f" "$SITE/plugins/opencode/bin/$f"; done
# OpenCode unloads a location's plugins after an hour without session activity, which kills the listener that
# answers Parly messages; turn that off unless the user already set it (opencode.jsonc is left to them).
CONF="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
node -e '
const fs = require("fs"), f = process.argv[1];
let c = {};
try { c = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { if (e.code !== "ENOENT") { console.error(`Left ${f} alone (${e.message}); add "experimental": {"location_idle_timeout": false} so Parly keeps listening.`); process.exit(); } }
c.experimental ??= {};
if (c.experimental.location_idle_timeout !== undefined) process.exit();
c.experimental.location_idle_timeout = false;
fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
' "$CONF"
echo 'Done. Needs OpenCode 2.x. Restart OpenCode and ask it to connect to Parly (the plugin replaces any "parly" MCP server you added by hand).'
