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
});