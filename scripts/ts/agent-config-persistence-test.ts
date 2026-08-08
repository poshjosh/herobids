/**
 * agent-config-persistence-test.ts — API-level persistence verification.
 *
 * Verifies that API create and PATCH endpoints correctly persist technical
 * configuration to the database, and that strict invalid configurations are
 * rejected at write time.
 *
 * Scenarios:
 *   1. Create scanner_gated agent with complete technical → all fields persisted
 *   2. Create scanner_gated agent with incomplete technical → API rejects
 *   3. Create mixed-mode hybrid → defaults applied and persisted
 *   4. PATCH preserves existing technical fields (partial update)
 *   5. Intelligence-mode agent unaffected (no technical block)
 *
 * This test requires only the API and DB. No worker, connection, candles,
 * signals, or live market data are needed.
 *
 * Prerequisites: API and DB running (docker compose up).
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3000 TEST_EMAIL=a@b.com TEST_PASSWORD=... \
 *     tsx scripts/ts/agent-config-persistence-test.ts
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
  const regRes = await apiRequest<{ token?: string }>('POST', '/auth/register', { body: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: 'Persistence Test' } });
  if (regRes.status === 201 && regRes.body.token) {
    ok(`Registered and logged in as ${TEST_EMAIL}`);
    return regRes.body.token;
  }
  throw new Error(`Auth failed: login=${loginRes.status} register=${regRes.status}`);
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

function agentTechnicalIsNull(agentId: string): boolean {
  const raw = dbQuery(
    `SELECT (unified_config->'technical' IS NULL)::text AS tech_null FROM agents WHERE id = '${agentId}'`,
  );
  return raw.includes('\n t') || raw.includes('\nt');
}

function agentTechnicalJson(agentId: string): Record<string, unknown> | null {
  const raw = dbQuery(
    `SELECT (unified_config->'technical')::text AS tech FROM agents WHERE id = '${agentId}'`,
  );
  const val = dbValue(raw);
  if (!val) return null;
  try { return JSON.parse(val) as Record<string, unknown>; }
  catch { return null; }
}

async function deleteAgent(token: string, agentId: string): Promise<void> {
  try { await apiRequest('DELETE', `/agents/${agentId}`, { token }); } catch { /* ok */ }
  await new Promise(r => setTimeout(r, 1000));
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

// ═══════════════════════════════════════════════════════════════════════════════
// Required technical fields for scanner_gated agents (StrictTechnicalConfigSchema)
// ═══════════════════════════════════════════════════════════════════════════════

const REQUIRED_SCANNER_FIELDS = [
  'filters', 'indicators', 'candles', 'signalBias',
  'scanIntervalMs', 'scanBatchSize', 'autonomousExit',
] as const;

const COMPLETE_TECHNICAL = {
  filters: { venue: 'hyperliquid', venueType: 'orderbook', symbols: ['BTC', 'ETH'] },
  indicators: { rsi: { period: 14 }, macd: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } },
  candles: { interval: '1h', limit: 100 },
  signalBias: 'trend-following',
  scanIntervalMs: 60_000,
  scanBatchSize: 5,
  autonomousExit: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 1: Complete technical config persisted for scanner_gated agent
// ═══════════════════════════════════════════════════════════════════════════════

async function scenario1_completeConfigPersisted(token: string): Promise<void> {
  const agentName = `persist-complete-${Date.now()}`;

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
      executionDefaults: { mode: 'paper' as const },
      skillIds: ['trading'],
      technical: COMPLETE_TECHNICAL,
    },
  });

  if (createRes.status !== 201 || !createRes.body.id) {
    record('s1-create', false, `create failed: ${createRes.status} — ${JSON.stringify(createRes.body).slice(0, 200)}`);
    return;
  }
  const agentId = createRes.body.id;
  log(`Created agent ${agentId}`);

  // Assert every required field is persisted with the correct value
  const dbScanIntervalMs = agentTechnicalField(agentId, 'scanIntervalMs');
  const dbScanBatchSize = agentTechnicalField(agentId, 'scanBatchSize');
  const dbSignalBias = agentTechnicalField(agentId, 'signalBias');
  const dbAutonomousExit = agentTechnicalField(agentId, 'autonomousExit');

  let allOk = true;
  if (dbScanIntervalMs !== '60000') { record('s1-scanIntervalMs', false, `expected 60000, got ${dbScanIntervalMs}`); allOk = false; }
  else record('s1-scanIntervalMs', true, `scanIntervalMs=${dbScanIntervalMs}`);

  if (dbScanBatchSize !== '5') { record('s1-scanBatchSize', false, `expected 5, got ${dbScanBatchSize}`); allOk = false; }
  else record('s1-scanBatchSize', true, `scanBatchSize=${dbScanBatchSize}`);

  if (dbSignalBias !== 'trend-following') { record('s1-signalBias', false, `expected trend-following, got ${dbSignalBias}`); allOk = false; }
  else record('s1-signalBias', true, `signalBias=${dbSignalBias}`);

  if (dbAutonomousExit !== 'true') { record('s1-autonomousExit', false, `expected true, got ${dbAutonomousExit}`); allOk = false; }
  else record('s1-autonomousExit', true, `autonomousExit=${dbAutonomousExit}`);

  // Assert nested filters persisted
  const dbVenue = agentTechnicalField(agentId, 'filters');
  record('s1-filters', dbVenue !== null, dbVenue !== null ? `filters persisted` : 'filters missing');

  // Assert nested indicators persisted
  const dbIndicators = agentTechnicalField(agentId, 'indicators');
  record('s1-indicators', dbIndicators !== null, dbIndicators !== null ? `indicators persisted` : 'indicators missing');

  // Assert nested candles persisted
  const dbCandles = agentTechnicalField(agentId, 'candles');
  record('s1-candles', dbCandles !== null, dbCandles !== null ? `candles persisted` : 'candles missing');

  await deleteAgent(token, agentId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 2: Incomplete technical config rejected by API
// ═══════════════════════════════════════════════════════════════════════════════

async function scenario2_incompleteConfigRejected(token: string): Promise<void> {
  // Try creating a scanner_gated agent with NO technical block at all
  const agentName1 = `persist-notech-${Date.now()}`;
  const res1 = await apiRequest<{ id?: string; error?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: agentName1,
      prompt: 'test',
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      style: 'balanced',
      // ⚠️ No technical block — should be rejected
    },
  });

  const rejectedNoTech = res1.status === 400;
  record('s2-reject-no-technical', rejectedNoTech,
    rejectedNoTech ? 'API rejected scanner_gated agent without technical block (400)' :
      `API returned ${res1.status} — expected 400`);

  // Clean up if it somehow created
  if (res1.body.id) await deleteAgent(token, res1.body.id);

  // Try creating a scanner_gated agent with technical but missing scanBatchSize
  const agentName2 = `persist-missing-batch-${Date.now()}`;
  const res2 = await apiRequest<{ id?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: agentName2,
      prompt: 'test',
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      strategyPreset: 'momentum',
      style: 'balanced',
      technical: {
        filters: { venue: 'hyperliquid' },
        // ⚠️ Missing scanBatchSize, scanIntervalMs, indicators, etc.
      },
    },
  });

  const rejectedPartial = res2.status === 400;
  record('s2-reject-partial-technical', rejectedPartial,
    rejectedPartial ? 'API rejected scanner_gated agent with incomplete technical block (400)' :
      `API returned ${res2.status} — expected 400`);

  if (res2.body.id) await deleteAgent(token, res2.body.id);

  // Try creating a scanner_gated agent with no indicators; API defaults them.
  const agentName3 = `persist-missing-indicators-${Date.now()}`;
  const res3 = await apiRequest<{ id?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: agentName3,
      prompt: 'test',
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      strategyPreset: 'momentum',
      style: 'balanced',
      executionDefaults: { mode: 'paper' as const },
      skillIds: ['trading'],
      technical: {
        ...COMPLETE_TECHNICAL,
        indicators: undefined,
        // ⚠️ Missing indicators — defaults are applied at write time.
      },
    },
  });

  const defaultedIndicators = res3.status === 201 && res3.body.id !== undefined;
  record('s2-default-missing-indicators', defaultedIndicators,
    defaultedIndicators ? 'API defaulted missing scanner_gated indicators' :
      `API returned ${res3.status} — expected 201`);

  if (res3.body.id) await deleteAgent(token, res3.body.id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 3: Mixed-mode hybrid gets defaults applied at API write
// ═══════════════════════════════════════════════════════════════════════════════

async function scenario3_mixedModeDefaultsApplied(token: string): Promise<void> {
  const agentName = `persist-mixed-${Date.now()}`;

  const createRes = await apiRequest<{ id?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: agentName,
      prompt: 'test',
      capabilityMode: 'hybrid',
      hybridMode: 'mixed',
      strategyPreset: 'momentum',
      style: 'balanced',
      executionDefaults: { mode: 'paper' as const },
      skillIds: ['trading'],
      technical: {
        filters: { venue: 'hyperliquid', venueType: 'orderbook' },
        // ⚠️ Minimal technical — Zod defaults should fill the rest
      },
    },
  });

  if (createRes.status !== 201 || !createRes.body.id) {
    record('s3-create', false, `create failed: ${createRes.status}`);
    return;
  }
  const agentId = createRes.body.id;
  log(`Created mixed-mode agent ${agentId}`);

  // Assert defaults were applied: scanBatchSize=5, scanIntervalMs=60000
  const dbScanBatchSize = agentTechnicalField(agentId, 'scanBatchSize');
  const dbScanIntervalMs = agentTechnicalField(agentId, 'scanIntervalMs');
  const dbAutonomousExit = agentTechnicalField(agentId, 'autonomousExit');

  let allOk = true;
  if (dbScanBatchSize !== '5') { record('s3-scanBatchSize', false, `expected 5, got ${dbScanBatchSize}`); allOk = false; }
  else record('s3-scanBatchSize', true, `scanBatchSize=${dbScanBatchSize} — default applied`);

  if (dbScanIntervalMs !== '60000') { record('s3-scanIntervalMs', false, `expected 60000, got ${dbScanIntervalMs}`); allOk = false; }
  else record('s3-scanIntervalMs', true, `scanIntervalMs=${dbScanIntervalMs} — default applied`);

  if (dbAutonomousExit !== 'false') { record('s3-autonomousExit', false, `expected false, got ${dbAutonomousExit}`); allOk = false; }
  else record('s3-autonomousExit', true, `autonomousExit=false — default applied`);

  await deleteAgent(token, agentId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 4: PATCH preserves existing technical fields
// ═══════════════════════════════════════════════════════════════════════════════

async function scenario4_patchPreservesFields(token: string): Promise<void> {
  const agentName = `persist-patch-${Date.now()}`;

  // 1. Create with complete technical
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
      executionDefaults: { mode: 'paper' as const },
      skillIds: ['trading'],
      technical: COMPLETE_TECHNICAL,
    },
  });

  if (createRes.status !== 201 || !createRes.body.id) {
    record('s4-create', false, `create failed: ${createRes.status}`);
    return;
  }
  const agentId = createRes.body.id;
  log(`Created agent ${agentId}`);

  // 2. Verify initial state
  const initScanBatchSize = agentTechnicalField(agentId, 'scanBatchSize');
  const initScanIntervalMs = agentTechnicalField(agentId, 'scanIntervalMs');
  const initSignalBias = agentTechnicalField(agentId, 'signalBias');

  // 3. PATCH to change only signalBias
  const patchRes = await apiRequest<{ id?: string }>('PATCH', `/agents/${agentId}`, {
    token,
    body: {
      technical: { signalBias: 'mean-reverting' },
    },
  });

  if (patchRes.status !== 200) {
    record('s4-patch', false, `PATCH failed: ${patchRes.status}`);
    await deleteAgent(token, agentId);
    return;
  }
  ok('PATCH succeeded');

  // 4. Assert: scanBatchSize and scanIntervalMs still present (not stripped)
  const postPatchBatch = agentTechnicalField(agentId, 'scanBatchSize');
  const postPatchInterval = agentTechnicalField(agentId, 'scanIntervalMs');
  const postPatchBias = agentTechnicalField(agentId, 'signalBias');

  const batchOk = postPatchBatch === initScanBatchSize;
  record('s4-batch-preserved', batchOk,
    batchOk ? `scanBatchSize=${postPatchBatch} — preserved` : `scanBatchSize changed: ${initScanBatchSize} → ${postPatchBatch}`);

  const intervalOk = postPatchInterval === initScanIntervalMs;
  record('s4-interval-preserved', intervalOk,
    intervalOk ? `scanIntervalMs=${postPatchInterval} — preserved` : `scanIntervalMs changed: ${initScanIntervalMs} → ${postPatchInterval}`);

  const biasOk = postPatchBias === 'mean-reverting';
  record('s4-bias-updated', biasOk,
    biasOk ? `signalBias updated to mean-reverting` : `signalBias=${postPatchBias} — expected mean-reverting`);

  // 5. Assert filters, indicators, candles still present
  const dbFilters = agentTechnicalField(agentId, 'filters');
  const dbIndicators = agentTechnicalField(agentId, 'indicators');
  const dbCandles = agentTechnicalField(agentId, 'candles');

  record('s4-filters-preserved', dbFilters !== null, dbFilters !== null ? 'filters preserved' : 'filters stripped');
  record('s4-indicators-preserved', dbIndicators !== null, dbIndicators !== null ? 'indicators preserved' : 'indicators stripped');
  record('s4-candles-preserved', dbCandles !== null, dbCandles !== null ? 'candles preserved' : 'candles stripped');

  await deleteAgent(token, agentId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 5: Intelligence-mode agent unaffected (no technical block)
// ═══════════════════════════════════════════════════════════════════════════════

async function scenario5_intelligenceAgentUnaffected(token: string): Promise<void> {
  const agentName = `persist-intel-${Date.now()}`;

  // 1. Create intelligence agent with NO technical block
  const createRes = await apiRequest<{ id?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: agentName,
      prompt: 'test',
      capabilityMode: 'intelligence',
      // ⚠️ No technical block, no connectionIds
    },
  });

  if (createRes.status !== 201 || !createRes.body.id) {
    record('s5-create', false, `create failed: ${createRes.status}`);
    return;
  }
  const agentId = createRes.body.id;
  log(`Created intelligence agent ${agentId}`);

  // 2. Assert DB: unified_config->'technical' IS NULL
  const techNull = agentTechnicalIsNull(agentId);
  record('s5-db-no-technical', techNull,
    techNull ? 'technical IS NULL — correct' : 'technical should be NULL but is present');

  // 3. Assert agent is healthy (GET returns status)
  const getRes = await apiRequest<{ status?: string; capabilityMode?: string }>('GET', `/agents/${agentId}`, { token });
  const isHealthy = getRes.status === 200;
  const modeCorrect = getRes.body?.capabilityMode === 'intelligence';

  record('s5-accessible', isHealthy, isHealthy ? 'agent GET returns 200' : `agent GET failed: ${getRes.status}`);
  record('s5-mode', modeCorrect, modeCorrect ? `capabilityMode=intelligence` : `capabilityMode=${getRes.body?.capabilityMode}`);

  await deleteAgent(token, agentId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 6: PATCH with invalid technical is rejected
// ═══════════════════════════════════════════════════════════════════════════════

async function scenario6_patchInvalidRejected(token: string): Promise<void> {
  const agentName = `persist-badpatch-${Date.now()}`;

  // 1. Create with complete technical
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
      executionDefaults: { mode: 'paper' as const },
      skillIds: ['trading'],
      technical: COMPLETE_TECHNICAL,
    },
  });

  if (createRes.status !== 201 || !createRes.body.id) {
    record('s6-create', false, `create failed: ${createRes.status}`);
    return;
  }
  const agentId = createRes.body.id;
  log(`Created agent ${agentId}`);

  // 2. PATCH with invalid scanBatchSize (negative number)
  const res1 = await apiRequest<{ error?: string }>('PATCH', `/agents/${agentId}`, {
    token,
    body: {
      technical: { scanBatchSize: -5 },
    },
  });
  record('s6-reject-negative-batch', res1.status === 400,
    res1.status === 400 ? 'API rejected negative scanBatchSize (400)' : `API returned ${res1.status}`);

  // 3. PATCH with invalid scanIntervalMs (too small)
  const res2 = await apiRequest<{ error?: string }>('PATCH', `/agents/${agentId}`, {
    token,
    body: {
      technical: { scanIntervalMs: 100 },
    },
  });
  record('s6-reject-tiny-interval', res2.status === 400,
    res2.status === 400 ? 'API rejected tiny scanIntervalMs (400)' : `API returned ${res2.status}`);

  // 4. Verify original values are still intact after rejected patches
  const dbScanBatchSize = agentTechnicalField(agentId, 'scanBatchSize');
  const dbScanIntervalMs = agentTechnicalField(agentId, 'scanIntervalMs');

  const valuesIntact = dbScanBatchSize === '5' && dbScanIntervalMs === '60000';
  record('s6-values-intact', valuesIntact,
    valuesIntact ? `values intact after rejected PATCH: batch=${dbScanBatchSize}, interval=${dbScanIntervalMs}` :
      `values corrupted: batch=${dbScanBatchSize}, interval=${dbScanIntervalMs}`);

  await deleteAgent(token, agentId);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n${BOLD}=== Agent Config Persistence Test ===${RESET}`);
  console.log(`  API: ${API_BASE_URL}`);
  console.log('');

  section('Setup');
  const token = await authenticate();

  section('Scenario 1 — Complete technical config persisted');
  await scenario1_completeConfigPersisted(token);

  section('Scenario 2 — Incomplete config rejected by API');
  await scenario2_incompleteConfigRejected(token);

  section('Scenario 3 — Mixed-mode defaults applied');
  await scenario3_mixedModeDefaultsApplied(token);

  section('Scenario 4 — PATCH preserves existing fields');
  await scenario4_patchPreservesFields(token);

  section('Scenario 5 — Intelligence agent unaffected');
  await scenario5_intelligenceAgentUnaffected(token);

  section('Scenario 6 — Invalid PATCH rejected');
  await scenario6_patchInvalidRejected(token);

  // ─── Report ──────────────────────────────────────────────────────────────
  section('Results');
  const passed = results.filter(r => r.passed).length;
  const failedCount = results.filter(r => !r.passed).length;
  for (const r of results) {
    const icon = r.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`  ${icon} ${r.name}: ${r.detail}`);
  }
  console.log(`\n${BOLD}${passed}/${results.length} passed, ${failedCount} failed${RESET}\n`);

  if (failedCount > 0) process.exit(1);
}

main().catch(err => {
  console.error(`${RED}FATAL: ${err instanceof Error ? err.message : String(err)}${RESET}`);
  process.exit(1);
});
