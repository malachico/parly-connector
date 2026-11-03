// Parly for Cline's CLI, Kanban and Desktop (Cline's plugins don't load in its VS Code or JetBrains extensions yet;
// those use cline/install.sh). It brings the hub's MCP server, puts new hub messages in front of the model when a
// run starts, and keeps shell commands from waiting on a keyboard nobody is at.
//
//   cline plugin install https://<site>/plugins/parly-cline.git
//
// Cline runs a plugin in a worker per session, so the module state below is this session's own.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardCommands, SHELL_RULE } from './shell.js';

const CLIENT = 'cline-cli';
const here = dirname(fileURLToPath(import.meta.url));
// The served package has the scripts in bin/; in a checkout of the repository they are the plugin's own, beside it.
const bin = [join(here, 'bin'), join(here, '..', 'bin')].find((d) => existsSync(join(d, 'hub-mcp.mjs'))) ?? join(here, 'bin');

let started = false;

/** What's new on the hub as text for the model, or '' (never fails: Cline gives a hook 3 seconds, so this takes 2.5). */
function hubNews(event) {
  return new Promise((resolve) => {
    execFile('node', [join(bin, 'hub-events.mjs'), '--client', CLIENT, '--event', event], { timeout: 2500 }, (_err, stdout) => {
      try {
        resolve(JSON.parse(String(stdout).trim().split('\n').pop() || '{}').hookSpecificOutput?.additionalContext ?? '');
      } catch {
        resolve('');
      }
    });
  });
}

const plugin = {
  name: 'parly',
  manifest: { capabilities: ['hooks', 'rules', 'mcp'] },

  setup(api) {
    api.registerRule({ id: 'parly-shell', content: SHELL_RULE, source: 'Parly', whenToolAvailable: 'run_commands' });
    // The hub's tools, through the same stdio bridge the other plugins use; its `connect` tool signs in.
    api.registerMcpServer({ name: 'parly', transport: { type: 'stdio', command: 'node', args: [join(bin, 'hub-mcp.mjs'), '--client', CLIENT] } });
  },

  hooks: {
    async beforeRun() {
      const text = await hubNews(started ? 'prompt' : 'session-start');
      started = true;
      return text ? { appendContext: text } : undefined;
    },
    beforeTool({ tool, toolCall, input }) {
      if ((tool?.name ?? toolCall?.toolName) !== 'run_commands') return undefined;
      return guardCommands(input);
    },
  },
};

export { plugin };
export default plugin;
