// One connection cycle on the local stack, without the browser form: create an
// agent, message it, redeem its link, complete the connection with the same
// POST /setup/provider-link call the form makes (it carries requestId, so the
// API grants the connection and wakes the agent), then check the account and
// funding tool results in the database. Exits 1 on any failed check; no tokens.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const API = process.env['API_BASE_URL'] ?? 'http://localhost:3000';
const PROVIDER = process.env['CYCLE_PROVIDER'] ?? 'openrouter';
const LIGHT_MODEL = process.env['CYCLE_LIGHT_MODEL'] ?? 'anthropic/claude-haiku-5.5';
const HEAVY_MODEL = process.env['CYCLE_HEAVY_MODEL'] ?? 'anthropic/claude-haiku-5.5';
const CONNECTION_PROVIDER = process.env['CYCLE_CONNECTION_PROVIDER'] ?? 'hyperliquid';
const MESSAGE =
  'Help me trade crypto. I am a novice, so set it up for me. Only provide a wallet for me to fund later when we decide to go live';
const FOLLOW_UP =
  'Your connection is done. Now call get_account_summary and get_funding_info, then tell me the mode, the capital and the funding address. If a tool fails, tell me the exact error.';
const POLL_MS = 5_000;
const LINK_TIMEOUT_MS = 180_000;
const REPLY_TIMEOUT_MS = 300_000;

const REQUIRED_TOOLS = ['get_account_summary', 'get_funding_info'];
const PG_CONTAINER = process.env['CYCLE_PG_CONTAINER'] ?? 'herobids-postgres-1';

/** Latest tool result summary per required tool, read from the agent's runtime log. */
function toolResults(agentId: string): Record<string, string> {
  if (!/^[0-9a-f-]{36}$/.test(agentId)) throw new Error(`unexpected agent id: ${agentId}`);
  const sql = `select payload->>'toolName', payload->>'summary' from agent_messages where agent_id='${agentId}' and type='agent.tool.result' and payload->>'toolName' in ('get_account_summary','get_funding_info') order by created_at;`;
  const out = execFileSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'herobids', '-d', 'herobids', '-At', '-F', '|', '-c', sql], { encoding: 'utf8' });
  const found: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const [tool, ...rest] = line.split('|');
    if (tool) found[tool] = rest.join('|');
  }
  return found;
}

interface ApiResult {
  status: number;
  body: unknown;
  headers: Headers;
}

interface OutboundMessage {
  createdAt: string;
  body: string;
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; redirect?: RequestRedirect } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.redirect ? { redirect: options.redirect } : {}),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON responses are returned as text.
  }
  return { status: response.status, body, headers: response.headers };
}

function fail(step: string, detail: unknown): never {
  throw new Error(`${step} failed: ${JSON.stringify(detail).slice(0, 400)}`);
}

async function listMessages(agentId: string, token: string): Promise<OutboundMessage[]> {
  const res = await call('GET', `/agents/${agentId}/messages?limit=50`, { token });
  if (res.status !== 200 || !Array.isArray(res.body)) fail('list messages', res);
  return res.body as OutboundMessage[];
}

async function pollUntil<T>(timeoutMs: number, check: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return undefined;
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const email = `cycle-${stamp}@test.local`;

  const registered = await call('POST', '/auth/register', {
    body: { email, password: randomUUID(), displayName: `Cycle ${stamp}` },
  });
  if (registered.status !== 201 && registered.status !== 200) fail('register', registered);
  const token = (registered.body as { token: string }).token;

  const settings = await call('PATCH', '/settings/ai-model', {
    token,
    body: { provider: PROVIDER, lightModel: LIGHT_MODEL, heavyModel: HEAVY_MODEL },
  });
  if (settings.status !== 200) fail('set ai model', settings);

  const created = await call('POST', '/agents', { token, body: { name: `cycle-${stamp}` } });
  if (created.status !== 201) fail('create agent', created);
  const agentId = (created.body as { id: string }).id;

  // Already-running agents answer non-2xx here; the message below is the real check.
  await call('POST', `/agents/${agentId}/start`, { token });

  const sent = await call('POST', `/agents/${agentId}/message`, { token, body: { message: MESSAGE } });
  if (sent.status !== 202) fail('send message', sent);
  const sentAt = Date.now();

  const linkPattern = /\/auth\/connection-request\/callback\?token=([A-Za-z0-9_-]+)/;
  const linkToken = await pollUntil(LINK_TIMEOUT_MS, async () => {
    for (const message of await listMessages(agentId, token)) {
      const match = linkPattern.exec(message.body);
      if (match?.[1]) return match[1];
    }
    return undefined;
  });
  if (!linkToken) fail('wait for connection link', { agentId, waitedMs: Date.now() - sentAt });

  const redeemed = await call('GET', `/auth/connection-request/callback?token=${linkToken}`, { redirect: 'manual' });
  const location = redeemed.headers.get('location');
  if (redeemed.status !== 302 || !location) fail('redeem link', redeemed);
  const redirect = new URL(location);
  const code = redirect.searchParams.get('code');
  const requestId = redirect.searchParams.get('requestId');
  const provider = redirect.searchParams.get('provider') ?? CONNECTION_PROVIDER;
  if (!code || !requestId) fail('read redirect', { provider, requestId });

  const exchanged = await call('POST', '/auth/exchange', { body: { code } });
  if (exchanged.status !== 200) fail('exchange code', exchanged);
  const sessionToken = (exchanged.body as { token: string }).token;

  const completed = await call('POST', '/setup/provider-link', {
    token: sessionToken,
    body: {
      provider,
      label: `cycle-${stamp}`,
      credentialMode: 'generated',
      capability: 'trading',
      requestId,
    },
  });
  if (completed.status !== 201) fail('complete connection', completed);
  const result = completed.body as {
    connectionRequest?: { status: string; errorCode?: string };
    wallet?: { address: string; network: string };
  };
  if (result.connectionRequest?.status !== 'completed') fail('connection request', result.connectionRequest);
  if (!result.wallet) fail('wallet', result);

  const followUpAt = new Date().toISOString();
  const followUp = await call('POST', `/agents/${agentId}/message`, { token, body: { message: FOLLOW_UP } });
  if (followUp.status !== 202) fail('send follow-up', followUp);

  const results = await pollUntil(REPLY_TIMEOUT_MS, async () => {
    const found = toolResults(agentId);
    return REQUIRED_TOOLS.every((tool) => found[tool] !== undefined) ? found : undefined;
  });
  if (!results) fail('account and funding tool calls', toolResults(agentId));
  for (const tool of REQUIRED_TOOLS) {
    if (!results[tool]?.startsWith('{"ok":true')) fail(`${tool} did not succeed`, results[tool]);
  }

  const firstReply = await pollUntil(REPLY_TIMEOUT_MS, async () => {
    const fresh = (await listMessages(agentId, token)).filter((m) => Date.parse(m.createdAt) > Date.parse(followUpAt));
    return fresh.length > 0 ? fresh : undefined;
  });
  if (!firstReply) fail('agent reply to follow-up', { agentId });
  const replies = firstReply.map((m) => ({
    at: m.createdAt,
    body: m.body.replace(/token=[A-Za-z0-9_-]+/g, 'token=***').slice(0, 500),
  }));

  console.log(JSON.stringify({
    verdict: 'PASS',
    email,
    agentId,
    provider,
    requestId,
    connectionRequest: result.connectionRequest,
    wallet: result.wallet?.address ?? null,
    replyCount: replies.length,
    replies,
  }, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
