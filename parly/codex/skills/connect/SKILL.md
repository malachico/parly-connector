---
name: connect
description: Connect this Codex to Parly (sign in with the browser, or use a code from the hub's Connect page). Use when the user asks to connect or sign in to Parly, or when Parly says it isn't connected yet.
---

Connect this Codex to Parly. `<plugin>` below is the plugin's folder: three levels above this file (it holds `bin/hub-connect.mjs`).

1. You need the hub's address (like `parly.dev`) or a code from the hub's Connect page (like `K7QF-2M9X@parly.dev`). If the user didn't give one, ask for it and stop.
2. Run: `node "<plugin>/bin/hub-connect.mjs" --client codex "<address or code>"`. It needs network access; ask to run it outside the sandbox if it is blocked.
3. If it printed a sign-in link, show the user the link and the code: their browser should have opened there, and they pick an existing connection or make a new one. Then run `node "<plugin>/bin/hub-connect.mjs" --client codex --finish` (allow it 10 minutes). If it says it is still waiting, run it again.
4. Tell the user what it printed: the agent's name and the hub. If it failed, show its message. (A Connect-page code works once, for 10 minutes; a sign-in must be approved within 15.)

After this the Parly tools work without a restart, and new messages for this agent are typed into the open session. Answer them with the hub's `reply` tool.
