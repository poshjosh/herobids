/**
 * agent-scanner-gated-lifecycle-test.ts — E2E smoke test for scanner-gated agent
 * create→start→running lifecycle.
 *
 * Verifies the full contract between the API (chat/form route) and the worker:
 * a scanner-gated agent created with a strategy preset must produce a
 * unifiedConfig.technical that the worker accepts at startup.
 *
 * What it does
 * ────────────
 *  Scenario 1 (happy path)  — create scanner-gated agent → verify DB has
 *                             technical → start agent → poll until running
 *                             → stop + delete.
 *  Scenario 2 (guard)       — create scanner-gated agent WITHOUT a strategy
 *                             preset → expect the step-9 guard in
 *                             resolveUnifiedConfig to reject it.
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3000 TEST_EMAIL=a@b.com TEST_PASSWORD=... \
 *     tsx scripts/ts/agent-scanner-gated-lifecycle-test.ts
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
function fatal(msg: string): never { console.log(`${DIM}${ts()}${RESET}  ${RED}FATAL${RESET} ${msg}`); process.exit(1); }

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
  const regRes = await apiRequest<{ token?: string }>('POST', '/auth/register', { body: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: 'Scanner Gated Test' } });
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

function agentTechnicalExists(agentId: string): boolean {
  const raw = dbQuery(`SELECT (unified_config->'technical' IS NOT NULL AND jsonb_typeof(unified_config->'technical') = 'object')::text AS has_technical FROM agents WHERE id = '${agentId}'`);
  return raw.includes('\n t') || raw.includes('\nt');
}

function agentSessionStatus(agentId: string): string | null {
  try {
    // Sessions are stored in trading_instances or sessions table — check the
    // session status via the active session. We query the sessions table directly
    // for any session belonging to this agent.
    const raw = dbQuery(`SELECT status FROM trading_sessions WHERE agent_id = '${agentId}' ORDER BY created_at DESC LIMIT 1`);
    const lines = raw.split('\n');
    if (lines.length < 3) return null;
    return lines[2]?.trim() ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getActiveConnectionId(token: string): Promise<string> {
  const res = await apiRequest<{ connections?: Array<{ id: string; provider: string; status: string }> }>('GET', '/connections', { token });
  const items = res.body?.connections ?? [];
  const active = items.find(c => c.status === 'active');
  if (active) return active.id;

  // Create a Hyperliquid provider link if none exists
  const linkRes = await apiRequest<{ connection?: { id: string } }>('POST', '/setup/provider-link', {
    token,
    body: {
      provider: 'hyperliquid',
      label: `scanner-gated-test-${Date.now()}`,
      secrets: { apiKey: 'test', secret: 'test', walletAddress: '0x0000000000000000000000000000000000000000' },
      capability: 'trading',
    },
  });
  if (linkRes.status === 201 && linkRes.body.connection?.id) return linkRes.body.connection.id;
  throw new Error(`No active connection available and could not create one: ${linkRes.status}`);
}

async function deleteAgent(token: string, agentId: string): Promise<void> {
  try { await apiRequest('POST', `/agents/${agentId}/stop`, { token }); } catch { /* ok */ }
  await sleep(3000);
  try { await apiRequest('DELETE', `/agents/${agentId}`, { token }); } catch { /* ok */ }
  await sleep(1000);
}

function reactivateConnections(): void {
  execSync(
    `docker compose exec -T postgres psql -U herobids -d herobids -c "UPDATE connections SET status = 'active' WHERE provider = 'hyperliquid' AND status = 'revoked'"`,
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 },
  );
}

// ─── Shared create payload defaults ──────────────────────────────────────────

const CREATE_BASE = {
  provider: process.env['LLM_PROVIDER'] ?? 'ollama',
  lightModel: process.env['LLM_LIGHT_MODEL'] ?? 'qwen3:8b',
  heavyModel: process.env['LLM_HEAVY_MODEL'] ?? 'qwen3.6:35b-a3b-q4_K_M',
} as const;

// ---------------------------------------------------------------------------
// Results tracking
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

// ─── Scenario 1: Scanner-gated agent happy path ──────────────────────────────

async function scenario_scanner_gated_happy_path(token: string): Promise<void> {
  section('Scenario 1: Scanner-gated agent create → start → running');

  const connectionId = await getActiveConnectionId(token);
  const agentName = `sg-lifecycle-${Date.now()}`;

  // ── 1a. Create scanner-gated agent ─────────────────────────────────────
  log('Creating scanner-gated agent...');
  const createRes = await apiRequest<{ id?: string; error?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: agentName,
      prompt: 'test scanner-gated lifecycle',
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      strategyPreset: 'momentum',
      style: 'balanced',
      skillIds: ['trading'],
      connectionIds: [connectionId],
      executionDefaults: { mode: 'paper', slippageBps: 50 },
    },
  });

  if (createRes.status !== 201 || !createRes.body.id) {
    record('scanner-gated-happy', false, `create failed: ${createRes.status} — ${JSON.stringify(createRes.body)}`);
    return;
  }
  const agentId = createRes.body.id;
  ok(`Agent created: ${agentId}`);

  // ── 1b. Verify DB has technical config ─────────────────────────────────
  const hasTech = agentTechnicalExists(agentId);
  if (!hasTech) {
    record('scanner-gated-happy', false, 'unifiedConfig.technical missing in DB after creation');
    await deleteAgent(token, agentId);
    return;
  }
  ok('DB check: unifiedConfig.technical exists');

  // ── 1c. Start the agent ────────────────────────────────────────────────
  log('Starting agent...');
  const startRes = await apiRequest<{ status?: string; error?: string }>(
    'POST', `/agents/${agentId}/start`, { token },
  );
  if (startRes.status !== 202) {
    record('scanner-gated-happy', false, `start failed: ${startRes.status} — ${JSON.stringify(startRes.body)}`);
    await deleteAgent(token, agentId);
    return;
  }
  ok('Agent start requested');

  // ── 1d. Poll until session is running (up to 60 s) ─────────────────────
  log('Polling for running session...');
  let sessionRunning = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(3000);

    // Check agent status via API
    const agentRes = await apiRequest<{ status?: string; activeSession?: { status?: string } | null }>(
      'GET', `/agents/${agentId}`, { token },
    );
    const agentStatus = agentRes.body.status;
    const sessionStatus = agentRes.body.activeSession?.status ?? 'none';
    log(`  agent=${agentStatus}  session=${sessionStatus}`);

    if (agentStatus === 'crashed') {
      record('scanner-gated-happy', false, `agent crashed — worker rejected the config`);
      await deleteAgent(token, agentId);
      return;
    }

    if (sessionStatus === 'running') {
      sessionRunning = true;
      break;
    }

    // Also check DB for fallback
    const dbSession = agentSessionStatus(agentId);
    if (dbSession === 'running') {
      sessionRunning = true;
      break;
    }
    if (dbSession === 'crashed' || dbSession === 'stopped') {
      record('scanner-gated-happy', false, `DB session status='${dbSession}' — worker rejected the config`);
      await deleteAgent(token, agentId);
      return;
    }
  }

  if (!sessionRunning) {
    record('scanner-gated-happy', false, 'session did not reach running within 60 s');
    await deleteAgent(token, agentId);
    return;
  }

  ok('Session reached running — worker accepted the config');

  // ── 1e. Stop and delete ────────────────────────────────────────────────
  await deleteAgent(token, agentId);
  record('scanner-gated-happy', true, 'create → technical in DB → start → running → stopped');
}

// ─── Scenario 2: Scanner-gated agent without strategy preset (should fail) ───

async function scenario_scanner_gated_no_preset(token: string): Promise<void> {
  section('Scenario 2: Scanner-gated agent without strategy preset — expect rejection');

  const agentName = `sg-nopreset-${Date.now()}`;

  // Create scanner-gated agent WITHOUT strategyPreset — the step-9 guard in
  // resolveUnifiedConfig should reject this.
  const createRes = await apiRequest<{ id?: string; error?: string; message?: string }>('POST', '/agents', {
    token,
    body: {
      ...CREATE_BASE,
      name: agentName,
      prompt: 'test scanner-gated without preset',
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      style: 'balanced',
      executionDefaults: { mode: 'paper', slippageBps: 50 },
      // NO strategyPreset and NO technical — should be rejected
      // NO connectionIds — not needed for this negative test
    },
  });

  if (createRes.status === 400 || createRes.status === 422) {
    // The form route rejects at Zod validation level (capabilityMode=hybrid requires
    // technical or strategyPreset). The chat route would hit the step-9 guard.
    const body = createRes.body as Record<string, unknown>;
    const msg = typeof body.message === 'string' ? body.message : JSON.stringify(body);
    record('scanner-gated-no-preset', true, `correctly rejected: ${msg.slice(0, 120)}`);
    return;
  }

  // If it somehow succeeded, check the DB and clean up
  if (createRes.status === 201 && createRes.body.id) {
    record('scanner-gated-no-preset', false, 'agent was created but should have been rejected — guard not working');
    await deleteAgent(token, createRes.body.id);
    return;
  }

  record('scanner-gated-no-preset', false, `unexpected status: ${createRes.status}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n${BOLD}=== Agent Scanner-Gated Lifecycle Test ===${RESET}`);
  console.log(`  API: ${API_BASE_URL}`);
  console.log('');

  section('Setup');
  const token = await authenticate();

  await scenario_scanner_gated_happy_path(token);
  reactivateConnections();
  await scenario_scanner_gated_no_preset(token);
  reactivateConnections();

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
