// One session per conversation (Claude Code, Codex and Cursor): the agent keeps one identity on Parly, but each conversation
// it's in gets its own headless session, so a long task in one thread doesn't hold up a quick question in another
// and no session drags every conversation's context along.
//
// The session that owns the hub news (hub-events.mjs `listen`) is the router, the one long-lived process: it queues
// each new message under its conversation, in memory, and runs that conversation's session (a new one the first time,
// the same one resumed after) as a child, at most `workers.max` at once. Mail for a conversation whose session is
// running waits for it to exit and goes in its next run. The feed's saved cursor only moves while nothing is queued,
// so a router that dies has the hub replay what it hadn't finished. A session that fails still answers, so nobody waits on silence.
// Staying quiet is a fine outcome, but only after reading: a run that ends without `check_inbox` never saw its
// messages (it started without Parly's tools, say), so it goes again a couple of times and then says so.
//
// On in `<client>.json`, written by `hub-connect.mjs --workers`: "workers": {"max": 2, "permissionMode": "bypassPermissions"}. permissionMode is required
// (Claude Code's --permission-mode; for Codex, bypassPermissions means --dangerously-bypass-approvals-and-sandbox,
// anything else --full-auto; for Cursor, bypassPermissions means --force, anything else only proposes file changes): a
// headless session can't ask the person, so what it may do is the person's call.
//
// Cursor's sessions are its CLI's (`agent`, installed and signed in on its own), since no hook wakes an idle chat there.
// On Windows it can be a .cmd or .ps1 launcher, and those go through a shell, which must never see a message's text:
// no agent.exe, no workers, and Cursor keeps showing news through its hooks.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configDir, freshConfig, hubFetch } from './common.mjs';

const RUN_TIMEOUT_MS = 60 * 60_000;
const UNREAD_RETRIES = 2;
// A session rereads all of itself on every call, so it compacts to a summary rather than growing without limit.
// ponytail: about 80k tokens; Claude Code fires 33k under this window (its 20k output and 13k summary reserves), so recheck if those move
const AUTO_COMPACT_WINDOW = '113000';

/** The client's worker settings, or undefined when it answers everything in its one session (the default). */
export function workerSettings(config) {
  const w = config?.workers;
  if (!w || typeof w.permissionMode !== 'string' || !w.permissionMode) return undefined;
  return { max: Math.max(1, Math.min(8, Number(w.max) || 2)), permissionMode: w.permissionMode };
}

/** Cursor's CLI, run directly and never through a shell, or undefined when it can't be. */
export function cursorAgent(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const exe = join(env.LOCALAPPDATA ?? '', 'cursor-agent', 'agent.exe');
    return existsSync(exe) ? exe : undefined;
  }
  // Where its installer puts it, which a GUI app's PATH often leaves out.
  const local = join(homedir(), '.local', 'bin', 'agent');
  return existsSync(local) ? local : 'agent';
}

/** Why Cursor's CLI can't run sessions, in words for the person, or undefined when it can (or we can't tell). */
export function cursorProblem(bin = cursorAgent(), exec = spawnSync) {
  if (!bin) return "Background sessions on Windows need Cursor's agent.exe, and this install has only script launchers, which aren't safe to run with message text";
  const r = exec(bin, ['status'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (r.error?.code === 'ENOENT') return "Cursor's CLI isn't installed: run `curl https://cursor.com/install -fsS | bash`, then `agent login`";
  if (r.error) return undefined;
  const out = String(r.stdout ?? '') + String(r.stderr ?? '');
  return /logged in/i.test(out) && !/not logged in/i.test(out) ? undefined : "Cursor's CLI isn't signed in: run `agent login`";
}

/** The settings when this client has a session per conversation, else undefined. */
export function workersFor(client, config) {
  if (client === 'cursor' ? !cursorAgent() : client !== 'claude-code' && client !== 'codex') return undefined;
  return workerSettings(config);
}

const dir = (client) => join(configDir(), `${client}.workers`);
const id = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);
const file = (client, key, ext) => join(dir(client), `${id(key)}.${ext}`);

/** Left by hub-mcp when this conversation's inbox was read. Cleared before each run. */
export function markRead(client, key) {
  mkdirSync(dir(client), { recursive: true, mode: 0o700 });
  writeFileSync(file(client, key, 'read'), '', { mode: 0o600 });
}

/**
 * The session a message goes to: its conversation. A channel's new posts share one (the channel has one read
 * position, so a session per post would mark the others read), and each thread has its own.
 */
export function conversationOf(event) {
  return String(event.conversation ?? '');
}

/**
 * The router's queue, in memory: each conversation's new messages wait while its session runs, and go in its next run.
 * At most `settings.max` sessions run at once. `onDone(ids)` once a run is through with its messages.
 */
export function createRouter(client, { exec = spawnAsync, retryWaitMs = 3_000, onDone = () => {} } = {}) {
  const waiting = new Map(); // key -> message ids
  const running = new Map(); // key -> its run
  const mentions = new Map(); // message id -> who it @mentions
  let max = 1;
  const pump = () => {
    for (const [key, ids] of waiting) {
      if (running.size >= max) return;
      if (running.has(key)) continue;
      waiting.delete(key);
      running.set(key, run(key, ids).catch(() => {}).finally(() => (running.delete(key), pump())));
    }
  };
  const later = (key, ids) => new Promise((r) => setTimeout(r, retryWaitMs)).then(() => waiting.set(key, [...ids, ...(waiting.get(key) ?? [])]));
  const run = async (key, ids, unread = 0) => {
    const config = await freshConfig(client);
    const settings = config && workersFor(client, config);
    if (!settings) return;
    const meta = JSON.parse(readFileSync(file(client, key, 'json'), 'utf8'));
    rmSync(file(client, key, 'read'), { force: true });
    const outcome = await runSession(client, meta, settings, config.name || 'your agent', file(client, key, 'log'), exec);
    writeFileSync(file(client, key, 'json'), JSON.stringify(meta) + '\n', { mode: 0o600 });
    // ponytail: busy (an older Codex run still holds the thread) retries every retryWaitMs with no ceiling; back off if that ever spins
    if (outcome.busy) return later(key, ids);
    const read = existsSync(file(client, key, 'read'));
    if (outcome.ok && !read && unread < UNREAD_RETRIES) {
      await new Promise((r) => setTimeout(r, retryWaitMs));
      return run(key, ids, unread + 1); // nothing read them: same messages again
    }
    if (!outcome.ok) await sayItFailed(config, ids, outcome.problem);
    // A session that ran fine but skipped its inbox (a resumed Cursor answering from memory) only says so where it was
    // asked something: a DM or an @mention. Elsewhere it's chatter it would likely have left alone anyway.
    else if (!read) await sayItFailed(config, ids.filter((id) => !channelOf(key) || mentions.get(id)?.includes(config.agentId)), "the session couldn't reach its Parly tools");
    for (const id of ids) mentions.delete(id);
    onDone(ids);
  };
  return {
    add(events, settings, cwd) {
      mkdirSync(dir(client), { recursive: true, mode: 0o700 });
      max = settings.max;
      for (const e of events) {
        const key = conversationOf(e);
        if (!key) continue;
        // What it's about, for the agent's other sessions (otherSessions).
        writeFileSync(file(client, key, 'last'), JSON.stringify({ key, from: e.from, text: String(e.text ?? '').replace(/\s+/g, ' ').slice(0, 140), at: e.at }) + '\n', { mode: 0o600 });
        if (!existsSync(file(client, key, 'json'))) writeFileSync(file(client, key, 'json'), JSON.stringify({ key, cwd }) + '\n', { mode: 0o600 });
        waiting.set(key, [...(waiting.get(key) ?? []), e.id]);
        if (e.mentions) mentions.set(e.id, e.mentions);
      }
      pump();
    },
    idle: () => waiting.size === 0 && running.size === 0,
    async drained() {
      while (running.size) await Promise.all(running.values());
    },
  };
}

/** spawnSync's result, without blocking the router while a session runs. */
export function spawnAsync(bin, args, opts) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    // spawn enforces opts.timeout itself; maxBuffer it ignores, so cap output here like spawnSync does (kill on overflow)
    const child = spawn(bin, args, opts);
    const cap = opts.maxBuffer ?? Infinity;
    const add = (s, d) => { s += d; if (s.length > cap) child.kill(opts.killSignal); return s.slice(0, cap); };
    child.stdout?.on('data', (d) => (stdout = add(stdout, d)));
    child.stderr?.on('data', (d) => (stderr = add(stderr, d)));
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** The channel a channel or thread conversation is in; undefined for anything private. */
const channelOf = (key) => /^(?:channel|thread):([^:]+)/.exec(key)?.[1];

/**
 * What the agent's other sessions are on (the last message in each conversation of the past day), newest first.
 * What it says here it may repeat there, so a shared conversation only hears of its own channel: a DM sees everything,
 * and nothing private reaches a channel.
 */
export function otherSessions(client, key, now = Date.now()) {
  const channel = channelOf(key);
  let names = [];
  try {
    names = readdirSync(dir(client)).filter((n) => n.endsWith('.last'));
  } catch {}
  return names
    .map((n) => { try { return JSON.parse(readFileSync(join(dir(client), n), 'utf8')); } catch { return undefined; } })
    .filter((l) => l && l.key !== key && now - Date.parse(l.at) < 24 * 60 * 60_000 && (!channel || channelOf(l.key) === channel))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 8);
}

/** One turn of the conversation's session; resumes the one it had. Updates `meta.session`. */
export async function runSession(client, meta, settings, name, logFile, exec = spawnAsync) {
  const others = otherSessions(client, meta.key);
  const prompt =
    `You are ${name} on Parly, in a session of your own for one conversation: ${meta.key}. ` +
    `Call check_inbox with conversation "${meta.key}" (only that conversation: the others have sessions of their own), ` +
    'read the thread if you need more, and answer with reply(messageId) where a message asks you something. ' +
    'Never call check_inbox without conversation, wait_for_message or wait_for_events. ' +
    'If the work means changing files in a git repository, make a new git worktree for it rather than editing the main checkout. ' +
    'Before using a skill or process Parly lists, load it with get_skill(id). ' +
    'Stop once you have answered.' +
    (others.length
      ? "\n\nYour other sessions (you, in other conversations) are on these; if this conversation touches one, read it (read_thread, or read the DM) before acting, and don't redo or contradict its work:\n" +
        others.map((o) => `- ${o.key}: ${o.from}: "${o.text}" (${o.at})`).join('\n')
      : '');
  const env = { ...process.env, PARLY_WORKER: meta.key };
  const log = (text) => appendFileSync(logFile, `--- ${new Date().toISOString()}\n${text}\n`, { mode: 0o600 });
  if (client === 'codex') {
    const perm = settings.permissionMode === 'bypassPermissions' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--full-auto'];
    const args = meta.session
      ? ['exec', 'resume', ...perm, '--json', '--skip-git-repo-check', meta.session, prompt]
      : ['exec', ...perm, '--json', '--skip-git-repo-check', '-C', meta.cwd || process.cwd(), prompt];
    const r = await exec('codex', args, { cwd: meta.cwd || process.cwd(), env, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    log(String(r.stdout ?? '') + String(r.stderr ?? ''));
    const lines = String(r.stdout ?? '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const thread = lines.find((l) => l.type === 'thread.started')?.thread_id;
    if (thread) meta.session = thread;
    // Its earlier run is still going (its runner died, the session didn't): busy, so its messages wait for later.
    if (/already has an active writer/.test(String(r.stdout ?? '') + String(r.stderr ?? ''))) return { ok: false, busy: true };
    const failed = lines.find((l) => l.type === 'turn.failed' || l.type === 'error');
    if (r.status !== 0 || failed || !lines.some((l) => l.type === 'turn.completed')) {
      return { ok: false, problem: failed?.error?.message || failed?.message || (r.error ? r.error.message : `codex exited with ${r.status}`) };
    }
    return { ok: true };
  }
  const resume = Boolean(meta.session);
  const cwd = meta.cwd || process.cwd();
  let bin = 'claude';
  let args;
  if (client === 'cursor') {
    bin = cursorAgent();
    // Its id comes back in the result; --trust and --approve-mcps because nobody is there to answer their prompts.
    args = ['-p', '--output-format', 'json', '--trust', '--approve-mcps', '--workspace', cwd, ...(settings.permissionMode === 'bypassPermissions' ? ['--force'] : []), ...(resume ? ['--resume', meta.session] : []), prompt];
  } else {
    if (!meta.session) meta.session = randomUUID();
    args = ['-p', '--output-format', 'json', '--permission-mode', settings.permissionMode, resume ? '--resume' : '--session-id', meta.session, prompt];
  }
  const r = await exec(bin, args, { cwd, env: client === 'cursor' ? env : { ...env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: AUTO_COMPACT_WINDOW }, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  log(String(r.stdout ?? '') + String(r.stderr ?? ''));
  let out;
  try {
    out = JSON.parse(String(r.stdout ?? '').trim().split('\n').at(-1));
  } catch {}
  if (out?.session_id) meta.session = out.session_id;
  if (r.status !== 0 || !out || out.is_error) {
    // A session that can't be resumed (deleted, another machine) starts over next time.
    if (resume && /No conversation found|session|chat/i.test(String(r.stderr ?? '') + String(out?.result ?? ''))) delete meta.session;
    if (client === 'cursor' && /log ?in|authenticat/i.test(String(r.stderr ?? '') + String(r.stdout ?? ''))) return { ok: false, problem: "Cursor's agent CLI isn't signed in on this machine: run `agent login`" };
    return { ok: false, problem: out?.result || (r.error ? r.error.message : `${client === 'cursor' ? 'agent' : 'claude'} exited with ${r.status}`) };
  }
  return { ok: true };
}

/** A run that died still answers each message it had, so nobody waits on silence. */
async function sayItFailed(config, ids, problem) {
  const why = String(problem ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  for (const messageId of ids) {
    await hubFetch(config, `/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      body: { text: `Sorry, I couldn't finish this one${why ? ` (${why})` : ''}. Please try again.` },
      timeoutMs: 15_000,
    }).catch(() => {});
  }
}
