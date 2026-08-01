/**
 * cost-benchmark.ts — Compare LLM token usage across hybrid modes and reasoning levels.
 *
 * What it does
 * ────────────
 *  Creates multiple agents with different capabilityMode / hybridMode / reasoning
 *  level configs, runs them simultaneously for a fixed duration, then aggregates
 *  per-agent token usage from billing_usage_events (DB) and outputs a comparison table.
 *
 *  Token data is read directly from the billing_usage_events table because the
 *  activity feed's LLM_COMPLETED events do not store tokensUsed — they only carry
 *  phase, model, turnsUsed, and finishReason.
 *
 * Required env vars
 * ─────────────────
 *  API_BASE_URL          default http://localhost:3000
 *  TEST_EMAIL            default trade-test@local.test
 *  TEST_PASSWORD         default TradeTest123!
 *  DATABASE_URL          postgres://herobids:herobids@localhost:5432/herobids
 *
 * Optional env vars
 * ─────────────────
 *  LLM_PROVIDER          ollama (default)
 *  LLM_LIGHT_MODEL       qwen3:8b (default)
 *  LLM_HEAVY_MODEL       qwen3.6:35b-a3b-q4_K_M (default)
 *  TICK_INTERVAL_MS      30000 (default, 30s — faster for benchmarks)
 *  BENCHMARK_DURATION_MS 300000 (default, 5 minutes)
 *  SKIP_TEARDOWN         1 to leave agents running for manual inspection
 *
 * Usage
 * ─────
 *  tsx scripts/ts/cost-benchmark.ts
 *
 *  # Override duration and tick interval for longer runs
 *  BENCHMARK_DURATION_MS=600000 TICK_INTERVAL_MS=15000 tsx scripts/ts/cost-benchmark.ts
 */

import { createDatabase, closeDatabase, billingUsageEvents } from '@herobids/db';
import { eq, inArray, and, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE_URL = process.env['API_BASE_URL'] ?? 'http://localhost:3000';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://herobids:herobids@localhost:5432/herobids';
const TEST_EMAIL = process.env['TEST_EMAIL'] ?? 'trade-test@local.test';
const TEST_PASSWORD = process.env['TEST_PASSWORD'] ?? 'TradeTest123!';
const LLM_PROVIDER = process.env['LLM_PROVIDER'] ?? 'ollama';
const LLM_LIGHT_MODEL = process.env['LLM_LIGHT_MODEL'] ?? 'qwen3:8b';
const LLM_HEAVY_MODEL = process.env['LLM_HEAVY_MODEL'] ?? 'qwen3.6:35b-a3b-q4_K_M';
const TICK_INTERVAL_MS = parseInt(process.env['TICK_INTERVAL_MS'] ?? '30000', 10);
const BENCHMARK_DURATION_MS = parseInt(process.env['BENCHMARK_DURATION_MS'] ?? '480000', 10); // default 8 min (first tick ~60-90s, need multiple ticks per agent)
const SKIP_TEARDOWN = process.env['SKIP_TEARDOWN'] === '1';
const POLL_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// Test matrix
// ---------------------------------------------------------------------------

interface BenchmarkCase {
  id: string;
  capabilityMode: 'intelligence' | 'hybrid';
  hybridMode?: 'mixed' | 'scanner_gated';
  scoutReasoning?: 'none' | 'low' | 'medium' | 'high';
  judgeReasoning?: 'none' | 'low' | 'medium' | 'high';
  label: string;
}

const BENCHMARK_CASES: BenchmarkCase[] = [
  // ── scanner_gated cost comparison (low reasoning) ──
  {
    id: 'intel-low',
    capabilityMode: 'intelligence',
    scoutReasoning: 'low',
    judgeReasoning: 'low',
    label: 'Intelligence (low reasoning)',
  },
  {
    id: 'sg-low',
    capabilityMode: 'hybrid',
    hybridMode: 'scanner_gated',
    scoutReasoning: 'low',
    judgeReasoning: 'low',
    label: 'Scanner-Gated (low reasoning)',
  },

  // ── reasoning level cost ladder (intelligence) ──
  // Note: 'high' is omitted — operator ceiling in local config caps at 'medium'.
  {
    id: 'intel-none',
    capabilityMode: 'intelligence',
    scoutReasoning: 'none',
    judgeReasoning: 'none',
    label: 'Intelligence (no reasoning)',
  },
  {
    id: 'intel-medium',
    capabilityMode: 'intelligence',
    scoutReasoning: 'medium',
    judgeReasoning: 'medium',
    label: 'Intelligence (medium reasoning)',
  },

  // ── reasoning level cost ladder (scanner_gated) ──
  {
    id: 'sg-none',
    capabilityMode: 'hybrid',
    hybridMode: 'scanner_gated',
    scoutReasoning: 'none',
    judgeReasoning: 'none',
    label: 'Scanner-Gated (no reasoning)',
  },
  {
    id: 'sg-medium',
    capabilityMode: 'hybrid',
    hybridMode: 'scanner_gated',
    scoutReasoning: 'medium',
    judgeReasoning: 'medium',
    label: 'Scanner-Gated (medium reasoning)',
  },
];

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

interface AgentActivityEntry {
  id: string;
  timestamp: string;
  eventType: string;
  summary: string;
  detail: Record<string, unknown>;
}

interface AgentActivityFeedResponse {
  entries: AgentActivityEntry[];
  hasMore: boolean;
}

interface BenchmarkResult {
  caseId: string;
  label: string;
  capabilityMode: string;
  hybridMode?: string;
  scoutReasoning: string;
  judgeReasoning: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalTokens: number;
  llmCallCount: number;
  tickCount: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fatal(msg: string): never {
  console.error(`\n❌ FATAL: ${msg}`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}

function info(msg: string): void {
  console.log(`  ℹ️  ${msg}`);
}

function section(title: string): void {
  console.log(`\n━━━ ${title} ━━━`);
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

async function login(): Promise<string> {
  const res = await apiRequest<{ token?: string; error?: string }>(
    'POST', '/auth/login',
    { body: { email: TEST_EMAIL, password: TEST_PASSWORD } },
  );
  if (res.status === 200 && res.body.token) {
    return res.body.token;
  }
  // Try register
  const regRes = await apiRequest<{ token?: string; error?: string }>(
    'POST', '/auth/register',
    { body: { email: TEST_EMAIL, password: TEST_PASSWORD, name: 'Benchmark User' } },
  );
  if (regRes.body.token) {
    return regRes.body.token;
  }
  fatal(`Auth failed: ${JSON.stringify(regRes.body)}`);
}

// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------

const BENCHMARK_GOAL = 'You are a market analyst. Monitor the market and provide observations. Do NOT submit trading decisions.';

async function createBenchmarkAgent(token: string, bc: BenchmarkCase): Promise<string> {
  const payload: Record<string, unknown> = {
    name: `bench-${bc.id}`,
    prompt: BENCHMARK_GOAL,
    // 'trading' skill required to run ticks; executionDefaults.mode: 'paper' keeps it safe
    skillIds: ['trading'],
    executionDefaults: { mode: 'paper' },
    tickIntervalMs: TICK_INTERVAL_MS,
    capital: '10000',
    provider: LLM_PROVIDER,
    lightModel: LLM_LIGHT_MODEL,
    heavyModel: LLM_HEAVY_MODEL,
    capabilityMode: bc.capabilityMode,
    ...(bc.hybridMode ? { hybridMode: bc.hybridMode } : {}),
    // scanner_gated agents need minimal technical config (API requires it for hybrid mode)
    ...(bc.capabilityMode === 'hybrid' ? {
      technical: { filters: { venue: 'hyperliquid', venueType: 'orderbook' } },
    } : {}),
    runtimePolicyOverrides: {
      scoutReasoning: bc.scoutReasoning ?? 'low',
      judgeReasoning: bc.judgeReasoning ?? 'low',
    },
  };

  const res = await apiRequest<AgentBody>('POST', '/agents', { token, body: payload });

  if (res.status === 201 && res.body.id) {
    return res.body.id;
  }

  fatal(`Agent creation failed for ${bc.id}: ${res.status} ${JSON.stringify(res.body)}`);
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
  console.warn(`  ⚠️  Stop returned ${res.status} for ${agentId} — may already be stopped`);
}

async function deleteAgent(token: string, agentId: string): Promise<void> {
  await apiRequest('DELETE', `/agents/${agentId}`, { token });
}

// ---------------------------------------------------------------------------
// Token aggregation from billing_usage_events (DB)
// ---------------------------------------------------------------------------

async function fetchActivityFeed(
  token: string, agentId: string, limit = 200,
): Promise<AgentActivityEntry[]> {
  const res = await apiRequest<AgentActivityFeedResponse>(
    'GET', `/agents/${agentId}/activity-feed?limit=${limit}`, { token },
  );
  if (res.status !== 200) return [];
  return res.body.entries ?? [];
}

/**
 * Aggregate token usage for an agent directly from billing_usage_events.
 * The activity feed's LLM_COMPLETED events don't include tokensUsed —
 * only the billing table has real token counts.
 */
async function aggregateAgentTokensFromDb(
  db: ReturnType<typeof createDatabase>,
  agentId: string,
  token: string,
): Promise<{ totalInput: number; totalOutput: number; totalThinking: number; totalTokens: number; llmCallCount: number; tickCount: number }> {
  // Token counts from billing events
  const meterRows = await db
    .select({
      meterKey: billingUsageEvents.meterKey,
      total: sql<number>`cast(sum(${billingUsageEvents.quantity}) as int)`,
    })
    .from(billingUsageEvents)
    .where(
      and(
        eq(billingUsageEvents.agentId, agentId),
        inArray(billingUsageEvents.meterKey, ['llm.input_tokens', 'llm.output_tokens', 'llm.reasoning_tokens']),
      ),
    )
    .groupBy(billingUsageEvents.meterKey);

  let totalInput = 0;
  let totalOutput = 0;
  let totalThinking = 0;
  for (const row of meterRows) {
    if (row.meterKey === 'llm.input_tokens') totalInput = row.total ?? 0;
    if (row.meterKey === 'llm.output_tokens') totalOutput = row.total ?? 0;
    if (row.meterKey === 'llm.reasoning_tokens') totalThinking = row.total ?? 0;
  }

  // LLM call count: distinct idempotency keys with sourceType = 'llm_call'
  const [callRow] = await db
    .select({ count: sql<number>`cast(count(distinct ${billingUsageEvents.idempotencyKey}) as int)` })
    .from(billingUsageEvents)
    .where(and(
      eq(billingUsageEvents.agentId, agentId),
      eq(billingUsageEvents.sourceType, 'llm_call'),
    ));

  // Tick count from activity feed (tick.started / tick.skipped)
  const entries = await fetchActivityFeed(token, agentId);
  const tickCount = entries.filter(
    (e) => e.eventType === 'tick.started' || e.eventType === 'tick.skipped',
  ).length;

  return {
    totalInput,
    totalOutput,
    totalThinking,
    totalTokens: totalInput + totalOutput + totalThinking,
    llmCallCount: callRow?.count ?? 0,
    tickCount,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printResults(results: BenchmarkResult[]): void {
  console.log('\n╔══════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                         COST BENCHMARK RESULTS                                      ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════════╣');

  // Header
  const headerFmt = '║ %-35s │ %6s │ %7s │ %7s │ %7s │ %7s │ %4s ║';
  console.log(sprintf(headerFmt, 'Configuration', 'Ticks', 'LLM #', 'Input', 'Output', 'Think', 'Total'));
  console.log('╠═════════════════════════════════════════╪════════╪═════════╪═════════╪═════════╪═════════╪══════╣');

  for (const r of results) {
    if (r.error) {
      console.log(`║ ${r.label.padEnd(39)} │ ${'ERROR'.padStart(6)} │ ${r.error.slice(0, 40).padEnd(7)} ${' '.repeat(38)}║`);
      continue;
    }
    console.log(sprintf(
      '║ %-35s │ %6d │ %7d │ %7d │ %7d │ %7d │ %4d ║',
      r.label,
      r.tickCount,
      r.llmCallCount,
      r.totalInputTokens,
      r.totalOutputTokens,
      r.totalThinkingTokens,
      r.totalTokens,
    ));
  }

  console.log('╚═════════════════════════════════════════╧════════╧═════════╧═════════╧═════════╧═════════╧══════╝');

  // ── Comparison summaries ──

  const intelLow = results.find((r) => r.caseId === 'intel-low');
  const sgLow = results.find((r) => r.caseId === 'sg-low');

  if (intelLow && sgLow && !intelLow.error && !sgLow.error) {
    const reduction = intelLow.totalTokens > 0
      ? ((1 - sgLow.totalTokens / intelLow.totalTokens) * 100).toFixed(1)
      : 'N/A';
    console.log(`\n📊 scanner_gated vs intelligence (low reasoning):`);
    console.log(`   Intelligence:     ${intelLow.totalTokens.toLocaleString()} tokens`);
    console.log(`   Scanner-Gated:    ${sgLow.totalTokens.toLocaleString()} tokens`);
    console.log(`   Token reduction:  ${reduction}%`);
  }

  // ── Reasoning level ladder (intelligence) ──
  console.log(`\n📊 Reasoning level cost ladder (intelligence):`);
  for (const r of results.filter((r) => r.capabilityMode === 'intelligence' && !r.error)) {
    console.log(`   ${r.scoutReasoning.padEnd(6)} → ${r.totalTokens.toLocaleString()} tokens (${r.llmCallCount} LLM calls)`);
  }

  // ── Reasoning level ladder (scanner_gated) ──
  console.log(`\n📊 Reasoning level cost ladder (scanner_gated):`);
  for (const r of results.filter((r) => r.hybridMode === 'scanner_gated' && !r.error)) {
    console.log(`   ${r.scoutReasoning.padEnd(6)} → ${r.totalTokens.toLocaleString()} tokens (${r.llmCallCount} LLM calls)`);
  }
}

// Minimal sprintf-like padding
function sprintf(fmt: string, ...args: (string | number)[]): string {
  let result = fmt;
  for (const arg of args) {
    result = result.replace(/%[-]?\d+[sd]/, String(arg));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('🚀 Cost Benchmark');
  console.log(`   API:       ${API_BASE_URL}`);
  console.log(`   DB:        ${DATABASE_URL.replace(/\/\/[^@]+@/, '//***@')}`);
  console.log(`   Provider:  ${LLM_PROVIDER} / ${LLM_LIGHT_MODEL} / ${LLM_HEAVY_MODEL}`);
  console.log(`   Tick:      ${TICK_INTERVAL_MS}ms`);
  console.log(`   Duration:  ${(BENCHMARK_DURATION_MS / 60_000).toFixed(1)} min (first tick ~60-90s due to Forex Factory timeout; multiple ticks per agent needed)`);
  console.log(`   Cases:     ${BENCHMARK_CASES.length}`);

  // ── Open DB connection ──
  const db = createDatabase(DATABASE_URL);

  // ── Auth ──
  section('Authentication');

  // Pre-flight: check API is reachable
  try {
    const health = await fetch(`${API_BASE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) fatal(`API returned ${health.status} — is the stack running? Try: docker compose up -d`);
  } catch {
    fatal(`API unreachable at ${API_BASE_URL} — is the stack running? Try: docker compose up -d`);
  }

  const token = await login();
  ok('Authenticated');

  // ── Create agents ──
  section(`Creating ${BENCHMARK_CASES.length} benchmark agents`);

  const created: Array<{ bc: BenchmarkCase; agentId: string }> = [];
  for (const bc of BENCHMARK_CASES) {
    info(`Creating ${bc.id} (${bc.label})...`);
    const agentId = await createBenchmarkAgent(token, bc);
    created.push({ bc, agentId });
    ok(`${bc.id} → ${agentId}`);
  }

  // ── Start all agents simultaneously ──
  section('Starting agents');
  const startTime = Date.now();
  for (const { agentId } of created) {
    await startAgent(token, agentId);
  }
  ok(`All ${created.length} agents started at ${new Date(startTime).toISOString()}`);

  // ── Wait for benchmark duration ──
  section(`Running for ${(BENCHMARK_DURATION_MS / 60_000).toFixed(1)} minutes...`);
  const deadline = Date.now() + BENCHMARK_DURATION_MS;

  while (Date.now() < deadline) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    process.stdout.write(`\r  ⏳ ${remaining}s remaining...`);
    await sleep(Math.min(POLL_INTERVAL_MS, remaining * 1000));
  }
  console.log(''); // newline after progress

  // ── Stop all agents ──
  section('Stopping agents');
  for (const { agentId } of created) {
    await stopAgent(token, agentId);
  }
  ok('All agents stopped');

  // ── Give activity feed a moment to flush (ticks can take up to 60s) ──
  await sleep(15000);

  // ── Aggregate results ──
  section('Aggregating token usage');
  const results: BenchmarkResult[] = [];

  for (const { bc, agentId } of created) {
    info(`Querying ${bc.id}...`);
    try {
      const tokens = await aggregateAgentTokensFromDb(db, agentId, token);
      results.push({
        caseId: bc.id,
        label: bc.label,
        capabilityMode: bc.capabilityMode,
        hybridMode: bc.hybridMode,
        scoutReasoning: bc.scoutReasoning ?? 'low',
        judgeReasoning: bc.judgeReasoning ?? 'low',
        totalInputTokens: tokens.totalInput,
        totalOutputTokens: tokens.totalOutput,
        totalThinkingTokens: tokens.totalThinking,
        totalTokens: tokens.totalTokens,
        llmCallCount: tokens.llmCallCount,
        tickCount: tokens.tickCount,
      });
      ok(`${bc.id}: ${tokens.totalTokens.toLocaleString()} tokens, ${tokens.llmCallCount} LLM calls, ${tokens.tickCount} ticks`);
    } catch (err) {
      results.push({
        caseId: bc.id,
        label: bc.label,
        capabilityMode: bc.capabilityMode,
        hybridMode: bc.hybridMode,
        scoutReasoning: bc.scoutReasoning ?? 'low',
        judgeReasoning: bc.judgeReasoning ?? 'low',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalThinkingTokens: 0,
        totalTokens: 0,
        llmCallCount: 0,
        tickCount: 0,
        error: String(err),
      });
      console.warn(`  ⚠️  ${bc.id}: error — ${String(err)}`);
    }
  }

  // ── Print results ──
  printResults(results);

  // ── Teardown ──
  if (!SKIP_TEARDOWN) {
    section('Cleaning up');
    for (const { agentId } of created) {
      await deleteAgent(token, agentId);
    }
    ok('All agents deleted');
  } else {
    info('SKIP_TEARDOWN=1 — agents left running for manual inspection');
  }

  console.log('\n✅ Benchmark complete.\n');
  await closeDatabase(db);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
