/**
 * agent-trade-test.ts — End-to-end smoke test that verifies an agent can trade.
 *
 * This script is NOT part of the routine test suite. Run it manually to
 * diagnose agent trading issues against a live or local stack.
 *
 * What it does
 * ────────────
 *  Phase 1  Stack — checks Docker + API are healthy; optionally starts them.
 *  Phase 2  Setup  — registers/logs in, creates a provider-link (credential +
 *                    connection + trading binding), creates a trading agent,
 *                    binds trading capability to it, and starts it.
 *  Phase 3  Watch  — polls activity-feed, decisions, and trading state every
 *                    10 s; streams events to stdout for debugging.
 *  Phase 4  Teardown — stops and deletes the agent; optionally stops Docker.
 *
 * Required env vars
 * ─────────────────
 *  API_BASE_URL          default http://localhost:3000
 *  TEST_EMAIL            default trade-test@local.test
 *  TEST_PASSWORD         default TradeTest123!
 *
 *  Hyperliquid testnet (VENUE=hyperliquid):
 *    HL_API_KEY, HL_SECRET, HL_WALLET_ADDRESS
 *
 *  Bybit (VENUE=bybit):
 *    BYBIT_API_KEY, BYBIT_SECRET
 *
 * Optional env vars
 * ─────────────────
 *  VENUE                 hyperliquid (default) | bybit
 *  EXECUTION_MODE        paper (default) | shadow | live
 *  TICK_INTERVAL_MS      60000 (default, 1 minute)
 *  TIMEOUT_MS            600000 (default, 10 minutes)
 *  DOCKER_COMPOSE_UP     1 to auto-start Docker stack when unhealthy
 *  DOCKER_COMPOSE_DOWN   1 to stop Docker stack on exit (only if started here)
 *  SKIP_TEARDOWN         1 to leave agent running for manual inspection
 *
 * Usage
 * ─────
 *  HL_API_KEY=... HL_SECRET=... HL_WALLET_ADDRESS=0x... \
 *    tsx scripts/ts/agent-trade-test.ts
 */

import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE_URL = process.env['API_BASE_URL'] ?? 'http://localhost:3000';
const TEST_EMAIL = process.env['TEST_EMAIL'] ?? 'trade-test@local.test';
const TEST_PASSWORD = process.env['TEST_PASSWORD'] ?? 'TradeTest123!';
const VENUE = process.env['VENUE'] ?? 'hyperliquid';
const EXECUTION_MODE = process.env['EXECUTION_MODE'] ?? 'paper';
const TICK_INTERVAL_MS = parseInt(process.env['TICK_INTERVAL_MS'] ?? '60000', 10);
const TIMEOUT_MS = parseInt(process.env['TIMEOUT_MS'] ?? '600000', 10);
const DOCKER_COMPOSE_UP = process.env['DOCKER_COMPOSE_UP'] === '1';
const DOCKER_COMPOSE_DOWN = process.env['DOCKER_COMPOSE_DOWN'] === '1';
const SKIP_TEARDOWN = process.env['SKIP_TEARDOWN'] === '1';
const POLL_INTERVAL_MS = 10_000;

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
  fatal(`Unsupported VENUE: ${VENUE}. Supported: hyperliquid, bybit`);
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

  // Wait up to 60 s for API to become healthy
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
  // Try login first (idempotent across multiple test runs)
  const loginRes = await apiRequest<{ token?: string; error?: string }>(
    'POST', '/auth/login',
    { body: { email: TEST_EMAIL, password: TEST_PASSWORD } },
  );
  if (loginRes.status === 200 && loginRes.body.token) {
    ok(`Logged in as ${TEST_EMAIL}`);
    return loginRes.body.token;
  }

  // Register a new account
  const registerRes = await apiRequest<{ token?: string; error?: string }>(
    'POST', '/auth/register',
    { body: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: 'Trade Test' } },
  );
  if (registerRes.status === 201 && registerRes.body.token) {
    ok(`Registered and logged in as ${TEST_EMAIL}`);
    return registerRes.body.token;
  }

  fatal(
    `Authentication failed.\n` +
    `  Login: ${loginRes.status} ${JSON.stringify(loginRes.body)}\n` +
    `  Register: ${registerRes.status} ${JSON.stringify(registerRes.body)}`,
  );
}

interface ProviderLinkResult {
  tradingBinding: { id: string };
}

function buildTradeTestDecision(): { instrumentId: string; targetSize: string } {
  if (VENUE === 'hyperliquid') {
    return { instrumentId: 'BTC', targetSize: '0.01' };
  }

  if (VENUE === 'bybit') {
    return { instrumentId: 'BTC', targetSize: '0.001' };
  }

  fatal(`Unsupported VENUE: ${VENUE}. Supported: hyperliquid, bybit`);
}

async function createProviderLink(token: string): Promise<string> {
  const res = await apiRequest<ProviderLinkResult & { error?: string }>(
    'POST', '/setup/provider-link',
    {
      token,
      body: {
        provider: VENUE,
        label: `trade-test-${Date.now()}`,
        secrets: venueSecrets(),
        capability: 'trading',
      },
    },
  );

  if (res.status === 201 && res.body.tradingBinding?.id) {
    ok(`Provider link created — bindingId=${res.body.tradingBinding.id}`);
    return res.body.tradingBinding.id;
  }

  fatal(`Provider link creation failed: ${res.status} ${JSON.stringify(res.body)}`);
}

// The goal is deliberately imperative to push the agent to trade on tick 1
// without analysis or deliberation. This is what we want in a trade test.
const TRADE_TEST_DECISION = buildTradeTestDecision();

const TRADE_TEST_GOAL = `
TRADE TEST — EXECUTE IMMEDIATELY.

You are running an automated paper-trading validation test.
Your ONLY objective is to confirm that the full trading path works end-to-end.

On your VERY FIRST tick, take these actions in order:
1. Call list_positions to confirm your current position state.
2. If you are flat, call submit_decision with exactly these values:
  - instrumentId = "${TRADE_TEST_DECISION.instrumentId}"
  - intent = "go_long"
  - targetSize = "${TRADE_TEST_DECISION.targetSize}"
  - rationaleSummary = "trade-test validation"
  - confidence = 0.95
3. Do not create a bot for this test.
4. On the next tick, call list_positions and get_analytics to confirm the trade landed.

Do NOT wait for market signals. Do NOT evaluate the regime. Act immediately.
`.trim();

interface AgentBody {
  id: string;
  status: string;
  error?: string;
}

async function createAgent(token: string): Promise<string> {
  const res = await apiRequest<AgentBody>(
    'POST', '/agents',
    {
      token,
      body: {
        name: `Trade Test ${new Date().toISOString().slice(0, 10)}`,
        prompt: TRADE_TEST_GOAL,
        skillIds: ['trading', 'bot-management', 'risk-monitoring'],
        executionMode: EXECUTION_MODE,
        tickIntervalMs: TICK_INTERVAL_MS,
      },
    },
  );

  if (res.status === 201 && res.body.id) {
    ok(`Agent created — id=${res.body.id}`);
    return res.body.id;
  }

  fatal(`Agent creation failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function bindTradingCapability(token: string, agentId: string, bindingId: string): Promise<void> {
  const res = await apiRequest<{ error?: string }>(
    'POST', `/agents/${agentId}/capabilities/trading/actions/bind`,
    { token, body: { bindingId } },
  );

  if (res.status === 200 || res.status === 201) {
    ok(`Trading capability bound — bindingId=${bindingId}`);
    return;
  }

  fatal(`Bind failed: ${res.status} ${JSON.stringify(res.body)}`);
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
// Phase 3: Watch
// ---------------------------------------------------------------------------

interface ActivityEntry {
  id: string;
  type: string;
  content?: string;
  createdAt: string;
}

interface DecisionRow {
  id: string;
  intent?: string;
  instrumentId?: string;
  targetSize?: string;
  side?: string;
  symbol?: string;
  status?: string;
  createdAt: string;
}

interface TradingState {
  openPositionCount: number;
  totalPnl: string;
  agentStatus: string;
}

interface AgentStatusBody {
  status: string;
  activeSession?: { status: string } | null;
}

// Tracks which activity entry IDs we have already printed so polling stays incremental.
const seenActivityIds = new Set<string>();

async function fetchAndPrintNewActivity(token: string, agentId: string): Promise<void> {
  const res = await apiRequest<ActivityEntry[]>(
    'GET', `/agents/${agentId}/activity-feed?limit=50`,
    { token },
  );
  if (res.status !== 200 || !Array.isArray(res.body)) return;

  // The feed is newest-first — reverse to print chronologically.
  const entries = [...res.body].reverse();
  for (const entry of entries) {
    if (seenActivityIds.has(entry.id)) continue;
    seenActivityIds.add(entry.id);
    const preview = (entry.content ?? '').slice(0, 120).replace(/\n/g, ' ');
    log(`  ${DIM}[${entry.type}]${RESET} ${preview}`);
  }
}

async function watchAgent(token: string, agentId: string): Promise<'success' | 'timeout' | 'crashed'> {
  section('Phase 3: Watching agent');
  log(`Timeout: ${TIMEOUT_MS / 1000}s  Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  const deadline = Date.now() + TIMEOUT_MS;
  let lastDecisionCount = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    // 1. Agent status
    const agentRes = await apiRequest<AgentStatusBody>('GET', `/agents/${agentId}`, { token });
    if (agentRes.status !== 200) {
      warn(`Could not fetch agent status: ${agentRes.status}`);
      continue;
    }
    const agentStatus = agentRes.body.status;
    const sessionStatus = agentRes.body.activeSession?.status ?? 'none';
    log(`Agent status=${agentStatus}  session=${sessionStatus}`);

    if (agentStatus === 'crashed') {
      await fetchAndPrintNewActivity(token, agentId);
      return 'crashed';
    }

    // 2. Stream new activity events
    await fetchAndPrintNewActivity(token, agentId);

    // 3. Decisions submitted directly by the agent or via one of its bots.
    const decisionsRes = await apiRequest<DecisionRow[]>(
      'GET', `/agents/${agentId}/decisions?limit=10`,
      { token },
    );
    if (decisionsRes.status === 200 && Array.isArray(decisionsRes.body)) {
      const count = decisionsRes.body.length;
      if (count > lastDecisionCount) {
        for (const d of decisionsRes.body.slice(0, count - lastDecisionCount)) {
          const intent = d.intent ?? d.side ?? 'unknown';
          const instrument = d.instrumentId ?? d.symbol ?? 'unknown';
          const details = d.targetSize ? ` targetSize=${d.targetSize}` : '';
          const status = d.status ? ` status=${d.status}` : '';
          ok(`Decision recorded — id=${d.id} intent=${intent} instrument=${instrument}${details}${status}`);
        }
        lastDecisionCount = count;
      }
    }

    // 4. Trading state (open positions = money moved)
    const stateRes = await apiRequest<TradingState>(
      'GET', `/agents/${agentId}/capabilities/trading/state`,
      { token },
    );
    if (stateRes.status === 200) {
      const { openPositionCount, totalPnl } = stateRes.body;
      if (openPositionCount > 0) {
        ok(`Open position confirmed — count=${openPositionCount} totalPnl=${totalPnl}`);
        return 'success';
      }
    }

    // 5. Decisions alone (without open position) also count as success for paper mode
    // In paper mode fills don't always produce an open position row immediately.
    if (lastDecisionCount > 0) {
      ok(`Decision submitted in paper mode — count=${lastDecisionCount}`);
      return 'success';
    }
  }

  return 'timeout';
}

// ---------------------------------------------------------------------------
// Phase 4: Teardown
// ---------------------------------------------------------------------------

async function teardown(token: string, agentId: string): Promise<void> {
  section('Phase 4: Teardown');

  if (SKIP_TEARDOWN) {
    warn('SKIP_TEARDOWN=1 — leaving agent running for manual inspection');
    warn(`  Agent ID: ${agentId}`);
    return;
  }

  // Stop
  const stopRes = await apiRequest<{ error?: string }>(
    'POST', `/agents/${agentId}/stop`,
    { token },
  );
  if (stopRes.status === 200 || stopRes.status === 202) {
    ok('Agent stopped');
  } else {
    warn(`Stop returned ${stopRes.status}: ${JSON.stringify(stopRes.body)}`);
  }

  // Wait briefly for the status to settle before deleting
  await sleep(3000);

  // Delete
  const deleteRes = await apiRequest<{ error?: string }>(
    'DELETE', `/agents/${agentId}`,
    { token },
  );
  if (deleteRes.status === 204) {
    ok('Agent deleted');
  } else {
    warn(`Delete returned ${deleteRes.status}: ${JSON.stringify(deleteRes.body)}`);
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
  console.log(`\n${BOLD}=== Agent Trade Test ===${RESET}`);
  console.log(`  API:            ${API_BASE_URL}`);
  console.log(`  Venue:          ${VENUE}`);
  console.log(`  Execution mode: ${EXECUTION_MODE}`);
  console.log(`  Tick interval:  ${TICK_INTERVAL_MS / 1000}s`);
  console.log(`  Timeout:        ${TIMEOUT_MS / 1000}s`);
  console.log('');

  // Phase 1
  await ensureStack();

  // Phase 2
  section('Phase 2: Setup');

  const token = await authenticate();
  const bindingId = await createProviderLink(token);
  const agentId = await createAgent(token);
  await bindTradingCapability(token, agentId, bindingId);
  await startAgent(token, agentId);
  ok(`Agent ${agentId} is starting`);

  // Phase 3
  const outcome = await watchAgent(token, agentId);

  // Phase 4
  await teardown(token, agentId);

  // Result
  console.log('');
  if (outcome === 'success') {
    console.log(`${BOLD}${GREEN}PASS${RESET} — agent submitted a trade within the timeout window.`);
  } else if (outcome === 'crashed') {
    console.log(`${BOLD}${RED}FAIL${RESET} — agent crashed. Check the activity feed above for the cause.`);
    process.exit(1);
  } else {
    console.log(`${BOLD}${RED}FAIL${RESET} — no trade was observed within ${TIMEOUT_MS / 1000}s.`);
    console.log('  Possible causes:');
    console.log('    · Agent still starting / waiting for first tick');
    console.log('    · Scout held (no market change detected) — add TICK_INTERVAL_MS=30000 to force faster ticks');
    console.log('    · Trading capability not effectively ready — check activity feed for capability errors');
    console.log('    · LLM provider issue — check worker logs');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`${RED}Unhandled error:${RESET}`, err);
  process.exit(1);
});
