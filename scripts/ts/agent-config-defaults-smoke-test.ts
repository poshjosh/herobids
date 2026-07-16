/**
 * agent-config-defaults-smoke-test.ts — Shell smoke test for agent config defaults.
 *
 * Verifies the full API → DB → worker → logs pipeline after the
 * applyConfigDefaults() fix (003-technical-config-scan-defaults-not-applied-at-load).
 *
 * Scenarios:
 *   1. Minimal config produces signals (scanBatchSize/scanIntervalMs defaults applied)
 *   2. Explicit values preserved in DB
 *   3. Intelligence-mode agent unaffected (no technical block, no technical phase)
 *   4. PATCH preserves defaults (partial update doesn't strip schema defaults)
 *
 * Prerequisites: Local or staging stack running (docker compose up),
 * a test user exists, and there is at least one active Hyperliquid connection.
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3000 TEST_EMAIL=a@b.com TEST_PASSWORD=... \
 *     tsx scripts/ts/agent-config-defaults-smoke-test.ts
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
  const regRes = await apiRequest<{ token?: string }>('POST', '/auth/register', { body: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: 'Defaults Smoke Test' } });
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

/** Extract the data-line value from psql tabular output. Returns null if empty. */
function dbValue(raw: string): string | null {
  const lines = raw.split('\n');
  // psql format: header line, separator line, data line(s), row count
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

function workerLogsSince(since: string, maxLines = 1000): string {
  try {
    return execSync(
      `docker compose logs --since "${since}" worker 2>&1 | head -${maxLines} || true`,
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 },
    );
  } catch { return ''; }
}

function workerLogsSinceAgent(since: string, agentId: string): string {
  try {
    // -A 20 includes trailing context lines because pino-pretty renders
    // structured log fields (candidatesScored, candidatesDiscovered, etc.)
    // on indented continuation lines that do NOT repeat the agent ID.
    return execSync(
      `docker compose logs --since "${since}" worker 2>&1 | grep -A 20 "${agentId}" | head -200 || true`,
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 },
    );
  } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Connection / Agent helpers
// ---------------------------------------------------------------------------

async function getActiveConnectionId(token: string): Promise<string> {
  const res = await apiRequest<{ connections?: Array<{ id: string; provider: string; status: string }> }>('GET', '/connections', { token });
  const items = res.body?.connections ?? [];
  const active = items.find(c => c.status === 'active');
  if (active) return active.id;

  // No active connection — create one using real credentials from env vars
  // (same approach as scripts/shell/ops/quick-setup.sh)
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
      label: `smoke-defaults-${Date.now()}`,
      secrets: { apiKey, secret, walletAddress },
      capability: 'trading',
    },
  });
  if (linkRes.status === 201 && linkRes.body.connection?.id) return linkRes.body.connection.id;
  throw new Error(`No active connection available and could not create one: ${linkRes.status}`);
}

function reactivateConnections(): void {
  execSync(
    `docker compose exec -T postgres psql -U herobids -d herobids -c "UPDATE connections SET status = 'active' WHERE provider = 'hyperliquid' AND status = 'revoked'"`,
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 },
  );
}

async function deleteAgent(token: string, agentId: string): Promise<void> {
  // Stop is best-effort — the agent may never have been started
  try { await apiRequest('POST', `/agents/${agentId}/stop`, { token }); } catch { /* ok */ }
  await new Promise(r => setTimeout(r, 3000));
  try { await apiRequest('DELETE', `/agents/${agentId}`, { token }); } catch { /* ok */ }
  // Wait for the deletion to settle before the next scenario
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

// ─── Shared create payload defaults ──────────────────────────────────────────

const CREATE_BASE = {
  provider: process.env['LLM_PROVIDER'] ?? 'ollama',
  lightModel: process.env['LLM_LIGHT_MODEL'] ?? 'qwen3:8b',
  heavyModel: process.env['LLM_HEAVY_MODEL'] ?? 'qwen3.6:35b-a3b-q4_K_M',
} as const;

// ─── Test record keeping ─────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  if (passed) ok(`${name}: ${detail}`);
  else fail(`${name}: ${detail}`);
}

// ─── Poll helpers ────────────────────────────────────────────────────────────

/**
 * Poll worker logs for candidatesScored > 0 within the given timeout.
 * Returns the agent ID for convenience.
 */
async function pollForCandidatesScored(
  agentId: string, since: string, timeoutMs = 120_000, pollIntervalMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = workerLogsSinceAgent(since, agentId);
    // Match any positive candidatesScored count (not zero)
    if (/candidatesScored:\s*([1-9]\d*)/.test(logs)) return true;
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  return false;
}

/**
 * Check that consecutive Technical phase complete timestamps in agent logs
 * are within expectedMs +/- toleranceMs.
 */
function checkScanIntervalInLogs(
  agentId: string, since: string, expectedMs: number, toleranceMs: number,
): { passed: boolean; detail: string } {
  const logs = workerLogsSinceAgent(since, agentId);
  const lines = logs.split('\n');
  const timestamps: number[] = [];
  for (const line of lines) {
    if (!line.includes('Technical phase complete')) continue;
    const match = line.match(/\[(\d{2}):(\d{2}):(\d{2})\]/);
    if (!match) continue;
    const [ , h, m, s ] = match;
    timestamps.push((parseInt(h!) * 3600 + parseInt(m!) * 60 + parseInt(s!)) * 1000);
  }
  if (timestamps.length < 3) {
    return { passed: false, detail: `only ${timestamps.length} timestamps found (need ≥3)` };
  }
  // Check gaps between consecutive timestamps
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    let gap = timestamps[i]! - timestamps[i - 1]!;
    if (gap < 0) gap += 24 * 3600 * 1000; // midnight wrap
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
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 1: Minimal config produces signals
// ═══════════════════════════════════════════════════════════════════════════════

async function scenario1_minimalConfigProducesSignals(token: string): Promise<void> {
  const connectionId = await getActiveConnectionId(token);
  const agentName = `smoke-defaults-${Date.now()}`;

  // 1. Create hybrid agent WITHOUT scanBatchSize or scanIntervalMs
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
      // ⚠️ Do NOT send scanBatchSize or scanIntervalMs — test defaults
    },
  });

  if (createRes.status !== 201 || !createRes.body.id) {
    record('s1-create', false, `create failed: ${createRes.status}`);
    return;
  }
  const agentId = createRes.body.id;
  log(`Created agent ${agentId}`);

  // 2. Start the agent
  const startRes = await apiRequest('POST', `/agents/${agentId}/start`, { token });
  if (startRes.status !== 200 && startRes.status !== 202) {
    record('s1-start', false, `start failed: ${startRes.status}`);
    await deleteAgent(token, agentId);
    return;
  }
  log('Agent started, waiting for active status...');

  const started = await pollAgentStatus(token, agentId, 'active', 30_000);
  if (!started) {
    record('s1-running', false, 'agent did not reach active status within 30s');
    await deleteAgent(token, agentId);
    return;
  }
  ok('Agent is active');

  // 3. Assert DB: scanBatchSize is exactly 5 (the Zod default)
  const scanBatchSize = agentTechnicalField(agentId, 'scanBatchSize');
  record('s1-db-defaults', scanBatchSize === '5',
    scanBatchSize === '5'
      ? `scanBatchSize=${scanBatchSize} — correct default`
      : `scanBatchSize=${scanBatchSize} (expected 5)`);

  // 4. Poll worker logs for candidatesScored > 0
  const since = new Date().toISOString();
  log('Polling worker logs for candidatesScored > 0 (up to 120s)...');
  const scored = await pollForCandidatesScored(agentId, since, 120_000, 5000);

  if (!scored) {
    record('s1-candidates', false, 'no candidatesScored > 0 found in worker logs within 120s');
  } else {
    record('s1-candidates', true, 'candidatesScored > 0 detected in worker logs');
  }

  // 5. Stop and delete
  await deleteAgent(token, agentId);
  reactivateConnections();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 2: Explicit values preserved
// ═══════════════════════════════════════════════════════════════════════════════

async function scenario2_explicitValuesPreserved(token: string): Promise<void> {
  const connectionId = await getActiveConnectionId(token);
  const agentName = `smoke-explicit-${Date.now()}`;

  // 1. Create hybrid agent with explicit scanBatchSize and scanIntervalMs
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
        filters: { venue: 'hyperliquid', venueType: 'orderbook' },
        scanBatchSize: 10,
        scanIntervalMs: 30_000,
      },
    },
  });

  if (createRes.status !== 201 || !createRes.body.id) {
    record('s2-create', false, `create failed: ${createRes.status}`);
    return;
  }
  const agentId = createRes.body.id;
  log(`Created agent ${agentId}`);

  // 2. Start the agent
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
  ok('Agent is active');

  // 3. Assert DB: stored values are exactly what we set
  const dbScanBatchSize = agentTechnicalField(agentId, 'scanBatchSize');
  const dbScanIntervalMs = agentTechnicalField(agentId, 'scanIntervalMs');

  const batchOk = dbScanBatchSize === '10';
  const intervalOk = dbScanIntervalMs === '30000';

  record('s2-db-explicit',
    batchOk && intervalOk,
    batchOk && intervalOk
      ? `scanBatchSize=${dbScanBatchSize}, scanIntervalMs=${dbScanIntervalMs} — correct`
      : `scanBatchSize=${dbScanBatchSize} (expected 10), scanIntervalMs=${dbScanIntervalMs} (expected 30000)`,
  );

  // 4. Poll worker logs for candidatesScored > 0
  const since = new Date().toISOString();
  log('Polling worker logs for candidatesScored > 0 (up to 120s)...');
  const scored = await pollForCandidatesScored(agentId, since, 120_000, 5000);

  record('s2-candidates', scored,
    scored ? 'candidatesScored > 0 detected' : 'no candidatesScored > 0 within 120s');

  // 5. Assert: scan log timestamps are ~30s apart (not 60s default)
  const intervalCheck = checkScanIntervalInLogs(agentId, since, 30_000, 10_000);
  record('s2-interval', intervalCheck.passed, intervalCheck.detail);

  // 6. Stop and delete
  await deleteAgent(token, agentId);
  reactivateConnections();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 3: Intelligence-mode agent unaffected
// ═══════════════════════════════════════════════════════════════════════════════

async function scenario3_intelligenceAgentUnaffected(token: string): Promise<void> {
  const agentName = `smoke-intel-${Date.now()}`;

  // 1. Create intelligence agent with NO technical block
  const createRes = await apiRequest<{ id?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: agentName,
      prompt: 'test',
      capabilityMode: 'intelligence',
      // ⚠️ No technical block, no connectionIds needed
    },
  });

  if (createRes.status !== 201 || !createRes.body.id) {
    record('s3-create', false, `create failed: ${createRes.status}`);
    return;
  }
  const agentId = createRes.body.id;
  log(`Created intelligence agent ${agentId}`);

  // 2. Start the agent
  const startTs = new Date().toISOString();
  const startRes = await apiRequest('POST', `/agents/${agentId}/start`, { token });
  if (startRes.status !== 200 && startRes.status !== 202) {
    record('s3-start', false, `start failed: ${startRes.status}`);
    await deleteAgent(token, agentId);
    return;
  }
  const started = await pollAgentStatus(token, agentId, 'active', 30_000);
  if (!started) {
    record('s3-running', false, 'agent did not reach active status within 30s');
    await deleteAgent(token, agentId);
    return;
  }
  ok('Intelligence agent is active');

  // 3. Assert DB: unified_config->'technical' IS NULL
  const techNull = agentTechnicalIsNull(agentId);
  record('s3-db-no-technical', techNull,
    techNull ? 'technical IS NULL — correct' : 'technical should be NULL but is present');

  // 4. Assert worker logs do NOT contain "Technical phase complete" for this agent
  // Wait a few seconds for logs to accumulate, then check
  await new Promise(r => setTimeout(r, 10_000));
  const agentLogs = workerLogsSinceAgent(startTs, agentId);
  const hasTechnicalPhase = agentLogs.includes('Technical phase complete');
  record('s3-no-technical-phase', !hasTechnicalPhase,
    hasTechnicalPhase
      ? 'intelligence agent should NOT have Technical phase complete in logs'
      : 'no Technical phase complete found — correct');

  // 5. Assert agent health — must be "active"
  const healthRes = await apiRequest<{ status?: string }>('GET', `/agents/${agentId}`, { token });
  const isHealthy = healthRes.body.status === 'active';
  record('s3-healthy', isHealthy,
    isHealthy ? `agent status is 'active' — healthy` : `agent status is '${healthRes.body.status}' — expected 'active'`);

  // 6. Stop and delete
  await deleteAgent(token, agentId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 4: PATCH preserves defaults
// ═══════════════════════════════════════════════════════════════════════════════

async function scenario4_patchPreservesDefaults(token: string): Promise<void> {
  const connectionId = await getActiveConnectionId(token);
  const agentName = `smoke-patch-${Date.now()}`;

  // 1. Create hybrid agent with minimal config (like scenario 1)
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
      // ⚠️ No scanBatchSize/scanIntervalMs — rely on defaults
    },
  });

  if (createRes.status !== 201 || !createRes.body.id) {
    record('s4-create', false, `create failed: ${createRes.status}`);
    return;
  }
  const agentId = createRes.body.id;
  log(`Created agent ${agentId}`);

  // 2. Start the agent and verify candidatesScored > 0
  let startRes = await apiRequest('POST', `/agents/${agentId}/start`, { token });
  if (startRes.status !== 200 && startRes.status !== 202) {
    record('s4-start', false, `start failed: ${startRes.status}`);
    await deleteAgent(token, agentId);
    return;
  }
  const started = await pollAgentStatus(token, agentId, 'active', 30_000);
  if (!started) {
    record('s4-running', false, 'agent did not reach active status within 30s');
    await deleteAgent(token, agentId);
    return;
  }
  ok('Agent is active');

  const since1 = new Date().toISOString();
  const scoredBefore = await pollForCandidatesScored(agentId, since1, 120_000, 5000);
  if (!scoredBefore) {
    record('s4-pre-patch', false, 'no candidatesScored > 0 before PATCH');
    await deleteAgent(token, agentId);
    reactivateConnections();
    return;
  }
  ok('candidatesScored > 0 before PATCH');

  // 3. Stop the agent before PATCH (must be stopped to update config)
  await apiRequest('POST', `/agents/${agentId}/stop`, { token });
  await new Promise(r => setTimeout(r, 3000));

  // 4. PATCH to change signalBias (nested under technical)
  const patchRes = await apiRequest<{ id?: string }>('PATCH', `/agents/${agentId}`, {
    token,
    body: {
      technical: { signalBias: 'mean-reverting' },
    },
  });
  if (patchRes.status !== 200) {
    record('s4-patch', false, `PATCH failed: ${patchRes.status}`);
    await deleteAgent(token, agentId);
    reactivateConnections();
    return;
  }
  ok('PATCH with signalBias succeeded');

  // 5. Assert DB: scanBatchSize and scanIntervalMs are still present
  const dbScanBatchSize = agentTechnicalField(agentId, 'scanBatchSize');
  const dbScanIntervalMs = agentTechnicalField(agentId, 'scanIntervalMs');
  const defaultsIntact = dbScanBatchSize !== null && dbScanIntervalMs !== null;
  record('s4-db-patch-preserved', defaultsIntact,
    defaultsIntact
      ? `scanBatchSize=${dbScanBatchSize}, scanIntervalMs=${dbScanIntervalMs} — preserved after PATCH`
      : `scanBatchSize=${dbScanBatchSize}, scanIntervalMs=${dbScanIntervalMs} — stripped by PATCH`);

  // 6. Restart and verify candidatesScored > 0 after PATCH
  startRes = await apiRequest('POST', `/agents/${agentId}/start`, { token });
  if (startRes.status !== 200 && startRes.status !== 202) {
    record('s4-restart', false, `restart failed: ${startRes.status}`);
    await deleteAgent(token, agentId);
    reactivateConnections();
    return;
  }
  const restarted = await pollAgentStatus(token, agentId, 'active', 30_000);
  if (!restarted) {
    record('s4-restart-running', false, 'agent did not reach active after PATCH restart');
    await deleteAgent(token, agentId);
    reactivateConnections();
    return;
  }

  const since2 = new Date().toISOString();
  const scoredAfter = await pollForCandidatesScored(agentId, since2, 120_000, 5000);
  record('s4-post-patch', scoredAfter,
    scoredAfter
      ? 'candidatesScored > 0 after PATCH restart'
      : 'no candidatesScored > 0 after PATCH restart');

  // 7. Stop and delete
  await deleteAgent(token, agentId);
  reactivateConnections();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const testStartedAt = new Date().toISOString();
  console.log(`\n${BOLD}=== Agent Config Defaults Smoke Test ===${RESET}`);
  console.log(`  API: ${API_BASE_URL}`);
  console.log('');

  section('Setup');
  const token = await authenticate();

  section('Scenario 1 — Minimal config produces signals');
  await scenario1_minimalConfigProducesSignals(token);

  section('Scenario 2 — Explicit values preserved');
  await scenario2_explicitValuesPreserved(token);

  section('Scenario 3 — Intelligence-mode agent unaffected');
  await scenario3_intelligenceAgentUnaffected(token);

  section('Scenario 4 — PATCH preserves defaults');
  await scenario4_patchPreservesDefaults(token);

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
