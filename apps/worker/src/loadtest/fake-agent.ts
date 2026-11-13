/**
 * fake-agent.ts — a load-test stand-in for a real agent runtime (Hetzner
 * scale-path plan, task 5.1). It imposes the same *steady-state* load on the
 * control plane as an idle `apps/worker/src/agent.ts`, so a ramp of these
 * measures how many agents the control plane holds without running real LLM work.
 *
 * It deliberately mirrors the real agent's resource footprint:
 *   - 2 Redis clients (the primary + a `.duplicate()`), the same count the real
 *     agent opens (see agent.ts: `redis` and `wakeRedis`).
 *   - A small Postgres pool via the shared `createDatabase` (max 2, idle 30 s),
 *     matching the agent pool added in task 3.3.
 *   - A heartbeat every `HEARTBEAT_INTERVAL_MS` through the real inbound path
 *     (`agent:inbound:<AGENT_ID>` XADD with the same envelope + the
 *     `agent.runtime.heartbeat` type and `HeartbeatPayload` shape).
 *   - A light DB query at a configurable interval, standing in for the small
 *     per-tick reads an idle agent makes.
 *
 * STAGING ONLY. It makes no venue or LLM calls and places no orders. It is run
 * as a Nomad job whose ID starts with `loadtest-` (NEVER `agent-`): the worker's
 * Nomad adapter only manages `agent-` jobs (`fetchAgentJobs` filters on that
 * prefix), so these jobs are invisible to reconcile/stop and are cleaned up by
 * `scripts/loadtest/cleanup.sh`.
 *
 * Env (same names the real agent reads, plus load-test knobs):
 *   AGENT_ID, SESSION_ID         — required; use the synthetic `loadtest-` rows.
 *   REDIS_URL                    — required.
 *   DATABASE_URL                 — optional; when set, the DB query loop runs.
 *   HEARTBEAT_INTERVAL_MS        — default 5000 (config/default.yaml heartbeatIntervalMs).
 *   DB_QUERY_INTERVAL_MS         — default 15000; light read cadence.
 */
import Redis from 'ioredis';
import { createDatabase } from '@herobids/db';
import { sql } from 'drizzle-orm';
import { AGENT_MESSAGE_TYPES, AGENT_STREAM_MAXLEN } from '@herobids/domain';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // eslint-disable-next-line no-console
    console.error(`fake-agent: ${name} is required`);
    process.exit(1);
  }
  return value;
}

const AGENT_ID = required('AGENT_ID');
const SESSION_ID = required('SESSION_ID');
const REDIS_URL = required('REDIS_URL');
const DATABASE_URL = process.env['DATABASE_URL'];
const HEARTBEAT_INTERVAL_MS = Number(process.env['HEARTBEAT_INTERVAL_MS'] ?? '5000');
const DB_QUERY_INTERVAL_MS = Number(process.env['DB_QUERY_INTERVAL_MS'] ?? '15000');

if (!AGENT_ID.startsWith('loadtest-') && !SESSION_ID.startsWith('loadtest-')) {
  // Guard: refuse to run against identifiers that are not clearly synthetic, so a
  // misconfigured job can never pose as a real agent on the inbound stream.
  // eslint-disable-next-line no-console
  console.error('fake-agent: AGENT_ID or SESSION_ID must start with "loadtest-"; refusing to run');
  process.exit(1);
}

// Same two Redis clients as the real agent runtime.
const parsedRedisUrl = new URL(REDIS_URL);
const redis = new Redis({
  host: parsedRedisUrl.hostname || 'localhost',
  port: parseInt(parsedRedisUrl.port || '6379', 10),
  ...(parsedRedisUrl.password && { password: decodeURIComponent(parsedRedisUrl.password) }),
  ...(parsedRedisUrl.protocol === 'rediss:' && { tls: {} }),
  lazyConnect: false,
  maxRetriesPerRequest: 3,
});
const wakeRedis = redis.duplicate();

// Same small pool the real agent uses (task 3.3).
const db = DATABASE_URL ? createDatabase(DATABASE_URL, { max: 2, idleTimeoutSeconds: 30 }) : null;

const INBOUND_STREAM = `agent:inbound:${AGENT_ID}`;

async function publishToInbound(type: string, payload: Record<string, unknown>): Promise<void> {
  const envelope = {
    schemaVersion: 'v1',
    messageId: crypto.randomUUID(),
    correlationId: SESSION_ID,
    initiatorType: 'agent',
    initiatorId: AGENT_ID,
    agentId: AGENT_ID,
    type,
    createdAt: new Date().toISOString(),
    payload,
  };
  await redis.xadd(INBOUND_STREAM, 'MAXLEN', '~', AGENT_STREAM_MAXLEN, '*', 'envelope', JSON.stringify(envelope));
}

async function sendHeartbeat(): Promise<void> {
  try {
    await publishToInbound(AGENT_MESSAGE_TYPES.RUNTIME_HEARTBEAT, {
      sessionId: SESSION_ID,
      status: 'ready',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('fake-agent: heartbeat failed', err);
  }
}

async function lightDbQuery(): Promise<void> {
  if (!db) return;
  try {
    // A trivial read, standing in for the small per-tick queries a real idle agent makes.
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('fake-agent: db query failed', err);
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let dbTimer: ReturnType<typeof setInterval> | undefined;
let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  // eslint-disable-next-line no-console
  console.error(`fake-agent: ${signal} received, shutting down ${AGENT_ID}`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (dbTimer) clearInterval(dbTimer);
  try {
    await Promise.allSettled([redis.quit(), wakeRedis.quit()]);
  } catch {
    // best effort
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.error(
    `fake-agent: starting ${AGENT_ID} (session ${SESSION_ID}), heartbeat ${HEARTBEAT_INTERVAL_MS}ms, db ${db ? `${DB_QUERY_INTERVAL_MS}ms` : 'off'}`,
  );
  await sendHeartbeat();
  await lightDbQuery();
  heartbeatTimer = setInterval(() => void sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  if (db) {
    dbTimer = setInterval(() => void lightDbQuery(), DB_QUERY_INTERVAL_MS);
  }
}

void main();
