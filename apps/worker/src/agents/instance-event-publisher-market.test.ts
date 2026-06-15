import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InstanceEventPublisher } from './instance-event-publisher.js';
import { MARKET_MONITOR_MESSAGE_TYPES } from '@herobids/domain';
import type {
  MarketWatchTriggeredPayload,
  MarketDiscoveryDetectedPayload,
  MarketRegimeChangedPayload,
  AgentMarketWakePayload,
} from '@herobids/domain';

function makeRedisMock() {
  return {
    xadd: vi.fn().mockResolvedValue('1-0'),
  } as any;
}

// Helpers to parse what was published
function parsePublished(xaddCall: unknown[]): { streamKey: string; type: string; payload: Record<string, unknown> } {
  const [streamKey, , , envelopeJson] = xaddCall as [string, string, string, string];
  const envelope = JSON.parse(envelopeJson) as { type: string; payload: Record<string, unknown> };
  return { streamKey, type: envelope.type, payload: envelope.payload };
}

describe('InstanceEventPublisher — market monitor helpers', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let publisher: InstanceEventPublisher;

  beforeEach(() => {
    redis = makeRedisMock();
    publisher = new InstanceEventPublisher(redis);
  });

  // -------------------------------------------------------------------------
  // emitMarketWatchTriggered
  // -------------------------------------------------------------------------

  describe('emitMarketWatchTriggered', () => {
    const payload: MarketWatchTriggeredPayload = {
      eventId: 'evt-1',
      monitorType: 'watch_threshold',
      watchId: 'watch-1',
      symbol: 'SOL',
      chain: 'solana',
      condition: 'above',
      thresholdPrice: 200,
      currentPrice: 204,
      priceSource: 'snapshot',
      stale: false,
      triggeredAt: '2026-06-10T12:00:00.000Z',
    };

    it('publishes to the correct stream key', async () => {
      await publisher.emitMarketWatchTriggered('agent-abc', payload);
      const { streamKey } = parsePublished(redis.xadd.mock.calls[0]);
      expect(streamKey).toBe('agent:outbound:agent-abc');
    });

    it('sets message type to market.watch.triggered', async () => {
      await publisher.emitMarketWatchTriggered('agent-abc', payload);
      const { type } = parsePublished(redis.xadd.mock.calls[0]);
      expect(type).toBe(MARKET_MONITOR_MESSAGE_TYPES.WATCH_TRIGGERED);
    });

    it('includes the full payload in the envelope', async () => {
      await publisher.emitMarketWatchTriggered('agent-abc', payload);
      const { payload: published } = parsePublished(redis.xadd.mock.calls[0]);
      expect(published['symbol']).toBe('SOL');
      expect(published['currentPrice']).toBe(204);
      expect(published['stale']).toBe(false);
    });

    it('sets initiatorType to system', async () => {
      await publisher.emitMarketWatchTriggered('agent-abc', payload);
      const [, , , envelopeJson] = redis.xadd.mock.calls[0] as [string, string, string, string];
      const envelope = JSON.parse(envelopeJson) as { initiatorType: string };
      expect(envelope.initiatorType).toBe('system');
    });

    it('sets agentId on the envelope', async () => {
      await publisher.emitMarketWatchTriggered('agent-abc', payload);
      const [, , , envelopeJson] = redis.xadd.mock.calls[0] as [string, string, string, string];
      const envelope = JSON.parse(envelopeJson) as { agentId: string };
      expect(envelope.agentId).toBe('agent-abc');
    });

    it('does not throw when Redis xadd fails (absorbs error)', async () => {
      redis.xadd.mockRejectedValueOnce(new Error('connection lost'));
      await expect(publisher.emitMarketWatchTriggered('agent-abc', payload)).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // emitMarketDiscoveryDetected
  // -------------------------------------------------------------------------

  describe('emitMarketDiscoveryDetected', () => {
    const payload: MarketDiscoveryDetectedPayload = {
      eventId: 'evt-2',
      monitorType: 'discovery_delta',
      symbol: 'WIF',
      network: 'solana',
      address: '0xabc',
      reason: 'entered_top_set',
      detectedAt: '2026-06-10T12:00:00.000Z',
    };

    it('publishes to the correct stream key', async () => {
      await publisher.emitMarketDiscoveryDetected('agent-xyz', payload);
      const { streamKey } = parsePublished(redis.xadd.mock.calls[0]);
      expect(streamKey).toBe('agent:outbound:agent-xyz');
    });

    it('sets message type to market.discovery.detected', async () => {
      await publisher.emitMarketDiscoveryDetected('agent-xyz', payload);
      const { type } = parsePublished(redis.xadd.mock.calls[0]);
      expect(type).toBe(MARKET_MONITOR_MESSAGE_TYPES.DISCOVERY_DETECTED);
    });

    it('includes symbol and reason in payload', async () => {
      await publisher.emitMarketDiscoveryDetected('agent-xyz', payload);
      const { payload: published } = parsePublished(redis.xadd.mock.calls[0]);
      expect(published['symbol']).toBe('WIF');
      expect(published['reason']).toBe('entered_top_set');
    });
  });

  // -------------------------------------------------------------------------
  // emitMarketRegimeChanged
  // -------------------------------------------------------------------------

  describe('emitMarketRegimeChanged', () => {
    const payload: MarketRegimeChangedPayload = {
      eventId: 'evt-3',
      monitorType: 'regime_change',
      benchmarkSymbol: 'BTC',
      previousState: 'favorable',
      currentState: 'unfavorable',
      changedAt: '2026-06-10T12:36:00.000Z',
    };

    it('publishes to the correct stream key', async () => {
      await publisher.emitMarketRegimeChanged('agent-1', payload);
      const { streamKey } = parsePublished(redis.xadd.mock.calls[0]);
      expect(streamKey).toBe('agent:outbound:agent-1');
    });

    it('sets message type to market.regime.changed', async () => {
      await publisher.emitMarketRegimeChanged('agent-1', payload);
      const { type } = parsePublished(redis.xadd.mock.calls[0]);
      expect(type).toBe(MARKET_MONITOR_MESSAGE_TYPES.REGIME_CHANGED);
    });

    it('includes benchmarkSymbol in payload', async () => {
      await publisher.emitMarketRegimeChanged('agent-1', payload);
      const { payload: published } = parsePublished(redis.xadd.mock.calls[0]);
      expect(published['benchmarkSymbol']).toBe('BTC');
      expect(published['previousState']).toBe('favorable');
      expect(published['currentState']).toBe('unfavorable');
    });
  });

  // -------------------------------------------------------------------------
  // emitAgentMarketWake
  // -------------------------------------------------------------------------

  describe('emitAgentMarketWake', () => {
    const payload: AgentMarketWakePayload = {
      wakeId: 'wake-1',
      reason: 'SOL crossed above 200',
      eventIds: ['evt-1', 'evt-2'],
      priority: 'normal',
      requestedAt: '2026-06-10T12:36:02.000Z',
      source: 'watch_threshold',
      context: { symbol: 'SOL', chain: 'solana', thresholdPrice: 200, currentPrice: 204.5, stale: false, watchId: 'w-1', triggeredAt: '2026-06-10T12:36:00.000Z' },
    };

    it('publishes to the correct stream key', async () => {
      await publisher.emitAgentMarketWake('agent-1', payload);
      const { streamKey } = parsePublished(redis.xadd.mock.calls[0]);
      expect(streamKey).toBe('agent:outbound:agent-1');
    });

    it('sets message type to agent.market.wake', async () => {
      await publisher.emitAgentMarketWake('agent-1', payload);
      const { type } = parsePublished(redis.xadd.mock.calls[0]);
      expect(type).toBe(MARKET_MONITOR_MESSAGE_TYPES.AGENT_WAKE);
    });

    it('includes eventIds, priority, source, and context in payload', async () => {
      await publisher.emitAgentMarketWake('agent-1', payload);
      const { payload: published } = parsePublished(redis.xadd.mock.calls[0]);
      expect(published['eventIds']).toEqual(['evt-1', 'evt-2']);
      expect(published['priority']).toBe('normal');
      expect(published['reason']).toBe('SOL crossed above 200');
      expect(published['source']).toBe('watch_threshold');
      expect((published['context'] as Record<string, unknown>)['symbol']).toBe('SOL');
    });

    it('each call generates a unique messageId', async () => {
      await publisher.emitAgentMarketWake('agent-1', payload);
      await publisher.emitAgentMarketWake('agent-1', payload);

      const envelope1 = JSON.parse((redis.xadd.mock.calls[0] as [string, string, string, string])[3]) as { messageId: string };
      const envelope2 = JSON.parse((redis.xadd.mock.calls[1] as [string, string, string, string])[3]) as { messageId: string };
      expect(envelope1.messageId).not.toBe(envelope2.messageId);
    });

    it('does not throw when Redis xadd fails', async () => {
      redis.xadd.mockRejectedValueOnce(new Error('stream overflow'));
      await expect(publisher.emitAgentMarketWake('agent-1', payload)).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Transport: all new methods reuse agent:outbound:{agentId} path
  // -------------------------------------------------------------------------

  it('all four new publish methods use the same outbound stream transport', async () => {
    const agentId = 'agent-transport-test';
    await publisher.emitMarketWatchTriggered(agentId, {
      eventId: 'e1', monitorType: 'watch_threshold', watchId: 'w1', symbol: 'A', chain: 'solana',
      condition: 'above', thresholdPrice: 1, currentPrice: 2, priceSource: 's', stale: false, triggeredAt: new Date().toISOString(),
    });
    await publisher.emitMarketDiscoveryDetected(agentId, {
      eventId: 'e2', monitorType: 'discovery_delta', symbol: 'B', network: 'solana', address: '0x1', reason: 'entered_top_set', detectedAt: new Date().toISOString(),
    });
    await publisher.emitMarketRegimeChanged(agentId, {
      eventId: 'e3', monitorType: 'regime_change', benchmarkSymbol: 'BTC', previousState: 'favorable', currentState: 'unfavorable', changedAt: new Date().toISOString(),
    });
    await publisher.emitAgentMarketWake(agentId, {
      wakeId: 'w1', reason: 'test', eventIds: [], priority: 'low', requestedAt: new Date().toISOString(), source: 'reminder', context: { reminderId: 'w1', message: 'test', scheduledBy: 'judge' },
    });

    const expectedStream = `agent:outbound:${agentId}`;
    for (const call of redis.xadd.mock.calls) {
      expect((call as [string])[0]).toBe(expectedStream);
    }
  });
});
