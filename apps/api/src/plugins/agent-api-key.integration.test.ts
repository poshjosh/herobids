import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import {
  createDatabase,
  users,
  sessions,
  agents,
  agentRuntimeSessions,
  generateAgentApiKey,
} from '@herobids/db';
import type { AuthConfig } from '@herobids/domain';
import { authPlugin, createSessionToken, requireUserCaller, requireSelfAgentOrUser } from './auth.js';
import { eventsRoutes } from '../routes/events.js';

const SKIP = !process.env['DATABASE_URL'];

const TEST_JWT_SECRET = 'test-secret-for-integration-tests-32ch!!';

function makeAuthConfig(): AuthConfig {
  return {
    publicBaseUrl: 'http://localhost:3000',
    frontendOrigin: 'http://localhost:5173',
    jwtSecret: TEST_JWT_SECRET,
    jwtTtlSecs: 3600,
    exchangeCodeTtlSecs: 60,
    googleClientId: 'test-client-id',
    googleClientSecret: 'test-client-secret',
    secureCookie: false,
    loginLinkTtlSecs: 600,
    loginLinkResendCooldownSecs: 60,
    loginLinkMaxSendsPerWindow: 5,
    loginLinkWindowSecs: 3600,
    loginLinkMaxSendsPerIpWindow: 10,
  };
}

type Db = ReturnType<typeof createDatabase>;

async function seedOwnerWithAgent(db: Db, runtimeStatus: string, apiKeyHash: string | null, agentStatus = 'active') {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userId = `owner-${suffix}`;
  const agentId = `agent-${suffix}`;
  const runtimeSessionId = `runtime-${suffix}`;
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    username: `owner_${suffix}`,
    displayName: 'Owner',
    email: `${userId}@agent-key.test.local`,
    planId: 'free',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(agents).values({
    id: agentId,
    userId,
    name: 'Key Agent',
    prompt: 'Do work.',
    skillIds: [],
    status: agentStatus,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(agentRuntimeSessions).values({
    id: runtimeSessionId,
    agentId,
    status: runtimeStatus,
    apiKeyHash,
    startedAt: now,
  });
  return { userId, agentId, runtimeSessionId };
}

async function seedUserSession(db: Db, userId: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
  });
  return sessionId;
}

describe.skipIf(SKIP)('agent API key authentication (integration)', () => {
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = createDatabase(process.env['DATABASE_URL']!);
    app = Fastify({ logger: false });
    await authPlugin(app, { config: makeAuthConfig(), db });
    // Probe routes. /protected opts in to agent keys so the identity assertions can run;
    // /probe-undeclared declares nothing, so agent keys must be refused by default.
    app.get('/protected', { config: { agentAccess: 'self' } }, async (request) => ({
      userId: request.userId,
      planId: request.userPlanId,
      isAdmin: request.isAdmin,
      actingAgentId: request.actingAgentId,
    }));
    app.get('/probe-undeclared', async () => ({ ok: true }));
    app.patch('/user-only', { preHandler: requireUserCaller }, async () => ({ ok: true }));
    // Probe for requireSelfAgentOrUser: an agent key may only address its own agent.
    app.get('/probe/agents/:id', { config: { agentAccess: 'self' }, preHandler: requireSelfAgentOrUser }, async (request) => ({
      id: (request.params as { id: string }).id,
    }));
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE agent_runtime_sessions, agents, sessions, users CASCADE`);
  });

  it('a valid agent key authenticates as the agent owner and sets actingAgentId', async () => {
    const { rawKey, keyHash } = generateAgentApiKey();
    const { userId, agentId } = await seedOwnerWithAgent(db, 'running', keyHash);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId, planId: 'free', isAdmin: false, actingAgentId: agentId });
  });

  it.each(['stopped', 'crashed'])('a key whose runtime session is %s is rejected with 401', async (status) => {
    const { rawKey, keyHash } = generateAgentApiKey();
    await seedOwnerWithAgent(db, status, keyHash);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it.each(['stopped', 'crashed'])('a key whose agent is %s is rejected with 401', async (agentStatus) => {
    const { rawKey, keyHash } = generateAgentApiKey();
    await seedOwnerWithAgent(db, 'running', keyHash, agentStatus);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('an unknown agent key is rejected with 401', async () => {
    const { rawKey } = generateAgentApiKey();

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('a user JWT still authenticates and leaves actingAgentId unset', async () => {
    const { userId } = await seedOwnerWithAgent(db, 'running', null);
    const sessionId = await seedUserSession(db, userId);
    const token = await createSessionToken(makeAuthConfig(), userId, sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userId, actingAgentId: null });
  });

  it('a key whose agent is paused is rejected with 401', async () => {
    const { rawKey, keyHash } = generateAgentApiKey();
    await seedOwnerWithAgent(db, 'running', keyHash, 'paused');

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it('an agent key on a route with no declared agentAccess is rejected with 403 (default-deny, probe)', async () => {
    const { rawKey, keyHash } = generateAgentApiKey();
    await seedOwnerWithAgent(db, 'running', keyHash);

    const res = await app.inject({
      method: 'GET',
      url: '/probe-undeclared',
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('an agent key on an unknown path is refused with 403, not a server error (probe)', async () => {
    const { rawKey, keyHash } = generateAgentApiKey();
    await seedOwnerWithAgent(db, 'running', keyHash);

    const res = await app.inject({
      method: 'GET',
      url: '/no-such-route',
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('a user JWT on a route with no declared agentAccess is allowed (probe)', async () => {
    const { userId } = await seedOwnerWithAgent(db, 'running', null);
    const sessionId = await seedUserSession(db, userId);
    const token = await createSessionToken(makeAuthConfig(), userId, sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/probe-undeclared',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
  });

  it('an agent key on a self-scoped route is allowed for its own agent id (probe)', async () => {
    const { rawKey, keyHash } = generateAgentApiKey();
    const { agentId } = await seedOwnerWithAgent(db, 'running', keyHash);

    const res = await app.inject({
      method: 'GET',
      url: `/probe/agents/${agentId}`,
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(res.statusCode).toBe(200);
  });

  it('an agent key on a self-scoped route with a mismatched agent id is rejected with 403 (probe)', async () => {
    const { rawKey, keyHash } = generateAgentApiKey();
    await seedOwnerWithAgent(db, 'running', keyHash);

    const res = await app.inject({
      method: 'GET',
      url: '/probe/agents/some-other-agent',
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('a user JWT on a self-scoped route is not restricted by agent id (probe)', async () => {
    const { userId } = await seedOwnerWithAgent(db, 'running', null);
    const sessionId = await seedUserSession(db, userId);
    const token = await createSessionToken(makeAuthConfig(), userId, sessionId);

    const res = await app.inject({
      method: 'GET',
      url: '/probe/agents/some-other-agent',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
  });

  it('an agent key on a user-only route is rejected with 403', async () => {
    const { rawKey, keyHash } = generateAgentApiKey();
    await seedOwnerWithAgent(db, 'running', keyHash);

    const res = await app.inject({
      method: 'PATCH',
      url: '/user-only',
      headers: { Authorization: `Bearer ${rawKey}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('a user JWT on a user-only route is allowed', async () => {
    const { userId } = await seedOwnerWithAgent(db, 'running', null);
    const sessionId = await seedUserSession(db, userId);
    const token = await createSessionToken(makeAuthConfig(), userId, sessionId);

    const res = await app.inject({
      method: 'PATCH',
      url: '/user-only',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
  });

  it('persists only the hash of the agent key, never the raw key', async () => {
    const { rawKey, keyHash } = generateAgentApiKey();
    const { runtimeSessionId } = await seedOwnerWithAgent(db, 'running', keyHash);

    const [row] = await db.select().from(agentRuntimeSessions).where(eq(agentRuntimeSessions.id, runtimeSessionId));

    expect(row?.apiKeyHash).toBe(keyHash);
    expect(JSON.stringify(row)).not.toContain(rawKey);
  });
});

describe.skipIf(SKIP)('events stream rejects agent keys (integration)', () => {
  let db: Db;
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    db = createDatabase(process.env['DATABASE_URL']!);
    app = Fastify({ logger: false });
    await authPlugin(app, { config: makeAuthConfig(), db });
    await eventsRoutes(app, makeAuthConfig(), () => ({
      subscribe: async () => {},
      unsubscribe: async () => {},
    }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('events test server has no TCP address');
    port = address.port;
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE agent_runtime_sessions, agents, sessions, users CASCADE`);
  });

  /** Resolves with the close code if the server closes the socket, or null if it stays open. */
  function connectEvents(token: string, waitMs = 500): Promise<number | null> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/events?token=${encodeURIComponent(token)}`);
      const timer = setTimeout(() => {
        socket.close();
        resolve(null);
      }, waitMs);
      socket.addEventListener('close', (event) => {
        clearTimeout(timer);
        resolve(event.code);
      });
    });
  }

  it('closes the socket with 4001 when an agent key is presented as the token', async () => {
    const { rawKey, keyHash } = generateAgentApiKey();
    await seedOwnerWithAgent(db, 'running', keyHash);

    expect(await connectEvents(rawKey)).toBe(4001);
  });

  it('keeps the socket open for a valid user JWT (control)', async () => {
    const { userId } = await seedOwnerWithAgent(db, 'running', null);
    const sessionId = await seedUserSession(db, userId);
    const token = await createSessionToken(makeAuthConfig(), userId, sessionId);

    expect(await connectEvents(token)).toBeNull();
  });
});
