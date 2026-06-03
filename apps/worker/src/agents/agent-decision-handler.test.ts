import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@herobids/engine', async () => {
  const actual = await vi.importActual<typeof import('@herobids/engine')>('@herobids/engine');
  return {
    ...actual,
    submitDecisionForExecution: vi.fn(),
  };
});

import { submitDecisionForExecution, DecisionContextHashMismatchError } from '@herobids/engine';
import { AgentDecisionHandler } from './agent-decision-handler.js';

describe('AgentDecisionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeHandler() {
    const markSource = {
      fetchMark: vi.fn().mockResolvedValue({ ok: true, data: { price: '101', source: 'oracle', stale: false } }),
    };

    const agentRepo = {
      getActiveLink: vi.fn().mockResolvedValue({ tradingInstanceId: 'inst-1' }),
      getAgent: vi.fn().mockResolvedValue({ id: 'agent-1', status: 'active' }),
      getSessionForAgentAndInstance: vi.fn().mockResolvedValue({ id: 'sess-1', status: 'running' }),
    };

    const intakeResolver = {
      getIntakeDeps: vi.fn().mockReturnValue({ symbol: 'BTC/USD:USD', markSource }),
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
      emitDecisionAccepted: vi.fn().mockResolvedValue(undefined),
      emitDecisionRejected: vi.fn().mockResolvedValue(undefined),
      emitPlanStatus: vi.fn().mockResolvedValue(undefined),
      emitGuardrailTriggered: vi.fn().mockResolvedValue(undefined),
      emitExecutionResult: vi.fn().mockResolvedValue(undefined),
    };

    const handler = new AgentDecisionHandler(agentRepo as any, intakeResolver as any, eventPublisher as any);
    return { handler, eventPublisher, markSource };
  }

  it('rejects decisions whose instrument does not match the linked instance symbol', async () => {
    const { handler, eventPublisher } = makeHandler();

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

  it('maps canonical hash mismatches to a stable rejection code', async () => {
    const { handler, eventPublisher } = makeHandler();

    vi.mocked(submitDecisionForExecution).mockRejectedValueOnce(
      new DecisionContextHashMismatchError('expected-hash', 'supplied-hash'),
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
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: '1',
        rationaleSummary: 'hash mismatch',
        contextHash: 'supplied-hash',
      },
    );

    expect(eventPublisher.emitDecisionRejected).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        decisionId: 'dec-1',
        code: 'context_hash_mismatch',
        details: {
          expectedHash: 'expected-hash',
          suppliedHash: 'supplied-hash',
        },
      }),
    );
  });

  it('still maps unexpected intake failures to execution_error', async () => {
    const { handler, eventPublisher } = makeHandler();

    vi.mocked(submitDecisionForExecution).mockRejectedValueOnce(new Error('Engine crash'));

    await handler.handleDecisionSubmit(
      {
        schemaVersion: 'v1',
        messageId: 'msg-2',
        correlationId: 'corr-2',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        tradingInstanceId: 'inst-1',
        type: 'agent.decision.submit',
        createdAt: '2026-06-03T00:00:00.000Z',
        payload: {},
      },
      {
        decisionId: 'dec-2',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: '1',
        rationaleSummary: 'engine failure',
      },
    );

    expect(eventPublisher.emitDecisionRejected).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        decisionId: 'dec-2',
        code: 'execution_error',
      }),
    );
  });

  it('swallows post-commit publication failures after successful intake', async () => {
    const { handler, eventPublisher } = makeHandler();

    vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
      decision: {
        id: 'dec-4',
        tradingInstanceId: 'inst-1',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: { toString: () => '1' },
        timestamp: '2026-06-03T00:00:00.000Z',
      } as any,
      riskRejected: false,
      position: {
        symbol: 'BTC/USD:USD',
        side: 'flat',
        size: { toString: () => '0' },
        entryPrice: { toString: () => '0' },
        realizedPnl: { toString: () => '0' },
      } as any,
      executionFailed: false,
    });

    (eventPublisher.emitDecisionAccepted as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(handler.handleDecisionSubmit(
      {
        schemaVersion: 'v1',
        messageId: 'msg-4',
        correlationId: 'corr-4',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        tradingInstanceId: 'inst-1',
        type: 'agent.decision.submit',
        createdAt: '2026-06-03T00:00:00.000Z',
        payload: {},
      },
      {
        decisionId: 'dec-4',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: '1',
        rationaleSummary: 'publish failure',
      },
    )).resolves.toBeUndefined();

    expect(eventPublisher.emitDecisionRejected).not.toHaveBeenCalled();
  });

  it('submits the exact resolved context without rewriting the reference mark', async () => {
    const { handler, markSource } = makeHandler();

    vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
      decision: {
        id: 'dec-3',
        tradingInstanceId: 'inst-1',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: { toString: () => '1' },
        timestamp: '2026-06-03T00:00:00.000Z',
      } as any,
      riskRejected: false,
      position: {
        symbol: 'BTC/USD:USD',
        side: 'flat',
        size: { toString: () => '0' },
        entryPrice: { toString: () => '0' },
        realizedPnl: { toString: () => '0' },
      } as any,
      executionFailed: false,
    });

    await handler.handleDecisionSubmit(
      {
        schemaVersion: 'v1',
        messageId: 'msg-3',
        correlationId: 'corr-3',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        tradingInstanceId: 'inst-1',
        type: 'agent.decision.submit',
        createdAt: '2026-06-03T00:00:00.000Z',
        payload: {},
      },
      {
        decisionId: 'dec-3',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: '1',
        rationaleSummary: 'exact context',
      },
    );

    expect(markSource.fetchMark).not.toHaveBeenCalled();
    expect(vi.mocked(submitDecisionForExecution)).toHaveBeenCalledWith(
      expect.objectContaining({ contextHash: undefined }),
      expect.objectContaining({
        referenceMark: { price: '100', source: 'last_price' },
      }),
      expect.anything(),
      expect.anything(),
    );
  });
});