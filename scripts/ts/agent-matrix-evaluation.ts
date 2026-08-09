/**
 * agent-matrix-evaluation.ts — Create agents for each matrix case, run them,
 * then stop them for evaluation.
 *
 * Matrix:
 *   - scanner_gated vs pure intelligence
 *
 * What it does
 * ────────────
 *  1. Creates an agent for each matrix case.
 *  2. Starts all agents simultaneously.
 *  3. Waits for the configured duration.
 *  4. Stops all agents.
 *  5. Prints agent IDs ready for evaluation via download-eval-reports.sh.
 *
 * Prerequisites
 * ─────────────
 *  - Stack running (docker compose up -d)
 *  - Venue credentials set up (provider-link) if using shadow/live modes
 *  - Admin user for shadow mode (see EXECUTION_MODE note below)
 *
 * Required env vars
 * ─────────────────
 *  API_BASE_URL          default http://localhost:3000
 *  TEST_EMAIL            default trade-test@local.test
 *  TEST_PASSWORD         default TradeTest123!
 *
 * Optional env vars
 * ─────────────────
 *  LLM_PROVIDER          ollama (default)
 *  LLM_HEAVY_MODEL       qwen3.6:35b-a3b-q4_K_M (default)
 *  EXECUTION_MODE        shadow (default) — 'paper', 'shadow', or 'live'
 *                         NOTE: shadow mode requires admin auth.
 *                         Set ADMIN_EMAIL / ADMIN_PASSWORD for shadow.
 *  EVAL_DURATION_MIN     60 (default) — how long to run agents before stopping
 *  TICK_INTERVAL_MS      30000 (default, 30s)
 *  SKIP_TEARDOWN         1 to leave agents running (skip stop)
 *
 * Usage
 * ─────
 *  tsx scripts/ts/agent-matrix-evaluation.ts
 *
 *  # Override duration and mode
 *  EVAL_DURATION_MIN=120 EXECUTION_MODE=paper tsx scripts/ts/agent-matrix-evaluation.ts
 */

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
const ADMIN_EMAIL = process.env['ADMIN_EMAIL'] ?? 'admin@herobids.local';
const ADMIN_PASSWORD = process.env['ADMIN_PASSWORD'] ?? 'AdminTest123!';
const LLM_PROVIDER = process.env['LLM_PROVIDER'] ?? 'ollama';
const LLM_HEAVY_MODEL = process.env['LLM_HEAVY_MODEL'] ?? 'qwen3.6:35b-a3b-q4_K_M';
const EXECUTION_MODE = process.env['EXECUTION_MODE'] ?? 'shadow';
const EVAL_DURATION_MIN = parseInt(process.env['EVAL_DURATION_MIN'] ?? '60', 10);
const TICK_INTERVAL_MS = parseInt(process.env['TICK_INTERVAL_MS'] ?? '30000', 10);
const SKIP_TEARDOWN = process.env['SKIP_TEARDOWN'] === '1';
const POLL_INTERVAL_MS = 10_000;

// Fixed parameters across all agents
const SCOUT_REASONING = 'medium';
const JUDGE_REASONING = 'high';
const ADAPT_SCOUT_REASONING = false;
const ADAPT_JUDGE_REASONING = false;
const CAPITAL = '1000';
const STYLE = 'balanced';

// Shared agent goal — neutral enough to work for both intelligence and scanner_gated modes.
const AGENT_GOAL = 'Grow this portfolio aggressively';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

interface AgentBody {
  id: string;
  status?: string;
  error?: string;
}

interface SkillBody {
  id: string;
  name: string;
  error?: string;
}

interface SkillListResponse {
  skills: Array<{ id: string; name: string }>;
}

interface TradingConnection {
  connectionId: string;
  label: string;
  provider: string;
}

interface TradingConnectionsResponse {
  connections: TradingConnection[];
}

// ---------------------------------------------------------------------------
// Matrix definition
// ---------------------------------------------------------------------------

interface MatrixCase {
  id: string;
  name: string;
  capabilityMode: 'intelligence' | 'hybrid';
  hybridMode?: 'scanner_gated';
  description: string;
}

const MATRIX_CASES: MatrixCase[] = [
  {
    id: 'a-pure-intel',
    name: 'A - Pure Intel',
    capabilityMode: 'intelligence',
    description: 'Pure intelligence (LLM-only) — baseline',
  },
  {
    id: 'b-scanner-gated',
    name: 'B - Scanner-Gated',
    capabilityMode: 'hybrid',
    hybridMode: 'scanner_gated',
    description: 'Scanner-gated hybrid — cost baseline',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function fatal(msg: string): never {
  console.error(`${RED}✗ FATAL: ${msg}${RESET}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

function info(msg: string): void {
  console.log(`  ${CYAN}ℹ${RESET}  ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ${YELLOW}⚠${RESET}  ${msg}`);
}

function section(title: string): void {
  console.log(`\n${BOLD}${CYAN}── ${title} ──${RESET}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
// Auth
// ---------------------------------------------------------------------------

async function authenticate(): Promise<string> {
  const email = EXECUTION_MODE === 'shadow' ? ADMIN_EMAIL : TEST_EMAIL;
  const password = EXECUTION_MODE === 'shadow' ? ADMIN_PASSWORD : TEST_PASSWORD;

  const loginRes = await apiRequest<{ token?: string; error?: string }>(
    'POST', '/auth/login',
    { body: { email, password } },
  );
  if (loginRes.status === 200 && loginRes.body.token) {
    ok(`Logged in as ${email}`);
    return loginRes.body.token;
  }

  // Register
  const regRes = await apiRequest<{ token?: string; error?: string }>(
    'POST', '/auth/register',
    { body: { email, password, displayName: EXECUTION_MODE === 'shadow' ? 'Admin' : 'Matrix Eval' } },
  );
  if (regRes.status === 201 && regRes.body.token) {
    ok(`Registered and logged in as ${email}`);
    if (EXECUTION_MODE === 'shadow') {
      warn('Shadow mode: newly registered user may not be admin. Use an existing admin account or seed the admin user first.');
    }
    return regRes.body.token;
  }

  fatal(`Auth failed: login=${loginRes.status} register=${regRes.status} ${JSON.stringify(regRes.body)}`);
}

// ---------------------------------------------------------------------------
// Trading connection lookup
// ---------------------------------------------------------------------------

async function fetchTradingConnectionId(token: string): Promise<string> {
  const res = await apiRequest<TradingConnectionsResponse>(
    'GET', '/capabilities/trading/connections', { token },
  );

  if (res.status !== 200) {
    fatal(`Failed to list trading connections: ${res.status} ${JSON.stringify(res.body)}`);
  }

  const connections = res.body.connections ?? [];
  if (connections.length === 0) {
    fatal(
      'No trading connections found.\n' +
      '  Run quick-setup.sh first to provision venue credentials, or set EXECUTION_MODE=paper.',
    );
  }

  // Prefer Hyperliquid, fall back to first available
  const hyperliquid = connections.find(
    (c) => c.provider === 'hyperliquid' || c.label === 'Hyperliquid',
  );
  const chosen = hyperliquid ?? connections[0]!;

  ok(`Trading connection: ${chosen.label} (${chosen.provider}) → ${chosen.connectionId}`);
  return chosen.connectionId;
}

// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------

async function createAgent(
  token: string,
  mc: MatrixCase,
  connectionId: string,
): Promise<string> {
  const skillIds = ['trading'];
  }

  const payload: Record<string, unknown> = {
    name: mc.name,
    prompt: AGENT_GOAL,
    skillIds,
    connectionIds: [connectionId],
    executionDefaults: { mode: EXECUTION_MODE },
    tickIntervalMs: TICK_INTERVAL_MS,
    capital: CAPITAL,
    style: STYLE,
    provider: LLM_PROVIDER,
    lightModel: LLM_HEAVY_MODEL,  // scout model (same as heavy per spec)
    heavyModel: LLM_HEAVY_MODEL,   // judge model
    capabilityMode: mc.capabilityMode,
    ...(mc.hybridMode ? { hybridMode: mc.hybridMode } : {}),
    ...(mc.capabilityMode === 'hybrid' ? {
      technical: { filters: { venue: 'hyperliquid', venueType: 'orderbook' } },
    } : {}),
    runtimePolicyOverrides: {
      scoutReasoning: SCOUT_REASONING,
      judgeReasoning: JUDGE_REASONING,
      adaptScoutReasoning: ADAPT_SCOUT_REASONING,
      adaptJudgeReasoning: ADAPT_JUDGE_REASONING,
    },
  };

  const res = await apiRequest<AgentBody>('POST', '/agents', { token, body: payload });

  if (res.status === 201 && res.body.id) {
    return res.body.id;
  }

  fatal(`Agent creation failed for ${mc.id}: ${res.status} ${JSON.stringify(res.body)}`);
}

async function startAgent(token: string, agentId: string): Promise<void> {
  const res = await apiRequest<{ status?: string; error?: string }>(
    'POST', `/agents/${agentId}/start`, { token },
  );
  if (res.status === 202) {
    return;
  }
  fatal(`Agent start failed for ${agentId}: ${res.status} ${JSON.stringify(res.body)}`);
}

async function stopAgent(token: string, agentId: string): Promise<void> {
  const res = await apiRequest<{ status?: string; error?: string }>(
    'POST', `/agents/${agentId}/stop`, { token },
  );
  if (res.status === 202 || res.status === 200) {
    return;
  }
  warn(`Stop returned ${res.status} for ${agentId} — may already be stopped`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const durationMs = EVAL_DURATION_MIN * 60_000;

  console.log(`${BOLD}🧪 Agent Matrix Evaluation${RESET}`);
  console.log(`${DIM}   Mode: ${EXECUTION_MODE} | Provider: ${LLM_PROVIDER} | Heavy model: ${LLM_HEAVY_MODEL}${RESET}`);
  console.log(`${DIM}   Scout reasoning: ${SCOUT_REASONING} | Judge reasoning: ${JUDGE_REASONING} | Adaptive: OFF${RESET}`);
  console.log(`${DIM}   Capital: $${CAPITAL} | Tick: ${TICK_INTERVAL_MS}ms | Style: ${STYLE} | Duration: ${EVAL_DURATION_MIN}min${RESET}`);

  // ── Pre-flight ──
  section('Pre-flight');
  try {
    const health = await fetch(`${API_BASE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) fatal(`API returned ${health.status} — is the stack running?`);
    ok(`API healthy at ${API_BASE_URL}`);
  } catch {
    fatal(`API unreachable at ${API_BASE_URL} — start the stack: docker compose up -d`);
  }

  // ── Auth ──
  section('Authentication');
  const token = await authenticate();

  // ── Fetch trading connection ──
  section('Trading connection');
  const connectionId = await fetchTradingConnectionId(token);

  // ── Create agents ──
  section(`Creating ${MATRIX_CASES.length} matrix agents`);

  const created: Array<{ mc: MatrixCase; agentId: string }> = [];
  for (const mc of MATRIX_CASES) {
    info(`Creating ${mc.id}...`);
    const agentId = await createAgent(token, mc, connectionId);
    created.push({ mc, agentId });
    ok(`${mc.id} → ${agentId} (bound to ${connectionId.slice(0, 8)}…)`);
  }

  // ── Start agents ──
  section('Starting agents');
  const startTime = Date.now();
  for (const { agentId } of created) {
    await startAgent(token, agentId);
  }
  ok(`All ${created.length} agents started at ${new Date(startTime).toISOString()}`);

  // ── Wait for evaluation duration ──
  const durationLabel = EVAL_DURATION_MIN >= 60
    ? `${(EVAL_DURATION_MIN / 60).toFixed(1)}h`
    : `${EVAL_DURATION_MIN}m`;
  section(`Running for ${durationLabel}...`);
  const deadline = Date.now() + durationMs;

  while (Date.now() < deadline) {
    const remainingSec = Math.ceil((deadline - Date.now()) / 1000);
    const remainingMin = Math.floor(remainingSec / 60);
    const remSec = remainingSec % 60;
    process.stdout.write(`\r  ⏳ ${remainingMin}m ${remSec}s remaining...`);
    await sleep(Math.min(POLL_INTERVAL_MS, remainingSec * 1000));
  }
  console.log(''); // newline after progress

  // ── Stop agents ──
  if (SKIP_TEARDOWN) {
    section('Skipping agent stop (SKIP_TEARDOWN=1)');
  } else {
    section('Stopping agents');
    for (const { agentId } of created) {
      await stopAgent(token, agentId);
    }
    ok('All agents stopped');
  }

  // ── Summary ──
  section('Agent Matrix Summary');
  console.log('');
  console.log('┌──────┬──────────────────────────────────┬──────────────────┬──────────┐');
  console.log('│ Cell │ Name                             │ Mode             │ Agent ID │');
  console.log('├──────┼──────────────────────────────────┼──────────────────┼──────────┤');
  for (const { mc, agentId } of created) {
    const mode = mc.hybridMode
      ? `${mc.capabilityMode}/${mc.hybridMode}`
      : mc.capabilityMode;
    const shortId = agentId.slice(0, 8);
    console.log(`│  ${mc.id[0]?.toUpperCase() ?? '?'}   │ ${mc.name.padEnd(32)} │ ${mode.padEnd(16)} │ ${shortId} │`);
  }
  console.log('└──────┴──────────────────────────────────┴──────────────────┴──────────┘');

  // ── Per-agent variable breakdown ──
  section('Per-Agent Variable Breakdown');
  console.log('');

  for (const { mc, agentId } of created) {
    console.log(`${BOLD}${mc.id.toUpperCase()} — ${mc.name}${RESET}`);
    console.log(`${DIM}  Description: ${mc.description}${RESET}`);
    console.log(`  Agent ID:            ${agentId}`);
    console.log(`  capabilityMode:      ${mc.capabilityMode}`);
    console.log(`  hybridMode:          ${mc.hybridMode ?? '(n/a — intelligence mode)'}`);
    console.log(`  Skill IDs attached:  trading`);
    console.log(`  ─── Fixed across all agents ───`);
    console.log(`  executionDefaults.mode: ${EXECUTION_MODE}`);
    console.log(`  capital:             $${CAPITAL}`);
    console.log(`  style:               ${STYLE}`);
    console.log(`  provider:            ${LLM_PROVIDER}`);
    console.log(`  scout model:         ${LLM_HEAVY_MODEL}`);
    console.log(`  scout reasoning:     ${SCOUT_REASONING}`);
    console.log(`  judge model:         ${LLM_HEAVY_MODEL}`);
    console.log(`  judge reasoning:     ${JUDGE_REASONING}`);
    console.log(`  adaptScoutReasoning: ${ADAPT_SCOUT_REASONING}`);
    console.log(`  adaptJudgeReasoning: ${ADAPT_JUDGE_REASONING}`);
    console.log(`  tickIntervalMs:      ${TICK_INTERVAL_MS}`);
    console.log(`  technical config:    ${mc.capabilityMode === 'hybrid' ? '{ filters: { venue: "hyperliquid", venueType: "orderbook" } }' : '(none — intelligence mode)'}`);
    console.log('');
  }

  // ── Evaluation instructions ──
  section('Evaluation Comparisons');
  console.log('');
  console.log('  A vs B  → scanner_gated cost/behavior delta');
  console.log('');

  if (!SKIP_TEARDOWN) {
    console.log(`${BOLD}Ready for evaluation.${RESET} Run:`);
    console.log(`  ${CYAN}HEROBIDS_ENV=dev scripts/shell/ops/download-eval-reports.sh${RESET}`);
    console.log('');
  } else {
    console.log(`${YELLOW}Agents still running (SKIP_TEARDOWN=1). Stop them manually before evaluating.${RESET}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error(`${RED}Unhandled error:${RESET}`, err);
  process.exit(1);
});
