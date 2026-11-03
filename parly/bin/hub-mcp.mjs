#!/usr/bin/env node
// A stdio MCP server that stands in for the hub: the client (Claude Code, Codex) talks JSON-RPC
// over stdin/stdout, and every message is forwarded to the hub's stateless Streamable HTTP
// endpoint (POST <hubUrl>/mcp) with the connected agent's token. Exists so the token lives in
// one file written by hub-connect.mjs, instead of an environment variable the person would have
// to set; the same file serves the hooks. Plain Node, no dependencies.
//
//   node hub-mcp.mjs --client claude-code
//
// Not connected yet: `initialize` still answers (with instructions that say how to connect) and
// `tools/list` answers with one local tool, `connect`, since the hub only talks to identified callers;
// the client starts cleanly, and an agent that only acts through tools (VS Code's Copilot) can connect.
// Once connected, the client is told the tool list changed and gets the hub's tools. The config is re-read on every call, so connecting takes effect
// without a restart.
//
// Connected, the first start asks the hub and keeps `initialize`'s instructions and the tool list in
// `<client>.mcp-cache.json`; later starts answer both from there and refresh in the background. A client can start its
// turn without waiting for its MCP servers (Codex does), so a hub that's slow for a moment would otherwise cost the
// whole session its tools.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { configMtime, connectHow, freshConfig, mcpCachePath, parseArgs, readConfig, writePrivate } from './common.mjs';
import { markRead } from './workers.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const client = typeof flags.client === 'string' ? flags.client : 'claude-code';
const PROTOCOL = '2025-06-18';
const NOT_CONNECTED = `Not connected to Parly yet. Ask the user for their hub's address (the hub web app's "Connect your agent" page shows it), then use ${connectHow(client)}.`;

let config = readConfig(client);
let mtime = configMtime(client);

function current() {
  const m = configMtime(client);
  if (m !== mtime) {
    mtime = m;
    config = readConfig(client);
  }
  return config;
}

function hubUrl() {
  return current()?.hubUrl || process.env.A2A_HUB_URL || '';
}

/** Connected: a hub to talk to and a token to talk as. */
function connected() {
  return Boolean(hubUrl() && current()?.token);
}

const CONNECT_TOOL = {
  name: 'connect',
  description:
    "Connects this agent to Parly. Call it with the hub's address (like hub.parly.dev) or a code from the hub's Connect page (like K7QF-2M9X@hub.parly.dev). " +
    'With an address it opens the browser to approve the sign-in: show the user the link and code it returns, then call it again with finish: true, ' +
    'which waits for the approval (call it again while it says it is still waiting). The hub\'s tools appear once connected.',
  inputSchema: {
    type: 'object',
    properties: {
      address: { type: 'string', description: "The hub's address, or a code from its Connect page." },
      finish: { type: 'boolean', description: 'Wait for the browser sign-in started earlier to be approved.' },
    },
  },
};

/** Runs hub-connect.mjs for the connect tool; its output is the tool's answer. */
function connect(args) {
  const argv = args?.finish ? ['--finish', '--wait', '50'] : [String(args?.address ?? '')];
  return new Promise((resolve) => {
    execFile(process.execPath, [fileURLToPath(new URL('hub-connect.mjs', import.meta.url)), '--client', client, ...argv], { timeout: 90_000 }, (err, stdout, stderr) => {
      const text = (stdout + stderr).trim() || (err ? err.message : 'Done.');
      const waiting = err?.code === 3;
      resolve({ isError: Boolean(err) && !waiting, content: [{ type: 'text', text: waiting ? 'Still waiting for the sign-in to be approved in the browser. Call connect with finish: true again.' : text }] });
    });
  });
}

/** What's kept for this hub and agent: `{instructions, tools}` as far as known, or undefined. */
function kept() {
  try {
    const c = JSON.parse(readFileSync(mcpCachePath(client), 'utf8'));
    return c.hubUrl === hubUrl() && c.agentId === current()?.agentId ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Enough to start from: the tools are known. */
function cached() {
  const c = kept();
  return Array.isArray(c?.tools) ? c : undefined;
}

function remember(part) {
  writePrivate(mcpCachePath(client), { ...kept(), hubUrl: hubUrl(), agentId: current()?.agentId, ...part });
}

let refreshing = false;

/** Started from the cache: brings it up to date, and tells the client only if the tools really changed. */
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const was = JSON.stringify(cached()?.tools);
    const init = await forward({ jsonrpc: '2.0', id: 'refresh-init', method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'parly-hub-mcp', version: '0.1.0' } } });
    const list = await forward({ jsonrpc: '2.0', id: 'refresh-tools', method: 'tools/list' });
    const tools = list?.result?.tools;
    if (!Array.isArray(tools)) return;
    remember({ instructions: init?.result?.instructions, tools });
    if (JSON.stringify(tools) !== was) out({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  } catch {
    // The hub is unreachable: the cached tools stand, and each call reports what's wrong.
  }
}

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const error = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });

/** Forwards one JSON-RPC message to the hub; resolves to its response, or undefined for notifications. */
async function forward(msg) {
  const url = hubUrl();
  if (!url) throw new Error(NOT_CONNECTED);
  const c = await freshConfig(client);
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL,
      ...(c?.token ? { authorization: `Bearer ${c.token}` } : {}),
    },
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 202 || res.status === 204) return undefined;
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).error?.message || JSON.parse(text).error || text;
    } catch {}
    throw new Error(`Hub returned HTTP ${res.status}: ${String(detail).slice(0, 300)}`);
  }
  const type = res.headers.get('content-type') || '';
  if (type.includes('text/event-stream')) {
    // The hub answers plain JSON, but tolerate a one-shot SSE body: the last `data:` line is the response.
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    return data.length ? JSON.parse(data[data.length - 1]) : undefined;
  }
  return text ? JSON.parse(text) : undefined;
}

async function handle(msg) {
  const id = msg.id;
  const isRequest = id !== undefined && id !== null;
  try {
    if (msg.method === 'initialize') {
      // Ask the hub for its real instructions when we can; otherwise answer locally so the client starts.
      let instructions = connected() ? cached()?.instructions : NOT_CONNECTED;
      if (connected() && !cached()) {
        try {
          const r = await forward(msg);
          instructions = r?.result?.instructions;
          remember({ instructions });
        } catch (err) {
          instructions = `Parly at ${hubUrl()} could not be reached: ${err.message}`;
        }
      }
      out({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'parly', version: '0.1.0' },
          ...(instructions ? { instructions } : {}),
        },
      });
      return;
    }
    if (msg.method === 'ping') {
      if (isRequest) out({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (msg.method === 'tools/list' && !connected()) {
      out({ jsonrpc: '2.0', id, result: { tools: [CONNECT_TOOL] } });
      return;
    }
    if (msg.method === 'tools/call' && msg.params?.name === 'connect' && !connected()) {
      out({ jsonrpc: '2.0', id, result: await connect(msg.params.arguments) });
      if (connected()) out({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      return;
    }
    if (msg.method === 'tools/list' && !msg.params?.cursor && cached()) {
      out({ jsonrpc: '2.0', id, result: { tools: cached().tools } });
      void refresh();
      return;
    }
    const response = await forward(msg);
    if (msg.method === 'tools/list' && Array.isArray(response?.result?.tools)) remember({ tools: response.result.tools });
    // The router's proof that this conversation's session got as far as its inbox; see workers.mjs.
    if (msg.method === 'tools/call' && msg.params?.name === 'check_inbox' && msg.params.arguments?.conversation && !response?.result?.isError) {
      markRead(client, msg.params.arguments.conversation);
    }
    if (isRequest) {
      if (response) out({ ...response, id });
      else error(id, -32603, 'The hub returned no response');
    }
  } catch (err) {
    if (isRequest) {
      // A failed tool call is a tool error (the model sees it); anything else is a protocol error.
      if (msg.method === 'tools/call') out({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: err.message }] } });
      else error(id, -32603, err.message);
    }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    error(null, -32700, 'Parse error');
    return;
  }
  void handle(msg);
});
rl.on('close', () => process.exit(0));
