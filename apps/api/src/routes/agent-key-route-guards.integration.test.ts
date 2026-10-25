import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { Redis } from 'ioredis';
import {
  createDatabase,
  users,
  sessions,
  agents,
  agentRuntimeSessions,
  generateAgentApiKey,
} from '@herobids/db';
import type { AuthConfig } from '@herobids/domain';
import { authPlugin, createSessionToken } from '../plugins/auth.js';
import { agentRoutes } from './agents.js';
import { agentInteractivityRoutes } from './agent-interactivity.js';
import { sessionRoutes } from './sessions.js';

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

interface Fixture {
  userId: string;
  agentId: string;
  runtimeSessionId: string;
  rawKey: string;
}

async function seedFixture(db: Db): Promise<Fixture> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userId = `owner-${suffix}`;
  const agentId = `agent-${suffix}`;
  const runtimeSessionId = `runtime-${suffix}`;
  const { rawKey, keyHash } = generateAgentApiKey();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    username: `owner_${suffix}`,
    displayName: 'Owner',
    email: `${userId}@agent-route-guards.test.local`,
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
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(agentRuntimeSessions).values({
    id: runtimeSessionId,
    agentId,
    status: 'running',
    apiKeyHash: keyHash,
    startedAt: now,
  });
  return { userId, agentId, runtimeSessionId, rawKey };
}

async function userToken(db: Db, userId: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
  });
  return createSessionToken(makeAuthConfig(), userId, sessionId);
}

interface DeniedRoute {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: (f: Fixture) => string;
  payload?: Record<string, unknown>;
}

/** Every route an agent key must be refused on (user-only routes and routes not yet opened to agents). */
const AGENT_KEY_DENIED_ROUTES: DeniedRoute[] = [
  { name: 'PATCH /agents/:id', method: 'PATCH', url: (f) => `/agents/${f.agentId}`, payload: { name: 'x' } },
  { name: 'DELETE /agents/:id', method: 'DELETE', url: (f) => `/agents/${f.agentId}` },
  { name: 'POST /agents/:id/resume', method: 'POST', url: (f) => `/agents/${f.agentId}/resume` },
  { name: 'POST /agents/:id/start', method: 'POST', url: (f) => `/agents/${f.agentId}/start` },
  { name: 'PUT /agents/:id (agent-interactivity)', method: 'PUT', url: (f) => `/agents/${f.agentId}`, payload: {} },
  { name: 'POST /agents', method: 'POST', url: () => '/agents', payload: { name: 'child', prompt: 'p' } },
  {
    name: 'POST /agents/:id/approvals/:approvalId/approve',
    method: 'POST',
    url: (f) => `/agents/${f.agentId}/approvals/appr-1/approve`,
  },
  {
    name: 'POST /agents/:id/approvals/:approvalId/reject',
    method: 'POST',
    url: (f) => `/agents/${f.agentId}/approvals/appr-1/reject`,
  },
  { name: 'POST /agents/:id/pause', method: 'POST', url: (f) => `/agents/${f.agentId}/pause` },
  { name: 'POST /agents/:id/stop', method: 'POST', url: (f) => `/agents/${f.agentId}/stop` },
  { name: 'POST /agents/:id/go-live', method: 'POST', url: (f) => `/agents/${f.agentId}/go-live`, payload: {} },
  { name: 'POST /agents/:id/blueprints', method: 'POST', url: (f) => `/agents/${f.agentId}/blueprints`, payload: {} },
  { name: 'POST /agents/:id/message', method: 'POST', url: (f) => `/agents/${f.agentId}/message`, payload: { content: 'hi' } },
];

describe.skipIf(SKIP)('agent key route guards (integration)', () => {
  let db: Db;
  let app: FastifyInstance;
  let redis: Redis;
  let fixture: Fixture;

  beforeAll(async () => {
    db = createDatabase(process.env['DATABASE_URL']!);
    // lazyConnect: the route guards refuse agent keys before any Redis call is made.
    redis = new Redis({ lazyConnect: true });
    app = Fastify({ logger: false });
    await authPlugin(app, { config: makeAuthConfig(), db });
    await agentRoutes(app, db);
    await agentInteractivityRoutes(app, db, redis);
    await sessionRoutes(app, db);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    redis.disconnect();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE agent_runtime_sessions, agents, sessions, users CASCADE`);
    fixture = await seedFixture(db);
  });

  it.each(AGENT_KEY_DENIED_ROUTES)('an agent key gets 403 on $name', async ({ method, url, payload }) => {
    const res = await app.inject({
      method,
      url: url(fixture),
      headers: { Authorization: `Bearer ${fixture.rawKey}` },
      ...(payload ? { payload } : {}),
    });

    expect(res.statusCode).toBe(403);
  });

  it('a user JWT still reaches approve (unknown approval returns 404, not 403)', async () => {
    const token = await userToken(db, fixture.userId);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${fixture.agentId}/approvals/appr-missing/approve`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('GET /sessions/:id omits apiKeyHash from the runtime session', async () => {
    const token = await userToken(db, fixture.userId);

    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${fixture.runtimeSessionId}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { session: Record<string, unknown> };
    expect(body.session['id']).toBe(fixture.runtimeSessionId);
    expect(body.session).not.toHaveProperty('apiKeyHash');
    expect(res.body).not.toContain('apiKeyHash');
  });

  it('GET /agents/:id omits apiKeyHash from the active session projection', async () => {
    const token = await userToken(db, fixture.userId);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${fixture.agentId}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { activeSession: Record<string, unknown> | null };
    expect(body.activeSession?.['id']).toBe(fixture.runtimeSessionId);
    expect(body.activeSession).not.toHaveProperty('apiKeyHash');
    expect(res.body).not.toContain('apiKeyHash');
  });
});
