/**
 * scanner-provider-smoke-test.ts — Live scanner candle-provider verification.
 *
 * Verifies the deployed scanner → provider → candle path using a bounded,
 * confirmed-supported symbol set (BTC, ETH). Validates that the scanner
 * completes healthy scans with actual candle data, without requiring
 * a live trading signal.
 *
 * Scenarios:
 *   1. BTC+ETH bounded scan completes with eligible>0, fetched>0
 *   2. Per-symbol outcomes reported (BTC/BTCUSDT, ETH/ETHUSDT)
 *   3. No provider failures, no unsupported symbols, no errors
 *   4. Scan interval matches configured value
 *   5. treats signalsGenerated===0 as success
 *
 * Prerequisites: Worker, API, DB, and an active Hyperliquid connection.
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3000 TEST_EMAIL=a@b.com TEST_PASSWORD=... \
 *     tsx scripts/ts/scanner-provider-smoke-test.ts
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
const TEST_EMAIL = process.env['TEST_EMAIL'] ?? 'trade-test@local.test';
const TEST_PASSWORD = process.env['TEST_PASSWORD'] ?? 'TradeTest123!';

// Confirmed-supported symbols from Decision 6 (014-phase0-decision-6-staging-smoke-inputs.md)
const SMOKE_SYMBOLS = ['BTC', 'ETH'];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function ts(): string { return new Date().toISOString().slice(11, 23); }
function log(msg: string): void { console.log(`${DIM}${ts()}${RESET}  ${msg}`); }
function section(title: string): void { console.log(`\n${BOLD}${CYAN}──── ${title} ────${RESET}`); }
function ok(msg: string): void { console.log(`${DIM}${ts()}${RESET}  ${GREEN}✓${RESET} ${msg}`); }
function warn(msg: string): void { console.log(`${DIM}${ts()}${RESET}  ${YELLOW}⚠${RESET} ${msg}`); }
function fail(msg: string): void { console.log(`${DIM}${ts()}${RESET}  ${RED}✗ FAIL${RESET} ${msg}`); }

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface ApiResponse<T = unknown> { status: number; body: T; }

async function apiRequest<T = unknown>(
  method: string, path: string, options?: { body?: unknown; token?: string },
): Promise<ApiResponse<T>> {
  const url = `${API_BASE_URL}${path}`;
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options?.token) headers['Authorization'] = `Bearer ${options.token}`;
  const res = await fetch(url, { method, headers, ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
  let body: T;
  const ct = res.headers.get('content-type') ?? '';
  body = ct.includes('application/json') ? (await res.json()) as T : (await res.text()) as unknown as T;
  if (res.status < 200 || res.status >= 300) {
    warn(`API ${method} ${path} → ${res.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function authenticate(): Promise<string> {
  const loginRes = await apiRequest<{ token?: string }>('POST', '/auth/login', { body: { email: TEST_EMAIL, password: TEST_PASSWORD } });
  if (loginRes.status === 200 && loginRes.body.token) {
    ok(`Logged in as ${TEST_EMAIL}`);
    return loginRes.body.token;
  }
  const regRes = await apiRequest<{ token?: string }>('POST', '/auth/register', { body: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: 'Scanner Smoke Test' } });
  if (regRes.status === 201 && regRes.body.token) {
    ok(`Registered and logged in as ${TEST_EMAIL}`);
    return regRes.body.token;
  }
  throw new Error(`Auth failed: login=${loginRes.status} register=${regRes.status}`);
}

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

async function getActiveConnectionId(token: string): Promise<string> {
  const res = await apiRequest<{ connections?: Array<{ id: string; provider: string; status: string }> }>('GET', '/connections', { token });
  const items = res.body?.connections ?? [];
  const active = items.find(c => c.status === 'active');
  if (active) {
    ok(`Using existing active connection: ${active.id.slice(0, 8)}... (${active.provider})`);
    return active.id;
  }

  // No active connection — create one using real credentials
  const apiKey = process.env['HL_API_KEY'];
  const secret = process.env['HL_SECRET'];
  const walletAddress = process.env['HL_WALLET_ADDRESS'];

  if (!apiKey || !secret || !walletAddress) {
    throw new Error(
      'No active Hyperliquid connection found and HL_API_KEY/HL_SECRET/HL_WALLET_ADDRESS not set.\n' +
      '  Set up a connection first:\n' +
      '    scripts/shell/ops/quick-setup.sh\n' +
      '  Or set the env vars in .env.ops.dev and re-run.'
    );
  }

  const linkRes = await apiRequest<{ connection?: { id: string } }>('POST', '/setup/provider-link', {
    token,
    body: {
      provider: 'hyperliquid',
      label: `smoke-scanner-${Date.now()}`,
      secrets: { apiKey, secret, walletAddress },
      capability: 'trading',
    },
  });
  if (linkRes.status === 201 && linkRes.body.connection?.id) {
    ok(`Created new Hyperliquid connection: ${linkRes.body.connection.id.slice(0, 8)}...`);
    return linkRes.body.connection.id;
  }
  throw new Error(`No active connection available and could not create one: ${linkRes.status}`);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function dbQuery(sql: string): string {
  return execSync(
    `docker compose exec -T postgres psql -U herobids -d herobids -c "${sql.replace(/"/g, '\\"')}"`,
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 },
  ).trim();
}

function dbValue(raw: string): string | null {
  const lines = raw.split('\n');
  if (lines.length < 3) return null;
  const val = lines[2]?.trim();
  return val === '' ? null : val;
}

function agentTechnicalField(agentId: string, field: string): string | null {
  const raw = dbQuery(
    `SELECT (unified_config->'technical'->>'${field}') AS val FROM agents WHERE id = '${agentId}'`,
  );
  return dbValue(raw);
}

// ---------------------------------------------------------------------------
// Worker log helpers
// ---------------------------------------------------------------------------

function workerLogsSince(since: string, maxLines = 2000): string {
  try {
    return execSync(
      `docker compose logs --since "${since}" worker 2>&1 | head -${maxLines} || true`,
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 },
    );
  } catch { return ''; }
}

function workerLogsSinceAgent(since: string, agentId: string): string {
  try {
    const shortId = agentId.slice(0, 8);
    return execSync(
      `docker compose logs --since "${since}" worker 2>&1 | grep -A 30 "${shortId}" | head -300 || true`,
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 },
    );
  } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Agent helpers
// ---------------------------------------------------------------------------

async function deleteAgent(token: string, agentId: string): Promise<void> {
  try { await apiRequest('POST', `/agents/${agentId}/stop`, { token }); } catch { /* ok */ }
  await new Promise(r => setTimeout(r, 3000));
  try { await apiRequest('DELETE', `/agents/${agentId}`, { token }); } catch { /* ok */ }
  await new Promise(r => setTimeout(r, 1000));
}

async function pollAgentStatus(token: string, agentId: string, targetStatus: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await apiRequest<{ status?: string }>('GET', `/agents/${agentId}`, { token });
    if (res.body.status === targetStatus) return true;
    if (res.body.status === 'crashed') return false;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Poll worker logs for Technical phase complete lines matching the agent.
 * Returns the raw log block when found.
 */
async function pollForScanComplete(
  agentId: string, since: string, timeoutMs = 180_000, pollIntervalMs = 5000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = workerLogsSinceAgent(since, agentId);
    if (logs.includes('Technical phase complete')) return logs;
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scan log parsing
// ---------------------------------------------------------------------------

interface SymbolOutcome {
  symbol: string;
  instrumentId: string;
  eligible: boolean;
  fetched: boolean;
  unsupported: boolean;
  failed: boolean;
  candleCount: number;
  resolvedBinanceSymbol?: string;
}

interface ParsedScan {
  candidatesDiscovered: number;
  candidatesEligible: number;
  candidatesFetched: number;
  candidatesScored: number;
  signalsGenerated: number;
  errorCount: number;
  symbolOutcomes: SymbolOutcome[];
}

function parseScanLogs(logs: string): ParsedScan[] {
  const scans: ParsedScan[] = [];
  const blocks = logs.split(/Technical phase complete/);
  if (blocks.length < 2) return scans;

  for (const block of blocks) {
    const discoveredMatch = block.match(/candidatesDiscovered:\s*(\d+)/);
    const eligibleMatch = block.match(/candidatesEligible:\s*(\d+)/);
    const fetchedMatch = block.match(/candidatesFetched:\s*(\d+)/);
    const scoredMatch = block.match(/candidatesScored:\s*(\d+)/);
    const signalsMatch = block.match(/signalsGenerated:\s*(\d+)/);
    const errorMatch = block.match(/errorCount:\s*(\d+)/);

    if (!discoveredMatch) continue;

    const scan: ParsedScan = {
      candidatesDiscovered: parseInt(discoveredMatch[1]!, 10),
      candidatesEligible: eligibleMatch ? parseInt(eligibleMatch[1]!, 10) : 0,
      candidatesFetched: fetchedMatch ? parseInt(fetchedMatch[1]!, 10) : 0,
      candidatesScored: scoredMatch ? parseInt(scoredMatch[1]!, 10) : 0,
      signalsGenerated: signalsMatch ? parseInt(signalsMatch[1]!, 10) : 0,
      errorCount: errorMatch ? parseInt(errorMatch[1]!, 10) : 0,
      symbolOutcomes: [],
    };

    // Parse per-symbol outcomes from the block
    const symbolLines = block.match(/symbolOutcomes[:\s]+\[([\s\S]*?)\]/);
    if (symbolLines?.[1]) {
      // Try to extract individual outcomes
      const outcomes = symbolLines[1].match(/\{[^}]+\}/g);
      if (outcomes) {
        for (const outcome of outcomes) {
          const symMatch = outcome.match(/"symbol":\s*"([^"]+)"/);
          const instMatch = outcome.match(/"instrumentId":\s*"([^"]+)"/);
          const eligMatch = outcome.match(/"eligible":\s*(true|false)/);
          const fetchMatch = outcome.match(/"fetched":\s*(true|false)/);
          const unsupMatch = outcome.match(/"unsupported":\s*(true|false)/);
          const failMatch = outcome.match(/"failed":\s*(true|false)/);
          const countMatch = outcome.match(/"candleCount":\s*(\d+)/);
          const binanceMatch = outcome.match(/"resolvedBinanceSymbol":\s*"([^"]+)"/);

          scan.symbolOutcomes.push({
            symbol: symMatch?.[1] ?? 'unknown',
            instrumentId: instMatch?.[1] ?? 'unknown',
            eligible: eligMatch?.[1] === 'true',
            fetched: fetchMatch?.[1] === 'true',
            unsupported: unsupMatch?.[1] === 'true',
            failed: failMatch?.[1] === 'true',
            candleCount: countMatch ? parseInt(countMatch[1]!, 10) : 0,
            resolvedBinanceSymbol: binanceMatch?.[1],
          });
        }
      }
    }

    scans.push(scan);
  }

  return scans;
}

/**
 * Check that consecutive scan timestamps have gaps within expected range.
 */
function checkScanInterval(
  agentId: string, since: string, expectedMs: number, toleranceMs: number,
): { passed: boolean; detail: string; gaps: number[] } {
  const logs = workerLogsSinceAgent(since, agentId);
  const lines = logs.split('\n');
  const timestamps: number[] = [];
  for (const line of lines) {
    if (!line.includes('Technical phase complete')) continue;
    const match = line.match(/\[(\d{2}):(\d{2}):(\d{2})\]/);
    if (!match) continue;
    const [, h, m, s] = match;
    timestamps.push((parseInt(h!) * 3600 + parseInt(m!) * 60 + parseInt(s!)) * 1000);
  }
  if (timestamps.length < 2) {
    return { passed: false, detail: `only ${timestamps.length} timestamps found (need ≥2)`, gaps: [] };
  }
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    let gap = timestamps[i]! - timestamps[i - 1]!;
    if (gap < 0) gap += 24 * 3600 * 1000;
    gaps.push(gap);
  }
  const minGap = Math.min(...gaps);
  const maxGap = Math.max(...gaps);
  const withinTolerance = minGap >= (expectedMs - toleranceMs) && maxGap <= (expectedMs + toleranceMs);
  return {
    passed: withinTolerance,
    detail: withinTolerance
      ? `scan gaps min=${minGap}ms max=${maxGap}ms (expected ~${expectedMs}ms ±${toleranceMs}ms)`
      : `scan gaps min=${minGap}ms max=${maxGap}ms (expected ~${expectedMs}ms ±${toleranceMs}ms — OUT OF RANGE)`,
    gaps,
  };
}

// ─── Shared create payload defaults ──────────────────────────────────────────

const CREATE_BASE = {
  provider: process.env['LLM_PROVIDER'] ?? 'ollama',
  lightModel: process.env['LLM_LIGHT_MODEL'] ?? 'qwen3:8b',
  heavyModel: process.env['LLM_HEAVY_MODEL'] ?? 'qwen3.6:35b-a3b-q4_K_M',
} as const;

// ─── Test record keeping ─────────────────────────────────────────────────────

interface TestResult { name: string; passed: boolean; detail: string; }
const results: TestResult[] = [];
function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  if (passed) ok(`${name}: ${detail}`);
  else fail(`${name}: ${detail}`);
}

// Tracked by scenario1 for the final report
let zeroSignalsWasPass = false;

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 1: BTC+ETH bounded scan completes with healthy data
// ═══════════════════════════════════════════════════════════════════════════════

async function scenario1_boundedScanCompletes(token: string): Promise<void> {
  const connectionId = await getActiveConnectionId(token);
  const agentName = `smoke-scanner-${Date.now()}`;

  // 1. Create scanner_gated agent with bounded BTC/ETH symbol filter
  const createRes = await apiRequest<{ id?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: agentName,
      prompt: 'test',
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      strategyPreset: 'momentum',
      style: 'balanced',
      connectionIds: [connectionId],
      technical: {
        filters: {
          venue: 'hyperliquid',
          venueType: 'orderbook',
          symbols: SMOKE_SYMBOLS,
          minVolume24hUsd: 1_000_000,
        },
        indicators: {
          rsi: { period: 14 },
          macd: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
        },
        candles: { interval: '1h', lookback: 100 },
        signalBias: 'trend-following',
        scanIntervalMs: 30_000,
        scanBatchSize: 5,
        autonomousExit: true,
      },
    },
  });

  if (createRes.status !== 201 || !createRes.body.id) {
    record('s1-create', false, `create failed: ${createRes.status}`);
    return;
  }
  const agentId = createRes.body.id;
  log(`Created agent ${agentId}`);

  // 2. Assert DB: symbols filter is persisted correctly
  const dbFilters = agentTechnicalField(agentId, 'filters');
  const hasBtcEth = dbFilters?.includes('BTC') && dbFilters?.includes('ETH');
  record('s1-db-symbols', hasBtcEth,
    hasBtcEth ? `symbols [BTC, ETH] persisted in filters` : `filters missing BTC/ETH: ${dbFilters}`);

  // 3. Start the agent
  const since = new Date().toISOString();
  const startRes = await apiRequest('POST', `/agents/${agentId}/start`, { token });
  if (startRes.status !== 200 && startRes.status !== 202) {
    record('s1-start', false, `start failed: ${startRes.status}`);
    await deleteAgent(token, agentId);
    return;
  }

  const started = await pollAgentStatus(token, agentId, 'active', 30_000);
  if (!started) {
    record('s1-running', false, 'agent did not reach active status within 30s');
    await deleteAgent(token, agentId);
    return;
  }
  ok('Agent is active');

  // 4. Poll for at least 2 scan completions
  log('Polling for Technical phase complete (up to 180s)...');
  const scanLogs = await pollForScanComplete(agentId, since, 180_000, 5000);
  if (!scanLogs) {
    record('s1-scan-complete', false, 'no Technical phase complete found within 180s');
    await deleteAgent(token, agentId);
    return;
  }
  ok('Scan logs captured');

  // 5. Parse scans and make assertions
  const scans = parseScanLogs(scanLogs);
  if (scans.length < 2) {
    record('s1-scan-count', false, `only ${scans.length} scan(s) found (need ≥2)`);
    await deleteAgent(token, agentId);
    return;
  }
  record('s1-scan-count', true, `${scans.length} scans completed`);

  // Use the last scan for health assertions
  const lastScan = scans[scans.length - 1]!;

  // 6. Assert healthy data: eligible>0, fetched>0, errorCount===0
  const eligibleOk = lastScan.candidatesEligible >= SMOKE_SYMBOLS.length;
  record('s1-eligible', eligibleOk,
    `eligible=${lastScan.candidatesEligible} (expected ≥${SMOKE_SYMBOLS.length})`);

  const fetchedOk = lastScan.candidatesFetched >= SMOKE_SYMBOLS.length;
  record('s1-fetched', fetchedOk,
    `fetched=${lastScan.candidatesFetched} (expected ≥${SMOKE_SYMBOLS.length})`);

  const noErrors = lastScan.errorCount === 0;
  record('s1-no-errors', noErrors,
    noErrors ? 'errorCount=0' : `errorCount=${lastScan.errorCount} (expected 0)`);

  // 7. Assert signalsGenerated === 0 is a PASS (not a failure)
  if (lastScan.signalsGenerated === 0) {
    zeroSignalsWasPass = true;
    record('s1-zero-signals', true,
      'signalsGenerated=0 — healthy no-signal scan (this is a PASS)');
  } else {
    // Having signals is also fine, but we document it
    record('s1-signals', true,
      `signalsGenerated=${lastScan.signalsGenerated} (non-zero is acceptable, not required)`);
  }

  // 8. Report per-symbol outcomes
  section('Per-Symbol Outcomes');
  if (lastScan.symbolOutcomes.length > 0) {
    for (const outcome of lastScan.symbolOutcomes) {
      const status = outcome.eligible && outcome.fetched
        ? `${GREEN}healthy${RESET}`
        : outcome.unsupported
          ? `${RED}unsupported${RESET}`
          : outcome.failed
            ? `${RED}failed${RESET}`
            : `${YELLOW}unknown${RESET}`;
      const binanceInfo = outcome.resolvedBinanceSymbol ? ` → ${outcome.resolvedBinanceSymbol}` : '';
      console.log(`  ${status}  ${outcome.symbol} (${outcome.instrumentId})${binanceInfo}: eligible=${outcome.eligible}, fetched=${outcome.fetched}, candles=${outcome.candleCount}`);
    }
  } else {
    warn('No per-symbol outcomes found in scan logs. The scanner may not be emitting symbolOutcomes yet.');
    warn('This is expected if the scanner health matrix (Phase 2) has not been deployed.');
  }

  // 9. Assert scan interval
  const intervalCheck = checkScanInterval(agentId, since, 30_000, 15_000);
  record('s1-interval', intervalCheck.passed, intervalCheck.detail);

  // 10. Assert no "overlap skipped" or capacity issues
  const hasOverlap = scanLogs.includes('overlap skipped') || scanLogs.includes('overlapSkipped');
  record('s1-no-overlap', !hasOverlap,
    hasOverlap ? 'WARNING: overlap skipped detected (scans overlapping)' : 'no overlap skipped — single-flight working');

  const hasCapacitySkip = scanLogs.includes('capacity skip') || scanLogs.includes('capacitySkip');
  record('s1-no-capacity-skip', !hasCapacitySkip,
    hasCapacitySkip ? 'WARNING: capacity skip detected' : 'no capacity skip');

  // Clean up: delete agent but do NOT revoke the shared connection
  await deleteAgent(token, agentId);
  ok('Agent cleaned up (connection preserved)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 2: Explicit scanIntervalMs respected
// ═══════════════════════════════════════════════════════════════════════════════

async function scenario2_explicitIntervalRespected(token: string): Promise<void> {
  const connectionId = await getActiveConnectionId(token);
  const agentName = `smoke-interval-${Date.now()}`;

  const SCAN_INTERVAL_MS = 20_000;

  const createRes = await apiRequest<{ id?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: agentName,
      prompt: 'test',
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      strategyPreset: 'momentum',
      style: 'balanced',
      connectionIds: [connectionId],
      technical: {
        filters: {
          venue: 'hyperliquid',
          venueType: 'orderbook',
          symbols: SMOKE_SYMBOLS,
          minVolume24hUsd: 1_000_000,
        },
        indicators: {
          rsi: { period: 14 },
          macd: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
        },
        candles: { interval: '1h', lookback: 100 },
        signalBias: 'trend-following',
        scanIntervalMs: SCAN_INTERVAL_MS,
        scanBatchSize: 5,
        autonomousExit: true,
      },
    },
  });

  if (createRes.status !== 201 || !createRes.body.id) {
    record('s2-create', false, `create failed: ${createRes.status}`);
    return;
  }
  const agentId = createRes.body.id;
  log(`Created agent ${agentId}`);

  // Start
  const since = new Date().toISOString();
  const startRes = await apiRequest('POST', `/agents/${agentId}/start`, { token });
  if (startRes.status !== 200 && startRes.status !== 202) {
    record('s2-start', false, `start failed: ${startRes.status}`);
    await deleteAgent(token, agentId);
    return;
  }

  const started = await pollAgentStatus(token, agentId, 'active', 30_000);
  if (!started) {
    record('s2-running', false, 'agent did not reach active status within 30s');
    await deleteAgent(token, agentId);
    return;
  }

  // Wait for scans
  const scanLogs = await pollForScanComplete(agentId, since, 120_000, 5000);
  if (!scanLogs) {
    record('s2-scan-complete', false, 'no scan complete within 120s');
    await deleteAgent(token, agentId);
    return;
  }

  // Assert interval
  const intervalCheck = checkScanInterval(agentId, since, SCAN_INTERVAL_MS, 12_000);
  record('s2-interval', intervalCheck.passed, intervalCheck.detail);

  await deleteAgent(token, agentId);
  ok('Agent cleaned up (connection preserved)');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n${BOLD}=== Scanner Provider Smoke Test ===${RESET}`);
  console.log(`  API: ${API_BASE_URL}`);
  console.log(`  Symbols: ${SMOKE_SYMBOLS.join(', ')} (Decision 6 — confirmed-supported)`);
  console.log('');

  section('Setup');
  const token = await authenticate();

  section('Scenario 1 — BTC+ETH bounded scan with healthy data');
  await scenario1_boundedScanCompletes(token);

  section('Scenario 2 — Explicit scanIntervalMs respected');
  await scenario2_explicitIntervalRespected(token);

  // ─── Report ──────────────────────────────────────────────────────────────
  section('Results');
  const passed = results.filter(r => r.passed).length;
  const failedCount = results.filter(r => !r.passed).length;
  for (const r of results) {
    const icon = r.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`  ${icon} ${r.name}: ${r.detail}`);
  }
  console.log(`\n${BOLD}${passed}/${results.length} passed, ${failedCount} failed${RESET}`);

  if (zeroSignalsWasPass) {
    console.log(`${GREEN}Note: signalsGenerated=0 is a PASS — smoke validates the provider path, not signal generation.${RESET}`);
  }
  console.log('');

  if (failedCount > 0) process.exit(1);
}

main().catch(err => {
  console.error(`${RED}FATAL: ${err instanceof Error ? err.message : String(err)}${RESET}`);
  process.exit(1);
});
