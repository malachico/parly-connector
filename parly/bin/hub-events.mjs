#!/usr/bin/env node
// A hook that runs when a session starts and before each prompt. It reads the hub's event feed
// since last time and prints what's new as context for the model, so the person never has to
// say "check your inbox". It never fails the prompt: any problem means no output and exit 0.
//
// Claude Code and Codex also keep the agent's status (its card on the canvas, its day): "Working on: <what the person
// typed>" (in its DM with them) or "Answering <who>: <what>" (where the message is); Claude Code's clears at the turn's end.
// `--event listen` is the background half (Claude Code's asyncRewake hook after every turn; not at
// session start, where Claude Code waits for every hook and a 60s startup timeout kills the session): it waits on the feed and, when something new arrives, prints it and exits 2,
// which wakes an idle session. One session owns the news and keeps it until it exits.
// Codex has no such hook, so its session-start hook starts the listener detached (`--event
// listen-codex`): news goes into the session with `codex queue`. Codex runs hooks in its shared
// app-server, so the listener can't see the window close; it ends when the next session's listener
// replaces it (or the app-server exits). ponytail: until then, news is queued to the closed session
// (still unanswered on the hub, so the next session start counts it).
//
//   node hub-events.mjs --client claude-code --event session-start|prompt|listen
//   node hub-events.mjs --client codex --event listen-codex     (stdin: Codex's hook input)
//   node hub-events.mjs --client vscode --event stop            (stdin: VS Code's hook input)
//   node hub-events.mjs --client cline --event session-start|prompt|done  (Cline's TaskStart/TaskResume, UserPromptSubmit,
//                                                                         TaskComplete/TaskCancel)
//   node hub-events.mjs --client cursor --event session-start|prompt|stop  (Cursor's sessionStart, postToolUse, stop)
//   node hub-events.mjs --client antigravity --event session-start|stop|listen-sidecar  (Antigravity's SessionStart,
//                                                                                       Stop, and the plugin's sidecar)
//
// Cursor with workers (workers.mjs): its workspaceOpen and session-start hooks also leave the router running detached, in the chat's
// workspace (hooks run in the plugin's folder), for as long as Cursor is open. Without `ps` to find Cursor (Windows) it
// is `--watch self`: one router, until the machine restarts.
//
// Antigravity runs a plugin's sidecar in the background (and restarts it): `listen-sidecar` waits on the feed and
// sends news into the conversation its hooks last saw (`agentapi send-message`), which wakes it.
//
// VS Code has no way to wake an idle chat, so its Stop hook checks the feed as the agent is about to
// stop and, when something is new, blocks the stop with it: the agent goes on and answers.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configDir, configProblem, connectHow, freshConfig, hubFetch, parseArgs, readConfig, readState, writeState } from './common.mjs';
import { createRouter, cursorProblem, workersFor } from './workers.mjs';

const MAX_ITEMS = 10;
const MAX_TEXT = 200;
/** Clients whose hooks keep the agent's status (its card on the canvas, its day): what woke it, or what it was asked. */
const AUTO_STATUS = new Set(['claude-code', 'codex']);
/** This run set the status from a typed prompt: news shown in the same run doesn't replace it. */
let prompted = false;
/** Cursor's session-start input: where the chat is, for the router. */
let hookInput = {};

const { flags } = parseArgs(process.argv.slice(2));

// A conversation's own session (workers.mjs): its hooks stay out of the way, since the router hands it its mail.
if (process.env.PARLY_WORKER) process.exit(0);

if (flags.event === 'listen') {
  await listen(typeof flags.client === 'string' ? flags.client : 'claude-code', flags.thread, flags.watch === 'self' ? process.pid : Number(flags.watch) || undefined);
} else if (flags.event === 'listen-sidecar') {
  await listen('antigravity', undefined, undefined, (text) => {
    // ponytail: no conversation seen yet means nowhere to wake; the news shows at the next SessionStart instead
    const conversation = readState('antigravity').conversation;
    if (conversation) spawnSync('agentapi', ['send-message', conversation, text], { stdio: 'ignore', timeout: 30_000 });
  });
} else if (flags.event === 'workspace-open') {
  // Cursor's workspaceOpen comes before any chat: it only starts the router, when there is one. News waits for a chat,
  // since showing it here would use it up (the feed's cursor, `shown`) where no model reads it.
  try {
    const config = await freshConfig('cursor');
    if (config && workersFor('cursor', config) && !cursorProblem()) startCursorRouter(await readInput());
  } catch {}
  process.exit(0);
} else if (flags.event === 'listen-codex') {
  startCodexListener();
} else if (flags.event === 'stop') {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    if (flags.client === 'antigravity') {
      // Not after a turn the person cancelled or that failed. The sidecar wakes it for what arrives later.
      seenConversation(input);
      const text = /CANCEL|ERROR/.test(String(input.terminationReason ?? '')) || input.error ? '' : await collect('antigravity', 'Stop');
      process.stdout.write(JSON.stringify(text ? { decision: 'continue', reason: text } : {}) + '\n');
      process.exit(0);
    }
    if (flags.client === 'cursor') {
      // Cursor sends followup_message as the next user message. Not after the person stopped the agent; its
      // hooks.json loop_limit caps a chain of them.
      const text = input.status === 'completed' ? await collect('cursor', 'Stop') : '';
      process.stdout.write(JSON.stringify(text ? { followup_message: text } : {}) + '\n');
      process.exit(0);
    }
    // ponytail: one extra turn per stop, never a chain of them (each costs the person AI credits); what
    // arrives meanwhile waits for the next stop.
    const text = input.stop_hook_active ? '' : await collect(typeof flags.client === 'string' ? flags.client : 'vscode', 'Stop');
    // VS Code's own chat reads hookSpecificOutput; its Copilot CLI sessions (the Agent Host) read the top level.
    if (text) process.stdout.write(JSON.stringify({ decision: 'block', reason: text, hookSpecificOutput: { hookEventName: 'Stop', decision: 'block', reason: text } }) + '\n');
  } catch {}
  process.exit(0);
} else if (flags.event === 'done') {
  // Cline's TaskComplete/TaskCancel: its task is free again, so the Parly extension may start one for new mail.
  try {
    writeState('cline', { ...readState('cline'), busy: false });
  } catch {}
  process.stdout.write(JSON.stringify({ cancel: false }) + '\n');
  process.exit(0);
} else {
  const client = typeof flags.client === 'string' ? flags.client : 'claude-code';
  const event = flags.event === 'session-start' ? 'SessionStart' : 'UserPromptSubmit';
  let text = '';
  try {
    // Cline's task is at work until its done hook: the extension leaves it alone meanwhile.
    if (client === 'cline') writeState(client, { ...readState(client), busy: true });
    if (client === 'antigravity') {
      try {
        seenConversation(JSON.parse(readFileSync(0, 'utf8') || '{}'));
      } catch {}
    }
    // What the person typed is what the agent is on now (said in its DM with them, so only they see it).
    if (event === 'UserPromptSubmit' && AUTO_STATUS.has(client)) await statusFromPrompt(client, await readInput()).catch(() => {});
    if (client === 'cursor' && event === 'SessionStart') hookInput = await readInput();
    text = await collect(client, event);
  } catch {
    // Silence is the right failure mode for a hook: the prompt goes on without hub news.
  }
  // Cline reads {cancel, contextModification} and wants an answer every time.
  if (client === 'cline') process.stdout.write(JSON.stringify({ cancel: false, ...(text ? { contextModification: text } : {}) }) + '\n');
  // Cursor's sessionStart and postToolUse read additional_context.
  else if (client === 'cursor') process.stdout.write(JSON.stringify(text ? { additional_context: text } : {}) + '\n');
  // Antigravity's SessionStart adds steps to the conversation.
  else if (client === 'antigravity') process.stdout.write(JSON.stringify(text ? { injectSteps: [{ ephemeralMessage: text }] } : {}) + '\n');
  else if (text) emit(event, text, client === 'vscode');
  process.exit(0);
}

/** Claude Code with workers: the router runs from the session's start, not only after its first turn. */
function startRouter() {
  try {
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--client', 'claude-code', '--event', 'listen', '--watch', String(process.ppid)], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch {}
}

/** Cursor with workers: the router, for as long as this Cursor runs, working in the chat's workspace. */
function startCursorRouter(input) {
  try {
    const root = input.workspace_roots?.[0];
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--client', 'cursor', '--event', 'listen', '--watch', String(ancestor(/cursor/i) ?? 'self')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: typeof root === 'string' && existsSync(root) ? root : homedir(),
    }).unref();
  } catch {}
}

/** Antigravity: remembers the conversation a hook ran in, where the sidecar sends news. */
function seenConversation(input) {
  if (input.conversationId) writeState('antigravity', { ...readState('antigravity'), conversation: input.conversationId });
}

/** The context to add for this event, or '' when there is nothing to say. */
async function collect(client, event) {
  const config = await freshConfig(client);
  if (!config) {
    if (event === 'Stop') return '';
    if (event !== 'SessionStart') return '';
    const problem = configProblem(client);
    if (problem) return `Parly: ${problem} Tell the person, then ask for their hub's address and use ${connectHow(client)}.`;
    return `The Parly plugin is installed but not connected yet. Ask the user for their hub's address (the hub web app's "Connect your agent" page shows it), then use ${connectHow(client)}.`;
  }
  if (ownedElsewhere(client)) return ''; // the owning session shows it; moving the cursor here would hide it there
  if (workersFor(client, config)) {
    // Each conversation has a session of its own: this one (the person's) only routes the mail, in the background.
    if (event !== 'SessionStart') return '';
    if (client === 'claude-code') startRouter();
    if (client === 'cursor') {
      // A CLI that can't run would answer every message with a failure: leave them for a chat until it can.
      const problem = cursorProblem();
      if (problem) return `Parly: nothing can answer in the background yet. ${problem}. Tell the person.`;
      startCursorRouter(hookInput);
    }
    return 'Parly: messages to you are answered by separate sessions, one per conversation, started in the background. Leave the Parly inbox to them: call check_inbox only if the person asks you to.';
  }
  const state = readState(client);
  const lines = [];

  if (!state.cursor) {
    // First run: say how much is already waiting, then start the feed from now.
    const me = await hubFetch(config, '/me');
    const pending = Number(me.pending) || 0;
    if (pending > 0) lines.push(waitingNote(pending));
    const { cursor } = await hubFetch(config, '/events?wait=0');
    writeState(client, { ...state, cursor });
    return lines.join('\n');
  }

  const { events, cursor } = await hubFetch(config, `/events?${new URLSearchParams({ cursor: state.cursor, wait: '0' })}`);
  if (cursor && cursor !== state.cursor) writeState(client, { ...readState(client), cursor });
  const news = await show(client, config, events, 'Do not loop on wait_for_events; new items appear here at your next prompt.');
  if (event !== 'SessionStart' || news) return news;
  // A new session: anything still unanswered, e.g. shown to a session that has since closed.
  const pending = Number((await hubFetch(config, '/me')).pending) || 0;
  return pending > 0 ? waitingNote(pending) : '';
}

/**
 * Waits on the feed until something is for this agent, then prints it and exits 2 (wakes the
 * model). Hub errors just mean waiting and trying again; only news ends the wait.
 */
async function listen(client, thread, watchPid, onNews) {
  if (!readConfig(client)) process.exit(0);
  // Claude Code starts this after every turn: the turn is over, so is what it was on (Codex's starts once, at session start).
  if (client === 'claude-code') await clearStatus(client).catch(() => {});
  // One session owns the hub news: the first to listen keeps it while it is open, and its newer
  // listener (next turn's) replaces its older one. Another session takes over only once the owner
  // has exited. Claude Code runs hooks directly, so our parent is the session's own process.
  // ponytail: "open" means the owner's pid is alive; add an idle timeout if a forgotten open session
  // should hand over.
  const owner = watchPid ?? process.ppid;
  const held = readLock(client);
  // ponytail: a router (workers) holds its sessions and their queue in memory, so a turn's new listener leaves a live one be
  const routing = workersFor(client, readConfig(client));
  if (held && ((held.owner !== owner && alive(held.owner)) || (routing && held.listener !== process.pid && alive(held.listener)))) process.exit(0);
  writeLock(client, { owner, listener: process.pid });
  const superseded = () => !alive(owner) || readLock(client)?.listener !== process.pid;
  // Done messages join `shown`, so a replay after a restart skips them.
  const router = createRouter(client, { onDone: (ids) => { const s = readState(client); writeState(client, { ...s, shown: [...(s.shown ?? []), ...ids].slice(-200) }); } });
  const quit = async () => (await router.drained(), process.exit(0));
  let next; // workers: where the feed is read from; the saved cursor lags it until the queue is empty
  for (;;) {
    if (superseded()) await quit();
    try {
      const config = await freshConfig(client); // the loop outlives an hour-long access token
      const workers = workersFor(client, config);
      const from = workers ? (next ??= readState(client).cursor) : readState(client).cursor;
      const q = new URLSearchParams(from ? { cursor: from, wait: '25' } : { wait: '0' }); // no cursor yet: take one, from now
      const { events, cursor } = await hubFetch(config, `/events?${q}`, { timeoutMs: 40_000 });
      if (superseded()) await quit();
      const state = readState(client);
      // The prompt hook moved the cursor meanwhile: it already showed these, so wait again from there.
      if (!workers && state.cursor !== from) continue;
      if (workers && from) {
        // Each conversation's session answers.
        const shown = new Set(state.shown ?? []);
        const mail = (events ?? []).filter((m) => m?.forYou && m.fromId !== config.agentId && !shown.has(m.id));
        if (mail.length) router.add(mail, workers, process.cwd());
        next = cursor ?? next;
        // ponytail: a router that dies replays all it hadn't finished, and `shown` (the last 200) skips what it had;
        // a router never idle replays more, so keep done ids per conversation if that ever outgrows 200
        if (router.idle()) writeState(client, { ...readState(client), cursor: next });
        continue;
      }
      if (cursor) writeState(client, { ...state, cursor });
      const text = from ? await show(client, config, events, 'You will be woken again for the next ones.') : '';
      if (text && thread) {
        // Codex: typed into the open session as the next message; it runs once Codex is idle.
        spawnSync('codex', ['queue', '--thread', thread, '--message', text], { stdio: 'ignore', timeout: 30_000 });
      } else if (text && onNews) {
        onNews(text);
      } else if (text) {
        // The lock stays: this session still owns the news, and its next turn's listener picks up from here.
        process.stderr.write(text + '\n');
        process.exit(2);
      }
    } catch (err) {
      if (err?.signedOut) process.exit(0);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

function lockPath(client) {
  return `${configDir()}/${client}.listen.json`;
}

/** `{owner, listener}`: the session that gets hub news and its current listener, or undefined. */
function readLock(client) {
  try {
    return JSON.parse(readFileSync(lockPath(client), 'utf8')) || undefined;
  } catch {
    return undefined;
  }
}

function writeLock(client, lock) {
  writeFileSync(lockPath(client), JSON.stringify(lock));
}

/** Whether another open session owns the news, so this one should leave it alone. Claude Code only. */
function ownedElsewhere(client) {
  const held = client === 'claude-code' && readLock(client);
  return Boolean(held && held.owner !== process.ppid && alive(held.owner));
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Codex's session-start hook: reads the session id from the hook input, finds the Codex process
 * above us, and leaves a detached listener behind for that session. Never fails the hook.
 */
function startCodexListener() {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const thread = String(input.session_id ?? '');
    const pid = ancestor(/codex/);
    if (!thread || !pid) process.exit(0);
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--client', 'codex', '--event', 'listen', '--thread', thread, '--watch', String(pid)], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch {}
  process.exit(0);
}

/** The nearest process above us whose command matches: hooks may run under a shell. Undefined without one, or without `ps`. */
function ancestor(pattern) {
  try {
    let pid = process.ppid;
    for (let i = 0; i < 8 && pid > 1; i++) {
      const [ppid, ...cmd] = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
      if (pattern.test(cmd.join(' ')) && !/hub-events/.test(cmd.join(' '))) return pid;
      pid = Number(ppid);
    }
  } catch {}
  return undefined;
}

/** What check_inbox would show: `n` conversations with something new. */
function waitingNote(n) {
  return `Parly: new messages in ${n} conversation${n === 1 ? '' : 's'} on the hub. Read them with check_inbox; it says when to reply.`;
}

/**
 * What `describe` finds, shown to the model, and remembered so the same message is never shown twice. Showing
 * marks nothing read: the agent reads and answers with check_inbox and reply.
 */
async function show(client, config, events, closing) {
  const { text, messages } = describe(config, events, closing, new Set(readState(client).shown ?? []));
  if (messages.length) {
    const state = readState(client);
    writeState(client, { ...state, shown: [...(state.shown ?? []), ...messages].slice(-200) });
    // Woken by a message: answering it is what it's on now, said where the message is (so whoever can read it sees it).
    const m = (events ?? []).find((e) => e.id === messages.at(-1));
    if (m && AUTO_STATUS.has(client) && !prompted) await setStatus(client, config, m.conversation, `Answering ${m.from}: ${oneLine(m.text, 70)}`).catch(() => {});
  }
  return text;
}

/** Posts the agent's status about `conversation` (the hub keeps it on its card and in its day), remembering where. */
async function setStatus(client, config, conversation, text) {
  if (!conversation || !text) return;
  await hubFetch(config, `/conversations/${encodeURIComponent(conversation)}/status`, { method: 'POST', body: { text } });
  writeState(client, { ...readState(client), status: conversation });
}

/** The turn is over: clears the status it set (only if it's still that one: the hub compares). */
async function clearStatus(client) {
  const { status } = readState(client);
  const config = await freshConfig(client);
  writeState(client, { ...readState(client), status: undefined });
  if (status && config) await hubFetch(config, `/conversations/${encodeURIComponent(status)}/status`, { method: 'POST', body: { done: true } });
}

/** A prompt the person typed: "Working on: …" in the agent's DM with its owner. Hub notices (our own wake-ups) aren't a task. */
async function statusFromPrompt(client, input) {
  const prompt = oneLine(input?.prompt, 100);
  if (!prompt || prompt.startsWith('Parly:')) return;
  const config = await freshConfig(client);
  if (!config) return;
  const me = await hubFetch(config, '/me?pending=0');
  if (!me.ownerId) return;
  await setStatus(client, config, `agent:${me.ownerId}`, `Working on: ${prompt}`);
  prompted = true;
}

/** The hook's JSON input on stdin, or {} (never waits long: a hook run without input must not hang). */
function readInput(ms = 500) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let data = '';
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(done, ms);
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', done);
  });
}

/** `text` on one line, at most `max` characters. */
function oneLine(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * New messages for this agent (the feed's `forYou` ones), as a few lines for the model ('' when none), with the
 * ids of the messages shown. `alreadyShown`: ids shown before.
 */
function describe(config, events, closing, alreadyShown = new Set()) {
  const items = [];
  const messages = [];
  for (const m of events ?? []) {
    if (!m?.forYou || m.fromId === config.agentId || alreadyShown.has(m.id) || messages.includes(m.id)) continue;
    messages.push(m.id);
    items.push(`- [messageId ${m.id}] from ${m.from}${m.channelId ? ' (in a channel)' : ''}: ${quote(m.text)}`);
  }
  if (items.length === 0) return { text: '', messages };
  const listed = items.slice(0, MAX_ITEMS);
  const lines = [`Parly: ${items.length} new ${items.length === 1 ? 'message' : 'messages'} for you (${config.name || 'your agent'}).`, ...listed];
  if (items.length > listed.length) lines.push(`- and ${items.length - listed.length} more (check_inbox)`);
  // Neutral on purpose: when to reply comes from the hub, with the messages (check_inbox), so it can change without a plugin update.
  lines.push(`Read them with check_inbox; it says when to reply. ${closing}`);
  return { text: lines.join('\n'), messages };
}

function quote(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '(no text)';
  return `"${t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t}"`;
}

/** Claude Code, Codex and VS Code's own chat read hookSpecificOutput.additionalContext from stdout; Copilot CLI (`topLevel`) reads it at the top. */
function emit(event, additionalContext, topLevel = false) {
  process.stdout.write(JSON.stringify({ ...(topLevel ? { additionalContext } : {}), hookSpecificOutput: { hookEventName: event, additionalContext } }) + '\n');
}
