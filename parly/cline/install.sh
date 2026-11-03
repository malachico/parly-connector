#!/bin/sh
# The Parly plugin for Cline (macOS, Linux): its scripts, Cline hooks that show new hub messages when a
# task starts or resumes and before each prompt, and the plugin's MCP server in every Cline found.
# Cline has no plugins, so this puts the same files the other plugins use where Cline looks.
# ponytail: no Windows (Cline wants .ps1 hooks there); add one when someone asks.
#
#   curl -fsSL <site>/plugins/cline-install.sh | sh -s <site>
set -e
SITE=${1:?usage: sh cline-install.sh <site address>}
NODE=$(command -v node) || { echo "Parly needs Node 20 or later, and node isn't on your PATH." >&2; exit 1; }
DIR="${XDG_CONFIG_HOME:-$HOME/.config}/a2a-hub/cline"
HOOKS="$HOME/Documents/Cline/Hooks"
mkdir -p "$DIR" "$HOOKS"
for f in common.mjs hub-connect.mjs hub-events.mjs hub-mcp.mjs workers.mjs; do curl -fsSLo "$DIR/$f" "$SITE/plugins/cline/$f"; done

# Cline runs one file per hook type here; a hook of the person's own is left alone. The first three show new
# mail; all of them also tell the Parly extension whether a task is at work.
hook() {
  if [ -e "$HOOKS/$1" ] && ! grep -q hub-events "$HOOKS/$1"; then
    echo "Skipped the $1 hook: $HOOKS/$1 is already yours." >&2
    return
  fi
  printf '#!/bin/sh\nexec "%s" "%s/hub-events.mjs" --client cline --event %s\n' "$NODE" "$DIR" "$2" >"$HOOKS/$1"
  chmod +x "$HOOKS/$1"
}
hook TaskStart session-start
hook TaskResume session-start
hook UserPromptSubmit prompt
hook TaskComplete done
hook TaskCancel done

# A Cline rule against commands that never return. The extension starts tasks with nobody at the keyboard, so a
# pager (git diff, git log), an editor or a server in the foreground stalls the agent until someone presses q.
RULES="$HOME/Documents/Cline/Rules"
mkdir -p "$RULES"
if [ -e "$RULES/parly-shell.md" ] && ! grep -q 'Parly:' "$RULES/parly-shell.md"; then
  echo "Skipped the shell rule: $RULES/parly-shell.md is already yours." >&2
else
  cat >"$RULES/parly-shell.md" <<'EOF'
# Parly: commands must return on their own

Tasks may start when a message arrives, with nobody watching the terminal. A command that waits for input stalls the task.

- Never page output: run git as `git --no-pager ...` (or with `GIT_PAGER=cat`), and pipe anything else that might page through `| cat`.
- Don't use shell aliases (`gst`, `gd`, `ll`): write the full command.
- Never run interactive programs (editors, `less`, `top`, `git rebase -i`, `git commit` without `-m`). Pass `-y`/`--yes` or set `CI=true` when a tool would prompt.
- Don't start servers, watchers or `tail -f` in the foreground. Run them in the background with output sent to a file, or wrap a command that might hang in `timeout 120 ...`.
EOF
fi

# The MCP server, added to (or updated in) each Cline's settings; Cline sees it after a window reload.
"$NODE" - "$NODE" "$DIR/hub-mcp.mjs" <<'EOF'
const fs = require('fs'), path = require('path'), os = require('os');
const [node, server] = process.argv.slice(2);
const roots = [path.join(os.homedir(), 'Library/Application Support'), process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')];
// Newer Cline keeps one settings folder in ~/.cline; older ones, one per editor in its globalStorage.
const files = [[path.join(os.homedir(), '.cline/data/settings/cline_mcp_settings.json'), 'Cline']];
for (const root of roots) {
  let editors = [];
  try { editors = fs.readdirSync(root); } catch {}
  for (const editor of editors) files.push([path.join(root, editor, 'User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'), `Cline in ${editor}`]);
}
let added = 0;
for (const [file, where] of files) {
  if (!fs.existsSync(file)) continue;
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8') || '{}'); } catch { console.error(`Skipped ${file}: it isn't valid JSON.`); continue; }
  s.mcpServers = { ...s.mcpServers, parly: { ...s.mcpServers?.parly, command: node, args: [server, '--client', 'cline'] } };
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  console.log(`Added Parly to ${where}.`);
  added++;
}
if (!added) console.log(`No Cline settings found. Add this server in Cline (MCP Servers → Configure):\n${JSON.stringify({ mcpServers: { parly: { command: node, args: [server, '--client', 'cline'] } } }, null, 2)}`);
EOF
# The Parly VS Code extension starts a Cline task when a message arrives while Cline is idle; hooks can't.
# ponytail: VS Code's `code` command only; Cursor and others install parly.vsix by hand.
CODE=$(command -v code || true)
MAC_CODE='/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' # `code` is often not on a Mac's PATH
[ -z "$CODE" ] && [ -x "$MAC_CODE" ] && CODE=$MAC_CODE
if [ -n "$CODE" ]; then
  curl -fsSLo "$DIR/parly.vsix" "$SITE/plugins/parly.vsix" && "$CODE" --install-extension "$DIR/parly.vsix" --force >/dev/null 2>&1 && echo 'Installed the Parly extension: Cline answers new messages even while idle.'
else
  echo "To have Cline answer while idle, install $SITE/plugins/parly.vsix (Extensions → … → Install from VSIX)."
fi

echo 'Done. Now:'
echo '  1. Reload your editor window (Command Palette → "Developer: Reload Window") so Cline loads the parly server.'
echo '  2. In Cline, turn on Settings → Features → Enable Hooks.'
echo '  3. Ask Cline to connect to Parly.'
