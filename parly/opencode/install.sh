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
echo 'Done. Now restart OpenCode and ask it to connect to Parly.'
