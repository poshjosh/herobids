/**
 * agent-bot-cascade-test.ts — Integration smoke test that verifies the
 * agent-stop-cascades-to-bots feature.
 *
 * This script is NOT part of the routine test suite. Run it manually to
 * diagnose agent → bot cascade-stop behaviour against a live or local stack.
 *
 * What it does
 * ────────────
 *  Phase 1    Stack    — checks API health; optionally starts Docker.
 *  Phase 2    Setup    — registers/logs in, creates a provider-link,
 *                        creates an agent with bot-management skill, binds
 *                        the connection, and starts the agent.
 *  Phase 3    Observe  — polls for the agent-created bot to appear and
 *                        reach status='running'.
 *  Phase 3d   Stop     — POST /agents/:id/stop, then polls for all
 *                        agent-created bots to reach status='stopped'
 *                        within 30 s. Asserts agent status = 'stopped'.
 *  Phase 4    Teardown — deletes the agent (cascades to bots via agent
 *                        deletion cleanup), optionally stops Docker.
 *
 * Required env vars
 * ─────────────────
 *  API_BASE_URL          default http://localhost:3000
 *  TEST_EMAIL            default cascade-test@local.test
 *  TEST_PASSWORD         default CascadeTest123!
 *
 * Optional env vars
 * ─────────────────
 *  VENUE                 hyperliquid (default) | bybit | 1inch
 *  EXECUTION_MODE        paper (default) | live
 *  TICK_INTERVAL_MS      60000 (default, 1 minute)
 *  TIMEOUT_MS            600000 (default, 10 minutes)
 *  LLM_PROVIDER          ollama (default)
 *  LLM_LIGHT_MODEL       qwen3:8b (default)
 *  LLM_HEAVY_MODEL       qwen3.6:35b-a3b-q4_K_M (default)
 *  DOCKER_COMPOSE_UP     1 to auto-start Docker stack when unhealthy
 *  DOCKER_COMPOSE_DOWN   1 to stop Docker stack on exit (only if started here)
 *  SKIP_TEARDOWN         1 to leave agent running for manual inspection
 *  DATABASE_URL          postgres://herobids:herobids@localhost:5432/herobids (default)
 *
 * Hyperliquid testnet (VENUE=hyperliquid):
 *   HL_API_KEY, HL_SECRET, HL_WALLET_ADDRESS
 *
 * Bybit (VENUE=bybit):
 *   BYBIT_API_KEY, BYBIT_SECRET
 *
 * 1inch swap (VENUE=1inch):
 *   ONEINCH_API_KEY, ONEINCH_PRIVATE_KEY
 *
 * Usage
 * ─────
 *  HL_API_KEY=... HL_SECRET=... HL_WALLET_ADDRESS=0x... \
 *    tsx scripts/ts/agent-bot-cascade-test.ts
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE_URL = process.env['API_BASE_URL'] ?? 'http://localhost:3000';
const TEST_EMAIL = process.env['TEST_EMAIL'] ?? 'cascade-test@local.test';
const TEST_PASSWORD = process.env['TEST_PASSWORD'] ?? 'CascadeTest123!';
const VENUE = process.env['VENUE'] ?? 'hyperliquid';
const EXECUTION_MODE = process.env['EXECUTION_MODE'] ?? 'paper';
const TICK_INTERVAL_MS = parseInt(process.env['TICK_INTERVAL_MS'] ?? '60000', 10);
const TIMEOUT_MS = parseInt(process.env['TIMEOUT_MS'] ?? '600000', 10);
const LLM_PROVIDER = process.env['LLM_PROVIDER'] ?? 'ollama';
const LLM_LIGHT_MODEL = process.env['LLM_LIGHT_MODEL'] ?? 'qwen3:8b';
const LLM_HEAVY_MODEL = process.env['LLM_HEAVY_MODEL'] ?? 'qwen3.6:35b-a3b-q4_K_M';
const DOCKER_COMPOSE_UP = process.env['DOCKER_COMPOSE_UP'] === '1';
const DOCKER_COMPOSE_DOWN = process.env['DOCKER_COMPOSE_DOWN'] === '1';
const SKIP_TEARDOWN = process.env['SKIP_TEARDOWN'] === '1';
const POLL_INTERVAL_MS = 3_000;
const CASCADE_TIMEOUT_MS = 30_000;
const BOT_APPEAR_TIMEOUT_MS = 60_000;

function venueSecrets(): Record<string, string> {
  if (VENUE === 'hyperliquid') {
    const apiKey = process.env['HL_API_KEY'];
    const secret = process.env['HL_SECRET'];
    const walletAddress = process.env['HL_WALLET_ADDRESS'];
    if (!apiKey || !secret || !walletAddress) {
      fatal('Hyperliquid requires HL_API_KEY, HL_SECRET, and HL_WALLET_ADDRESS');
    }
    return { apiKey, secret, walletAddress };
  }
  if (VENUE === 'bybit') {
    const apiKey = process.env['BYBIT_API_KEY'];
    const secret = process.env['BYBIT_SECRET'];
    if (!apiKey || !secret) {
      fatal('Bybit requires BYBIT_API_KEY and BYBIT_SECRET');
    }
    return { apiKey, secret };
  }
  if (VENUE === '1inch') {
    const apiKey = process.env['ONEINCH_API_KEY'];
    const privateKey = process.env['ONEINCH_PRIVATE_KEY'];
    if (!apiKey || !privateKey) {
      fatal('1inch requires ONEINCH_API_KEY and ONEINCH_PRIVATE_KEY');
    }
    return { apiKey, privateKey };
  }
  fatal(`Unsupported VENUE: ${VENUE}. Supported: hyperliquid, bybit, 1inch`);
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(msg: string): void {
  console.log(`${DIM}${ts()}${RESET}  ${msg}`);
}

function section(title: string): void {
  console.log(`\n${BOLD}${CYAN}──── ${title} ────${RESET}`);
}

function ok(msg: string): void {
  console.log(`${DIM}${ts()}${RESET}  ${GREEN}✓${RESET} ${msg}`);
}

function warn(msg: string): void {
  console.log(`${DIM}${ts()}${RESET}  ${YELLOW}⚠${RESET} ${msg}`);
}

function fatal(msg: string): never {
  console.error(`${DIM}${ts()}${RESET}  ${RED}✗ FATAL: ${msg}${RESET}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

async function apiRequest<T = unknown>(
  method: string,
  path: string,
  options?: { body?: unknown; token?: string },
): Promise<ApiResponse<T>> {
  const url = `${API_BASE_URL}${path}`;
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options?.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }
  const res = await fetch(url, {
    method,
    headers,
    ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  let body: T;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    body = (await res.json()) as T;
  } else {
    body = (await res.text()) as unknown as T;
  }

  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Phase 1: Stack health
// ---------------------------------------------------------------------------

let stackStartedByUs = false;

async function checkApiHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureStack(): Promise<void> {
  section('Phase 1: Stack health');

  const healthy = await checkApiHealth();
  if (healthy) {
    ok(`API is reachable at ${API_BASE_URL}`);
    return;
  }

  if (!DOCKER_COMPOSE_UP) {
    fatal(
      `API at ${API_BASE_URL} is not reachable.\n` +
      `  Start the stack manually, or re-run with DOCKER_COMPOSE_UP=1 to auto-start it.`,
    );
  }

  log('API not reachable — starting Docker stack…');
  try {
    execSync('docker compose up -d', { cwd: REPO_ROOT, stdio: 'inherit' });
  } catch (err) {
    fatal(`docker compose up failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  stackStartedByUs = true;

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await checkApiHealth()) {
      ok('API is now healthy');
      return;
    }
    log('Waiting for API to start…');
  }
  fatal('API did not become healthy within 60 s after docker compose up');
}

// ---------------------------------------------------------------------------
// Phase 2: Setup
// ---------------------------------------------------------------------------

async function authenticate(): Promise<string> {
  const email = TEST_EMAIL;
  const password = TEST_PASSWORD;

  // Try login first
  const loginRes = await apiRequest<{ token?: string; error?: string }>(
    'POST', '/auth/login',
    { body: { email, password } },
  );
  if (loginRes.status === 200 && loginRes.body.token) {
    ok(`Logged in as ${email}`);
    return loginRes.body.token;
  }

  // Register
  const registerRes = await apiRequest<{ token?: string; error?: string }>(
    'POST', '/auth/register',
    { body: { email, password, displayName: 'Cascade Test' } },
  );
  if (registerRes.status === 201 && registerRes.body.token) {
    ok(`Registered and logged in as ${email}`);
    return registerRes.body.token;
  }

  fatal(
    `Authentication failed.\n` +
    `  Login: ${loginRes.status} ${JSON.stringify(loginRes.body)}\n` +
    `  Register: ${registerRes.status} ${JSON.stringify(registerRes.body)}`,
  );
}

interface ProviderLinkResult {
  connection: { id: string };
}

async function createProviderLink(token: string): Promise<string> {
  const res = await apiRequest<ProviderLinkResult & { error?: string }>(
    'POST', '/setup/provider-link',
    {
      token,
      body: {
        provider: VENUE,
        label: `cascade-test-${Date.now()}`,
        secrets: venueSecrets(),
        capability: 'trading',
      },
    },
  );

  if (res.status === 201 && res.body.connection?.id) {
    ok(`Provider link created — connectionId=${res.body.connection.id}`);
    return res.body.connection.id;
  }

  fatal(`Provider link creation failed: ${res.status} ${JSON.stringify(res.body)}`);
}

interface AgentBody {
  id: string;
  status: string;
  error?: string;
}

async function createAgent(token: string, connectionId: string): Promise<string> {
  // The goal tells the agent to create a bot on its first tick, then idle.
  // The test script controls when the agent is stopped — the agent itself
  // does not need to reason about closing or stopping.
  const goal = `
CASCADE TEST — EXECUTE IMMEDIATELY.

You are running an automated cascade-stop validation test in ${EXECUTION_MODE} mode.

On your VERY FIRST tick, take this action:
1. Call manage_bot with:
   - action = "create_and_start"
   - connectionId = "${connectionId}"
   - config = {
       "strategy": { "type": "momentum", "decisionMode": "mechanical" },
       "symbol": "BTC",
       "execution": { "mode": "${EXECUTION_MODE}", "slippageBps": 5 },
       "risk": { "stopLossPct": 3, "takeProfitPct": 6, "maxDrawdownPct": 5, "maxPositionSizePct": 10 }
     }

After creating the bot, do nothing else. Do not trade. Do not close positions.
Just wait for further instructions.
`.trim();

  const res = await apiRequest<AgentBody>(
    'POST', '/agents',
    {
      token,
      body: {
        name: `Cascade Test ${new Date().toISOString().slice(0, 10)}`,
        prompt: goal,
        skillIds: ['bot-management'],
        executionMode: EXECUTION_MODE,
        tickIntervalMs: TICK_INTERVAL_MS,
        capital: '100000',
        provider: LLM_PROVIDER,
        lightModel: LLM_LIGHT_MODEL,
        heavyModel: LLM_HEAVY_MODEL,
      },
    },
  );

  if (res.status === 201 && res.body.id) {
    ok(`Agent created — id=${res.body.id}`);
    return res.body.id;
  }

  fatal(`Agent creation failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function grantConnection(token: string, agentId: string, connectionId: string): Promise<void> {
  const res = await apiRequest<{ error?: string }>(
    'PATCH', `/agents/${agentId}`,
    { token, body: { connectionIds: [connectionId] } },
  );

  if (res.status === 200) {
    ok(`Connection granted — connectionId=${connectionId}`);
    return;
  }

  fatal(`Grant connection failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function verifyAgentProvisioned(token: string, agentId: string): Promise<void> {
  // Brief wait to let the agent record propagate to the read model
  await sleep(2000);

  const agentRes = await apiRequest<AgentBody>('GET', `/agents/${agentId}`, { token });
  if (agentRes.status !== 200) {
    fatal(`Could not fetch agent status during provision check: ${agentRes.status}`);
  }
  if (agentRes.body.status === 'unknown') {
    fatal(`Agent status is 'unknown' — provisioning may have failed`);
  }
  ok(`Agent provisioned — status=${agentRes.body.status}`);
}

async function startAgent(token: string, agentId: string): Promise<void> {
  const res = await apiRequest<{ status?: string; error?: string }>(
    'POST', `/agents/${agentId}/start`,
    { token },
  );

  if (res.status === 202) {
    ok(`Agent start requested — status=${res.body.status}`);
    return;
  }

  fatal(`Agent start failed: ${res.status} ${JSON.stringify(res.body)}`);
}

// ---------------------------------------------------------------------------
// Phase 3: Observe — wait for agent to create a bot via its tick loop
// ---------------------------------------------------------------------------

interface BotRow {
  id: string;
  status: string;
  creatorType: string;
  creatorId: string;
  createdAt: string;
}

interface BotListResponse {
  bots: BotRow[];
}

async function waitForAgentBot(
  token: string,
  agentId: string,
  testStartTime: string,
): Promise<{ botIds: string[] }> {
  section('Phase 3: Waiting for agent to create bots');
  log(`Timeout: ${BOT_APPEAR_TIMEOUT_MS / 1000}s  Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  const deadline = Date.now() + BOT_APPEAR_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const botsRes = await apiRequest<BotListResponse>('GET', '/bots', { token });
    if (botsRes.status !== 200 || !Array.isArray(botsRes.body.bots)) {
      warn(`Could not fetch bots: ${botsRes.status}`);
      continue;
    }

    const agentBots = botsRes.body.bots.filter(
      (b) =>
        b.creatorType === 'agent' &&
        b.creatorId === agentId &&
        b.createdAt > testStartTime,
    );

    if (agentBots.length === 0) {
      log('No agent-created bots yet — waiting for agent tick…');
      continue;
    }

    log(`Found ${agentBots.length} agent-created bot(s)`);
    for (const b of agentBots) {
      log(`  Bot id=${b.id} status=${b.status}`);
    }

    // Check for crashed bots before reaching 'running'
    const crashed = agentBots.filter((b) => b.status === 'crashed');
    if (crashed.length > 0) {
      const ids = crashed.map((b) => b.id).join(', ');
      fatal(`Bot(s) crashed before reaching 'running' status: ${ids}`);
    }

    // Wait for all agent-created bots to reach 'running'
    const allRunning = agentBots.every((b) => b.status === 'running');
    if (allRunning) {
      const botIds = agentBots.map((b) => b.id);
      ok(`${botIds.length} agent-created bot(s) running`);
      return { botIds };
    }

    log('Waiting for all agent bots to reach running status…');
  }

  fatal('Agent did not create bots within timeout — check agent activity feed for errors');
}

// ---------------------------------------------------------------------------
// Phase 3d: Stop agent and verify cascade to bots
// ---------------------------------------------------------------------------

async function runCascadeTest(
  token: string,
  agentId: string,
  createdBotIds: string[],
): Promise<void> {
  section('Phase 3d: Stop agent & verify bot cascade');

  // 1. Stop the agent
  log(`Stopping agent ${agentId}…`);
  const stopRes = await apiRequest<{ status?: string; error?: string }>(
    'POST', `/agents/${agentId}/stop`,
    { token },
  );
  if (stopRes.status !== 200) {
    fatal(`Agent stop failed: ${stopRes.status} ${JSON.stringify(stopRes.body)}`);
  }
  ok(`Agent stop requested — status=${stopRes.body.status}`);

  // 2. Assert agent status = 'stopped' (retry to allow DB propagation)
  let agentStopped = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(500);
    const agentRes = await apiRequest<AgentBody>('GET', `/agents/${agentId}`, { token });
    if (agentRes.status !== 200) {
      warn(`Agent status check attempt ${attempt + 1}/5: HTTP ${agentRes.status}`);
      continue;
    }
    if (agentRes.body.status === 'stopped') {
      agentStopped = true;
      break;
    }
    log(`Agent status is '${agentRes.body.status}' — retrying (${attempt + 1}/5)…`);
  }
  if (!agentStopped) {
    fatal(`Agent did not reach 'stopped' status after 5 retries`);
  }
  ok(`Agent status confirmed — stopped`);

  // 3. Poll: all agent-created bots reach status='stopped' within CASCADE_TIMEOUT_MS
  log(`Polling ${createdBotIds.length} agent bot(s) for cascade stop…`);
  log(`Cascade timeout: ${CASCADE_TIMEOUT_MS / 1000}s`);

  const cascadeDeadline = Date.now() + CASCADE_TIMEOUT_MS;
  const pendingBotIds = new Set(createdBotIds);

  while (pendingBotIds.size > 0 && Date.now() < cascadeDeadline) {
    await sleep(POLL_INTERVAL_MS);

    for (const botId of [...pendingBotIds]) {
      const botRes = await apiRequest<BotRow>('GET', `/bots/${botId}`, { token });
      if (botRes.status !== 200) {
        warn(`Could not fetch bot ${botId}: ${botRes.status}`);
        continue;
      }

      const botStatus = botRes.body.status;
      log(`Bot ${botId} status=${botStatus}`);

      if (botStatus === 'stopped') {
        ok(`Bot ${botId} cascade-stopped`);
        pendingBotIds.delete(botId);
      } else if (botStatus === 'crashed') {
        // Crashed is NOT an acceptable cascade outcome — the bot should reach
        // 'stopped' per AC1. Log a warning but do not remove from pending set
        // so the sweep correctly reports this as a test failure.
        warn(`Bot ${botId} crashed — expected 'stopped'. Will count as failure.`);
      }
    }
  }

  if (pendingBotIds.size > 0) {
    const remaining = [...pendingBotIds].join(', ');
    fatal(
      `Cascade-stop timeout: ${pendingBotIds.size} bot(s) did not stop within ${CASCADE_TIMEOUT_MS / 1000}s.\n` +
      `  Remaining bots: ${remaining}\n` +
      `  Check worker logs for cascade-stop errors.`,
    );
  }

  ok('All agent-created bots cascade-stopped successfully');
}

// ---------------------------------------------------------------------------
// Phase 4: Teardown
// ---------------------------------------------------------------------------

async function teardown(token: string, agentId: string): Promise<void> {
  section('Phase 4: Teardown');

  if (SKIP_TEARDOWN) {
    warn('SKIP_TEARDOWN=1 — leaving agent and bots for manual inspection');
    warn(`  Agent ID: ${agentId}`);
    return;
  }

  // Agent must be stopped before deletion
  const agentRes = await apiRequest<AgentBody>('GET', `/agents/${agentId}`, { token });
  if (agentRes.status === 200 && agentRes.body.status !== 'stopped') {
    log('Stopping agent before deletion…');
    await apiRequest('POST', `/agents/${agentId}/stop`, { token });
    await sleep(2000);
  }

  // Delete agent — agent deletion cleanup cascades to bots
  const deleteRes = await apiRequest<{ error?: string }>(
    'DELETE', `/agents/${agentId}`,
    { token },
  );
  if (deleteRes.status === 204) {
    ok('Agent deleted (bots cascaded via deletion cleanup)');
  } else {
    warn(`Agent delete returned ${deleteRes.status}: ${JSON.stringify(deleteRes.body)}`);
  }

  if (DOCKER_COMPOSE_DOWN && stackStartedByUs) {
    log('Stopping Docker stack (started by this script)…');
    try {
      execSync('docker compose down', { cwd: REPO_ROOT, stdio: 'inherit' });
      ok('Docker stack stopped');
    } catch (err) {
      warn(`docker compose down failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n${BOLD}=== Agent Bot Cascade Test ===${RESET}`);
  console.log(`  API:            ${API_BASE_URL}`);
  console.log(`  Venue:          ${VENUE}`);
  console.log(`  Execution mode: ${EXECUTION_MODE}`);
  console.log(`  Tick interval:  ${TICK_INTERVAL_MS / 1000}s`);
  console.log(`  Timeout:        ${TIMEOUT_MS / 1000}s`);
  console.log('');

  // Phase 1
  await ensureStack();

  // Phase 2: Setup
  section('Phase 2: Setup');

  const testStartTime = new Date().toISOString();

  const token = await authenticate();
  const connectionId = await createProviderLink(token);
  const agentId = await createAgent(token, connectionId);
  await grantConnection(token, agentId, connectionId);
  await verifyAgentProvisioned(token, agentId);
  await startAgent(token, agentId);
  ok(`Agent ${agentId} is starting`);

  // Phase 3: Wait for agent to create bots
  const { botIds } = await waitForAgentBot(token, agentId, testStartTime);

  // Phase 3d: Stop agent and verify cascade
  await runCascadeTest(token, agentId, botIds);

  // Phase 4: Teardown
  await teardown(token, agentId);

  // Result
  console.log('');
  console.log(`${BOLD}${GREEN}PASS${RESET} — agent stop cascaded to all agent-created bots.`);
}

main().catch((err: unknown) => {
  console.error(`${RED}Unhandled error:${RESET}`, err);
  process.exit(1);
});
