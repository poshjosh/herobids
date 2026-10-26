import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import {
  createDatabase,
  users,
  sessions,
  agents,
  agentAuditEvents,
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

/** Answers the bot listing with no bots, so a bot-less child can be torn down. Anything else fails. */
class NoBotsBoundary extends ExternalBackendClient {
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
    new NoBotsBoundary(),
    undefined,
    undefined,
    undefined,
    AgentCreationConfigSchema.parse({}),
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
    email: `${userId}@children.test.local`,
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
    prompt: `prompt ${suffix}`,
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

function keyed(app: FastifyInstance, method: 'GET' | 'DELETE', url: string, rawKey: string) {
  return app.inject({ method, url, headers: { Authorization: `Bearer ${rawKey}` } });
}

/** Makes the child childless, for the cases that test the child's own state. */
async function removeGrandchild(db: Db, agentId: string): Promise<void> {
  await db.delete(agents).where(eq(agents.id, agentId));
}

async function rowExists(db: Db, agentId: string): Promise<boolean> {
  const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId));
  return rows.length === 1;
}

describe.skipIf(SKIP)('agent children management routes (integration)', () => {
  let db: Db;
  const apps: FastifyInstance[] = [];

  async function appWith(): Promise<FastifyInstance> {
    const app = await buildApp(db);
    apps.push(app);
    return app;
  }

  beforeAll(() => {
    db = createDatabase(process.env['DATABASE_URL']!);
  });

  afterAll(async () => {
    await db.execute(sql`TRUNCATE conversations, agent_runtime_sessions, agents, sessions, users CASCADE`);
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE conversations, agent_runtime_sessions, agents, sessions, users CASCADE`);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  /** A creator with one stopped direct child that has one stopped grandchild, and an unrelated agent. */
  async function seedTree() {
    const userId = await seedUser(db);
    const creator = await seedAgent(db, userId, { status: 'active' });
    const child = await seedAgent(db, userId, { parentAgentId: creator.agentId, depth: 1, withKey: false });
    const grandchild = await seedAgent(db, userId, { parentAgentId: child.agentId, depth: 2, withKey: false });
    const unrelated = await seedAgent(db, userId, { withKey: false });
    return { userId, creator, child, grandchild, unrelated };
  }

  it('lists only the direct children, each with its own child count', async () => {
    const tree = await seedTree();
    const app = await appWith();

    const res = await keyed(app, 'GET', `/agents/${tree.creator.agentId}/children`, tree.creator.rawKey);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      children: [{
        id: tree.child.agentId,
        name: expect.any(String),
        status: 'stopped',
        depth: 1,
        childCount: 1,
        lastStartRefusal: null,
      }],
    });
  });

  it('answers an empty list for an agent with no children', async () => {
    const userId = await seedUser(db);
    const lonely = await seedAgent(db, userId, { status: 'active' });
    const app = await appWith();

    const res = await keyed(app, 'GET', `/agents/${lonely.agentId}/children`, lonely.rawKey);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ children: [] });
  });

  it('refuses an agent key that asks for another agent\'s children', async () => {
    const tree = await seedTree();
    const app = await appWith();

    const res = await keyed(app, 'GET', `/agents/${tree.unrelated.agentId}/children`, tree.creator.rawKey);

    expect(res.statusCode).toBe(403);
  });

  it('deletes a stopped, childless direct child, removes its row and audits the delete as the parent', async () => {
    const tree = await seedTree();
    await removeGrandchild(db, tree.grandchild.agentId);
    const app = await appWith();

    const res = await keyed(app, 'DELETE', `/agents/${tree.creator.agentId}/children/${tree.child.agentId}`, tree.creator.rawKey);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true, stopped: false });
    expect(await rowExists(db, tree.child.agentId)).toBe(false);
    const audits = await db.select().from(agentAuditEvents).where(and(
      eq(agentAuditEvents.userId, tree.userId),
      eq(agentAuditEvents.action, 'agent.child_deleted'),
    ));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'agent', actorId: tree.creator.agentId, targetId: tree.child.agentId });
  });

  it('stops a running child first by default, then deletes it, and audits the stop and the delete', async () => {
    const tree = await seedTree();
    await removeGrandchild(db, tree.grandchild.agentId);
    await db.update(agents).set({ status: 'active' }).where(eq(agents.id, tree.child.agentId));
    const app = await appWith();

    const res = await keyed(app, 'DELETE', `/agents/${tree.creator.agentId}/children/${tree.child.agentId}`, tree.creator.rawKey);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true, stopped: true });
    expect(await rowExists(db, tree.child.agentId)).toBe(false);
    const audits = await db.select({ action: agentAuditEvents.action, actorId: agentAuditEvents.actorId }).from(agentAuditEvents).where(and(
      eq(agentAuditEvents.userId, tree.userId),
      eq(agentAuditEvents.targetId, tree.child.agentId),
    ));
    expect(audits).toEqual(expect.arrayContaining([
      { action: 'agent.creator_stopped_child', actorId: tree.creator.agentId },
      { action: 'agent.child_deleted', actorId: tree.creator.agentId },
    ]));
  });

  it('refuses a running child when stopFirst is false, and neither stops nor deletes it', async () => {
    const tree = await seedTree();
    await removeGrandchild(db, tree.grandchild.agentId);
    await db.update(agents).set({ status: 'active' }).where(eq(agents.id, tree.child.agentId));
    const app = await appWith();

    const res = await keyed(app, 'DELETE', `/agents/${tree.creator.agentId}/children/${tree.child.agentId}?stopFirst=false`, tree.creator.rawKey);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'agent.child.running',
      message: 'child is running; stop it first or pass stopFirst: true',
    });
    expect(await rowExists(db, tree.child.agentId)).toBe(true);
    const [row] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, tree.child.agentId));
    expect(row?.status).toBe('active');
  });

  it('refuses a child that has children of its own even when it is running, and stops nothing', async () => {
    const tree = await seedTree();
    await db.update(agents).set({ status: 'active' }).where(eq(agents.id, tree.child.agentId));
    const app = await appWith();

    const res = await keyed(app, 'DELETE', `/agents/${tree.creator.agentId}/children/${tree.child.agentId}`, tree.creator.rawKey);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'agent.child.has_children' });
    expect(await rowExists(db, tree.child.agentId)).toBe(true);
    expect(await rowExists(db, tree.grandchild.agentId)).toBe(true);
    const [row] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, tree.child.agentId));
    expect(row?.status).toBe('active');
  });

  it('refuses a stopFirst value that is neither true nor false', async () => {
    const tree = await seedTree();
    await removeGrandchild(db, tree.grandchild.agentId);
    const app = await appWith();

    const res = await keyed(app, 'DELETE', `/agents/${tree.creator.agentId}/children/${tree.child.agentId}?stopFirst=maybe`, tree.creator.rawKey);

    expect(res.statusCode).toBe(400);
    expect(await rowExists(db, tree.child.agentId)).toBe(true);
  });

  it('refuses to delete a child that has children of its own, and changes nothing', async () => {
    const tree = await seedTree();
    const app = await appWith();

    const res = await keyed(app, 'DELETE', `/agents/${tree.creator.agentId}/children/${tree.child.agentId}`, tree.creator.rawKey);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'agent.child.has_children' });
    expect(await rowExists(db, tree.child.agentId)).toBe(true);
    expect(await rowExists(db, tree.grandchild.agentId)).toBe(true);
  });

  it('refuses a grandchild as a target, both through the parent and through the child', async () => {
    const tree = await seedTree();
    await db.update(agents).set({ status: 'stopped' }).where(eq(agents.id, tree.grandchild.agentId));
    const app = await appWith();

    const viaCreator = await keyed(app, 'DELETE', `/agents/${tree.creator.agentId}/children/${tree.grandchild.agentId}`, tree.creator.rawKey);
    const viaChild = await keyed(app, 'DELETE', `/agents/${tree.child.agentId}/children/${tree.grandchild.agentId}`, tree.creator.rawKey);

    expect(viaCreator.statusCode).toBe(403);
    expect(viaChild.statusCode).toBe(403);
    expect(await rowExists(db, tree.grandchild.agentId)).toBe(true);
  });

  it('refuses an agent that is not the child\'s parent, even when the child id is real', async () => {
    const tree = await seedTree();
    const app = await appWith();

    const res = await keyed(app, 'DELETE', `/agents/${tree.unrelated.agentId}/children/${tree.child.agentId}`, tree.creator.rawKey);

    expect(res.statusCode).toBe(403);
    expect(await rowExists(db, tree.child.agentId)).toBe(true);
  });

  it('refuses an unknown child id as not a direct child', async () => {
    const tree = await seedTree();
    const app = await appWith();

    const res = await keyed(app, 'DELETE', `/agents/${tree.creator.agentId}/children/does-not-exist`, tree.creator.rawKey);

    expect(res.statusCode).toBe(403);
  });

  it('refuses the delete route for a user session, which has no agent key', async () => {
    const tree = await seedTree();
    const app = await appWith();
    const token = await userToken(db, tree.userId);

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${tree.creator.agentId}/children/${tree.child.agentId}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(await rowExists(db, tree.child.agentId)).toBe(true);
  });
});
