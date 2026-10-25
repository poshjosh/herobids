import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql, eq } from 'drizzle-orm';
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
import type { AuthConfig, PlansConfig } from '@herobids/domain';
import { AgentCreationConfigSchema } from '@herobids/domain';
import { authPlugin, createSessionToken } from '../plugins/auth.js';
import { agentRoutes } from './agents.js';

const SKIP = !process.env['DATABASE_URL'];

const TEST_JWT_SECRET = 'test-secret-for-integration-tests-32ch!!';
const PLAN_CEILING = 3;

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

function makePlansConfig(): PlansConfig {
  return {
    defaultPlanId: 'free',
    plans: {
      free: {
        entitlements: {
          skills: {
            canCreatePrivateSkills: false,
            canViewMarketplaceSkills: true,
            canPublishToMarketplace: true,
            autoPublishNonDraftSkills: true,
            canPriceSkills: false,
            canLikeMarketplaceSkills: true,
          },
          agents: { canViewOwnPrompts: true },
          limits: {
            maxAgents: 10,
            childAgentLimitCeiling: PLAN_CEILING,
            maxBots: 5,
            maxConnections: 5,
            maxCredentials: 5,
            maxBindings: 5,
            maxVenueAccounts: 5,
            maxConcurrentBacktests: 3,
            liveEnabled: false,
          },
        },
        usage: {},
      },
    },
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
    makePlansConfig(),
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

async function seedUser(db: Db, options: { isAdmin?: boolean } = {}): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userId = `owner-${suffix}`;
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    username: `owner_${suffix}`,
    displayName: 'Owner',
    email: `${userId}@child-limit.test.local`,
    planId: 'free',
    isAdmin: options.isAdmin ?? false,
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

interface SeededAgent {
  agentId: string;
  rawKey: string;
}

async function seedAgent(db: Db, userId: string, options: { childAgentLimit?: number } = {}): Promise<SeededAgent> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const agentId = `agent-${suffix}`;
  const { rawKey, keyHash } = generateAgentApiKey();
  const now = new Date();
  await db.insert(agents).values({
    id: agentId,
    userId,
    name: `Agent ${suffix}`,
    prompt: 'Do work.',
    skillIds: [],
    status: 'active',
    childAgentLimit: options.childAgentLimit ?? 0,
    permissionLevel: 'standard',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(agentRuntimeSessions).values({
    id: `runtime-${suffix}`,
    agentId,
    status: 'running',
    apiKeyHash: keyHash,
    startedAt: now,
  });
  return { agentId, rawKey };
}

async function seedChildren(db: Db, userId: string, parentId: string, count: number): Promise<void> {
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    const suffix = crypto.randomUUID().slice(0, 8);
    await db.insert(agents).values({
      id: `child-${suffix}`,
      userId,
      name: `Child ${suffix}`,
      prompt: 'Help.',
      skillIds: [],
      status: 'stopped',
      creatorType: 'agent',
      creatorId: parentId,
      parentAgentId: parentId,
      depth: 1,
      permissionLevel: 'standard',
      createdAt: now,
      updatedAt: now,
    });
  }
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

function putChildLimit(app: FastifyInstance, agentId: string, auth: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'PUT',
    url: `/agents/${agentId}/child-limit`,
    headers: { Authorization: `Bearer ${auth}` },
    payload,
  });
}

async function storedLimit(db: Db, agentId: string): Promise<number> {
  const [row] = await db.select({ childAgentLimit: agents.childAgentLimit }).from(agents).where(eq(agents.id, agentId));
  return row?.childAgentLimit ?? -1;
}

async function childCount(db: Db, parentId: string): Promise<number> {
  const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.parentAgentId, parentId));
  return rows.length;
}

describe.skipIf(SKIP)('agent child limit setting (integration)', () => {
  let db: Db;
  let redis: Redis;
  const apps: FastifyInstance[] = [];

  async function appWith(): Promise<FastifyInstance> {
    const app = await buildApp(db, redis);
    apps.push(app);
    return app;
  }

  beforeAll(() => {
    db = createDatabase(process.env['DATABASE_URL']!);
    redis = new Redis();
  });

  afterAll(() => {
    redis.disconnect();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE agent_runtime_sessions, agents, sessions, users CASCADE`);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('an owner sets a limit within the plan ceiling and gets the stored value back', async () => {
    const userId = await seedUser(db);
    const agent = await seedAgent(db, userId);
    const token = await userToken(db, userId);
    const app = await appWith();

    const res = await putChildLimit(app, agent.agentId, token, { childAgentLimit: 2 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ childAgentLimit: 2 });
    expect(await storedLimit(db, agent.agentId)).toBe(2);
  });

  it('a limit above the plan ceiling is rejected with the ceiling in params and nothing is stored', async () => {
    const userId = await seedUser(db);
    const agent = await seedAgent(db, userId);
    const token = await userToken(db, userId);
    const app = await appWith();

    const res = await putChildLimit(app, agent.agentId, token, { childAgentLimit: PLAN_CEILING + 1 });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'agent.child_limit.exceeds_ceiling',
      params: { ceiling: PLAN_CEILING, requested: PLAN_CEILING + 1 },
    });
    expect(await storedLimit(db, agent.agentId)).toBe(0);
  });

  it('a limit equal to the plan ceiling is accepted', async () => {
    const userId = await seedUser(db);
    const agent = await seedAgent(db, userId);
    const token = await userToken(db, userId);
    const app = await appWith();

    const res = await putChildLimit(app, agent.agentId, token, { childAgentLimit: PLAN_CEILING });

    expect(res.statusCode).toBe(200);
    expect(await storedLimit(db, agent.agentId)).toBe(PLAN_CEILING);
  });

  it('a negative limit is rejected', async () => {
    const userId = await seedUser(db);
    const agent = await seedAgent(db, userId, { childAgentLimit: 1 });
    const token = await userToken(db, userId);
    const app = await appWith();

    const res = await putChildLimit(app, agent.agentId, token, { childAgentLimit: -1 });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('validation_error');
    expect(await storedLimit(db, agent.agentId)).toBe(1);
  });

  it('a non-integer limit is rejected', async () => {
    const userId = await seedUser(db);
    const agent = await seedAgent(db, userId, { childAgentLimit: 1 });
    const token = await userToken(db, userId);
    const app = await appWith();

    const res = await putChildLimit(app, agent.agentId, token, { childAgentLimit: 1.5 });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('validation_error');
    expect(await storedLimit(db, agent.agentId)).toBe(1);
  });

  it('an agent key gets 403 and the limit is unchanged', async () => {
    const userId = await seedUser(db);
    const agent = await seedAgent(db, userId, { childAgentLimit: 1 });
    const app = await appWith();

    const res = await putChildLimit(app, agent.agentId, agent.rawKey, { childAgentLimit: 2 });

    expect(res.statusCode).toBe(403);
    expect(await storedLimit(db, agent.agentId)).toBe(1);
  });

  it("another user's agent gets 404 and the limit is unchanged", async () => {
    const ownerId = await seedUser(db);
    const otherId = await seedUser(db);
    const agent = await seedAgent(db, ownerId, { childAgentLimit: 1 });
    const otherToken = await userToken(db, otherId);
    const app = await appWith();

    const res = await putChildLimit(app, agent.agentId, otherToken, { childAgentLimit: 2 });

    expect(res.statusCode).toBe(404);
    expect(await storedLimit(db, agent.agentId)).toBe(1);
  });

  it('lowering the limit below the current child count keeps the existing children', async () => {
    const userId = await seedUser(db);
    const agent = await seedAgent(db, userId, { childAgentLimit: 3 });
    await seedChildren(db, userId, agent.agentId, 2);
    const token = await userToken(db, userId);
    const app = await appWith();

    const res = await putChildLimit(app, agent.agentId, token, { childAgentLimit: 0 });

    expect(res.statusCode).toBe(200);
    expect(await storedLimit(db, agent.agentId)).toBe(0);
    expect(await childCount(db, agent.agentId)).toBe(2);
  });

  it('an admin owner is held to the plan ceiling', async () => {
    const userId = await seedUser(db, { isAdmin: true });
    const agent = await seedAgent(db, userId);
    const token = await userToken(db, userId);
    const app = await appWith();

    const res = await putChildLimit(app, agent.agentId, token, { childAgentLimit: PLAN_CEILING + 1 });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'agent.child_limit.exceeds_ceiling', params: { ceiling: PLAN_CEILING } });
    expect(await storedLimit(db, agent.agentId)).toBe(0);
  });

  it('a new agent starts with childAgentLimit 0 when no limit is set', async () => {
    const userId = await seedUser(db);
    const token = await userToken(db, userId);
    const app = await appWith();

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { Authorization: `Bearer ${token}` },
      payload: { name: 'Fresh', prompt: 'Help.' },
    });

    expect(res.statusCode).toBe(201);
    const [created] = await db.select({ id: agents.id, childAgentLimit: agents.childAgentLimit })
      .from(agents).where(eq(agents.userId, userId));
    expect(created?.childAgentLimit).toBe(0);
  });
});
