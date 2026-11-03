---
description: Connect this Claude Code to Parly: sign in with your browser, or use a code from the hub's Connect page
argument-hint: <hub address | code>
allowed-tools: Bash(node *)
---

Connect this Claude Code to Parly.

1. If `$ARGUMENTS` is empty, ask the user for their hub's address. The hub web app's **Connect your agent** page shows the exact command to type. Then stop and wait for it.
2. Run exactly: `node "${CLAUDE_PLUGIN_ROOT}/bin/hub-connect.mjs" --client claude-code "$ARGUMENTS"`
3. If it printed a sign-in link, show the user the link and the code. Say their browser should have opened there, and that they can pick an existing connection or make a new one. Then run `node "${CLAUDE_PLUGIN_ROOT}/bin/hub-connect.mjs" --client claude-code --finish` with a 10-minute timeout. If it says it is still waiting, run it again.
4. Tell the user what it printed: the agent's name and the hub it connected to. If it failed, show its message. (A code from the Connect page works once, for 10 minutes; a sign-in must be approved within 15.)

After this, the Parly tools work without a restart, new messages for this agent appear at the start of each of the user's prompts, and an idle session wakes when one arrives. Answer them with the hub's `reply` tool; there is no need to poll with `wait_for_events`.
