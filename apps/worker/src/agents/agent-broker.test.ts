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
    insertMessage: vi.fn().mockResolvedValue(undefined),
    markMessageProcessed: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockResolvedValue({ id: 'agent-123', status: 'active' }),
    updateAgent: vi.fn().mockResolvedValue(undefined),
    getActiveSession: vi.fn().mockResolvedValue({ id: 'sess-001' }),
    retireActiveSessions: vi.fn().mockResolvedValue(undefined),
    getRuntimeCapabilityDescriptor: vi.fn().mockResolvedValue(makeTradingCapabilityDescriptor()),
    insertArtifact: vi.fn().mockResolvedValue('art-id'),
    getActiveLink: vi.fn().mockResolvedValue({ botId: 'ti-456' }),
  };
}

function makeTradingCapabilityDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    grantedBindingsByFamily: {
      trading: [
        {
          bindingId: 'binding-1',
          sourceVenueAccountId: 'va-001',
          readiness: { effectiveReady: true },
        },
      ],
    },
    defaultBindingByFamily: { trading: 'binding-1' },
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

    it('handles runtime session ended by stopping the agent and retiring active sessions', async () => {
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
        statusChange,
      );
      const envelope = makeEnvelope({
        type: 'agent.runtime.session_ended',
        payload: { sessionId: 'sess-001', reasonCode: 'wall_clock_expired' },
      });

      const result = await brokerWithStatus.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-123', { status: 'stopped' });
      expect(agentRepo.retireActiveSessions).toHaveBeenCalledWith('agent-123');
      expect(agentRepo.markMessageProcessed).toHaveBeenCalledWith(envelope.messageId, 'processed');
      expect(statusChange).toHaveBeenCalledWith('agent-123', 'user-1', 'stopped');
    });

    it('does not emit a duplicate stopped event when the agent is already stopped', async () => {
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
        payload: { sessionId: 'sess-001', reasonCode: 'SIGTERM' },
      });

      const result = await brokerWithStatus.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect(statusChange).not.toHaveBeenCalled();
      expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-123', { status: 'stopped' });
      expect(agentRepo.retireActiveSessions).toHaveBeenCalledWith('agent-123');
      expect(agentRepo.markMessageProcessed).toHaveBeenCalledWith(envelope.messageId, 'processed');
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
          venueAccountId: 'va-001',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: {}, venueType: 'orderbook' },
        },
        ...overrides,
      };
    }

    function makeBotRepo() {
      return {
        isTradingBindingOwnedBy: vi.fn().mockResolvedValue(true),
        countRunningBotsByCreator: vi.fn().mockResolvedValue(0),
        createBot: vi.fn().mockResolvedValue('bot-new-001'),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([]),
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
      expect(botRepo.createBot).toHaveBeenCalledTimes(2);
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
      expect(botRepo.createBot).not.toHaveBeenCalled();
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
          venueAccountId: 'va-001',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: {}, venueType: 'orderbook' },
        },
        ...overrides,
      };
    }

    describe('bot_query emits tool results', () => {
      it('emits a bot list result', async () => {
        const botRepo = {
          getBotsByCreator: vi.fn().mockResolvedValue([
            { id: 'bot-a', status: 'running', config: { strategyPreset: 'momentum', symbol: 'BTC-USD' } },
            { id: 'bot-b', status: 'stopped', config: { strategyPreset: 'mean-reversion', symbol: 'ETH-USD' } },
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
            data: [
              expect.objectContaining({ id: 'bot-a', status: 'running', strategyPreset: 'momentum', symbol: 'BTC-USD' }),
              expect.objectContaining({ id: 'bot-b', status: 'stopped', strategyPreset: 'mean-reversion', symbol: 'ETH-USD' }),
            ],
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
        isTradingBindingOwnedBy: vi.fn().mockResolvedValue(true),
        countRunningBotsByCreator: vi.fn().mockResolvedValue(0),
        createBot: vi.fn().mockResolvedValue('bot-abc'),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([
          { id: 'bot-abc', status: 'running', config: { strategyPreset: 'momentum', symbol: 'BTC-USD' } },
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
        isTradingBindingOwnedBy: vi.fn().mockResolvedValue(true),
        countRunningBotsByCreator: vi.fn().mockResolvedValue(0),
        createBot: vi.fn().mockResolvedValue('bot-xyz'),
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

      await brokerWithBot.processInbound(makeManageBotEnvelope());

      expect((eventPublisher as any).emitInstanceStatus).toHaveBeenCalledWith(
        'agent-123',
        expect.objectContaining({ managedBots: [] }),
      );
    });

    it('emits bot with undefined strategyPreset when config has none', async () => {
      const botRepo = {
        isTradingBindingOwnedBy: vi.fn().mockResolvedValue(true),
        countRunningBotsByCreator: vi.fn().mockResolvedValue(0),
        createBot: vi.fn().mockResolvedValue('bot-min'),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
        getBotsByCreator: vi.fn().mockResolvedValue([
          { id: 'bot-min', status: 'stopped', config: {} },
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
        vi.fn().mockResolvedValue(undefined),
      );

      await brokerWithBot.processInbound(makeManageBotEnvelope());

      const call = (eventPublisher as any).emitInstanceStatus.mock.calls[0];
      expect(call[1].managedBots[0].strategyPreset).toBeUndefined();
      expect(call[1].managedBots[0].symbol).toBeUndefined();
    });

    it('uses the requested venue account binding when provided', async () => {
      agentRepo.getRuntimeCapabilityDescriptor.mockResolvedValue(makeTradingCapabilityDescriptor({
        grantedBindingsByFamily: {
          trading: [
            {
              bindingId: 'binding-1',
              sourceVenueAccountId: 'va-001',
              readiness: { effectiveReady: true },
            },
            {
              bindingId: 'binding-2',
              sourceVenueAccountId: 'va-002',
              readiness: { effectiveReady: true },
            },
          ],
        },
        defaultBindingByFamily: { trading: 'binding-1' },
      }));

      const botRepo = {
        isTradingBindingOwnedBy: vi.fn().mockResolvedValue(true),
        countRunningBotsByCreator: vi.fn().mockResolvedValue(0),
        createBot: vi.fn().mockResolvedValue('bot-targeted'),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
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
        payload: {
          action: 'create_and_start',
          venueAccountId: 'va-002',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: {}, venueType: 'orderbook' },
        },
      }));

      expect(result.accepted).toBe(true);
      expect(botRepo.isTradingBindingOwnedBy).toHaveBeenCalledWith('binding-2', 'user-1');
      expect(botRepo.createBot).toHaveBeenCalledWith(expect.objectContaining({
        tradingBindingId: 'binding-2',
        venueAccountId: 'va-002',
      }));
      expect(botStart).toHaveBeenCalledWith('bot-targeted', 'user-1', 'va-002', expect.any(Object));
    });

    it('rejects create_and_start when the requested venue account maps to multiple bindings', async () => {
      agentRepo.getRuntimeCapabilityDescriptor.mockResolvedValue(makeTradingCapabilityDescriptor({
        grantedBindingsByFamily: {
          trading: [
            {
              bindingId: 'binding-1',
              sourceVenueAccountId: 'va-002',
              readiness: { effectiveReady: true },
            },
            {
              bindingId: 'binding-2',
              sourceVenueAccountId: 'va-002',
              readiness: { effectiveReady: true },
            },
          ],
        },
        defaultBindingByFamily: { trading: 'binding-1' },
      }));

      const botRepo = {
        isTradingBindingOwnedBy: vi.fn().mockResolvedValue(true),
        countRunningBotsByCreator: vi.fn().mockResolvedValue(0),
        createBot: vi.fn().mockResolvedValue('bot-ambiguous'),
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
          venueAccountId: 'va-002',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: {}, venueType: 'orderbook' },
        },
      }));

      expect(result.accepted).toBe(false);
      expect(result.error).toMatch(/multiple trading capability bindings/i);
      expect(botRepo.createBot).not.toHaveBeenCalled();
    });

    it('rejects create_and_start when resolved binding is not owned by agent user', async () => {
      const botRepo = {
        isTradingBindingOwnedBy: vi.fn().mockResolvedValue(false),
        countRunningBotsByCreator: vi.fn().mockResolvedValue(0),
        createBot: vi.fn().mockResolvedValue('bot-never'),
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
      expect(botRepo.createBot).not.toHaveBeenCalled();
      expect((eventPublisher as any).emitInstanceStatus).not.toHaveBeenCalled();
    });

    it('rejects create_and_start when agent has reached maxBots limit', async () => {
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 2,
        toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
      });

      const botRepo = {
        isTradingBindingOwnedBy: vi.fn().mockResolvedValue(true),
        countRunningBotsByCreator: vi.fn().mockResolvedValue(2), // at limit
        createBot: vi.fn().mockResolvedValue('bot-over'),
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
      expect(botRepo.createBot).not.toHaveBeenCalled();
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

      const botRepo = {
        isTradingBindingOwnedBy: vi.fn().mockResolvedValue(true),
        countRunningBotsByCreator: vi.fn().mockResolvedValue(0),
        createBot: vi.fn().mockResolvedValue('bot-cap'),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
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
        payload: {
          action: 'create_and_start',
          venueAccountId: 'va-001',
          config: {
            venue: 'hyperliquid',
            symbol: 'BTC-USD',
            strategy: {},
            venueType: 'orderbook',
            risk: { maxDrawdownPct: 10, maxOrderNotional: '2500' },
          },
        },
      }));

      expect(result.accepted).toBe(true);
      expect(botRepo.createBot).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({
          risk: expect.objectContaining({ maxDrawdownPct: 10, maxOrderNotional: '1000' }),
        }),
      }));
      expect(botStart).toHaveBeenCalledWith(
        'bot-cap',
        'user-1',
        'va-001',
        expect.objectContaining({
          risk: expect.objectContaining({ maxOrderNotional: '1000' }),
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
          venueAccountId: 'va-001',
          status: 'stopped',
          startedAt: null,
          stoppedAt: new Date('2026-06-01T00:00:00.000Z'),
          config: {},
          creatorType: 'agent',
          creatorId: 'agent-123',
        }),
        updateBotConfig: vi.fn().mockResolvedValue(undefined),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
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
      expect(botRepo.markBotRunning).toHaveBeenCalledWith('bot-start');
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
          venueAccountId: 'va-001',
          status: 'stopped',
          startedAt: null,
          stoppedAt: new Date('2026-06-01T00:00:00.000Z'),
          config: { risk: { maxOrderNotional: '1500', maxDrawdownPct: 10 } },
          creatorType: 'agent',
          creatorId: 'agent-123',
        }),
        updateBotConfig: vi.fn().mockResolvedValue(undefined),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
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
        risk: { maxOrderNotional: '750', maxDrawdownPct: 10 },
      });
      expect(botStart).toHaveBeenCalledWith('bot-start', 'user-1', 'va-001', {
        risk: { maxOrderNotional: '750', maxDrawdownPct: 10 },
      });
    });

    it('still fails gracefully when start enqueue AND rollback both fail', async () => {
      const botRepo = {
        getBotById: vi.fn().mockResolvedValue({
          id: 'bot-start',
          userId: 'user-1',
          venueAccountId: 'va-001',
          status: 'stopped',
          startedAt: null,
          stoppedAt: new Date('2026-06-01T00:00:00.000Z'),
          config: {},
          creatorType: 'agent',
          creatorId: 'agent-123',
        }),
        updateBotConfig: vi.fn().mockResolvedValue(undefined),
        markBotRunning: vi.fn().mockResolvedValue(undefined),
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
          venueAccountId: 'va-001',
          status: 'running',
          config: {
            strategy: { type: 'momentum', threshold: 2 },
            risk: { maxDrawdownPct: 10 },
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
      expect(botRepo.updateBotConfig).toHaveBeenCalledWith('bot-run', {
        strategy: { type: 'momentum', threshold: 5 },
        risk: { maxDrawdownPct: 10 },
        executionMode: 'shadow',
      });
      expect(botRestart).toHaveBeenCalledWith('bot-run', 'user-1', 'va-001', {
        strategy: { type: 'momentum', threshold: 5 },
        risk: { maxDrawdownPct: 10 },
        executionMode: 'shadow',
      });
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
          status: 'running',
          config: {
            strategy: { type: 'momentum', threshold: 2 },
            risk: { maxDrawdownPct: 10, maxOrderNotional: '2000' },
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
      expect(botRepo.updateBotConfig).toHaveBeenCalledWith('bot-run', {
        strategy: { type: 'momentum', threshold: 2 },
        risk: { maxDrawdownPct: 10, maxOrderNotional: '750' },
      });
      expect(botRestart).toHaveBeenCalledWith('bot-run', 'user-1', 'va-001', {
        strategy: { type: 'momentum', threshold: 2 },
        risk: { maxDrawdownPct: 10, maxOrderNotional: '750' },
      });
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
              strategy: { type: 'momentum', threshold: 2 },
              risk: { maxDrawdownPct: 10 },
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
        expect(botRepo.updateBotConfig).toHaveBeenCalledWith('bot-run', {
          strategy: { type: 'momentum', threshold: 5 },
          risk: { maxDrawdownPct: 10 },
        });
        expect(botRepo.restoreBotConfig).toHaveBeenCalledWith('bot-run', {
          strategy: { type: 'momentum', threshold: 2 },
          risk: { maxDrawdownPct: 10 },
        });
      });

      it('still fails gracefully when restart enqueue AND config rollback both fail', async () => {
        const botRepo = {
          getBotById: vi.fn().mockResolvedValue({
            id: 'bot-run',
            userId: 'user-1',
            venueAccountId: 'va-001',
            status: 'running',
            config: {
              strategy: { type: 'momentum', threshold: 2 },
              risk: { maxDrawdownPct: 10 },
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
              strategy: { type: 'momentum', threshold: 2 },
              risk: { maxDrawdownPct: 10 },
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
              strategy: { type: 'momentum', threshold: 2 },
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
  });
});

describe('AgentMessageBroker — runtime activity audit events', () => {
  function makeAuditAgentRepo() {
    return {
      isMessageDuplicate: vi.fn().mockResolvedValue(false),
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
