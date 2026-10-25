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
  options: { parentAgentId?: string; childAgentLimit?: number; withKey?: boolean } = {},
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
    await db.execute(sql`TRUNCATE agent_outbound_messages, agent_runtime_sessions, agents, sessions, users CASCADE`);
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
});
