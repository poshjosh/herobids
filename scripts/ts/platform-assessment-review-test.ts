/**
 * platform-assessment-review-test.ts — E2E gating tests for the data-only
 * platform assessment review screen (herobids plan 002 H3).
 *
 * The preset assessment itself moved to Traderton (data-only, free). Herobids
 * keeps the review screen, which gates on the creator's opt-in + the agent's
 * capability mode. This test covers ONLY that gating — the data-only assessment
 * behaviour (flags, cache, cooldown, change gates) is covered by Traderton's
 * unit + integration tests and its cross-stack verification.
 *
 * Scenarios:
 *   G1  Non-hybrid agent → eligibility canTrigger=false (hybrid reason);
 *       POST /reviews → 403 capability_mode_unsupported.
 *   G2  Hybrid agent opted out (platformAssessment.enabled=false) →
 *       eligibility canTrigger=false (opt-in reason); POST → 403 agent_not_opted_in.
 *   G3  Hybrid + opted-in + active + running session → eligibility canTrigger=true.
 *
 * Tier 3 (API + DB): no worker, no venue keys, no traderton boundary needed —
 * the gating fires before any boundary call.
 *
 * Usage:
 *   SCENARIOS=G1,G2,G3 tsx scripts/ts/platform-assessment-review-test.ts
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
const SCENARIOS = (process.env['SCENARIOS'] ?? 'G1,G2,G3').split(',').map(s => s.trim());

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
  const regRes = await apiRequest<{ token?: string }>('POST', '/auth/register', { body: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: 'Assessment Review Test' } });
  if (regRes.status === 201 && regRes.body.token) { ok(`Registered and logged in as ${TEST_EMAIL}`); return regRes.body.token; }
  fatal(`Auth failed: login=${loginRes.status} register=${regRes.status}`);
}

// ---------------------------------------------------------------------------
function dbExec(sql: string): string {
  return execSync(`docker compose exec -T postgres psql -U herobids -d herobids -c "${sql.replace(/"/g, '\\"')}"`, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 }).trim();
}

async function createAgent(token: string): Promise<string> {
  const res = await apiRequest<{ id?: string }>('POST', '/agents', { token, body: {
    name: `AssessReview-${Date.now()}`, prompt: 'Test agent. Do not trade.',
  }});
  if (res.status === 201 && res.body.id) { ok(`Agent created — ${res.body.id}`); return res.body.id; }
  fatal(`Agent creation failed: ${res.status} ${JSON.stringify(res.body)}`);
}

/** Seed unifiedConfig capabilityMode + platformAssessment, and set status. */
function configureAgent(agentId: string, capabilityMode: 'hybrid' | 'intelligence', platformAssessmentEnabled: boolean): void {
  dbExec(`UPDATE agents SET status = 'active', unified_config = COALESCE(unified_config, '{}'::jsonb) || '{"capabilityMode": "${capabilityMode}", "platformAssessment": {"enabled": ${platformAssessmentEnabled}}}'::jsonb WHERE id = '${agentId}'`);
}

/** Seed a running runtime session so the eligibility gate passes. */
function seedRunningSession(agentId: string): void {
  dbExec(`INSERT INTO agent_runtime_sessions (id, agent_id, status) VALUES ('sess-${agentId}', '${agentId}', 'running') ON CONFLICT (id) DO NOTHING`);
}

async function stopAndDeleteAgent(token: string, agentId: string): Promise<void> {
  try { await apiRequest('POST', `/agents/${agentId}/stop`, { token }); } catch { /* ok */ }
  await sleep(1000);
  try { await apiRequest('DELETE', `/agents/${agentId}`, { token }); } catch { /* ok */ }
  await sleep(1000);
}

// ---------------------------------------------------------------------------
interface TR { scenario: string; passed: boolean; detail: string; }
const results: TR[] = [];
function record(scenario: string, passed: boolean, detail: string): void {
  results.push({ scenario, passed, detail });
  if (passed) ok(`${scenario}: ${detail}`); else fail(`${scenario}: ${detail}`);
}

// ---------------------------------------------------------------------------
async function runG1(token: string): Promise<void> {
  section('G1: Non-hybrid agent blocked (capability_mode_unsupported)');

  const agentId = await createAgent(token);
  configureAgent(agentId, 'intelligence', true);

  const elig = await apiRequest<{ canTrigger?: boolean; reason?: string | null }>('GET', `/agents/${agentId}/platform-assessment/reviews/eligibility`, { token });
  const reasonText = typeof elig.body?.reason === 'string' ? elig.body.reason : '';
  const eligOk = elig.body?.canTrigger === false && reasonText.toLowerCase().includes('hybrid');
  record('G1-eligibility', eligOk, `canTrigger=${elig.body?.canTrigger} reason=[${reasonText}]`);

  const post = await apiRequest('POST', `/agents/${agentId}/platform-assessment/reviews`, { token, body: { symbols: ['BTC'], venueFamily: 'hyperliquid' } });
  record('G1-post', post.status === 403 && (post.body as { error?: string })?.error === 'capability_mode_unsupported',
    `POST → ${post.status} ${(post.body as { error?: string })?.error ?? ''}`);

  await stopAndDeleteAgent(token, agentId);
}

async function runG2(token: string): Promise<void> {
  section('G2: Opted-out hybrid agent blocked (agent_not_opted_in)');

  const agentId = await createAgent(token);
  configureAgent(agentId, 'hybrid', false);

  const elig = await apiRequest<{ canTrigger?: boolean; reason?: string | null }>('GET', `/agents/${agentId}/platform-assessment/reviews/eligibility`, { token });
  const reasonText = typeof elig.body?.reason === 'string' ? elig.body.reason : '';
  const eligOk = elig.body?.canTrigger === false && reasonText.toLowerCase().includes('not enabled');
  record('G2-eligibility', eligOk, `canTrigger=${elig.body?.canTrigger} reason=[${reasonText}]`);

  const post = await apiRequest('POST', `/agents/${agentId}/platform-assessment/reviews`, { token, body: { symbols: ['BTC'], venueFamily: 'hyperliquid' } });
  record('G2-post', post.status === 403 && (post.body as { error?: string })?.error === 'agent_not_opted_in',
    `POST → ${post.status} ${(post.body as { error?: string })?.error ?? ''}`);

  await stopAndDeleteAgent(token, agentId);
}

async function runG3(token: string): Promise<void> {
  section('G3: Hybrid + opted-in + active + running session → canTrigger=true');

  const agentId = await createAgent(token);
  configureAgent(agentId, 'hybrid', true);
  seedRunningSession(agentId);

  const elig = await apiRequest<{ canTrigger?: boolean; reason?: string | null }>('GET', `/agents/${agentId}/platform-assessment/reviews/eligibility`, { token });
  record('G3-eligibility', elig.body?.canTrigger === true,
    `canTrigger=${elig.body?.canTrigger} reason=[${typeof elig.body?.reason === 'string' ? elig.body.reason : ''}]`);

  await stopAndDeleteAgent(token, agentId);
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  log(`Scenarios: ${SCENARIOS.join(', ')}`);

  // Clean up leftover agents (FK order: billing_usage_events → agents).
  dbExec("DELETE FROM billing_usage_events; UPDATE agents SET status = 'stopped' WHERE status NOT IN ('stopped', 'crashed'); DELETE FROM agents;");
  log('Cleaned up leftover agents');

  const token = await authenticate();

  if (SCENARIOS.includes('G1')) await runG1(token);
  if (SCENARIOS.includes('G2')) await runG2(token);
  if (SCENARIOS.includes('G3')) await runG3(token);

  console.log(`\n${BOLD}${CYAN}═══════════════════════════════════════${RESET}`);
  console.log(`${BOLD}${CYAN}  Results${RESET}`);
  console.log(`${BOLD}${CYAN}═══════════════════════════════════════${RESET}`);
  let p = 0, f = 0;
  for (const r of results) { if (r.passed) { console.log(`  ${GREEN}✓${RESET} ${r.scenario}: ${r.detail}`); p++; } else { console.log(`  ${RED}✗${RESET} ${r.scenario}: ${r.detail}`); f++; } }
  console.log(`\n${BOLD}${p} passed, ${f} failed, ${results.length} total${RESET}`);
  if (f > 0) process.exit(1);
}
main().catch(err => { console.error(`${RED}FATAL: ${err instanceof Error ? err.message : String(err)}${RESET}`); process.exit(1); });