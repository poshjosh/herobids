import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql, eq, and } from 'drizzle-orm';
import crypto from 'node:crypto';
import { Redis } from 'ioredis';
import {
  createDatabase,
  users,
  sessions,
  agents,
  agentRuntimeSessions,
  agentSkills,
  agentConnections,
  connections,
  skills,
  skillRevisions,
  generateAgentApiKey,
  TradingProfileReconciliationOutboxRepository,
  TradingProfileReconciliationSaga,
} from '@herobids/db';
import type { AuthConfig, PlansConfig } from '@herobids/domain';
import { AgentCreationConfigSchema } from '@herobids/domain';
import type { ExternalBackendClientResult } from '@herobids/domain/external-backend';
import { authPlugin, createSessionToken } from '../plugins/auth.js';
import { agentRoutes } from './agents.js';

const SKIP = !process.env['DATABASE_URL'];

const TEST_JWT_SECRET = 'test-secret-for-integration-tests-32ch!!';
const DEFAULT_RATE_PER_MINUTE = 100;

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

function makePlansConfig(maxAgents: number, canViewMarketplaceSkills = true): PlansConfig {
  return {
    defaultPlanId: 'free',
    plans: {
      free: {
        entitlements: {
          skills: {
            canCreatePrivateSkills: false,
            canViewMarketplaceSkills,
            canPublishToMarketplace: true,
            autoPublishNonDraftSkills: true,
            canPriceSkills: false,
            canLikeMarketplaceSkills: true,
          },
          agents: { canViewOwnPrompts: true },
          limits: {
            maxAgents,
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

interface BuildOptions {
  maxAgents?: number;
  canViewMarketplaceSkills?: boolean;
  rateLimitPerMinute?: number;
  maxAgentDepth?: number;
  redis?: Redis;
  profileReconciliationSaga?: TradingProfileReconciliationSaga;
}

/** A fresh app per test, so the creation config and the limiter client can differ per case. */
async function buildApp(db: Db, options: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await authPlugin(app, { config: makeAuthConfig(), db });
  const agentCreation = AgentCreationConfigSchema.parse({
    agentCreateRatePerMinute: options.rateLimitPerMinute ?? DEFAULT_RATE_PER_MINUTE,
    maxAgentDepth: options.maxAgentDepth ?? 6,
  });
  await agentRoutes(
    app,
    db,
    makePlansConfig(options.maxAgents ?? 10, options.canViewMarketplaceSkills ?? true),
    undefined,
    undefined,
    options.redis,
    { provider: 'openai' },
    undefined,
    undefined,
    options.profileReconciliationSaga,
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
    email: `${userId}@child-create.test.local`,
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

async function seedAgent(
  db: Db,
  userId: string,
  options: {
    depth?: number;
    childAgentLimit?: number;
    permissionLevel?: 'restricted' | 'standard' | 'full';
  } = {},
): Promise<SeededAgent> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const agentId = `agent-${suffix}`;
  const runtimeSessionId = `runtime-${suffix}`;
  const { rawKey, keyHash } = generateAgentApiKey();
  const now = new Date();
  await db.insert(agents).values({
    id: agentId,
    userId,
    name: `Agent ${suffix}`,
    prompt: 'Do work.',
    skillIds: [],
    status: 'active',
    depth: options.depth ?? 0,
    childAgentLimit: options.childAgentLimit ?? 0,
    permissionLevel: options.permissionLevel ?? 'standard',
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
  return { agentId, rawKey };
}

interface SeededSkill {
  skillId: string;
  revisionId: string;
}

/** A system-owned published skill, selectable by any user. */
/** A published, free skill authored by someone else: selectable only through the plan's marketplace entitlement. */
async function seedMarketplaceSkill(db: Db): Promise<SeededSkill> {
  const skill = await seedSystemSkill(db);
  const authorId = await seedUser(db);
  await db.update(skills).set({ authorId }).where(eq(skills.id, skill.skillId));
  return skill;
}

async function seedSystemSkill(db: Db): Promise<SeededSkill> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const skillId = `skill-${suffix}`;
  const revisionId = `rev-${suffix}`;
  const now = new Date();
  await db.insert(skills).values({
    id: skillId,
    authorId: null,
    slug: `system/child-create-${suffix}`,
    name: `Skill ${suffix}`,
    description: 'Test skill.',
    instructions: 'Do the thing.',
    publicationStatus: 'published',
    publishedAt: now,
    currentRevisionId: revisionId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(skillRevisions).values({
    id: revisionId,
    skillId,
    version: 1,
    name: `Skill ${suffix}`,
    description: 'Test skill.',
    instructions: 'Do the thing.',
    publishedAt: now,
  });
  return { skillId, revisionId };
}

async function seedConnection(db: Db, userId: string, options: { venueAccountId?: string } = {}): Promise<string> {
  const connectionId = `conn-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(connections).values({
    id: connectionId,
    userId,
    provider: 'telegram',
    label: 'Test connection',
    status: 'active',
    resolvedVenueAccountId: options.venueAccountId ?? null,
  });
  return connectionId;
}

async function grantSkillToAgent(db: Db, agentId: string, skill: SeededSkill): Promise<void> {
  await db.insert(agentSkills).values({ agentId, skillId: skill.skillId, skillRevisionId: skill.revisionId });
}

async function assignConnectionToAgent(db: Db, agentId: string, connectionId: string, userId: string): Promise<void> {
  const now = new Date();
  await db.insert(agentConnections).values({
    id: crypto.randomUUID(),
    agentId,
    connectionId,
    status: 'active',
    grantedBy: userId,
    grantedAt: now,
    createdAt: now,
    updatedAt: now,
  });
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

function postAsAgent(app: FastifyInstance, rawKey: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/agents',
    headers: { Authorization: `Bearer ${rawKey}` },
    payload,
  });
}

async function agentsOwnedBy(db: Db, userId: string) {
  return db.select().from(agents).where(eq(agents.userId, userId));
}

async function childrenOf(db: Db, parentId: string) {
  return db.select().from(agents).where(eq(agents.parentAgentId, parentId));
}

describe.skipIf(SKIP)('agent-created child agents (integration)', () => {
  let db: Db;
  let redis: Redis;
  const apps: FastifyInstance[] = [];

  async function appWith(options: BuildOptions): Promise<FastifyInstance> {
    const app = await buildApp(db, { redis, ...options });
    apps.push(app);
    return app;
  }

  beforeAll(() => {
    db = createDatabase(process.env['DATABASE_URL']!);
    // Real Redis: the token bucket is a Lua script, so the rate tests exercise it directly.
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

  describe('creation outcome', () => {
    it('a child created by an agent key has the parent as creator, depth plus one, zero allowance and stopped status', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { depth: 1, childAgentLimit: 1 });
      const app = await appWith({});

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.' });

      expect(res.statusCode).toBe(201);
      const [child] = await childrenOf(db, parent.agentId);
      expect(child).toMatchObject({
        userId,
        creatorType: 'agent',
        creatorId: parent.agentId,
        parentAgentId: parent.agentId,
        depth: 2,
        childAgentLimit: 0,
        status: 'stopped',
      });
    });

    it('a user creation records the user as creator and no parent', async () => {
      const userId = await seedUser(db);
      const token = await userToken(db, userId);
      const app = await appWith({});

      const res = await app.inject({
        method: 'POST',
        url: '/agents',
        headers: { Authorization: `Bearer ${token}` },
        payload: { name: 'Mine', prompt: 'Help.' },
      });

      expect(res.statusCode).toBe(201);
      const [created] = await agentsOwnedBy(db, userId);
      expect(created).toMatchObject({ creatorType: 'user', creatorId: userId, parentAgentId: null, depth: 0 });
    });

    it('an agent caller sending creatorType, creatorId, parentAgentId or depth gets 400 and no child is created', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { depth: 1, childAgentLimit: 1 });
      const app = await appWith({});

      const res = await postAsAgent(app, parent.rawKey, {
        name: 'Forged',
        prompt: 'Help.',
        creatorType: 'user',
        creatorId: 'someone-else',
        parentAgentId: 'some-other-agent',
        depth: 0,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string; params: { fields: string[] } }>()).toMatchObject({
        error: 'agent.create.field_not_allowed',
        params: { fields: ['creatorType', 'creatorId', 'parentAgentId', 'depth'] },
      });
      expect(await childrenOf(db, parent.agentId)).toHaveLength(0);
    });

    it('an agent caller sending toolPolicy, telegramChatId or executionDefaults gets 400 with agent.create.field_not_allowed', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 1 });
      const app = await appWith({});

      const res = await postAsAgent(app, parent.rawKey, {
        name: 'Child',
        prompt: 'Help.',
        toolPolicy: { allow: ['*'] },
        telegramChatId: '12345',
        executionDefaults: { mode: 'live' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string; params: { fields: string[] } }>()).toMatchObject({
        error: 'agent.create.field_not_allowed',
        params: { fields: ['toolPolicy', 'telegramChatId', 'executionDefaults'] },
      });
      expect(await childrenOf(db, parent.agentId)).toHaveLength(0);
    });

    it('an agent caller sending a field outside the allowlist is refused, not stripped', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 1 });
      const app = await appWith({});

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.', capital: '5000', bogusField: true });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string; params: { fields: string[] } }>()).toMatchObject({
        error: 'agent.create.field_not_allowed',
        params: { fields: ['capital', 'bogusField'] },
      });
      expect(await childrenOf(db, parent.agentId)).toHaveLength(0);
    });

    it('an agent caller sending permissionLevel gets 400 with agent.create.field_not_allowed', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 1, permissionLevel: 'standard' });
      const app = await appWith({});

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.', permissionLevel: 'full' });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string; params: { fields: string[] } }>()).toMatchObject({
        error: 'agent.create.field_not_allowed',
        params: { fields: ['permissionLevel'] },
      });
      expect(await childrenOf(db, parent.agentId)).toHaveLength(0);
    });

    it('an agent caller using only name, prompt, skillIds and connectionIds creates the child with server defaults', async () => {
      const userId = await seedUser(db);
      const held = await seedSystemSkill(db);
      const connectionId = await seedConnection(db, userId);
      const parent = await seedAgent(db, userId, { childAgentLimit: 1, permissionLevel: 'standard' });
      await grantSkillToAgent(db, parent.agentId, held);
      await assignConnectionToAgent(db, parent.agentId, connectionId, userId);
      const app = await appWith({});

      const res = await postAsAgent(app, parent.rawKey, {
        name: 'Child',
        prompt: 'Help.',
        skillIds: [held.skillId],
        connectionIds: [connectionId],
      });

      expect(res.statusCode).toBe(201);
      const [child] = await childrenOf(db, parent.agentId);
      expect(child).toMatchObject({ name: 'Child', prompt: 'Help.', telegramChatId: null, permissionLevel: 'standard' });
    });
  });

  describe('allowance and depth', () => {
    it('an agent with a zero allowance cannot create a child', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 0 });
      const app = await appWith({});

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.' });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string; rule: string }>()).toMatchObject({ error: 'agent.create.allowance_exhausted', rule: 'allowance' });
      expect(await childrenOf(db, parent.agentId)).toHaveLength(0);
    });

    it('an agent with an allowance of one creates one child and refuses the second', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 1 });
      const app = await appWith({});

      const first = await postAsAgent(app, parent.rawKey, { name: 'First', prompt: 'Help.' });
      const second = await postAsAgent(app, parent.rawKey, { name: 'Second', prompt: 'Help.' });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(403);
      expect(second.json<{ error: string }>().error).toBe('agent.create.allowance_exhausted');
      expect(await childrenOf(db, parent.agentId)).toHaveLength(1);
    });

    it('an agent at maxAgentDepth cannot create a child', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { depth: 2, childAgentLimit: 1 });
      const app = await appWith({ maxAgentDepth: 2 });

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.' });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string; rule: string }>()).toMatchObject({ error: 'agent.create.depth_exceeded', rule: 'depth' });
      expect(await childrenOf(db, parent.agentId)).toHaveLength(0);
    });
  });

  describe('plan total', () => {
    it('a child is refused when the user total would exceed maxAgents, children included', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 5 });
      const app = await appWith({ maxAgents: 2 });

      const first = await postAsAgent(app, parent.rawKey, { name: 'First', prompt: 'Help.' });
      const second = await postAsAgent(app, parent.rawKey, { name: 'Second', prompt: 'Help.' });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(403);
      expect(second.json<{ error: string; rule: string }>()).toMatchObject({
        error: 'agent.create.plan_limit_exceeded',
        rule: 'plan_total',
      });
      expect(await agentsOwnedBy(db, userId)).toHaveLength(2);
    });

    it('a user creation is refused at maxAgents with the existing plan error shape', async () => {
      const userId = await seedUser(db);
      await seedAgent(db, userId);
      const token = await userToken(db, userId);
      const app = await appWith({ maxAgents: 1 });

      const res = await app.inject({
        method: 'POST',
        url: '/agents',
        headers: { Authorization: `Bearer ${token}` },
        payload: { name: 'Over', prompt: 'Help.' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json<Record<string, unknown>>()).not.toHaveProperty('rule');
      expect(res.json<{ error: string }>().error).toBe('plan.limit_exceeded');
    });

    it('parallel creations at the allowance boundary create no more than the allowance', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 2 });
      const app = await appWith({ maxAgents: 20 });

      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, index) => postAsAgent(app, parent.rawKey, { name: `Race ${index}`, prompt: 'Help.' })),
      );

      expect(responses.filter((res) => res.statusCode === 201)).toHaveLength(2);
      expect(await childrenOf(db, parent.agentId)).toHaveLength(2);
    });

    it('parallel creations under two parents of one user cannot exceed maxAgents', async () => {
      const userId = await seedUser(db);
      const parentA = await seedAgent(db, userId, { childAgentLimit: 5 });
      const parentB = await seedAgent(db, userId, { childAgentLimit: 5 });
      // Two agents already exist; the plan allows three in total.
      const app = await appWith({ maxAgents: 3 });

      const responses = await Promise.all([
        postAsAgent(app, parentA.rawKey, { name: 'A1', prompt: 'Help.' }),
        postAsAgent(app, parentA.rawKey, { name: 'A2', prompt: 'Help.' }),
        postAsAgent(app, parentB.rawKey, { name: 'B1', prompt: 'Help.' }),
        postAsAgent(app, parentB.rawKey, { name: 'B2', prompt: 'Help.' }),
      ]);

      expect(responses.filter((res) => res.statusCode === 201)).toHaveLength(1);
      expect(await agentsOwnedBy(db, userId)).toHaveLength(3);
    });
  });

  describe('rate limit and limiter availability', () => {
    it('each attempt takes a token, including an attempt the allowance then refuses', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 0 });
      const app = await appWith({ rateLimitPerMinute: 2 });

      const statuses = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = await postAsAgent(app, parent.rawKey, { name: `Try ${attempt}`, prompt: 'Help.' });
        statuses.push(res.statusCode);
      }

      // Capacity 2: the first two attempts reach the allowance check; the third finds the bucket empty.
      expect(statuses).toEqual([403, 403, 429]);
      expect(await agentsOwnedBy(db, userId)).toHaveLength(1);
    });

    it('an agent key is refused with 503 when no rate limiter is configured (fails closed)', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 5 });
      const app = await buildApp(db, { maxAgentDepth: 6 });
      apps.push(app);

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.' });

      expect(res.statusCode).toBe(503);
      expect(res.json<{ error: string; rule: string }>()).toMatchObject({
        error: 'agent.create.limiter_unavailable',
        rule: 'limiter',
      });
      expect(await childrenOf(db, parent.agentId)).toHaveLength(0);
    });

    it('an agent key is refused with 503 when the limiter cannot be reached (fails closed)', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 5 });
      const unreachable = new Redis({ port: 1, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0 });
      // Expected: the port is closed. The command rejection is what the route must handle.
      unreachable.on('error', () => undefined);
      try {
        const app = await appWith({ redis: unreachable });

        const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.' });

        expect(res.statusCode).toBe(503);
        expect(res.json<{ error: string }>().error).toBe('agent.create.limiter_unavailable');
        expect(await childrenOf(db, parent.agentId)).toHaveLength(0);
      } finally {
        unreachable.disconnect();
      }
    });
  });

  describe('admin owner', () => {
    it('an admin owner is not held to maxAgents for a child', async () => {
      const userId = await seedUser(db, { isAdmin: true });
      const parent = await seedAgent(db, userId, { childAgentLimit: 2 });
      const app = await appWith({ maxAgents: 1 });

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.' });

      expect(res.statusCode).toBe(201);
      expect(await agentsOwnedBy(db, userId)).toHaveLength(2);
    });

    it('an admin owner is still held to the depth limit for a child', async () => {
      const userId = await seedUser(db, { isAdmin: true });
      const parent = await seedAgent(db, userId, { depth: 1, childAgentLimit: 2 });
      const app = await appWith({ maxAgents: 1, maxAgentDepth: 1 });

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.' });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toBe('agent.create.depth_exceeded');
    });

    it('an admin owner child gets the admin skill policy, so a marketplace skill the plan withholds is granted', async () => {
      const userId = await seedUser(db, { isAdmin: true });
      const skill = await seedMarketplaceSkill(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 1 });
      await grantSkillToAgent(db, parent.agentId, skill);
      const app = await appWith({ canViewMarketplaceSkills: false });

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.', skillIds: [skill.skillId] });

      expect(res.statusCode).toBe(201);
    });

    it('a non-admin owner child gets the plan skill policy, so the same marketplace skill is refused', async () => {
      const userId = await seedUser(db);
      const skill = await seedMarketplaceSkill(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 1 });
      await grantSkillToAgent(db, parent.agentId, skill);
      const app = await appWith({ canViewMarketplaceSkills: false });

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.', skillIds: [skill.skillId] });

      expect(res.statusCode).toBe(400);
      expect(await childrenOf(db, parent.agentId)).toHaveLength(0);
    });
  });

  describe('grants', () => {
    it('a skill the parent does not hold is refused', async () => {
      const userId = await seedUser(db);
      const held = await seedSystemSkill(db);
      const notHeld = await seedSystemSkill(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 1 });
      await grantSkillToAgent(db, parent.agentId, held);
      const app = await appWith({});

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.', skillIds: [notHeld.skillId] });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string; rule: string }>()).toMatchObject({ error: 'agent.create.grant_not_held', rule: 'grant' });
      expect(await childrenOf(db, parent.agentId)).toHaveLength(0);
    });

    it('a skill the parent holds is granted to the child', async () => {
      const userId = await seedUser(db);
      const held = await seedSystemSkill(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 1 });
      await grantSkillToAgent(db, parent.agentId, held);
      const app = await appWith({});

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.', skillIds: [held.skillId] });

      expect(res.statusCode).toBe(201);
      const [child] = await childrenOf(db, parent.agentId);
      const childSkills = await db.select().from(agentSkills).where(eq(agentSkills.agentId, child!.id));
      expect(childSkills.map((row) => row.skillId)).toEqual([held.skillId]);
    });

    it('a connection the parent is not assigned is refused', async () => {
      const userId = await seedUser(db);
      const connectionId = await seedConnection(db, userId);
      const parent = await seedAgent(db, userId, { childAgentLimit: 1 });
      const app = await appWith({});

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.', connectionIds: [connectionId] });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toBe('agent.create.grant_not_held');
      expect(await childrenOf(db, parent.agentId)).toHaveLength(0);
    });

    it('a connection the parent holds is granted to the child', async () => {
      const userId = await seedUser(db);
      const connectionId = await seedConnection(db, userId);
      const parent = await seedAgent(db, userId, { childAgentLimit: 1 });
      await assignConnectionToAgent(db, parent.agentId, connectionId, userId);
      const app = await appWith({});

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.', connectionIds: [connectionId] });

      expect(res.statusCode).toBe(201);
      const [child] = await childrenOf(db, parent.agentId);
      const childConnections = await db
        .select()
        .from(agentConnections)
        .where(and(eq(agentConnections.agentId, child!.id), eq(agentConnections.status, 'active')));
      expect(childConnections.map((row) => row.connectionId)).toEqual([connectionId]);
    });

    it('an omitted permissionLevel under a restricted parent creates a restricted child', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 1, permissionLevel: 'restricted' });
      const app = await appWith({});

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.' });

      expect(res.statusCode).toBe(201);
      const [child] = await childrenOf(db, parent.agentId);
      expect(child?.permissionLevel).toBe('restricted');
    });

    it('an omitted permissionLevel under a full parent creates a standard child', async () => {
      const userId = await seedUser(db);
      const parent = await seedAgent(db, userId, { childAgentLimit: 1, permissionLevel: 'full' });
      const app = await appWith({});

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.' });

      expect(res.statusCode).toBe(201);
      const [child] = await childrenOf(db, parent.agentId);
      expect(child?.permissionLevel).toBe('standard');
    });
  });

  describe('profile boundary', () => {
    /** A boundary spy that fails any write it receives. A refused child must never reach it. */
    function boundarySpy() {
      const invoke = vi.fn(async (input: { requestId: string }): Promise<ExternalBackendClientResult> => ({
        kind: 'transport_error',
        requestId: input.requestId,
        retryable: true,
        message: 'boundary write attempted',
      }));
      const saga = new TradingProfileReconciliationSaga(new TradingProfileReconciliationOutboxRepository(db), { invoke });
      return { invoke, saga };
    }

    it('a child refused by allowance with connectionIds makes no boundary write', async () => {
      const userId = await seedUser(db);
      const connectionId = await seedConnection(db, userId, { venueAccountId: `venue-${crypto.randomUUID().slice(0, 8)}` });
      const parent = await seedAgent(db, userId, { childAgentLimit: 0 });
      await assignConnectionToAgent(db, parent.agentId, connectionId, userId);
      const { invoke, saga } = boundarySpy();
      const app = await appWith({ profileReconciliationSaga: saga });

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.', connectionIds: [connectionId] });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toBe('agent.create.allowance_exhausted');
      expect(invoke).not.toHaveBeenCalled();
      expect(await childrenOf(db, parent.agentId)).toHaveLength(0);
    });

    it('a child refused by an ungranted connection makes no boundary write', async () => {
      const userId = await seedUser(db);
      const connectionId = await seedConnection(db, userId, { venueAccountId: `venue-${crypto.randomUUID().slice(0, 8)}` });
      const parent = await seedAgent(db, userId, { childAgentLimit: 1 });
      const { invoke, saga } = boundarySpy();
      const app = await appWith({ profileReconciliationSaga: saga });

      const res = await postAsAgent(app, parent.rawKey, { name: 'Child', prompt: 'Help.', connectionIds: [connectionId] });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toBe('agent.create.grant_not_held');
      expect(invoke).not.toHaveBeenCalled();
      expect(await childrenOf(db, parent.agentId)).toHaveLength(0);
    });
  });
});
