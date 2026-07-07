import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentMessageBroker } from './agent-message-broker.js';
import { CapabilityPolicyEngine } from './capability-policy.js';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'v1',
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    correlationId: 'corr-001',
    initiatorType: 'agent',
    initiatorId: 'agent-123',
    botId: 'ti-456',
    type: 'agent.decision.submit',
    createdAt: '2026-06-01T00:00:00.000Z',
    payload: {
      decisionId: 'dec-001',
      instrumentId: 'BTC-USD',
      intent: 'go_long',
      targetSize: '1.5',
      rationaleSummary: 'Momentum breakout',
    },
    ...overrides,
  };
}

function mockAgentRepo() {
  return {
    isMessageDuplicate: vi.fn().mockResolvedValue(false),
    isActiveSession: vi.fn().mockResolvedValue(true),
    insertMessage: vi.fn().mockResolvedValue(undefined),
    markMessageProcessed: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockResolvedValue({ id: 'agent-123', status: 'active' }),
    updateAgent: vi.fn().mockResolvedValue(undefined),
    getActiveSession: vi.fn().mockResolvedValue({ id: 'sess-001', status: 'running' }),
    retireActiveSessions: vi.fn().mockResolvedValue(undefined),
    getRuntimeCapabilityDescriptor: vi.fn().mockResolvedValue(makeTradingCapabilityDescriptor()),
    insertArtifact: vi.fn().mockResolvedValue('art-id'),
    getActiveLink: vi.fn().mockResolvedValue({ botId: 'ti-456' }),
    getUserAiModelConfig: vi.fn().mockResolvedValue(null),
  };
}

function makeTradingCapabilityDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    grantedConnectionsByFamily: {
      trading: [
        {
          connectionId: 'binding-1',
          resolvedVenueAccountId: 'va-001',
          readiness: { effectiveReady: true },
        },
      ],
    },
    defaultConnectionByFamily: { trading: 'binding-1' },
    ...overrides,
  };
}

function mockDecisionHandler() {
  return {
    handleDecisionSubmit: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentDecisionHandler;
}

function mockSessionManager() {
  return {
    handleHeartbeat: vi.fn().mockResolvedValue(undefined),
    handlePauseRequest: vi.fn().mockResolvedValue(undefined),
    handleStopRequest: vi.fn().mockResolvedValue(undefined),
    handleRuntimeSessionEnd: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentSessionManager;
}

function mockEventPublisher() {
  return {
    emitDecisionAccepted: vi.fn().mockResolvedValue(undefined),
    emitDecisionRejected: vi.fn().mockResolvedValue(undefined),
    emitInstanceStatus: vi.fn().mockResolvedValue(undefined),
    emitToolResult: vi.fn().mockResolvedValue(undefined),
  } as unknown as InstanceEventPublisher;
}

describe('AgentMessageBroker', () => {
  let broker: AgentMessageBroker;
  let agentRepo: ReturnType<typeof mockAgentRepo>;
  let decisionHandler: ReturnType<typeof mockDecisionHandler>;
  let sessionManager: ReturnType<typeof mockSessionManager>;
  let eventPublisher: ReturnType<typeof mockEventPublisher>;

  beforeEach(() => {
    agentRepo = mockAgentRepo();
    decisionHandler = mockDecisionHandler();
    sessionManager = mockSessionManager();
    eventPublisher = mockEventPublisher();
    broker = new AgentMessageBroker(
      {} as any, // redis (not used directly in processInbound tests)
      agentRepo as any,
      decisionHandler,
      sessionManager,
      eventPublisher,
    );
  });

  describe('envelope validation', () => {
    it('rejects invalid envelope', async () => {
      const result = await broker.processInbound({ bad: 'data' });
      expect(result.accepted).toBe(false);
      expect(result.error).toBe('invalid_envelope');
    });

    it('rejects missing required fields', async () => {
      const result = await broker.processInbound({ messageId: 'msg-1' });
      expect(result.accepted).toBe(false);
      expect(result.error).toBe('invalid_envelope');
    });

    it('rejects envelope with unknown message type', async () => {
      const envelope = makeEnvelope({ type: 'agent.unknown.action' });
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(false);
      expect(result.error).toBe('unknown_message_type');
    });
  });

  describe('payload validation', () => {
    it('rejects envelope with invalid payload for its type', async () => {
      const envelope = makeEnvelope({
        payload: { /* missing required fields */ },
      });
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(false);
      expect(result.error).toBe('invalid_payload');
    });
  });

  describe('deduplication', () => {
    it('accepts duplicate messages idempotently', async () => {
      agentRepo.isMessageDuplicate.mockResolvedValue(true);
      const envelope = makeEnvelope();
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(true);
      // Should not call insertMessage or route to handler
      expect(agentRepo.insertMessage).not.toHaveBeenCalled();
      expect(decisionHandler.handleDecisionSubmit).not.toHaveBeenCalled();
    });

    it('processes new messages normally', async () => {
      const envelope = makeEnvelope();
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(true);
      expect(agentRepo.insertMessage).toHaveBeenCalled();
      expect(decisionHandler.handleDecisionSubmit).toHaveBeenCalled();
    });

    it('returns idempotent success for duplicate even after session rotation', async () => {
      agentRepo.isMessageDuplicate.mockResolvedValue(true);
      // Session gate would reject if reached, but dedup runs first
      agentRepo.isActiveSession.mockResolvedValue(false);
      const envelope = makeEnvelope();
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(true);
      expect(agentRepo.isActiveSession).not.toHaveBeenCalled();
    });
  });

  describe('session-ownership gate', () => {
    it('rejects agent message from stale session', async () => {
      agentRepo.isActiveSession.mockResolvedValue(false);
      const envelope = makeEnvelope({ correlationId: 'stale-session-id' });
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(false);
      expect(result.error).toBe('stale_session');
    });

    it('exempts heartbeat from session gate', async () => {
      agentRepo.isActiveSession.mockResolvedValue(false);
      const envelope = makeEnvelope({
        type: 'agent.runtime.heartbeat',
        payload: { sessionId: 'sess-001', status: 'ready' },
      });
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(true);
      expect(agentRepo.isActiveSession).not.toHaveBeenCalled();
    });

    it('exempts session_ended from session gate', async () => {
      agentRepo.isActiveSession.mockResolvedValue(false);
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });
      const envelope = makeEnvelope({
        type: 'agent.runtime.session_ended',
        payload: { sessionId: 'sess-001', reasonCode: 'wall_clock_expired' },
      });
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(true);
      expect(agentRepo.isActiveSession).not.toHaveBeenCalled();
    });

    it('allows non-agent initiator messages without session check', async () => {
      const envelope = makeEnvelope({ initiatorType: 'user' });
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(true);
      expect(agentRepo.isActiveSession).not.toHaveBeenCalled();
    });
  });

  describe('message routing', () => {
    it('routes decision.submit to decisionHandler', async () => {
      const envelope = makeEnvelope({ type: 'agent.decision.submit' });
      await broker.processInbound(envelope);
      expect(decisionHandler.handleDecisionSubmit).toHaveBeenCalled();
    });

    it('routes heartbeat to sessionManager', async () => {
      const envelope = makeEnvelope({
        type: 'agent.runtime.heartbeat',
        payload: { sessionId: 'sess-001', status: 'ready' },
      });
      await broker.processInbound(envelope);
      expect((sessionManager as any).handleHeartbeat).toHaveBeenCalled();
    });

    it('routes pause request to sessionManager', async () => {
      const envelope = makeEnvelope({
        type: 'agent.lifecycle.pause_request',
        payload: { reason: 'User requested' },
      });
      await broker.processInbound(envelope);
      expect((sessionManager as any).handlePauseRequest).toHaveBeenCalled();
    });

    it('routes stop request to sessionManager', async () => {
      const envelope = makeEnvelope({
        type: 'agent.lifecycle.stop_request',
        payload: { reason: 'Done' },
      });
      await broker.processInbound(envelope);
      expect((sessionManager as any).handleStopRequest).toHaveBeenCalled();
    });

    it('handles runtime session ended by routing through session manager', async () => {
      const statusChange = vi.fn();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });
      const brokerWithStatus = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        statusChange,
      );
      const envelope = makeEnvelope({
        type: 'agent.runtime.session_ended',
        payload: { sessionId: 'sess-001', reasonCode: 'wall_clock_expired' },
      });

      const result = await brokerWithStatus.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect((sessionManager as any).handleRuntimeSessionEnd).toHaveBeenCalledWith('corr-001', 'agent-123', 'stopped');
      expect(agentRepo.markMessageProcessed).toHaveBeenCalledWith(envelope.messageId, 'processed');
    });

    it('routes session_ended with crash reason code through session manager as crashed', async () => {
      const statusChange = vi.fn();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'stopped' });
      const brokerWithStatus = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        statusChange,
      );

      const envelope = makeEnvelope({
        type: 'agent.runtime.session_ended',
        payload: { sessionId: 'sess-001', reasonCode: 'unexpected_error' },
      });

      const result = await brokerWithStatus.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect((sessionManager as any).handleRuntimeSessionEnd).toHaveBeenCalledWith('corr-001', 'agent-123', 'crashed');
      expect(agentRepo.markMessageProcessed).toHaveBeenCalledWith(envelope.messageId, 'processed');
    });

    it('routes publish_artifact using effective agent ownership for non-agent initiators', async () => {
      agentRepo.getAgent.mockImplementation(async (id: string) => (
        id === 'agent-123'
          ? { id: 'agent-123', userId: 'user-1', status: 'active', toolPolicy: null }
          : null
      ));

      const result = await broker.processInbound({
        schemaVersion: 'v1',
        messageId: 'msg-artifact-effective-agent',
        correlationId: 'corr-artifact-effective-agent',
        initiatorType: 'user',
        initiatorId: 'user-1',
        agentId: 'agent-123',
        type: 'agent.artifact.publish',
        createdAt: new Date().toISOString(),
        payload: {
          artifactId: 'artifact-1',
          artifactType: 'note',
          contentType: 'text/plain',
          summary: 'artifact summary',
        },
      });

      expect(result.accepted).toBe(true);
      expect(agentRepo.getAgent).toHaveBeenCalledWith('agent-123');
      expect(agentRepo.insertArtifact).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'agent-123',
        sessionId: 'sess-001',
      }));
    });

    it('routes bot_query using effective agent ownership for non-agent initiators', async () => {
      agentRepo.getAgent.mockImplementation(async (id: string) => (
        id === 'agent-123'
          ? { id: 'agent-123', userId: 'user-1', status: 'active', toolPolicy: null }
          : null
      ));
      const botRepo = {
        getBotsByCreator: vi.fn().mockResolvedValue([
          { id: 'bot-a', status: 'running', config: { strategy: { type: 'momentum', decisionMode: 'mechanical' }, symbol: 'BTC-USD' } },
        ]),
      };
      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
      );

      const result = await brokerWithBot.processInbound({
        schemaVersion: 'v1',
        messageId: 'msg-bot-query-effective-agent',
        correlationId: 'corr-bot-query-effective-agent',
        initiatorType: 'user',
        initiatorId: 'user-1',
        agentId: 'agent-123',
        type: 'agent.bot.query',
        createdAt: new Date().toISOString(),
        payload: { action: 'list_bots' },
      });

      expect(result.accepted).toBe(true);
      expect(agentRepo.getAgent).toHaveBeenCalledWith('agent-123');
      expect(botRepo.getBotsByCreator).toHaveBeenCalledWith('agent', 'agent-123', undefined);
    });
  });

  describe('message persistence', () => {
    it('persists envelope metadata before routing', async () => {
      const envelope = makeEnvelope({ messageId: 'msg-specific' });
      await broker.processInbound(envelope);
      expect(agentRepo.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-specific',
          correlationId: 'corr-001',
          actorType: 'agent',
          actorId: 'agent-123',
          botId: 'ti-456',
          type: 'agent.decision.submit',
          direction: 'inbound',
          schemaVersion: 'v1',
        }),
      );
    });

    it('marks message as processed on success', async () => {
      const envelope = makeEnvelope({ messageId: 'msg-success' });
      await broker.processInbound(envelope);
      expect(agentRepo.markMessageProcessed).toHaveBeenCalledWith('msg-success', 'processed');
    });

    it('marks message as failed on handler error', async () => {
      (decisionHandler.handleDecisionSubmit as any).mockRejectedValue(new Error('Engine crash'));
      const envelope = makeEnvelope({ messageId: 'msg-fail' });
      const result = await broker.processInbound(envelope);
      expect(result.accepted).toBe(false);
      expect(agentRepo.markMessageProcessed).toHaveBeenCalledWith(
        'msg-fail',
        'failed',
        expect.objectContaining({ code: 'processing_error' }),
      );
    });
  });

  describe('capability cache invalidation (CX.1)', () => {
    function makeManageBotEnvelope(overrides: Record<string, unknown> = {}) {
      return {
        schemaVersion: 'v1',
        messageId: `msg-${Math.random().toString(36).slice(2)}`,
        correlationId: 'corr-001',
        initiatorType: 'agent',
        initiatorId: 'agent-123',
        agentId: 'agent-123',
        type: 'agent.manage_bot',
        createdAt: new Date().toISOString(),
        payload: {
          action: 'create_and_start',
          connectionId: 'binding-1',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: { type: 'momentum', decisionMode: 'mechanical' }, venueType: 'orderbook' },
        },
        ...overrides,
      };
    }

    const mockDbSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }]),
        }),
      }),
    });

    function makeBotRepo() {
      return {
        db: { select: mockDbSelect },
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        tryCreateBotWithLimit: vi.fn().mockResolvedValue({ created: true, botId: 'bot-new-001' }),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([]),
        getVenueAccountById: vi.fn().mockResolvedValue({ id: 'va-001', venue: 'hyperliquid', userId: 'user-1' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }),
      };
    }

    // toolPolicy values must include the `capability` key so they key into the grant Map correctly
    const MANAGE_BOT_ENABLED = { capability: 'manage_bot', tier: 'brokered', enabled: true, limits: { maxPerMinute: 5, maxConcurrent: 1, timeoutMs: 30_000 } };
    const MANAGE_BOT_DISABLED = { capability: 'manage_bot', tier: 'brokered', enabled: false, limits: { maxPerMinute: 5, maxConcurrent: 1, timeoutMs: 30_000 } };

    it('uses cached engine when toolPolicy is unchanged', async () => {
      const policy = { manage_bot: MANAGE_BOT_ENABLED };
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123',
        userId: 'user-1',
        status: 'active',
        maxBots: 5,
        toolPolicy: policy,
      });
      agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });

      const botRepo = makeBotRepo();
      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        vi.fn().mockResolvedValue(undefined),
      );

      const e1 = makeManageBotEnvelope();
      const e2 = makeManageBotEnvelope();

      await brokerWithBot.processInbound(e1);

      // Capture the engine instance after the first request.
      const capEngines = (brokerWithBot as any).capabilityEngines as Map<string, { engine: CapabilityPolicyEngine; policySig: string }>;
      const engineAfterFirst = capEngines.get('agent-123')!.engine;

      await brokerWithBot.processInbound(e2);

      const engineAfterSecond = capEngines.get('agent-123')!.engine;

      // Strict object identity proves reuse. If the engine were rebuilt and the map entry
      // overwritten, this would be a different reference even though policySig looks identical.
      expect(engineAfterSecond).toBe(engineAfterFirst);
      // Both requests succeeded (createBot called twice confirms neither was denied)
      expect(botRepo.tryCreateBotWithLimit).toHaveBeenCalledTimes(2);
    });

    it('rebuilds engine when toolPolicy changes between calls', async () => {
      const policyV1 = { manage_bot: MANAGE_BOT_ENABLED };
      const policyV2 = { manage_bot: MANAGE_BOT_DISABLED };

      agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });

      const botRepo = makeBotRepo();
      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        vi.fn().mockResolvedValue(undefined),
      );

      // First call: policy v1 — manage_bot enabled → should be accepted
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5, toolPolicy: policyV1,
      });
      const e1 = makeManageBotEnvelope();
      const result1 = await brokerWithBot.processInbound(e1);
      expect(result1.accepted).toBe(true);

      // Second call: policy v2 — manage_bot disabled → should be denied
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5, toolPolicy: policyV2,
      });
      const e2 = makeManageBotEnvelope();
      const result2 = await brokerWithBot.processInbound(e2);
      expect(result2.accepted).toBe(false);
      expect(result2.error).toMatch(/capability_denied/);
    });

    it('denies manage_bot when agent has no toolPolicy override (default is disabled)', async () => {
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5, toolPolicy: null,
      });
      agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });

      const botRepo = makeBotRepo();
      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        vi.fn().mockResolvedValue(undefined),
      );

      // manage_bot is disabled in DEFAULT_CAPABILITY_GRANTS — no override → denied
      const e1 = makeManageBotEnvelope();
      const result = await brokerWithBot.processInbound(e1);
      expect(result.accepted).toBe(false);
      expect(result.error).toMatch(/capability_denied/);
      expect(botRepo.tryCreateBotWithLimit).not.toHaveBeenCalled();
    });
  });

  describe('manage_bot emits instance status with bot list (R3.2)', () => {
    function makeManageBotEnvelope(overrides: Record<string, unknown> = {}) {
      return {
        schemaVersion: 'v1',
        messageId: `msg-${Math.random().toString(36).slice(2)}`,
        correlationId: 'corr-001',
        initiatorType: 'agent',
        initiatorId: 'agent-123',
        agentId: 'agent-123',
        type: 'agent.manage_bot',
        createdAt: new Date().toISOString(),
        payload: {
          action: 'create_and_start',
          connectionId: 'binding-1',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: { type: 'momentum', decisionMode: 'mechanical' }, venueType: 'orderbook' },
        },
        ...overrides,
      };
    }

    const instanceStatusDbMock = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }]),
          }),
        }),
      }),
    };

    describe('bot_query emits tool results', () => {
      it('emits a bot list result', async () => {
        const botRepo = {
          getBotsByCreator: vi.fn().mockResolvedValue([
            { id: 'bot-a', status: 'running', config: { strategy: { type: 'momentum', decisionMode: 'mechanical' }, symbol: 'BTC-USD' } },
            { id: 'bot-b', status: 'stopped', config: { strategy: { type: 'scalper', decisionMode: 'mechanical' }, symbol: 'ETH-USD' } },
          ]),
        };

        const brokerWithBot = new AgentMessageBroker(
          {} as any,
          agentRepo as any,
          decisionHandler,
          sessionManager,
          eventPublisher,
          undefined,
          botRepo as any,
        );

        const result = await brokerWithBot.processInbound({
          schemaVersion: 'v1',
          messageId: 'msg-query-1',
          correlationId: 'corr-query-1',
          initiatorType: 'agent',
          initiatorId: 'agent-123',
          agentId: 'agent-123',
          type: 'agent.bot.query',
          createdAt: new Date().toISOString(),
          payload: { action: 'list_bots' },
        });

        expect(result.accepted).toBe(true);
        expect((eventPublisher as any).emitToolResult).toHaveBeenCalledWith(
          'agent-123',
          expect.objectContaining({
            tool: 'list_bots',
            status: 'ok',
            message: 'Found 2 bot(s)',
            data: expect.objectContaining({
              ok: true,
              bots: [
                expect.objectContaining({ id: 'bot-a', status: 'running', strategyPreset: 'momentum', symbol: 'BTC-USD' }),
                expect.objectContaining({ id: 'bot-b', status: 'stopped', strategyPreset: 'scalper', symbol: 'ETH-USD' }),
              ],
            }),
          }),
        );
      });

      it('passes the time filter through for list_bots', async () => {
        const botRepo = {
          getBotsByCreator: vi.fn().mockResolvedValue([]),
        };

        const brokerWithBot = new AgentMessageBroker(
          {} as any,
          agentRepo as any,
          decisionHandler,
          sessionManager,
          eventPublisher,
          undefined,
          botRepo as any,
        );

        await brokerWithBot.processInbound({
          schemaVersion: 'v1',
          messageId: 'msg-query-2',
          correlationId: 'corr-query-2',
          initiatorType: 'agent',
          initiatorId: 'agent-123',
          agentId: 'agent-123',
          type: 'agent.bot.query',
          createdAt: new Date().toISOString(),
          payload: { action: 'list_bots', days: 7 },
        });

        expect(botRepo.getBotsByCreator).toHaveBeenCalledWith('agent', 'agent-123', expect.any(Date));
      });

      it('emits an error result when get_bot_status botId is not owned', async () => {
        const botRepo = {
          getBotById: vi.fn().mockResolvedValue({
            id: 'bot-private',
            userId: 'user-2',
            status: 'running',
            venueAccountId: 'va-001',
            config: {},
          }),
        };

        const brokerWithBot = new AgentMessageBroker(
          {} as any,
          agentRepo as any,
          decisionHandler,
          sessionManager,
          eventPublisher,
          undefined,
          botRepo as any,
        );

        const result = await brokerWithBot.processInbound({
          schemaVersion: 'v1',
          messageId: 'msg-query-3',
          correlationId: 'corr-query-3',
          initiatorType: 'agent',
          initiatorId: 'agent-123',
          agentId: 'agent-123',
          type: 'agent.bot.query',
          createdAt: new Date().toISOString(),
          payload: { action: 'get_bot_status', botId: 'bot-private' },
        });

        expect(result.accepted).toBe(true);
        expect((eventPublisher as any).emitToolResult).toHaveBeenCalledWith(
          'agent-123',
          expect.objectContaining({
            tool: 'get_bot_status',
            status: 'error',
            message: expect.stringContaining('not owned by this agent'),
            botId: 'bot-private',
          }),
        );
      });

      it('emits get_analytics using the tool contract and default 7-day lookback', async () => {
        const botRepo = {
          getAnalyticsByCreator: vi.fn().mockResolvedValue({
            botCount: 1,
            openPositions: 2,
            closedPositions: 3,
            winningPositions: 2,
            realizedPnlUsd: '45.00',
            totalFeesUsd: '2.10',
            recentFills: 8,
            avgHoldTimeHours: 4.5,
            byBot: [{ botId: 'bot-1', status: 'running', recentFills: 5, realizedPnlUsd: '30.00' }],
            agentDirect: { recentFills: 3, realizedPnlUsd: '15.00' },
          }),
        };

        const brokerWithBot = new AgentMessageBroker(
          {} as any,
          agentRepo as any,
          decisionHandler,
          sessionManager,
          eventPublisher,
          undefined,
          botRepo as any,
        );

        const result = await brokerWithBot.processInbound({
          schemaVersion: 'v1',
          messageId: 'msg-query-4',
          correlationId: 'corr-query-4',
          initiatorType: 'agent',
          initiatorId: 'agent-123',
          agentId: 'agent-123',
          type: 'agent.bot.query',
          createdAt: new Date().toISOString(),
          payload: { action: 'get_analytics' },
        });

        expect(result.accepted).toBe(true);
        expect(botRepo.getAnalyticsByCreator).toHaveBeenCalledWith('agent', 'agent-123', expect.any(Date), undefined);
        expect((eventPublisher as any).emitToolResult).toHaveBeenCalledWith(
          'agent-123',
          expect.objectContaining({
            tool: 'get_analytics',
            status: 'ok',
            message: 'Analytics summary ready',
            data: {
              ok: true,
              totalTrades: 8,
              winRate: 66.67,
              realizedPnlUsd: '45.00',
              totalFeesUsd: '2.10',
              openPositions: 2,
              botCount: 1,
              avgHoldTimeHours: 4.5,
              byBot: [{ botId: 'bot-1', status: 'running', recentFills: 5, realizedPnlUsd: '30.00' }],
              agentDirect: { recentFills: 3, realizedPnlUsd: '15.00' },
              days: 7,
            },
          }),
        );
      });

      it('emits list_positions using the tool contract with explicit ownership fields', async () => {
        const botRepo = {
          getOpenPositionsByCreator: vi.fn().mockResolvedValue([
            {
              actorType: 'agent',
              actorId: 'agent-123',
              symbol: 'SOL',
              side: 'long',
              size: '50',
              entryPrice: '67.917',
              openedAt: new Date('2026-06-13T12:55:00.000Z'),
            },
          ]),
        };

        const brokerWithBot = new AgentMessageBroker(
          {} as any,
          agentRepo as any,
          decisionHandler,
          sessionManager,
          eventPublisher,
          undefined,
          botRepo as any,
        );

        const result = await brokerWithBot.processInbound({
          schemaVersion: 'v1',
          messageId: 'msg-query-5',
          correlationId: 'corr-query-5',
          initiatorType: 'agent',
          initiatorId: 'agent-123',
          agentId: 'agent-123',
          type: 'agent.bot.query',
          createdAt: new Date().toISOString(),
          payload: { action: 'list_positions' },
        });

        expect(result.accepted).toBe(true);
        expect((eventPublisher as any).emitToolResult).toHaveBeenCalledWith(
          'agent-123',
          expect.objectContaining({
            tool: 'list_positions',
            status: 'ok',
            message: 'Found 1 open position(s)',
            data: {
              ok: true,
              note: 'unrealizedPnl not available — mark prices are not cached in the agent process',
              positions: [
                {
                  actorType: 'agent',
                  actorId: 'agent-123',
                  botId: null,
                  instrumentId: 'SOL',
                  side: 'long',
                  size: '50',
                  entryPrice: '67.917',
                  openedAt: '2026-06-13T12:55:00.000Z',
                },
              ],
            },
          }),
        );
      });

      it('rejects bot_query payloads with days above the shared 90-day limit', async () => {
        const result = await broker.processInbound({
          schemaVersion: 'v1',
          messageId: 'msg-query-6',
          correlationId: 'corr-query-6',
          initiatorType: 'agent',
          initiatorId: 'agent-123',
          agentId: 'agent-123',
          type: 'agent.bot.query',
          createdAt: new Date().toISOString(),
          payload: { action: 'get_analytics', days: 365 },
        });

        expect(result.accepted).toBe(false);
        expect(result.error).toBe('invalid_payload');
      });
    });

    const MANAGE_BOT_ENABLED_GRANT = { capability: 'manage_bot', tier: 'brokered', enabled: true, limits: { maxPerMinute: 5, maxConcurrent: 1, timeoutMs: 30_000 } };

    beforeEach(() => {
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123',
        userId: 'user-1',
        status: 'active',
        maxBots: 5,
        toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
      });
      agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });
      agentRepo.getRuntimeCapabilityDescriptor.mockResolvedValue(makeTradingCapabilityDescriptor());
    });

    it('emits instance status with bot list after create_and_start', async () => {
      const botRepo = {
        db: instanceStatusDbMock,
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        tryCreateBotWithLimit: vi.fn().mockResolvedValue({ created: true, botId: 'bot-abc' }),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([
          { id: 'bot-abc', status: 'running', config: { strategy: { type: 'momentum', decisionMode: 'mechanical' }, symbol: 'BTC-USD' } },
        ]),
        getVenueAccountById: vi.fn().mockResolvedValue({ id: 'va-001', venue: 'hyperliquid', userId: 'user-1' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }),
      };

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        vi.fn().mockResolvedValue(undefined),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope());
      expect(result.accepted).toBe(true);

      expect((eventPublisher as any).emitInstanceStatus).toHaveBeenCalledWith(
        'agent-123',
        expect.objectContaining({
          status: 'running',
          reason: 'bot_created',
          managedBots: [
            expect.objectContaining({ id: 'bot-abc', status: 'running', strategyPreset: 'momentum', symbol: 'BTC-USD' }),
          ],
        }),
      );
    });

    it('emits instance status with empty bot list when agent has no bots', async () => {
      const botRepo = {
        db: instanceStatusDbMock,
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        tryCreateBotWithLimit: vi.fn().mockResolvedValue({ created: true, botId: 'bot-xyz' }),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([]),
        getVenueAccountById: vi.fn().mockResolvedValue({ id: 'va-001', venue: 'hyperliquid', userId: 'user-1' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }),
      };

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        vi.fn().mockResolvedValue(undefined),
      );

      await brokerWithBot.processInbound(makeManageBotEnvelope());

      expect((eventPublisher as any).emitInstanceStatus).toHaveBeenCalledWith(
        'agent-123',
        expect.objectContaining({ managedBots: [] }),
      );
    });

    it('emits bot with undefined strategyPreset when config has none', async () => {
      const botRepo = {
        db: instanceStatusDbMock,
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        tryCreateBotWithLimit: vi.fn().mockResolvedValue({ created: true, botId: 'bot-min' }),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([
          { id: 'bot-min', status: 'stopped', config: {} },
        ]),
        getVenueAccountById: vi.fn().mockResolvedValue({ id: 'va-001', venue: 'hyperliquid', userId: 'user-1' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }),
      };

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        vi.fn().mockResolvedValue(undefined),
      );

      await brokerWithBot.processInbound(makeManageBotEnvelope());

      const call = (eventPublisher as any).emitInstanceStatus.mock.calls[0];
      expect(call[1].managedBots[0].strategyPreset).toBeUndefined();
      expect(call[1].managedBots[0].symbol).toBeUndefined();
    });

    it('uses the requested connection by connectionId when provided', async () => {
      agentRepo.getRuntimeCapabilityDescriptor.mockResolvedValue(makeTradingCapabilityDescriptor({
        grantedConnectionsByFamily: {
          trading: [
            {
              connectionId: 'binding-1',
              resolvedVenueAccountId: 'va-001',
              provider: 'hyperliquid',
              readiness: { effectiveReady: true },
            },
            {
              connectionId: 'binding-2',
              resolvedVenueAccountId: 'va-002',
              provider: 'hyperliquid',
              readiness: { effectiveReady: true },
            },
          ],
        },
        defaultConnectionByFamily: { trading: 'binding-1' },
      }));

      const mockDbV2 = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ resolvedVenueAccountId: 'va-002', venue: 'hyperliquid' }]),
            }),
          }),
        }),
      };

      const botRepo = {
        db: mockDbV2,
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        tryCreateBotWithLimit: vi.fn().mockResolvedValue({ created: true, botId: 'bot-targeted' }),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([]),
        getVenueAccountById: vi.fn().mockResolvedValue({ id: 'va-002', venue: 'hyperliquid', userId: 'user-1' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-002', venue: 'hyperliquid' }),
      };
      const botStart = vi.fn().mockResolvedValue(undefined);

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        botStart,
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          connectionId: 'binding-2',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: { type: 'momentum', decisionMode: 'mechanical' }, venueType: 'orderbook' },
        },
      }));

      expect(result.accepted).toBe(true);
      expect(botRepo.isConnectionOwnedBy).toHaveBeenCalledWith('binding-2', 'user-1');
      expect(botRepo.tryCreateBotWithLimit).toHaveBeenCalledWith(expect.objectContaining({
        connectionId: 'binding-2',
        venueAccountId: 'va-002',
      }));
      expect(botStart).toHaveBeenCalledWith('bot-targeted', 'user-1', 'binding-2', expect.objectContaining({
        venueAccountId: 'va-002',
      }));
    });

    it('resolves the connection by connectionId when provided', async () => {
      agentRepo.getRuntimeCapabilityDescriptor.mockResolvedValue(makeTradingCapabilityDescriptor({
        grantedConnectionsByFamily: {
          trading: [
            {
              connectionId: 'binding-1',
              resolvedVenueAccountId: 'va-001',
              readiness: { effectiveReady: true },
            },
            {
              connectionId: 'binding-2',
              resolvedVenueAccountId: 'va-002',
              readiness: { effectiveReady: true },
            },
          ],
        },
        defaultConnectionByFamily: { trading: 'binding-1' },
      }));

      const mockDbByConn = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ resolvedVenueAccountId: 'va-002', venue: 'hyperliquid' }]),
            }),
          }),
        }),
      };

      const botRepo = {
        db: mockDbByConn,
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        tryCreateBotWithLimit: vi.fn().mockResolvedValue({ created: true, botId: 'bot-by-connectionid' }),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([]),
        getVenueAccountById: vi.fn().mockResolvedValue({ id: 'va-002', venue: 'hyperliquid', userId: 'user-1' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-002', venue: 'hyperliquid' }),
      };
      const botStart = vi.fn().mockResolvedValue(undefined);

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        botStart,
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          connectionId: 'binding-2',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: { type: 'momentum', decisionMode: 'mechanical' }, venueType: 'orderbook' },
        },
      }));

      expect(result.accepted).toBe(true);
      expect(botRepo.tryCreateBotWithLimit).toHaveBeenCalledWith(expect.objectContaining({
        connectionId: 'binding-2',
        venueAccountId: 'va-002',
      }));
    });

    it('rejects when connectionId does not match any granted connection', async () => {
      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        tryCreateBotWithLimit: vi.fn().mockResolvedValue({ created: true, botId: 'bot-never' }),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([]),
      };

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        vi.fn().mockResolvedValue(undefined),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          connectionId: 'nonexistent',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: { type: 'momentum', decisionMode: 'mechanical' }, venueType: 'orderbook' },
        },
      }));

      expect(result.accepted).toBe(false);
      expect(result.error).toMatch(/no trading capability connection found with connectionid nonexistent/i);
      expect(botRepo.tryCreateBotWithLimit).not.toHaveBeenCalled();
    });

    it('uses the default connection when no connectionId is provided', async () => {
      agentRepo.getRuntimeCapabilityDescriptor.mockResolvedValue(makeTradingCapabilityDescriptor({
        grantedConnectionsByFamily: {
          trading: [
            {
              connectionId: 'binding-1',
              resolvedVenueAccountId: 'va-001',
              readiness: { effectiveReady: true },
            },
            {
              connectionId: 'binding-2',
              resolvedVenueAccountId: 'va-002',
              readiness: { effectiveReady: true },
            },
          ],
        },
        defaultConnectionByFamily: { trading: 'binding-2' },
      }));

      const mockDbDefault = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ resolvedVenueAccountId: 'va-002', venue: 'hyperliquid' }]),
            }),
          }),
        }),
      };

      const botRepo = {
        db: mockDbDefault,
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        tryCreateBotWithLimit: vi.fn().mockResolvedValue({ created: true, botId: 'bot-default' }),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([]),
        getVenueAccountById: vi.fn().mockResolvedValue({ id: 'va-002', venue: 'hyperliquid', userId: 'user-1' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-002', venue: 'hyperliquid' }),
      };
      const botStart = vi.fn().mockResolvedValue(undefined);

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        botStart,
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: { type: 'momentum', decisionMode: 'mechanical' }, venueType: 'orderbook' },
        },
      }));

      expect(result.accepted).toBe(true);
      expect(botRepo.tryCreateBotWithLimit).toHaveBeenCalledWith(expect.objectContaining({
        connectionId: 'binding-2',
        venueAccountId: 'va-002',
      }));
    });

    it('falls back to default connection when no connectionId is provided', async () => {
      agentRepo.getRuntimeCapabilityDescriptor.mockResolvedValue(makeTradingCapabilityDescriptor({
        grantedConnectionsByFamily: {
          trading: [
            {
              connectionId: 'binding-1',
              resolvedVenueAccountId: 'va-002',
              provider: 'hyperliquid',
              readiness: { effectiveReady: true },
            },
            {
              connectionId: 'binding-2',
              resolvedVenueAccountId: 'va-002',
              provider: 'hyperliquid',
              readiness: { effectiveReady: true },
            },
          ],
        },
        defaultConnectionByFamily: { trading: 'binding-1' },
      }));

      const mockDbAmbiguous = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ resolvedVenueAccountId: 'va-002', venue: 'hyperliquid' }]),
            }),
          }),
        }),
      };

      const botRepo = {
        db: mockDbAmbiguous,
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        tryCreateBotWithLimit: vi.fn().mockResolvedValue({ created: true, botId: 'bot-ambiguous' }),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([]),
        getVenueAccountById: vi.fn().mockResolvedValue({ id: 'va-002', venue: 'hyperliquid', userId: 'user-1' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-002', venue: 'hyperliquid' }),
      };

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        vi.fn().mockResolvedValue(undefined),
      );

      // No connectionId provided — broker falls back to default connection
      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: { type: 'momentum', decisionMode: 'mechanical' }, venueType: 'orderbook' },
        },
      }));

      expect(result.accepted).toBe(true);
      expect(botRepo.tryCreateBotWithLimit).toHaveBeenCalledWith(expect.objectContaining({
        connectionId: 'binding-1',
        venueAccountId: 'va-002',
      }));
    });

    it('rejects create_and_start when resolved binding is not owned by agent user', async () => {
      const mockDbNotOwned = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }]),
            }),
          }),
        }),
      };

      const botRepo = {
        db: mockDbNotOwned,
        isConnectionOwnedBy: vi.fn().mockResolvedValue(false),
        tryCreateBotWithLimit: vi.fn().mockResolvedValue({ created: true, botId: 'bot-never' }),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([]),
      };

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        vi.fn().mockResolvedValue(undefined),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope());
      expect(result.accepted).toBe(false);
      expect(botRepo.tryCreateBotWithLimit).not.toHaveBeenCalled();
      expect((eventPublisher as any).emitInstanceStatus).not.toHaveBeenCalled();
    });

    it('rejects create_and_start when agent has reached maxBots limit', async () => {
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 2,
        toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
      });

      const mockDbMaxBots = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }]),
            }),
          }),
        }),
      };

      const botRepo = {
        db: mockDbMaxBots,
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        countRunningBotsByCreator: vi.fn().mockResolvedValue(2), // at limit
        tryCreateBotWithLimit: vi.fn().mockResolvedValue({ created: true, botId: 'bot-over' }),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([]),
      };

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        vi.fn().mockResolvedValue(undefined),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope());
      expect(result.accepted).toBe(false);
      expect(botRepo.tryCreateBotWithLimit).not.toHaveBeenCalled();
    });

    it('clamps create_and_start risk.maxOrderNotional to the agent capital limit', async () => {
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123',
        userId: 'user-1',
        status: 'active',
        maxBots: 5,
        capital: '1000',
        toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
      });

      const mockDbCap = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }]),
            }),
          }),
        }),
      };

      const botRepo = {
        db: mockDbCap,
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        tryCreateBotWithLimit: vi.fn().mockResolvedValue({ created: true, botId: 'bot-cap' }),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([]),
        getVenueAccountById: vi.fn().mockResolvedValue({ id: 'va-001', venue: 'hyperliquid', userId: 'user-1' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }),
      };
      const botStart = vi.fn().mockResolvedValue(undefined);

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        botStart,
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          venueAccountId: 'va-001',
          config: {
            venue: 'hyperliquid',
            symbol: 'BTC-USD',
            strategy: { type: 'momentum', decisionMode: 'mechanical' },
            venueType: 'orderbook',
            risk: { maxDrawdownPct: 10, maxOrderNotional: '2500' },
          },
        },
      }));

      expect(result.accepted).toBe(true);
      // maxDrawdownPct is not a RiskConfigSchema field — it is stripped by
      // BotConfigSchema.safeParse() validation. The capital clamp on
      // maxOrderNotional (2500 → 1000) is what this test cares about.
      expect(botRepo.tryCreateBotWithLimit).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({
          risk: expect.objectContaining({ maxOrderNotional: '1000' }),
        }),
      }));
      expect(botStart).toHaveBeenCalledWith(
        'bot-cap',
        'user-1',
        'binding-1',
        expect.objectContaining({
          risk: expect.objectContaining({ maxOrderNotional: '1000' }),
          venueAccountId: 'va-001',
        }),
      );
    });

    it('enqueues a stop job for stop_bot', async () => {
      const botRepo = {
        getBotById: vi.fn().mockResolvedValue({
          id: 'bot-stop',
          userId: 'user-1',
          venueAccountId: 'va-001',
          status: 'running',
          config: {},
          creatorType: 'agent',
          creatorId: 'agent-123',
        }),
      };
      const botStop = vi.fn().mockResolvedValue(undefined);

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        vi.fn().mockResolvedValue(undefined),
        undefined,
        undefined,
        botStop,
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: { action: 'stop', botId: 'bot-stop' },
      }));

      expect(result.accepted).toBe(true);
      expect(botStop).toHaveBeenCalledWith('bot-stop', 'user-1');
    });

    it('restores prior runtime state when start enqueue fails', async () => {
      const botRepo = {
        getBotById: vi.fn().mockResolvedValue({
          id: 'bot-start',
          userId: 'user-1',
          connectionId: 'binding-1',
          venueAccountId: 'va-001',
          status: 'stopped',
          startedAt: null,
          stoppedAt: new Date('2026-06-01T00:00:00.000Z'),
          config: { strategy: { type: 'dca' }, symbol: 'ETH/USDC' },
          creatorType: 'agent',
          creatorId: 'agent-123',
        }),
        updateBotConfig: vi.fn().mockResolvedValue(undefined),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        restoreBotRuntimeState: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([]),
      };
      const botStart = vi.fn().mockRejectedValue(new Error('Redis connection refused'));

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        botStart,
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: { action: 'start', botId: 'bot-start' },
      }));

      expect(result.accepted).toBe(false);
      expect(botRepo.tryMarkBotRunningWithLimit).toHaveBeenCalledWith('bot-start', 'agent', 'agent-123', 5);
      expect(botRepo.restoreBotRuntimeState).toHaveBeenCalledWith({
        botId: 'bot-start',
        status: 'stopped',
        startedAt: null,
        stoppedAt: new Date('2026-06-01T00:00:00.000Z'),
      });
    });

    it('reapplies the agent capital clamp before starting an existing bot', async () => {
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123',
        userId: 'user-1',
        status: 'active',
        maxBots: 5,
        capital: '750',
        toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
      });

      const botRepo = {
        getBotById: vi.fn().mockResolvedValue({
          id: 'bot-start',
          userId: 'user-1',
          connectionId: 'binding-1',
          venueAccountId: 'va-001',
          status: 'stopped',
          startedAt: null,
          stoppedAt: new Date('2026-06-01T00:00:00.000Z'),
          config: { strategy: { type: 'dca' }, risk: { maxOrderNotional: '1500', maxDrawdownPct: 10 }, symbol: 'ETH/USDC' },
          creatorType: 'agent',
          creatorId: 'agent-123',
        }),
        updateBotConfig: vi.fn().mockResolvedValue(undefined),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        restoreBotRuntimeState: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([]),
      };
      const botStart = vi.fn().mockResolvedValue(undefined);

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        botStart,
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: { action: 'start', botId: 'bot-start' },
      }));

      expect(result.accepted).toBe(true);
      expect(botRepo.updateBotConfig).toHaveBeenCalledWith('bot-start', {
        strategy: { type: 'dca' }, risk: { maxOrderNotional: '750', maxDrawdownPct: 10 }, symbol: 'ETH/USDC',
      });
      expect(botStart).toHaveBeenCalledWith('bot-start', 'user-1', 'binding-1', {
        strategy: { type: 'dca' }, risk: { maxOrderNotional: '750', maxDrawdownPct: 10 }, symbol: 'ETH/USDC',
      });
    });

    it('still fails gracefully when start enqueue AND rollback both fail', async () => {
      const botRepo = {
        getBotById: vi.fn().mockResolvedValue({
          id: 'bot-start',
          userId: 'user-1',
          connectionId: 'binding-1',
          venueAccountId: 'va-001',
          status: 'stopped',
          startedAt: null,
          stoppedAt: new Date('2026-06-01T00:00:00.000Z'),
          config: { strategy: { type: 'dca' }, symbol: 'ETH/USDC' },
          creatorType: 'agent',
          creatorId: 'agent-123',
        }),
        updateBotConfig: vi.fn().mockResolvedValue(undefined),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        restoreBotRuntimeState: vi.fn().mockRejectedValue(new Error('DB also down')),
      };
      const botStart = vi.fn().mockRejectedValue(new Error('Redis connection refused'));

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        botStart,
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: { action: 'start', botId: 'bot-start' },
      }));

      expect(result.accepted).toBe(false);
      expect(botRepo.restoreBotRuntimeState).toHaveBeenCalled();
    });

    it('merges config and restarts a running bot for adjust_bot_config', async () => {
      const botRepo = {
        getBotById: vi.fn().mockResolvedValue({
          id: 'bot-run',
          userId: 'user-1',
          connectionId: 'binding-1',
          venueAccountId: 'va-001',
          status: 'running',
          config: {
            strategy: { type: 'momentum', decisionMode: 'mechanical', threshold: 2 },
            risk: { maxDrawdownPct: 10 },
            symbol: 'BTC-USD',
            venue: 'hyperliquid',
            venueType: 'orderbook',
          },
          creatorType: 'agent',
          creatorId: 'agent-123',
        }),
        updateBotConfig: vi.fn().mockResolvedValue(undefined),
      };
      const botRestart = vi.fn().mockResolvedValue(undefined);

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        vi.fn().mockResolvedValue(undefined),
        undefined,
        undefined,
        undefined,
        botRestart,
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'adjust_config',
          botId: 'bot-run',
          config: { strategy: { threshold: 5 }, executionMode: 'shadow' },
        },
      }));

      expect(result.accepted).toBe(true);
      expect(botRepo.updateBotConfig).toHaveBeenCalledWith('bot-run', expect.objectContaining({
        strategy: expect.objectContaining({ type: 'momentum', threshold: 5 }),
        risk: expect.objectContaining({ maxDrawdownPct: 10 }),
        executionMode: 'shadow',
      }));
      expect(botRestart).toHaveBeenCalledWith('bot-run', 'user-1', 'binding-1', expect.objectContaining({
        strategy: expect.objectContaining({ type: 'momentum', threshold: 5 }),
        risk: expect.objectContaining({ maxDrawdownPct: 10 }),
        executionMode: 'shadow',
      }));
    });

    it('clamps adjusted risk.maxOrderNotional to agent capital', async () => {
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123',
        userId: 'user-1',
        status: 'active',
        maxBots: 5,
        capital: '750',
        toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
      });

      const botRepo = {
        getBotById: vi.fn().mockResolvedValue({
          id: 'bot-run',
          userId: 'user-1',
          venueAccountId: 'va-001',
          connectionId: 'binding-1',
          status: 'running',
          config: {
            strategy: { type: 'momentum', decisionMode: 'mechanical', threshold: 2 },
            risk: { maxDrawdownPct: 10, maxOrderNotional: '2000' },
            symbol: 'BTC-USD',
            venue: 'hyperliquid',
            venueType: 'orderbook',
          },
          creatorType: 'agent',
          creatorId: 'agent-123',
        }),
        updateBotConfig: vi.fn().mockResolvedValue(undefined),
      };
      const botRestart = vi.fn().mockResolvedValue(undefined);

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,
        botRepo as any,
        vi.fn().mockResolvedValue(undefined),
        undefined,
        undefined,
        undefined,
        botRestart,
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'adjust_config',
          botId: 'bot-run',
          config: { risk: { maxOrderNotional: '1500' } },
        },
      }));

      expect(result.accepted).toBe(true);
      expect(botRepo.updateBotConfig).toHaveBeenCalledWith('bot-run', expect.objectContaining({
        strategy: expect.objectContaining({ type: 'momentum', threshold: 2 }),
        risk: expect.objectContaining({ maxDrawdownPct: 10, maxOrderNotional: '750' }),
      }));
      expect(botRestart).toHaveBeenCalledWith('bot-run', 'user-1', 'binding-1', expect.objectContaining({
        strategy: expect.objectContaining({ type: 'momentum', threshold: 2 }),
        risk: expect.objectContaining({ maxDrawdownPct: 10, maxOrderNotional: '750' }),
      }));
    });

    describe('adjust_config rollback', () => {
      it('restores the prior config when restart enqueue fails', async () => {
        const botRepo = {
          getBotById: vi.fn().mockResolvedValue({
            id: 'bot-run',
            userId: 'user-1',
            venueAccountId: 'va-001',
            status: 'running',
            config: {
              strategy: { type: 'momentum', decisionMode: 'mechanical', threshold: 2 },
              risk: { maxDrawdownPct: 10 },
              symbol: 'BTC-USD',
              venue: 'hyperliquid',
              venueType: 'orderbook',
            },
            creatorType: 'agent',
            creatorId: 'agent-123',
          }),
          updateBotConfig: vi.fn().mockResolvedValue(undefined),
          restoreBotConfig: vi.fn().mockResolvedValue(undefined),
        };
        const botRestart = vi.fn().mockRejectedValue(new Error('Redis connection refused'));

        const brokerWithBot = new AgentMessageBroker(
          {} as any,
          agentRepo as any,
          decisionHandler,
          sessionManager,
          eventPublisher,
          undefined,
          botRepo as any,
          vi.fn().mockResolvedValue(undefined),
          undefined,
          undefined,
          undefined,
          botRestart,
        );

        const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
          payload: {
            action: 'adjust_config',
            botId: 'bot-run',
            config: { strategy: { threshold: 5 } },
          },
        }));

        expect(result.accepted).toBe(false);
        expect(botRepo.updateBotConfig).toHaveBeenCalledWith('bot-run', expect.objectContaining({
          strategy: expect.objectContaining({ threshold: 5 }),
        }));
        expect(botRepo.restoreBotConfig).toHaveBeenCalledWith('bot-run', expect.objectContaining({
          strategy: expect.objectContaining({ threshold: 2 }),
        }));
      });

      it('still fails gracefully when restart enqueue AND config rollback both fail', async () => {
        const botRepo = {
          getBotById: vi.fn().mockResolvedValue({
            id: 'bot-run',
            userId: 'user-1',
            venueAccountId: 'va-001',
            status: 'running',
            config: {
              strategy: { type: 'momentum', decisionMode: 'mechanical', threshold: 2 },
              risk: { maxDrawdownPct: 10 },
              symbol: 'BTC-USD',
              venue: 'hyperliquid',
              venueType: 'orderbook',
            },
            creatorType: 'agent',
            creatorId: 'agent-123',
          }),
          updateBotConfig: vi.fn().mockResolvedValue(undefined),
          restoreBotConfig: vi.fn().mockRejectedValue(new Error('DB also down')),
        };
        const botRestart = vi.fn().mockRejectedValue(new Error('Redis connection refused'));

        const brokerWithBot = new AgentMessageBroker(
          {} as any,
          agentRepo as any,
          decisionHandler,
          sessionManager,
          eventPublisher,
          undefined,
          botRepo as any,
          vi.fn().mockResolvedValue(undefined),
          undefined,
          undefined,
          undefined,
          botRestart,
        );

        const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
          payload: {
            action: 'adjust_config',
            botId: 'bot-run',
            config: { strategy: { threshold: 5 } },
          },
        }));

        expect(result.accepted).toBe(false);
        expect(botRepo.restoreBotConfig).toHaveBeenCalled();
      });

      it('fails without enqueue when the DB update fails', async () => {
        const botRepo = {
          getBotById: vi.fn().mockResolvedValue({
            id: 'bot-run',
            userId: 'user-1',
            venueAccountId: 'va-001',
            status: 'running',
            config: {
              strategy: { type: 'momentum', decisionMode: 'mechanical', threshold: 2 },
              risk: { maxDrawdownPct: 10 },
              symbol: 'BTC-USD',
              venue: 'hyperliquid',
              venueType: 'orderbook',
            },
            creatorType: 'agent',
            creatorId: 'agent-123',
          }),
          updateBotConfig: vi.fn().mockRejectedValue(new Error('DB connection lost')),
          restoreBotConfig: vi.fn().mockResolvedValue(undefined),
        };
        const botRestart = vi.fn().mockResolvedValue(undefined);

        const brokerWithBot = new AgentMessageBroker(
          {} as any,
          agentRepo as any,
          decisionHandler,
          sessionManager,
          eventPublisher,
          undefined,
          botRepo as any,
          vi.fn().mockResolvedValue(undefined),
          undefined,
          undefined,
          undefined,
          botRestart,
        );

        const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
          payload: {
            action: 'adjust_config',
            botId: 'bot-run',
            config: { strategy: { threshold: 5 } },
          },
        }));

        expect(result.accepted).toBe(false);
        expect(botRepo.updateBotConfig).toHaveBeenCalledWith('bot-run', expect.any(Object));
        expect(botRestart).not.toHaveBeenCalled();
        expect(botRepo.restoreBotConfig).not.toHaveBeenCalled();
      });

      it('does NOT enqueue restart when bot is not running', async () => {
        const botRepo = {
          getBotById: vi.fn().mockResolvedValue({
            id: 'bot-stopped',
            userId: 'user-1',
            venueAccountId: 'va-001',
            status: 'stopped',
            config: {
              strategy: { type: 'momentum', decisionMode: 'mechanical', threshold: 2 },
              symbol: 'BTC-USD',
              venue: 'hyperliquid',
              venueType: 'orderbook',
            },
            creatorType: 'agent',
            creatorId: 'agent-123',
          }),
          updateBotConfig: vi.fn().mockResolvedValue(undefined),
        };
        const botRestart = vi.fn().mockResolvedValue(undefined);

        const brokerWithBot = new AgentMessageBroker(
          {} as any,
          agentRepo as any,
          decisionHandler,
          sessionManager,
          eventPublisher,
          undefined,
          botRepo as any,
          vi.fn().mockResolvedValue(undefined),
          undefined,
          undefined,
          undefined,
          botRestart,
        );

        const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
          payload: {
            action: 'adjust_config',
            botId: 'bot-stopped',
            config: { strategy: { threshold: 5 } },
          },
        }));

        expect(result.accepted).toBe(true);
        expect(botRestart).not.toHaveBeenCalled();
        expect(botRepo.updateBotConfig).toHaveBeenCalled();
      });
    });

    describe('execution mode constraint', () => {
      const execModeDbMock = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }]),
            }),
          }),
        }),
      };

      const makeBotRepo = () => ({
        db: execModeDbMock,
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        tryCreateBotWithLimit: vi.fn().mockResolvedValue({ created: true, botId: 'bot-exec-mode' }),
        tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([]),
        getVenueAccountById: vi.fn().mockResolvedValue({ id: 'va-001', venue: 'hyperliquid', userId: 'user-1' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }),
      });

      const makeLiveBotEnvelope = () => makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          venueAccountId: 'va-001',
          config: {
            venue: 'hyperliquid',
            symbol: 'BTC-USD',
            strategy: { type: 'momentum', decisionMode: 'mechanical' },
            venueType: 'orderbook',
            execution: { mode: 'live' },
          },
        },
      });

      const makePaperBotEnvelope = () => makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          venueAccountId: 'va-001',
          config: {
            venue: 'hyperliquid',
            symbol: 'BTC-USD',
            strategy: { type: 'momentum', decisionMode: 'mechanical' },
            venueType: 'orderbook',
            execution: { mode: 'paper' },
          },
        },
      });

      const makeShadowBotEnvelope = () => makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          venueAccountId: 'va-001',
          config: {
            venue: 'hyperliquid',
            symbol: 'BTC-USD',
            strategy: { type: 'momentum', decisionMode: 'mechanical' },
            venueType: 'orderbook',
            execution: { mode: 'shadow' },
          },
        },
      });

      beforeEach(() => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123',
          userId: 'user-1',
          status: 'active',
          maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionMode: 'paper',
        });
        agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });
        agentRepo.getRuntimeCapabilityDescriptor.mockResolvedValue(makeTradingCapabilityDescriptor());
      });

      it('rejects paper agent creating a live-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionMode: 'paper',
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
        );

        const result = await brokerWithBot.processInbound(makeLiveBotEnvelope());
        expect(result.accepted).toBe(false);
        expect(result.error).toMatch(/cannot create a bot with execution mode "live".*permitted execution modes: paper/i);
        expect(botRepo.tryCreateBotWithLimit).not.toHaveBeenCalled();
      });

      it('rejects shadow agent creating a live-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionMode: 'shadow',
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
        );

        const result = await brokerWithBot.processInbound(makeLiveBotEnvelope());
        expect(result.accepted).toBe(false);
        expect(result.error).toMatch(/cannot create a bot with execution mode "live".*permitted execution modes: paper, shadow/i);
        expect(botRepo.tryCreateBotWithLimit).not.toHaveBeenCalled();
      });

      it('allows paper agent to create a paper-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionMode: 'paper',
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
        );

        const result = await brokerWithBot.processInbound(makePaperBotEnvelope());
        expect(result.accepted).toBe(true);
        expect(botRepo.tryCreateBotWithLimit).toHaveBeenCalledTimes(1);
      });

      it('allows live agent to create a live-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionMode: 'live',
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
        );

        const result = await brokerWithBot.processInbound(makeLiveBotEnvelope());
        expect(result.accepted).toBe(true);
        expect(botRepo.tryCreateBotWithLimit).toHaveBeenCalledTimes(1);
      });

      it('rejects live bot creation when botLiveCheck callback throws (plan gate)', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionMode: 'live',
        });

        const botLiveCheck = vi.fn().mockRejectedValue(
          new Error('Live execution mode is not available on your plan.'),
        );

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          undefined, botRepo as any, vi.fn().mockResolvedValue(undefined), // botStart
          undefined, // botLimitCheck
          botLiveCheck, // botLiveCheck
        );

        const result = await brokerWithBot.processInbound(makeLiveBotEnvelope());
        expect(result.accepted).toBe(false);
        expect(result.error).toMatch(/not available on your plan/);
        expect(botLiveCheck).toHaveBeenCalledWith('user-1');
        expect(botRepo.tryCreateBotWithLimit).not.toHaveBeenCalled();
      });

      it('allows shadow agent to create a paper-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionMode: 'shadow',
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
        );

        const result = await brokerWithBot.processInbound(makePaperBotEnvelope());
        expect(result.accepted).toBe(true);
        expect(botRepo.tryCreateBotWithLimit).toHaveBeenCalledTimes(1);
      });

      it('rejects paper agent creating a shadow-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionMode: 'paper',
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
        );

        const result = await brokerWithBot.processInbound(makeShadowBotEnvelope());
        expect(result.accepted).toBe(false);
        expect(result.error).toMatch(/cannot create a bot with execution mode "shadow".*permitted execution modes: paper/i);
        expect(botRepo.tryCreateBotWithLimit).not.toHaveBeenCalled();
      });

      it('allows shadow agent to create a shadow-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionMode: 'shadow',
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
        );

        const result = await brokerWithBot.processInbound(makeShadowBotEnvelope());
        expect(result.accepted).toBe(true);
        expect(botRepo.tryCreateBotWithLimit).toHaveBeenCalledTimes(1);
      });

      it('allows live agent to create a paper-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionMode: 'live',
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
        );

        const result = await brokerWithBot.processInbound(makePaperBotEnvelope());
        expect(result.accepted).toBe(true);
        expect(botRepo.tryCreateBotWithLimit).toHaveBeenCalledTimes(1);
      });

      it('allows live agent to create a shadow-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionMode: 'live',
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
        );

        const result = await brokerWithBot.processInbound(makeShadowBotEnvelope());
        expect(result.accepted).toBe(true);
        expect(botRepo.tryCreateBotWithLimit).toHaveBeenCalledTimes(1);
      });

      describe('adjust_config mode escalation guard', () => {
        const makeAdjustConfigBotRepo = () => ({
          isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
          getBotById: vi.fn().mockResolvedValue({
            id: 'bot-shadow',
            userId: 'user-1',
            status: 'running',
            connectionId: 'binding-1',
            config: {
              venue: 'hyperliquid',
              venueType: 'orderbook',
              symbol: 'BTC-USD',
              strategy: { type: 'momentum', decisionMode: 'mechanical' },
              execution: { mode: 'shadow' },
            },
          }),
          updateBotConfig: vi.fn().mockResolvedValue(undefined),
          getBotsByCreator: vi.fn().mockResolvedValue([]),
          getVenueAccountById: vi.fn().mockResolvedValue({ id: 'va-001', venue: 'hyperliquid', userId: 'user-1' }),
        getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }),
        });

        const makeAdjustLiveEnvelope = () => makeManageBotEnvelope({
          payload: {
            action: 'adjust_config',
            botId: 'bot-shadow',
            config: { execution: { mode: 'live' } },
          },
        });

        const makeAdjustShadowEnvelope = () => makeManageBotEnvelope({
          payload: {
            action: 'adjust_config',
            botId: 'bot-shadow',
            config: { execution: { mode: 'shadow' } },
          },
        });

        const makeAdjustPaperEnvelope = () => makeManageBotEnvelope({
          payload: {
            action: 'adjust_config',
            botId: 'bot-shadow',
            config: { execution: { mode: 'paper' } },
          },
        });

        it('rejects shadow agent escalating a bot to live mode via adjust_config', async () => {
          agentRepo.getAgent.mockResolvedValue({
            id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
            toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
            executionMode: 'shadow',
          });

          const botRepo = makeAdjustConfigBotRepo();
          const brokerWithBot = new AgentMessageBroker(
            {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
            undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
          );

          const result = await brokerWithBot.processInbound(makeAdjustLiveEnvelope());
          expect(result.accepted).toBe(false);
          expect(result.error).toMatch(/cannot adjust a bot to execution mode "live".*permitted execution modes: paper, shadow/i);
          expect(botRepo.updateBotConfig).not.toHaveBeenCalled();
        });

        it('rejects paper agent escalating a bot to live mode via adjust_config', async () => {
          agentRepo.getAgent.mockResolvedValue({
            id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
            toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
            executionMode: 'paper',
          });

          const botRepo = makeAdjustConfigBotRepo();
          const brokerWithBot = new AgentMessageBroker(
            {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
            undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
          );

          const result = await brokerWithBot.processInbound(makeAdjustLiveEnvelope());
          expect(result.accepted).toBe(false);
          expect(result.error).toMatch(/cannot adjust a bot to execution mode "live".*permitted execution modes: paper/i);
          expect(botRepo.updateBotConfig).not.toHaveBeenCalled();
        });

        it('allows live agent to escalate a bot to live mode via adjust_config', async () => {
          agentRepo.getAgent.mockResolvedValue({
            id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
            toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
            executionMode: 'live',
          });

          const botRepo = makeAdjustConfigBotRepo();
          const brokerWithBot = new AgentMessageBroker(
            {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
            undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
            undefined, undefined,
          );

          const result = await brokerWithBot.processInbound(makeAdjustLiveEnvelope());
          expect(result.accepted).toBe(true);
          expect(botRepo.updateBotConfig).toHaveBeenCalled();
        });

        it('rejects paper agent escalating a bot to shadow mode via adjust_config', async () => {
          agentRepo.getAgent.mockResolvedValue({
            id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
            toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
            executionMode: 'paper',
          });

          const botRepo = makeAdjustConfigBotRepo();
          const brokerWithBot = new AgentMessageBroker(
            {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
            undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
          );

          const result = await brokerWithBot.processInbound(makeAdjustShadowEnvelope());
          expect(result.accepted).toBe(false);
          expect(result.error).toMatch(/cannot adjust a bot to execution mode "shadow".*permitted execution modes: paper/i);
          expect(botRepo.updateBotConfig).not.toHaveBeenCalled();
        });

        it('allows shadow agent to adjust a bot to shadow mode', async () => {
          agentRepo.getAgent.mockResolvedValue({
            id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
            toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
            executionMode: 'shadow',
          });

          const botRepo = makeAdjustConfigBotRepo();
          const brokerWithBot = new AgentMessageBroker(
            {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
            undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
          );

          const result = await brokerWithBot.processInbound(makeAdjustShadowEnvelope());
          expect(result.accepted).toBe(true);
          expect(botRepo.updateBotConfig).toHaveBeenCalled();
        });

        it('allows paper agent to adjust a bot to paper mode', async () => {
          agentRepo.getAgent.mockResolvedValue({
            id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
            toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
            executionMode: 'paper',
          });

          const botRepo = makeAdjustConfigBotRepo();
          const brokerWithBot = new AgentMessageBroker(
            {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
            undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
          );

          const result = await brokerWithBot.processInbound(makeAdjustPaperEnvelope());
          expect(result.accepted).toBe(true);
          expect(botRepo.updateBotConfig).toHaveBeenCalled();
        });

        it('allows live agent to adjust a bot to paper mode', async () => {
          agentRepo.getAgent.mockResolvedValue({
            id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
            toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
            executionMode: 'live',
          });

          const botRepo = makeAdjustConfigBotRepo();
          const brokerWithBot = new AgentMessageBroker(
            {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
            undefined, botRepo as any, vi.fn().mockResolvedValue(undefined),
            undefined, undefined,
          );

          const result = await brokerWithBot.processInbound(makeAdjustPaperEnvelope());
          expect(result.accepted).toBe(true);
          expect(botRepo.updateBotConfig).toHaveBeenCalled();
        });
      });
    });
  });
});

describe('AgentMessageBroker — runtime activity audit events', () => {
  function makeAuditAgentRepo() {
    return {
      isMessageDuplicate: vi.fn().mockResolvedValue(false),
      isActiveSession: vi.fn().mockResolvedValue(true),
      insertMessage: vi.fn().mockResolvedValue(undefined),
      markMessageProcessed: vi.fn().mockResolvedValue(undefined),
      getAgent: vi.fn().mockResolvedValue({ id: 'agent-123', status: 'active' }),
      updateAgent: vi.fn().mockResolvedValue(undefined),
      getActiveSession: vi.fn().mockResolvedValue({ id: 'sess-001' }),
      retireActiveSessions: vi.fn().mockResolvedValue(undefined),
      getRuntimeCapabilityDescriptor: vi.fn().mockResolvedValue(null),
      insertArtifact: vi.fn().mockResolvedValue('art-id'),
      getActiveLink: vi.fn().mockResolvedValue({ botId: 'ti-456' }),
    };
  }

  const auditDecisionHandler = { handleDecisionSubmit: vi.fn() } as unknown as AgentDecisionHandler;
  const auditSessionManager = {
    handleHeartbeat: vi.fn(),
    handlePauseRequest: vi.fn(),
    handleStopRequest: vi.fn(),
  } as unknown as AgentSessionManager;
  const auditEventPublisher = {
    emitDecisionAccepted: vi.fn(),
    emitDecisionRejected: vi.fn(),
    emitInstanceStatus: vi.fn(),
    emitToolResult: vi.fn(),
  } as unknown as InstanceEventPublisher;

  let auditAgentRepo: ReturnType<typeof makeAuditAgentRepo>;
  let auditBroker: AgentMessageBroker;

  beforeEach(() => {
    auditAgentRepo = makeAuditAgentRepo();
    auditBroker = new AgentMessageBroker(
      {} as any,
      auditAgentRepo as any,
      auditDecisionHandler,
      auditSessionManager,
      auditEventPublisher,
    );
  });

  it('accepts and persists agent.tick.started without routing to any handler', async () => {
    const envelope = {
      schemaVersion: 'v1',
      messageId: 'msg-tick-1',
      correlationId: 'corr-tick-1',
      initiatorType: 'agent',
      initiatorId: 'agent-123',
      type: 'agent.tick.started',
      createdAt: new Date().toISOString(),
      payload: { tickId: 'tick-001', trigger: 'scheduled', positionSide: 'none', hasWakeSignal: false },
    };

    const result = await auditBroker.processInbound(envelope);

    expect(result.accepted).toBe(true);
    expect(auditAgentRepo.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-tick-1', type: 'agent.tick.started' }),
    );
    expect(auditAgentRepo.markMessageProcessed).toHaveBeenCalledWith('msg-tick-1', 'processed');
    expect((auditDecisionHandler as any).handleDecisionSubmit).not.toHaveBeenCalled();
    expect((auditSessionManager as any).handleHeartbeat).not.toHaveBeenCalled();
  });

  it('accepts agent.llm.completed as audit-only', async () => {
    const envelope = {
      schemaVersion: 'v1',
      messageId: 'msg-llm-1',
      correlationId: 'corr-llm-1',
      initiatorType: 'agent',
      initiatorId: 'agent-123',
      type: 'agent.llm.completed',
      createdAt: new Date().toISOString(),
      payload: { tickId: 'tick-001', phase: 'scout', model: 'gpt-4o-mini', turnsUsed: 2, finishReason: 'stop', terminatedByLimit: false },
    };

    const result = await auditBroker.processInbound(envelope);

    expect(result.accepted).toBe(true);
    expect(auditAgentRepo.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent.llm.completed' }),
    );
  });

  it('rejects unknown type even if it looks like an activity event', async () => {
    const envelope = {
      schemaVersion: 'v1',
      messageId: 'msg-bad-1',
      correlationId: 'corr-bad-1',
      initiatorType: 'agent',
      initiatorId: 'agent-123',
      type: 'agent.tick.unknown',
      createdAt: new Date().toISOString(),
      payload: {},
    };

    const result = await auditBroker.processInbound(envelope);

    expect(result.accepted).toBe(false);
    expect(result.error).toBe('unknown_message_type');
  });
});

describe('manage_bot create_and_start — LLM inheritance (bug-report 001)', () => {
  function makeLlmAgentRepo(overrides: Record<string, unknown> = {}) {
    const base = mockAgentRepo();
    base.getAgent.mockResolvedValue({
      id: 'agent-123',
      userId: 'user-1',
      status: 'active',
      maxBots: 5,
      toolPolicy: { manage_bot: { capability: 'manage_bot', tier: 'brokered', enabled: true, limits: { maxPerMinute: 5, maxConcurrent: 1, timeoutMs: 30_000 } } },
      modelPolicy: {
        provider: 'openrouter',
        heavyModel: 'openai/gpt-4o',
        lightModel: 'openai/gpt-4o-mini',
      },
      executionMode: 'paper',
      ...overrides,
    });
    return base;
  }

  function makeLlmManageBotEnvelope(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 'v1',
      messageId: `msg-${Math.random().toString(36).slice(2)}`,
      correlationId: 'corr-001',
      initiatorType: 'agent' as const,
      initiatorId: 'agent-123',
      agentId: 'agent-123',
      type: 'agent.manage_bot' as const,
      createdAt: new Date().toISOString(),
      payload: {
        action: 'create_and_start' as const,
        connectionId: 'binding-1',
        config: {
          symbol: 'BTC-USD',
          strategy: { type: 'momentum' as const, decisionMode: 'llm' as const },
          execution: { mode: 'paper' as const },
          risk: {},
        },
        ...overrides,
      },
    };
  }

  const mockDbSelect = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }]),
      }),
    }),
  });

  function makeBotRepo() {
    return {
      db: { select: mockDbSelect },
      isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      tryCreateBotWithLimit: vi.fn().mockResolvedValue({ created: true, botId: 'bot-new-001' }),
      tryMarkBotRunningWithLimit: vi.fn().mockResolvedValue(true),
      markBotRunning: vi.fn().mockResolvedValue(undefined),
      getBotsByCreator: vi.fn().mockResolvedValue([]),
      getVenueAccountById: vi.fn().mockResolvedValue({ id: 'va-001', venue: 'hyperliquid', userId: 'user-1' }),
      getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' }),
    };
  }

  it('stamps agent modelPolicy provider/model into strategy.params for llm bots', async () => {
    const agentRepo = makeLlmAgentRepo();
    agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });
    agentRepo.getUserAiModelConfig.mockResolvedValue(null);

    const botRepo = makeBotRepo();
    const broker = new AgentMessageBroker(
      {} as any, // redis
      agentRepo as any,
      mockDecisionHandler(),
      mockSessionManager(),
      mockEventPublisher(),
      undefined, // telegram
      botRepo as any,
      vi.fn().mockResolvedValue(undefined), // botStart
    );

    const envelope = makeLlmManageBotEnvelope();
    const result = await broker.processInbound(envelope);

    expect(result.accepted).toBe(true);
    expect(botRepo.tryCreateBotWithLimit).toHaveBeenCalledTimes(1);

    // Extract the config passed to createBot
    const createBotCall = (botRepo.tryCreateBotWithLimit as ReturnType<typeof vi.fn>).mock.calls[0] as Array<Record<string, unknown>>;
    const createBotArg = createBotCall[0] as Record<string, unknown>;
    const config = createBotArg['config'] as Record<string, unknown>;
    const strategy = config['strategy'] as Record<string, unknown>;
    const params = strategy['params'] as Record<string, unknown>;

    expect(params['provider']).toBe('openrouter');
    expect(params['model']).toBe('openai/gpt-4o'); // heavy model preferred for bot
  });

  it('falls back to user AI defaults when modelPolicy is empty', async () => {
    const agentRepo = makeLlmAgentRepo({ modelPolicy: null });
    agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });
    agentRepo.getUserAiModelConfig.mockResolvedValue({
      provider: 'openai',
      lightModel: 'gpt-4o-mini',
      heavyModel: 'gpt-4o',
    });

    const botRepo = makeBotRepo();
    const broker = new AgentMessageBroker(
      {} as any,
      agentRepo as any,
      mockDecisionHandler(),
      mockSessionManager(),
      mockEventPublisher(),
      undefined,
      botRepo as any,
      vi.fn().mockResolvedValue(undefined),
    );

    const envelope = makeLlmManageBotEnvelope();
    const result = await broker.processInbound(envelope);

    expect(result.accepted).toBe(true);
    const createBotArg = ((botRepo.tryCreateBotWithLimit as ReturnType<typeof vi.fn>).mock.calls[0] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const params = ((createBotArg['config'] as Record<string, unknown>)['strategy'] as Record<string, unknown>)['params'] as Record<string, unknown>;

    expect(params['provider']).toBe('openai');
    expect(params['model']).toBe('gpt-4o');
  });

  it('does NOT stamp provider/model for mechanical bots', async () => {
    const agentRepo = makeLlmAgentRepo();
    agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });

    const botRepo = makeBotRepo();
    const broker = new AgentMessageBroker(
      {} as any,
      agentRepo as any,
      mockDecisionHandler(),
      mockSessionManager(),
      mockEventPublisher(),
      undefined,
      botRepo as any,
      vi.fn().mockResolvedValue(undefined),
    );

    const envelope = makeLlmManageBotEnvelope({
      config: {
        symbol: 'BTC-USD',
        strategy: { type: 'momentum', decisionMode: 'mechanical' },
        execution: { mode: 'paper' },
        risk: {},
      },
    } as unknown as Record<string, unknown>);

    const result = await broker.processInbound(envelope);
    expect(result.accepted).toBe(true);

    const createBotArg = ((botRepo.tryCreateBotWithLimit as ReturnType<typeof vi.fn>).mock.calls[0] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const params = ((createBotArg['config'] as Record<string, unknown>)['strategy'] as Record<string, unknown>)['params'] as Record<string, unknown> | undefined;

    // params should not have provider/model stamped for mechanical
    expect(params?.['provider']).toBeUndefined();
    expect(params?.['model']).toBeUndefined();
  });

  it('does NOT stamp provider/model for DCA bots', async () => {
    const agentRepo = makeLlmAgentRepo();
    agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });

    const botRepo = makeBotRepo();
    const broker = new AgentMessageBroker(
      {} as any,
      agentRepo as any,
      mockDecisionHandler(),
      mockSessionManager(),
      mockEventPublisher(),
      undefined,
      botRepo as any,
      vi.fn().mockResolvedValue(undefined),
    );

    const envelope = makeLlmManageBotEnvelope({
      config: {
        symbol: 'BTC-USD',
        strategy: { type: 'dca' },
        execution: { mode: 'paper' },
        risk: {},
      },
    } as unknown as Record<string, unknown>);

    const result = await broker.processInbound(envelope);
    expect(result.accepted).toBe(true);

    const createBotArg = ((botRepo.tryCreateBotWithLimit as ReturnType<typeof vi.fn>).mock.calls[0] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const params = ((createBotArg['config'] as Record<string, unknown>)['strategy'] as Record<string, unknown>)['params'] as Record<string, unknown> | undefined;

    expect(params?.['provider']).toBeUndefined();
    expect(params?.['model']).toBeUndefined();
  });
});
