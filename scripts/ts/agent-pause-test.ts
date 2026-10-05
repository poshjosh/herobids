/**
 * agent-pause-test.ts — E2E test for agent pause / resume (bug 2026-10-05/001).
 *
 * Verifies against a running stack (API + worker + Postgres + Redis + agent
 * image) that a paused agent really stops working, survives a worker restart,
 * and re-engages on resume.
 *
 * What it does
 * ────────────
 *  1. Create a minimal agent (short tick interval) → start → wait for `active`
 *     and for the runtime's first `agent.tick.started` event.
 *  2. Pause → the runtime emits `agent.tick.skipped` with `gate: 'paused'`.
 *  3. While paused: send a user message, then observe a window. Expect more
 *     paused skips and NO `agent.tick.started` / `agent.llm.dispatch` /
 *     `agent.scout.*` events after the first paused skip.
 *  4. Restart the worker (opt out with PAUSE_TEST_RESTART_WORKER=0) → the agent
 *     must still be `paused` after the surviving session's first heartbeat.
 *  5. Resume → the first `agent.tick.started` after resume carries
 *     `hasWakeSignal: true` (forced full evaluation), followed by an
 *     `agent.llm.dispatch` (the held user message is answered).
 *  6. Stop + delete (unless SKIP_TEARDOWN=1).
 *
 * Runtime activity events are read from the `agent_messages` table via
 * `docker compose exec postgres psql`. Thresholds use the DB clock (`now()`),
 * so host/container clock skew does not matter.
 *
 * Note: the agent container runs the `herobids-agent:latest` image. If step 2
 * fails with no paused skip at all, the image is probably stale — rebuild it
 * with `docker build -f docker/Dockerfile.agent -t herobids-agent:latest .`.
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3000 TEST_EMAIL=a@b.com TEST_PASSWORD=... \
 *     tsx scripts/ts/agent-pause-test.ts
 *
 * Optional env:
 *   PAUSE_TEST_TICK_INTERVAL_MS   agent tick interval (default 10000)
 *   PAUSE_TEST_ACTIVE_TIMEOUT_S   wait for agent active + first tick (default 180)
 *   PAUSE_TEST_OBSERVE_S          paused observation window (default 40)
 *   PAUSE_TEST_RESUME_TIMEOUT_S   wait for first resumed tick (default 90; covers
 *                                 agentRuntime.pause.statusPollMs = 30s + slack)
 *   PAUSE_TEST_RESTART_WORKER     1 (default) to run the worker-restart step, 0 to skip
 *   SKIP_TEARDOWN                 1 to leave the agent in place for inspection
 */

import { execFileSync } from 'node:child_process';
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
const LLM_PROVIDER = process.env['LLM_PROVIDER'] ?? 'ollama';
const LLM_LIGHT_MODEL = process.env['LLM_LIGHT_MODEL'] ?? 'qwen3:8b';
const LLM_HEAVY_MODEL = process.env['LLM_HEAVY_MODEL'] ?? 'qwen3.6:35b-a3b-q4_K_M';
const TICK_INTERVAL_MS = intEnv('PAUSE_TEST_TICK_INTERVAL_MS', 10_000);
const ACTIVE_TIMEOUT_MS = intEnv('PAUSE_TEST_ACTIVE_TIMEOUT_S', 180) * 1000;
const OBSERVE_MS = intEnv('PAUSE_TEST_OBSERVE_S', 40) * 1000;
const RESUME_TIMEOUT_MS = intEnv('PAUSE_TEST_RESUME_TIMEOUT_S', 90) * 1000;
const RESTART_WORKER = (process.env['PAUSE_TEST_RESTART_WORKER'] ?? '1') === '1';
const SKIP_TEARDOWN = process.env['SKIP_TEARDOWN'] === '1';
const POLL_MS = 3_000;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface ApiResponse<T> { status: number; body: T; }

async function apiRequest<T>(
  method: string, route: string, options?: { body?: unknown; token?: string },
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options?.token) headers['Authorization'] = `Bearer ${options.token}`;
  const res = await fetch(`${API_BASE_URL}${route}`, {
    method,
    headers,
    ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const body = (contentType.includes('application/json') ? await res.json() : { text: await res.text() }) as T;
  if (res.status < 200 || res.status >= 300) {
    warn(`API ${method} ${route} → ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return { status: res.status, body };
}

async function authenticate(): Promise<string> {
  const login = await apiRequest<{ token?: string }>('POST', '/auth/login', { body: { email: TEST_EMAIL, password: TEST_PASSWORD } });
  if (login.status === 200 && login.body.token) {
    ok(`Logged in as ${TEST_EMAIL}`);
    return login.body.token;
  }
  const reg = await apiRequest<{ token?: string }>('POST', '/auth/register', { body: { email: TEST_EMAIL, password: TEST_PASSWORD, displayName: 'Pause Test' } });
  if (reg.status === 201 && reg.body.token) {
    ok(`Registered and logged in as ${TEST_EMAIL}`);
    return reg.body.token;
  }
  throw new Error(`Auth failed: login=${login.status} register=${reg.status}`);
}

// ---------------------------------------------------------------------------
// DB + docker helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f-]{8,64}$/i;

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'herobids', '-d', 'herobids', '-At', '-F', '|', '-c', sql],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15_000 },
  ).trim();
}

/** DB clock, as an ISO timestamp string usable in SQL comparisons. */
function dbNow(): string {
  return psql('SELECT to_char(now() AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\')');
}

function agentStatus(agentId: string): string {
  return psql(`SELECT status FROM agents WHERE id = '${agentId}'`);
}

interface ActivityRow { type: string; gate: string; hasWakeSignal: string; createdAt: string; }

/** Runtime activity events (inbound, agent→platform) for the agent since `sinceIso`. */
function activitySince(agentId: string, sinceIso: string): ActivityRow[] {
  const raw = psql(
    `SELECT type, coalesce(payload->>'gate',''), coalesce(payload->>'hasWakeSignal',''), `
    + `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') `
    + `FROM agent_messages WHERE agent_id = '${agentId}' `
    + `AND type IN ('agent.tick.started','agent.tick.skipped','agent.llm.dispatch','agent.scout.held','agent.scout.escalated') `
    + `AND created_at > '${sinceIso}'::timestamptz ORDER BY created_at ASC`,
  );
  if (raw.length === 0) return [];
  return raw.split('\n').map((line) => {
    const [type = '', gate = '', hasWakeSignal = '', createdAt = ''] = line.split('|');
    return { type, gate, hasWakeSignal, createdAt };
  });
}

const isPausedSkip = (row: ActivityRow) => row.type === 'agent.tick.skipped' && row.gate === 'paused';
const isDecisionWork = (row: ActivityRow) => row.type === 'agent.tick.started'
  || row.type === 'agent.llm.dispatch'
  || row.type.startsWith('agent.scout.');

async function waitFor<T>(label: string, timeoutMs: number, probe: () => T | null | Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await sleep(POLL_MS);
  }
  warn(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`);
  return null;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

interface CheckResult { name: string; passed: boolean; detail: string; }
const results: CheckResult[] = [];

function record(name: string, passed: boolean, detail: string): boolean {
  results.push({ name, passed, detail });
  if (passed) ok(`${name}: ${detail}`);
  else fail(`${name}: ${detail}`);
  return passed;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function createAndStartAgent(token: string): Promise<string> {
  section('1. Create + start agent');
  const create = await apiRequest<{ id?: string }>('POST', '/agents', {
    token,
    body: {
      name: `pause-test-${Date.now()}`,
      prompt: 'You are a test assistant. When a user sends you a message, reply with one short sentence using send_message. Otherwise do nothing.',
      provider: LLM_PROVIDER,
      lightModel: LLM_LIGHT_MODEL,
      heavyModel: LLM_HEAVY_MODEL,
      tickIntervalMs: TICK_INTERVAL_MS,
      skillIds: ['file-management'],
    },
  });
  if (create.status !== 201 || !create.body.id || !UUID_RE.test(create.body.id)) {
    throw new Error(`Agent create failed: ${create.status} ${JSON.stringify(create.body)}`);
  }
  const agentId = create.body.id;
  ok(`Agent created: ${agentId}`);

  const start = await apiRequest('POST', `/agents/${agentId}/start`, { token });
  if (start.status !== 202) throw new Error(`Agent start failed: ${start.status}`);
  ok('Agent start requested');
  return agentId;
}

async function waitForActiveAndTicking(agentId: string, startedAt: string): Promise<boolean> {
  const active = await waitFor('agent status active', ACTIVE_TIMEOUT_MS, () => {
    const status = agentStatus(agentId);
    if (status === 'crashed' || status === 'stopped') throw new Error(`Agent reached '${status}' before becoming active`);
    return status === 'active' ? status : null;
  });
  if (!record('agent-active', active !== null, active ? 'agent reached active' : 'agent never reached active')) return false;

  const tick = await waitFor('first agent.tick.started', ACTIVE_TIMEOUT_MS, () =>
    activitySince(agentId, startedAt).find((row) => row.type === 'agent.tick.started') ?? null);
  return record('runtime-ticking', tick !== null, tick ? `first tick at ${tick.createdAt}` : 'no agent.tick.started — runtime is not ticking');
}

async function pauseAndExpectPausedSkip(token: string, agentId: string): Promise<string | null> {
  section('2. Pause → paused tick');
  const pausedAt = dbNow();
  const pause = await apiRequest<{ status?: string }>('POST', `/agents/${agentId}/pause`, { token, body: { reason: 'pause-e2e-test' } });
  if (!record('pause-api', pause.status === 200 && agentStatus(agentId) === 'paused', `POST /pause → ${pause.status}, agents.status=${agentStatus(agentId)}`)) {
    return null;
  }

  // Detection happens at the next tick: one tick interval after the pause, plus
  // however long an in-flight (possibly LLM-bound) tick takes to finish.
  const firstSkip = await waitFor('agent.tick.skipped gate=paused', Math.max(TICK_INTERVAL_MS * 3 + 30_000, ACTIVE_TIMEOUT_MS), () =>
    activitySince(agentId, pausedAt).find(isPausedSkip) ?? null);
  record(
    'paused-tick-emitted',
    firstSkip !== null,
    firstSkip
      ? `tick_skipped gate=paused at ${firstSkip.createdAt}`
      : 'no paused tick_skipped — the runtime does not detect pause (stale herobids-agent image? rebuild it)',
  );
  return firstSkip?.createdAt ?? null;
}

async function observeWhilePaused(token: string, agentId: string, firstSkipAt: string): Promise<void> {
  section('3. While paused: user message + observation window');
  const message = await apiRequest('POST', `/agents/${agentId}/message`, { token, body: { message: 'Pause test: please reply after you are resumed.' } });
  record('message-accepted-while-paused', message.status === 202, `POST /message → ${message.status}`);

  log(`Observing for ${OBSERVE_MS / 1000}s…`);
  await sleep(OBSERVE_MS);

  const rows = activitySince(agentId, firstSkipAt);
  const work = rows.filter(isDecisionWork);
  const pausedSkips = rows.filter(isPausedSkip).length;
  record(
    'no-decision-work-while-paused',
    work.length === 0,
    work.length === 0
      ? 'no tick.started / llm.dispatch / scout events after the first paused skip (user message did not wake the agent)'
      : `unexpected events while paused: ${work.map((r) => `${r.type}@${r.createdAt}`).join(', ')}`,
  );
  record(
    'paused-ticks-continue',
    pausedSkips >= 1,
    `${pausedSkips} further paused skip(s) in ${OBSERVE_MS / 1000}s (tick interval ${TICK_INTERVAL_MS / 1000}s)`,
  );
  record('status-still-paused', agentStatus(agentId) === 'paused', `agents.status=${agentStatus(agentId)}`);
}

function workerLogsSince(sinceEpochS: number): string {
  try {
    return execFileSync('docker', ['compose', 'logs', 'worker', '--no-color', '--since', String(sinceEpochS)], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    warn(`Could not read worker logs: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

const PAUSED_RECOVERY_LOG = 'session activated without changing agent status';

/**
 * Matches the session manager's paused-recovery log line for this agent in
 * either JSON logs (one line) or pino-pretty dev logs (fields on following lines).
 */
function hasPausedRecoveryLog(logs: string, agentId: string): boolean {
  const lines = logs.split('\n');
  return lines.some((line, index) => line.includes(PAUSED_RECOVERY_LOG)
    && lines.slice(index, index + 4).some((candidate) => candidate.includes(agentId)));
}

async function restartWorkerAndExpectStillPaused(agentId: string): Promise<void> {
  section('4. Worker restart keeps the agent paused');
  if (!RESTART_WORKER) {
    warn('PAUSE_TEST_RESTART_WORKER=0 — skipping worker restart step');
    return;
  }
  const restartEpochS = Math.floor(Date.now() / 1000);
  log('Restarting worker (docker compose restart worker)…');
  execFileSync('docker', ['compose', 'restart', 'worker'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });

  // The surviving session's first heartbeat on the new worker takes the
  // recovery path that used to overwrite paused → active.
  let flippedTo: string | null = null;
  const recovered = await waitFor('worker recovery heartbeat for the paused agent', 120_000, () => {
    const status = agentStatus(agentId);
    if (status !== 'paused') {
      flippedTo = status;
      return 'flipped';
    }
    return hasPausedRecoveryLog(workerLogsSince(restartEpochS), agentId) ? 'recovered' : null;
  });

  if (recovered === 'flipped') {
    record('paused-survives-worker-restart', false, `agents.status changed to '${flippedTo}' after worker restart`);
    return;
  }
  if (recovered === null) {
    // No log confirmation (log format/permissions); fall back to a status check
    // after enough heartbeats for recovery to have happened.
    const status = agentStatus(agentId);
    record('paused-survives-worker-restart', status === 'paused', `no recovery log line seen; agents.status=${status} 120s after restart`);
    return;
  }
  await sleep(10_000);
  const status = agentStatus(agentId);
  record('paused-survives-worker-restart', status === 'paused', `recovery heartbeat processed; agents.status=${status}`);
}

async function resumeAndExpectFullEvaluation(token: string, agentId: string): Promise<void> {
  section('5. Resume → full evaluation');
  const resumedAt = dbNow();
  const resume = await apiRequest('POST', `/agents/${agentId}/resume`, { token });
  if (!record('resume-api', resume.status === 200 && agentStatus(agentId) === 'active', `POST /resume → ${resume.status}, agents.status=${agentStatus(agentId)}`)) {
    return;
  }

  const firstTick = await waitFor('first agent.tick.started after resume', RESUME_TIMEOUT_MS, () =>
    activitySince(agentId, resumedAt).find((row) => row.type === 'agent.tick.started') ?? null);
  if (!firstTick) {
    record('resumed-tick', false, `no tick.started within ${RESUME_TIMEOUT_MS / 1000}s of resume`);
    return;
  }
  record('resumed-tick', true, `tick.started at ${firstTick.createdAt}`);
  record(
    'resumed-tick-forced-full-evaluation',
    firstTick.hasWakeSignal === 'true',
    `first resumed tick hasWakeSignal=${firstTick.hasWakeSignal} (expected true: bypasses the context-hash gate)`,
  );

  const dispatch = await waitFor('agent.llm.dispatch after resume', 60_000, () =>
    activitySince(agentId, resumedAt).find((row) => row.type === 'agent.llm.dispatch') ?? null);
  record(
    'resumed-llm-dispatch',
    dispatch !== null,
    dispatch ? `LLM dispatched at ${dispatch.createdAt} (held user message is answered)` : 'no llm.dispatch after resume',
  );
}

async function teardown(token: string, agentId: string): Promise<void> {
  section('6. Teardown');
  if (SKIP_TEARDOWN) {
    warn(`SKIP_TEARDOWN=1 — leaving agent ${agentId} in place`);
    return;
  }
  await apiRequest('POST', `/agents/${agentId}/stop`, { token }).catch(() => undefined);
  await sleep(3_000);
  await apiRequest('DELETE', `/agents/${agentId}`, { token }).catch(() => undefined);
  ok(`Agent ${agentId} stopped and deleted`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n${BOLD}=== Agent Pause / Resume E2E Test ===${RESET}`);
  console.log(`  API: ${API_BASE_URL}   tick interval: ${TICK_INTERVAL_MS / 1000}s   restart worker: ${RESTART_WORKER ? 'yes' : 'no'}`);

  section('Setup');
  const token = await authenticate();
  const startedAt = dbNow();
  const agentId = await createAndStartAgent(token);

  try {
    if (await waitForActiveAndTicking(agentId, startedAt)) {
      const firstSkipAt = await pauseAndExpectPausedSkip(token, agentId);
      if (firstSkipAt) {
        await observeWhilePaused(token, agentId, firstSkipAt);
        await restartWorkerAndExpectStillPaused(agentId);
        await resumeAndExpectFullEvaluation(token, agentId);
      }
    }
  } finally {
    await teardown(token, agentId);
  }

  section('Results');
  const failed = results.filter((r) => !r.passed);
  for (const r of results) {
    console.log(`  ${r.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} ${r.name}: ${r.detail}`);
  }
  console.log(`\n${BOLD}${results.length - failed.length}/${results.length} passed, ${failed.length} failed${RESET}\n`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(`${RED}FATAL: ${err instanceof Error ? err.message : String(err)}${RESET}`);
  process.exit(1);
});
