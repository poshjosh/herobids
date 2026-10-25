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
  agentAuditEvents,
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
import { agentInteractivityRoutes } from './agent-interactivity.js';

const SKIP = !process.env['DATABASE_URL'];

const TEST_JWT_SECRET = 'test-secret-for-integration-tests-32ch!!';
const PROMPT_MARKER = 'audit-test-prompt-marker';

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

interface BotRow {
  id: string;
  status: string;
  creatorType: string;
  creatorId: string;
}

/** The real boundary client with `invoke` replaced by an in-memory bot list. Only the delete cascade's tools are served. */
class InMemoryBotBoundary extends ExternalBackendClient {
  bots: BotRow[];

  constructor(bots: BotRow[]) {
    super({
      baseUrl: 'http://127.0.0.1:9',
      consumerId: 'test-consumer',
      keyId: 'test-key',
      hmacSecret: 'test-hmac-secret',
      requestTimeoutMs: 1000,
    });
    this.bots = bots;
  }

  override async invoke(input: InvokeToolInput): Promise<ExternalBackendClientResult> {
    const requestId = crypto.randomUUID();
    if (input.toolName === 'list_owner_bots') {
      return { kind: 'success', requestId, correlationId: requestId, payload: { bots: this.bots } };
    }
    if (input.toolName === 'delete_bot') {
      const botId = String((input.payload as { botId?: unknown }).botId);
      this.bots = this.bots.filter((bot) => bot.id !== botId);
      return { kind: 'success', requestId, correlationId: requestId, payload: {} };
    }
    return { kind: 'transport_error', requestId, retryable: true, message: `unexpected tool ${input.toolName}` };
  }
}

interface BuildOptions {
  redis: Redis;
  boundary?: ExternalBackendClient;
}

async function buildApp(db: Db, options: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await authPlugin(app, { config: makeAuthConfig(), db });
  const agentCreation = AgentCreationConfigSchema.parse({});
  await agentRoutes(
    app,
    db,
    makePlansConfig(),
    undefined,
    undefined,
    options.redis,
    { provider: 'openai' },
    options.boundary,
    undefined,
    undefined,
    undefined,
    agentCreation,
  );
  await agentInteractivityRoutes(app, db, options.redis, undefined, undefined, undefined, undefined, agentCreation);
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
    email: `${userId}@agent-audit.test.local`,
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
  options: { parentAgentId?: string; depth?: number; status?: string; childAgentLimit?: number; withKey?: boolean } = {},
): Promise<SeededAgent> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const agentId = `agent-${suffix}`;
  const now = new Date();
  await db.insert(agents).values({
    id: agentId,
    userId,
    name: `Agent ${suffix}`,
    prompt: `${PROMPT_MARKER} ${suffix}`,
    skillIds: [],
    status: options.status ?? 'active',
    creatorType: options.parentAgentId ? 'agent' : 'user',
    creatorId: options.parentAgentId ?? userId,
    parentAgentId: options.parentAgentId ?? null,
    depth: options.depth ?? 0,
    childAgentLimit: options.childAgentLimit ?? 2,
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

function agentKeyRequest(app: FastifyInstance, method: 'POST' | 'PUT' | 'DELETE', url: string, rawKey: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url, headers: { Authorization: `Bearer ${rawKey}` }, payload });
}

async function auditEventsFor(db: Db, userId: string) {
  return db.select().from(agentAuditEvents).where(eq(agentAuditEvents.userId, userId));
}

async function childrenOf(db: Db, parentId: string) {
  return db.select().from(agents).where(eq(agents.parentAgentId, parentId));
}

describe.skipIf(SKIP)('agent audit events (integration)', () => {
  let db: Db;
  let redis: Redis;
  const apps: FastifyInstance[] = [];
  const streamKeys: string[] = [];

  async function appWith(options: Partial<BuildOptions> = {}): Promise<FastifyInstance> {
    const app = await buildApp(db, { redis, ...options });
    apps.push(app);
    return app;
  }

  beforeAll(() => {
    db = createDatabase(process.env['DATABASE_URL']!);
    // Real Redis: the create and message rate limiters are Lua scripts.
    redis = new Redis();
  });

  afterAll(() => {
    redis.disconnect();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE agent_audit_events, agent_outbound_messages, agent_runtime_sessions, agents, sessions, users CASCADE`);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    if (streamKeys.length > 0) await redis.del(...streamKeys.splice(0));
  });

  it('a child created by an agent key writes one agent.child_created event with the agent as actor and no prompt or key in detail', async () => {
    const userId = await seedUser(db);
    const parent = await seedAgent(db, userId, { childAgentLimit: 1, depth: 1 });
    const app = await appWith();

    const res = await agentKeyRequest(app, 'POST', '/agents', parent.rawKey, { name: 'Child', prompt: `${PROMPT_MARKER} child` });

    expect(res.statusCode).toBe(201);
    const [child] = await childrenOf(db, parent.agentId);
    const events = await auditEventsFor(db, userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'agent',
      actorId: parent.agentId,
      action: 'agent.child_created',
      targetType: 'agent',
      targetId: child!.id,
    });
    expect(events[0]!.detail).toEqual({ parentAgentId: parent.agentId, depth: 2 });
    const serialized = JSON.stringify(events[0]!.detail);
    expect(serialized).not.toContain(PROMPT_MARKER);
    expect(serialized).not.toContain(parent.rawKey);
  });

  it('a refused child creation writes no event', async () => {
    const userId = await seedUser(db);
    const parent = await seedAgent(db, userId, { childAgentLimit: 0 });
    const app = await appWith();

    const res = await agentKeyRequest(app, 'POST', '/agents', parent.rawKey, { name: 'Child', prompt: 'Help.' });

    expect(res.statusCode).toBe(403);
    expect(await auditEventsFor(db, userId)).toHaveLength(0);
  });

  it('a child limit change writes one agent.child_limit_set event with the user as actor', async () => {
    const userId = await seedUser(db);
    const parent = await seedAgent(db, userId, { childAgentLimit: 0, withKey: false });
    const token = await userToken(db, userId);
    const app = await appWith();

    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${parent.agentId}/child-limit`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { childAgentLimit: 2 },
    });

    expect(res.statusCode).toBe(200);
    const events = await auditEventsFor(db, userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'user',
      actorId: userId,
      action: 'agent.child_limit_set',
      targetId: parent.agentId,
      detail: { childAgentLimit: 2 },
    });
  });

  it('a creator pause of a direct child writes one agent.creator_paused_child event with the creator as actor', async () => {
    const userId = await seedUser(db);
    const creator = await seedAgent(db, userId);
    const child = await seedAgent(db, userId, { parentAgentId: creator.agentId, depth: 1, withKey: false });
    const app = await appWith();

    const res = await agentKeyRequest(app, 'POST', `/agents/${child.agentId}/pause`, creator.rawKey, {});

    expect(res.statusCode).toBe(200);
    const events = await auditEventsFor(db, userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'agent',
      actorId: creator.agentId,
      action: 'agent.creator_paused_child',
      targetId: child.agentId,
    });
  });

  it('a creator stop of a direct child writes one agent.creator_stopped_child event', async () => {
    const userId = await seedUser(db);
    const creator = await seedAgent(db, userId);
    const child = await seedAgent(db, userId, { parentAgentId: creator.agentId, depth: 1, withKey: false });
    const app = await appWith();

    const res = await agentKeyRequest(app, 'POST', `/agents/${child.agentId}/stop`, creator.rawKey);

    expect(res.statusCode).toBe(200);
    const events = await auditEventsFor(db, userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: 'agent', actorId: creator.agentId, action: 'agent.creator_stopped_child' });
  });

  it('a user pause writes no event', async () => {
    const userId = await seedUser(db);
    const owned = await seedAgent(db, userId, { withKey: false });
    const token = await userToken(db, userId);
    const app = await appWith();

    const res = await app.inject({
      method: 'POST',
      url: `/agents/${owned.agentId}/pause`,
      headers: { Authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(await auditEventsFor(db, userId)).toHaveLength(0);
  });

  it('a creator message to a direct child writes one agent.creator_messaged_child event without the message text', async () => {
    const userId = await seedUser(db);
    const creator = await seedAgent(db, userId);
    const child = await seedAgent(db, userId, { parentAgentId: creator.agentId, depth: 1, withKey: false });
    const app = await appWith();
    streamKeys.push(`agent:outbound:${child.agentId}`);

    const res = await agentKeyRequest(app, 'POST', `/agents/${child.agentId}/message`, creator.rawKey, { message: 'status-text-marker' });

    expect(res.statusCode).toBe(202);
    const events = await auditEventsFor(db, userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: 'agent', actorId: creator.agentId, action: 'agent.creator_messaged_child' });
    expect(JSON.stringify(events[0]!.detail ?? {})).not.toContain('status-text-marker');
  });

  it('a subtree delete writes one agent.deleted event with the scope and the agent and bot counts', async () => {
    const userId = await seedUser(db);
    const root = await seedAgent(db, userId, { status: 'stopped', withKey: false });
    const child = await seedAgent(db, userId, { parentAgentId: root.agentId, depth: 1, status: 'stopped', withKey: false });
    await seedAgent(db, userId, { parentAgentId: child.agentId, depth: 2, status: 'stopped', withKey: false });
    const boundary = new InMemoryBotBoundary([
      { id: 'bot-root', status: 'stopped', creatorType: 'agent', creatorId: root.agentId },
      { id: 'bot-child', status: 'stopped', creatorType: 'agent', creatorId: child.agentId },
    ]);
    const token = await userToken(db, userId);
    const app = await appWith({ boundary });

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${root.agentId}?scope=subtree`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ scope: 'subtree', agentCount: 3, botCount: 2 });
    const events = await auditEventsFor(db, userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'user',
      actorId: userId,
      action: 'agent.deleted',
      targetId: root.agentId,
      detail: { scope: 'subtree', agentCount: 3, botCount: 2 },
    });
  });

  it('an agent-only delete writes one agent.deleted event with scope agent and one agent', async () => {
    const userId = await seedUser(db);
    const root = await seedAgent(db, userId, { status: 'stopped', withKey: false });
    await seedAgent(db, userId, { parentAgentId: root.agentId, depth: 1, status: 'stopped', withKey: false });
    const boundary = new InMemoryBotBoundary([]);
    const token = await userToken(db, userId);
    const app = await appWith({ boundary });

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${root.agentId}?scope=agent`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const events = await auditEventsFor(db, userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'user',
      action: 'agent.deleted',
      targetId: root.agentId,
      detail: { scope: 'agent', agentCount: 1, botCount: 0 },
    });
  });
});
