// Parly for OpenCode 2.x: the hub's MCP server, new hub messages added to each prompt, and an idle session woken
// when a message arrives.
//
//   curl -fsSL <site>/plugins/opencode-install.sh | sh -s <site>
//
// The plugin runs in OpenCode's own process, so process.pid is OpenCode's and the listener ends when OpenCode does.
// ponytail: OpenCode 2.x plugin format only (export default { id, setup }); 1.x loaded named function exports.
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

async function setup({ mcp, session }) {
  const started = new Set(); // sessions that have had their session-start news
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
      if (code === 2 && err.trim()) session.prompt({ sessionID, text: err.trim() }).catch(() => {});
    });
    listener = child;
  }

  // The hub's tools, through the same stdio bridge the other plugins use; its `connect` tool signs in and saves the
  // token the listener needs. It replaces a hand-added remote "parly" server, whose OAuth sign-in the listener can't use.
  await mcp.transform((servers) => servers.set('parly', { type: 'local', command: ['node', join(bin, 'hub-mcp.mjs'), '--client', CLIENT] }));
  // ponytail: news is appended to the prompt text, so it stays in the saved history; move it to the "context" hook if that gets noisy
  await session.hook('prompt', async (input) => {
    stopListening();
    const text = await hubNews(started.has(input.sessionID) ? 'prompt' : 'session-start');
    started.add(input.sessionID);
    if (text) input.prompt.text += `\n\n${text}`;
  });
  await session.hook('experimental.idle', ({ sessionID }) => listen(sessionID));
  return stopListening;
}

export default { id: 'parly', setup };
