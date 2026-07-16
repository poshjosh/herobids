import { describe, expect, it, vi } from 'vitest';
import { AgentReconnectHandler } from './agent-reconnect-handler.js';
import { AGENT_STREAM_MAXLEN } from '@herobids/domain';

describe('AgentReconnectHandler', () => {
  function makeDeps() {
    const redis = {
      xrange: vi.fn().mockResolvedValue([]),
      xadd: vi.fn().mockResolvedValue('1-0'),
    };

    const agentRepo = {
      updateSession: vi.fn().mockResolvedValue(undefined),
    };

    const eventPublisher = {
      emitInstanceStatus: vi.fn().mockResolvedValue(undefined),
      emitContextSnapshot: vi.fn().mockResolvedValue(undefined),
    };

    return { redis, agentRepo, eventPublisher };
  }

  it('awaits an async snapshot resolver and emits the recovered snapshot', async () => {
    const { redis, agentRepo, eventPublisher } = makeDeps();
    const snapshotResolver = {
      resolveSnapshot: vi.fn().mockResolvedValue({
        snapshotId: 'snap-1',
        symbol: 'BTC/USD:USD',
        price: '50000',
        timestamp: '2026-06-14T00:00:00.000Z',
        position: null,
        referenceMark: { price: '50000', source: 'oracle' },
        strategyParams: {},
        executionMode: 'paper',
        guardrails: {},
      }),
    };

    const handler = new AgentReconnectHandler(
      redis as any,
      agentRepo as any,
      eventPublisher as any,
      undefined,
      snapshotResolver,
    );

    await handler.handleReconnect('agent-1', 'sess-1');

    expect(snapshotResolver.resolveSnapshot).toHaveBeenCalledWith('agent-1');
    expect(eventPublisher.emitContextSnapshot).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      snapshotId: 'snap-1',
      symbol: 'BTC/USD:USD',
    }));
  });

  it('replays high-value events with their original messageId preserved', async () => {
    const { redis, agentRepo, eventPublisher } = makeDeps();
    redis.xrange.mockResolvedValue([
      ['1-0', [
        'envelope', JSON.stringify({
          messageId: 'msg-1',
          type: 'instance.plan.status',
          payload: { planId: 'plan-1' },
        }),
      ]],
    ]);

    const handler = new AgentReconnectHandler(
      redis as any,
      agentRepo as any,
      eventPublisher as any,
    );

    await handler.handleReconnect('agent-1', 'sess-1');

    expect(redis.xadd).toHaveBeenCalledTimes(1);
    const replayEnvelope = JSON.parse((redis.xadd.mock.calls[0] as string[])[6]) as { messageId: string; type: string };
    expect(replayEnvelope).toMatchObject({
      messageId: 'msg-1',
      type: 'instance.plan.status',
    });
    expect(redis.xadd).toHaveBeenCalledWith(
      'agent:outbound:agent-1',
      'MAXLEN', '~', AGENT_STREAM_MAXLEN,
      '*',
      'envelope', expect.any(String),
      'is_replay', '1',
    );
  });

  it('does not replay entries that are already replay copies', async () => {
    const { redis, agentRepo, eventPublisher } = makeDeps();
    redis.xrange.mockResolvedValue([
      ['1-0', [
        'envelope', JSON.stringify({
          messageId: 'msg-1',
          type: 'instance.plan.status',
          payload: { planId: 'plan-1' },
        }),
        'is_replay', '1',
      ]],
    ]);

    const handler = new AgentReconnectHandler(
      redis as any,
      agentRepo as any,
      eventPublisher as any,
    );

    await handler.handleReconnect('agent-1', 'sess-1');

    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('emits multiple context snapshots when resolveSnapshots returns several instruments', async () => {
    const { redis, agentRepo, eventPublisher } = makeDeps();
    const snapshotResolver = {
      resolveSnapshot: vi.fn().mockResolvedValue(undefined),
      resolveSnapshots: vi.fn().mockResolvedValue([
        {
          snapshotId: 'snap-btc',
          symbol: 'BTC/USD:USD',
          price: '50000',
          timestamp: '2026-06-14T00:00:00.000Z',
          position: { side: 'long', size: '0.5', entryPrice: '48000', realizedPnl: '100' },
          referenceMark: { price: '50000', source: 'oracle' },
          strategyParams: {},
          executionMode: 'paper',
          guardrails: {},
        },
        {
          snapshotId: 'snap-eth',
          symbol: 'ETH/USD:USD',
          price: '3200',
          timestamp: '2026-06-14T00:00:00.000Z',
          position: { side: 'short', size: '5', entryPrice: '3300', realizedPnl: '-50' },
          referenceMark: { price: '3200', source: 'oracle' },
          strategyParams: {},
          executionMode: 'paper',
          guardrails: {},
        },
      ]),
    };

    const handler = new AgentReconnectHandler(
      redis as any,
      agentRepo as any,
      eventPublisher as any,
      undefined,
      snapshotResolver,
    );

    await handler.handleReconnect('agent-1', 'sess-1');

    expect(snapshotResolver.resolveSnapshots).toHaveBeenCalledWith('agent-1');
    expect(snapshotResolver.resolveSnapshot).not.toHaveBeenCalled();
    expect(eventPublisher.emitContextSnapshot).toHaveBeenCalledTimes(2);
    expect(eventPublisher.emitContextSnapshot).toHaveBeenCalledWith('agent-1', expect.objectContaining({ symbol: 'BTC/USD:USD' }));
    expect(eventPublisher.emitContextSnapshot).toHaveBeenCalledWith('agent-1', expect.objectContaining({ symbol: 'ETH/USD:USD' }));
  });

  it('falls back to resolveSnapshot when resolveSnapshots returns empty array', async () => {
    const { redis, agentRepo, eventPublisher } = makeDeps();
    const snapshotResolver = {
      resolveSnapshot: vi.fn().mockResolvedValue({
        snapshotId: 'snap-fallback',
        symbol: 'BTC/USD:USD',
        price: '50000',
        timestamp: '2026-06-14T00:00:00.000Z',
        position: null,
        referenceMark: { price: '50000', source: 'oracle' },
        strategyParams: {},
        executionMode: 'paper',
        guardrails: {},
      }),
      resolveSnapshots: vi.fn().mockResolvedValue([]),
    };

    const handler = new AgentReconnectHandler(
      redis as any,
      agentRepo as any,
      eventPublisher as any,
      undefined,
      snapshotResolver,
    );

    await handler.handleReconnect('agent-1', 'sess-1');

    expect(snapshotResolver.resolveSnapshot).toHaveBeenCalledWith('agent-1');
    expect(eventPublisher.emitContextSnapshot).toHaveBeenCalledWith('agent-1', expect.objectContaining({ snapshotId: 'snap-fallback' }));
  });
});