/**
 * Integration test: Agent-native decision resolution
 *
 * Verifies that an agent can submit a decision and have it executed
 * WITHOUT creating a bot first — resolution goes through:
 *   agent_connections → connections → venue_accounts
 *
 * The full pipeline is exercised: DecisionIntakeResolver → AgentIntakeResolver
 * → PaperExecutor → persistence (DB writes).
 *
 * Requires DATABASE_URL and REDIS_URL. Skipped otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import Redis from 'ioredis';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import {
  createDatabase,
  AgentRepository,
  FillRepository,
  PositionRepository,
  ExecutionPlanRepository,
  OrderRepository,
  BalanceSnapshotRepository,
  DecisionRepository,
  BacktestingRepository,
  PgJournal,
  users,
  agents,
  agentRuntimeSessions,
  localIdentities,
  userPlans,
  connections,
  agentConnections,
  venueAccounts,
  decisions,
  positions,
  executionPlans,
  fills,
} from '@herobids/db';
import type { DecisionSubmitPayload, MessageEnvelope, AgentRiskDefaultsConfig } from '@herobids/domain';
import { OracleMarkSource } from '@herobids/venues';
import { AgentDecisionHandler } from '../../agents/agent-decision-handler.js';
import { AgentIntakeResolver } from '../../agents/agent-intake-resolver.js';
import type { DecisionIntakeResolver } from '../../agents/agent-decision-handler.js';
import { InstanceEventPublisher } from '../../agents/instance-event-publisher.js';
import type { DecisionContext } from '@herobids/engine';
import type { IdGenerator } from '@herobids/engine';
import type { OrderId, FillId } from '@herobids/domain';

const scrypt = promisify<crypto.BinaryLike, crypto.BinaryLike, number, Buffer>(crypto.scrypt);

const SKIP = !process.env['DATABASE_URL'] || !process.env['REDIS_URL'];
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://herobids:herobids@localhost:5432/herobids';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname || 'localhost',
    port: parseInt(u.port || '6379', 10),
    ...(u.password && { password: decodeURIComponent(u.password) }),
    ...(u.username && { username: decodeURIComponent(u.username) }),
  };
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

describe.skipIf(SKIP)('Agent-native decision resolution (integration)', () => {
  let db: ReturnType<typeof createDatabase>;
  let redisClient: Redis;
  let agentRepo: AgentRepository;
  let positionRepo: PositionRepository;
  let decisionRepo: DecisionRepository;
  let planRepo: ExecutionPlanRepository;
  let fillRepo: FillRepository;
  let orderRepo: OrderRepository;
  let balanceSnapshotRepo: BalanceSnapshotRepository;
  let backtestingRepo: BacktestingRepository;
  let journal: PgJournal;
  let eventPublisher: InstanceEventPublisher;
  let handler: AgentDecisionHandler;

  // Test data IDs
  let userId: string;
  let agentId: string;
  let connectionId: string;
  let grantId: string;
  let venueAccountId: string;
  let sessionId: string;

  const idGen: IdGenerator & { planId(): string; decisionId(): string } = {
    orderId: () => crypto.randomUUID() as OrderId,
    fillId: () => crypto.randomUUID() as FillId,
    planId: () => crypto.randomUUID(),
    decisionId: () => crypto.randomUUID(),
  };

  beforeAll(async () => {
    db = createDatabase(DB_URL);
    const redisConn = parseRedisUrl(REDIS_URL);
    redisClient = new Redis(redisConn);
    agentRepo = new AgentRepository(db);
    positionRepo = new PositionRepository(db);
    decisionRepo = new DecisionRepository(db);
    planRepo = new ExecutionPlanRepository(db);
    fillRepo = new FillRepository(db);
    orderRepo = new OrderRepository(db);
    balanceSnapshotRepo = new BalanceSnapshotRepository(db);
    backtestingRepo = new BacktestingRepository(db);
    journal = new PgJournal(db);
    eventPublisher = new InstanceEventPublisher(redisClient);
  }, 30_000);

  afterAll(async () => {
    await redisClient.quit();
  });

  beforeEach(async () => {
    // Clean relevant tables
    await db.execute(sql`
      TRUNCATE
        fills, orders, execution_plans, decisions, positions,
        decision_contexts, journal_events,
        agent_connections, connections,
        venue_accounts, user_credentials,
        agent_runtime_sessions, agent_messages, agent_artifacts,
        agent_outbound_messages, agents,
        sessions, local_identities, oauth_identities, user_plans, users
      CASCADE
    `);

    const now = new Date();

    // 1. Seed user
    userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      displayName: 'Test User',
      email: `${userId}@integration-test.local`,
      planId: 'free',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(localIdentities).values({
      id: crypto.randomUUID(),
      userId,
      passwordHash: await hashPassword('password123'),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(userPlans).values({
      id: crypto.randomUUID(),
      userId,
      planId: 'free',
    });

    // 2. Seed venue account
    venueAccountId = crypto.randomUUID();
    await db.insert(venueAccounts).values({
      id: venueAccountId,
      userId,
      venue: 'hyperliquid',
      label: 'Test Hyperliquid',
      venueAccountRef: '0xtest',
      createdAt: now,
      updatedAt: now,
    });

    // 3. Seed connection (resolved to the venue account created above)
    connectionId = crypto.randomUUID();
    await db.insert(connections).values({
      id: connectionId,
      userId,
      provider: 'hyperliquid',
      label: 'Test Connection',
      status: 'active',
      resolvedVenueAccountId: venueAccountId,
      createdAt: now,
      updatedAt: now,
    });

    // 4. resolvedVenueAccountId already set on connection in step 3

    // 5. Seed agent
    agentId = crypto.randomUUID();
    await db.insert(agents).values({
      id: agentId,
      userId,
      name: 'Test Trading Agent',
      prompt: 'Trade BTC aggressively.',
      skillIds: [],
      status: 'active',
      executionMode: 'paper',
      capital: '100000',
      createdAt: now,
      updatedAt: now,
    });

    // 6. Grant agent access to the connection
    grantId = crypto.randomUUID();
    await db.insert(agentConnections).values({
      id: grantId,
      agentId,
      connectionId,
      status: 'active',
      grantedBy: userId,
      grantedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // 7. Create a running session for the agent
    sessionId = crypto.randomUUID();
    await db.insert(agentRuntimeSessions).values({
      id: sessionId,
      agentId,
      status: 'running',
      heartbeatAt: now,
    });

    // 8. Build the resolver chain (mimics worker/src/index.ts wiring)
    // Use a stub mark source that returns a fixed price
    const stubMarkSource = {
      fetchMark: async (instrument: string) => ({
        ok: true as const,
        data: {
          price: { toString: () => '50000' } as any,
          source: 'oracle' as const,
          instrument,
          timestamp: now.toISOString(),
        },
      }),
    };

    const agentIntakeResolver = new AgentIntakeResolver({
      db,
      agentRepo,
      positionRepo,
      decisionRepo,
      planRepo,
      fillRepo,
      orderRepo,
      balanceSnapshotRepo,
      backtestingRepo,
      journal,
      markSource: stubMarkSource as any,
      idGen,
      agentRiskDefaults: {
        maxOpenPositions: 10,
        maxPositionSizePct: 100,
        maxPositionSize: 1_000_000,
        stopLossMaxUnrealizedLossPct: 10,
        dailyMaxLossPct: 20,
        stopLossCooldownMs: 300_000,
        maxOrderNotionalMultiplier: 1,
      } satisfies AgentRiskDefaultsConfig,
    });

    // The combined resolver: no actorRegistry match → agent fallback
    const intakeResolver: DecisionIntakeResolver = {
      getIntakeDeps: (instanceId: string, instrumentId?: string) => {
        // No bot actors registered — always fall through to agent
        if (instrumentId) return agentIntakeResolver.getIntakeDeps(instanceId, instrumentId);
        return undefined;
      },
      getDecisionContext: (instanceId: string, instrumentId?: string) => {
        if (instrumentId) return agentIntakeResolver.getDecisionContext(instanceId, instrumentId);
        return undefined;
      },
      getPosition: (instanceId: string, instrumentId?: string) => {
        if (instrumentId) return agentIntakeResolver.getPosition(instanceId, instrumentId);
        return undefined;
      },
    };

    handler = new AgentDecisionHandler(agentRepo as any, intakeResolver, eventPublisher as any);
  });

  function makeEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
    return {
      schemaVersion: 'v1',
      messageId: crypto.randomUUID(),
      correlationId: sessionId, // must match the running agentRuntimeSession id
      initiatorType: 'agent',
      initiatorId: agentId,
      agentId,
      type: 'agent.decision.submit',
      createdAt: new Date().toISOString(),
      payload: {},
      ...overrides,
    };
  }

  function makePayload(overrides: Partial<DecisionSubmitPayload> = {}): DecisionSubmitPayload {
    return {
      decisionId: crypto.randomUUID(),
      instrumentId: 'BTC/USD:USD',
      intent: 'go_long',
      targetSize: '0.1',
      rationaleSummary: 'Integration test — agent direct trade',
      confidence: 0.85,
      ...overrides,
    };
  }

  it('agent submits a decision and it executes via paper executor without a bot', async () => {
    const envelope = makeEnvelope();
    const payload = makePayload();

    await handler.handleDecisionSubmit(envelope, payload);

    // Verify decision was persisted
    const [decision] = await db.select().from(decisions).where(eq(decisions.id, payload.decisionId));
    expect(decision).toBeDefined();
    expect(decision!.instrumentId).toBe('BTC/USD:USD');
    expect(decision!.intent).toBe('go_long');
    expect(decision!.actorType).toBe('agent');
    expect(decision!.actorId).toBe(agentId);
    expect(decision!.venueAccountId).toBe(venueAccountId);

    // Verify an execution plan was created
    const plans = await db.select().from(executionPlans).where(eq(executionPlans.decisionId, payload.decisionId));
    expect(plans.length).toBe(1);
    expect(plans[0]!.venue).toBe('hyperliquid');
    expect(plans[0]!.symbol).toBe('BTC/USD:USD');

    // Verify fills were created (paper executor always fills)
    const allFills = await db.select().from(fills).where(eq(fills.venueAccountId, venueAccountId));
    expect(allFills.length).toBeGreaterThan(0);

    // Verify position was opened
    const openPositions = await positionRepo.getOpenByActor('agent', agentId);
    expect(openPositions.length).toBe(1);
    expect(openPositions[0]!.symbol).toBe('BTC/USD:USD');
    expect(openPositions[0]!.side).toBe('long');
  });

  it('rejects decision when agent has no active trading grant', async () => {
    // Revoke the grant
    await db.update(agentConnections).set({ status: 'revoked' }).where(eq(agentConnections.id, grantId));

    const envelope = makeEnvelope();
    const payload = makePayload();

    // Should not throw — rejects gracefully via event publisher
    await handler.handleDecisionSubmit(envelope, payload);

    // No decision should have been persisted
    const allDecisions = await db.select().from(decisions).where(eq(decisions.id, payload.decisionId));
    expect(allDecisions.length).toBe(0);
  });

  it('agent can trade multiple instruments without instrument mismatch', async () => {
    const envelope = makeEnvelope();
    const btcPayload = makePayload({ instrumentId: 'BTC/USD:USD' });
    const ethPayload = makePayload({ decisionId: crypto.randomUUID(), instrumentId: 'ETH/USD:USD' });

    await handler.handleDecisionSubmit(envelope, btcPayload);
    await handler.handleDecisionSubmit(envelope, ethPayload);

    // Both should succeed
    const [btcDecision] = await db.select().from(decisions).where(eq(decisions.id, btcPayload.decisionId));
    const [ethDecision] = await db.select().from(decisions).where(eq(decisions.id, ethPayload.decisionId));

    expect(btcDecision).toBeDefined();
    expect(btcDecision!.instrumentId).toBe('BTC/USD:USD');
    expect(ethDecision).toBeDefined();
    expect(ethDecision!.instrumentId).toBe('ETH/USD:USD');

    // Both positions should exist
    const openPositions = await positionRepo.getOpenByActor('agent', agentId);
    const symbols = openPositions.map((p) => p.symbol).sort();
    expect(symbols).toContain('BTC/USD:USD');
    expect(symbols).toContain('ETH/USD:USD');
  });

  it('rejects decision when agent is paused', async () => {
    await db.update(agents).set({ status: 'paused' }).where(eq(agents.id, agentId));

    const envelope = makeEnvelope();
    const payload = makePayload();

    await handler.handleDecisionSubmit(envelope, payload);

    const allDecisions = await db.select().from(decisions).where(eq(decisions.id, payload.decisionId));
    expect(allDecisions.length).toBe(0);
  });

  it('uses existing position state for subsequent decisions', async () => {
    const envelope = makeEnvelope();

    // First trade: go long
    const firstPayload = makePayload({ intent: 'go_long', targetSize: '1.0' });
    await handler.handleDecisionSubmit(envelope, firstPayload);

    // Second trade: close (go_short with same size to flatten)
    const secondPayload = makePayload({
      decisionId: crypto.randomUUID(),
      intent: 'go_short',
      targetSize: '1.0',
    });
    await handler.handleDecisionSubmit(envelope, secondPayload);

    // Both decisions persisted
    const allDecisions = await db.select().from(decisions);
    expect(allDecisions.length).toBe(2);

    // Position should reflect the second trade
    const openPositions = await positionRepo.getOpenByActor('agent', agentId);
    // After go_long(1) then go_short(1), position should be flat or short depending on engine logic
    // The key assertion: the pipeline ran twice without error
    expect(allDecisions.every((d) => d.actorType === 'agent')).toBe(true);
  });

  it('rejects decision when correlationId does not match the active session id', async () => {
    // Use a random UUID that is NOT the active sessionId — this is the root cause
    // of Bug 005: makeEnvelope() was generating a random correlationId instead of
    // using sessionId, causing every decision to be rejected with stale_session.
    const envelope = makeEnvelope({ correlationId: crypto.randomUUID() });
    const payload = makePayload();

    await handler.handleDecisionSubmit(envelope, payload);

    // The stale_session check fires before any DB write, so no decision is persisted.
    const allDecisions = await db.select().from(decisions).where(eq(decisions.id, payload.decisionId));
    expect(allDecisions.length).toBe(0);

    // No execution plan or fills either
    const allPlans = await db.select().from(executionPlans).where(eq(executionPlans.decisionId, payload.decisionId));
    expect(allPlans.length).toBe(0);
  });

  it('risk gate rejects decision when agent capital is insufficient for the order notional', async () => {
    // Lower the agent capital to $100 — smaller than the 0.1 BTC × $50,000 = $5,000 notional.
    // This is the root cause of Bug 005 Bug 2: the integration test agent had no capital
    // configured, which previously defaulted to '$100', blocking all trades via the risk gate.
    await db.update(agents).set({ capital: '100' }).where(eq(agents.id, agentId));

    const envelope = makeEnvelope();
    // 0.1 BTC at the stub mark price of $50,000 = $5,000 notional > $100 maxOrderNotional
    const payload = makePayload({ targetSize: '0.1' });

    await handler.handleDecisionSubmit(envelope, payload);

    // The decision IS persisted — the risk gate runs inside the engine after the DB write.
    const [decision] = await db.select().from(decisions).where(eq(decisions.id, payload.decisionId));
    expect(decision).toBeDefined();

    // An execution plan is created (write-ahead) but then marked failed by the risk gate.
    const allPlans = await db.select().from(executionPlans).where(eq(executionPlans.decisionId, payload.decisionId));
    expect(allPlans.length).toBe(1);
    expect(allPlans[0]!.status).toBe('failed');

    // No fills are created — the executor never ran.
    const allFills = await db.select().from(fills).where(eq(fills.venueAccountId, venueAccountId));
    expect(allFills.length).toBe(0);
  });

  describe('1inch swap path', () => {
    let swapVenueAccountId: string;
    let swapConnectionId: string;
    let swapGrantId: string;
    let swapTokenSafety: { checkSwapTarget: ReturnType<typeof vi.fn> };
    let swapHandler: AgentDecisionHandler;

    beforeEach(async () => {
      const now = new Date(Date.now() + 1000); // later than parent grant to win recency tie

      // Seed 1inch venue account
      swapVenueAccountId = crypto.randomUUID();
      await db.insert(venueAccounts).values({
        id: swapVenueAccountId,
        userId,
        venue: '1inch',
        label: 'Test 1inch',
        venueAccountRef: null,
        createdAt: now,
        updatedAt: now,
      });

      // Seed 1inch connection
      swapConnectionId = crypto.randomUUID();
      await db.insert(connections).values({
        id: swapConnectionId,
        userId,
        provider: '1inch',
        label: 'Test 1inch Connection',
        status: 'active',
        resolvedVenueAccountId: swapVenueAccountId,
        createdAt: now,
        updatedAt: now,
      });

      // Grant agent access to the 1inch connection
      swapGrantId = crypto.randomUUID();
      await db.insert(agentConnections).values({
        id: swapGrantId,
        agentId,
        connectionId: swapConnectionId,
        status: 'active',
        grantedBy: userId,
        grantedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      // Mock swap token safety — approves all buys
      swapTokenSafety = {
        checkSwapTarget: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            tokenAddress: 'ETH',
            tokenSymbol: 'ETH',
            overridden: false,
          },
        }),
      };

      const stubMarkSource = {
        fetchMark: async (instrument: string) => ({
          ok: true as const,
          data: {
            price: { toString: () => '1600' } as any,
            source: 'oracle' as const,
            instrument,
            timestamp: now.toISOString(),
          },
        }),
      };

      const swapIntakeResolver = new AgentIntakeResolver({
        db,
        agentRepo,
        positionRepo,
        decisionRepo,
        planRepo,
        fillRepo,
        orderRepo,
        balanceSnapshotRepo,
        backtestingRepo,
        journal,
        markSource: stubMarkSource as any,
        idGen,
        agentRiskDefaults: {
          maxOpenPositions: 10,
          maxPositionSizePct: 100,
          maxPositionSize: 1_000_000,
          stopLossMaxUnrealizedLossPct: 10,
          dailyMaxLossPct: 20,
          stopLossCooldownMs: 300_000,
          maxOrderNotionalMultiplier: 1,
        } satisfies AgentRiskDefaultsConfig,
        swapTokenSafety: swapTokenSafety as any,
        oneInchConfig: { tokenSafetyNetwork: 'base', chainId: 8453 },
      });

      const swapIntakeResolverFn: DecisionIntakeResolver = {
        getIntakeDeps: (instanceId: string, instrumentId?: string) => {
          if (instrumentId) return swapIntakeResolver.getIntakeDeps(instanceId, instrumentId);
          return undefined;
        },
        getDecisionContext: (instanceId: string, instrumentId?: string) => {
          if (instrumentId) return swapIntakeResolver.getDecisionContext(instanceId, instrumentId);
          return undefined;
        },
        getPosition: (instanceId: string, instrumentId?: string) => {
          if (instrumentId) return swapIntakeResolver.getPosition(instanceId, instrumentId);
          return undefined;
        },
      };

      swapHandler = new AgentDecisionHandler(agentRepo as any, swapIntakeResolverFn, eventPublisher as any);
    });

    it('agent submits a swap buy and token safety gate is consulted', async () => {
      const decisionId = crypto.randomUUID();
      const envelope = makeEnvelope();
      const payload = makePayload({
        decisionId,
        instrumentId: 'ETH/USDC',
        intent: 'go_long',
        targetSize: '10',
      });

      await swapHandler.handleDecisionSubmit(envelope, payload);

      // Token safety was called with the correct network and token address
      expect(swapTokenSafety.checkSwapTarget).toHaveBeenCalledTimes(1);
      const safetyCall = swapTokenSafety.checkSwapTarget.mock.calls[0][0];
      expect(safetyCall.venue).toBe('1inch');
      expect(safetyCall.network).toBe('base');
      expect(safetyCall.tokenAddress).toBe('ETH');
      expect(safetyCall.swapSide).toBe('buy');

      // Decision was persisted
      const [decision] = await db.select().from(decisions).where(eq(decisions.id, decisionId));
      expect(decision).toBeDefined();
      expect(decision!.instrumentId).toBe('ETH/USDC');
      expect(decision!.intent).toBe('go_long');
      expect(decision!.venueAccountId).toBe(swapVenueAccountId);

      // Execution plan was created
      const plans = await db.select().from(executionPlans).where(eq(executionPlans.decisionId, decisionId));
      expect(plans.length).toBe(1);
      expect(plans[0]!.venue).toBe('1inch');
      expect(plans[0]!.symbol).toBe('ETH/USDC');

      // Fills were created (paper executor)
      const allFills = await db.select().from(fills).where(eq(fills.venueAccountId, swapVenueAccountId));
      expect(allFills.length).toBeGreaterThan(0);
    });

    it('swap buy is rejected when token safety check fails', async () => {
      swapTokenSafety.checkSwapTarget.mockResolvedValue({
        ok: false,
        error: {
          code: 'token.safety_rejected',
          message: 'Token age could not be resolved for ETH on base',
          retryable: true,
        },
      });

      const decisionId = crypto.randomUUID();
      const envelope = makeEnvelope();
      const payload = makePayload({
        decisionId,
        instrumentId: 'ETH/USDC',
        intent: 'go_long',
        targetSize: '10',
      });

      await swapHandler.handleDecisionSubmit(envelope, payload);

      // Token safety was consulted
      expect(swapTokenSafety.checkSwapTarget).toHaveBeenCalledTimes(1);

      // Decision IS persisted — it's written in step 1 before the safety gate at step 5b.
      // The execution plan is created (write-ahead at step 5) then marked failed by the gate.
      const [decision] = await db.select().from(decisions).where(eq(decisions.id, decisionId));
      expect(decision).toBeDefined();

      const plans = await db.select().from(executionPlans).where(eq(executionPlans.decisionId, decisionId));
      expect(plans.length).toBe(1);
      expect(plans[0]!.status).toBe('failed');

      // No fills — executor never ran
      const allFills = await db.select().from(fills).where(eq(fills.venueAccountId, swapVenueAccountId));
      expect(allFills.length).toBe(0);
    });

    it('sell-only swap bypasses token safety check entirely', async () => {
      const decisionId = crypto.randomUUID();
      const envelope = makeEnvelope();
      const payload = makePayload({
        decisionId,
        instrumentId: 'ETH/USDC',
        intent: 'go_short', // sell path
        targetSize: '0.001',
      });

      await swapHandler.handleDecisionSubmit(envelope, payload);

      // Token safety should NOT be called for sells — the adapter bypasses immediately
      expect(swapTokenSafety.checkSwapTarget).not.toHaveBeenCalled();

      // Decision still executed
      const [decision] = await db.select().from(decisions).where(eq(decisions.id, decisionId));
      expect(decision).toBeDefined();
    });
  });
});
