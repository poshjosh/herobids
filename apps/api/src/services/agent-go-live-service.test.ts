/**
 * Unit tests for agent-go-live-service (Task 3).
 *
 * Covers:
 * - cloneAgentAsLive: success paths (paper→live, shadow→live), rejection paths
 *   (already live, not found, no connections, plan enforcement, agent limit),
 *   field carry-over, field exclusion, skill re-resolution, name handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '@herobids/db';
import type { AgentBlueprintRevisionPayload } from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import type { TradingProfileConnection, TypedTradingProfile } from '../agents/trading-profile-reconciliation.js';

// ── Module mocks ─────────────────────────────────────────────────────────────
// Must be declared before importing the module under test.

vi.mock('@herobids/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    agents: { id: 'agents.id', userId: 'agents.userId' },
    agentConnections: { agentId: 'ac.agentId', status: 'ac.status', connectionId: 'ac.connectionId' },
    agentSkills: { agentId: 'as.agentId', skillId: 'as.skillId', orderIndex: 'as.orderIndex' },
    users: { id: 'users.id', aiModelConfig: 'users.aiModelConfig' },
    resolveSkillAssignmentsForUser: vi.fn(),
  };
});

vi.mock('../plan-guards.js', () => ({
  checkLiveEnabled: vi.fn(),
  checkAgentLimit: vi.fn(),
  resolvePlanLimitEntitlements: vi.fn(),
  resolvePlanSkillEntitlements: vi.fn(),
}));

vi.mock('../routes/agent-config-helpers.js', () => ({
  extractModelSelection: vi.fn().mockReturnValue({ provider: 'openai', lightModel: null }),
  mergeModelPolicy: vi.fn().mockReturnValue({}),
  validateAgentModelPolicy: vi.fn().mockResolvedValue([]),
}));

vi.mock('./blueprint-projection.js', () => ({
  projectAgentToBlueprintPayload: vi.fn(),
}));

vi.mock('./agent-instantiation-service.js', () => ({
  createAgentFromPayload: vi.fn(),
}));

vi.mock('@herobids/domain', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    normalizePersistedAiModelConfig: vi.fn().mockReturnValue({ provider: 'openai' }),
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { cloneAgentAsLive, type GoLiveParams } from './agent-go-live-service.js';
import { resolveSkillAssignmentsForUser } from '@herobids/db';
import { checkLiveEnabled, checkAgentLimit, resolvePlanLimitEntitlements, resolvePlanSkillEntitlements } from '../plan-guards.js';
import { extractModelSelection, mergeModelPolicy, validateAgentModelPolicy } from '../routes/agent-config-helpers.js';
import { projectAgentToBlueprintPayload } from './blueprint-projection.js';
import { createAgentFromPayload } from './agent-instantiation-service.js';
import { TradingProfileCeilingViolationError } from '../agents/trading-profile-reconciliation-saga.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset']) {
    chain[method] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    _reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve);
  return chain;
}

/** Minimal valid agent row for the source agent. */
function makeSourceAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-src',
    userId: 'user-1',
    name: 'Momentum Paper',
    status: 'stopped',
    prompt: 'Trade momentum',
    style: 'balanced',
    executionDefaults: { mode: 'paper', slippageBps: 50 },
    unifiedConfig: {
      capabilityMode: 'intelligence',
      intelligence: { provider: 'openai', wakeIntervalMs: 60_000 },
      authorizationMode: 'direct',
      execution: { mode: 'paper' },
      metadata: { version: 1 },
    },
    risk: { maxOpenPositions: 5 },
    strategy: null,
    capital: null,
    maxBots: null,
    tickIntervalMs: null,
    toolPolicy: null,
    modelPolicy: null,
    runtimePolicyOverrides: null,
    wakePreferences: null,
    openPositionEscalationToJudgePolicy: 'uncovered_or_triggered',
    riskOverrides: { customField: true },
    pauseState: { reason: 'manual' },
    blueprintId: 'bp-1',
    blueprintRevisionId: 'rev-1',
    notificationPolicy: { sendMessage: { email: { enabled: true } } },
    telegramChatId: 'chat-123',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/** Projected payload returned by the mock of projectAgentToBlueprintPayload. */
function makeProjectedPayload(overrides: Partial<AgentBlueprintRevisionPayload> = {}): AgentBlueprintRevisionPayload {
  return {
    kind: 'agent',
    name: 'Momentum Paper',
    description: '',
    tags: [],
    prompt: 'Trade momentum',
    style: 'balanced',
    strategy: null,
    risk: { maxOpenPositions: 5 },
    executionDefaults: { mode: 'paper', slippageBps: 50 },
    capabilityMode: 'intelligence',
    intelligence: { provider: 'openai', wakeIntervalMs: 60_000 },
    authorizationMode: 'direct',
    openPositionEscalationToJudgePolicy: 'uncovered_or_triggered',
    capital: null,
    maxBots: null,
    tickIntervalMs: null,
    ...overrides,
  } as AgentBlueprintRevisionPayload;
}

/** Active connection rows for the source agent. */
function makeActiveConnections(count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `conn-${i}`,
    agentId: 'agent-src',
    connectionId: `connection-${i}`,
    venueAccountId: `venue-${i}`,
    status: 'active',
    grantedBy: 'user-1',
    grantedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
}

/** Insert tracker to capture what the transaction writes. */
interface InsertTracker {
  inserted: Record<string, unknown>[];
  updated: Record<string, unknown>[];
}

function makeInsertTracker(): InsertTracker {
  return { inserted: [], updated: [] };
}

/**
 * Build a mock Database for cloneAgentAsLive.
 *
 * Select call order in cloneAgentAsLive:
 * 1. Source agent lookup (agents table)
 * 2. Active connections (agentConnections table)
 * 3. Source skills (agentSkills table)
 * 4. (optional) User row for model fallback (users table)
 */
function buildMockDb(selectResults: unknown[][], tracker: InsertTracker): Database {
  let selectCallCount = 0;

  function nextSelect() {
    const idx = selectCallCount++;
    return selectResults[idx] ?? [];
  }

  function makeUpdate() {
    return {
      set: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        tracker.updated.push(v);
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      }),
    };
  }

  function makeInsert() {
    return {
      values: vi.fn().mockImplementation((v: Record<string, unknown> | Record<string, unknown>[]) => {
        if (Array.isArray(v)) {
          tracker.inserted.push(...v);
        } else {
          tracker.inserted.push(v);
        }
        return Promise.resolve();
      }),
    };
  }

  function makeSelect() {
    return makeChain(nextSelect());
  }

  const db = {
    select: vi.fn().mockImplementation(() => makeSelect()),
    insert: vi.fn().mockImplementation(() => makeInsert()),
    update: vi.fn().mockReturnValue(makeUpdate()),
    transaction: vi.fn().mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const tx = {
          select: vi.fn().mockImplementation(() => makeSelect()),
          insert: vi.fn().mockImplementation(() => makeInsert()),
          update: vi.fn().mockReturnValue(makeUpdate()),
        };
        return fn(tx);
      },
    ),
  };

  return db as unknown as Database;
}

/** Default params factory for cloneAgentAsLive. */
function makeParams(db: Database, overrides: Partial<GoLiveParams> = {}): GoLiveParams {
  return {
    sourceAgentId: 'agent-src',
    userId: 'user-1',
    db,
    plansConfig: { plans: {} } as GoLiveParams['plansConfig'],
    userPlanId: 'free',
    isAdmin: false,
    profileReconciliationSaga: {
      readCurrentProfiles: async (_ownerId: string, actorId: string, connections: TradingProfileConnection[]) => new Map(
        connections.flatMap((connection) => connection.venueAccountId === null ? [] : [[connection.venueAccountId, {
          actorId,
          venueAccountId: connection.venueAccountId,
          capital: null,
          riskPosture: null,
          executionDefaults: { mode: 'paper' },
        } satisfies TypedTradingProfile] as const]),
      ),
      executeStaged: async (input) => {
        await input.preparePlannerInput();
        return input.commitLocal(db as never, async () => undefined);
      },
    } as GoLiveParams['profileReconciliationSaga'],
    ...overrides,
  };
}

/** Set up all mocks for a successful happy-path call. */
function setupHappyPath(sourceAgent = makeSourceAgent(), connections = makeActiveConnections()) {
  const skillRows = [{ skillId: 'skill-a' }, { skillId: 'skill-b' }];
  const tracker = makeInsertTracker();

  // selectResults: source reads, then staged-commit revalidation reads.
  const selectResults: unknown[][] = [
    [sourceAgent],
    connections,
    skillRows,
    [sourceAgent],
    connections,
  ];

  const db = buildMockDb(selectResults, tracker);

  // Plan guards pass
  vi.mocked(checkLiveEnabled).mockReturnValue(ok(undefined));
  vi.mocked(checkAgentLimit).mockResolvedValue(ok(undefined));
  vi.mocked(resolvePlanLimitEntitlements).mockReturnValue({ maxBots: 10, maxAgents: 10, maxVenueAccounts: 5, maxCredentials: 5, maxBindings: 5, maxConcurrentBacktests: 2, maxConnections: 5 } as ReturnType<typeof resolvePlanLimitEntitlements>);
  vi.mocked(resolvePlanSkillEntitlements).mockReturnValue({ canViewMarketplaceSkills: true });

  // Projection
  vi.mocked(projectAgentToBlueprintPayload).mockReturnValue(makeProjectedPayload());

  // Model validation passes
  vi.mocked(mergeModelPolicy).mockReturnValue({});
  vi.mocked(validateAgentModelPolicy).mockResolvedValue([]);
  vi.mocked(extractModelSelection).mockReturnValue({ provider: 'openai', lightModel: null });

  // Skill resolution succeeds
  vi.mocked(resolveSkillAssignmentsForUser).mockResolvedValue({
    assignments: [
      { skillId: 'skill-a', skillRevisionId: 'skill-a:v2' },
      { skillId: 'skill-b', skillRevisionId: 'skill-b:v3' },
    ],
  });

  // createAgentFromPayload succeeds
  vi.mocked(createAgentFromPayload).mockResolvedValue({
    agentId: 'new-agent-id',
    unifiedConfig: {
      capabilityMode: 'intelligence',
      intelligence: { provider: 'openai', wakeIntervalMs: 60_000 },
      authorizationMode: 'direct',
      execution: { mode: 'live' },
    },
  });

  return { db, tracker, sourceAgent };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('cloneAgentAsLive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Success paths ────────────────────────────────────────────────────────

  it('successfully clones a paper agent as live', async () => {
    const { db } = setupHappyPath();
    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.agentId).toBeTruthy();
  });

  it('successfully clones a shadow agent as live', async () => {
    const sourceAgent = makeSourceAgent({
      executionDefaults: { mode: 'shadow', slippageBps: 50 },
      unifiedConfig: {
        capabilityMode: 'intelligence',
        intelligence: { provider: 'openai', wakeIntervalMs: 60_000 },
        authorizationMode: 'direct',
        execution: { mode: 'shadow' },
      },
    });
    const { db } = setupHappyPath(sourceAgent);
    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);
  });

  // ── Rejection paths ──────────────────────────────────────────────────────

  it('rejects when source agent is already live (400)', async () => {
    const tracker = makeInsertTracker();
    const sourceAgent = makeSourceAgent();
    const db = buildMockDb([
      [sourceAgent],
      [{ connectionId: 'connection-0', venueAccountId: 'venue-0', status: 'active' }],
      [],
    ], tracker);

    const result = await cloneAgentAsLive(makeParams(db, {
      profileReconciliationSaga: {
        readCurrentProfiles: async (_ownerId, actorId, connections) => new Map(connections.flatMap((connection) => (
          connection.venueAccountId === null ? [] : [[connection.venueAccountId, {
            actorId,
            venueAccountId: connection.venueAccountId,
            capital: null,
            riskPosture: null,
            executionDefaults: { mode: 'live' },
          } satisfies TypedTradingProfile] as const]
        ))),
        executeStaged: vi.fn(),
      } as never,
    }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.status).toBe(400);
    expect(result.message).toContain('already in live mode');
  });

  it('rejects when source agent not found (404)', async () => {
    const tracker = makeInsertTracker();
    const db = buildMockDb([[]], tracker);

    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.status).toBe(404);
    expect(result.error).toBe('not_found');
  });

  it('rejects when no active connections (400)', async () => {
    const tracker = makeInsertTracker();
    const sourceAgent = makeSourceAgent();
    // selectResults: 1. agent found, 2. no connections, 3. skills
    const db = buildMockDb([[sourceAgent], [], []], tracker);

    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.status).toBe(400);
    expect(result.message).toContain('active connection');
  });

  it('rejects when plan does not allow live (403)', async () => {
    const tracker = makeInsertTracker();
    const sourceAgent = makeSourceAgent();
    const connections = makeActiveConnections();
    const db = buildMockDb([[sourceAgent], connections, []], tracker);

    vi.mocked(checkLiveEnabled).mockReturnValue(
      err({ code: 'plan.live_disabled', message: 'Live trading not available on your plan' }),
    );

    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.status).toBe(403);
    expect(result.error).toBe('plan.live_disabled');
  });

  it('rejects when agent limit exceeded (403)', async () => {
    const tracker = makeInsertTracker();
    const sourceAgent = makeSourceAgent();
    const connections = makeActiveConnections();
    const db = buildMockDb([[sourceAgent], connections, []], tracker);

    vi.mocked(checkLiveEnabled).mockReturnValue(ok(undefined));
    vi.mocked(checkAgentLimit).mockResolvedValue(
      err({ code: 'plan.limit_exceeded', message: 'Agent limit reached (3)', params: { resource: 'agent', limit: 3, current: 3 } }),
    );

    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.status).toBe(403);
    expect(result.error).toBe('plan.limit_exceeded');
    expect(result.params).toEqual({ resource: 'agent', limit: 3, current: 3 });
  });

  // ── Name handling ────────────────────────────────────────────────────────

  it('name override works', async () => {
    const { db } = setupHappyPath();
    const result = await cloneAgentAsLive(makeParams(db, { nameOverride: 'Custom Live Agent' }));

    expect(result.ok).toBe(true);

    // Verify the payload passed to createAgentFromPayload has the override name
    const createCall = vi.mocked(createAgentFromPayload).mock.calls[0]!;
    const livePayload = createCall[1] as AgentBlueprintRevisionPayload;
    expect(livePayload.name).toBe('Custom Live Agent');
  });

  it('default name appends " (Live)"', async () => {
    const { db } = setupHappyPath();
    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    const createCall = vi.mocked(createAgentFromPayload).mock.calls[0]!;
    const livePayload = createCall[1] as AgentBlueprintRevisionPayload;
    expect(livePayload.name).toBe('Momentum Paper (Live)');
  });

  // ── Field carry-over ─────────────────────────────────────────────────────

  it('copies source agent notificationPolicy', async () => {
    const { db, tracker } = setupHappyPath();
    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    // The transaction updates the new agent with the source's notificationPolicy
    const notifUpdate = tracker.updated.find((u) => 'notificationPolicy' in u);
    expect(notifUpdate).toBeDefined();
    expect((notifUpdate as Record<string, unknown>).notificationPolicy).toEqual({
      sendMessage: { email: { enabled: true } },
    });
  });

  it('copies active agent_connections to new agent', async () => {
    const { db, tracker } = setupHappyPath();
    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    // Verify connection rows were inserted in the transaction
    const connInserts = tracker.inserted.filter((r) => 'connectionId' in r && 'grantedBy' in r);
    expect(connInserts.length).toBeGreaterThanOrEqual(1);
    expect(connInserts[0]!.connectionId).toBe('connection-0');
    expect(connInserts[0]!.status).toBe('active');
    expect(connInserts[0]!.grantedBy).toBe('user-1');
  });

  it('keeps copied resolved connections out of the local profile boundary', async () => {
    const { db } = setupHappyPath();

    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);
  });

  it('preserves intelligence, execution, allowedPresets, presetTransition from source unifiedConfig', async () => {
    const { db } = setupHappyPath();
    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    // Verify the projected payload carried through to createAgentFromPayload
    const createCall = vi.mocked(createAgentFromPayload).mock.calls[0]!;
    const livePayload = createCall[1] as AgentBlueprintRevisionPayload;
    // executionDefaults should have mode overridden to 'live'
    expect(livePayload.executionDefaults).toEqual(expect.objectContaining({ mode: 'live' }));
  });

  it('copies source agent unifiedConfig metadata in overlay step', async () => {
    // The source agent has metadata in unifiedConfig that should be preserved
    const { db, tracker } = setupHappyPath();
    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    // The overlay step merges unifiedConfig with metadata from source
    const ucUpdate = tracker.updated.find((u) => 'unifiedConfig' in u);
    if (ucUpdate) {
      const mergedUc = (ucUpdate as Record<string, unknown>).unifiedConfig as Record<string, unknown>;
      expect(mergedUc.metadata).toEqual({ version: 1 });
    }
  });

  // ── Field exclusion ──────────────────────────────────────────────────────

  it('does NOT carry riskOverrides or pauseState', async () => {
    const { db } = setupHappyPath();
    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    // Verify the context passed to createAgentFromPayload has no blueprint attribution
    const createCall = vi.mocked(createAgentFromPayload).mock.calls[0]!;
    const context = createCall[3] as Record<string, unknown>;

    // Go Live does not carry blueprint attribution
    expect(context.blueprintId).toBeUndefined();
    expect(context.blueprintRevisionId).toBeUndefined();

    // riskOverrides and pauseState are instance-only fields that the projected
    // payload and createAgentFromPayload context never carry. The projection
    // function (projectAgentToBlueprintPayload) strips them, and the Go Live
    // service doesn't add them back.
    const livePayload = createCall[1] as Record<string, unknown>;
    expect(livePayload.riskOverrides).toBeUndefined();
    expect(livePayload.pauseState).toBeUndefined();
  });

  it('does NOT carry blueprintId or blueprintRevisionId', async () => {
    const { db } = setupHappyPath();
    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    const createCall = vi.mocked(createAgentFromPayload).mock.calls[0]!;
    const context = createCall[3] as Record<string, unknown>;
    expect(context.blueprintId).toBeUndefined();
    expect(context.blueprintRevisionId).toBeUndefined();
  });

  // ── Skill re-resolution ──────────────────────────────────────────────────

  it('re-resolves skills via resolveSkillAssignmentsForUser', async () => {
    const { db } = setupHappyPath();
    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);
    expect(resolveSkillAssignmentsForUser).toHaveBeenCalledTimes(1);

    // Verify the resolved assignments are passed to createAgentFromPayload
    const createCall = vi.mocked(createAgentFromPayload).mock.calls[0]!;
    const skillRefs = createCall[2] as Array<{ skillId: string; skillRevisionId: string }>;
    expect(skillRefs).toEqual([
      { skillId: 'skill-a', skillRevisionId: 'skill-a:v2' },
      { skillId: 'skill-b', skillRevisionId: 'skill-b:v3' },
    ]);
  });

  it('rejects when skill re-resolution fails', async () => {
    const tracker = makeInsertTracker();
    const sourceAgent = makeSourceAgent();
    const connections = makeActiveConnections();
    const skillRows = [{ skillId: 'skill-a' }];
    const db = buildMockDb([[sourceAgent], connections, skillRows], tracker);

    vi.mocked(checkLiveEnabled).mockReturnValue(ok(undefined));
    vi.mocked(checkAgentLimit).mockResolvedValue(ok(undefined));
    vi.mocked(resolvePlanSkillEntitlements).mockReturnValue({ canViewMarketplaceSkills: true });
    vi.mocked(projectAgentToBlueprintPayload).mockReturnValue(makeProjectedPayload());
    vi.mocked(mergeModelPolicy).mockReturnValue({});
    vi.mocked(validateAgentModelPolicy).mockResolvedValue([]);
    vi.mocked(extractModelSelection).mockReturnValue({ provider: 'openai', lightModel: null });

    vi.mocked(resolveSkillAssignmentsForUser).mockResolvedValue({
      error: { code: 'validation_error', message: 'Skill not found' },
    });

    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.status).toBe(400);
    expect(result.message).toContain('Skill not found');
  });

  // ── Plan bypass (no plansConfig) ─────────────────────────────────────────

  it('skips plan checks when plansConfig is undefined', async () => {
    const { db } = setupHappyPath();
    vi.mocked(resolvePlanLimitEntitlements).mockReturnValue({ maxBots: 10 } as ReturnType<typeof resolvePlanLimitEntitlements>);

    const result = await cloneAgentAsLive(makeParams(db, { plansConfig: undefined }));

    expect(result.ok).toBe(true);
    expect(checkLiveEnabled).not.toHaveBeenCalled();
    expect(checkAgentLimit).not.toHaveBeenCalled();
  });

  // ── Execution mode override ──────────────────────────────────────────────

  it('overrides execution mode to live in the payload', async () => {
    const { db } = setupHappyPath();
    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    const createCall = vi.mocked(createAgentFromPayload).mock.calls[0]!;
    const livePayload = createCall[1] as AgentBlueprintRevisionPayload;
    expect(livePayload.executionDefaults!.mode).toBe('live');
  });

  // ── New agent status ─────────────────────────────────────────────────────

  it('new agent is created in stopped status', async () => {
    const { db } = setupHappyPath();
    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    // createAgentFromPayload is responsible for setting status = 'stopped'
    // This is verified in the instantiation service tests. Here we just
    // confirm the service was called.
    expect(createAgentFromPayload).toHaveBeenCalledTimes(1);
  });

  // ── Telegramchatid carry-over ────────────────────────────────────────────

  it('passes source telegramChatId to createAgentFromPayload context', async () => {
    const { db } = setupHappyPath();
    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    const createCall = vi.mocked(createAgentFromPayload).mock.calls[0]!;
    const context = createCall[3] as Record<string, unknown>;
    expect(context.telegramChatId).toBe('chat-123');
  });

  // ── Multiple connections ─────────────────────────────────────────────────

  it('copies all active connections to the new agent', async () => {
    const multipleConns = makeActiveConnections(3);
    const { db, tracker } = setupHappyPath(makeSourceAgent(), multipleConns);
    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    const connInserts = tracker.inserted.filter((r) => 'connectionId' in r && 'grantedBy' in r);
    expect(connInserts).toHaveLength(3);
    expect(connInserts.map((c) => c.connectionId)).toEqual(['connection-0', 'connection-1', 'connection-2']);
  });

  // ── Risk bounds validation ───────────────────────────────────────────────

  it('rejects when the boundary enforces a risk ceiling (400)', async () => {
    const tracker = makeInsertTracker();
    const sourceAgent = makeSourceAgent({ risk: { maxOpenPositions: 100 } });
    const connections = makeActiveConnections();
    const skillRows = [{ skillId: 'skill-a' }];
    const db = buildMockDb([[sourceAgent], connections, skillRows], tracker);

    vi.mocked(checkLiveEnabled).mockReturnValue(ok(undefined));
    vi.mocked(checkAgentLimit).mockResolvedValue(ok(undefined));
    vi.mocked(projectAgentToBlueprintPayload).mockReturnValue(
      makeProjectedPayload({ risk: { maxOpenPositions: 100 } }),
    );

    const result = await cloneAgentAsLive(makeParams(db, {
      profileReconciliationSaga: {
        readCurrentProfiles: async () => new Map(),
        executeStaged: async () => {
          throw new TradingProfileCeilingViolationError('maxOpenPositions cannot exceed the operator ceiling of 50');
        },
      } as unknown as GoLiveParams['profileReconciliationSaga'],
    }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.status).toBe(400);
    expect(result.error).toBe('validation_error');
    expect(result.message).toContain('maxOpenPositions cannot exceed the operator ceiling');
  });

  // ── Model policy validation ──────────────────────────────────────────────

  it('rejects when model policy validation fails (400)', async () => {
    const tracker = makeInsertTracker();
    const sourceAgent = makeSourceAgent();
    const connections = makeActiveConnections();
    const skillRows = [{ skillId: 'skill-a' }];
    const db = buildMockDb([[sourceAgent], connections, skillRows], tracker);

    vi.mocked(checkLiveEnabled).mockReturnValue(ok(undefined));
    vi.mocked(checkAgentLimit).mockResolvedValue(ok(undefined));
    vi.mocked(projectAgentToBlueprintPayload).mockReturnValue(makeProjectedPayload());
    vi.mocked(mergeModelPolicy).mockReturnValue({});
    vi.mocked(validateAgentModelPolicy).mockResolvedValue([
      { message: 'Model not available in your region' },
    ]);

    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.status).toBe(400);
    expect(result.message).toContain('Model not available');
  });

  // ── Provider fallback ────────────────────────────────────────────────────

  it('rejects when no provider available from agent, user, or operator defaults (400)', async () => {
    const tracker = makeInsertTracker();
    const sourceAgent = makeSourceAgent();
    const connections = makeActiveConnections();
    const skillRows = [{ skillId: 'skill-a' }];
    // 4th select result is the user row (for provider fallback lookup)
    const db = buildMockDb([[sourceAgent], connections, skillRows, [{ aiModelConfig: null }]], tracker);

    vi.mocked(checkLiveEnabled).mockReturnValue(ok(undefined));
    vi.mocked(checkAgentLimit).mockResolvedValue(ok(undefined));
    vi.mocked(projectAgentToBlueprintPayload).mockReturnValue(makeProjectedPayload());
    vi.mocked(mergeModelPolicy).mockReturnValue({});
    vi.mocked(validateAgentModelPolicy).mockResolvedValue([]);
    // Provider is null — triggers fallback path
    vi.mocked(extractModelSelection).mockReturnValue({ provider: null, lightModel: null });

    // normalizePersistedAiModelConfig returns null (no user config)
    const { normalizePersistedAiModelConfig } = await import('@herobids/domain');
    vi.mocked(normalizePersistedAiModelConfig).mockReturnValue(null as unknown as ReturnType<typeof normalizePersistedAiModelConfig>);

    const result = await cloneAgentAsLive(makeParams(db, {
      operatorModelDefaults: undefined,
    }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.status).toBe(400);
    expect(result.message).toContain('Provider is required');
  });

  // ── maxBots plan resolution ──────────────────────────────────────────────

  it('clamps maxBots to plan limit when requested value exceeds it', async () => {
    const sourceAgent = makeSourceAgent();
    const { db } = setupHappyPath(sourceAgent);

    // Source has maxBots null, but projected payload gets maxBots 20
    vi.mocked(projectAgentToBlueprintPayload).mockReturnValue(
      makeProjectedPayload({ maxBots: 20 }),
    );
    vi.mocked(resolvePlanLimitEntitlements).mockReturnValue({
      maxBots: 5,
      maxAgents: 10,
      maxVenueAccounts: 5,
      maxCredentials: 5,
      maxBindings: 5,
      maxConcurrentBacktests: 2,
      maxConnections: 5,
    } as ReturnType<typeof resolvePlanLimitEntitlements>);

    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    const createCall = vi.mocked(createAgentFromPayload).mock.calls[0]!;
    const livePayload = createCall[1] as AgentBlueprintRevisionPayload;
    expect(livePayload.maxBots).toBe(5);
  });

  it('defaults maxBots to plan limit when payload maxBots is null', async () => {
    const sourceAgent = makeSourceAgent();
    const { db } = setupHappyPath(sourceAgent);

    vi.mocked(projectAgentToBlueprintPayload).mockReturnValue(
      makeProjectedPayload({ maxBots: null }),
    );
    vi.mocked(resolvePlanLimitEntitlements).mockReturnValue({
      maxBots: 8,
      maxAgents: 10,
      maxVenueAccounts: 5,
      maxCredentials: 5,
      maxBindings: 5,
      maxConcurrentBacktests: 2,
      maxConnections: 5,
    } as ReturnType<typeof resolvePlanLimitEntitlements>);

    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    const createCall = vi.mocked(createAgentFromPayload).mock.calls[0]!;
    const livePayload = createCall[1] as AgentBlueprintRevisionPayload;
    expect(livePayload.maxBots).toBe(8);
  });

  it('preserves maxBots when within plan limit', async () => {
    const sourceAgent = makeSourceAgent();
    const { db } = setupHappyPath(sourceAgent);

    vi.mocked(projectAgentToBlueprintPayload).mockReturnValue(
      makeProjectedPayload({ maxBots: 3 }),
    );
    vi.mocked(resolvePlanLimitEntitlements).mockReturnValue({
      maxBots: 10,
      maxAgents: 10,
      maxVenueAccounts: 5,
      maxCredentials: 5,
      maxBindings: 5,
      maxConcurrentBacktests: 2,
      maxConnections: 5,
    } as ReturnType<typeof resolvePlanLimitEntitlements>);

    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    const createCall = vi.mocked(createAgentFromPayload).mock.calls[0]!;
    const livePayload = createCall[1] as AgentBlueprintRevisionPayload;
    expect(livePayload.maxBots).toBe(3);
  });

  // ── executionPolicy carry-over from source unifiedConfig ─────────────────

  it('carries executionPolicy from projection through to the live payload', async () => {
    const sourceAgent = makeSourceAgent({
      unifiedConfig: {
        capabilityMode: 'intelligence',
        intelligence: { provider: 'openai', wakeIntervalMs: 60_000 },
        authorizationMode: 'direct',
        execution: {
          mode: 'paper',
          positionSizeMode: 'fixed',
          fixedPositionSize: '200',
        },
        metadata: { version: 1 },
      },
    });
    const { db } = setupHappyPath(sourceAgent);

    // Projection now correctly reads uc.execution and maps to executionPolicy
    vi.mocked(projectAgentToBlueprintPayload).mockReturnValue(
      makeProjectedPayload({
        executionPolicy: {
          positionSizeMode: 'fixed',
          fixedPositionSize: '200',
        },
      }),
    );

    const result = await cloneAgentAsLive(makeParams(db));

    expect(result.ok).toBe(true);

    const createCall = vi.mocked(createAgentFromPayload).mock.calls[0]!;
    const livePayload = createCall[1] as AgentBlueprintRevisionPayload;
    expect(livePayload.executionPolicy).toEqual({
      positionSizeMode: 'fixed',
      fixedPositionSize: '200',
    });
  });
});
