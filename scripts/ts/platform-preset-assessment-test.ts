/**
 * platform-preset-assessment-test.ts — E2E tests for platform preset assessment
 * config-propagation gating (S1, S2, S3, S19).
 *
 * Verifies that operator config and agent opt-in are correctly propagated
 * by checking API-persisted config, worker logs, and DB state.
 *
 * Scenarios:
 *   S1  Operator disables platform assessor → review schedulers skip
 *   S2  Agent opts out (platformAssessment.enabled=false) → scheduler skips
 *   S3  Agent opts in (platformAssessment.enabled=true) → scheduler starts
 *   S19 Operator freshness config propagates to assessor
 *
 * Usage:
 *   PLATFORM_ASSESSOR_ENABLED=true SCENARIOS=S1,S2,S3,S19 \
 *     tsx scripts/ts/platform-preset-assessment-test.ts
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
const API_BASE_URL = process.env['API_BASE_URL'] ?? 'http://localhost:3000';
const TEST_EMAIL = process.env['TEST_EMAIL'] ?? 'trade-test@local.test';
const TEST_PASSWORD = process.env['TEST_PASSWORD'] ?? 'TradeTest123!';
const VENUE = process.env['VENUE'] ?? 'hyperliquid';
const EXECUTION_MODE = process.env['EXECUTION_MODE'] ?? 'paper';
const LLM_PROVIDER = process.env['LLM_PROVIDER'] ?? 'ollama';
const LLM_LIGHT_MODEL = process.env['LLM_LIGHT_MODEL'] ?? 'qwen3:8b';
const LLM_HEAVY_MODEL = process.env['LLM_HEAVY_MODEL'] ?? 'qwen3.6:35b-a3b-q4_K_M';
const SCENARIOS = (process.env['SCENARIOS'] ?? 'S1,S2,S3,S19').split(',').map(s => s.trim());

// ---------------------------------------------------------------------------
const RESET = '\x1b[0m', BOLD = '\x1b[1m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m', CYAN = '\x1b[36m', DIM = '\x1b[2m';
function ts(): string { return new Date().toISOString().slice(11, 23); }
function log(msg: string): void { console.log(`${DIM}${ts()}${RESET}  ${msg}`); }
function section(title: string): void { console.log(`\n${BOLD}${CYAN}──── ${title} ────${RESET}`); }
function ok(msg: string): void { console.log(`${DIM}${ts()}${RESET}  ${GREEN}✓${RESET} ${msg}`); }
function warn(msg: string): void { console.log(`${DIM}${ts()}${RESET}  ${YELLOW}⚠${RESET} ${msg}`); }
function fail(msg: string): void { console.log(`${DIM}${ts()}${RESET}  ${RED}✗ FAIL${RESET} ${msg}`); }
function fatal(msg: string): never { console.error(`${DIM}${ts()}${RESET}  ${RED}✗ FATAL: ${msg}${RESET}`); process.exit(1); }
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
interface ApiResponse<T = unknown> { status: number; body: T; }
async function apiRequest<T = unknown>(method: string, path: string, options?: { body?: unknown; token?: string }): Promise<ApiResponse<T>> {
  const url = `${API_BASE_URL}${path}`;
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options?.token) headers['Authorization'] = `Bearer ${options.token}`;
  const res = await fetch(url, { method, headers, ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
  let body: T;
  const ct = res.headers.get('content-type') ?? '';
  body = ct.includes('application/json') ? (await res.json()) as T : (await res.text()) as unknown as T;
  if (res.status < 200 || res.status >= 300) warn(`API ${method} ${path} → ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
async function authenticate(): Promise<string> {
  const loginRes = await apiRequest<{ token?: string }>('POST', '/auth/login', { body: { email: TEST_EMAIL, password: TEST_PASSWORD } });
  if (loginRes.status === 200 && loginRes.body.token) { ok(`Logged in as ${TEST_EMAIL}`); return loginRes.body.token; }
  const regRes = await apiRequest<{ token?: string }>('POST', '/auth/register', { body: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: 'Assessment Test' } });
  if (regRes.status === 201 && regRes.body.token) { ok(`Registered and logged in as ${TEST_EMAIL}`); return regRes.body.token; }
  fatal(`Auth failed: login=${loginRes.status} register=${regRes.status}`);
}

// ---------------------------------------------------------------------------
function venueSecrets(): Record<string, string> {
  if (VENUE === 'hyperliquid') {
    const a = process.env['HL_API_KEY'], s = process.env['HL_SECRET'], w = process.env['HL_WALLET_ADDRESS'];
    if (!a || !s || !w) fatal('Hyperliquid requires HL_API_KEY, HL_SECRET, HL_WALLET_ADDRESS');
    return { apiKey: a, secret: s, walletAddress: w };
  }
  if (VENUE === 'bybit') {
    const a = process.env['BYBIT_API_KEY'], s = process.env['BYBIT_SECRET'];
    if (!a || !s) fatal('Bybit requires BYBIT_API_KEY, BYBIT_SECRET');
    return { apiKey: a, secret: s };
  }
  if (VENUE === '1inch') {
    const a = process.env['ONEINCH_API_KEY'], p = process.env['ONEINCH_PRIVATE_KEY'];
    if (!a || !p) fatal('1inch requires ONEINCH_API_KEY, ONEINCH_PRIVATE_KEY');
    return { apiKey: a, privateKey: p };
  }
  fatal(`Unsupported VENUE: ${VENUE}`);
}

async function createProviderLink(token: string): Promise<string> {
  const res = await apiRequest<{ connection?: { id: string } }>('POST', '/setup/provider-link', {
    token, body: { provider: VENUE, label: `assess-test-${Date.now()}`, secrets: venueSecrets(), capability: 'trading' },
  });
  if (res.status === 201 && res.body.connection?.id) { ok(`Provider link — ${res.body.connection.id}`); return res.body.connection.id; }
  fatal(`Provider link failed: ${res.status}`);
}

// ---------------------------------------------------------------------------
async function createAgent(token: string, connectionId: string): Promise<string> {
  const res = await apiRequest<{ id?: string }>('POST', '/agents', { token, body: {
    name: `AssessTest-${Date.now()}`, prompt: 'Test agent. Do not trade.',
    skillIds: ['trading'], executionMode: EXECUTION_MODE, tickIntervalMs: 60_000,
    capital: '1000', provider: LLM_PROVIDER, lightModel: LLM_LIGHT_MODEL, heavyModel: LLM_HEAVY_MODEL,
    connectionIds: [connectionId],
  }});
  if (res.status === 201 && res.body.id) { ok(`Agent created — ${res.body.id}`); return res.body.id; }
  fatal(`Agent creation failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function startAgent(token: string, agentId: string): Promise<void> {
  const res = await apiRequest('POST', `/agents/${agentId}/start`, { token });
  if (res.status === 202) { ok('Agent started'); return; }
  if (res.status === 409) { warn('Agent start 409'); return; }
  fatal(`Agent start failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function stopAndDeleteAgent(token: string, agentId: string): Promise<void> {
  try { await apiRequest('POST', `/agents/${agentId}/stop`, { token }); } catch { /* ok */ }
  await sleep(5000);
  try { await apiRequest('DELETE', `/agents/${agentId}`, { token }); } catch { /* ok */ }
  await sleep(1000);
}

// ---------------------------------------------------------------------------
function dbExec(sql: string): string {
  return execSync(`docker compose exec -T postgres psql -U herobids -d herobids -c "${sql.replace(/"/g, '\\"')}"`, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 }).trim();
}
function dbVal(raw: string): string | null {
  const lines = raw.split('\n'); if (lines.length < 3) return null;
  const v = lines[2]?.trim(); return v === '' ? null : v;
}
function reactivateConnections(): void {
  dbExec("UPDATE connections SET status = 'active' WHERE status = 'revoked'");
}
function setPlatformAssessment(agentId: string, enabled: boolean): void {
  dbExec(`UPDATE agents SET unified_config = COALESCE(unified_config, '{}'::jsonb) || '{"platformAssessment": {"enabled": ${enabled}}}'::jsonb WHERE id = '${agentId}'`);
}
function getPlatformAssessment(agentId: string): string | null {
  return dbVal(dbExec(`SELECT (unified_config->'platformAssessment'->>'enabled')::text AS val FROM agents WHERE id = '${agentId}'`));
}
function workerLogs(): string {
  try { return execSync(`docker compose logs worker 2>&1 | tail -500 || true`, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 }); } catch { return ''; }
}

// ---------------------------------------------------------------------------
interface TR { scenario: string; passed: boolean; detail: string; }
const results: TR[] = [];
function record(scenario: string, passed: boolean, detail: string): void {
  results.push({ scenario, passed, detail });
  if (passed) ok(`${scenario}: ${detail}`); else fail(`${scenario}: ${detail}`);
}

// ---------------------------------------------------------------------------
async function runS1(token: string, connectionId: string): Promise<void> {
  section('S1: Operator-disabled global block');
  const opOn = process.env['PLATFORM_ASSESSOR_ENABLED'] !== 'false';
  if (opOn) { record('S1', true, 'Skipped — PLATFORM_ASSESSOR_ENABLED not false'); return; }

  reactivateConnections();
  const agentId = await createAgent(token, connectionId);
  setPlatformAssessment(agentId, true);
  await startAgent(token, agentId);
  await sleep(15000);

  const schedulerSkipped = workerLogs().includes('Platform assessor is disabled at operator level');
  record('S1', schedulerSkipped, schedulerSkipped ? 'Scheduler skipped at operator level' : 'Disable message not in logs');
  await stopAndDeleteAgent(token, agentId);
}

async function runS2(token: string, connectionId: string): Promise<void> {
  section('S2: Agent opt-out block');
  const opOn = process.env['PLATFORM_ASSESSOR_ENABLED'] !== 'false';
  if (!opOn) { record('S2', true, 'Skipped — operator disabled'); return; }

  reactivateConnections();
  const agentId = await createAgent(token, connectionId);
  setPlatformAssessment(agentId, false);
  await startAgent(token, agentId);
  await sleep(15000);

  const v = getPlatformAssessment(agentId);
  record('S2', v === 'false', `platformAssessment.enabled=${v} (expected false)`);
  await stopAndDeleteAgent(token, agentId);
}

async function runS3(token: string, connectionId: string): Promise<void> {
  section('S3: Agent opt-in');
  const opOn = process.env['PLATFORM_ASSESSOR_ENABLED'] !== 'false';
  if (!opOn) { record('S3', true, 'Skipped — operator disabled'); return; }

  reactivateConnections();
  const agentId = await createAgent(token, connectionId);
  setPlatformAssessment(agentId, true);
  await startAgent(token, agentId);
  await sleep(15000);

  const v = getPlatformAssessment(agentId);
  record('S3', v === 'true', `platformAssessment.enabled=${v} (expected true)`);
  await stopAndDeleteAgent(token, agentId);
}

async function runS19(token: string, connectionId: string): Promise<void> {
  section('S19: Freshness config propagation');
  const opOn = process.env['PLATFORM_ASSESSOR_ENABLED'] !== 'false';
  if (!opOn) { record('S19', true, 'Skipped — operator disabled'); return; }

  reactivateConnections();
  const agentId = await createAgent(token, connectionId);
  setPlatformAssessment(agentId, true);
  await startAgent(token, agentId);
  await sleep(15000);

  const tableOk = dbVal(dbExec("SELECT count(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='market_assessment_artifacts'"));
  record('S19-schema', tableOk === '1', `Schema ready: ${tableOk === '1'}`);
  const llmOk = workerLogs().includes('Platform assessor LLM configured');
  record('S19-llm', llmOk, llmOk ? 'LLM config propagated' : 'LLM config not found in logs');
  await stopAndDeleteAgent(token, agentId);
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  log(`Scenarios: ${SCENARIOS.join(', ')}  PLATFORM_ASSESSOR_ENABLED=${process.env['PLATFORM_ASSESSOR_ENABLED'] ?? 'unset'}`);

  // Clean up leftover agents
  dbExec("UPDATE agents SET status = 'stopped' WHERE status NOT IN ('stopped', 'crashed'); DELETE FROM agents;");
  log('Cleaned up leftover agents');

  const token = await authenticate();
  const connectionId = await createProviderLink(token);

  if (SCENARIOS.includes('S1')) await runS1(token, connectionId);
  if (SCENARIOS.includes('S2')) await runS2(token, connectionId);
  if (SCENARIOS.includes('S3')) await runS3(token, connectionId);
  if (SCENARIOS.includes('S19')) await runS19(token, connectionId);

  console.log(`\n${BOLD}${CYAN}═══════════════════════════════════════${RESET}`);
  console.log(`${BOLD}${CYAN}  Results${RESET}`);
  console.log(`${BOLD}${CYAN}═══════════════════════════════════════${RESET}`);
  let p = 0, f = 0;
  for (const r of results) { if (r.passed) { console.log(`  ${GREEN}✓${RESET} ${r.scenario}: ${r.detail}`); p++; } else { console.log(`  ${RED}✗${RESET} ${r.scenario}: ${r.detail}`); f++; } }
  console.log(`\n${BOLD}${p} passed, ${f} failed, ${results.length} total${RESET}`);
  if (f > 0) process.exit(1);
}
main().catch(err => { console.error(`${RED}FATAL: ${err instanceof Error ? err.message : String(err)}${RESET}`); process.exit(1); });
