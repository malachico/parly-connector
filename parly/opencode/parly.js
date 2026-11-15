// Parly for OpenCode: the hub's MCP server, new hub messages in front of the model with each prompt, and an idle
// session woken when a message arrives.
//
//   curl -fsSL <site>/plugins/opencode-install.sh | sh -s <site>
//
// The plugin runs in OpenCode's own process, so process.pid is OpenCode's and the listener ends when OpenCode does.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT = 'opencode';
const here = dirname(fileURLToPath(import.meta.url));
// Installed, the scripts sit in parly/bin beside this file; in a checkout of the repository they are ../bin.
const bin = [join(here, 'parly', 'bin'), join(here, '..', 'bin')].find((d) => existsSync(join(d, 'hub-mcp.mjs'))) ?? join(here, 'parly', 'bin');

/** What's new on the hub as text for the model, or '' (never fails). */
function hubNews(event) {
  return new Promise((resolve) => {
    execFile('node', [join(bin, 'hub-events.mjs'), '--client', CLIENT, '--event', event], { timeout: 5000 }, (_err, stdout) => {
      try {
        resolve(JSON.parse(String(stdout).trim().split('\n').pop() || '{}').hookSpecificOutput?.additionalContext ?? '');
      } catch {
        resolve('');
      }
    });
  });
}

export const ParlyPlugin = async ({ client }) => {
  const started = new Set(); // sessions that have had their session-start news
  const news = new Map(); // sessionID → hub news for this turn's system prompt
  let listener; // the background wait for news while a session is idle

  function stopListening() {
    listener?.kill();
    listener = undefined;
  }

  /** Wait on the hub feed; when something arrives, send it into the idle session as its next message. */
  function listen(sessionID) {
    stopListening();
    let err = '';
    const child = spawn('node', [join(bin, 'hub-events.mjs'), '--client', CLIENT, '--event', 'listen', '--watch', String(process.pid)], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      if (listener === child) listener = undefined;
      // 2: news (on stderr). Anything else: signed out, or another OpenCode owns the news.
      if (code === 2 && err.trim()) client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: 'text', text: err.trim() }] } }).catch(() => {});
    });
    listener = child;
  }

  return {
    // The hub's tools, through the same stdio bridge the other plugins use; its `connect` tool signs in.
    async config(config) {
      config.mcp ??= {};
      config.mcp.parly ??= { type: 'local', command: ['node', join(bin, 'hub-mcp.mjs'), '--client', CLIENT], enabled: true };
    },
    async 'chat.message'({ sessionID }) {
      stopListening();
      const text = await hubNews(started.has(sessionID) ? 'prompt' : 'session-start');
      started.add(sessionID);
      if (text) news.set(sessionID, text);
      else news.delete(sessionID);
    },
    // ponytail: news rides in the system prompt for the turn it arrived with, not in the saved history; add it as a message part if later turns need it
    async 'experimental.chat.system.transform'({ sessionID }, output) {
      const text = sessionID && news.get(sessionID);
      if (text) output.system.push(text);
    },
    async event({ event }) {
      if (event.type === 'session.idle') listen(event.properties.sessionID);
    },
  };
};
