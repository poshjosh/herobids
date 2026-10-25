import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
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
  conversationMessages,
  generateAgentApiKey,
} from '@herobids/db';
import type { AuthConfig, PlansConfig } from '@herobids/domain';
import { AgentCreationConfigSchema, userAgentConversationId } from '@herobids/domain';
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
const PROMPT_MARKER = 'creator-test-secret-prompt-marker';

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

/** The real ExternalBackendClient with `invoke` replaced by a fixed decisions read for the decisions route. */
class FakeDecisionsBoundary extends ExternalBackendClient {
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
    if (input.toolName !== 'get_agent_decisions') {
      return { kind: 'transport_error', requestId, retryable: true, message: `unexpected tool ${input.toolName}` };
    }
    return {
      kind: 'success',
      requestId,
      correlationId: requestId,
      payload: { decisions: [{ id: 'decision-1', intent: 'hold', createdAt: '2026-10-25T00:00:00.000Z' }] },
    };
  }
}

async function buildApp(
  db: Db,
  redis: Redis,
  creatorMessageRatePerMinute = 10,
  boundary?: ExternalBackendClient,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await authPlugin(app, { config: makeAuthConfig(), db });
  const agentCreation = AgentCreationConfigSchema.parse({ creatorMessageRatePerMinute });
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
  await agentInteractivityRoutes(app, db, redis, undefined, undefined, undefined, undefined, agentCreation);
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
    email: `${userId}@creator-actions.test.local`,
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
    prompt: `${PROMPT_MARKER} ${suffix}`,
    skillIds: [],
    status: options.status ?? 'active',
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

interface CreatorFixture {
  userId: string;
  creator: SeededAgent;
  child: SeededAgent;
  grandchild: SeededAgent;
  unrelated: SeededAgent;
}

/** A creator with one direct child, a grandchild under that child, and an unrelated agent of the same owner. */
async function seedCreatorTree(db: Db): Promise<CreatorFixture> {
  const userId = await seedUser(db);
  const creator = await seedAgent(db, userId);
  const child = await seedAgent(db, userId, { parentAgentId: creator.agentId, depth: 1, withKey: false });
  const grandchild = await seedAgent(db, userId, { parentAgentId: child.agentId, depth: 2, withKey: false });
  const unrelated = await seedAgent(db, userId, { withKey: false });
  return { userId, creator, child, grandchild, unrelated };
}

function agentKeyRequest(app: FastifyInstance, method: 'GET' | 'POST', url: string, rawKey: string, payload?: Record<string, unknown>) {
  return app.inject({
    method,
    url,
    headers: { Authorization: `Bearer ${rawKey}` },
    payload,
  });
}

async function readAgent(db: Db, agentId: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
  return row;
}

describe.skipIf(SKIP)('creator agent actions on direct children (integration)', () => {
  let db: Db;
  let redis: Redis;
  const apps: FastifyInstance[] = [];
  const streamKeys: string[] = [];

  async function appWith(creatorMessageRatePerMinute?: number, boundary?: ExternalBackendClient): Promise<FastifyInstance> {
    const app = await buildApp(db, redis, creatorMessageRatePerMinute, boundary);
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
    await db.execute(sql`TRUNCATE conversations, agent_runtime_sessions, agents, sessions, users CASCADE`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(apps.splice(0).map((app) => app.close()));
    if (streamKeys.length > 0) await redis.del(...streamKeys.splice(0));
  });

  it('a creator key reads the status of a direct child', async () => {
    const tree = await seedCreatorTree(db);
    const app = await appWith();

    const res = await agentKeyRequest(app, 'GET', `/agents/${tree.child.agentId}/status`, tree.creator.rawKey);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: tree.child.agentId,
      status: 'active',
      depth: 1,
      parentAgentId: tree.creator.agentId,
      childAgentLimit: 2,
      runtimeStatus: null,
    });
  });

  it('a creator key status response carries only the status projection, with no prompt, config or key fields', async () => {
    const tree = await seedCreatorTree(db);
    const app = await appWith();

    const res = await agentKeyRequest(app, 'GET', `/agents/${tree.child.agentId}/status`, tree.creator.rawKey);

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(
      ['childAgentLimit', 'depth', 'id', 'name', 'parentAgentId', 'runtimeStatus', 'status'],
    );
    expect(res.body).not.toContain(PROMPT_MARKER);
    expect(res.body).not.toContain('apiKeyHash');
    expect(res.body).not.toContain(tree.creator.rawKey);
  });

  it('a creator key reads the decisions of a direct child', async () => {
    const tree = await seedCreatorTree(db);
    const app = await appWith(undefined, new FakeDecisionsBoundary());

    const res = await agentKeyRequest(app, 'GET', `/agents/${tree.child.agentId}/decisions`, tree.creator.rawKey);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ id: 'decision-1', intent: 'hold' }]);
  });

  it('a creator key cannot read the decisions of an agent that is not its child', async () => {
    const tree = await seedCreatorTree(db);
    const app = await appWith(undefined, new FakeDecisionsBoundary());

    const res = await agentKeyRequest(app, 'GET', `/agents/${tree.unrelated.agentId}/decisions`, tree.creator.rawKey);

    expect(res.statusCode).toBe(403);
  });

  it('a creator key cannot read the decisions of a grandchild', async () => {
    const tree = await seedCreatorTree(db);
    const app = await appWith(undefined, new FakeDecisionsBoundary());

    const res = await agentKeyRequest(app, 'GET', `/agents/${tree.grandchild.agentId}/decisions`, tree.creator.rawKey);

    expect(res.statusCode).toBe(403);
  });

  it('a creator key cannot read the status of an agent that is not its child', async () => {
    const tree = await seedCreatorTree(db);
    const app = await appWith();

    const res = await agentKeyRequest(app, 'GET', `/agents/${tree.unrelated.agentId}/status`, tree.creator.rawKey);

    expect(res.statusCode).toBe(403);
  });

  it('a creator key cannot read the status of a grandchild', async () => {
    const tree = await seedCreatorTree(db);
    const app = await appWith();

    const res = await agentKeyRequest(app, 'GET', `/agents/${tree.grandchild.agentId}/status`, tree.creator.rawKey);

    expect(res.statusCode).toBe(403);
  });

  it('a creator key pauses a direct child and the pause records the creator as requester', async () => {
    const tree = await seedCreatorTree(db);
    const app = await appWith();

    const res = await agentKeyRequest(app, 'POST', `/agents/${tree.child.agentId}/pause`, tree.creator.rawKey, { reason: 'checking in' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'paused' });
    const child = await readAgent(db, tree.child.agentId);
    expect(child?.status).toBe('paused');
    expect(child?.pauseState).toMatchObject({ requestedBy: `agent:${tree.creator.agentId}`, reason: 'checking in' });
  });

  it('a creator key stops a direct child', async () => {
    const tree = await seedCreatorTree(db);
    const app = await appWith();

    const res = await agentKeyRequest(app, 'POST', `/agents/${tree.child.agentId}/stop`, tree.creator.rawKey);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'stopped' });
    const child = await readAgent(db, tree.child.agentId);
    expect(child?.status).toBe('stopped');
    expect(child?.pauseState).toBeNull();
  });

  it('a creator key cannot pause or stop an agent that is not its child, nor a grandchild', async () => {
    const tree = await seedCreatorTree(db);
    const app = await appWith();

    const pause = await agentKeyRequest(app, 'POST', `/agents/${tree.unrelated.agentId}/pause`, tree.creator.rawKey);
    const stop = await agentKeyRequest(app, 'POST', `/agents/${tree.unrelated.agentId}/stop`, tree.creator.rawKey);
    const pauseGrandchild = await agentKeyRequest(app, 'POST', `/agents/${tree.grandchild.agentId}/pause`, tree.creator.rawKey);

    expect(pause.statusCode).toBe(403);
    expect(stop.statusCode).toBe(403);
    expect(pauseGrandchild.statusCode).toBe(403);
    expect((await readAgent(db, tree.unrelated.agentId))?.status).toBe('active');
    expect((await readAgent(db, tree.grandchild.agentId))?.status).toBe('active');
  });

  it('a creator key cannot resume or start a direct child', async () => {
    const tree = await seedCreatorTree(db);
    await db.update(agents).set({ status: 'paused' }).where(eq(agents.id, tree.child.agentId));
    const app = await appWith();

    const resume = await agentKeyRequest(app, 'POST', `/agents/${tree.child.agentId}/resume`, tree.creator.rawKey);
    await db.update(agents).set({ status: 'stopped' }).where(eq(agents.id, tree.child.agentId));
    const start = await agentKeyRequest(app, 'POST', `/agents/${tree.child.agentId}/start`, tree.creator.rawKey);

    expect(resume.statusCode).toBe(403);
    expect(start.statusCode).toBe(403);
    expect((await readAgent(db, tree.child.agentId))?.status).toBe('stopped');
  });

  it('a creator key sends a message to a direct child, stored and published as the creator', async () => {
    const tree = await seedCreatorTree(db);
    const app = await appWith();
    streamKeys.push(`agent:outbound:${tree.child.agentId}`);

    const res = await agentKeyRequest(app, 'POST', `/agents/${tree.child.agentId}/message`, tree.creator.rawKey, { message: 'Status update?' });

    expect(res.statusCode).toBe(202);
    const [conversationRow] = await db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, userAgentConversationId(tree.child.agentId)));
    expect(conversationRow).toMatchObject({ senderType: 'agent', senderId: tree.creator.agentId, body: 'Status update?', deliveryStatus: 'sent' });
    expect(res.json()).toMatchObject({ delivered: true, message: { id: conversationRow?.id, senderType: 'agent', senderId: tree.creator.agentId } });
    const entries = await redis.xrange(`agent:outbound:${tree.child.agentId}`, '-', '+');
    expect(entries).toHaveLength(1);
    const envelope = JSON.parse(entries[0]![1][1]!) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      initiatorType: 'agent',
      initiatorId: tree.creator.agentId,
      agentId: tree.child.agentId,
      type: 'agent.user.message',
      payload: { message: 'Status update?' },
    });
  });

  it('a creator key retries a failed message under its own authorship: same id, one more publish, one row', async () => {
    const tree = await seedCreatorTree(db);
    const app = await appWith();
    streamKeys.push(`agent:outbound:${tree.child.agentId}`);
    const clientMessageId = crypto.randomUUID();
    const send = () => agentKeyRequest(app, 'POST', `/agents/${tree.child.agentId}/message`, tree.creator.rawKey, { message: 'Status update?', clientMessageId });
    const xadd = vi.spyOn(redis, 'xadd').mockRejectedValueOnce(new Error('redis unavailable') as never);

    const failed = await send();

    expect(failed.statusCode).toBe(503);
    const [afterFailure] = await db.select().from(conversationMessages).where(eq(conversationMessages.id, clientMessageId));
    expect(afterFailure).toMatchObject({ senderType: 'agent', senderId: tree.creator.agentId, deliveryStatus: 'failed' });
    expect(await redis.xlen(`agent:outbound:${tree.child.agentId}`)).toBe(0);

    const retry = await send();
    const repeat = await send();

    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ delivered: true, message: { id: clientMessageId, senderType: 'agent', senderId: tree.creator.agentId, deliveryStatus: 'sent' } });
    expect(repeat.statusCode).toBe(202);
    expect(xadd).toHaveBeenCalledTimes(2);
    const entries = await redis.xrange(`agent:outbound:${tree.child.agentId}`, '-', '+');
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]![1][1]!)).toMatchObject({ messageId: clientMessageId, type: 'agent.user.message', initiatorId: tree.creator.agentId });
    expect(await db.select().from(conversationMessages).where(eq(conversationMessages.id, clientMessageId))).toHaveLength(1);
  });

  it('a creator key is refused with 429 once the creator-child pair bucket is empty', async () => {
    const tree = await seedCreatorTree(db);
    const app = await appWith(1);
    streamKeys.push(`agent:outbound:${tree.child.agentId}`);

    const first = await agentKeyRequest(app, 'POST', `/agents/${tree.child.agentId}/message`, tree.creator.rawKey, { message: 'one' });
    const second = await agentKeyRequest(app, 'POST', `/agents/${tree.child.agentId}/message`, tree.creator.rawKey, { message: 'two' });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
    expect(await redis.xlen(`agent:outbound:${tree.child.agentId}`)).toBe(1);
  });

  it('a creator key cannot message an agent that is not its child or a grandchild', async () => {
    const tree = await seedCreatorTree(db);
    const app = await appWith();

    const unrelated = await agentKeyRequest(app, 'POST', `/agents/${tree.unrelated.agentId}/message`, tree.creator.rawKey, { message: 'hi' });
    const grandchild = await agentKeyRequest(app, 'POST', `/agents/${tree.grandchild.agentId}/message`, tree.creator.rawKey, { message: 'hi' });

    expect(unrelated.statusCode).toBe(403);
    expect(grandchild.statusCode).toBe(403);
    expect(await db.select().from(conversationMessages)).toHaveLength(0);
  });

  it('a user caller pauses and stops an owned agent with requestedBy user', async () => {
    const tree = await seedCreatorTree(db);
    const token = await userToken(db, tree.userId);
    const app = await appWith();

    const pause = await app.inject({
      method: 'POST',
      url: `/agents/${tree.unrelated.agentId}/pause`,
      headers: { Authorization: `Bearer ${token}` },
      payload: {},
    });
    const pausedRow = await readAgent(db, tree.unrelated.agentId);
    const stop = await app.inject({
      method: 'POST',
      url: `/agents/${tree.unrelated.agentId}/stop`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(pause.statusCode).toBe(200);
    expect(pausedRow?.pauseState).toMatchObject({ requestedBy: 'user' });
    expect(stop.statusCode).toBe(200);
    expect((await readAgent(db, tree.unrelated.agentId))?.status).toBe('stopped');
  });

  it('a user caller reads the status of an owned agent that is not a child of any agent', async () => {
    const tree = await seedCreatorTree(db);
    const token = await userToken(db, tree.userId);
    const app = await appWith();

    const res = await app.inject({
      method: 'GET',
      url: `/agents/${tree.unrelated.agentId}/status`,
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: tree.unrelated.agentId, parentAgentId: null });
  });
});
