/**
 * agent-config-matrix-test.ts — End-to-end config matrix test for agent technical/filters wiring.
 *
 * Verifies the full create/PATCH pipeline for all 6 agent-type × method combos:
 *   intelligence (POST)      — technical omitted, no filters expected
 *   intelligence (PATCH)     — technical:null clears existing technical
 *   hybrid-mixed (POST)      — preset fills technical → filters populated from connection
 *   hybrid-mixed (PATCH)     — preset fills technical, client sends technical:null, preset preserved, filters populated
 *   hybrid-scanner (POST)    — preset fills technical → filters populated from connection
 *   hybrid-scanner (PATCH)   — preset fills technical, client sends technical:null, preset preserved, filters populated
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3000 TEST_EMAIL=a@b.com TEST_PASSWORD=... \
 *     tsx scripts/ts/agent-config-matrix-test.ts
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
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://herobids:herobids@localhost:5432/herobids';

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

  // Log non-2xx responses for debugging
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
  const regRes = await apiRequest<{ token?: string }>('POST', '/auth/register', { body: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: 'Matrix Test' } });
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

function agentDbField(agentId: string, field: string): string | null {
  const raw = dbQuery(`SELECT ${field} FROM agents WHERE id = '${agentId}'`);
  // psql returns tabular format; extract value from last line after header
  const lines = raw.split('\n');
  if (lines.length < 3) return null;
  const val = lines[2]?.trim();
  return val === '' ? null : val;
}

function agentHasFilters(agentId: string): boolean {
  const raw = dbQuery(`SELECT (unified_config->'technical'->'filters' IS NOT NULL AND jsonb_typeof(unified_config->'technical'->'filters') = 'object')::text AS has_filters FROM agents WHERE id = '${agentId}'`);
  // psql output for boolean true: " t" on the data line; false: " f"
  return raw.includes('\n t') || raw.includes('\nt');
}

function agentTechnicalIsNull(agentId: string): boolean {
  const raw = dbQuery(`SELECT (unified_config->'technical' IS NULL)::text AS tech_null FROM agents WHERE id = '${agentId}'`);
  return raw.includes('\n t') || raw.includes('\nt');
}

function workerLogsSince(since: string): string {
  try {
    return execSync(
      `docker compose logs --since "${since}" worker 2>&1 | head -500 || true`,
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 },
    );
  } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Scenario runners
// ---------------------------------------------------------------------------

interface ScenarioResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: ScenarioResult[] = [];

function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  if (passed) ok(`${name}: ${detail}`);
  else fail(`${name}: ${detail}`);
}

async function deleteAgent(token: string, agentId: string): Promise<void> {
  // Stop is best-effort — the agent may never have been started
  try { await apiRequest('POST', `/agents/${agentId}/stop`, { token }); } catch { /* ok */ }
  await new Promise(r => setTimeout(r, 3000));
  try { await apiRequest('DELETE', `/agents/${agentId}`, { token }); } catch { /* ok */ }
  // Wait for the deletion to settle before the next scenario
  await new Promise(r => setTimeout(r, 1000));
}

/** Agent deletion cascade-revokes connections. Re-activate all Hyperliquid connections for the test user. */
function reactivateConnections(): void {
  execSync(
    `docker compose exec -T postgres psql -U herobids -d herobids -c "UPDATE connections SET status = 'active' WHERE provider = 'hyperliquid' AND status = 'revoked'"`,
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 },
  );
}

async function getActiveConnectionId(token: string): Promise<string> {
  const res = await apiRequest<{ connections?: Array<{ id: string; provider: string; status: string }> }>('GET', '/connections', { token });
  const items = res.body?.connections ?? [];
  const active = items.find(c => c.status === 'active');
  if (active) return active.id;
  // Create a Hyperliquid provider link if none exists or none active
  const linkRes = await apiRequest<{ connection?: { id: string } }>('POST', '/setup/provider-link', {
    token,
    body: {
      provider: 'hyperliquid',
      label: `matrix-test-${Date.now()}`,
      secrets: { apiKey: 'test', secret: 'test', walletAddress: '0x0000000000000000000000000000000000000000' },
      capability: 'trading',
    },
  });
  if (linkRes.status === 201 && linkRes.body.connection?.id) return linkRes.body.connection.id;
  throw new Error(`No active connection available and could not create one: ${linkRes.status}`);
}

// ─── Shared create payload defaults ──────────────────────────────────────────

const CREATE_BASE = {
  provider: process.env['LLM_PROVIDER'] ?? 'ollama',
  lightModel: process.env['LLM_LIGHT_MODEL'] ?? 'qwen3:8b',
  heavyModel: process.env['LLM_HEAVY_MODEL'] ?? 'qwen3.6:35b-a3b-q4_K_M',
} as const;

// ─── Scenario 1: intelligence POST ──────────────────────────────────────────

async function scenario_intelligence_post(token: string): Promise<void> {
  const res = await apiRequest<{ id?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: `matrix-intel-post-${Date.now()}`,
      prompt: 'test',
      capabilityMode: 'intelligence',
      // technical intentionally omitted
    },
  });
  if (res.status !== 201 || !res.body.id) { record('intel-post', false, `create failed: ${res.status}`); return; }
  const id = res.body.id;
  const hasTech = !agentTechnicalIsNull(id);
  record('intel-post', !hasTech, hasTech ? 'technical should be null but is not' : 'technical null, no filters — correct');
  await deleteAgent(token, id);
}

// ─── Scenario 2: intelligence PATCH ─────────────────────────────────────────

async function scenario_intelligence_patch(token: string): Promise<void> {
  // Create a hybrid agent with a preset (no connection needed — we only test config, not filters)
  const createRes = await apiRequest<{ id?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: `matrix-intel-patch-${Date.now()}`,
      prompt: 'test',
      capabilityMode: 'hybrid',
      hybridMode: 'mixed',
      strategyPreset: 'momentum',
      style: 'balanced',
      // No connectionIds — not needed for this test
    },
  });
  if (createRes.status !== 201 || !createRes.body.id) { record('intel-patch', false, `create failed: ${createRes.status}`); return; }
  const id = createRes.body.id;

  // PATCH to intelligence with technical:null — should clear technical
  const patchRes = await apiRequest('PATCH', `/agents/${id}`, {
    token,
    body: { capabilityMode: 'intelligence', hybridMode: null, technical: null },
  });
  if (patchRes.status !== 200) { record('intel-patch', false, `patch failed: ${patchRes.status}`); await deleteAgent(token, id); return; }

  const techNull = agentTechnicalIsNull(id);
  record('intel-patch', techNull, techNull ? 'technical cleared by null — correct' : 'technical should be null after intelligence PATCH');
  await deleteAgent(token, id);
}

// ─── Scenario 3: hybrid-mixed POST ──────────────────────────────────────────

async function scenario_hybrid_mixed_post(token: string): Promise<void> {
  const connectionId = await getActiveConnectionId(token);
  const res = await apiRequest<{ id?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: `matrix-hm-post-${Date.now()}`,
      prompt: 'test',
      capabilityMode: 'hybrid',
      hybridMode: 'mixed',
      strategyPreset: 'momentum',
      style: 'balanced',
      connectionIds: [connectionId],
    },
  });
  if (res.status !== 201 || !res.body.id) { record('hm-post', false, `create failed: ${res.status}`); return; }
  const id = res.body.id;
  const hasF = agentHasFilters(id);
  record('hm-post', hasF, hasF ? 'filters populated from connection — correct' : 'filters missing');
  await deleteAgent(token, id);
}

// ─── Scenario 4: hybrid-mixed PATCH ─────────────────────────────────────────

async function scenario_hybrid_mixed_patch(token: string): Promise<void> {
  const connectionId = await getActiveConnectionId(token);
  // Create a hybrid agent first
  const createRes = await apiRequest<{ id?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: `matrix-hm-patch-${Date.now()}`,
      prompt: 'test',
      capabilityMode: 'hybrid',
      hybridMode: 'mixed',
      strategyPreset: 'swing',
      style: 'balanced',
      connectionIds: [connectionId],
    },
  });
  if (createRes.status !== 201 || !createRes.body.id) { record('hm-patch', false, `create failed: ${createRes.status}`); return; }
  const id = createRes.body.id;

  // PATCH with new preset + technical:null (frontend default) — preset must survive
  const patchRes = await apiRequest('PATCH', `/agents/${id}`, {
    token,
    body: {
      strategyPreset: 'momentum',
      technical: null, // frontend default — must NOT delete preset's technical
    },
  });
  if (patchRes.status !== 200) { record('hm-patch', false, `patch failed: ${patchRes.status}`); await deleteAgent(token, id); return; }

  const hasF = agentHasFilters(id);
  const techNull = agentTechnicalIsNull(id);
  const passed = hasF && !techNull;
  const detail = passed ? 'preset preserved, filters populated — correct'
    : `tech_null=${techNull} has_filters=${hasF} — unexpected`;
  record('hm-patch', passed, detail);
  await deleteAgent(token, id);
}

// ─── Scenario 5: hybrid-scanner POST ────────────────────────────────────────

async function scenario_hybrid_scanner_post(token: string): Promise<void> {
  const connectionId = await getActiveConnectionId(token);
  const res = await apiRequest<{ id?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: `matrix-hs-post-${Date.now()}`,
      prompt: 'test',
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      strategyPreset: 'momentum',
      style: 'balanced',
      connectionIds: [connectionId],
    },
  });
  if (res.status !== 201 || !res.body.id) { record('hs-post', false, `create failed: ${res.status}`); return; }
  const id = res.body.id;
  const hasF = agentHasFilters(id);
  record('hs-post', hasF, hasF ? 'filters populated from connection — correct' : 'filters missing');
  await deleteAgent(token, id);
}

// ─── Scenario 6: hybrid-scanner PATCH ───────────────────────────────────────

async function scenario_hybrid_scanner_patch(token: string): Promise<void> {
  const connectionId = await getActiveConnectionId(token);
  const createRes = await apiRequest<{ id?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: `matrix-hs-patch-${Date.now()}`,
      prompt: 'test',
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      strategyPreset: 'swing',
      style: 'balanced',
      connectionIds: [connectionId],
    },
  });
  if (createRes.status !== 201 || !createRes.body.id) { record('hs-patch', false, `create failed: ${createRes.status}`); return; }
  const id = createRes.body.id;

  const patchRes = await apiRequest('PATCH', `/agents/${id}`, {
    token,
    body: {
      strategyPreset: 'momentum',
      technical: null, // frontend default — must NOT delete preset's technical
    },
  });
  if (patchRes.status !== 200) { record('hs-patch', false, `patch failed: ${patchRes.status}`); await deleteAgent(token, id); return; }

  const hasF = agentHasFilters(id);
  const techNull = agentTechnicalIsNull(id);
  const passed = hasF && !techNull;
  const detail = passed ? 'preset preserved, filters populated — correct'
    : `tech_null=${techNull} has_filters=${hasF} — unexpected`;
  record('hs-patch', passed, detail);
  await deleteAgent(token, id);
}

// ─── Worker log check ───────────────────────────────────────────────────────

function checkWorkerLogs(since: string): void {
  const logs = workerLogsSince(since);
  const discoveryErrors = (logs.match(/candidate discovery failed/g) ?? []).length;
  if (discoveryErrors > 0) {
    record('worker-logs', false, `${discoveryErrors} candidate discovery errors in worker logs`);
  } else {
    record('worker-logs', true, 'no candidate discovery errors');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const testStartedAt = new Date().toISOString();
  console.log(`\n${BOLD}=== Agent Config Matrix Test ===${RESET}`);
  console.log(`  API: ${API_BASE_URL}`);
  console.log('');

  section('Setup');
  const token = await authenticate();

  section('Scenario Matrix');
  await scenario_intelligence_post(token);
  await scenario_intelligence_patch(token);
  await scenario_hybrid_mixed_post(token); reactivateConnections();
  await scenario_hybrid_mixed_patch(token); reactivateConnections();
  await scenario_hybrid_scanner_post(token); reactivateConnections();
  await scenario_hybrid_scanner_patch(token); reactivateConnections();

  section('Worker Logs');
  checkWorkerLogs(testStartedAt);

  // ─── Report ──────────────────────────────────────────────────────────────
  section('Results');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  for (const r of results) {
    const icon = r.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`  ${icon} ${r.name}: ${r.detail}`);
  }
  console.log(`\n${BOLD}${passed}/${results.length} passed, ${failed} failed${RESET}\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(`${RED}FATAL: ${err instanceof Error ? err.message : String(err)}${RESET}`);
  process.exit(1);
});
