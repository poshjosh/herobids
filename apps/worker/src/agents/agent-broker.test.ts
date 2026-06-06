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
    tradingInstanceId: 'ti-456',
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
    getActiveSession: vi.fn().mockResolvedValue({ id: 'sess-001' }),
    insertArtifact: vi.fn().mockResolvedValue('art-id'),
    getActiveLink: vi.fn().mockResolvedValue({ tradingInstanceId: 'ti-456' }),
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
          tradingInstanceId: 'ti-456',
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
        isVenueAccountOwnedBy: vi.fn().mockResolvedValue(true),
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
    function makeManageBotEnvelope() {
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
      };
    }

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
    });

    it('emits instance status with bot list after create_and_start', async () => {
      const botRepo = {
        isVenueAccountOwnedBy: vi.fn().mockResolvedValue(true),
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
        isVenueAccountOwnedBy: vi.fn().mockResolvedValue(true),
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
        isVenueAccountOwnedBy: vi.fn().mockResolvedValue(true),
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

    it('rejects create_and_start when venue account not owned by agent user', async () => {
      const botRepo = {
        isVenueAccountOwnedBy: vi.fn().mockResolvedValue(false),
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
        isVenueAccountOwnedBy: vi.fn().mockResolvedValue(true),
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
  });
});
