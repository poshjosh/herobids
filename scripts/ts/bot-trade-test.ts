/**
 * bot-trade-test.ts — End-to-end smoke test that verifies bot lifecycle correctness.
 *
 * This script is NOT part of the routine test suite. Run it manually to
 * verify bot lifecycle invariants against a live or local stack.
 *
 * What it does
 * ────────────
 *  Phase 1    Stack    — checks API is reachable; optionally starts Docker.
 *  Phase 2    Setup    — registers/logs in, creates provider-link, creates a bot.
 *  Phase 3    User bot lifecycle — start, verify invariants, wait for activity,
 *             stop, verify invariants, restart, verify invariants, delete.
 *  Phase 4    Guards   — idempotency checks, delete-while-running rejection.
 *  Phase 5    Teardown — clean up remaining test resources.
 *
 * Required env vars
 * ─────────────────
 *  API_BASE_URL          default http://localhost:3000
 *  TEST_EMAIL            default trade-test@local.test
 *  TEST_PASSWORD         default TradeTest123!
 *  VENUE                 hyperliquid (default) | bybit | 1inch
 *
 *  Hyperliquid testnet (VENUE=hyperliquid):
 *    HL_API_KEY, HL_SECRET, HL_WALLET_ADDRESS
 *
 * Optional env vars
 * ─────────────────
 *  EXECUTION_MODE        paper (default) | shadow | live
 *  TICK_INTERVAL_MS      60000 (default)
 *  TIMEOUT_MS            600000 (default, 10 minutes)
 *  DOCKER_COMPOSE_UP     1 to auto-start Docker
 *  DOCKER_COMPOSE_DOWN   1 to stop Docker on exit
 *  SKIP_TEARDOWN         1 to leave bot running
 *
 * Usage
 * ─────
 *  HL_API_KEY=... HL_SECRET=... HL_WALLET_ADDRESS=0x... \
 *    tsx scripts/ts/bot-trade-test.ts
 */

import { execSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── Config ──────────────────────────────────────────────────────────────

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
const POLL_INTERVAL_MS = 5_000;

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

// ── Logging ─────────────────────────────────────────────────────────────

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

// ── HTTP helpers ────────────────────────────────────────────────────────

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

async function get<T = unknown>(path: string, token: string): Promise<ApiResponse<T>> {
  return apiRequest<T>('GET', path, { token });
}

async function post<T = unknown>(path: string, body: unknown, token: string): Promise<ApiResponse<T>> {
  return apiRequest<T>('POST', path, { body, token });
}

async function del<T = unknown>(path: string, token: string): Promise<ApiResponse<T>> {
  return apiRequest<T>('DELETE', path, { token });
}

// ── Polling ─────────────────────────────────────────────────────────────

async function pollUntil(
  label: string,
  fn: () => Promise<boolean>,
  timeoutMs: number = TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) {
      ok(label);
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  fatal(`Timeout waiting for: ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Phase 1: Stack health ──────────────────────────────────────────

  section('Phase 1: Stack health');

  let dockerStarted = false;

  // Check API reachable
  try {
    const res = await fetch(`${API_BASE_URL}/health`);
    if (res.ok) {
      ok(`API reachable at ${API_BASE_URL}`);
    } else {
      if (DOCKER_COMPOSE_UP) {
        warn('API not healthy, starting Docker Compose...');
        execSync('docker compose up -d', { cwd: REPO_ROOT, stdio: 'inherit' });
        dockerStarted = true;
        await sleep(10_000); // Wait for services to start
        ok('Docker Compose started');
      } else {
        warn('API not healthy. Set DOCKER_COMPOSE_UP=1 to auto-start.');
      }
    }
  } catch {
    if (DOCKER_COMPOSE_UP) {
      warn('API unreachable, starting Docker Compose...');
      execSync('docker compose up -d', { cwd: REPO_ROOT, stdio: 'inherit' });
      dockerStarted = true;
      await sleep(10_000);
      ok('Docker Compose started');
    } else {
      fatal(`API unreachable at ${API_BASE_URL}. Set DOCKER_COMPOSE_UP=1 to auto-start.`);
    }
  }

  // ── Phase 2: Setup ─────────────────────────────────────────────────

  section('Phase 2: Setup');

  const secrets = venueSecrets();
  const password = TEST_PASSWORD;

  // Register / login
  let token: string;
  log(`Registering/logging in as ${TEST_EMAIL}...`);
  const registerRes = await post<{ token?: string; error?: string }>('/auth/register', {
    email: TEST_EMAIL,
    password,
    displayName: 'Bot Trade Test',
  }, '');

  if (registerRes.status === 201 && registerRes.body.token) {
    token = registerRes.body.token;
    ok('Registered new test user');
  } else if (registerRes.status === 409) {
    // Already exists — login
    const loginRes = await post<{ token: string }>('/auth/login', {
      email: TEST_EMAIL,
      password,
    }, '');
    if (loginRes.status !== 200 || !loginRes.body.token) {
      fatal(`Login failed: ${loginRes.status}`);
    }
    token = loginRes.body.token;
    ok('Logged in');
  } else {
    fatal(`Registration failed: ${registerRes.status} ${JSON.stringify(registerRes.body)}`);
  }

  // Create provider-link (credential + connection + trading binding)
  log('Creating provider-link...');
  const linkRes = await post<{ tradingBinding?: { id: string }; error?: string }>('/setup/provider-link', {
    provider: VENUE,
    label: `bot-trade-test-${Date.now()}`,
    secrets: secrets,
    capability: 'trading',
  }, token);
  if (linkRes.status !== 201 || !linkRes.body.tradingBinding?.id) {
    fatal(`Provider-link failed: ${linkRes.status} ${JSON.stringify(linkRes.body)}`);
  }
  const bindingId = linkRes.body.tradingBinding.id;
  ok(`Provider-link created (binding: ${bindingId})`);

  // Create bot — venue-aware config (swap venues use BASE/QUOTE symbols)
  log('Creating bot...');
  const botSymbol = VENUE === '1inch' ? 'WETH/USDC' : 'BTC-PERP';
  const botPayload: Record<string, unknown> = {
    tradingBindingId: bindingId,
    venue: VENUE,
    symbol: botSymbol,
    config: {
      strategy: { type: 'momentum', params: { symbol: botSymbol, intervalMs: TICK_INTERVAL_MS, lookbackPeriods: 14 } },
      risk: {},
      execution: { mode: EXECUTION_MODE },
      venue: VENUE,
      symbol: botSymbol,
    },
  };
  // Swap venues (1inch) require swapAssets inside config for token resolution
  if (VENUE === '1inch') {
    (botPayload['config'] as Record<string, unknown>)['swapAssets'] = {
      baseAsset: 'WETH',
      quoteAsset: 'USDC',
      baseDecimals: 18,
      quoteDecimals: 6,
    };
  }
  const createRes = await post<{ id: string; status: string }>('/bots', botPayload, token);
  if (createRes.status !== 201) {
    fatal(`Bot creation failed: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  const botId = createRes.body.id;
  ok(`Bot created: ${botId}`);

  // ── Phase 3: User bot lifecycle ───────────────────────────────────

  section('Phase 3: User bot lifecycle');

  // 3a. Start bot
  log('Starting bot...');
  const startRes = await post<{ status: string; botId: string }>(`/bots/${botId}/start`, {}, token);
  if (startRes.status !== 202) {
    fatal(`Start failed: ${startRes.status} ${JSON.stringify(startRes.body)}`);
  }
  ok(`Start accepted: ${startRes.body.status}`);

  // 3b. Wait for status running
  await pollUntil('Bot status → running', async () => {
    const res = await get<{ status: string; startedAt: string | null; stoppedAt: string | null }>(`/bots/${botId}`, token);
    if (res.status !== 200) return false;
    const bot = res.body;
    return bot.status === 'running';
  });

  // 3c. Verify invariants: startedAt set, stoppedAt === null
  {
    const res = await get<{ status: string; startedAt: string | null; stoppedAt: string | null; createdAt: string }>(`/bots/${botId}`, token);
    if (res.status !== 200) fatal('Failed to fetch bot');
    const bot = res.body;
    if (!bot.startedAt) fatal('INVARIANT FAILED: startedAt is null on running bot');
    if (bot.stoppedAt !== null) fatal(`INVARIANT FAILED: stoppedAt is not null on running bot: ${bot.stoppedAt}`);
    if (new Date(bot.startedAt).getTime() < new Date(bot.createdAt).getTime()) {
      fatal('INVARIANT FAILED: startedAt < createdAt');
    }
    ok('Running invariants: startedAt set, stoppedAt null, startedAt >= createdAt');
  }

  // 3d. Wait briefly for any trading activity (fill events)
  log('Waiting for trading activity...');
  let sawActivity = false;
  try {
    await pollUntil('Trading activity (fills)', async () => {
      const res = await get<{ events: Array<{ type: string }> }>(`/bots/${botId}/events?limit=5`, token);
      if (res.status !== 200) return false;
      const fillEvents = res.body.events.filter((e) => e.type.startsWith('fill.') || e.type.startsWith('order.'));
      if (fillEvents.length > 0) {
        sawActivity = true;
        ok(`Saw ${fillEvents.length} fill/order events`);
        return true;
      }
      return false;
    }, Math.min(120_000, TIMEOUT_MS));
  } catch {
    warn('No trading activity detected within timeout — bot may not have ticked yet. Continuing.');
  }

  // 3e. Stop bot
  log('Stopping bot...');
  const stopRes = await post<{ status: string; botId: string }>(`/bots/${botId}/stop`, {}, token);
  if (stopRes.status !== 202) {
    fatal(`Stop failed: ${stopRes.status} ${JSON.stringify(stopRes.body)}`);
  }
  ok(`Stop accepted: ${stopRes.body.status}`);

  // 3f. Wait for status stopped
  await pollUntil('Bot status → stopped', async () => {
    const res = await get<{ status: string }>(`/bots/${botId}`, token);
    if (res.status !== 200) return false;
    return res.body.status === 'stopped';
  });

  // 3g. Verify invariants: stoppedAt set, stoppedAt > startedAt
  {
    const res = await get<{ status: string; startedAt: string | null; stoppedAt: string | null }>(`/bots/${botId}`, token);
    if (res.status !== 200) fatal('Failed to fetch bot');
    const bot = res.body;
    if (!bot.stoppedAt) fatal('INVARIANT FAILED: stoppedAt is null on stopped bot');
    if (!bot.startedAt) fatal('INVARIANT FAILED: startedAt is null on stopped bot');
    if (new Date(bot.stoppedAt).getTime() < new Date(bot.startedAt).getTime()) {
      fatal('INVARIANT FAILED: stoppedAt < startedAt');
    }
    ok('Stopped invariants: stoppedAt set, stoppedAt >= startedAt, status=stopped');
  }

  // 3h. Restart bot
  log('Restarting bot...');
  const restartRes = await post<{ status: string; botId: string }>(`/bots/${botId}/start`, {}, token);
  if (restartRes.status !== 202) {
    fatal(`Restart failed: ${restartRes.status} ${JSON.stringify(restartRes.body)}`);
  }
  ok(`Restart accepted: ${restartRes.body.status}`);

  // 3i. Wait for status running again
  await pollUntil('Bot status → running (after restart)', async () => {
    const res = await get<{ status: string }>(`/bots/${botId}`, token);
    if (res.status !== 200) return false;
    return res.body.status === 'running';
  });

  // 3j. Verify invariants: stoppedAt cleared, startedAt set to new value
  {
    const res = await get<{ status: string; startedAt: string | null; stoppedAt: string | null }>(`/bots/${botId}`, token);
    if (res.status !== 200) fatal('Failed to fetch bot');
    const bot = res.body;
    if (!bot.startedAt) fatal('INVARIANT FAILED: startedAt is null after restart');
    if (bot.stoppedAt !== null) fatal(`INVARIANT FAILED: stoppedAt is not null after restart: ${bot.stoppedAt}`);
    ok('Restart invariants: startedAt set, stoppedAt null (Phase 1 fix validated)');
  }

  // ── Phase 4: Idempotency & guard checks ───────────────────────────

  section('Phase 4: Idempotency & guard checks');

  // 4a. Double-start (idempotent)
  const doubleStart = await post<{ status: string }>(`/bots/${botId}/start`, {}, token);
  if (doubleStart.status !== 200 || doubleStart.body.status !== 'already_running') {
    fatal(`Double-start not idempotent: ${doubleStart.status} ${JSON.stringify(doubleStart.body)}`);
  }
  ok('Double-start → 200 already_running (idempotent)');

  // 4b. Delete while running → 409
  const deleteRunning = await del<{ error: string }>(`/bots/${botId}`, token);
  if (deleteRunning.status !== 409) {
    fatal(`Delete-while-running not rejected: ${deleteRunning.status} ${JSON.stringify(deleteRunning.body)}`);
  }
  ok('Delete-while-running → 409 Conflict');

  // 4c. Stop the bot
  log('Stopping bot for final cleanup...');
  const stop2Res = await post<{ status: string }>(`/bots/${botId}/stop`, {}, token);
  if (stop2Res.status !== 202) {
    fatal(`Stop failed: ${stop2Res.status} ${JSON.stringify(stop2Res.body)}`);
  }
  await pollUntil('Bot status → stopped (final)', async () => {
    const res = await get<{ status: string }>(`/bots/${botId}`, token);
    if (res.status !== 200) return false;
    return res.body.status === 'stopped';
  });

  // 4d. Double-stop (idempotent)
  const doubleStop = await post<{ status: string }>(`/bots/${botId}/stop`, {}, token);
  if (doubleStop.status !== 200 || doubleStop.body.status !== 'already_stopped') {
    fatal(`Double-stop not idempotent: ${doubleStop.status} ${JSON.stringify(doubleStop.body)}`);
  }
  ok('Double-stop → 200 already_stopped (idempotent)');

  // 4e. Delete stopped bot
  const deleteStopped = await del(`/bots/${botId}`, token);
  if (deleteStopped.status !== 204) {
    fatal(`Delete stopped bot failed: ${deleteStopped.status} ${JSON.stringify(deleteStopped.body)}`);
  }
  ok('Delete stopped bot → 204 No Content');

  // Verify bot is gone
  const getDeleted = await get(`/bots/${botId}`, token);
  if (getDeleted.status !== 404) {
    fatal(`Bot not actually deleted: ${getDeleted.status}`);
  }
  ok('Bot gone after delete');

  // ── Phase 5: Teardown ──────────────────────────────────────────────

  section('Phase 5: Teardown');

  if (dockerStarted && DOCKER_COMPOSE_DOWN) {
    log('Stopping Docker Compose...');
    execSync('docker compose down', { cwd: REPO_ROOT, stdio: 'inherit' });
    ok('Docker Compose stopped');
  }

  section('ALL CHECKS PASSED');
  ok('Bot lifecycle is correct!');
}

main().catch((err) => {
  console.error(`\n${RED}FATAL: ${err instanceof Error ? err.message : String(err)}${RESET}`);
  process.exit(1);
});
