import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { Redis } from 'ioredis';
import { z } from 'zod';
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
import {
  ExternalBackendClient,
  type ExternalBackendClientResult,
  type InvokeToolInput,
} from '@herobids/domain/external-backend';
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
            childAgentLimitCeiling: 3,
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

const BotIdPayloadSchema = z.object({ botId: z.string() });

interface FakeBot {
  id: string;
  status: string;
  creatorType: string;
  creatorId: string | null;
}

/**
 * The real ExternalBackendClient with `invoke` replaced by an in-memory Traderton. It serves
 * the three bot tools the delete cascade uses and records each `delete_bot` in call order.
 */
class FakeTradertonBoundary extends ExternalBackendClient {
  bots: FakeBot[] = [];
  /** creatorId of each bot in the order its delete_bot call succeeded. */
  readonly deletedBotOwners: string[] = [];
  /** Bot ids whose next delete_bot fails with a transport error (then succeeds on retry). */
  readonly failNextDeleteFor = new Set<string>();

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
    switch (input.toolName) {
      case 'list_owner_bots':
        return { kind: 'success', requestId, correlationId: requestId, payload: { bots: this.bots } };
      case 'stop_bot': {
        const { botId } = BotIdPayloadSchema.parse(input.payload);
        this.bots = this.bots.map((bot) => (bot.id === botId ? { ...bot, status: 'stopped' } : bot));
        return { kind: 'success', requestId, correlationId: requestId, payload: {} };
      }
      case 'delete_bot': {
        const { botId } = BotIdPayloadSchema.parse(input.payload);
        if (this.failNextDeleteFor.delete(botId)) {
          return { kind: 'transport_error', requestId, retryable: true, message: 'boundary dropped the connection' };
        }
        const bot = this.bots.find((candidate) => candidate.id === botId);
        if (bot?.creatorId) this.deletedBotOwners.push(bot.creatorId);
        this.bots = this.bots.filter((candidate) => candidate.id !== botId);
        return { kind: 'success', requestId, correlationId: requestId, payload: {} };
      }
      default:
        return { kind: 'transport_error', requestId, retryable: true, message: `unexpected tool ${input.toolName}` };
    }
  }
}

function buildBoundary(): FakeTradertonBoundary {
  return new FakeTradertonBoundary();
}

async function buildApp(db: Db, redis: Redis, boundary: ExternalBackendClient | undefined): Promise<FastifyInstance> {
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
    boundary,
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
    email: `${userId}@delete-subtree.test.local`,
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
  options: { parentAgentId?: string; depth?: number; status?: string; withKey?: boolean } = {},
): Promise<SeededAgent> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const agentId = `agent-${suffix}`;
  const now = new Date();
  await db.insert(agents).values({
    id: agentId,
    userId,
    name: `Agent ${suffix}`,
    prompt: `delete subtree ${suffix}`,
    skillIds: [],
    status: options.status ?? 'stopped',
    creatorType: options.parentAgentId ? 'agent' : 'user',
    creatorId: options.parentAgentId ?? userId,
    parentAgentId: options.parentAgentId ?? null,
    depth: options.depth ?? 0,
    childAgentLimit: 2,
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

async function readAgent(db: Db, agentId: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
  return row;
}

async function agentExists(db: Db, agentId: string): Promise<boolean> {
  return (await readAgent(db, agentId)) !== undefined;
}

/** root → child → grandchild → great-grandchild, plus a second child of root with one grandchild. */
interface Tree {
  userId: string;
  root: SeededAgent;
  childA: SeededAgent;
  grandA: SeededAgent;
  greatA: SeededAgent;
  childB: SeededAgent;
  grandB: SeededAgent;
}

async function seedTree(db: Db): Promise<Tree> {
  const userId = await seedUser(db);
  const root = await seedAgent(db, userId);
  const childA = await seedAgent(db, userId, { parentAgentId: root.agentId, depth: 1, withKey: false });
  const grandA = await seedAgent(db, userId, { parentAgentId: childA.agentId, depth: 2, withKey: false });
  const greatA = await seedAgent(db, userId, { parentAgentId: grandA.agentId, depth: 3, withKey: false });
  const childB = await seedAgent(db, userId, { parentAgentId: root.agentId, depth: 1, withKey: false });
  const grandB = await seedAgent(db, userId, { parentAgentId: childB.agentId, depth: 2, withKey: false });
  return { userId, root, childA, grandA, greatA, childB, grandB };
}

function seedBotsForTree(boundary: FakeTradertonBoundary, tree: Tree, extraUnrelatedBot = true): void {
  const agentBot = (botId: string, creatorId: string, status = 'stopped'): FakeBot => ({
    id: botId,
    status,
    creatorType: 'agent',
    creatorId,
  });
  boundary.bots = [
    agentBot(`bot-root-${tree.root.agentId}`, tree.root.agentId, 'running'),
    agentBot(`bot-childA-${tree.childA.agentId}`, tree.childA.agentId),
    agentBot(`bot-grandA-${tree.grandA.agentId}`, tree.grandA.agentId),
    agentBot(`bot-greatA-${tree.greatA.agentId}`, tree.greatA.agentId),
    agentBot(`bot-childB-${tree.childB.agentId}`, tree.childB.agentId),
    agentBot(`bot-grandB-${tree.grandB.agentId}`, tree.grandB.agentId),
    ...(extraUnrelatedBot ? [{ id: `bot-user-${tree.userId}`, status: 'stopped', creatorType: 'user', creatorId: tree.userId }] : []),
  ];
}

describe.skipIf(SKIP)('agent delete with subtree scope (integration)', () => {
  let db: Db;
  let redis: Redis;
  const apps: FastifyInstance[] = [];

  async function appWith(boundary: ExternalBackendClient | undefined): Promise<FastifyInstance> {
    const app = await buildApp(db, redis, boundary);
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
    await db.execute(sql`TRUNCATE agent_outbound_messages, agent_runtime_sessions, agents, sessions, users CASCADE`);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('subtree delete with a non-stopped descendant returns 409 and lists it', async () => {
    const tree = await seedTree(db);
    await db.update(agents).set({ status: 'running' }).where(eq(agents.id, tree.grandA.agentId));
    const boundary = buildBoundary();
    seedBotsForTree(boundary, tree);
    const token = await userToken(db, tree.userId);
    const app = await appWith(boundary);

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${tree.root.agentId}?scope=subtree`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'agent_subtree_not_stopped',
      nonStoppedAgents: [{ id: tree.grandA.agentId, status: 'running' }],
    });
    expect(boundary.deletedBotOwners).toEqual([]);
    expect(await agentExists(db, tree.grandA.agentId)).toBe(true);
  });

  it('subtree delete removes every descendant and tears down bots deepest first', async () => {
    const tree = await seedTree(db);
    const boundary = buildBoundary();
    seedBotsForTree(boundary, tree);
    const token = await userToken(db, tree.userId);
    const app = await appWith(boundary);

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${tree.root.agentId}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scope: 'subtree', agentCount: 6, botCount: 6 });
    for (const agent of [tree.root, tree.childA, tree.grandA, tree.greatA, tree.childB, tree.grandB]) {
      expect(await agentExists(db, agent.agentId)).toBe(false);
    }
    // Deepest first: the great-grandchild's bot before the grandchildren, then the children, then the root.
    const order = boundary.deletedBotOwners;
    expect(order.indexOf(tree.greatA.agentId)).toBeLessThan(order.indexOf(tree.grandA.agentId));
    expect(order.indexOf(tree.grandA.agentId)).toBeLessThan(order.indexOf(tree.childA.agentId));
    expect(order.indexOf(tree.childA.agentId)).toBeLessThan(order.indexOf(tree.root.agentId));
    expect(order.indexOf(tree.grandB.agentId)).toBeLessThan(order.indexOf(tree.childB.agentId));
    expect(order.indexOf(tree.childB.agentId)).toBeLessThan(order.indexOf(tree.root.agentId));
    // The user-created bot is not an agent-owned bot, so it is left alone.
    expect(boundary.bots.map((bot) => bot.id)).toEqual([`bot-user-${tree.userId}`]);
  });

  it('a boundary failure partway returns 503 with the step, keeps the agents, and a retry completes', async () => {
    const tree = await seedTree(db);
    const boundary = buildBoundary();
    seedBotsForTree(boundary, tree);
    boundary.failNextDeleteFor.add(`bot-childA-${tree.childA.agentId}`);
    const token = await userToken(db, tree.userId);
    const app = await appWith(boundary);

    const failed = await app.inject({
      method: 'DELETE',
      url: `/agents/${tree.root.agentId}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ step: 'delete_bot', agentId: tree.childA.agentId });
    for (const agent of [tree.root, tree.childA, tree.grandA, tree.greatA, tree.childB, tree.grandB]) {
      expect(await agentExists(db, agent.agentId)).toBe(true);
    }
    // Bots of the agents processed before the failure are gone; the failing agent's and the root's are untouched.
    expect(boundary.bots.some((bot) => bot.id === `bot-greatA-${tree.greatA.agentId}`)).toBe(false);
    expect(boundary.bots.some((bot) => bot.id === `bot-childA-${tree.childA.agentId}`)).toBe(true);
    expect(boundary.bots.some((bot) => bot.id === `bot-root-${tree.root.agentId}`)).toBe(true);

    const deletedBeforeRetry = boundary.deletedBotOwners.length;
    const retry = await app.inject({
      method: 'DELETE',
      url: `/agents/${tree.root.agentId}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ scope: 'subtree', agentCount: 6, botCount: 6 - deletedBeforeRetry });
    for (const agent of [tree.root, tree.childA, tree.grandA, tree.greatA, tree.childB, tree.grandB]) {
      expect(await agentExists(db, agent.agentId)).toBe(false);
    }
  });

  it('a subtree delete with the boundary absent fails closed with 503 and changes nothing', async () => {
    const tree = await seedTree(db);
    const token = await userToken(db, tree.userId);
    const app = await appWith(undefined);

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${tree.root.agentId}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ step: 'boundary_unconfigured' });
    for (const agent of [tree.root, tree.childA, tree.grandA, tree.greatA, tree.childB, tree.grandB]) {
      expect(await agentExists(db, agent.agentId)).toBe(true);
    }
  });

  it('agent-only delete across three levels lifts children to top level and reduces descendant depths', async () => {
    const tree = await seedTree(db);
    const boundary = buildBoundary();
    seedBotsForTree(boundary, tree);
    const token = await userToken(db, tree.userId);
    const app = await appWith(boundary);

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${tree.root.agentId}?scope=agent`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scope: 'agent', agentCount: 1, botCount: 1 });
    expect(await agentExists(db, tree.root.agentId)).toBe(false);

    const childA = await readAgent(db, tree.childA.agentId);
    const grandA = await readAgent(db, tree.grandA.agentId);
    const greatA = await readAgent(db, tree.greatA.agentId);
    const childB = await readAgent(db, tree.childB.agentId);
    const grandB = await readAgent(db, tree.grandB.agentId);
    expect(childA).toMatchObject({ parentAgentId: null, depth: 0 });
    expect(grandA).toMatchObject({ parentAgentId: tree.childA.agentId, depth: 1 });
    expect(greatA).toMatchObject({ parentAgentId: tree.grandA.agentId, depth: 2 });
    expect(childB).toMatchObject({ parentAgentId: null, depth: 0 });
    expect(grandB).toMatchObject({ parentAgentId: tree.childB.agentId, depth: 1 });
  });

  it('agent-only delete keeps the children creator fields and their bots untouched', async () => {
    const tree = await seedTree(db);
    const boundary = buildBoundary();
    seedBotsForTree(boundary, tree);
    const before = await readAgent(db, tree.childA.agentId);
    const token = await userToken(db, tree.userId);
    const app = await appWith(boundary);

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${tree.root.agentId}?scope=agent`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const after = await readAgent(db, tree.childA.agentId);
    expect(after).toMatchObject({ creatorType: before?.creatorType, creatorId: before?.creatorId });
    expect(after?.creatorId).toBe(tree.root.agentId);
    // Only the root's own bot is torn down.
    expect(boundary.deletedBotOwners).toEqual([tree.root.agentId]);
    expect(boundary.bots.some((bot) => bot.creatorId === tree.childA.agentId)).toBe(true);
    expect(boundary.bots.some((bot) => bot.creatorId === tree.grandB.agentId)).toBe(true);
  });

  it('an agent key gets 403 on delete and on the delete preview', async () => {
    const tree = await seedTree(db);
    const boundary = buildBoundary();
    seedBotsForTree(boundary, tree);
    const keyHolder = await seedAgent(db, tree.userId, { status: 'active' });
    const app = await appWith(boundary);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/agents/${tree.root.agentId}`,
      headers: { Authorization: `Bearer ${keyHolder.rawKey}` },
    });
    const previewRes = await app.inject({
      method: 'GET',
      url: `/agents/${tree.root.agentId}/delete-preview`,
      headers: { Authorization: `Bearer ${keyHolder.rawKey}` },
    });

    expect(deleteRes.statusCode).toBe(403);
    expect(previewRes.statusCode).toBe(403);
    expect(await agentExists(db, tree.root.agentId)).toBe(true);
  });

  it("another user's agent gets 404 on delete and on the delete preview", async () => {
    const tree = await seedTree(db);
    const boundary = buildBoundary();
    seedBotsForTree(boundary, tree);
    const intruderId = await seedUser(db);
    const intruderToken = await userToken(db, intruderId);
    const app = await appWith(boundary);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/agents/${tree.root.agentId}`,
      headers: { Authorization: `Bearer ${intruderToken}` },
    });
    const previewRes = await app.inject({
      method: 'GET',
      url: `/agents/${tree.root.agentId}/delete-preview`,
      headers: { Authorization: `Bearer ${intruderToken}` },
    });

    expect(deleteRes.statusCode).toBe(404);
    expect(previewRes.statusCode).toBe(404);
    expect(await agentExists(db, tree.root.agentId)).toBe(true);
  });

  it('delete-preview returns the agent and bot counts for each scope and lists non-stopped agents', async () => {
    const tree = await seedTree(db);
    await db.update(agents).set({ status: 'running' }).where(eq(agents.id, tree.greatA.agentId));
    const boundary = buildBoundary();
    seedBotsForTree(boundary, tree);
    const token = await userToken(db, tree.userId);
    const app = await appWith(boundary);

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${tree.root.agentId}/delete-preview`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      availableScopes: ['subtree', 'agent'],
      defaultScope: 'subtree',
      agentCount: 6,
      botCount: 6,
      nonStoppedAgents: [{ id: tree.greatA.agentId, status: 'running' }],
      scopes: {
        subtree: { agentCount: 6, botCount: 6 },
        agent: { agentCount: 1, botCount: 1 },
      },
    });
  });

  it('a lone agent with no children deletes exactly as before, with an empty 204', async () => {
    const userId = await seedUser(db);
    const lone = await seedAgent(db, userId, { withKey: false });
    const boundary = buildBoundary();
    boundary.bots = [{ id: `bot-lone-${lone.agentId}`, status: 'stopped', creatorType: 'agent', creatorId: lone.agentId }];
    const token = await userToken(db, userId);
    const app = await appWith(boundary);

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${lone.agentId}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await agentExists(db, lone.agentId)).toBe(false);
    expect(boundary.deletedBotOwners).toEqual([lone.agentId]);
  });

  it('rejects an unknown scope with 400', async () => {
    const tree = await seedTree(db);
    const token = await userToken(db, tree.userId);
    const app = await appWith(buildBoundary());

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${tree.root.agentId}?scope=everything`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_error' });
    expect(await agentExists(db, tree.root.agentId)).toBe(true);
  });
});
