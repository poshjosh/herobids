/**
 * Integration tests for preset tool broker mediation.
 *
 * Verifies:
 *  1. Reply list mechanism: LPUSH + EXPIRE + BLPOP works with real Redis
 *  2. Tool broker-mediation path: publishes request and BLPOPs reply via real Redis
 *  3. Broker handler end-to-end: processInbound → handler → reply on Redis list
 *  4. End-to-end: tool publishes request, simulated broker processes, tool receives reply
 *
 * Requires REDIS_URL.  Skipped otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Redis from 'ioredis';
import { AGENT_MESSAGE_TYPES } from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';
import type { AgentDecisionHandler } from '../../agents/agent-decision-handler.js';
import type { AgentSessionManager } from '../../agents/agent-session-manager.js';
import { InstanceEventPublisher } from '../../agents/instance-event-publisher.js';
import { AgentMessageBroker } from '../../agents/agent-message-broker.js';
import {
  setAssessmentRequestPort,
  clearAssessmentRequestPort,
  assessStrategyPresetTool,
} from '../../tools/assess-strategy-preset.js';
import { createToolRegistry } from '../../tools/index.js';
import crypto from 'node:crypto';

// ── Skip gate ───────────────────────────────────────────────────────────────

const SKIP = !process.env['REDIS_URL'];
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Return a mock ToolContext.redis shaped to satisfy the narrow ToolContext interface. */
function mockRedisDefaults(overrides: Record<string, unknown> = {}) {
  return {
    hset: vi.fn(),
    hget: vi.fn(),
    hgetall: vi.fn().mockResolvedValue(null),
    hdel: vi.fn(),
    publish: vi.fn(),
    blpop: vi.fn(),
    smembers: vi.fn().mockResolvedValue([]),
    sadd: vi.fn(),
    srem: vi.fn(),
    expire: vi.fn(),
    ...overrides,
  };
}

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname || 'localhost',
    port: parseInt(u.port || '6379', 10),
    ...(u.password && { password: decodeURIComponent(u.password) }),
    ...(u.username && { username: decodeURIComponent(u.username) }),
  };
}

function makeAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-agent',
    userId: 'test-user',
    name: 'Test Agent',
    toolPolicy: null,
    executionMode: 'paper',
    capital: null,
    unifiedConfig: null,
    maxBots: null,
    modelPolicy: null,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)('Preset tool broker integration', () => {
  let redis: Redis;
  let eventPublisher: InstanceEventPublisher;

  beforeAll(async () => {
    redis = new Redis(parseRedisUrl(REDIS_URL));
    eventPublisher = new InstanceEventPublisher(redis);
  });

  afterAll(async () => {
    clearAssessmentRequestPort();
    await redis?.quit();
  });

  // ── Test 1: Reply list mechanism ───────────────────────────────────────

  it('LPUSH → BLPOP → EXPIRE round-trip with real Redis', async () => {
    const requestMessageId = crypto.randomUUID();
    const replyKey = `agent:preset:reply:${requestMessageId}`;

    const testResult = {
      success: true,
      data: {
        assessedInstrumentCount: 1,
        results: [{ symbol: 'BTC', success: true }],
      },
    };

    // Publish via InstanceEventPublisher (LPUSH + EXPIRE)
    await eventPublisher.publishPresetToolReply(requestMessageId, testResult);

    // Verify EXPIRE was set (TTL should be > 0 and ≤ 60s)
    const ttlBefore = await redis.ttl(replyKey);
    expect(ttlBefore).toBeGreaterThan(0);
    expect(ttlBefore).toBeLessThanOrEqual(60);

    // BLPOP to retrieve (simulating what the agent tool does)
    const reply = await redis.blpop(replyKey, 5);
    expect(reply).not.toBeNull();
    expect(reply![0]).toBe(replyKey);

    const parsed = JSON.parse(reply![1]) as { result: typeof testResult };
    expect(parsed.result).toEqual(testResult);

    // After BLPOP removed the last element, the key should be gone
    const ttl = await redis.ttl(replyKey);
    expect(ttl).toBe(-2); // key does not exist
  });

  // ── Test 2: Tool broker-mediation path with real Redis ─────────────────

  it('assess_strategy_preset broker-mediated path publishes and BLPOPs via real Redis', async () => {
    const registry = createToolRegistry();
    const tool = registry.get('assess_strategy_preset');
    expect(tool).toBeDefined();

    const publishToInbound = vi.fn().mockResolvedValue(undefined);

    const ctx = {
      agentId: 'test-agent-int',
      sessionId: 'test-session-int',
      phase: 'scout' as const,
      executionMode: 'paper' as const,
      authorizationMode: 'direct' as const,
      redis: mockRedisDefaults({
        blpop: (...args: Parameters<Redis['blpop']>) => redis.blpop(...args),
      }),
      publishToInbound,
      agentConfigOps: {
        getCurrentConfig: vi.fn().mockResolvedValue(null),
        persistConfig: vi.fn(),
        appendJournal: vi.fn(),
        notifyActorConfigUpdate: vi.fn(),
        getLlmTickCount: vi.fn().mockReturnValue(0),
      },
    };

    // port is null (not wired in agent container) → broker-mediated path
    // The tool will publish to inbound, then BLPOP from real Redis.
    // Since no broker is running, BLPOP will timeout after 30s.
    // We verify: (a) publishToInbound called with correct type, (b) BLPOP timed out.

    const resultPromise = tool!.execute(
      { symbols: ['ETH'], venueFamily: 'hyperliquid', instrumentKind: 'perp' },
      ctx,
    );

    // Give the tool time to call publishToInbound
    await vi.waitFor(() => {
      expect(publishToInbound).toHaveBeenCalled();
    }, { timeout: 2000 });

    // Verify publishToInbound was called with correct broker message type
    expect(publishToInbound).toHaveBeenCalledWith(
      AGENT_MESSAGE_TYPES.TOOL_ASSESS_STRATEGY_PRESET,
      expect.objectContaining({
        agentId: 'test-agent-int',
        sessionId: 'test-session-int',
        symbols: ['ETH'],
        venueFamily: 'hyperliquid',
        instrumentKind: 'perp',
        requestMessageId: expect.any(String),
      }),
    );

    // The call made it to BLPOP (30s timeout) — result will be a timeout error
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('broker.timeout');
    expect(result.error).toContain('timed out');
  }, 35_000);

  // ── Test 3: Broker handler end-to-end ──────────────────────────────────

  it('broker processInbound handles assess_strategy_preset and publishes reply to Redis list', async () => {
    // ── Wire the port with a mock so the tool uses the direct path ──
    const mockPort = {
      maxInstrumentsPerRequest: 3,
      requestAssessment: vi.fn(),
      requestBatchAssessment: vi.fn().mockResolvedValue({
        ok: true as const,
        data: [
          {
            kind: 'assessment_completed' as const,
            requestId: 'req-int-1',
            assessmentArtifactId: crypto.randomUUID(),
            canonicalIdentity: {
              instrumentKind: 'perp' as const,
              venueFamily: 'hyperliquid',
              styleTier: 'standard' as const,
              symbol: 'BTC',
            },
            artifact: {
              assessedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              currentMarketSummary: 'Bullish market structure in integration test',
              regimeSummary: 'Strong uptrend',
              scanHealthSummary: 'All scans clear',
              presetRankings: [
                {
                  presetKey: 'momentum',
                  presetBehaviorVersion: 'v1',
                  rank: 1,
                  score: 85,
                  scoreBand: 'A',
                  pros: ['Strong trend following'],
                  cons: ['Noisy in ranging markets'],
                  fitNotes: 'Best fit for current regime',
                },
              ],
              recommendedPreset: 'momentum',
              allowedPresets: ['momentum', 'mean_reversion'],
              confidence: 85,
              urgency: 'low' as const,
            },
          },
        ],
      }),
    };
    setAssessmentRequestPort(mockPort);

    // ── Mock AgentRepository for the broker's internal gates ──
    const mockAgentRepo = {
      isMessageDuplicate: vi.fn().mockResolvedValue(false),
      getAgent: vi.fn().mockResolvedValue(makeAgentRow()),
      getActiveSession: vi.fn().mockResolvedValue({ id: 'test-session', status: 'running' }),
      insertMessage: vi.fn().mockResolvedValue(undefined),
      markMessageProcessed: vi.fn().mockResolvedValue(undefined),
      getUnifiedConfig: vi.fn().mockResolvedValue(null),
    } as unknown as AgentRepository;

    // ── Construct the broker with properly typed mock handlers ──
    // decisionHandler and sessionManager are not used for preset tool messages,
    // but must satisfy the constructor types.
    const mockDecisionHandler = {
      handleDecisionSubmit: vi.fn(),
    } as AgentDecisionHandler;

    const mockSessionManager = {
      handleHeartbeat: vi.fn(),
      handlePauseRequest: vi.fn(),
      handleStopRequest: vi.fn(),
      handleRuntimeSessionEnd: vi.fn(),
    } as AgentSessionManager;

    const broker = new AgentMessageBroker(
      redis,
      mockAgentRepo,
      mockDecisionHandler,
      mockSessionManager,
      eventPublisher,
    );

    // ── Build a valid envelope ──
    const requestMessageId = crypto.randomUUID();
    const envelopeMessageId = crypto.randomUUID();
    const envelope = {
      schemaVersion: 'v1' as const,
      messageId: envelopeMessageId,
      correlationId: 'test-session',
      initiatorType: 'system' as const, // bypass session-ownership gate
      initiatorId: 'test-agent',
      agentId: 'test-agent',
      type: AGENT_MESSAGE_TYPES.TOOL_ASSESS_STRATEGY_PRESET,
      createdAt: new Date().toISOString(),
      payload: {
        agentId: 'test-agent',
        sessionId: 'test-session',
        symbols: ['BTC'],
        venueFamily: 'hyperliquid',
        instrumentKind: 'perp',
        requestMessageId,
      },
    };

    // ── Execute ──
    const result = await broker.processInbound(envelope);
    expect(result.accepted).toBe(true);

    // ── Verify message persistence ──
    expect(mockAgentRepo.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: envelopeMessageId,
        type: AGENT_MESSAGE_TYPES.TOOL_ASSESS_STRATEGY_PRESET,
      }),
    );
    expect(mockAgentRepo.markMessageProcessed).toHaveBeenCalledWith(envelopeMessageId, 'processed');

    // ── Verify the broker published a reply to the Redis list ──
    const replyKey = `agent:preset:reply:${requestMessageId}`;
    const reply = await redis.blpop(replyKey, 5);
    expect(reply).not.toBeNull();
    expect(reply![0]).toBe(replyKey);

    const parsed = JSON.parse(reply![1]) as {
      result: { success: boolean; data?: Record<string, unknown> };
    };
    expect(parsed.result.success).toBe(true);
    expect(parsed.result.data).toBeDefined();

    const data = parsed.result.data!;
    expect(data.assessedInstrumentCount).toBe(1);
    expect(data.requestedInstrumentCount).toBe(1);

    const results = data.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(true);
    expect(results[0]?.symbol).toBe('BTC');
    expect(results[0]?.canonicalIdentity).toEqual({
      instrumentKind: 'perp',
      venueFamily: 'hyperliquid',
      styleTier: 'standard',
      symbol: 'BTC',
    });

    // ── Verify the mock port was called ──
    expect(mockPort.requestBatchAssessment).toHaveBeenCalledTimes(1);
    const batchCall = mockPort.requestBatchAssessment.mock.calls[0]?.[0];
    expect(batchCall).toHaveLength(1);
    expect(batchCall?.[0]).toMatchObject({
      agentId: 'test-agent',
      symbol: 'BTC',
      venueFamily: 'hyperliquid',
      instrumentKind: 'perp',
      styleTier: 'standard',
    });

  });

  // ── Test 4: End-to-end happy-path ─────────────────────────────────────

  it('end-to-end: tool publishes request and receives broker reply via Redis', async () => {
    // Port is NOT wired — the tool will use the broker-mediation path
    clearAssessmentRequestPort();

    const mockPort = {
      maxInstrumentsPerRequest: 3,
      requestBatchAssessment: vi.fn().mockResolvedValue({
        ok: true as const,
        data: [
          {
            kind: 'assessment_completed' as const,
            requestId: 'test-req-e2e',
            assessmentArtifactId: crypto.randomUUID(),
            canonicalIdentity: {
              instrumentKind: 'perp' as const,
              venueFamily: 'hyperliquid' as const,
              styleTier: 'standard' as const,
              symbol: 'BTC' as const,
            },
            artifact: {
              assessedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              currentMarketSummary: 'Bullish momentum in e2e test',
              regimeSummary: 'Trending up',
              scanHealthSummary: 'All scans healthy',
              presetRankings: [
                {
                  presetKey: 'standard',
                  presetBehaviorVersion: 'v1',
                  rank: 1,
                  score: 85,
                  scoreBand: 'A',
                  pros: ['Well-balanced'],
                  cons: ['None'],
                  fitNotes: 'Good fit',
                },
              ],
              recommendedPreset: 'standard',
              allowedPresets: ['standard'],
              confidence: 85,
              urgency: 'low' as const,
            },
          },
        ],
      }),
    };

    // publishToInbound simulates the broker: wires the port, calls the tool
    // (which will use the direct path since port is wired), then publishes
    // the reply to Redis so the agent-side BLPOP can pick it up.
    const publishToInbound = vi.fn().mockImplementation(
      async (_type: string, payload: Record<string, unknown>) => {
        // Wire the port so the "broker-side" tool call uses the direct path
        setAssessmentRequestPort(mockPort);
        try {
          const brokerResult = await assessStrategyPresetTool.execute(payload, {
            agentId: 'test-agent-e2e',
            sessionId: 'test-session-e2e',
            phase: 'scout',
            executionMode: 'paper',
            authorizationMode: 'direct',
            redis: mockRedisDefaults(),
            publishToInbound: vi.fn(),
            agentConfigOps: {
              getCurrentConfig: vi.fn().mockResolvedValue({
                allowedPresets: { styleTier: 'standard' },
              }),
              appendJournal: vi.fn(),
            },
          });
          // Publish reply to Redis list — agent-side BLPOP will pick it up
          await eventPublisher.publishPresetToolReply(
            payload.requestMessageId as string,
            brokerResult as Record<string, unknown>,
          );
        } finally {
          clearAssessmentRequestPort();
        }
      },
    );

    const ctx = {
      agentId: 'test-agent-e2e',
      sessionId: 'test-session-e2e',
      phase: 'scout' as const,
      executionMode: 'paper' as const,
      authorizationMode: 'direct' as const,
      redis: mockRedisDefaults({
        blpop: (...args: Parameters<Redis['blpop']>) => redis.blpop(...args),
      }),
      publishToInbound,
      agentConfigOps: {
        getCurrentConfig: vi.fn().mockResolvedValue({
          allowedPresets: { styleTier: 'standard' },
        }),
        appendJournal: vi.fn(),
      },
    };

    // Execute the tool — port is null, so it enters broker-mediation path:
    // publishToInbound → BLPOP reply
    const result = await assessStrategyPresetTool.execute(
      { symbols: ['BTC'], venueFamily: 'hyperliquid', instrumentKind: 'perp' },
      ctx,
    );

    // Verify full round-trip succeeded
    expect(result.success).toBe(true);
    expect(publishToInbound).toHaveBeenCalledTimes(1);
    expect(publishToInbound).toHaveBeenCalledWith(
      AGENT_MESSAGE_TYPES.TOOL_ASSESS_STRATEGY_PRESET,
      expect.objectContaining({
        agentId: 'test-agent-e2e',
        symbols: ['BTC'],
        venueFamily: 'hyperliquid',
        requestMessageId: expect.any(String),
      }),
    );

    // Verify the mock port was called on the broker side
    expect(mockPort.requestBatchAssessment).toHaveBeenCalledTimes(1);
  });

  // ── Cleanup leaked keys between tests ──

  afterEach(async () => {
    // Reset port in case a test failed before cleanup
    clearAssessmentRequestPort();
    // Clean up any leaked reply keys between tests
    const keys = await redis.keys('agent:preset:reply:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });
});
