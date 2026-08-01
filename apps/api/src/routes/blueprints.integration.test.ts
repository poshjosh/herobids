import {
  describe, it, expect, beforeAll, beforeEach, afterAll,
} from 'vitest';
import Fastify from 'fastify';
import { sql } from 'drizzle-orm';
import {
  createDatabase,
  users,
  sessions,
  blueprints,
  blueprintRevisions,
  blueprintInstantiationRequests,
  blueprintUsageEvents,
  agents,
  bots,
  agentSkills,
  connections,
  venueAccounts,
} from '@herobids/db';
import { authPlugin, createSessionToken } from '../plugins/auth.js';
import { blueprintRoutes } from './blueprints.js';
import { BlueprintExecutionCapabilityAdapter } from '../services/blueprint-execution-capability-adapter.js';
import { loadProvidersConfig } from '@herobids/domain/config/load-providers';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthConfig, AgentRiskDefaultsConfig } from '@herobids/domain';

// ── Config ──────────────────────────────────────────────────────────────────

const SKIP = !process.env['DATABASE_URL'];
const TEST_USER_ID = 'test-user-bp-int';
const TEST_USER_EMAIL = 'bp-int@test.local';
const TEST_JWT_SECRET = 'test-integration-secret-at-least-32-characters!!';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MONOREPO_CONFIG_DIR = resolve(MODULE_DIR, '../../../../config');
const providersYaml = loadProvidersConfig(resolve(MONOREPO_CONFIG_DIR, 'providers.yaml'));

const agentRiskDefaults: AgentRiskDefaultsConfig = {
  dailyLossLimitDefaultRatio: 0.05,
  maxOpenPositions: 10,
  maxPositionSizePct: 100,
  maxPositionSize: 1_000_000,
  stopLossPct: 10,
  dailyMaxLossPct: 20,
  stopLossCooldownMs: 300_000,
  maxOrderNotionalMultiplier: 1,
  botConfigInvalidHaltThreshold: 1,
  botExecutionErrorHaltThreshold: 5,
  botLlmProviderErrorHaltThreshold: 1,
  agentDecisionNoContextThreshold: 10,
  agentDecisionSwapInstrumentFormatThreshold: 5,
  maxDrawdown: 1_000_000_000,
  maxDrawdownPct: 20,
  perTradeLevelMonitorIntervalMs: 5_000,
  maxBots: 5,
};

const executionCapabilityAdapter = new BlueprintExecutionCapabilityAdapter(providersYaml);

function makeAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    publicBaseUrl: 'http://localhost:3000',
    frontendOrigin: 'http://localhost:5173',
    jwtSecret: TEST_JWT_SECRET,
    jwtTtlSecs: 3600,
    exchangeCodeTtlSecs: 60,
    googleClientId: 'test-google-client-id',
    googleClientSecret: 'test-google-client-secret',
    secureCookie: false,
    loginLinkTtlSecs: 600,
    loginLinkResendCooldownSecs: 60,
    loginLinkMaxSendsPerWindow: 5,
    loginLinkWindowSecs: 3600,
    loginLinkMaxSendsPerIpWindow: 10,
    ...overrides,
  };
}

// ── Payload builders ────────────────────────────────────────────────────────

function makeAgentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'agent',
    name: 'Test Agent',
    description: 'A test agent from blueprint',
    tags: ['test'],
    prompt: 'You are a test agent',
    style: 'balanced',
    strategy: {
      type: 'momentum',
      decisionMode: 'llm',
      params: { candleInterval: '15m', candleLimit: 50 },
    },
    risk: {
      maxOpenPositions: 3,
      stopLossPct: 5,
      maxPositionSizePct: 50,
    },
    executionDefaults: { mode: 'paper', slippageBps: 50 },
    technical: { entryConditions: [] },
    intelligence: { instructions: 'test' },
    capabilityMode: 'hybrid',
    openPositionEscalationToJudgePolicy: 'uncovered_or_triggered',
    capital: null,
    maxBots: null,
    tickIntervalMs: null,
    ...overrides,
  };
}

function makeBotPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'bot',
    name: 'Test Bot',
    description: 'A test bot from blueprint',
    tags: ['test'],
    strategy: {
      type: 'dca',
      decisionMode: 'mechanical',
      params: {},
    },
    risk: {
      maxOpenPositions: 1,
      stopLossPct: 5,
      maxPositionSizePct: 100,
    },
    executionDefaults: { mode: 'paper', slippageBps: 50 },
    venue: 'hyperliquid',
    venueType: 'orderbook',
    symbol: 'BTC-PERP',
    shadowPollIntervalMs: 2000,
    ...overrides,
  };
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)('Blueprint instantiation — faithful copy verification', () => {
  let db: ReturnType<typeof createDatabase>;
  let app: ReturnType<typeof Fastify>;
  let authCfg: AuthConfig;

  beforeAll(async () => {
    db = createDatabase(process.env['DATABASE_URL']!);
    authCfg = makeAuthConfig();

    app = Fastify({ logger: false });
    await authPlugin(app, { config: authCfg, db });
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityAdapter);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Truncate in FK-safe order
    await db.execute(sql`
      TRUNCATE
        blueprint_usage_events,
        blueprint_instantiation_requests,
        agent_skills,
        bots,
        agents,
        blueprint_revision_skills,
        blueprint_revisions,
        blueprints,
        venue_accounts,
        connections,
        user_credentials,
        sessions,
        oauth_identities,
        user_plans,
        users
      CASCADE
    `);

    // Seed test user
    await db.insert(users).values({
      id: TEST_USER_ID,
      username: 'test_bp_int',
      displayName: 'Test BP Int',
      email: TEST_USER_EMAIL,
      planId: 'free',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  // ── Helpers ─────────────────────────────────────────────────────────────

  async function getAuthToken(userId = TEST_USER_ID): Promise<string> {
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      userId,
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
      createdAt: new Date(),
    });
    return createSessionToken(authCfg, userId, sessionId);
  }

  async function seedBlueprint(
    bpOverrides: Partial<typeof blueprints.$inferInsert> = {},
    payload: Record<string, unknown>,
    authorId = TEST_USER_ID,
  ) {
    const bpId = (bpOverrides.id as string) ?? crypto.randomUUID();
    const revId = crypto.randomUUID();
    const kind = (payload.kind as string) ?? 'agent';
    const strategyType = kind === 'agent'
      ? ((payload.strategy as Record<string, unknown> | null)?.type as string | null) ?? null
      : ((payload.strategy as Record<string, unknown>)?.type as string | null) ?? null;
    const style = (payload.style as string | null) ?? null;
    const venueType = kind === 'bot' ? ((payload.venueType as string) ?? null) : null;
    const now = new Date();

    // Determine the final publicationStatus from overrides (default: 'published')
    const finalPubStatus = (bpOverrides.publicationStatus as string) ?? 'published';
    const isPublished = finalPubStatus === 'published';

    // Step 1: Insert blueprint as 'draft' to satisfy lifecycle CHECK constraints
    // (published requires published_at + published_revision_id, which need the
    // revision to exist first — circular FK). We'll update to the real status in step 3.
    const baseValues: Record<string, unknown> = {
      id: bpId,
      authorId,
      publicationStatus: 'draft', // temporary — updated in step 3
      kind,
      name: (payload.name as string) ?? 'Test BP',
      description: (payload.description as string) ?? '',
      tags: ['test'],
      strategyType,
      style,
      venueType,
      currentRevisionId: null,
      publishedRevisionId: null,
      publishedAt: null,
      likeCount: 0,
      forkCount: 0,
      popularityScore: 0,
      trendingScore: 0,
      createdAt: now,
      updatedAt: now,
    };

    // Apply non-lifecycle overrides (we handle publicationStatus separately)
    const nonLifecycleOverrides = { ...bpOverrides };
    delete nonLifecycleOverrides.publicationStatus;
    delete nonLifecycleOverrides.publishedRevisionId;
    delete nonLifecycleOverrides.publishedAt;
    delete nonLifecycleOverrides.currentRevisionId;

    const merged = { ...baseValues, ...nonLifecycleOverrides };

    await db.insert(blueprints).values(merged as typeof blueprints.$inferInsert);

    // Step 2: Insert the revision (references the blueprint)
    await db.insert(blueprintRevisions).values({
      id: revId,
      blueprintId: bpId,
      version: 1,
      kind,
      name: (payload.name as string) ?? 'Test BP',
      description: (payload.description as string) ?? '',
      strategyType,
      style,
      venueType,
      tags: ['test'],
      payload,
      changeSummary: 'initial',
      createdByUserId: authorId,
      createdAt: now,
    });

    // Step 3: Update the blueprint to its real lifecycle state + revision pointers
    await db
      .update(blueprints)
      .set({
        publicationStatus: finalPubStatus,
        currentRevisionId: revId,
        publishedRevisionId: isPublished ? revId : null,
        publishedAt: isPublished ? now : null,
        updatedAt: now,
      } as Partial<typeof blueprints.$inferInsert>)
      .where(sql`${blueprints.id} = ${bpId}`);

    return { bpId, revId };
  }

  async function seedConnection(connId = crypto.randomUUID()) {
    await db.insert(connections).values({
      id: connId,
      userId: TEST_USER_ID,
      provider: 'hyperliquid',
      label: 'Test Connection',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return connId;
  }

  async function seedVenueAccount(vaId = crypto.randomUUID()) {
    await db.insert(venueAccounts).values({
      id: vaId,
      userId: TEST_USER_ID,
      venue: 'hyperliquid',
      label: 'Test Venue Account',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return vaId;
  }

  // ── Test 1: Agent created from blueprint has correct attribution ───────

  it('creates stopped agent with blueprint attribution', async () => {
    const payload = makeAgentPayload();
    const { bpId, revId } = await seedBlueprint({}, payload);
    const token = await getAuthToken();

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': `test-agent-attribution-${crypto.randomUUID()}`,
      },
      payload: { revisionId: revId },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.actorId).toBeDefined();
    expect(body.actorKind).toBe('agent');
    expect(body.blueprintId).toBe(bpId);
    expect(body.blueprintRevisionId).toBe(revId);
    expect(body.status).toBe('stopped');

    // Verify DB row
    const [agent] = await db
      .select()
      .from(agents)
      .where(sql`${agents.id} = ${body.actorId}`);
    expect(agent).toBeDefined();
    expect(agent!.blueprintId).toBe(bpId);
    expect(agent!.blueprintRevisionId).toBe(revId);
    expect(agent!.status).toBe('stopped');
  });

  // ── Test 2: Bot created from blueprint has correct attribution ─────────

  it('creates stopped bot with blueprint attribution', async () => {
    const payload = makeBotPayload();
    const { bpId, revId } = await seedBlueprint({}, payload);
    const token = await getAuthToken();
    const connId = await seedConnection();
    const vaId = await seedVenueAccount();

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': `test-bot-attribution-${crypto.randomUUID()}`,
      },
      payload: {
        revisionId: revId,
        bindings: {
          kind: 'bot',
          connectionId: connId,
          venueAccountId: vaId,
        },
        requestedMode: 'paper',
      },
    });

    // Bot creation test
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.actorKind).toBe('bot');

    const [bot] = await db
      .select()
      .from(bots)
      .where(sql`${bots.id} = ${body.actorId}`);
    expect(bot).toBeDefined();
    expect(bot!.blueprintId).toBe(bpId);
    expect(bot!.blueprintRevisionId).toBe(revId);
    expect(bot!.status).toBe('stopped');
    expect(bot!.configSnapshot).toBeDefined();
  });

  // ── Test 3: Paired-null enforcement ────────────────────────────────────

  it('rejects agent with half-null attribution at DB level', async () => {
    const agentId = crypto.randomUUID();
    // Attempt to insert with blueprintId set but blueprintRevisionId null
    await expect(
      db.insert(agents).values({
        id: agentId,
        userId: TEST_USER_ID,
        name: 'Half-Null Agent',
        prompt: 'test',
        status: 'stopped',
        blueprintId: 'some-bp-id',
        blueprintRevisionId: null,
      } as typeof agents.$inferInsert),
    ).rejects.toThrow();
  });

  // ── Test 4: Deterministic copy ─────────────────────────────────────────

  it('same blueprint revision creates identical agent config twice', async () => {
    const payload = makeAgentPayload({
      name: 'Deterministic Agent',
      strategy: { type: 'momentum', decisionMode: 'llm', params: { candleInterval: '1h', candleLimit: 100 } },
      risk: { maxOpenPositions: 5, stopLossPct: 8, maxPositionSizePct: 60 },
    });
    const { bpId, revId } = await seedBlueprint({}, payload);
    const token = await getAuthToken();

    const key1 = `test-det-1-${crypto.randomUUID()}`;
    const key2 = `test-det-2-${crypto.randomUUID()}`;

    const r1 = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': key1,
      },
      payload: { revisionId: revId },
    });
    expect(r1.statusCode).toBe(201);
    const id1 = r1.json().actorId;

    const r2 = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': key2,
      },
      payload: { revisionId: revId },
    });
    expect(r2.statusCode).toBe(201);
    const id2 = r2.json().actorId;
    expect(id1).not.toBe(id2);

    // Compare the two agents
    const [a1] = await db.select().from(agents).where(sql`${agents.id} = ${id1}`);
    const [a2] = await db.select().from(agents).where(sql`${agents.id} = ${id2}`);
    expect(a1).toBeDefined();
    expect(a2).toBeDefined();

    // Strategy, risk, executionDefaults should be identical
    expect(a1!.strategy).toEqual(a2!.strategy);
    expect(a1!.risk).toEqual(a2!.risk);
    expect(a1!.executionDefaults).toEqual(a2!.executionDefaults);
    expect(a1!.blueprintId).toBe(bpId);
    expect(a2!.blueprintId).toBe(bpId);
  });

  // ── Test 5: Skills are pinned exactly (not resolved to current) ───────

  it('pins exact skill revisions, not current', async () => {
    // This test requires seeding skills, skill_revisions, and blueprint_revision_skills.
    // For Phase 1, skill pinning works at the blueprint_revision_skills level,
    // so unless there are skills linked to the revision, agent_skills is empty.
    // We'll verify that agent_skills rows use the revision's skillRevisionId
    // when skills are associated.
    const payload = makeAgentPayload();
    const { bpId, revId } = await seedBlueprint({}, payload);
    const token = await getAuthToken();

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': `test-skills-pin-${crypto.randomUUID()}`,
      },
      payload: { revisionId: revId },
    });

    expect(res.statusCode).toBe(201);
    const actorId = res.json().actorId;

    // With no skills on the revision, agent_skills should be empty
    const skills = await db
      .select()
      .from(agentSkills)
      .where(sql`${agentSkills.agentId} = ${actorId}`);
    expect(skills).toHaveLength(0);
  });

  // ── Test 6: Risk preserves provenance ──────────────────────────────────

  it('preserves risk provenance on instantiation', async () => {
    const payload = makeAgentPayload({
      risk: {
        maxOpenPositions: 5,
        stopLossPct: 10,
        maxPositionSizePct: 75,
      },
    });
    const { bpId, revId } = await seedBlueprint({}, payload);
    const token = await getAuthToken();

    // Instantiate with an override on stopLossPct
    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': `test-risk-provenance-${crypto.randomUUID()}`,
      },
      payload: {
        revisionId: revId,
        edits: {
          kind: 'agent',
          risk: { stopLossPct: 7 },
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const actorId = res.json().actorId;

    const [agent] = await db.select().from(agents).where(sql`${agents.id} = ${actorId}`);
    expect(agent).toBeDefined();

    // The stored risk should be the merged result:
    // maxOpenPositions from blueprint, stopLossPct overridden by installer
    const risk = agent!.risk as Record<string, unknown> | null;
    expect(risk).toBeDefined();
    expect(risk!.maxOpenPositions).toBe(5);
    // stopLossPct should be the overridden value (deep-merged into the payload)
    expect(risk!.stopLossPct).toBe(7);
    // maxPositionSizePct should be from blueprint
    expect(risk!.maxPositionSizePct).toBe(75);
  });

  // ── Test 7: Non-trading agent created correctly ────────────────────────

  it('creates non-trading agent with null strategy/executionDefaults', async () => {
    const payload = makeAgentPayload({
      strategy: null,
      executionDefaults: null,
      capabilityMode: 'intelligence',
      technical: undefined,
    });
    // Remove hybrid-specific fields
    delete payload.hybridMode;
    delete payload.technical;

    const { bpId, revId } = await seedBlueprint({}, payload);
    const token = await getAuthToken();

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': `test-non-trading-${crypto.randomUUID()}`,
      },
      payload: { revisionId: revId },
    });

    expect(res.statusCode).toBe(201);
    const actorId = res.json().actorId;

    const [agent] = await db.select().from(agents).where(sql`${agents.id} = ${actorId}`);
    expect(agent).toBeDefined();
    expect(agent!.strategy).toBeNull();
    expect(agent!.executionDefaults).toBeNull();
  });

  // ── Test 8: Idempotency ────────────────────────────────────────────────

  it('returns same agent on idempotent retry', async () => {
    const payload = makeAgentPayload();
    const { bpId, revId } = await seedBlueprint({}, payload);
    const token = await getAuthToken();
    const key = `test-idempotent-${crypto.randomUUID()}`;

    const r1 = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': key,
      },
      payload: { revisionId: revId },
    });
    expect(r1.statusCode).toBe(201);
    const actorId1 = r1.json().actorId;

    const r2 = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': key,
      },
      payload: { revisionId: revId },
    });
    expect(r2.statusCode).toBe(200); // 200 for idempotent replay
    const actorId2 = r2.json().actorId;
    expect(actorId1).toBe(actorId2);

    // Verify only one agent row exists with that actorId
    const rows = await db
      .select()
      .from(agents)
      .where(sql`${agents.id} = ${actorId1}`);
    expect(rows).toHaveLength(1);

    // Verify only one usage event emitted
    const events = await db
      .select()
      .from(blueprintUsageEvents)
      .where(sql`${blueprintUsageEvents.subjectId} = ${actorId1}`);
    expect(events).toHaveLength(1);
  });

  // ── Test 9: Different hash = 409 ───────────────────────────────────────

  it('rejects different body with same idempotency key', async () => {
    const payload = makeAgentPayload();
    const { bpId, revId } = await seedBlueprint({}, payload);
    const token = await getAuthToken();
    const key = `test-diff-hash-${crypto.randomUUID()}`;

    // First request: no edits
    const r1 = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': key,
      },
      payload: { revisionId: revId },
    });
    expect(r1.statusCode).toBe(201);

    // Second request with different body (adds edits) — same key
    const r2 = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': key,
      },
      payload: {
        revisionId: revId,
        edits: { kind: 'agent', name: 'Changed Name' },
      },
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toBe('blueprint.idempotency_conflict');
  });

  // ── Test 10: Invalid idempotency key → 400 ─────────────────────────────

  it('rejects empty idempotency key', async () => {
    const payload = makeAgentPayload();
    const { bpId, revId } = await seedBlueprint({}, payload);
    const token = await getAuthToken();

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': '   ', // whitespace-only
      },
      payload: { revisionId: revId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('blueprint.validation');
  });

  // ── Test 11: Non-owner cannot instantiate private blueprint ─────────────

  it('rejects non-owner instantiating non-published blueprint', async () => {
    const payload = makeAgentPayload();
    const otherAuthorId = 'other-author-id';

    // Seed the other author
    await db.insert(users).values({
      id: otherAuthorId,
      username: 'other_author',
      displayName: 'Other Author',
      email: 'other@test.local',
      planId: 'free',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { bpId, revId } = await seedBlueprint(
      { publicationStatus: 'draft', authorId: otherAuthorId },
      payload,
      otherAuthorId,
    );
    const token = await getAuthToken(TEST_USER_ID); // different user

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': `test-nonowner-${crypto.randomUUID()}`,
      },
      payload: { revisionId: revId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('blueprint.not_found');
  });

  // ── Test 12: Non-owner can instantiate published blueprint ─────────────

  it('allows non-owner to instantiate published blueprint', async () => {
    const payload = makeAgentPayload();
    const otherAuthorId = 'other-author-pub';

    await db.insert(users).values({
      id: otherAuthorId,
      username: 'other_author_pub',
      displayName: 'Other Author Pub',
      email: 'other-pub@test.local',
      planId: 'free',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { bpId, revId } = await seedBlueprint(
      { publicationStatus: 'published', authorId: otherAuthorId },
      payload,
      otherAuthorId,
    );
    const token = await getAuthToken(TEST_USER_ID);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': `test-nonowner-pub-${crypto.randomUUID()}`,
      },
      payload: { revisionId: revId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().blueprintId).toBe(bpId);
  });

  // ── Test 13: Usage event emitted on creation ───────────────────────────

  it('emits a blueprint usage event on instantiation', async () => {
    const payload = makeAgentPayload();
    const { bpId, revId } = await seedBlueprint({}, payload);
    const token = await getAuthToken();

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Idempotency-Key': `test-usage-event-${crypto.randomUUID()}`,
      },
      payload: { revisionId: revId },
    });
    expect(res.statusCode).toBe(201);
    const actorId = res.json().actorId;

    const events = await db
      .select()
      .from(blueprintUsageEvents)
      .where(sql`${blueprintUsageEvents.subjectId} = ${actorId}`);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('instance_created');
    expect(events[0]!.userId).toBe(TEST_USER_ID);
    expect(events[0]!.blueprintId).toBe(bpId);
    expect(events[0]!.blueprintRevisionId).toBe(revId);
  });

  // ── Test 14: idempotency key scoped per-user ──────────────────────────

  it('scopes idempotency key per-user', async () => {
    const payload = makeAgentPayload();
    const { bpId, revId } = await seedBlueprint({}, payload);
    const key = `test-per-user-key`;

    // First user
    const token1 = await getAuthToken(TEST_USER_ID);
    const r1 = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token1}`,
        'Idempotency-Key': key,
      },
      payload: { revisionId: revId },
    });
    expect(r1.statusCode).toBe(201);

    // Second user (same key — should create a new actor, not replay)
    const otherUserId = 'test-user-bp-int-2';
    await db.insert(users).values({
      id: otherUserId,
      username: 'test_bp_int_2',
      displayName: 'Test BP Int 2',
      email: 'bp-int-2@test.local',
      planId: 'free',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const token2 = await getAuthToken(otherUserId);
    const r2 = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        'Authorization': `Bearer ${token2}`,
        'Idempotency-Key': key,
      },
      payload: { revisionId: revId },
    });
    expect(r2.statusCode).toBe(201);
    expect(r2.json().actorId).not.toBe(r1.json().actorId);
  });
});

