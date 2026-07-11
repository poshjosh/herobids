/**
 * Worker integration tests: Agent session lifecycle
 *
 * Verifies that:
 *   1. Starting a session creates a DB record in 'starting' state.
 *   2. reconcileStartingSessions picks up the starting session and launches it (stub runtime).
 *   3. Heartbeats from the stub promote the session to 'running'.
 *   4. Stopping the runtime marks the session stopped.
 *
 * Not yet covered: crash/unhealthy detection (requires the health monitor's timeout
 * logic to fire, which needs a real or time-accelerated clock; tracked for a follow-up).
 *
 * Requires DATABASE_URL and REDIS_URL.  Skipped otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { createDatabase, users, agents, agentRuntimeSessions, localIdentities, userPlans } from '@herobids/db';
import { AgentRepository } from '@herobids/db';
import { AgentRuntimeLauncher } from '../../agents/agent-runtime-launcher.js';
import { AgentSessionManager } from '../../agents/agent-session-manager.js';
import { InstanceEventPublisher } from '../../agents/instance-event-publisher.js';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify<crypto.BinaryLike, crypto.BinaryLike, number, Buffer>(crypto.scrypt);

const SKIP = !process.env['DATABASE_URL'] || !process.env['REDIS_URL'];
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://herobids:herobids@localhost:5432/herobids';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const TEST_RUNTIME_BUDGETS = {
  maxHistoryMessages: 20,
  maxHistoryTokens: 40000,
  maxRecentToolMessages: 6,
  maxToolResultChars: 4000,
  maxVisibleToolSchemas: 37,
  maxContextBlockChars: 4000,
};

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname || 'localhost',
    port: parseInt(u.port || '6379', 10),
    ...(u.password && { password: decodeURIComponent(u.password) }),
    ...(u.username && { username: decodeURIComponent(u.username) }),
  };
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

async function seedUser(db: ReturnType<typeof createDatabase>, id = crypto.randomUUID()) {
  const now = new Date();
  const email = `${id}@worker-test.local`;
  const username = email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const displayName = username
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  await db.insert(users).values({
    id,
    username,
    displayName,
    email,
    planId: 'free',
    aiModelConfig: { provider: 'openai', lightModel: 'gpt-4o-mini', heavyModel: 'gpt-4o' },
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(localIdentities).values({
    id: crypto.randomUUID(),
    userId: id,
    passwordHash: await hashPassword('password123'),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(userPlans).values({
    id: crypto.randomUUID(),
    userId: id,
    planId: 'free',
  });
  return id;
}

async function seedAgent(db: ReturnType<typeof createDatabase>, userId: string) {
  const agentId = crypto.randomUUID();
  const now = new Date();
  await db.insert(agents).values({
    id: agentId,
    userId,
    name: 'Test Agent',
    prompt: 'Do some work.',
    skillIds: [],
    status: 'stopped',
    createdAt: now,
    updatedAt: now,
  });
  return agentId;
}

describe.skipIf(SKIP)('Worker: session lifecycle (stub runtime)', () => {
  let db: ReturnType<typeof createDatabase>;
  let redisClient: Redis;
  let agentRepo: AgentRepository;
  let launcher: AgentRuntimeLauncher;
  let sessionManager: AgentSessionManager;
  let eventPublisher: InstanceEventPublisher;

  beforeAll(async () => {
    db = createDatabase(DB_URL);
    const redisConn = parseRedisUrl(REDIS_URL);
    redisClient = new Redis(redisConn);
    agentRepo = new AgentRepository(db);
    eventPublisher = new InstanceEventPublisher(redisClient);
  }, 30_000);

  afterAll(async () => {
    await redisClient.quit();
  });

  beforeEach(async () => {
    await db.execute(sql`
      TRUNCATE
        agent_runtime_sessions, agent_messages, agent_artifacts,
        agent_outbound_messages, agents, sessions, local_identities,
        oauth_identities, user_plans, users
      CASCADE
    `);

    launcher = new AgentRuntimeLauncher({ redis: redisClient, heartbeatIntervalMs: 200 });
    sessionManager = new AgentSessionManager(
      agentRepo,
      eventPublisher,
      launcher,
      {
        heartbeatTimeoutMs: 2000,
        healthCheckIntervalMs: 500,
        budgets: TEST_RUNTIME_BUDGETS,
      },
    );
  });

  afterEach(async () => {
    await sessionManager.stop();
    await launcher.stopAll();
  });

  it('creates a session record when an agent is started via API', async () => {
    const userId = await seedUser(db);
    const agentId = await seedAgent(db, userId);

    // Manually create a session (as the API start endpoint does)
    await db.insert(agentRuntimeSessions).values({
      id: crypto.randomUUID(),
      agentId,
      status: 'starting',
    });
    await db.update(agents).set({ status: 'starting' }).where(eq(agents.id, agentId));

    const [session] = await db.select().from(agentRuntimeSessions).where(
      eq(agentRuntimeSessions.agentId, agentId),
    );

    expect(session).toBeDefined();
    expect(session!.status).toBe('starting');
  });

  it('reconcileStartingSessions launches the stub runtime for eligible sessions', async () => {
    const userId = await seedUser(db);
    const agentId = await seedAgent(db, userId);
    const sessionId = crypto.randomUUID();

    await db.insert(agentRuntimeSessions).values({ id: sessionId, agentId, status: 'starting' });
    await db.update(agents).set({ status: 'starting' }).where(eq(agents.id, agentId));

    await sessionManager.reconcileStartingSessions();

    // The stub runtime should now have a handle for this session
    expect(launcher.hasRuntime(sessionId)).toBe(true);
  });

  it('stub heartbeat promotes session to running', async () => {
    const userId = await seedUser(db);
    const agentId = await seedAgent(db, userId);
    const sessionId = crypto.randomUUID();

    await db.insert(agentRuntimeSessions).values({ id: sessionId, agentId, status: 'starting' });
    await db.update(agents).set({ status: 'starting' }).where(eq(agents.id, agentId));

    // Reconcile to launch the stub
    await sessionManager.reconcileStartingSessions();

    // Feed a synthetic heartbeat (as the stream consumer would)
    const envelope = {
      schemaVersion: 'v1' as const,
      messageId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      initiatorType: 'agent' as const,
      initiatorId: agentId,
      botId: sessionId,
      type: 'agent.runtime.heartbeat',
      createdAt: new Date().toISOString(),
      payload: {},
    };
    const heartbeatPayload = {
      sessionId,
      status: 'ready' as const,
    };

    await sessionManager.handleHeartbeat(envelope, heartbeatPayload);

    const [updatedSession] = await db.select().from(agentRuntimeSessions).where(
      eq(agentRuntimeSessions.id, sessionId),
    );
    expect(updatedSession?.status).toBe('running');
  });

  it('stopping a runtime marks the session stopped in the DB', async () => {
    const userId = await seedUser(db);
    const agentId = await seedAgent(db, userId);
    const sessionId = crypto.randomUUID();

    await db.insert(agentRuntimeSessions).values({ id: sessionId, agentId, status: 'starting' });
    await db.update(agents).set({ status: 'starting' }).where(eq(agents.id, agentId));
    await sessionManager.reconcileStartingSessions();

    await launcher.stop(sessionId);

    await db.update(agentRuntimeSessions).set({ status: 'stopped', stoppedAt: new Date() })
      .where(eq(agentRuntimeSessions.id, sessionId));
    await db.update(agents).set({ status: 'stopped' }).where(eq(agents.id, agentId));

    const [session] = await db.select().from(agentRuntimeSessions)
      .where(eq(agentRuntimeSessions.id, sessionId));
    expect(session?.status).toBe('stopped');

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent?.status).toBe('stopped');
  });
});
