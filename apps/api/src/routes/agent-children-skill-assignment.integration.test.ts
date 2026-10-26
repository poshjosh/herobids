import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { createDatabase, users, sessions, agents, agentAuditEvents, agentSkills } from '@herobids/db';
import type { AuthConfig, PlansConfig } from '@herobids/domain';
import { AgentCreationConfigSchema } from '@herobids/domain';
import { ExternalBackendClient, type ExternalBackendClientResult, type InvokeToolInput } from '@herobids/domain/external-backend';
import { authPlugin, createSessionToken } from '../plugins/auth.js';
import { syncSystemSkills } from '../sync-system-skills.js';
import { agentRoutes } from './agents.js';

const SKIP = !process.env['DATABASE_URL'];
const TEST_JWT_SECRET = 'test-secret-for-integration-tests-32ch!!';
const CHILDREN_SKILL = 'agent-children-management';

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

/** Two plans: `pro` allows three children, `basic` allows none. */
function makePlansConfig(): PlansConfig {
  const skills = {
    canCreatePrivateSkills: false,
    canViewMarketplaceSkills: true,
    canPublishToMarketplace: true,
    autoPublishNonDraftSkills: true,
    canPriceSkills: false,
    canLikeMarketplaceSkills: true,
  };
  const limits = (childAgentLimitCeiling: number) => ({
    maxAgents: 10,
    childAgentLimitCeiling,
    maxBots: 5,
    maxConnections: 5,
    maxCredentials: 5,
    maxBindings: 5,
    maxVenueAccounts: 5,
    maxConcurrentBacktests: 3,
    liveEnabled: false,
  });
  return {
    defaultPlanId: 'basic',
    plans: {
      basic: { entitlements: { skills, agents: { canViewOwnPrompts: true }, limits: limits(0) }, usage: {} },
      pro: { entitlements: { skills, agents: { canViewOwnPrompts: true }, limits: limits(3) }, usage: {} },
    },
  };
}

type Db = ReturnType<typeof createDatabase>;

/** The bot and profile calls a PATCH or POST makes for an agent with no connections. Anything else fails. */
class QuietBoundary extends ExternalBackendClient {
  constructor() {
    super({
      baseUrl: 'http://127.0.0.1:9',
      consumerId: 'test-consumer',
      keyId: 'test-key',
      hmacSecret: 'test-hmac-secret',
      requestTimeoutMs: 1000,
    });
  }

  override async invoke(input: InvokeToolInput): Promise<ExternalBackendClientResult> {
    const requestId = crypto.randomUUID();
    if (input.toolName === 'list_owner_bots') {
      return { kind: 'success', requestId, correlationId: requestId, payload: { bots: [] } };
    }
    return { kind: 'transport_error', requestId, retryable: true, message: `unexpected tool ${input.toolName}` };
  }
}

async function buildApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await authPlugin(app, { config: makeAuthConfig(), db });
  await agentRoutes(
    app,
    db,
    makePlansConfig(),
    undefined,
    undefined,
    undefined,
    { provider: 'openai' },
    new QuietBoundary(),
    undefined,
    undefined,
    undefined,
    AgentCreationConfigSchema.parse({}),
  );
  await app.ready();
  return app;
}

async function seedUser(db: Db, planId: string): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userId = `owner-${suffix}`;
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    username: `owner_${suffix}`,
    displayName: 'Owner',
    email: `${userId}@children-skill.test.local`,
    planId,
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

async function seedAgent(db: Db, userId: string, childAgentLimit = 0): Promise<string> {
  const agentId = `agent-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await db.insert(agents).values({
    id: agentId,
    userId,
    name: 'Assigned agent',
    prompt: 'prompt',
    skillIds: [],
    status: 'stopped',
    creatorType: 'user',
    creatorId: userId,
    depth: 0,
    childAgentLimit,
    permissionLevel: 'standard',
    createdAt: now,
    updatedAt: now,
  });
  return agentId;
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

async function childLimitOf(db: Db, agentId: string): Promise<number> {
  const [row] = await db.select({ limit: agents.childAgentLimit }).from(agents).where(eq(agents.id, agentId));
  return row!.limit;
}

async function heldSkillIds(db: Db, agentId: string): Promise<string[]> {
  const rows = await db.select({ skillId: agentSkills.skillId }).from(agentSkills).where(eq(agentSkills.agentId, agentId));
  return rows.map((row) => row.skillId);
}

describe.skipIf(SKIP)('assigning the children skill sets the child limit (integration)', () => {
  let db: Db;
  const apps: FastifyInstance[] = [];

  async function appWith(): Promise<FastifyInstance> {
    const app = await buildApp(db);
    apps.push(app);
    return app;
  }

  beforeAll(async () => {
    db = createDatabase(process.env['DATABASE_URL']!);
    await db.execute(sql`TRUNCATE conversations, agent_runtime_sessions, agents, sessions, users CASCADE`);
    await syncSystemSkills(db);
  });

  afterAll(async () => {
    await db.execute(sql`TRUNCATE conversations, agent_runtime_sessions, agents, sessions, users CASCADE`);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE conversations, agent_runtime_sessions, agents, sessions, users CASCADE`);
    await syncSystemSkills(db);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('a user who assigns the skill on a plan with children sets the limit to the plan ceiling, with an audit row', async () => {
    const userId = await seedUser(db, 'pro');
    const agentId = await seedAgent(db, userId);
    const app = await appWith();

    const res = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${await userToken(db, userId)}` },
      payload: { skillIds: [CHILDREN_SKILL] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('childAgentLimitNotice');
    expect(await childLimitOf(db, agentId)).toBe(3);
    expect(await heldSkillIds(db, agentId)).toContain(CHILDREN_SKILL);
    const audits = await db.select().from(agentAuditEvents).where(and(
      eq(agentAuditEvents.targetId, agentId),
      eq(agentAuditEvents.action, 'agent.child_limit_set'),
    ));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toMatchObject({ childAgentLimit: 3, source: 'skill_assigned' });
  });

  it('on a plan that allows no children the assignment succeeds, the limit stays 0, and the response says so', async () => {
    const userId = await seedUser(db, 'basic');
    const agentId = await seedAgent(db, userId);
    const app = await appWith();

    const res = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${await userToken(db, userId)}` },
      payload: { skillIds: [CHILDREN_SKILL] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('childAgentLimitNotice');
    expect(await childLimitOf(db, agentId)).toBe(0);
    expect(await heldSkillIds(db, agentId)).toContain(CHILDREN_SKILL);
  });

  it('a later save that keeps the skill does not touch the limit the user has since changed', async () => {
    const userId = await seedUser(db, 'pro');
    const agentId = await seedAgent(db, userId);
    const app = await appWith();
    const token = await userToken(db, userId);
    await app.inject({ method: 'PATCH', url: `/agents/${agentId}`, headers: { Authorization: `Bearer ${token}` }, payload: { skillIds: [CHILDREN_SKILL] } });
    await db.update(agents).set({ childAgentLimit: 1 }).where(eq(agents.id, agentId));

    const res = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { skillIds: [CHILDREN_SKILL] },
    });

    expect(res.statusCode).toBe(200);
    expect(await childLimitOf(db, agentId)).toBe(1);
  });

  it('a user who creates an agent with the skill on a plan with children gets the ceiling as its limit', async () => {
    const userId = await seedUser(db, 'pro');
    const app = await appWith();

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { Authorization: `Bearer ${await userToken(db, userId)}` },
      payload: { name: 'With children', prompt: 'Coordinate.', skillIds: [CHILDREN_SKILL] },
    });

    expect(res.statusCode).toBe(201);
    const created = res.json() as { id: string };
    expect(await childLimitOf(db, created.id)).toBe(3);
  });

  it('a user who creates an agent without the skill keeps the limit at 0', async () => {
    const userId = await seedUser(db, 'pro');
    const app = await appWith();

    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { Authorization: `Bearer ${await userToken(db, userId)}` },
      payload: { name: 'No children', prompt: 'Work alone.', skillIds: ['browser'] },
    });

    expect(res.statusCode).toBe(201);
    const created = res.json() as { id: string };
    expect(await childLimitOf(db, created.id)).toBe(0);
  });
});
