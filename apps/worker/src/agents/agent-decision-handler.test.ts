import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@herobids/engine', async () => {
  const actual = await vi.importActual<typeof import('@herobids/engine')>('@herobids/engine');
  return {
    ...actual,
    submitDecisionForExecution: vi.fn(),
  };
});

import { submitDecisionForExecution, DecisionContextHashMismatchError, DailyLossTracker } from '@herobids/engine';
import { price } from '@herobids/domain';
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
      getActiveLink: vi.fn().mockResolvedValue({ botId: 'inst-1' }),
      getAgent: vi.fn().mockResolvedValue({ id: 'agent-1', status: 'active' }),
      getSessionForAgentAndInstance: vi.fn().mockResolvedValue({ id: 'sess-1', status: 'running' }),
      isActiveSession: vi.fn().mockResolvedValue(true),
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
      publishDecisionReply: vi.fn().mockResolvedValue(undefined),
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
        botId: 'inst-1',
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
        botId: 'inst-1',
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
        botId: 'inst-1',
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

  it('accepts a decision when the agent row is missing but a running session exists', async () => {
    const { handler, eventPublisher } = makeHandler();

    vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
      decision: {
        id: 'dec-3',
        botId: 'inst-1',
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

    const agentRepo = (handler as unknown as { agentRepo: { getAgent: ReturnType<typeof vi.fn> } }).agentRepo;
    agentRepo.getAgent.mockResolvedValueOnce(null);

    await handler.handleDecisionSubmit(
      {
        schemaVersion: 'v1',
        messageId: 'msg-3',
        correlationId: 'corr-3',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        botId: 'inst-1',
        type: 'agent.decision.submit',
        createdAt: '2026-06-03T00:00:00.000Z',
        payload: {},
      },
      {
        decisionId: 'dec-3',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: '1',
        rationaleSummary: 'missing row but live session',
      },
    );

    expect(eventPublisher.emitDecisionRejected).not.toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ code: 'agent_paused' }),
    );
    expect(eventPublisher.emitDecisionAccepted).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ decisionId: 'dec-3' }),
    );
  });

  it('resolves execution context by agentId even when bot-facing ids differ', async () => {
    const { handler } = makeHandler();

    vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
      decision: {
        id: 'dec-agent-key',
        botId: 'ti-123',
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

    const intakeResolver = (handler as unknown as { intakeResolver: {
      getIntakeDeps: ReturnType<typeof vi.fn>;
      getDecisionContext: ReturnType<typeof vi.fn>;
      getPosition: ReturnType<typeof vi.fn>;
    } }).intakeResolver;

    await handler.handleDecisionSubmit(
      {
        schemaVersion: 'v1',
        messageId: 'msg-agent-key',
        correlationId: 'corr-agent-key',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        agentId: 'agent-1',
        botId: 'bot-99',
        tradingInstanceId: 'ti-123',
        type: 'agent.decision.submit',
        createdAt: '2026-06-03T00:00:00.000Z',
        payload: {},
      },
      {
        decisionId: 'dec-agent-key',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: '1',
        rationaleSummary: 'agent keyed routing',
      },
    );

    expect(intakeResolver.getIntakeDeps).toHaveBeenCalledWith('agent-1', 'BTC/USD:USD');
    expect(intakeResolver.getDecisionContext).toHaveBeenCalledWith('agent-1', 'BTC/USD:USD');
    expect(intakeResolver.getPosition).toHaveBeenCalledWith('agent-1', 'BTC/USD:USD');
  });

  it('swallows post-commit publication failures after successful intake', async () => {
    const { handler, eventPublisher } = makeHandler();

    vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
      decision: {
        id: 'dec-4',
        botId: 'inst-1',
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
        botId: 'inst-1',
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
        botId: 'inst-1',
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
        botId: 'inst-1',
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

  it('rejects decisions from a superseded runtime session', async () => {
    const { handler, eventPublisher } = makeHandler();

    const agentRepo = (handler as unknown as { agentRepo: { isActiveSession: ReturnType<typeof vi.fn> } }).agentRepo;
    agentRepo.isActiveSession.mockResolvedValueOnce(false);

    await handler.handleDecisionSubmit(
      {
        schemaVersion: 'v1',
        messageId: 'msg-stale',
        correlationId: 'old-session-id',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        agentId: 'agent-1',
        type: 'agent.decision.submit',
        createdAt: '2026-06-03T00:00:00.000Z',
        payload: {},
      },
      {
        decisionId: 'dec-stale',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: '1',
        rationaleSummary: 'stale container trade attempt',
      },
    );

    expect(eventPublisher.emitDecisionRejected).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        decisionId: 'dec-stale',
        code: 'stale_session',
        retryable: false,
      }),
    );
    expect(agentRepo.isActiveSession).toHaveBeenCalledWith('agent-1', 'old-session-id');
  });

  it('accepts decisions when correlationId matches the active session', async () => {
    const { handler, eventPublisher } = makeHandler();

    vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
      decision: {
        id: 'dec-ok',
        botId: 'agent-1',
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

    const agentRepo = (handler as unknown as { agentRepo: { isActiveSession: ReturnType<typeof vi.fn> } }).agentRepo;
    agentRepo.isActiveSession.mockResolvedValueOnce(true);

    await handler.handleDecisionSubmit(
      {
        schemaVersion: 'v1',
        messageId: 'msg-ok',
        correlationId: 'current-session-id',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        agentId: 'agent-1',
        type: 'agent.decision.submit',
        createdAt: '2026-06-03T00:00:00.000Z',
        payload: {},
      },
      {
        decisionId: 'dec-ok',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: '1',
        rationaleSummary: 'current session trade',
      },
    );

    expect(eventPublisher.emitDecisionRejected).not.toHaveBeenCalled();
    expect(agentRepo.isActiveSession).toHaveBeenCalledWith('agent-1', 'current-session-id');
  });

  it('does not emit accepted or plan status when the risk gate rejects the decision', async () => {
    const { handler, eventPublisher } = makeHandler();

    vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
      decision: {
        id: 'dec-risk',
        botId: 'inst-1',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: { toString: () => '1' },
        timestamp: '2026-06-03T00:00:00.000Z',
      } as any,
      plan: {
        id: 'plan-risk',
        status: 'failed',
        action: 'open_long',
        venue: 'hyperliquid',
        symbol: 'BTC/USD:USD',
        orders: [],
      } as any,
      riskRejected: true,
      riskError: {
        code: 'risk.max_order_notional_exceeded',
        message: 'Order notional exceeds configured limit',
        context: { maxOrderNotional: '1000' },
      },
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
        messageId: 'msg-risk',
        correlationId: 'corr-risk',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        botId: 'inst-1',
        type: 'agent.decision.submit',
        createdAt: '2026-06-03T00:00:00.000Z',
        payload: {},
      },
      {
        decisionId: 'dec-risk',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: '1',
        rationaleSummary: 'should trip risk gate',
      },
    );

    expect(eventPublisher.emitDecisionAccepted).not.toHaveBeenCalled();
    expect(eventPublisher.emitPlanStatus).not.toHaveBeenCalled();
    expect(eventPublisher.emitGuardrailTriggered).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        code: 'risk.max_order_notional_exceeded',
        message: 'Order notional exceeds configured limit',
        details: { maxOrderNotional: '1000' },
      }),
    );
  });

  it('maps circuit_breaker_open rejection to explicit rejection code', async () => {
    const { handler, eventPublisher } = makeHandler();

    // Override intakeResolver to return a typed rejection
    const resolver = (handler as any).intakeResolver;
    resolver.getIntakeDeps.mockReturnValueOnce({
      rejected: true,
      code: 'circuit_breaker_open',
      message: 'Circuit breaker is open — execution halted after consecutive venue errors',
      retryable: false,
    });

    await handler.handleDecisionSubmit(
      {
        schemaVersion: 'v1',
        messageId: 'msg-cb',
        correlationId: 'corr-cb',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        botId: 'inst-1',
        type: 'agent.decision.submit',
        createdAt: '2026-06-03T00:00:00.000Z',
        payload: {},
      },
      {
        decisionId: 'dec-cb',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: '1',
        rationaleSummary: 'breaker open',
      },
    );

    expect(eventPublisher.emitDecisionRejected).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        decisionId: 'dec-cb',
        code: 'circuit_breaker_open',
        message: 'Circuit breaker is open — execution halted after consecutive venue errors',
        retryable: false,
      }),
    );
  });

  it('maps stop_loss_active rejection to explicit rejection code', async () => {
    const { handler, eventPublisher } = makeHandler();

    const resolver = (handler as any).intakeResolver;
    resolver.getIntakeDeps.mockReturnValueOnce({
      rejected: true,
      code: 'stop_loss_active',
      message: 'Stop-loss cooldown active for BTC/USD:USD — re-entry blocked',
      retryable: false,
    });

    await handler.handleDecisionSubmit(
      {
        schemaVersion: 'v1',
        messageId: 'msg-sl',
        correlationId: 'corr-sl',
        initiatorType: 'agent',
        initiatorId: 'agent-1',
        botId: 'inst-1',
        type: 'agent.decision.submit',
        createdAt: '2026-06-03T00:00:00.000Z',
        payload: {},
      },
      {
        decisionId: 'dec-sl',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long',
        targetSize: '1',
        rationaleSummary: 'stop loss cooldown',
      },
    );

    expect(eventPublisher.emitDecisionRejected).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        decisionId: 'dec-sl',
        code: 'stop_loss_active',
        message: 'Stop-loss cooldown active for BTC/USD:USD — re-entry blocked',
        retryable: false,
      }),
    );
  });

  describe('DecisionFailureRepository recording', () => {
    function makeHandlerWithFailureRepo() {
      const base = (() => {
        const markSource = {
          fetchMark: vi.fn().mockResolvedValue({ ok: true, data: { price: '101', source: 'oracle', stale: false } }),
        };

        const agentRepo = {
          getActiveLink: vi.fn().mockResolvedValue({ botId: 'inst-1' }),
          getAgent: vi.fn().mockResolvedValue({ id: 'agent-1', status: 'active' }),
          getSessionForAgentAndInstance: vi.fn().mockResolvedValue({ id: 'sess-1', status: 'running' }),
          isActiveSession: vi.fn().mockResolvedValue(true),
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

        return { agentRepo, intakeResolver, eventPublisher };
      })();

      const failureRepo = {
        insert: vi.fn().mockResolvedValue('failure-id'),
      };

      const handler = new AgentDecisionHandler(
        base.agentRepo as any,
        base.intakeResolver as any,
        base.eventPublisher as any,
        failureRepo as any,
      );

      return { handler, failureRepo, ...base };
    }

    const envelope = {
      schemaVersion: 'v1' as const,
      messageId: 'msg-f1',
      correlationId: 'corr-f1',
      initiatorType: 'agent' as const,
      initiatorId: 'agent-1',
      botId: 'inst-1',
      type: 'agent.decision.submit' as const,
      createdAt: '2026-06-03T00:00:00.000Z',
      payload: {},
    };

    const payload = {
      decisionId: 'dec-f1',
      instrumentId: 'BTC/USD:USD',
      intent: 'go_long' as const,
      targetSize: '1',
      rationaleSummary: 'test',
    };

    it('records a failure when the agent is paused', async () => {
      const { handler, failureRepo, agentRepo } = makeHandlerWithFailureRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-1', status: 'paused' });

      await handler.handleDecisionSubmit(envelope, payload);

      expect(failureRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          failureCode: 'agent_paused',
          failureClass: 'rejection',
          retryable: false,
          actorId: 'agent-1',
        }),
      );
    });

    it('records a failure when no execution context is available (instance_not_running)', async () => {
      const { handler, failureRepo, intakeResolver } = makeHandlerWithFailureRepo();
      intakeResolver.getIntakeDeps.mockReturnValue(null);

      await handler.handleDecisionSubmit(envelope, payload);

      expect(failureRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          failureCode: 'instance_not_running',
          failureClass: 'rejection',
          retryable: true,
        }),
      );
    });

    it('records a failure with failureClass error when the engine throws unexpectedly', async () => {
      const { handler, failureRepo } = makeHandlerWithFailureRepo();
      vi.mocked(submitDecisionForExecution).mockRejectedValueOnce(new Error('engine boom'));

      await handler.handleDecisionSubmit(envelope, payload);

      expect(failureRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          failureCode: 'execution_error',
          failureClass: 'error',
          retryable: false,
        }),
      );
    });

    it('records a failure when the session is stale', async () => {
      const { handler, failureRepo, agentRepo } = makeHandlerWithFailureRepo();
      agentRepo.isActiveSession.mockResolvedValue(false);

      await handler.handleDecisionSubmit(envelope, payload);

      expect(failureRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          failureCode: 'stale_session',
          failureClass: 'rejection',
          retryable: false,
          actorId: 'agent-1',
        }),
      );
    });

    it('records a failure when no decision context is available', async () => {
      const { handler, failureRepo, intakeResolver } = makeHandlerWithFailureRepo();
      intakeResolver.getDecisionContext.mockReturnValue(null);

      await handler.handleDecisionSubmit(envelope, payload);

      expect(failureRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          failureCode: 'no_context',
          failureClass: 'rejection',
          retryable: true,
        }),
      );
    });

    it('records a failure when position state is unavailable', async () => {
      const { handler, failureRepo, intakeResolver } = makeHandlerWithFailureRepo();
      intakeResolver.getPosition.mockReturnValue(null);

      await handler.handleDecisionSubmit(envelope, payload);

      expect(failureRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          failureCode: 'no_position_state',
          failureClass: 'rejection',
          retryable: true,
        }),
      );
    });

    it('records a failure on pre-execution rejection', async () => {
      const { handler, failureRepo } = makeHandlerWithFailureRepo();
      vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
        decision: {} as any,
        riskRejected: false,
        position: {} as any,
        executionFailed: false,
        preExecutionRejection: {
          code: 'swap_token_unsafe',
          message: 'Token failed safety check',
          retryable: false,
        },
      });

      await handler.handleDecisionSubmit(envelope, payload);

      expect(failureRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          failureCode: 'swap_token_unsafe',
          failureClass: 'rejection',
          retryable: false,
        }),
      );
    });

    it('does not throw when decisionFailureRepo is absent', async () => {
      const { handler, agentRepo } = (() => {
        const agentRepo = {
          getActiveLink: vi.fn().mockResolvedValue({ botId: 'inst-1' }),
          getAgent: vi.fn().mockResolvedValue({ id: 'agent-1', status: 'paused' }),
          getSessionForAgentAndInstance: vi.fn().mockResolvedValue({ id: 'sess-1', status: 'running' }),
          isActiveSession: vi.fn().mockResolvedValue(true),
        };
        const intakeResolver = { getIntakeDeps: vi.fn(), getDecisionContext: vi.fn(), getPosition: vi.fn() };
        const eventPublisher = {
          emitDecisionAccepted: vi.fn().mockResolvedValue(undefined),
          emitDecisionRejected: vi.fn().mockResolvedValue(undefined),
          emitPlanStatus: vi.fn().mockResolvedValue(undefined),
          emitGuardrailTriggered: vi.fn().mockResolvedValue(undefined),
          emitExecutionResult: vi.fn().mockResolvedValue(undefined),
        };
        // No decisionFailureRepo passed (optional 4th arg omitted)
        const handler = new AgentDecisionHandler(agentRepo as any, intakeResolver as any, eventPublisher as any);
        return { handler, agentRepo };
      })();

      await expect(handler.handleDecisionSubmit(envelope, payload)).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // circuit breaker for no_context
  // ---------------------------------------------------------------------------
  describe('circuit breaker for no_context', () => {
    function makeHandlerWithFailureRepo() {
      const base = (() => {
        const markSource = {
          fetchMark: vi.fn().mockResolvedValue({ ok: true, data: { price: '101', source: 'oracle', stale: false } }),
        };

        const agentRepo = {
          getActiveLink: vi.fn().mockResolvedValue({ botId: 'inst-1' }),
          getAgent: vi.fn().mockResolvedValue({ id: 'agent-1', status: 'active' }),
          getSessionForAgentAndInstance: vi.fn().mockResolvedValue({ id: 'sess-1', status: 'running' }),
          isActiveSession: vi.fn().mockResolvedValue(true),
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

        return { agentRepo, intakeResolver, eventPublisher };
      })();

      const failureRepo = {
        insert: vi.fn().mockResolvedValue('failure-id'),
      };

      const handler = new AgentDecisionHandler(
        base.agentRepo as any,
        base.intakeResolver as any,
        base.eventPublisher as any,
        failureRepo as any,
      );

      return { handler, failureRepo, ...base };
    }

    const envelope = {
      schemaVersion: 'v1' as const,
      messageId: 'msg-1',
      correlationId: 'corr-1',
      initiatorType: 'agent' as const,
      initiatorId: 'agent-1',
      botId: 'inst-1',
      type: 'agent.decision.submit' as const,
      createdAt: '2026-06-03T00:00:00.000Z',
      payload: {},
    };

    const payload = {
      decisionId: 'dec-f1',
      instrumentId: 'BTC/USD:USD',
      intent: 'go_long' as const,
      targetSize: '1',
      rationaleSummary: 'test',
    };

    it('skips circuit breaker for no_context when actor has never had successful context', async () => {
      const { handler, eventPublisher, intakeResolver } = makeHandlerWithFailureRepo();
      intakeResolver.getDecisionContext.mockReturnValue(null);

      // First no_context — actor has never had context, breaker should be skipped
      await handler.handleDecisionSubmit(envelope, payload);

      expect(eventPublisher.emitDecisionRejected).toHaveBeenCalledWith(
        'inst-1',
        expect.objectContaining({
          decisionId: payload.decisionId,
          code: 'no_context',
          retryable: true,
        }),
      );
      // Message should NOT contain circuit breaker text since breaker was skipped
      const call = eventPublisher.emitDecisionRejected.mock.calls[0] as any[];
      expect(call[1].message).not.toContain('CIRCUIT BREAKER');
    });

    it('trips circuit breaker after 3 consecutive no_context failures for an initialized actor', async () => {
      const { handler, eventPublisher, intakeResolver } = makeHandlerWithFailureRepo();
      intakeResolver.getDecisionContext.mockReturnValue(null);

      // Simulate that the actor has previously succeeded in fetching context
      // by accessing the private set (only way to seed it without a successful call first)
      const privateSet = (handler as any).actorsWithSuccessfulContext as Set<string>;
      privateSet.add('agent-1');

      // Failures 1 and 2 — should be retryable
      for (let i = 0; i < 2; i++) {
        await handler.handleDecisionSubmit(envelope, payload);
      }

      // Verify calls 0 and 1 stayed retryable (breaker not yet tripped)
      const calls = eventPublisher.emitDecisionRejected.mock.calls;
      expect(calls[0][1].retryable).toBe(true);
      expect(calls[1][1].retryable).toBe(true);

      // Failure 3 — should trip the breaker
      await handler.handleDecisionSubmit(envelope, payload);

      const lastCall = calls[calls.length - 1] as any[];
      expect(lastCall[1].retryable).toBe(false);
      expect(lastCall[1].message).toContain('CIRCUIT BREAKER');
      expect(lastCall[1].message).toContain('3 consecutive');
    });
  });

  // ---------------------------------------------------------------------------
  // synchronous decision reply (_expectsReply)
  // ---------------------------------------------------------------------------
  describe('synchronous decision reply (_expectsReply)', () => {
    function makePayload(overrides: Partial<Parameters<AgentDecisionHandler['handleDecisionSubmit']>[1]> = {}) {
      return {
        decisionId: 'dec-sync',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long' as const,
        targetSize: '1',
        rationaleSummary: 'sync reply test',
        _expectsReply: true,
        ...overrides,
      };
    }

    const envelope = {
      schemaVersion: 'v1' as const,
      messageId: 'msg-sync',
      correlationId: 'corr-sync',
      initiatorType: 'agent' as const,
      initiatorId: 'agent-1',
      botId: 'inst-1',
      type: 'agent.decision.submit',
      createdAt: '2026-06-03T00:00:00.000Z',
      payload: {},
    };

    // -----------------------------------------------------------------------
    // publishes on acceptance
    // -----------------------------------------------------------------------

    it('publishes an accepted sync reply when the decision passes intake and risk', async () => {
      const { handler, eventPublisher } = makeHandler();

      vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
        decision: {
          id: 'dec-sync-ok',
          botId: 'inst-1',
          instrumentId: 'BTC/USD:USD',
          intent: 'go_long',
          targetSize: { toString: () => '1' },
          timestamp: '2026-06-03T00:00:00.000Z',
        } as any,
        plan: { id: 'plan-1', status: 'executing', action: 'open_long', venue: 'hyperliquid', symbol: 'BTC/USD:USD', orders: [] } as any,
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

      await handler.handleDecisionSubmit(envelope, makePayload({ _expectsReply: true }));

      expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith(
        'dec-sync',
        {
          status: 'accepted',
          planId: 'plan-1',
          message: "Accepted. Note: no stopLoss or takeProfit set — this position is unprotected if you're unable to trade.",
        },
      );
    });

    // -----------------------------------------------------------------------
    // publishes on rejection (early gate: instrument mismatch)
    // -----------------------------------------------------------------------

    it('publishes a rejected sync reply on instrument mismatch', async () => {
      const { handler, eventPublisher } = makeHandler();

      await handler.handleDecisionSubmit(
        envelope,
        makePayload({ instrumentId: 'ETH/USD:USD', _expectsReply: true }),
      );

      expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith(
        'dec-sync',
        { status: 'rejected', code: 'instrument_mismatch', message: 'Decision instrument does not match the actor symbol' },
      );
    });

    // -----------------------------------------------------------------------
    // publishes on rejection (early gate: stale session)
    // -----------------------------------------------------------------------

    it('publishes a rejected sync reply on stale session', async () => {
      const { handler, eventPublisher } = makeHandler();

      const agentRepo = (handler as unknown as { agentRepo: { isActiveSession: ReturnType<typeof vi.fn> } }).agentRepo;
      agentRepo.isActiveSession.mockResolvedValueOnce(false);

      await handler.handleDecisionSubmit(envelope, makePayload({ _expectsReply: true }));

      expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith(
        'dec-sync',
        { status: 'rejected', code: 'stale_session', message: 'Decision rejected — runtime session is no longer the active session' },
      );
    });

    // -----------------------------------------------------------------------
    // publishes on rejection (intake rejection e.g. circuit breaker)
    // -----------------------------------------------------------------------

    it('publishes a rejected sync reply on intake rejection', async () => {
      const { handler, eventPublisher } = makeHandler();

      const resolver = (handler as any).intakeResolver;
      resolver.getIntakeDeps.mockReturnValueOnce({
        rejected: true,
        code: 'circuit_breaker_open',
        message: 'Circuit breaker is open',
        retryable: false,
      });

      await handler.handleDecisionSubmit(envelope, makePayload({ _expectsReply: true }));

      expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith(
        'dec-sync',
        { status: 'rejected', code: 'circuit_breaker_open', message: 'Circuit breaker is open' },
      );
    });

    // -----------------------------------------------------------------------
    // publishes on risk gate rejection
    // -----------------------------------------------------------------------

    it('publishes a rejected sync reply when the risk gate rejects', async () => {
      const { handler, eventPublisher } = makeHandler();

      vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
        decision: { id: 'dec-risk', instrumentId: 'BTC/USD:USD', intent: 'go_long', targetSize: { toString: () => '1' } } as any,
        riskRejected: true,
        riskError: { code: 'risk.max_order_notional_exceeded', message: 'Order notional exceeds limit', context: {} },
        position: { symbol: 'BTC/USD:USD', side: 'flat', size: { toString: () => '0' }, entryPrice: { toString: () => '0' }, realizedPnl: { toString: () => '0' } } as any,
        executionFailed: false,
      });

      await handler.handleDecisionSubmit(envelope, makePayload({ _expectsReply: true }));

      expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith(
        'dec-sync',
        { status: 'rejected', code: 'risk.max_order_notional_exceeded', message: 'Order notional exceeds limit' },
      );
    });

    // -----------------------------------------------------------------------
    // enriches daily loss rejection with blocked-till guidance and timestamp
    // -----------------------------------------------------------------------

    it('enriches daily loss rejection with blocked-till timestamp and go_flat/decrease guidance', async () => {
      const { handler, eventPublisher } = makeHandler();

      const now = Date.now();
      const oldestLossTs = now - 3_600_000; // 1h ago — expires in 23h
      const tracker = new DailyLossTracker();
      tracker.recordFill(price('-57.71'), oldestLossTs);
      tracker.recordFill(price('-5.68'), now);

      // Override intake deps to include the tracker
      const resolver = (handler as any).intakeResolver;
      resolver.getIntakeDeps.mockReturnValue({
        symbol: 'BTC/USD:USD',
        markSource: { fetchMark: vi.fn().mockResolvedValue({ ok: true, data: { price: '101', source: 'oracle', stale: false } }) },
        dailyLossTracker: tracker,
      });

      vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
        decision: { id: 'dec-daily', instrumentId: 'BTC/USD:USD', intent: 'go_long', targetSize: { toString: () => '1' } } as any,
        riskRejected: true,
        riskError: { code: 'risk.daily_max_loss_exceeded', message: 'Daily loss limit reached: $57.71 realized (limit: $50.00)', context: {} },
        position: { symbol: 'BTC/USD:USD', side: 'flat', size: { toString: () => '0' }, entryPrice: { toString: () => '0' }, realizedPnl: { toString: () => '0' } } as any,
        executionFailed: false,
      });

      await handler.handleDecisionSubmit(envelope, makePayload({ _expectsReply: true }));

      expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith(
        'dec-sync',
        expect.objectContaining({
          status: 'rejected',
          code: 'risk.daily_max_loss_exceeded',
          message: expect.stringContaining('New positions are blocked till at least'),
        }),
      );
      const call = (eventPublisher.publishDecisionReply as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      const msg = call[1].message as string;
      expect(msg).toContain('go_flat or decrease to manage existing open positions');
      expect(msg).toContain('subsequent losses may extend the block');
    });

    // -----------------------------------------------------------------------
    // publishes on execution error
    // -----------------------------------------------------------------------

    it('publishes an error sync reply when the engine throws unexpectedly', async () => {
      const { handler, eventPublisher } = makeHandler();

      vi.mocked(submitDecisionForExecution).mockRejectedValueOnce(new Error('Engine crash'));

      await handler.handleDecisionSubmit(envelope, makePayload({ _expectsReply: true }));

      expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith(
        'dec-sync',
        { status: 'error', code: 'execution_error', message: 'Engine crash' },
      );
    });

    // -----------------------------------------------------------------------
    // publishes on context hash mismatch
    // -----------------------------------------------------------------------

    it('publishes a rejected sync reply on context hash mismatch', async () => {
      const { handler, eventPublisher } = makeHandler();

      vi.mocked(submitDecisionForExecution).mockRejectedValueOnce(
        new DecisionContextHashMismatchError('expected', 'supplied'),
      );

      await handler.handleDecisionSubmit(envelope, makePayload({ _expectsReply: true }));

      expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith(
        'dec-sync',
        { status: 'rejected', code: 'context_hash_mismatch', message: 'Decision context hash does not match the server-resolved context' },
      );
    });

    // -----------------------------------------------------------------------
    // does NOT publish when _expectsReply is absent
    // -----------------------------------------------------------------------

    it('does NOT publish a sync reply when _expectsReply is absent', async () => {
      const { handler, eventPublisher } = makeHandler();

      vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
        decision: { id: 'dec-no-reply', botId: 'inst-1', instrumentId: 'BTC/USD:USD', intent: 'go_long', targetSize: { toString: () => '1' }, timestamp: '2026-06-03T00:00:00.000Z' } as any,
        riskRejected: false,
        position: { symbol: 'BTC/USD:USD', side: 'flat', size: { toString: () => '0' }, entryPrice: { toString: () => '0' }, realizedPnl: { toString: () => '0' } } as any,
        executionFailed: false,
      });

      const payload = makePayload();
      delete (payload as any)._expectsReply;

      await handler.handleDecisionSubmit(envelope, payload);

      expect(eventPublisher.publishDecisionReply).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // does NOT publish when _expectsReply is false
    // -----------------------------------------------------------------------

    it('does NOT publish a sync reply when _expectsReply is false', async () => {
      const { handler, eventPublisher } = makeHandler();

      vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
        decision: { id: 'dec-false', botId: 'inst-1', instrumentId: 'BTC/USD:USD', intent: 'go_long', targetSize: { toString: () => '1' }, timestamp: '2026-06-03T00:00:00.000Z' } as any,
        riskRejected: false,
        position: { symbol: 'BTC/USD:USD', side: 'flat', size: { toString: () => '0' }, entryPrice: { toString: () => '0' }, realizedPnl: { toString: () => '0' } } as any,
        executionFailed: false,
      });

      await handler.handleDecisionSubmit(envelope, makePayload({ _expectsReply: false }));

      expect(eventPublisher.publishDecisionReply).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // does not crash when publishDecisionReply throws
    // -----------------------------------------------------------------------

    it('does not crash when publishDecisionReply throws (handler completes)', async () => {
      const { handler, eventPublisher } = makeHandler();

      vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
        decision: { id: 'dec-crash', botId: 'inst-1', instrumentId: 'BTC/USD:USD', intent: 'go_long', targetSize: { toString: () => '1' }, timestamp: '2026-06-03T00:00:00.000Z' } as any,
        riskRejected: false,
        position: { symbol: 'BTC/USD:USD', side: 'flat', size: { toString: () => '0' }, entryPrice: { toString: () => '0' }, realizedPnl: { toString: () => '0' } } as any,
        executionFailed: false,
      });

      (eventPublisher.publishDecisionReply as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Redis connection lost'));

      await expect(
        handler.handleDecisionSubmit(envelope, makePayload({ _expectsReply: true })),
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // per-trade level validation (stopLoss / takeProfit vs mark price)
  // ---------------------------------------------------------------------------
  describe('per-trade level validation', () => {
    function makePayload(overrides: Partial<Parameters<AgentDecisionHandler['handleDecisionSubmit']>[1]> = {}) {
      return {
        decisionId: 'dec-lvl',
        instrumentId: 'BTC/USD:USD',
        intent: 'go_long' as const,
        targetSize: '1',
        rationaleSummary: 'level validation test',
        _expectsReply: true,
        ...overrides,
      };
    }

    const envelope = {
      schemaVersion: 'v1' as const,
      messageId: 'msg-lvl',
      correlationId: 'corr-lvl',
      initiatorType: 'agent' as const,
      initiatorId: 'agent-1',
      botId: 'inst-1',
      type: 'agent.decision.submit',
      createdAt: '2026-06-03T00:00:00.000Z',
      payload: {},
    };

    // -----------------------------------------------------------------------
    // Scenario 1: go_long with stopLoss >= markPrice → rejected
    // -----------------------------------------------------------------------

    it('rejects go_long when stopLoss is at or above mark price', async () => {
      const { handler, eventPublisher } = makeHandler();

      await handler.handleDecisionSubmit(
        envelope,
        makePayload({ intent: 'go_long', stopLoss: '100', _expectsReply: true }),
      );

      // Should publish a rejected sync reply
      expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith(
        'dec-lvl',
        {
          status: 'rejected',
          code: 'level.above_mark_for_long',
          message: expect.stringContaining('stopLoss (100) must be below current price (100)'),
        },
      );

      // Should emit decision rejected
      expect(eventPublisher.emitDecisionRejected).toHaveBeenCalledWith(
        'inst-1',
        expect.objectContaining({
          decisionId: 'dec-lvl',
          code: 'level.above_mark_for_long',
          retryable: false,
        }),
      );

      // Should NOT proceed to engine intake
      expect(submitDecisionForExecution).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Scenario 2: go_short with takeProfit >= markPrice → rejected
    // -----------------------------------------------------------------------

    it('rejects go_short when takeProfit is at or above mark price', async () => {
      const { handler, eventPublisher } = makeHandler();

      await handler.handleDecisionSubmit(
        envelope,
        makePayload({ intent: 'go_short', takeProfit: '100', _expectsReply: true }),
      );

      expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith(
        'dec-lvl',
        {
          status: 'rejected',
          code: 'level.above_mark_for_short',
          message: expect.stringContaining('takeProfit (100) must be below current price (100)'),
        },
      );

      expect(eventPublisher.emitDecisionRejected).toHaveBeenCalledWith(
        'inst-1',
        expect.objectContaining({
          decisionId: 'dec-lvl',
          code: 'level.above_mark_for_short',
          retryable: false,
        }),
      );

      expect(submitDecisionForExecution).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Scenario 3: increase intent resolves side from position and rejects bad levels
    // -----------------------------------------------------------------------

    it('resolves increase side from position.side and rejects bad stopLoss for a long position', async () => {
      const { handler, eventPublisher } = makeHandler();

      // Override position to be long
      const resolver = (handler as any).intakeResolver;
      resolver.getPosition.mockReturnValue({
        symbol: 'BTC/USD:USD',
        side: 'long',
        size: { toString: () => '0.5' },
        entryPrice: { toString: () => '99' },
        realizedPnl: { toString: () => '0' },
      });

      await handler.handleDecisionSubmit(
        envelope,
        makePayload({ intent: 'increase', stopLoss: '100', _expectsReply: true }),
      );

      expect(eventPublisher.publishDecisionReply).toHaveBeenCalledWith(
        'dec-lvl',
        {
          status: 'rejected',
          code: 'level.above_mark_for_long',
          message: expect.stringContaining('stopLoss (100) must be below current price (100)'),
        },
      );

      expect(submitDecisionForExecution).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Scenario 4: go_flat / decrease skips level validation entirely
    // -----------------------------------------------------------------------

    it('skips level validation for go_flat even with invalid levels', async () => {
      const { handler, eventPublisher } = makeHandler();

      vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
        decision: { id: 'dec-flat', botId: 'inst-1', instrumentId: 'BTC/USD:USD', intent: 'go_flat', targetSize: { toString: () => '0' }, timestamp: '2026-06-03T00:00:00.000Z' } as any,
        riskRejected: false,
        position: { symbol: 'BTC/USD:USD', side: 'flat', size: { toString: () => '0' }, entryPrice: { toString: () => '0' }, realizedPnl: { toString: () => '0' } } as any,
        executionFailed: false,
      });

      await handler.handleDecisionSubmit(
        envelope,
        makePayload({ intent: 'go_flat', stopLoss: '100', takeProfit: '100', _expectsReply: true }),
      );

      // Should NOT be level-rejected — proceeds to intake
      expect(submitDecisionForExecution).toHaveBeenCalled();
      expect(eventPublisher.emitDecisionRejected).not.toHaveBeenCalledWith(
        'inst-1',
        expect.objectContaining({ code: expect.stringContaining('level.') }),
      );
    });

    it('skips level validation for decrease even with invalid levels', async () => {
      const { handler, eventPublisher } = makeHandler();

      vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
        decision: { id: 'dec-dec', botId: 'inst-1', instrumentId: 'BTC/USD:USD', intent: 'decrease', targetSize: { toString: () => '0.2' }, timestamp: '2026-06-03T00:00:00.000Z' } as any,
        riskRejected: false,
        position: { symbol: 'BTC/USD:USD', side: 'long', size: { toString: () => '0.5' }, entryPrice: { toString: () => '99' }, realizedPnl: { toString: () => '0' } } as any,
        executionFailed: false,
      });

      await handler.handleDecisionSubmit(
        envelope,
        makePayload({ intent: 'decrease', stopLoss: '100', takeProfit: '100', _expectsReply: true }),
      );

      // Should NOT be level-rejected — proceeds to intake
      expect(submitDecisionForExecution).toHaveBeenCalled();
      expect(eventPublisher.emitDecisionRejected).not.toHaveBeenCalledWith(
        'inst-1',
        expect.objectContaining({ code: expect.stringContaining('level.') }),
      );
    });

    // -----------------------------------------------------------------------
    // Scenario 5: missing mark price → validation skipped (non-blocking)
    // -----------------------------------------------------------------------

    it('skips level validation when mark price is unavailable', async () => {
      const { handler, eventPublisher } = makeHandler();

      // Override context to have no mark price
      const resolver = (handler as any).intakeResolver;
      resolver.getDecisionContext.mockReturnValue({
        snapshot: { symbol: 'BTC/USD:USD', price: '', timestamp: '2026-06-03T00:00:00.000Z' },
        position: null,
        referenceMark: { price: '', source: 'last_price' },
        strategyParams: {},
      });

      vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
        decision: { id: 'dec-nomark', botId: 'inst-1', instrumentId: 'BTC/USD:USD', intent: 'go_long', targetSize: { toString: () => '1' }, timestamp: '2026-06-03T00:00:00.000Z' } as any,
        riskRejected: false,
        position: { symbol: 'BTC/USD:USD', side: 'flat', size: { toString: () => '0' }, entryPrice: { toString: () => '0' }, realizedPnl: { toString: () => '0' } } as any,
        executionFailed: false,
      });

      await handler.handleDecisionSubmit(
        envelope,
        makePayload({ intent: 'go_long', stopLoss: '90', takeProfit: '110', _expectsReply: true }),
      );

      // Should NOT be level-rejected — proceeds to intake despite having stopLoss+takeProfit
      expect(submitDecisionForExecution).toHaveBeenCalled();
      expect(eventPublisher.emitDecisionRejected).not.toHaveBeenCalledWith(
        'inst-1',
        expect.objectContaining({ code: expect.stringContaining('level.') }),
      );
    });

    // -----------------------------------------------------------------------
    // malformed mark price → validation skipped (non-blocking, no crash)
    // -----------------------------------------------------------------------

    it('skips level validation when mark price is malformed (non-numeric)', async () => {
      const { handler, eventPublisher } = makeHandler();

      const resolver = (handler as any).intakeResolver;
      resolver.getDecisionContext.mockReturnValue({
        snapshot: { symbol: 'BTC/USD:USD', price: 'not-a-number', timestamp: '2026-06-03T00:00:00.000Z' },
        position: null,
        referenceMark: { price: 'not-a-number', source: 'last_price' },
        strategyParams: {},
      });

      vi.mocked(submitDecisionForExecution).mockResolvedValueOnce({
        decision: { id: 'dec-malformed', botId: 'inst-1', instrumentId: 'BTC/USD:USD', intent: 'go_long', targetSize: { toString: () => '1' }, timestamp: '2026-06-03T00:00:00.000Z' } as any,
        riskRejected: false,
        position: { symbol: 'BTC/USD:USD', side: 'flat', size: { toString: () => '0' }, entryPrice: { toString: () => '0' }, realizedPnl: { toString: () => '0' } } as any,
        executionFailed: false,
      });

      await handler.handleDecisionSubmit(
        envelope,
        makePayload({ intent: 'go_long', stopLoss: '90', takeProfit: '110', _expectsReply: true }),
      );

      // Should NOT crash and should proceed to intake
      expect(submitDecisionForExecution).toHaveBeenCalled();
    });
  });
});