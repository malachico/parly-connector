// Wakes Copilot Chat and Cline for Parly mail. VS Code can't let a plugin hook or MCP server start a turn in an
// idle chat, so this long-polls the hub's event feed with the Parly plugin's own connection (~/.config/a2a-hub/
// <client>.json, written by the plugin's connect tool) and, when something new is for that agent, submits a
// prompt as if the person typed it. The plugin's hooks still cover a busy chat.
const vscode = require('vscode');

const PROMPT = 'New Parly messages arrived. Read them with check_inbox; it says when to reply.';
const CLINE = 'saoudrizwan.claude-dev';

let stopped = false;

/** Each client the plugin can be connected as, and how to put the prompt in front of it; false: not now, try later. */
const CLIENTS = {
  vscode: async () => {
    // ponytail: submitted even if the chat is mid-turn (VS Code queues it); blockOnResponse waits for the answer,
    // so a burst of mail is one prompt, not one per message.
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: PROMPT, preserveInput: true, blockOnResponse: true });
    return true;
  },
  cline: async ({ readState }) => {
    // Cline's own API: a new task with the prompt, unless one is at work (its hooks keep `busy` in the plugin's
    // state). Its sendMessage would continue a finished task, but does nothing, silently, when none is open.
    // ponytail: a task Cline drops without its TaskComplete/TaskCancel hook (a crash) stays busy until this
    // window's next start; add a timeout if that bites.
    if (readState('cline').busy) return false;
    const api = await vscode.extensions.getExtension(CLINE)?.activate();
    await api?.startNewTask(PROMPT);
    return true;
  },
};

async function activate(context) {
  context.subscriptions.push({ dispose: () => (stopped = true) });
  // common.mjs is the plugin's (copied in when packaged): connection file, token refresh, hub calls.
  const common = await import('./common.mjs');
  // A window starting has no Cline task at work yet, whatever the last one left behind.
  if (common.readConfig('cline')) common.writeState('cline', { ...common.readState('cline'), busy: false });
  for (const [client, wake] of Object.entries(CLIENTS)) watch(client, wake, common);
}

async function watch(client, wake, common) {
  const { freshConfig, hubFetch } = common;
  const wakened = new Set(); // message ids already announced
  let cursor;
  let waiting = false; // mail the client hasn't been asked to answer yet (it was busy): asked after the next poll
  while (!stopped) {
    try {
      const config = await freshConfig(client);
      if (!config) {
        await sleep(30_000); // not connected yet: the plugin's connect tool writes the file
        continue;
      }
      const q = new URLSearchParams(cursor ? { cursor, wait: '25' } : { wait: '0' }); // first call: start from now
      const res = await hubFetch(config, `/events?${q}`, { timeoutMs: 40_000 });
      const first = !cursor;
      cursor = res.cursor || cursor;
      if (first) continue;
      const fresh = (res.events ?? []).filter((m) => {
        if (!m.forYou || m.fromId === config.agentId || wakened.has(m.id)) return false;
        wakened.add(m.id);
        return true;
      });
      if (fresh.length) waiting = true;
      if (waiting && vscode.workspace.getConfiguration('parly').get('answerWhileIdle')) waiting = !(await wake(common));
    } catch {
      await sleep(10_000); // hub down, token ended, chat busy: try again shortly
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { activate, deactivate: () => (stopped = true) };
