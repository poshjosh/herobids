/**
 * agent-trade-test.ts — End-to-end smoke test that verifies an agent can open and close a trade.
 *
 * This script is NOT part of the routine test suite. Run it manually to
 * diagnose agent trading issues against a live or local stack.
 *
 * What it does
 * ────────────
 *  Phase 1    Stack    — checks Docker + API are healthy; optionally starts them.
 *  Phase 2    Setup    — registers/logs in, creates a provider-link (credential +
 *                        connection + trading binding), creates a trading agent,
 *                        binds trading capability to it, and starts it.
 *  Phase 3    Watch    — polls activity-feed, decisions, and trading state every
 *                        10 s until an open position is confirmed.
 *  Phase 3.5  Assert   — verifies decisions are non-rejected, journal events exist,
 *                        and position visibility is consistent (system vs agent-visible).
 *  Phase 3.6  Close    — waits for the agent to submit go_flat and confirms
 *                        openPositionCount drops to 0.
 *  Phase 3.7  Audit    — checks DB bookkeeping: closedAt set, go_flat plan settled,
 *                        journal event count, worker error logs, Redis reminder cleanup.
 *  Phase 4    Teardown — stops and deletes the agent; optionally stops Docker.
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
 *  1inch swap (VENUE=1inch):
 *    ONEINCH_API_KEY, ONEINCH_PRIVATE_KEY
 *
 * Optional env vars
 * ─────────────────
 *  VENUE                 hyperliquid (default) | bybit | 1inch
 *  EXECUTION_MODE        paper (default) | shadow | live
 *  TICK_INTERVAL_MS      60000 (default, 1 minute)
 *  TIMEOUT_MS            600000 (default, 10 minutes)
 *  LLM_PROVIDER          ollama (default) — LLM provider for agent reasoning
 *  LLM_LIGHT_MODEL       qwen3:8b (default) — fast/cheap model
 *  LLM_HEAVY_MODEL       qwen3.6:35b-a3b-q4_K_M (default) — powerful model for strategy
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
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, closeDatabase, users } from '@herobids/db';
import { eq } from 'drizzle-orm';
import {
  getToolResultPayload,
  selectListPositionsResult,
  type AgentActivityEntry,
  type ToolResultPayload,
} from './agent-trade-test-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE_URL = process.env['API_BASE_URL'] ?? 'http://localhost:3000';
const TEST_EMAIL = process.env['TEST_EMAIL'] ?? 'trade-test@local.test';
const TEST_PASSWORD = process.env['TEST_PASSWORD'] ?? 'TradeTest123!';
const ADMIN_EMAIL = process.env['ADMIN_EMAIL'] ?? 'admin@herobids.local';
const ADMIN_PASSWORD = process.env['ADMIN_PASSWORD'] ?? 'AdminTest123!';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://herobids:herobids@localhost:5432/herobids';
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

/**
 * Promote a user to admin via direct DB connection.
 * Used when EXECUTION_MODE=shadow and the admin user was just registered
 * (registration always creates non-admin users).
 */
async function promoteToAdmin(email: string): Promise<void> {
  const db = createDatabase(DATABASE_URL);
  try {
    const result = await db
      .update(users)
      .set({ isAdmin: true, updatedAt: new Date() })
      .where(eq(users.email, email.toLowerCase().trim()))
      .returning({ id: users.id });
    if (result.length > 0) {
      ok(`User ${email} promoted to admin (id=${result[0]!.id})`);
    } else {
      warn(`Could not promote ${email} to admin — user not found in DB`);
    }
  } finally {
    await closeDatabase(db);
  }
}

async function authenticate(): Promise<string> {
  // When running in shadow mode, use admin credentials.
  // Shadow mode is restricted to admin users by the API.
  const email = EXECUTION_MODE === 'shadow' ? ADMIN_EMAIL : TEST_EMAIL;
  const password = EXECUTION_MODE === 'shadow' ? ADMIN_PASSWORD : TEST_PASSWORD;

  // Try login first (idempotent across multiple test runs)
  const loginRes = await apiRequest<{ token?: string; error?: string }>(
    'POST', '/auth/login',
    { body: { email, password } },
  );
  if (loginRes.status === 200 && loginRes.body.token) {
    ok(`Logged in as ${email}`);

    // Shadow mode: ensure the user is still admin (may have been demoted or
    // never promoted if seed-admin was skipped).
    if (EXECUTION_MODE === 'shadow') {
      await promoteToAdmin(email);
    }

    return loginRes.body.token;
  }

  // Register a new account
  const registerRes = await apiRequest<{ token?: string; error?: string }>(
    'POST', '/auth/register',
    { body: { email, password, displayName: EXECUTION_MODE === 'shadow' ? 'Admin' : 'Trade Test' } },
  );
  if (registerRes.status === 201 && registerRes.body.token) {
    ok(`Registered and logged in as ${email}`);

    // Shadow mode: newly registered users are NOT admin by default.
    // Promote via direct DB so the next API call sees isAdmin=true.
    if (EXECUTION_MODE === 'shadow') {
      await promoteToAdmin(email);
    }

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

function buildTradeTestDecision(): { instrumentId: string; targetSize: string } {
  if (VENUE === 'hyperliquid') {
    return { instrumentId: 'BTC', targetSize: '0.01' };
  }

  if (VENUE === 'bybit') {
    return { instrumentId: 'BTC', targetSize: '0.001' };
  }

  if (VENUE === '1inch') {
    // 1inch swap: go_long = buy WETH with USDC on Base.
    // targetSize is the WETH amount (~$0.02 at current prices — minimal risk).
    // Instrument MUST be BASE/QUOTE format for swap venues.
    return { instrumentId: 'WETH/USDC', targetSize: '0.00001' };
  }

  fatal(`Unsupported VENUE: ${VENUE}. Supported: hyperliquid, bybit, 1inch`);
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

  if (res.status === 201 && res.body.connection?.id) {
    ok(`Provider link created — connectionId=${res.body.connection.id}`);
    return res.body.connection.id;
  }

  fatal(`Provider link creation failed: ${res.status} ${JSON.stringify(res.body)}`);
}

// The goal is deliberately imperative to push the agent to trade on tick 1
// without analysis or deliberation. This is what we want in a trade test.
const TRADE_TEST_DECISION = buildTradeTestDecision();

const TRADE_TEST_GOAL = `
TRADE TEST — EXECUTE IMMEDIATELY.

You are running an automated ${EXECUTION_MODE}-mode trading validation test.
Your ONLY objective is to confirm that the full trading path works end-to-end, including opening AND closing a position.

On your VERY FIRST tick, take these actions in order:
1. Call list_positions to confirm your current position state.
2. If you are flat, call submit_decision with exactly these values:
  - instrumentId = "${TRADE_TEST_DECISION.instrumentId}"
  - intent = "go_long"
  - targetSize = "${TRADE_TEST_DECISION.targetSize}"
  - rationaleSummary = "trade-test open"
  - confidence = 0.95
3. Do not create a bot for this test.
4. Call schedule_reminder with:
  - message = "trade-test: close the open position now — call submit_decision with intent=go_flat, targetSize=0"
  - triggerAt = the current UTC time plus ${TICK_INTERVAL_MS} milliseconds, formatted as ISO 8601 (e.g. new Date(Date.now() + ${TICK_INTERVAL_MS}).toISOString())

On your SECOND tick (when the reminder fires), take these actions in order:
1. Call list_positions to confirm the position opened.
2. If you have an open position, call submit_decision with exactly these values:
  - instrumentId = "${TRADE_TEST_DECISION.instrumentId}"
  - intent = "go_flat"
  - targetSize = "0"
  - rationaleSummary = "trade-test close"
  - confidence = 0.95
3. Call list_positions again to confirm the position is now closed.

Do NOT wait for market signals. Do NOT evaluate the regime. Act immediately on every tick.
`.trim();

interface AgentBody {
  id: string;
  status: string;
  error?: string;
}

async function createAgent(token: string, connectionId: string): Promise<string> {
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
        // Required: sets maxOrderNotional; must cover BTC order notional (~$640 at current prices)
        capital: '100000',
        provider: LLM_PROVIDER,
        lightModel: LLM_LIGHT_MODEL,
        heavyModel: LLM_HEAVY_MODEL,
        // Required for live/shadow execution — see validateConnectionRequirement in agent-config-helpers.ts
        connectionIds: [connectionId],
      },
    },
  );

  if (res.status === 201 && res.body.id) {
    ok(`Agent created — id=${res.body.id}`);
    return res.body.id;
  }

  fatal(`Agent creation failed: ${res.status} ${JSON.stringify(res.body)}`);
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

async function verifyAgentProvisioned(token: string, agentId: string): Promise<void> {
  // Wait briefly for async provisioning to complete
  await sleep(2000);

  const verifyRes = await apiRequest<AgentBody>('GET', `/agents/${agentId}`, { token });
  if (verifyRes.status !== 200) {
    fatal(`Agent ${agentId} was created but is not queryable — status ${verifyRes.status}`);
  }
  if (verifyRes.body.status === 'unknown') {
    fatal(`Agent ${agentId} exists but has status 'unknown' — provisioning gap detected`);
  }
  ok(`Agent verified — id=${agentId} status=${verifyRes.body.status}`);
}

// ---------------------------------------------------------------------------
// Phase 3: Watch
// ---------------------------------------------------------------------------

interface AgentActivityFeedResponse {
  entries: AgentActivityEntry[];
  hasMore: boolean;
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

interface JournalEntry {
  id: string;
  actorId: string;
  actorType: string;
  eventType: string;
  createdAt: string;
}

interface JournalQueryResponse {
  events: JournalEntry[];
}

interface AgentPositionsResponse {
  agentId: string;
  family: 'trading';
  items: Array<{
    id: string;
    actorType: string;
    actorId: string;
    closedAt: string | null;
  }>;
  limit: number;
  offset: number;
}

type WatchOutcome = 'success' | 'timeout' | 'crashed' | 'silent_rejection' | 'rejected' | 'position_mismatch' | 'bookkeeping_failure';

// Tracks which activity entry IDs we have already printed so polling stays incremental.
const seenActivityIds = new Set<string>();

// Captured during Phase 3.6 so the bookkeeping audit can verify settlement.
let flatDecisionId: string | null = null;

async function fetchAgentActivityEntries(token: string, agentId: string, limit = 50): Promise<AgentActivityEntry[] | null> {
  const res = await apiRequest<AgentActivityFeedResponse>(
    'GET', `/agents/${agentId}/activity-feed?limit=${limit}`,
    { token },
  );
  if (res.status !== 200 || !Array.isArray(res.body.entries)) return null;
  return res.body.entries;
}

async function fetchAndPrintNewActivity(token: string, agentId: string): Promise<void> {
  const entries = await fetchAgentActivityEntries(token, agentId);
  if (entries === null) return;

  // The feed is newest-first — reverse to print chronologically.
  const orderedEntries = [...entries].reverse();
  for (const entry of orderedEntries) {
    if (seenActivityIds.has(entry.id)) continue;
    seenActivityIds.add(entry.id);
    const preview = entry.summary.slice(0, 120).replace(/\n/g, ' ');
    log(`  ${DIM}[${entry.eventType}]${RESET} ${preview}`);
  }
}

async function waitForListPositionsResult(
  token: string,
  agentId: string,
  notBeforeIso: string,
  timeoutMs = 30_000,
): Promise<AgentActivityEntry | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const entries = await fetchAgentActivityEntries(token, agentId, 100);
    if (entries !== null) {
      const match = selectListPositionsResult(entries, notBeforeIso);
      if (match) {
        return match;
      }
    }

    await sleep(3_000);
  }

  return null;
}

async function fetchDirectAgentJournalEvents(token: string, agentId: string): Promise<JournalEntry[] | null> {
  const query = new URLSearchParams({ actorId: agentId, limit: '20' });
  const res = await apiRequest<JournalQueryResponse>(
    'GET', `/journal?${query.toString()}`,
    { token },
  );
  if (res.status !== 200 || !Array.isArray(res.body.events)) {
    return null;
  }
  return res.body.events;
}

async function watchAgent(token: string, agentId: string): Promise<WatchOutcome> {
  section('Phase 3: Watching agent');
  log(`Timeout: ${TIMEOUT_MS / 1000}s  Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  const deadline = Date.now() + TIMEOUT_MS;
  let lastDecisionCount = 0;
  let decisionObservedAt: number | null = null;

  // After seeing a decision, wait up to this many ms for journal confirmation
  const JOURNAL_CONFIRM_WAIT_MS = 60_000;

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
          const dStatus = d.status ? ` status=${d.status}` : '';
          ok(`Decision recorded — id=${d.id} intent=${intent} instrument=${instrument}${details}${dStatus}`);

          // Fail immediately if decision was explicitly rejected
          if (d.status === 'rejected' || d.status === 'dropped') {
            warn(`Decision ${d.id} was ${d.status} — trading pipeline rejected it`);
            return 'rejected';
          }
        }
        lastDecisionCount = count;
        if (!decisionObservedAt) {
          decisionObservedAt = Date.now();
          log('Decision observed — waiting for journal/fill confirmation…');
        }
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

    // 5. If decision was observed, check for journal confirmation
    if (decisionObservedAt) {
      const agentJournalEvents = await fetchDirectAgentJournalEvents(token, agentId);
      if (agentJournalEvents !== null) {
        if (agentJournalEvents.length > 0) {
          ok(`Journal event confirmed — ${agentJournalEvents.length} event(s) for agent actor`);
          return 'success';
        }
      }

      // If we've waited long enough after decision and still no journal, it's a silent rejection
      if (Date.now() - decisionObservedAt > JOURNAL_CONFIRM_WAIT_MS) {
        warn('Decision was submitted but no journal event appeared — silent rejection detected');
        return 'silent_rejection';
      }
    }
  }

  return 'timeout';
}

// ---------------------------------------------------------------------------
// Phase 3.5: Post-trade assertions
// ---------------------------------------------------------------------------

async function runPostTradeAssertions(token: string, agentId: string, testStartedAt: string): Promise<WatchOutcome> {
  section('Phase 3.5: Post-trade assertions');

  // 1. Verify decisions exist and none are rejected
  const decisionsRes = await apiRequest<DecisionRow[]>(
    'GET', `/agents/${agentId}/decisions?limit=10`,
    { token },
  );
  if (decisionsRes.status === 200 && Array.isArray(decisionsRes.body)) {
    const rejected = decisionsRes.body.filter(d => d.status === 'rejected' || d.status === 'dropped');
    if (rejected.length > 0) {
      warn(`${rejected.length} decision(s) were rejected/dropped after initial success signal`);
      for (const d of rejected) {
        warn(`  Decision ${d.id} status=${d.status}`);
      }
      return 'rejected';
    }
    ok(`All ${decisionsRes.body.length} decision(s) have non-rejected status`);
  }

  // 2. Verify journal events exist for the agent
  const agentEvents = await fetchDirectAgentJournalEvents(token, agentId);
  if (agentEvents === null) {
    warn('Could not query direct agent journal events during post-trade assertions');
    return 'silent_rejection';
  }
  if (agentEvents.length > 0) {
    ok(`Journal has ${agentEvents.length} event(s) attributed to agent actor directly`);
  } else {
    warn('No direct agent journal events found — trade may not have been persisted');
    return 'silent_rejection';
  }

  // 3. Cross-check position visibility: system-level vs agent-visible
  const stateRes = await apiRequest<TradingState>(
    'GET', `/agents/${agentId}/capabilities/trading/state`,
    { token },
  );
  const positionsRes = await apiRequest<AgentPositionsResponse>(
    'GET', `/agents/${agentId}/capabilities/trading/positions`,
    { token },
  );

  if (stateRes.status !== 200) {
    warn(`Trading state check failed during post-trade assertions: ${stateRes.status}`);
    return 'silent_rejection';
  }

  if (positionsRes.status !== 200 || !Array.isArray(positionsRes.body.items)) {
    warn(`Trading positions check failed during post-trade assertions: ${positionsRes.status}`);
    return 'silent_rejection';
  }

  const openSystemPositions = positionsRes.body.items.filter((position) => position.closedAt === null);
  const systemPositionCount = openSystemPositions.length;
  const agentVisibleCount = stateRes.body.openPositionCount;

  if (systemPositionCount > 0) {
    // Check activity feed for any list_positions call since test start.
    // We use testStartedAt (not journal event timestamps) because journal events are
    // written async by the engine and can lag the activity feed entries, causing the
    // pre-decision list_positions call to be incorrectly excluded by a later anchor.
    const allEntries = await fetchAgentActivityEntries(token, agentId, 100);
    if (allEntries !== null) {
      const listPositionsEntry = selectListPositionsResult(allEntries, testStartedAt);
      if (!listPositionsEntry) {
        warn('list_positions was not called during this test run — tool may not be available');
        // Soft warning only: position visibility is already confirmed by the API-based check below
      } else {
        const payload = getToolResultPayload(listPositionsEntry);
        if (payload?.positionCount && payload.positionCount > 0) {
          ok(`list_positions confirmed open position visible to agent — positionCount=${payload.positionCount}`);
        } else {
          ok('list_positions was called and returned ok (position may not be visible to tool yet — tick 2 will confirm)');
        }
      }
    }
  }

  if (systemPositionCount > 0 && agentVisibleCount === 0) {
    warn(`POSITION MISMATCH: ${systemPositionCount} position(s) at system level, but agent sees 0`);
    for (const position of openSystemPositions.slice(0, 5)) {
      warn(`  Position: actorType=${position.actorType} actorId=${position.actorId}`);
    }
    return 'position_mismatch';
  }

  if (systemPositionCount > 0) {
    ok(`Position visibility consistent — system=${systemPositionCount} agent-visible=${agentVisibleCount}`);
  }

  return 'success';
}

// ---------------------------------------------------------------------------
// Phase 3.6: Wait for close
// ---------------------------------------------------------------------------

async function waitForClose(token: string, agentId: string): Promise<WatchOutcome> {
  section('Phase 3.6: Waiting for position close');
  log(`Timeout: ${TIMEOUT_MS / 1000}s  Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

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

    await fetchAndPrintNewActivity(token, agentId);

    // Check for a go_flat decision
    const decisionsRes = await apiRequest<DecisionRow[]>(
      'GET', `/agents/${agentId}/decisions?limit=20`,
      { token },
    );
    if (decisionsRes.status === 200 && Array.isArray(decisionsRes.body)) {
      const flatDecision = decisionsRes.body.find(d => d.intent === 'go_flat');
      if (flatDecision) {
        if (flatDecision.status === 'rejected' || flatDecision.status === 'dropped') {
          warn(`go_flat decision ${flatDecision.id} was ${flatDecision.status}`);
          return 'rejected';
        }
        ok(`go_flat decision recorded — id=${flatDecision.id} status=${flatDecision.status ?? 'no-plan-yet'}`);
        flatDecisionId = flatDecision.id;
      }
    }

    // Success when position count reaches zero
    const stateRes = await apiRequest<TradingState>(
      'GET', `/agents/${agentId}/capabilities/trading/state`,
      { token },
    );
    if (stateRes.status === 200 && stateRes.body.openPositionCount === 0) {
      ok('Position closed — openPositionCount=0');
      return 'success';
    }
  }

  return 'timeout';
}

// ---------------------------------------------------------------------------
// Phase 3.7: Bookkeeping audit
// ---------------------------------------------------------------------------

async function runBookkeepingAudit(
  token: string,
  agentId: string,
  testStartedAt: string,
): Promise<WatchOutcome> {
  section('Phase 3.7: Bookkeeping audit');

  // 1. Verify position record has closedAt set in DB (via positions API)
  const positionsRes = await apiRequest<AgentPositionsResponse>(
    'GET', `/agents/${agentId}/capabilities/trading/positions`,
    { token },
  );
  if (positionsRes.status !== 200 || !Array.isArray(positionsRes.body.items)) {
    warn('Could not query positions for bookkeeping audit');
    return 'bookkeeping_failure';
  }
  const closedPositions = positionsRes.body.items.filter(p => p.closedAt !== null);
  if (closedPositions.length === 0) {
    warn('No position record has closedAt set — DB was not updated after go_flat');
    return 'bookkeeping_failure';
  }
  ok(`Position marked closed in DB — closedAt=${closedPositions[0]?.closedAt ?? 'unknown'}`);

  // 2. Wait for go_flat decision to leave active execution state (up to 30 s)
  // null status means no execution plan was created — this is valid when the engine
  // found nothing to close (position already flat, or 0-order plan optimised away).
  // Only fail if the plan is explicitly stuck in 'pending' or 'executing'.
  if (flatDecisionId) {
    const deadline = Date.now() + 30_000;
    let settled = false;
    while (Date.now() < deadline) {
      const decisionsRes = await apiRequest<DecisionRow[]>(
        'GET', `/agents/${agentId}/decisions?limit=20`,
        { token },
      );
      if (decisionsRes.status === 200 && Array.isArray(decisionsRes.body)) {
        const flatDecision = decisionsRes.body.find(d => d.id === flatDecisionId);
        const s = flatDecision?.status ?? null;
        // null  → no plan row (0-order close, already flat) — valid
        // completed / failed → terminal — valid
        // pending / executing → still in flight — keep waiting
        if (s === null) {
          ok('go_flat decision settled — no execution plan needed (position was already flat or engine optimised to 0 orders)');
          settled = true;
          break;
        }
        if (s !== 'pending' && s !== 'executing') {
          ok(`go_flat decision settled — status=${s}`);
          settled = true;
          break;
        }
      }
      await sleep(3_000);
    }
    if (!settled) {
      warn(`go_flat decision ${flatDecisionId} is still pending/executing after 30s — execution engine may be stalled`);
      return 'bookkeeping_failure';
    }
  } else {
    warn('go_flat decision ID not captured — skipping decision settlement check');
  }

  // 3. Report journal event count after full open+close cycle
  const journalRes = await apiRequest<JournalQueryResponse>(
    'GET', `/journal?${new URLSearchParams({ actorId: agentId, limit: '50' }).toString()}`,
    { token },
  );
  if (journalRes.status === 200 && Array.isArray(journalRes.body.events)) {
    const count = journalRes.body.events.length;
    if (count > 5) {
      ok(`Journal event count after full open+close cycle: ${count}`);
    } else {
      warn(`Journal only has ${count} event(s) — close events may not have been persisted`);
    }
  }

  // 4. Scan worker logs for errors since test start
  try {
    const logErrors = execSync(
      `docker compose logs --since "${testStartedAt}" worker 2>&1 | grep -E 'ERROR|FATAL|uncaughtException' | head -10 || true`,
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 },
    ).trim();
    if (logErrors) {
      warn('Worker error log lines since test start:');
      for (const line of logErrors.split('\n')) {
        warn(`  ${line}`);
      }
    } else {
      ok('Worker logs: no ERROR/FATAL lines since test start');
    }
  } catch (err) {
    warn(`Worker log check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Check Redis for dangling agent reminders
  try {
    const reminderData = execSync(
      `docker compose exec -T redis redis-cli HGETALL "agent:reminders:${agentId}" 2>&1`,
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 },
    ).trim();
    if (!reminderData) {
      ok('Redis: agent reminder hash is empty — reminder was consumed');
    } else {
      warn(`Redis: agent:reminders:${agentId} is non-empty — reminder may not have been consumed: ${reminderData.slice(0, 200)}`);
    }
  } catch (err) {
    warn(`Redis reminder check skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  return 'success';
}

// ---------------------------------------------------------------------------
// Phase 4: Teardown
// ---------------------------------------------------------------------------

async function teardown(token: string, agentId: string, agentBotId: string | null): Promise<void> {
  section('Phase 4: Teardown');

  if (SKIP_TEARDOWN) {
    warn('SKIP_TEARDOWN=1 — leaving agent and bot running for manual inspection');
    warn(`  Agent ID: ${agentId}`);
    if (agentBotId) warn(`  Bot ID: ${agentBotId}`);
    return;
  }

  // Stop and delete the bot first (cleanup before agent deletion)
  if (agentBotId) {
    try {
      execSync(
        `docker compose exec -T postgres psql -U herobids -d herobids -c "DELETE FROM bots WHERE id = '${agentBotId}'"`,
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 },
      );
      ok(`Bot ${agentBotId} deleted`);
    } catch (err) {
      warn(`Bot cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
  const testStartedAt = new Date().toISOString();
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
  const connectionId = await createProviderLink(token);
  const agentId = await createAgent(token, connectionId);
  await verifyAgentProvisioned(token, agentId);
  await startAgent(token, agentId);
  ok(`Agent ${agentId} is starting`);

  // Phase 2.5: Agent bot creation
  let agentBotId: string | null = null;
  {
    section('Phase 2.5: Agent bot creation');

    // Wait for the agent runtime to subscribe to its Redis stream
    await sleep(5000);

    // Publish a manage_bot message to the agent's inbound Redis stream.
    // This exercises the exact broker path that was broken by the connectionId/venueAccountId confusion.

    // Build venue-aware bot config — swap venues (1inch) require swapAssets and cannot use paper mode.
    // Symbol must use BASE/QUOTE format for swap venues (validated by the broker's safety gate).
    const botSymbol = VENUE === '1inch' ? 'WETH/USDC' : 'BTC';
    const botConfig: Record<string, unknown> = {
      strategy: {
        type: 'momentum',
        decisionMode: 'mechanical',
        params: {
          lookbackPeriod: 14,
          entryThreshold: 0.5,
          exitThreshold: 0.3,
          adxThreshold: 20,
          momentumWindow: 7,
        },
      },
      symbol: botSymbol,
      execution: { mode: EXECUTION_MODE, slippageBps: 5 },
      risk: { stopLossPct: 3, takeProfitPct: 6, maxDrawdownPct: 5, maxPositionSizePct: 10 },
    };
    if (VENUE === '1inch') {
      botConfig['swapAssets'] = {
        baseAsset: 'WETH',
        quoteAsset: 'USDC',
        baseDecimals: 18,
        quoteDecimals: 6,
      };
    }

    const botCreatePayload = {
      action: 'create_and_start',
      connectionId,
      config: botConfig,
    };

    const envelope = {
      schemaVersion: 'v1',
      messageId: crypto.randomUUID(),
      correlationId: 'e2e-bot-creation',
      initiatorType: 'system',
      initiatorId: agentId,
      agentId,
      type: 'agent.manage_bot',
      createdAt: new Date().toISOString(),
      payload: botCreatePayload,
    };

    const envelopeJson = JSON.stringify(envelope).replace(/'/g, "'\\''");
    try {
      execSync(
        `docker compose exec -T redis redis-cli XADD 'agent:inbound:${agentId}' '*' envelope '${envelopeJson}'`,
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 },
      );
      ok('Manage-bot message published to agent inbound stream');
    } catch (err) {
      fatal(`Failed to publish to agent inbound stream: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Poll for the bot to appear in the bot list (created by the broker)
    const botDeadline = Date.now() + 30_000;
    let botFound = false;
    while (Date.now() < botDeadline) {
      await sleep(3_000);
      const botsRes = await apiRequest<{ bots?: Array<{ id: string; status: string; creatorType: string; creatorId: string }> }>(
        'GET', '/bots', { token },
      );
      if (botsRes.status === 200 && Array.isArray(botsRes.body.bots)) {
        const agentBots = botsRes.body.bots.filter((b) => b.creatorId === agentId);
        if (agentBots.length > 0) {
          agentBotId = agentBots[0].id;
          ok(`Bot created — id=${agentBotId} status=${agentBots[0].status}`);
          botFound = true;
          break;
        }
      }
    }

    if (!botFound) {
      fatal('Bot was not created within 30s — broker may have rejected the manage_bot message');
    }
  }

  // Phase 3
  let outcome = await watchAgent(token, agentId);

  // Phase 3.5: Post-trade assertions (cross-check consistency)
  if (outcome === 'success') {
    outcome = await runPostTradeAssertions(token, agentId, testStartedAt);
  }

  // Phase 3.6: Wait for agent to close the position
  if (outcome === 'success') {
    outcome = await waitForClose(token, agentId);
  }

  // Phase 3.7: Bookkeeping audit
  if (outcome === 'success') {
    outcome = await runBookkeepingAudit(token, agentId, testStartedAt);
  }

  // Phase 4
  await teardown(token, agentId, agentBotId);

  // Result
  console.log('');
  if (outcome === 'success') {
    console.log(`${BOLD}${GREEN}PASS${RESET} — agent opened and closed a position — full trade cycle confirmed.`);
  } else if (outcome === 'crashed') {
    console.log(`${BOLD}${RED}FAIL${RESET} — agent crashed. Check the activity feed above for the cause.`);
    process.exit(1);
  } else if (outcome === 'rejected') {
    console.log(`${BOLD}${RED}FAIL${RESET} — agent's decision was explicitly rejected by the trading pipeline.`);
    console.log('  Possible causes:');
    console.log('    · Agent not found in agents table (provisioning gap)');
    console.log('    · Agent status is paused/stopped');
    console.log('    · Risk gate rejected the decision');
    process.exit(1);
  } else if (outcome === 'silent_rejection') {
    console.log(`${BOLD}${RED}FAIL${RESET} — decision was submitted but no journal event appeared (silent rejection).`);
    console.log('  Possible causes:');
    console.log('    · Agent row missing from agents table — worker drops decision at gate');
    console.log('    · DecisionIntakeResolver cannot resolve execution context for agent actor');
    console.log('    · Position persisted with wrong actorType — invisible to queries');
    console.log('    · Worker crashed silently while processing the decision');
    process.exit(1);
  } else if (outcome === 'position_mismatch') {
    console.log(`${BOLD}${RED}FAIL${RESET} — position exists at system level but is invisible to the agent.`);
    console.log('  Possible causes:');
    console.log('    · list_positions only queries actorType=bot (missing agent positions)');
    console.log('    · Position persisted with incorrect actorId');
    process.exit(1);
  } else if (outcome === 'bookkeeping_failure') {
    console.log(`${BOLD}${RED}FAIL${RESET} — trade executed but post-trade bookkeeping checks failed.`);
    console.log('  Possible causes:');
    console.log('    · Position record not marked closed in DB (closedAt is null after go_flat)');
    console.log('    · go_flat execution plan stuck in pending/executing state (engine may be hung)');
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
