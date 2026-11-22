import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
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
  connections,
  generateAgentApiKey,
} from '@herobids/db';
import type { AuthConfig } from '@herobids/domain';
import { AgentCreationConfigSchema } from '@herobids/domain';
import { authPlugin, createSessionToken } from '../plugins/auth.js';
import { agentRoutes } from './agents.js';

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

async function buildApp(db: Db, redis: Redis): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await authPlugin(app, { config: makeAuthConfig(), db });
  const agentCreation = AgentCreationConfigSchema.parse({});
  await agentRoutes(
    app,
    db,
    undefined,
    undefined,
    undefined,
    redis,
    { provider: 'openai' },
    undefined,
    undefined,
    undefined,
    undefined,
    agentCreation,
  );
  await app.ready();
  return app;
}

async function seedUser(db: Db): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userId = `owner-${suffix}`;
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    username: `owner_${suffix}`,
    displayName: 'Owner',
    email: `${userId}@child-allowance.test.local`,
    planId: 'free',
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

interface SeededAgent {
  agentId: string;
  rawKey: string;
}

async function seedAgent(
  db: Db,
  userId: string,
  options: { parentAgentId?: string; childAgentLimit?: number; withKey?: boolean; grantAnyConnectionToChildren?: boolean } = {},
): Promise<SeededAgent> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const agentId = `agent-${suffix}`;
  const now = new Date();
  await db.insert(agents).values({
    id: agentId,
    userId,
    name: `Agent ${suffix}`,
    prompt: `allowance prompt ${suffix}`,
    skillIds: [],
    status: 'active',
    creatorType: options.parentAgentId ? 'agent' : 'user',
    creatorId: options.parentAgentId ?? userId,
    parentAgentId: options.parentAgentId ?? null,
    depth: options.parentAgentId ? 1 : 0,
    childAgentLimit: options.childAgentLimit ?? 0,
    grantAnyConnectionToChildren: options.grantAnyConnectionToChildren ?? false,
    permissionLevel: 'standard',
    createdAt: now,
    updatedAt: now,
  });
  let rawKey = '';
  if (options.withKey !== false) {
    const generated = generateAgentApiKey();
    rawKey = generated.rawKey;
    await db.insert(agentRuntimeSessions).values({
      id: `runtime-${suffix}`,
      agentId,
      status: 'running',
      apiKeyHash: generated.keyHash,
      startedAt: now,
    });
  }
  return { agentId, rawKey };
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

describe.skipIf(SKIP)('own child allowance read (integration)', () => {
  let db: Db;
  let redis: Redis;
  const apps: FastifyInstance[] = [];

  beforeAll(() => {
    db = createDatabase(process.env['DATABASE_URL']!);
    redis = new Redis();
  });

  afterAll(() => {
    redis.disconnect();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE conversations, agent_runtime_sessions, agents, connections, sessions, users CASCADE`);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function appWith(): Promise<FastifyInstance> {
    const app = await buildApp(db, redis);
    apps.push(app);
    return app;
  }

  it('an agent key reads its own child limit, child count and remaining allowance', async () => {
    const userId = await seedUser(db);
    const parent = await seedAgent(db, userId, { childAgentLimit: 3 });
    await seedAgent(db, userId, { parentAgentId: parent.agentId, withKey: false });
    const app = await appWith();

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${parent.agentId}/child-allowance`,
      headers: { Authorization: `Bearer ${parent.rawKey}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: parent.agentId,
      childAgentLimit: 3,
      childCount: 1,
      remainingChildAllowance: 2,
      grantAnySkillToChildren: false,
      grantAnyConnectionToChildren: false,
    });
  });

  it('an agent key cannot read the allowance of another agent', async () => {
    const userId = await seedUser(db);
    const caller = await seedAgent(db, userId, { childAgentLimit: 3 });
    const other = await seedAgent(db, userId, { childAgentLimit: 3, withKey: false });
    const app = await appWith();

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${other.agentId}/child-allowance`,
      headers: { Authorization: `Bearer ${caller.rawKey}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('a user reads the allowance of an agent they own', async () => {
    const userId = await seedUser(db);
    const agent = await seedAgent(db, userId, { childAgentLimit: 2, withKey: false });
    const token = await userToken(db, userId);
    const app = await appWith();

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${agent.agentId}/child-allowance`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ childAgentLimit: 2, childCount: 0, remainingChildAllowance: 2 });
  });

  it('a user cannot read the allowance of an agent owned by someone else', async () => {
    const ownerId = await seedUser(db);
    const otherUserId = await seedUser(db);
    const agent = await seedAgent(db, ownerId, { childAgentLimit: 2, withKey: false });
    const token = await userToken(db, otherUserId);
    const app = await appWith();

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${agent.agentId}/child-allowance`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
  });

  async function seedConnection(userId: string, overrides: Partial<typeof connections.$inferInsert> = {}): Promise<string> {
    const id = `conn-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(connections).values({
      id,
      userId,
      provider: 'hyperliquid',
      label: `Label ${id}`,
      status: 'active',
      credentialId: 'cred-secret-ref',
      providerRef: '0xprovider-secret-ref',
      resolvedVenueAccountId: 'venue-account-secret',
      meta: { note: 'cached' },
      ...overrides,
    });
    return id;
  }

  describe('owner connections read', () => {
    it('lists only id, provider, status and label of the owner\'s active connections when the setting is on', async () => {
      const userId = await seedUser(db);
      const agent = await seedAgent(db, userId, { grantAnyConnectionToChildren: true });
      const activeId = await seedConnection(userId);
      await seedConnection(userId, { status: 'revoked' });
      const app = await appWith();

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.agentId}/owner-connections`,
        headers: { Authorization: `Bearer ${agent.rawKey}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        connections: [{ id: activeId, provider: 'hyperliquid', status: 'active', label: `Label ${activeId}` }],
      });
      expect(res.body).not.toMatch(/cred-secret-ref|0xprovider-secret-ref|venue-account-secret/);
    });

    it('does not list another user\'s connections', async () => {
      const userId = await seedUser(db);
      const otherUserId = await seedUser(db);
      const agent = await seedAgent(db, userId, { grantAnyConnectionToChildren: true });
      const mine = await seedConnection(userId);
      await seedConnection(otherUserId);
      const app = await appWith();

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.agentId}/owner-connections`,
        headers: { Authorization: `Bearer ${agent.rawKey}` },
      });

      expect(res.json().connections.map((row: { id: string }) => row.id)).toEqual([mine]);
    });

    it('refuses with 403 when the setting is off', async () => {
      const userId = await seedUser(db);
      const agent = await seedAgent(db, userId);
      await seedConnection(userId);
      const app = await appWith();

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.agentId}/owner-connections`,
        headers: { Authorization: `Bearer ${agent.rawKey}` },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'agent.owner_connections.not_enabled' });
    });

    it('an agent key cannot read another agent\'s list, even when that agent has the setting on', async () => {
      const userId = await seedUser(db);
      const caller = await seedAgent(db, userId);
      const other = await seedAgent(db, userId, { grantAnyConnectionToChildren: true, withKey: false });
      const app = await appWith();

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${other.agentId}/owner-connections`,
        headers: { Authorization: `Bearer ${caller.rawKey}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('refuses a user caller, since the route is for agent keys', async () => {
      const userId = await seedUser(db);
      const agent = await seedAgent(db, userId, { grantAnyConnectionToChildren: true, withKey: false });
      const token = await userToken(db, userId);
      const app = await appWith();

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agent.agentId}/owner-connections`,
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
