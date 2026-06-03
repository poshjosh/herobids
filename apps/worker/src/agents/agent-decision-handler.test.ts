import { describe, it, expect, vi } from 'vitest';
import { AgentDecisionHandler } from './agent-decision-handler.js';

describe('AgentDecisionHandler', () => {
  it('rejects decisions whose instrument does not match the linked instance symbol', async () => {
    const agentRepo = {
      getActiveLink: vi.fn().mockResolvedValue({ tradingInstanceId: 'inst-1' }),
      getAgent: vi.fn().mockResolvedValue({ id: 'agent-1', status: 'active' }),
      getSessionForAgentAndInstance: vi.fn().mockResolvedValue({ id: 'sess-1', status: 'running' }),
    };

    const intakeResolver = {
      getIntakeDeps: vi.fn().mockReturnValue({ symbol: 'BTC/USD:USD' }),
      getDecisionContext: vi.fn().mockReturnValue({
        snapshot: { symbol: 'BTC/USD:USD', price: '100', timestamp: '2026-06-03T00:00:00.000Z' },
        position: null,
        referenceMark: { price: '100', source: 'last_price' },
        strategyParams: {},
      }),
      getPosition: vi.fn().mockReturnValue({
        symbol: 'BTC/USD:USD',
        side: 'flat',
        size: { toString: () => '0' },
        entryPrice: { toString: () => '0' },
        realizedPnl: { toString: () => '0' },
      }),
    };

    const eventPublisher = {
      emitDecisionRejected: vi.fn().mockResolvedValue(undefined),
    };

    const handler = new AgentDecisionHandler(
      agentRepo as any,
      intakeResolver as any,
      eventPublisher as any,
    );

    await handler.handleDecisionSubmit(
      {
        schemaVersion: 'v1',
        messageId: 'msg-1',
        correlationId: 'corr-1',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        tradingInstanceId: 'inst-1',
        type: 'agent.decision.submit',
        createdAt: '2026-06-03T00:00:00.000Z',
        payload: {},
      },
      {
        decisionId: 'dec-1',
        instrumentId: 'ETH/USD:USD',
        intent: 'go_long',
        targetSize: '1',
        rationaleSummary: 'wrong instrument',
      },
    );

    expect(eventPublisher.emitDecisionRejected).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        decisionId: 'dec-1',
        code: 'instrument_mismatch',
        details: {
          expectedInstrumentId: 'BTC/USD:USD',
          receivedInstrumentId: 'ETH/USD:USD',
        },
      }),
    );
  });
});