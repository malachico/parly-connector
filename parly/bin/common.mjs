// Shared by the hub scripts: where the connection lives on disk, and how to call the hub.
// Plain Node (20+), no dependencies: these run as hooks and as a stdio MCP server.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CODE_PREFIX = 'a2ac_';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** The tool's name on the hub's consent page, which names a new connection after it ("Malachi's Claude Code"). */
const TOOL_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', vscode: 'VS Code', cline: 'Cline', 'cline-cli': 'Cline', cursor: 'Cursor', antigravity: 'Antigravity' };

/** How the person (re)connects this tool: Claude Code has a command, Codex a skill, the others the MCP server's connect tool. */
export const connectHow = (client) =>
  client === 'codex'
    ? "the Parly plugin's connect skill with the hub's address"
    : ['vscode', 'cline', 'cline-cli', 'cursor', 'antigravity'].includes(client)
      ? "the Parly `connect` tool with the hub's address"
      : '/parly:connect <hub address>';

/** `A2A_HUB_CONFIG_DIR` (tests), else `$XDG_CONFIG_HOME/a2a-hub`, else `~/.config/a2a-hub`. */
export function configDir() {
  return process.env.A2A_HUB_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'a2a-hub');
}

export const configPath = (client) => join(configDir(), `${client}.json`);
export const statePath = (client) => join(configDir(), `${client}.state.json`);
export const mcpCachePath = (client) => join(configDir(), `${client}.mcp-cache.json`);
const signInPath = (client) => join(configDir(), `${client}.signin.json`);

/** `--client <name>`, `--event <name>` and friends from argv; bare words are positional. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

/** The connection `{hubUrl, token, agentId, name}` for a client, or undefined when not connected. */
export function readConfig(client) {
  const p = configPath(client);
  if (!existsSync(p)) return undefined;
  try {
    const c = JSON.parse(readFileSync(p, 'utf8'));
    return c && typeof c.hubUrl === 'string' && typeof c.token === 'string' ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Modification time of the config file, to notice a (re)connect without restarting. */
export function configMtime(client) {
  try {
    return statSync(configPath(client)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Words for a config that exists but can't be used (a hand edit gone wrong), which otherwise looks like never having signed in. */
export function configProblem(client) {
  if (!existsSync(configPath(client)) || readConfig(client)) return undefined;
  return `${configPath(client)} isn't a usable sign-in, so Parly is off here. Connecting again replaces it.`;
}

export function writeConfig(client, config) {
  writePrivate(configPath(client), config);
}

/** Written aside and renamed in: sessions start in parallel, and one must never read a half-written file. */
export function writePrivate(path, value) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function readState(client) {
  try {
    return JSON.parse(readFileSync(statePath(client), 'utf8')) || {};
  } catch {
    return {};
  }
}

export function writeState(client, state) {
  writePrivate(statePath(client), state);
}

/** Decodes a connection code from the hub's Connect page. Throws a plain Error on bad input. */
export function decodeCode(raw) {
  const code = String(raw ?? '').trim();
  if (!code.startsWith(CODE_PREFIX)) throw new Error(`That is not a connection code (it should start with ${CODE_PREFIX}).`);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(code.slice(CODE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('That connection code is damaged. Copy it again from the Connect page.');
  }
  const { hubUrl, token, agentId, name } = parsed ?? {};
  if (typeof hubUrl !== 'string' || !/^https?:\/\//.test(hubUrl) || typeof token !== 'string' || !token.startsWith('a2ah_')) {
    throw new Error('That connection code is incomplete. Copy it again from the Connect page.');
  }
  return { hubUrl: hubUrl.replace(/\/+$/, ''), token, agentId: String(agentId ?? ''), name: String(name ?? '') };
}

/**
 * A pairing code from the Connect page, `XXXX-XXXX@<hub host>`: one-time, short-lived, no token in it.
 * Returns `{hubUrl, code}`, or undefined when `raw` is not one.
 */
export function parsePairing(raw) {
  const m = /^([0-9A-Za-z]{4}-?[0-9A-Za-z]{4})@([\w.-]+(?::\d+)?)$/.exec(String(raw ?? '').trim());
  if (!m) return undefined;
  const local = /^(localhost|127\.\d+\.\d+\.\d+)(:|$)/.test(m[2]);
  return { code: m[1], hubUrl: `${local ? 'http' : 'https'}://${m[2]}` };
}

/** Spends a pairing code at its hub for this tool's own connection `{hubUrl, token, agentId, name}`. */
export async function redeemPairing({ hubUrl, code }) {
  const res = await fetch(`${hubUrl}/pairings/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `The hub at ${hubUrl} returned HTTP ${res.status}`);
  return { hubUrl, token: json.token, agentId: json.agent?.id ?? '', name: json.agent?.name ?? '' };
}

/** GET/POST JSON against the hub as the connected agent. Throws on HTTP errors with the hub's message. */
export async function hubFetch(config, path, { method = 'GET', body, timeoutMs = 4000 } = {}) {
  const res = await fetch(`${config.hubUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Hub returned HTTP ${res.status}`);
  return json;
}

/** A hub address typed to connect (`https://hub.example.com`, or just the host), or undefined when `raw` is not one. */
export function parseHubUrl(raw) {
  const s = String(raw ?? '').trim().replace(/\/+$/, '').replace(/\/mcp$/, '');
  if (/^https?:\/\/[\w.-]+(:\d+)?$/.test(s)) return s;
  if (/^([\w-]+(\.[\w-]+)+|localhost)(:\d+)?$/.test(s)) return `${/^(localhost|127\.)/.test(s) ? 'http' : 'https'}://${s}`;
  return undefined;
}

async function oauthPost(hubUrl, path, params) {
  const res = await fetch(`${hubUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const oauthMessage = (hubUrl, { status, body }) => body.error_description || body.error || `The hub at ${hubUrl} returned HTTP ${status}`;
const withTokens = (config, t) => ({ ...config, token: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 });

/**
 * Starts signing in to a hub with the OAuth device flow: registers this tool, keeps what polling
 * needs in <client>.signin.json, and returns the page where the person approves `{url, userCode}`.
 */
export async function startSignIn(client, hubUrl) {
  const reg = await fetch(`${hubUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The device flow never redirects, but registration requires a redirect URI.
    body: JSON.stringify({ client_name: TOOL_NAMES[client] ?? client, redirect_uris: ['http://127.0.0.1/'], grant_types: [DEVICE_GRANT, 'refresh_token'] }),
    signal: AbortSignal.timeout(10_000),
  });
  const registered = await reg.json().catch(() => ({}));
  if (!reg.ok) throw new Error(oauthMessage(hubUrl, { status: reg.status, body: registered }));
  const start = await oauthPost(hubUrl, '/device_authorization', { client_id: registered.client_id });
  if (start.status !== 200) throw new Error(oauthMessage(hubUrl, start));
  writePrivate(signInPath(client), {
    hubUrl,
    clientId: registered.client_id,
    deviceCode: start.body.device_code,
    interval: start.body.interval,
    expiresAt: Date.now() + start.body.expires_in * 1000,
  });
  return { url: start.body.verification_uri_complete, userCode: start.body.user_code };
}

/**
 * Waits for the person to approve the sign-in startSignIn began, up to `maxWaitMs`. Returns the
 * connection `{hubUrl, clientId, token, refreshToken, expiresAt}`, or undefined if still waiting.
 */
export async function finishSignIn(client, maxWaitMs) {
  let pending;
  try {
    pending = JSON.parse(readFileSync(signInPath(client), 'utf8'));
  } catch {
    throw new Error(`No sign-in is in progress. Start again with ${connectHow(client)}.`);
  }
  const deadline = Math.min(pending.expiresAt, Date.now() + maxWaitMs);
  let interval = pending.interval || 5;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await oauthPost(pending.hubUrl, '/token', { grant_type: DEVICE_GRANT, client_id: pending.clientId, device_code: pending.deviceCode });
    if (res.body.error === 'authorization_pending') continue;
    if (res.body.error === 'slow_down') {
      interval += 5;
      continue;
    }
    rmSync(signInPath(client), { force: true });
    if (res.status !== 200) throw new Error(res.body.error === 'access_denied' ? 'The sign-in was declined.' : oauthMessage(pending.hubUrl, res));
    return withTokens({ hubUrl: pending.hubUrl, clientId: pending.clientId }, res.body);
  }
  if (Date.now() >= pending.expiresAt) {
    rmSync(signInPath(client), { force: true });
    throw new Error(`The sign-in expired before it was approved. Start again with ${connectHow(client)}.`);
  }
  return undefined;
}

/**
 * The connection for `client` with a live token: a signed-in one whose access token is about to
 * expire is refreshed first. Refresh tokens rotate, so this always starts from the file on disk;
 * two processes refreshing at once both succeed (the hub allows a spent refresh token for a minute)
 * and the last write wins. A code connection's token never expires and is returned as is.
 */
export async function freshConfig(client) {
  const config = readConfig(client);
  if (!config?.refreshToken || config.expiresAt - Date.now() > 60_000) return config;
  const res = await oauthPost(config.hubUrl, '/token', { grant_type: 'refresh_token', client_id: config.clientId, refresh_token: config.refreshToken });
  if (res.status !== 200) {
    const now = readConfig(client);
    if (now?.refreshToken && now.refreshToken !== config.refreshToken) return now; // another process refreshed first
    const err = new Error(`The hub sign-in has ended (${oauthMessage(config.hubUrl, res)}). Sign in again with ${connectHow(client)}.`);
    err.signedOut = res.status === 400 || res.status === 401; // a revoked grant never comes back: retrying only trips the rate limit
    throw err;
  }
  const next = withTokens(config, res.body);
  writeConfig(client, next);
  return next;
}
