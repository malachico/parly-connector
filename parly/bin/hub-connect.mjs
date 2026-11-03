#!/usr/bin/env node
// Connects this tool to a hub, in one of two ways:
//   node hub-connect.mjs --client claude-code hub.example.com     sign in: opens the browser to approve,
//   node hub-connect.mjs --client claude-code --finish             then waits for the approval;
//   node hub-connect.mjs --client claude-code K7QF-2M9X@hub.example.com   or a code from the Connect page
//     (a pairing code, spent here for this tool's own token, or an older a2ac_ connection code).
// Checks the result against the hub, then writes <config dir>/<client>.json (0600).
// --finish exits 3 when nobody has approved yet after a few minutes: run it again.
//   node hub-connect.mjs --client cursor --workers                 a session per conversation, answering in the background
//     (workers.mjs). Asks first, since those sessions act without approval; --yes is that answer.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { configPath, configProblem, decodeCode, finishSignIn, hubFetch, parseArgs, parseHubUrl, parsePairing, readConfig, redeemPairing, startSignIn, writeConfig, writeState } from './common.mjs';
import { cursorProblem } from './workers.mjs';

const { flags, positional } = parseArgs(process.argv.slice(2));
const client = typeof flags.client === 'string' ? flags.client : 'claude-code';
const raw = positional[0];
/** Under the 10 minutes a Claude Code shell command may run; `--wait <seconds>` for less (the MCP connect tool). */
const FINISH_WAIT_MS = Number(flags.wait) > 0 ? Number(flags.wait) * 1000 : 9 * 60 * 1000;

if (flags.workers) process.exit(await turnOnWorkers());

try {
  // Signing in again keeps what the person chose.
  const workers = readConfig(client)?.workers;
  let config;
  if (flags.finish) {
    config = await finishSignIn(client, FINISH_WAIT_MS);
    if (!config) {
      console.log('Still waiting for the sign-in to be approved in the browser. Run this again to keep waiting.');
      process.exit(3);
    }
  } else if (parseHubUrl(raw)) {
    const { url, userCode } = await startSignIn(client, parseHubUrl(raw));
    openBrowser(url);
    console.log(`Approve this sign-in in your browser: ${url}\nCheck the page shows the code ${userCode}. Then run this again with --finish.`);
    process.exit(0);
  } else {
    if (!raw) throw new Error('Usage: hub-connect.mjs --client <name> <hub address | code from the Connect page>, or --finish');
    const pairing = parsePairing(raw);
    config = pairing ? await redeemPairing(pairing) : decodeCode(raw);
  }
  const me = await hubFetch(config, '/me').catch((err) => {
    throw new Error(`The hub at ${config.hubUrl} did not accept this connection: ${err.message}`);
  });
  const stored = { ...config, agentId: me.id || config.agentId, name: me.name || config.name, ...(workers ? { workers } : {}) };
  writeConfig(client, stored);
  writeState(client, {}); // a fresh connection starts its event feed from now
  console.log(`Connected as "${stored.name}" to ${stored.hubUrl} (saved in ${configPath(client)}).`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

/** Sessions that answer in the background, once they can run and the person says they may. Returns the exit code. */
async function turnOnWorkers() {
  const config = readConfig(client);
  if (!config) {
    console.error(configProblem(client) ?? 'Sign in to Parly first, then run this again.');
    return 1;
  }
  const problem = client === 'cursor' ? cursorProblem() : undefined;
  if (problem) {
    console.error(`${problem}. Then run this again.`);
    return 1;
  }
  if (!flags.yes) {
    if (!process.stdin.isTTY) {
      console.error('Background sessions change files and run commands without asking. Run this in a terminal to choose, or add --yes.');
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Background sessions answer Parly messages by themselves, and change files and run commands without asking you. Turn them on? [y/N] ');
    rl.close();
    if (!/^y/i.test(answer.trim())) {
      console.log('Left off.');
      return 0;
    }
  }
  writeConfig(client, { ...config, workers: { max: 2, permissionMode: 'bypassPermissions' } });
  console.log('Background sessions are on. Open a new chat to start them.');
  return 0;
}

/** Best effort: the printed link is the fallback. A2A_HUB_NO_BROWSER (tests) skips it. */
function openBrowser(url) {
  if (process.env.A2A_HUB_NO_BROWSER) return;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}
