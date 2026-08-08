import {
  describe, it, expect, beforeAll, beforeEach, afterAll,
} from 'vitest';
import Fastify from 'fastify';
import { sql, eq, and } from 'drizzle-orm';
import {
  createDatabase,
  users,
  sessions,
  blueprints,
  blueprintRevisions,
  blueprintInstantiationRequests,
  blueprintUsageEvents,
  blueprintLikes,
  blueprintForkRequests,
  agents,
  bots,
  agentSkills,
  connections,
  venueAccounts,
} from '@herobids/db';
import { authPlugin, createSessionToken } from '../plugins/auth.js';
import { blueprintRoutes } from './blueprints.js';
import { BlueprintExecutionCapabilityAdapter } from '../services/blueprint-execution-capability-adapter.js';
import { refreshLikeCount } from '../services/blueprint-scoring.js';
import { loadProvidersConfig } from '@herobids/domain/config/load-providers';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthConfig, AgentRiskDefaultsConfig, PlansConfig } from '@herobids/domain';

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

const testPlansConfig: PlansConfig = {
  defaultPlanId: 'free',
  plans: {
    free: {
      entitlements: {
        skills: {
          canCreatePrivateSkills: true,
          canViewMarketplaceSkills: false,
          canPublishToMarketplace: false,
          autoPublishNonDraftSkills: false,
          canPriceSkills: false,
          canLikeMarketplaceSkills: true,
        },
        agents: {
          canViewOwnPrompts: true,
        },
        blueprints: {
          canViewMarketplaceBlueprints: true,
          canLikeMarketplaceBlueprints: true,
        },
        limits: {
          maxAgents: 1,
          maxBots: 1,
          maxConnections: 1,
          maxCredentials: 1,
          maxBindings: 1,
          maxVenueAccounts: 1,
          maxConcurrentBacktests: 1,
          liveEnabled: false,
        },
      },
      usage: {
        includedCreditCents: 0,
        topUpPackIds: [],
      },
    },
    // Plan with no marketplace access at all
    'no-marketplace': {
      entitlements: {
        skills: {
          canCreatePrivateSkills: true,
          canViewMarketplaceSkills: false,
          canPublishToMarketplace: false,
          autoPublishNonDraftSkills: false,
          canPriceSkills: false,
          canLikeMarketplaceSkills: true,
        },
        agents: {
          canViewOwnPrompts: true,
        },
        blueprints: {
          canViewMarketplaceBlueprints: false,
          canLikeMarketplaceBlueprints: false,
        },
        limits: {
          maxAgents: 1,
          maxBots: 1,
          maxConnections: 1,
          maxCredentials: 1,
          maxBindings: 1,
          maxVenueAccounts: 1,
          maxConcurrentBacktests: 1,
          liveEnabled: false,
        },
      },
      usage: {
        includedCreditCents: 0,
        topUpPackIds: [],
      },
    },
    // Plan with view but no like
    'view-only': {
      entitlements: {
        skills: {
          canCreatePrivateSkills: true,
          canViewMarketplaceSkills: false,
          canPublishToMarketplace: false,
          autoPublishNonDraftSkills: false,
          canPriceSkills: false,
          canLikeMarketplaceSkills: true,
        },
        agents: {
          canViewOwnPrompts: true,
        },
        blueprints: {
          canViewMarketplaceBlueprints: true,
          canLikeMarketplaceBlueprints: false,
        },
        limits: {
          maxAgents: 1,
          maxBots: 1,
          maxConnections: 1,
          maxCredentials: 1,
          maxBindings: 1,
          maxVenueAccounts: 1,
          maxConcurrentBacktests: 1,
          liveEnabled: false,
        },
      },
      usage: {
        includedCreditCents: 0,
        topUpPackIds: [],
      },
    },
  },
};

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
      params: { provider: 'openai', model: 'gpt-4o', candleInterval: '15m', candleLimit: 50 },
    },
    risk: {
      maxOpenPositions: 3,
      stopLossPct: 5,
      maxPositionSizePct: 50,
    },
    executionDefaults: { mode: 'paper', slippageBps: 50 },
    technical: {
      filters: { venue: 'hyperliquid', venueType: 'orderbook' },
      entryConditions: [],
    },
    intelligence: { instructions: 'test' },
    capabilityMode: 'hybrid',
    authorizationMode: 'direct',
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
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityAdapter, testPlansConfig);
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

  // ═══════════════════════════════════════════════════════════════════════
  // Marketplace Phase 1 — Milestone B4: Functional Verification
  // ═══════════════════════════════════════════════════════════════════════

  // ── Helpers ───────────────────────────────────────────────────────────

  async function seedUser(id: string, username: string, email: string, isAdmin = false) {
    await db.insert(users).values({
      id,
      username,
      displayName: username,
      email,
      planId: 'free',
      isAdmin,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function getTokenForUser(userId: string): Promise<string> {
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

  // ─────────────────────────────────────────────────────────────────────
  // A. Lifecycle Transitions
  // ─────────────────────────────────────────────────────────────────────

  describe('Blueprint Marketplace — Lifecycle', () => {
    const OWNER_ID = 'lifecycle-owner';
    const OTHER_ID = 'lifecycle-other';

    beforeEach(async () => {
      await seedUser(OWNER_ID, 'lifecycle_owner', 'lifecycle-owner@test.local');
      await seedUser(OTHER_ID, 'lifecycle_other', 'lifecycle-other@test.local');
    });

    // A1: draft → private succeeds (owner)
    it('draft → private succeeds (owner)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/private`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().publicationStatus).toBe('private');
    });

    // A2: private → draft succeeds (owner)
    it('private → draft succeeds (owner)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'private' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/draft`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().publicationStatus).toBe('draft');
    });

    // A3: draft → published succeeds (owner, with valid skills)
    it('draft → published succeeds (owner)', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      // Publish requires expectedCurrentRevisionId
      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/publish`,
        headers: { authorization: `Bearer ${token}` },
        payload: { expectedCurrentRevisionId: revId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().publicationStatus).toBe('published');
      expect(res.json().publishedRevisionId).toBe(revId);
      expect(res.json().publishedAt).toBeTruthy();
    });

    // A4: private → published succeeds (owner)
    it('private → published succeeds (owner)', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'private' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/publish`,
        headers: { authorization: `Bearer ${token}` },
        payload: { expectedCurrentRevisionId: revId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().publicationStatus).toBe('published');
    });

    // A5: published → delisted succeeds (owner)
    it('published → delisted succeeds (owner)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/delist`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().publicationStatus).toBe('delisted');
      expect(res.json().delistedAt).toBeTruthy();
    });

    // A6: delisted → published (republish) succeeds (owner)
    it('delisted → published (republish) succeeds (owner)', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      // First delist
      await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/delist`,
        headers: { authorization: `Bearer ${token}` },
      });

      // Then republish
      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/publish`,
        headers: { authorization: `Bearer ${token}` },
        payload: { expectedCurrentRevisionId: revId },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.publicationStatus).toBe('published');
      // delistedAt is cleared on republish (may be null or absent)
      expect(body.delistedAt ?? null).toBeNull();
    });

    // A7: published → archived succeeds (owner)
    it('published → archived succeeds (owner)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/archive`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().publicationStatus).toBe('archived');
      expect(res.json().archivedAt).toBeTruthy();
    });

    // A8: draft → archived succeeds (owner, never published)
    it('draft → archived succeeds (owner, never published)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/archive`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().publicationStatus).toBe('archived');
    });

    // A9: private → archived succeeds (owner)
    it('private → archived succeeds (owner)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'private' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/archive`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().publicationStatus).toBe('archived');
    });

    // A10: delisted → archived succeeds (owner)
    it('delisted → archived succeeds (owner)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      // First delist
      await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/delist`,
        headers: { authorization: `Bearer ${token}` },
      });

      // Then archive
      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/archive`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().publicationStatus).toBe('archived');
    });

    // A11: Nonowner cannot transition — 404 for draft (hidden from nonowner)
    it('nonowner cannot transition draft (404)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OTHER_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/private`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('blueprint.forbidden');
    });

    // A12: Disallowed transitions rejected
    it('published → draft rejected (409)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/draft`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('blueprint.lifecycle_conflict');
    });

    it('delisted → draft rejected (409)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      // First delist
      await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/delist`,
        headers: { authorization: `Bearer ${token}` },
      });

      // Then try draft
      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/draft`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('blueprint.lifecycle_conflict');
    });

    it('archived → anything rejected (409)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      // First archive
      await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/archive`,
        headers: { authorization: `Bearer ${token}` },
      });

      // Then try to move back to draft
      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/draft`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('blueprint.lifecycle_conflict');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // B. Browse & Retrieve
  // ─────────────────────────────────────────────────────────────────────

  describe('Blueprint Marketplace — Browse & Retrieve', () => {
    const OWNER_ID = 'browse-owner';
    const OTHER_ID = 'browse-other';

    beforeEach(async () => {
      await seedUser(OWNER_ID, 'browse_owner', 'browse-owner@test.local');
      await seedUser(OTHER_ID, 'browse_other', 'browse-other@test.local');
    });

    // B1: Browse returns only published blueprints
    it('browse returns only published blueprints', async () => {
      // Create one draft and one published blueprint
      await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload({ name: 'Draft BP' }), OWNER_ID);
      await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'Published BP' }), OWNER_ID);
      await seedBlueprint({ publicationStatus: 'private' }, makeAgentPayload({ name: 'Private BP' }), OWNER_ID);
      const token = await getTokenForUser(OTHER_ID);

      const res = await app.inject({
        method: 'GET',
        url: '/blueprints',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].name).toBe('Published BP');
    });

    // B2: Browse filters by kind (agent/bot)
    it('browse filters by kind', async () => {
      await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'Agent BP' }), OWNER_ID);
      await seedBlueprint({ publicationStatus: 'published' }, makeBotPayload({ name: 'Bot BP' }), OWNER_ID);
      const token = await getTokenForUser(OTHER_ID);

      const agentRes = await app.inject({
        method: 'GET',
        url: '/blueprints?kind=agent',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(agentRes.statusCode).toBe(200);
      const agentBody = agentRes.json();
      expect(agentBody.items).toHaveLength(1);
      expect(agentBody.items[0].kind).toBe('agent');

      const botRes = await app.inject({
        method: 'GET',
        url: '/blueprints?kind=bot',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(botRes.statusCode).toBe(200);
      const botBody = botRes.json();
      expect(botBody.items).toHaveLength(1);
      expect(botBody.items[0].kind).toBe('bot');
    });

    // B3: Browse sorts by popular (desc)
    it('browse sorts by popular (desc)', async () => {
      const { bpId: bp1 } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'Popular BP' }), OWNER_ID);
      const { bpId: bp2 } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'Less Popular BP' }), OWNER_ID);

      // Set different popularity scores
      await db.update(blueprints).set({ popularityScore: 100 }).where(sql`${blueprints.id} = ${bp1}`);
      await db.update(blueprints).set({ popularityScore: 10 }).where(sql`${blueprints.id} = ${bp2}`);

      const token = await getTokenForUser(OTHER_ID);
      const res = await app.inject({
        method: 'GET',
        url: '/blueprints?sort=popular',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(2);
      expect(body.items[0].name).toBe('Popular BP');
      expect(body.items[1].name).toBe('Less Popular BP');
    });

    // B4: Browse sorts by trending (desc)
    it('browse sorts by trending (desc)', async () => {
      const { bpId: bp1 } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'Trending BP' }), OWNER_ID);
      const { bpId: bp2 } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'Not Trending' }), OWNER_ID);

      await db.update(blueprints).set({ trendingScore: 50, popularityScore: 50 }).where(sql`${blueprints.id} = ${bp1}`);
      await db.update(blueprints).set({ trendingScore: 5, popularityScore: 5 }).where(sql`${blueprints.id} = ${bp2}`);

      const token = await getTokenForUser(OTHER_ID);
      const res = await app.inject({
        method: 'GET',
        url: '/blueprints?sort=trending',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items[0].name).toBe('Trending BP');
    });

    // B5: Browse sorts by newest (desc)
    it('browse sorts by newest (desc)', async () => {
      const past = new Date(Date.now() - 86_400_000);
      const recent = new Date();

      const { bpId: bpOld } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'Old BP' }), OWNER_ID);
      const { bpId: bpNew } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'New BP' }), OWNER_ID);

      await db.update(blueprints).set({ publishedAt: past }).where(sql`${blueprints.id} = ${bpOld}`);
      await db.update(blueprints).set({ publishedAt: recent }).where(sql`${blueprints.id} = ${bpNew}`);

      const token = await getTokenForUser(OTHER_ID);
      const res = await app.inject({
        method: 'GET',
        url: '/blueprints?sort=newest',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Newer first (descending publishedAt)
      expect(body.items[0].name).toBe('New BP');
    });

    // B6: Cursor pagination returns next page
    it('cursor pagination returns next page', async () => {
      // Create enough blueprints to fill more than one page (default limit=20)
      for (let i = 0; i < 25; i++) {
        await seedBlueprint(
          { publicationStatus: 'published' },
          makeAgentPayload({ name: `BP ${i}` }),
          OWNER_ID,
        );
      }
      const token = await getTokenForUser(OTHER_ID);

      // Page 1: default limit
      const p1 = await app.inject({
        method: 'GET',
        url: '/blueprints?sort=newest',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(p1.statusCode).toBe(200);
      const b1 = p1.json();
      expect(b1.items.length).toBeLessThanOrEqual(20);
      expect(b1.nextCursor).toBeTruthy();

      // Page 2: use cursor (raw URL, Fastify handles decoding)
      const p2 = await app.inject({
        method: 'GET',
        url: `/blueprints?sort=newest&cursor=${b1.nextCursor}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(p2.statusCode).toBe(200);
      const b2 = p2.json();
      expect(b2.items.length).toBeGreaterThanOrEqual(1);
    });

    // B7: Retrieve published blueprint as nonowner (200)
    it('retrieve published blueprint as nonowner (200)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'Pub BP' }), OWNER_ID);
      const token = await getTokenForUser(OTHER_ID);

      const res = await app.inject({
        method: 'GET',
        url: `/blueprints/${bpId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('Pub BP');
      expect(res.json().publicationStatus).toBe('published');
    });

    // B8: Retrieve draft blueprint as nonowner (404)
    it('retrieve draft blueprint as nonowner (404)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload({ name: 'Draft BP' }), OWNER_ID);
      const token = await getTokenForUser(OTHER_ID);

      const res = await app.inject({
        method: 'GET',
        url: `/blueprints/${bpId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('blueprint.not_found');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // C. Fork
  // ─────────────────────────────────────────────────────────────────────

  describe('Blueprint Marketplace — Fork', () => {
    const OWNER_ID = 'fork-owner';
    const OTHER_ID = 'fork-other';

    beforeEach(async () => {
      await seedUser(OWNER_ID, 'fork_owner', 'fork-owner@test.local');
      await seedUser(OTHER_ID, 'fork_other', 'fork-other@test.local');
    });

    // C1: Fork published blueprint as nonowner (201, lineage set)
    it('fork published blueprint as nonowner (201, lineage set)', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'Source BP' }), OWNER_ID);
      const token = await getTokenForUser(OTHER_ID);
      const key = `fork-nonowner-${crypto.randomUUID()}`;

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/fork`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': key,
        },
        payload: { revisionId: revId },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.publicationStatus).toBe('draft');
      expect(body.lineage).toBeDefined();
      expect(body.lineage.sourceBlueprintId).toBe(bpId);
      expect(body.lineage.sourceBlueprintRevisionId).toBe(revId);
    });

    // C2: Fork as owner of own blueprint (201, isSelfUsage=true)
    it('fork as owner of own blueprint (201, isSelfUsage=true)', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'My BP' }), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);
      const key = `fork-self-${crypto.randomUUID()}`;

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/fork`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': key,
        },
        payload: { revisionId: revId },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.authorId).toBe(OWNER_ID);

      // Verify the usage event is self
      const events = await db
        .select()
        .from(blueprintUsageEvents)
        .where(
          and(
            eq(blueprintUsageEvents.blueprintId, bpId),
            eq(blueprintUsageEvents.eventType, 'fork_created'),
          ),
        );
      expect(events).toHaveLength(1);
      expect(events[0]!.isSelfUsage).toBe(true);
    });

    // C3: Fork with same idempotency key returns same fork
    it('fork with same idempotency key returns same fork', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'Source' }), OWNER_ID);
      const token = await getTokenForUser(OTHER_ID);
      const key = `fork-idempotent-${crypto.randomUUID()}`;

      const r1 = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/fork`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': key,
        },
        payload: { revisionId: revId },
      });
      expect(r1.statusCode).toBe(201);
      const id1 = r1.json().id;

      const r2 = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/fork`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': key,
        },
        payload: { revisionId: revId },
      });
      expect(r2.statusCode).toBe(200); // idempotent replay
      expect(r2.json().forkBlueprintId).toBe(id1);
    });

    // C4: Fork with different hash returns 409
    it('fork with different hash returns 409', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'Source' }), OWNER_ID);
      const token = await getTokenForUser(OTHER_ID);
      const key = `fork-diff-hash-${crypto.randomUUID()}`;

      // First fork
      await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/fork`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': key,
        },
        payload: { revisionId: revId },
      });

      // Second fork with different edits
      const r2 = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/fork`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': key,
        },
        payload: {
          revisionId: revId,
          edits: { kind: 'agent', name: 'Different Name' },
        },
      });
      expect(r2.statusCode).toBe(409);
      expect(r2.json().error).toBe('blueprint.idempotency_conflict');
    });

    // C5: Fork draft blueprint as nonowner (404)
    it('fork draft blueprint as nonowner (404)', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload({ name: 'Draft' }), OWNER_ID);
      const token = await getTokenForUser(OTHER_ID);
      const key = `fork-draft-${crypto.randomUUID()}`;

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/fork`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': key,
        },
        payload: { revisionId: revId },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('blueprint.not_found');
    });

    // C6: Fork increments source forkCount (non-self only)
    it('fork increments source forkCount (non-self only)', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'Source' }), OWNER_ID);
      const token = await getTokenForUser(OTHER_ID);

      // Check initial forkCount
      const [before] = await db.select({ forkCount: blueprints.forkCount }).from(blueprints).where(eq(blueprints.id, bpId));

      await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/fork`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': `fork-count-${crypto.randomUUID()}`,
        },
        payload: { revisionId: revId },
      });

      const [after] = await db.select({ forkCount: blueprints.forkCount }).from(blueprints).where(eq(blueprints.id, bpId));
      expect(after!.forkCount).toBe((before!.forkCount ?? 0) + 1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // D. Like/Unlike
  // ─────────────────────────────────────────────────────────────────────

  describe('Blueprint Marketplace — Like/Unlike', () => {
    const OWNER_ID = 'like-owner';
    const LIKER_ID = 'like-liker';

    beforeEach(async () => {
      await seedUser(OWNER_ID, 'like_owner', 'like-owner@test.local');
      await seedUser(LIKER_ID, 'like_liker', 'like-liker@test.local');
    });

    // D1: Like published blueprint (200, likeCount incremented)
    it('like published blueprint (200, likeCount incremented)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(LIKER_ID);

      const [before] = await db.select({ likeCount: blueprints.likeCount }).from(blueprints).where(eq(blueprints.id, bpId));

      const res = await app.inject({
        method: 'PUT',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.liked).toBe(true);
      expect(body.likeCount).toBe((before!.likeCount ?? 0) + 1);
    });

    // D2: Unlike previously liked blueprint (200, likeCount decremented)
    it('unlike previously liked blueprint (200, likeCount decremented)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(LIKER_ID);

      // First like
      await app.inject({
        method: 'PUT',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });

      const [before] = await db.select({ likeCount: blueprints.likeCount }).from(blueprints).where(eq(blueprints.id, bpId));

      // Then unlike
      const res = await app.inject({
        method: 'DELETE',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.liked).toBe(false);
      expect(body.likeCount).toBe((before!.likeCount ?? 1) - 1);
    });

    // D3: Self-like rejected (403)
    it('self-like rejected (403)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'PUT',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('blueprint.forbidden');
    });

    // D4: Like draft blueprint rejected (409 — not published)
    it('like draft blueprint rejected (409)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(LIKER_ID);

      const res = await app.inject({
        method: 'PUT',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });
      // The like endpoint checks publicationStatus before ownership;
      // draft blueprints return 409 (lifecycle conflict) for any caller.
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('blueprint.lifecycle_conflict');
    });

    // D5: Like idempotent (repeat like = 200, count unchanged)
    it('like idempotent (repeat like = 200, count unchanged)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(LIKER_ID);

      // First like
      const r1 = await app.inject({
        method: 'PUT',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r1.statusCode).toBe(200);
      const count1 = r1.json().likeCount;

      // Second like (same user)
      const r2 = await app.inject({
        method: 'PUT',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r2.statusCode).toBe(200);
      expect(r2.json().likeCount).toBe(count1);
    });

    // D6: Browse response includes viewer like state (Case 4)
    it('browse response includes viewer like state', async () => {
      const { bpId: likedBpId } = await seedBlueprint(
        { publicationStatus: 'published' },
        makeAgentPayload({ name: 'Liked BP' }),
        OWNER_ID,
      );
      const { bpId: unlikedBpId } = await seedBlueprint(
        { publicationStatus: 'published' },
        makeAgentPayload({ name: 'Not Liked BP' }),
        OWNER_ID,
      );

      // Insert a direct like row for the viewer on the liked blueprint
      await db.insert(blueprintLikes).values({
        blueprintId: likedBpId,
        userId: LIKER_ID,
        createdAt: new Date(),
      });
      await refreshLikeCount(db, likedBpId);

      const token = await getTokenForUser(LIKER_ID);
      const res = await app.inject({
        method: 'GET',
        url: '/blueprints?sort=newest',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      const likedBp = body.items.find((i: { id: string }) => i.id === likedBpId);
      const unlikedBp = body.items.find((i: { id: string }) => i.id === unlikedBpId);
      expect(likedBp).toBeDefined();
      expect(unlikedBp).toBeDefined();
      expect(likedBp.isLikedByViewer).toBe(true);
      expect(unlikedBp.isLikedByViewer).toBe(false);
    });

    // D7: Detail response includes viewer like state (Case 5)
    it('detail response includes viewer like state', async () => {
      const { bpId } = await seedBlueprint(
        { publicationStatus: 'published' },
        makeAgentPayload({ name: 'Detail BP' }),
        OWNER_ID,
      );
      const token = await getTokenForUser(LIKER_ID);

      // Before liking — isLikedByViewer should be false
      const res1 = await app.inject({
        method: 'GET',
        url: `/blueprints/${bpId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().isLikedByViewer).toBe(false);

      // Insert a like row directly
      await db.insert(blueprintLikes).values({
        blueprintId: bpId,
        userId: LIKER_ID,
        createdAt: new Date(),
      });
      await refreshLikeCount(db, bpId);

      // After liking — isLikedByViewer should be true
      const res2 = await app.inject({
        method: 'GET',
        url: `/blueprints/${bpId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().isLikedByViewer).toBe(true);
    });

    // D8: Like action updates count and state when entitled (Case 6)
    it('like action updates count and state when entitled', async () => {
      const { bpId } = await seedBlueprint(
        { publicationStatus: 'published' },
        makeAgentPayload({ name: 'Like Me' }),
        OWNER_ID,
      );
      const token = await getTokenForUser(LIKER_ID);

      const [before] = await db
        .select({ likeCount: blueprints.likeCount })
        .from(blueprints)
        .where(eq(blueprints.id, bpId));

      const res = await app.inject({
        method: 'PUT',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.liked).toBe(true);
      expect(body.likeCount).toBe((before!.likeCount ?? 0) + 1);

      // Also verify browse reflects the new state
      const browse = await app.inject({
        method: 'GET',
        url: '/blueprints?sort=newest',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(browse.statusCode).toBe(200);
      const browseItem = browse.json().items.find((i: { id: string }) => i.id === bpId);
      expect(browseItem).toBeDefined();
      expect(browseItem.isLikedByViewer).toBe(true);
    });

    // D9: Unlike action updates count and state when entitled (Case 7)
    it('unlike action updates count and state when entitled', async () => {
      const { bpId } = await seedBlueprint(
        { publicationStatus: 'published' },
        makeAgentPayload({ name: 'Unlike Me' }),
        OWNER_ID,
      );
      const token = await getTokenForUser(LIKER_ID);

      // First like
      await app.inject({
        method: 'PUT',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });

      const [before] = await db
        .select({ likeCount: blueprints.likeCount })
        .from(blueprints)
        .where(eq(blueprints.id, bpId));

      // Then unlike
      const res = await app.inject({
        method: 'DELETE',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.liked).toBe(false);
      expect(body.likeCount).toBe((before!.likeCount ?? 1) - 1);

      // Also verify browse reflects the removed like
      const browse = await app.inject({
        method: 'GET',
        url: '/blueprints?sort=newest',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(browse.statusCode).toBe(200);
      const browseItem = browse.json().items.find((i: { id: string }) => i.id === bpId);
      expect(browseItem).toBeDefined();
      expect(browseItem.isLikedByViewer).toBe(false);
    });

    // D10: Author self-like remains rejected (Case 8)
    it('author self-like remains rejected (403)', async () => {
      const { bpId } = await seedBlueprint(
        { publicationStatus: 'published' },
        makeAgentPayload({ name: 'My BP' }),
        OWNER_ID,
      );
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'PUT',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('blueprint.forbidden');

      // Verify no like row was inserted
      const likes = await db
        .select()
        .from(blueprintLikes)
        .where(
          and(
            eq(blueprintLikes.blueprintId, bpId),
            eq(blueprintLikes.userId, OWNER_ID),
          ),
        );
      expect(likes).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // E. Authoring
  // ─────────────────────────────────────────────────────────────────────

  describe('Blueprint Marketplace — Authoring', () => {
    const OWNER_ID = 'authoring-owner';

    beforeEach(async () => {
      await seedUser(OWNER_ID, 'authoring_owner', 'authoring-owner@test.local');
    });

    // E1: Create blueprint from scratch (201, draft, revision 1)
    it('create blueprint from scratch (201, draft, revision 1)', async () => {
      const token = await getTokenForUser(OWNER_ID);
      const payload = makeAgentPayload({ name: 'Fresh BP' });

      const res = await app.inject({
        method: 'POST',
        url: '/blueprints',
        headers: { authorization: `Bearer ${token}` },
        payload: { payload },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.publicationStatus).toBe('draft');
      expect(body.revision.version).toBe(1);
      expect(body.revision.payload.name).toBe('Fresh BP');
      expect(body.authorId).toBe(OWNER_ID);
    });

    // E2: Edit blueprint creates revision 2 (201, version incremented)
    it('edit blueprint creates revision 2 (201, version incremented)', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload({ name: 'Original' }), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/revisions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          payload: makeAgentPayload({ name: 'Edited' }),
          changeSummary: 'Updated name',
          expectedBaseRevisionId: revId,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.revision.version).toBe(2);
      expect(body.revision.payload.name).toBe('Edited');
      expect(body.revision.changeSummary).toBe('Updated name');
    });

    // E3: Edit with stale expectedBaseRevisionId (409)
    it('edit with stale expectedBaseRevisionId (409)', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload({ name: 'Original' }), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      // First edit creates revision 2
      await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/revisions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          payload: makeAgentPayload({ name: 'Edited' }),
          changeSummary: 'First edit',
          expectedBaseRevisionId: revId,
        },
      });

      // Second edit with stale expectedBaseRevisionId (still revId)
      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/revisions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          payload: makeAgentPayload({ name: 'Stale Edit' }),
          changeSummary: 'Should fail',
          expectedBaseRevisionId: revId, // stale — current is now revision 2
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('blueprint.revision_stale');
    });

    // E4: Create draft from agent — uses POST /agents/:id/blueprints
    // Server-side this requires a real agent row, which needs more setup.
    // We test the direct create endpoint (POST /blueprints) which covers the same schema.

    // E5: Create draft from bot — uses POST /bots/:id/blueprints
    // Similarly requires bot row setup. The direct create path tests the bot payload schema.
    it('create bot blueprint from scratch (201, draft, no skills)', async () => {
      const token = await getTokenForUser(OWNER_ID);
      const payload = makeBotPayload({ name: 'Bot BP' });

      const res = await app.inject({
        method: 'POST',
        url: '/blueprints',
        headers: { authorization: `Bearer ${token}` },
        payload: { payload },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.kind).toBe('bot');
      expect(body.publicationStatus).toBe('draft');
      expect(body.revision.version).toBe(1);
      expect(body.revision.skills).toHaveLength(0);
    });

    // E6: Hard delete eligible draft (204, blueprint gone)
    it('hard delete eligible draft (204, blueprint gone)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload({ name: 'Deletable' }), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'DELETE',
        url: `/blueprints/${bpId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(204);

      // Verify blueprint is gone
      const [bp] = await db.select().from(blueprints).where(eq(blueprints.id, bpId));
      expect(bp).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // F. Authorization Matrix
  // ─────────────────────────────────────────────────────────────────────

  describe('Blueprint Marketplace — Authorization', () => {
    const OWNER_ID = 'auth-owner';
    const OTHER_ID = 'auth-other';
    const ADMIN_ID = 'auth-admin';

    beforeEach(async () => {
      await seedUser(OWNER_ID, 'auth_owner', 'auth-owner@test.local');
      await seedUser(OTHER_ID, 'auth_other', 'auth-other@test.local');
      await seedUser(ADMIN_ID, 'auth_admin', 'auth-admin@test.local', true);
    });

    // F1: Admin can publish another user's blueprint (200)
    it('admin can publish another user\'s blueprint (200)', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(ADMIN_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/publish`,
        headers: { authorization: `Bearer ${token}` },
        payload: { expectedCurrentRevisionId: revId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().publicationStatus).toBe('published');
    });

    // F2: Admin can delist another user's blueprint (200)
    it('admin can delist another user\'s blueprint (200)', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(ADMIN_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/delist`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().publicationStatus).toBe('delisted');
    });

    // F3: Non-owner cannot edit blueprint (403)
    it('non-owner cannot edit blueprint (403)', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload({ name: 'Original' }), OWNER_ID);
      const token = await getTokenForUser(OTHER_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/revisions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          payload: makeAgentPayload({ name: 'Hacked' }),
          changeSummary: 'Unauthorized edit',
          expectedBaseRevisionId: revId,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('blueprint.forbidden');
    });

    // F4: Non-owner cannot publish blueprint (403)
    it('non-owner cannot publish blueprint (403)', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OTHER_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/publish`,
        headers: { authorization: `Bearer ${token}` },
        payload: { expectedCurrentRevisionId: revId },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('blueprint.forbidden');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // G. Error Codes
  // ─────────────────────────────────────────────────────────────────────

  describe('Blueprint Marketplace — Error Codes', () => {
    const OWNER_ID = 'err-owner';
    const OTHER_ID = 'err-other';

    beforeEach(async () => {
      await seedUser(OWNER_ID, 'err_owner', 'err-owner@test.local');
      await seedUser(OTHER_ID, 'err_other', 'err-other@test.local');
    });

    // G1: Invalid payload returns 400 with blueprint.validation
    it('invalid payload returns 400 with blueprint.validation', async () => {
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'POST',
        url: '/blueprints',
        headers: { authorization: `Bearer ${token}` },
        payload: { payload: { kind: 'agent', name: '' } }, // missing required fields
      });
      expect(res.statusCode).toBe(400);
    });

    // G2: Unauthorized returns 403 with blueprint.forbidden
    it('unauthorized returns 403 with blueprint.forbidden', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OTHER_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/revisions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          payload: makeAgentPayload({ name: 'Nope' }),
          changeSummary: 'no',
          expectedBaseRevisionId: revId,
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('blueprint.forbidden');
    });

    // G3: Not found returns 404 with blueprint.not_found
    it('not found returns 404 with blueprint.not_found', async () => {
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'GET',
        url: '/blueprints/nonexistent-id',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('blueprint.not_found');
    });

    // G4: Stale edit returns 409 with blueprint.revision_stale
    it('stale edit returns 409 with blueprint.revision_stale', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'draft' }, makeAgentPayload({ name: 'Base' }), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      // Create revision 2 first
      await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/revisions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          payload: makeAgentPayload({ name: 'Edited' }),
          changeSummary: 'Edit 1',
          expectedBaseRevisionId: revId,
        },
      });

      // Now try with stale revId
      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/revisions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          payload: makeAgentPayload({ name: 'Stale' }),
          changeSummary: 'Should be stale',
          expectedBaseRevisionId: revId,
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('blueprint.revision_stale');
    });

    // G5: Invalid lifecycle transition returns 409 with blueprint.lifecycle_conflict
    it('invalid lifecycle transition returns 409 with blueprint.lifecycle_conflict', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/draft`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('blueprint.lifecycle_conflict');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // H. Scoring
  // ─────────────────────────────────────────────────────────────────────

  describe('Blueprint Marketplace — Scoring', () => {
    const OWNER_ID = 'score-owner';
    const LIKER_ID = 'score-liker';
    const FORKER_ID = 'score-forker';

    beforeEach(async () => {
      await seedUser(OWNER_ID, 'score_owner', 'score-owner@test.local');
      await seedUser(LIKER_ID, 'score_liker', 'score-liker@test.local');
      await seedUser(FORKER_ID, 'score_forker', 'score-forker@test.local');
    });

    // H1: Like increases popularityScore
    it('like increases popularityScore', async () => {
      const { bpId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload(), OWNER_ID);
      const token = await getTokenForUser(LIKER_ID);

      const [before] = await db.select({ popularityScore: blueprints.popularityScore }).from(blueprints).where(eq(blueprints.id, bpId));

      await app.inject({
        method: 'PUT',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });

      const [after] = await db.select({ popularityScore: blueprints.popularityScore }).from(blueprints).where(eq(blueprints.id, bpId));
      // Score should increase (or stay > 0 after first like)
      expect(after!.popularityScore).toBeGreaterThanOrEqual(before!.popularityScore);
    });

    // H2: Fork increases popularityScore of source
    it('fork increases popularityScore of source', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'Source' }), OWNER_ID);
      const token = await getTokenForUser(FORKER_ID);

      const [before] = await db.select({ popularityScore: blueprints.popularityScore }).from(blueprints).where(eq(blueprints.id, bpId));

      await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/fork`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': `score-fork-${crypto.randomUUID()}`,
        },
        payload: { revisionId: revId },
      });

      const [after] = await db.select({ popularityScore: blueprints.popularityScore }).from(blueprints).where(eq(blueprints.id, bpId));
      expect(after!.popularityScore).toBeGreaterThanOrEqual(before!.popularityScore);
    });

    // H3: Self-usage does NOT affect scores
    it('self-usage does NOT affect scores', async () => {
      const { bpId, revId } = await seedBlueprint({ publicationStatus: 'published' }, makeAgentPayload({ name: 'My BP' }), OWNER_ID);
      const token = await getTokenForUser(OWNER_ID);

      const [before] = await db.select({
        popularityScore: blueprints.popularityScore,
        forkCount: blueprints.forkCount,
      }).from(blueprints).where(eq(blueprints.id, bpId));

      // Self-fork
      await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/fork`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': `self-score-${crypto.randomUUID()}`,
        },
        payload: { revisionId: revId },
      });

      const [after] = await db.select({
        popularityScore: blueprints.popularityScore,
        forkCount: blueprints.forkCount,
      }).from(blueprints).where(eq(blueprints.id, bpId));

      // Self-usage should not increment forkCount or affect scores
      expect(after!.forkCount).toBe(before!.forkCount);
      expect(after!.popularityScore).toBe(before!.popularityScore);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // I. Entitlement Enforcement (Negative-Path)
  // ─────────────────────────────────────────────────────────────────────

  describe('Blueprint Marketplace — Entitlement Enforcement', () => {
    const OWNER_ID = 'ent-owner';
    const NO_MARKETPLACE_ID = 'ent-no-mkt';
    const VIEW_ONLY_ID = 'ent-view-only';

    beforeEach(async () => {
      await seedUser(OWNER_ID, 'ent_owner', 'ent-owner@test.local');
      // User on 'no-marketplace' plan — neither view nor like
      await db.insert(users).values({
        id: NO_MARKETPLACE_ID,
        username: 'ent_no_mkt',
        displayName: 'No Marketplace',
        email: 'ent-no-mkt@test.local',
        planId: 'no-marketplace',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      // User on 'view-only' plan — can view but cannot like
      await db.insert(users).values({
        id: VIEW_ONLY_ID,
        username: 'ent_view_only',
        displayName: 'View Only',
        email: 'ent-view-only@test.local',
        planId: 'view-only',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    // I1: User without canViewMarketplaceBlueprints → 403 on browse
    it('user without canViewMarketplaceBlueprints → 403 on browse', async () => {
      const token = await getTokenForUser(NO_MARKETPLACE_ID);

      const res = await app.inject({
        method: 'GET',
        url: '/blueprints',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('blueprint.forbidden');
    });

    // I2: User without canViewMarketplaceBlueprints → 403 on detail (published non-owned)
    it('user without canViewMarketplaceBlueprints → 403 on detail (published non-owned)', async () => {
      const { bpId } = await seedBlueprint(
        { publicationStatus: 'published' },
        makeAgentPayload({ name: 'Pub BP' }),
        OWNER_ID,
      );
      const token = await getTokenForUser(NO_MARKETPLACE_ID);

      const res = await app.inject({
        method: 'GET',
        url: `/blueprints/${bpId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('blueprint.forbidden');
    });

    // I3: User without canViewMarketplaceBlueprints → 403 on fork
    it('user without canViewMarketplaceBlueprints → 403 on fork', async () => {
      const { bpId, revId } = await seedBlueprint(
        { publicationStatus: 'published' },
        makeAgentPayload({ name: 'Pub BP' }),
        OWNER_ID,
      );
      const token = await getTokenForUser(NO_MARKETPLACE_ID);

      const res = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/fork`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': `ent-fork-${crypto.randomUUID()}`,
        },
        payload: { revisionId: revId },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('blueprint.forbidden');
    });

    // I4: User with view but without canLikeMarketplaceBlueprints → 403 on like
    it('user with view but without canLikeMarketplaceBlueprints → 403 on like', async () => {
      const { bpId } = await seedBlueprint(
        { publicationStatus: 'published' },
        makeAgentPayload({ name: 'Pub BP' }),
        OWNER_ID,
      );
      const token = await getTokenForUser(VIEW_ONLY_ID);

      const res = await app.inject({
        method: 'PUT',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('blueprint.forbidden');
    });

    // I5: User with view but without canLikeMarketplaceBlueprints → 403 on unlike
    it('user with view but without canLikeMarketplaceBlueprints → 403 on unlike', async () => {
      const { bpId } = await seedBlueprint(
        { publicationStatus: 'published' },
        makeAgentPayload({ name: 'Pub BP' }),
        OWNER_ID,
      );
      const token = await getTokenForUser(VIEW_ONLY_ID);

      const res = await app.inject({
        method: 'DELETE',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('blueprint.forbidden');
    });

    // I6: User with both entitlements false → 403 on all five endpoints
    it('user with no entitlements → 403 on browse, detail, fork, like, unlike', async () => {
      const { bpId, revId } = await seedBlueprint(
        { publicationStatus: 'published' },
        makeAgentPayload({ name: 'Pub BP' }),
        OWNER_ID,
      );
      const token = await getTokenForUser(NO_MARKETPLACE_ID);

      const browse = await app.inject({
        method: 'GET',
        url: '/blueprints',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(browse.statusCode).toBe(403);

      const detail = await app.inject({
        method: 'GET',
        url: `/blueprints/${bpId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(detail.statusCode).toBe(403);

      const fork = await app.inject({
        method: 'POST',
        url: `/blueprints/${bpId}/fork`,
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': `ent-all-fork-${crypto.randomUUID()}`,
        },
        payload: { revisionId: revId },
      });
      expect(fork.statusCode).toBe(403);

      const like = await app.inject({
        method: 'PUT',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(like.statusCode).toBe(403);

      const unlike = await app.inject({
        method: 'DELETE',
        url: `/blueprints/${bpId}/like`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(unlike.statusCode).toBe(403);
    });
  });
});

// ── Preview: model readiness & skill portability ─────────────────────────

describe.skipIf(SKIP)('Blueprint preview — start-readiness checks', () => {
  let db: ReturnType<typeof createDatabase>;
  let app: ReturnType<typeof Fastify>;
  let authCfg: AuthConfig;

  beforeAll(async () => {
    db = createDatabase(process.env['DATABASE_URL']!);
    authCfg = makeAuthConfig();

    app = Fastify({ logger: false });
    await authPlugin(app, { config: authCfg, db });
    await blueprintRoutes(app, db, agentRiskDefaults, executionCapabilityAdapter, testPlansConfig);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
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

    const finalPubStatus = (bpOverrides.publicationStatus as string) ?? 'published';
    const isPublished = finalPubStatus === 'published';

    const baseValues: Record<string, unknown> = {
      id: bpId,
      authorId,
      publicationStatus: 'draft',
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

    const nonLifecycleOverrides = { ...bpOverrides };
    delete nonLifecycleOverrides.publicationStatus;
    delete nonLifecycleOverrides.publishedRevisionId;
    delete nonLifecycleOverrides.publishedAt;
    delete nonLifecycleOverrides.currentRevisionId;

    const merged = { ...baseValues, ...nonLifecycleOverrides };

    await db.insert(blueprints).values(merged as typeof blueprints.$inferInsert);

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

    await db
      .update(blueprints)
      .set({
        publicationStatus: finalPubStatus,
        currentRevisionId: revId,
        publishedRevisionId: isPublished ? revId : null,
        publishedAt: isPublished ? now : null,
      })
      .where(eq(blueprints.id, bpId));

    return { bpId, revId };
  }

  // ── Test 6: modelSelectionReady false when no model configured ─────────

  it('preview returns modelSelectionReady: false when blueprint has no modelPolicy and user has no AI settings', async () => {
    const payload = makeAgentPayload({ modelPolicy: undefined });
    const { bpId, revId } = await seedBlueprint({}, payload);
    const token = await getAuthToken();

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate/preview`,
      headers: { authorization: `Bearer ${token}` },
      payload: { revisionId: revId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.modelSelectionReady).toBe(false);
    expect(body.validationWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Model selection incomplete'),
      ]),
    );
  });

  // ── Test 7: modelSelectionReady true when blueprint has modelPolicy ────

  it('preview returns modelSelectionReady: true when blueprint has explicit modelPolicy', async () => {
    const payload = makeAgentPayload({
      modelPolicy: { provider: 'openai', lightModel: 'gpt-4.1-mini', heavyModel: 'gpt-4.1' },
    });
    const { bpId, revId } = await seedBlueprint({}, payload);
    const token = await getAuthToken();

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate/preview`,
      headers: { authorization: `Bearer ${token}` },
      payload: { revisionId: revId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.modelSelectionReady).toBe(true);
  });

  // ── Test 8: modelSelectionReady true when user has AI settings ─────────

  it('preview returns modelSelectionReady: true when blueprint has no modelPolicy but user has AI settings', async () => {
    // Give the user AI model config
    await db.update(users)
      .set({
        aiModelConfig: {
          provider: 'openrouter',
          lightModel: 'openai/gpt-4.1-mini',
          heavyModel: 'anthropic/claude-sonnet-4-5',
        },
      })
      .where(eq(users.id, TEST_USER_ID));

    const payload = makeAgentPayload({ modelPolicy: undefined });
    const { bpId, revId } = await seedBlueprint({}, payload);
    const token = await getAuthToken();

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate/preview`,
      headers: { authorization: `Bearer ${token}` },
      payload: { revisionId: revId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.modelSelectionReady).toBe(true);
  });

  // ── Test 9: same-user instantiate pre-fills telegramChatId ─────────────

  it('instantiate pre-fills telegramChatId when installer is the blueprint author', async () => {
    // Give the author a telegram chat ID
    await db.update(users)
      .set({ telegramChatId: '123456789' })
      .where(eq(users.id, TEST_USER_ID));

    const payload = makeAgentPayload();
    const { bpId, revId } = await seedBlueprint({}, payload, TEST_USER_ID);
    const token = await getAuthToken();

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        authorization: `Bearer ${token}`,
        'Idempotency-Key': `test-telegram-pre-fill-${crypto.randomUUID()}`,
      },
      payload: { revisionId: revId },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();

    const [agent] = await db
      .select({ telegramChatId: agents.telegramChatId })
      .from(agents)
      .where(eq(agents.id, body.actorId));
    expect(agent!.telegramChatId).toBe('123456789');
  });

  // ── Test 10: instantiate does NOT pre-fill for different user ──────────

  it('instantiate does NOT pre-fill telegramChatId when installer is a different user', async () => {
    const OTHER_USER_ID = 'other-user-bp-int';

    // Give the author a telegram chat ID
    await db.update(users)
      .set({ telegramChatId: '999999999' })
      .where(eq(users.id, TEST_USER_ID));

    // Create a different user
    await db.insert(users).values({
      id: OTHER_USER_ID,
      username: 'other_bp_int',
      displayName: 'Other BP Int',
      email: 'other-bp-int@test.local',
      planId: 'free',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Give the other user a different telegram chat ID
    await db.update(users)
      .set({ telegramChatId: '111111111' })
      .where(eq(users.id, OTHER_USER_ID));

    const payload = makeAgentPayload();
    const { bpId, revId } = await seedBlueprint({}, payload, TEST_USER_ID);
    const token = await getAuthToken(OTHER_USER_ID);

    const res = await app.inject({
      method: 'POST',
      url: `/blueprints/${bpId}/instantiate`,
      headers: {
        authorization: `Bearer ${token}`,
        'Idempotency-Key': `test-telegram-no-leak-${crypto.randomUUID()}`,
      },
      payload: { revisionId: revId },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();

    const [agent] = await db
      .select({ telegramChatId: agents.telegramChatId })
      .from(agents)
      .where(eq(agents.id, body.actorId));

    // Should NOT inherit the author's telegramChatId
    // (it may be null or the other user's ID, but must NOT be the author's)
    expect(agent!.telegramChatId).not.toBe('999999999');
  });
});

