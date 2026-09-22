import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentMessageBroker } from './agent-message-broker.js';
import { CapabilityPolicyEngine } from './capability-policy.js';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import type { TradertonClientResult } from '@herobids/domain/traderton';
import type { TradertonSideEffectBoundary } from '../traderton/write-adapter.js';

/**
 * L3c: the number of positional ctor args before the trailing
 * `sideEffectBoundary`. Bot lifecycle now routes over the Traderton REST
 * boundary; the botStart/botLimitCheck/botStop/botRestart/agentRiskDefaults
 * params are dead. `makeBrokerArgs` fills the gap so tests only wire the
 * boundary + the params they still care about (redis..botRepo).
 */

/** A stubbed side-effecting boundary whose invokeAndAwait returns a scripted result. */
function makeBoundary(result: TradertonClientResult = { kind: 'success', requestId: 'r', correlationId: 'c', payload: {} }): {
  boundary: TradertonSideEffectBoundary;
  invokeAndAwait: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
} {
  const invokeAndAwait = vi.fn().mockResolvedValue(result);
  const invoke = vi.fn().mockResolvedValue(result);
  return { boundary: { invoke, invokeAndAwait }, invokeAndAwait, invoke };
}

/**
 * Build the trailing ctor args (telegram..sideEffectBoundary) for a broker that
 * routes bot lifecycle over the boundary. Only `botRepo` (ownership + bot_query
 * reads) and the boundary are meaningful now — the lifecycle callbacks are dead.
 */
function makeBoundaryBrokerArgs(botRepo: unknown, boundary: TradertonSideEffectBoundary): unknown[] {
  return [
    undefined,   // telegram
    botRepo,     // botRepo (ownership gate + bot_query reads)
    undefined,   // botLiveCheck
    undefined,   // emailClient
    undefined,   // onAgentConfigUpdate
    undefined,   // brandImageUrl
    undefined,   // db
    undefined,   // operatorModelDefaults
    undefined,   // plansConfig
    boundary,    // sideEffectBoundary
  ];
}

// Module-level mocks for skill management functions used by handleManageAgentSkills
vi.mock('@herobids/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@herobids/db')>();
  return {
    ...actual,
    resolveSkillAssignmentsForUser: vi.fn().mockResolvedValue({ assignments: [] }),
    syncAgentSkillAssignments: vi.fn().mockResolvedValue(undefined),
  };
});

// Import the mocked functions so we can configure per-test behavior
import { resolveSkillAssignmentsForUser, syncAgentSkillAssignments } from '@herobids/db';

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
      );
      void statusChange;
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
      );
      void statusChange;

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

    // c4.9i: the BOT_QUERY receive path was removed (nothing publishes
    // `agent.bot.query`; agents read bots/analytics/positions over the Traderton
    // boundary read tools). The bot_query routing test was removed with it.
  });

  describe('send_message email fanout regression', () => {
    it('does NOT call emailClient.send when handleSendMessage processes a brokered send_message', async () => {
      // Enrich agentRepo with the additional methods handleSendMessage needs
      (agentRepo as any).insertOutboundMessage = vi.fn().mockResolvedValue('out-msg-1');
      (agentRepo as any).getEffectiveTelegramChatId = vi.fn().mockResolvedValue(null);
      (agentRepo as any).markOutboundMessageFailed = vi.fn().mockResolvedValue(undefined);
      (agentRepo as any).markOutboundMessageSent = vi.fn().mockResolvedValue(undefined);

      // Set up mocks so handleSendMessage can succeed without Telegram
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123',
        userId: 'user-1',
        status: 'active',
        name: 'Test Agent',
        toolPolicy: null,
      });
      agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });

      // Provide a mock emailClient with a spy on send
      const emailSendSpy = vi.fn().mockResolvedValue(undefined);
      const emailClient = { send: emailSendSpy };

      const brokerWithEmail = new AgentMessageBroker(
        {} as any,              // redis
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        undefined,              // telegram
        undefined,              // botRepo
        undefined,              // botLiveCheck
        emailClient as any,     // emailClient
      );

      const envelope = makeEnvelope({
        messageId: 'msg-send-message-nofanout',
        type: 'agent.message.send',
        payload: {
          body: 'Hello from agent',
          subject: 'Test',
          messageClass: 'routine',
        },
      });

      const result = await brokerWithEmail.processInbound(envelope);

      // The message should be accepted and processed
      expect(result.accepted).toBe(true);

      // Email fanout must NOT be triggered
      expect(emailSendSpy).not.toHaveBeenCalled();
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

    // L3c: create routes over the boundary — the botRepo only needs the
    // ownership gate (isConnectionOwnedBy). No bots-table writes remain.
    function makeBotRepo() {
      return {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
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
      const { boundary, invokeAndAwait } = makeBoundary();
      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
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
      // Both requests succeeded (boundary create_bot invoked twice confirms neither was denied).
      expect(invokeAndAwait).toHaveBeenCalledTimes(2);
      expect(invokeAndAwait.mock.calls.every((call) => call[0].toolName === 'create_bot')).toBe(true);
    });

    it('rebuilds engine when toolPolicy changes between calls', async () => {
      const policyV1 = { manage_bot: MANAGE_BOT_ENABLED };
      const policyV2 = { manage_bot: MANAGE_BOT_DISABLED };

      agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });

      const botRepo = makeBotRepo();
      const { boundary } = makeBoundary();
      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
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
      const { boundary, invokeAndAwait } = makeBoundary();
      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      // manage_bot is disabled in DEFAULT_CAPABILITY_GRANTS — no override → denied
      // before lifecycle runs, so the boundary is never touched.
      const e1 = makeManageBotEnvelope();
      const result = await brokerWithBot.processInbound(e1);
      expect(result.accepted).toBe(false);
      expect(result.error).toMatch(/capability_denied/);
      expect(invokeAndAwait).not.toHaveBeenCalled();
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

    it('routes create_and_start to the boundary create_bot and emits a lightweight running status', async () => {
      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      };

      const { boundary, invokeAndAwait } = makeBoundary({ kind: 'success', requestId: 'r', correlationId: 'c', payload: { id: 'bot-abc' } });
      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope());
      expect(result.accepted).toBe(true);

      // Routed to the boundary with the create_bot tool + platform-owned subject only.
      expect(invokeAndAwait).toHaveBeenCalledTimes(1);
      const arg = invokeAndAwait.mock.calls[0]![0];
      expect(arg.toolName).toBe('create_bot');
      expect(arg.subject).toEqual({ ownerId: 'user-1', actor: { type: 'agent', id: 'agent-123' } });
      // Subject carries ownerId + actor ONLY — no venue account resolution leaked.
      expect(arg.subject).not.toHaveProperty('venueAccountId');
      expect(arg.subject).not.toHaveProperty('venue');
      expect(arg.subject).not.toHaveProperty('venueType');
      // Payload forwards the connection's resolved venue account (herobids owns
      // the connection→account mapping); the connectionId is NOT sent — the
      // boundary does not consume it.
      expect(arg.payload.venueAccountId).toBe('va-001');
      expect(arg.payload).not.toHaveProperty('connectionId');
      expect(arg.payload).not.toHaveProperty('botId');
      expect(arg.payload.config).not.toHaveProperty('venueAccountId');

      // create_bot no longer writes the bots table nor enforces a client-side limit.
      expect(botRepo).not.toHaveProperty('tryCreateBotWithLimit');

      // Post-create status is a lightweight running signal — no managedBots list
      // (the authoritative list now lives behind the boundary's list_bots).
      expect((eventPublisher as any).emitInstanceStatus).toHaveBeenCalledWith(
        'agent-123',
        expect.objectContaining({ status: 'running', reason: 'bot_created' }),
      );
      const statusArg = (eventPublisher as any).emitInstanceStatus.mock.calls[0][1];
      expect(statusArg).not.toHaveProperty('managedBots');
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

      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      };
      const { boundary, invokeAndAwait } = makeBoundary();

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          connectionId: 'binding-2',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: { type: 'momentum', decisionMode: 'mechanical' }, venueType: 'orderbook' },
        },
      }));

      expect(result.accepted).toBe(true);
      // Ownership gate runs against the requested connectionId.
      expect(botRepo.isConnectionOwnedBy).toHaveBeenCalledWith('binding-2', 'user-1');
      // The requested connection's resolved venue account (va-002) is forwarded to
      // the boundary; the connectionId itself is NOT sent.
      const arg = invokeAndAwait.mock.calls[0]![0];
      expect(arg.toolName).toBe('create_bot');
      expect(arg.payload.venueAccountId).toBe('va-002');
      expect(arg.payload).not.toHaveProperty('connectionId');
      expect(arg.subject).toEqual({ ownerId: 'user-1', actor: { type: 'agent', id: 'agent-123' } });
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

      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      };
      const { boundary, invokeAndAwait } = makeBoundary();

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          connectionId: 'binding-2',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: { type: 'momentum', decisionMode: 'mechanical' }, venueType: 'orderbook' },
        },
      }));

      expect(result.accepted).toBe(true);
      expect(invokeAndAwait.mock.calls[0]![0].payload.venueAccountId).toBe('va-002');
    });

    it('rejects when connectionId does not match any granted connection — boundary NOT called', async () => {
      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      };
      const { boundary, invokeAndAwait } = makeBoundary();

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
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
      expect(invokeAndAwait).not.toHaveBeenCalled();
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
        getBotsByCreator: vi.fn().mockResolvedValue([]),
      };
      const { boundary, invokeAndAwait } = makeBoundary();

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: { type: 'momentum', decisionMode: 'mechanical' }, venueType: 'orderbook' },
        },
      }));

      expect(result.accepted).toBe(true);
      // The agent's default trading connection (binding-2) resolves to va-002,
      // which is forwarded as the payload venueAccountId.
      expect(invokeAndAwait.mock.calls[0]![0].payload.venueAccountId).toBe('va-002');
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

      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      };
      const { boundary, invokeAndAwait } = makeBoundary();

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      // No connectionId provided — broker falls back to default connection
      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          config: { venue: 'hyperliquid', symbol: 'BTC-USD', strategy: { type: 'momentum', decisionMode: 'mechanical' }, venueType: 'orderbook' },
        },
      }));

      expect(result.accepted).toBe(true);
      // The default connection (binding-1) resolves to va-002, forwarded as the
      // payload venueAccountId.
      expect(invokeAndAwait.mock.calls[0]![0].payload.venueAccountId).toBe('va-002');
    });

    it('rejects create_and_start when resolved connection is not owned by agent user — boundary NOT called', async () => {
      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(false),
      };
      const { boundary, invokeAndAwait } = makeBoundary();

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope());
      expect(result.accepted).toBe(false);
      // Ownership gate (herobids-side authz) blocks BEFORE any boundary call.
      expect(invokeAndAwait).not.toHaveBeenCalled();
      expect((eventPublisher as any).emitInstanceStatus).not.toHaveBeenCalled();
    });

    it('no longer enforces a client-side maxBots limit — Traderton owns the limit', async () => {
      // Previously the broker rejected once the agent hit maxBots. That limit now
      // lives behind the boundary (Traderton's create_bot). The broker forwards
      // regardless of maxBots and lets the boundary own acceptance.
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 2,
        toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
      });

      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      };
      const { boundary, invokeAndAwait } = makeBoundary();

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope());
      expect(result.accepted).toBe(true);
      // No client-side limit gate — the create is forwarded to the boundary.
      expect(invokeAndAwait).toHaveBeenCalledTimes(1);
      expect(invokeAndAwait.mock.calls[0]![0].toolName).toBe('create_bot');
    });

    it('rejects create_and_start when the boundary returns a failure', async () => {
      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      };
      const { boundary, invokeAndAwait } = makeBoundary({
        kind: 'failure', requestId: 'r', correlationId: 'c', code: 'risk.exceeded', message: 'over cap', retryable: false,
      });

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope());
      expect(result.accepted).toBe(false);
      // The failure code is surfaced in the processing error.
      expect(result.error).toMatch(/risk\.exceeded/);
      expect(invokeAndAwait).toHaveBeenCalledTimes(1);
      // No running status is emitted on a rejected create.
      expect((eventPublisher as any).emitInstanceStatus).not.toHaveBeenCalled();
    });

    it('forwards create_and_start risk.maxOrderNotional unchanged (no local capital clamp)', async () => {
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123',
        userId: 'user-1',
        status: 'active',
        maxBots: 5,
        capital: '1000',
        toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
      });

      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      };
      const { boundary, invokeAndAwait } = makeBoundary();

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          connectionId: 'binding-1',
          config: {
            venue: 'hyperliquid',
            symbol: 'BTC-USD',
            strategy: { type: 'momentum', decisionMode: 'mechanical' },
            venueType: 'orderbook',
            risk: { maxDrawdownPct: 10, maxOrderNotional: 2500 },
          },
        },
      }));

      expect(result.accepted).toBe(true);
      // Capital is no longer an agent property (ADR 010) and herobids does not
      // enforce local risk copies (ADR 011), so the config is forwarded verbatim;
      // Traderton owns the capital clamp and risk enforcement.
      const arg = invokeAndAwait.mock.calls[0]![0];
      expect(arg.toolName).toBe('create_bot');
      expect(arg.payload.config).toEqual(expect.objectContaining({
        risk: expect.objectContaining({ maxOrderNotional: 2500, maxDrawdownPct: 10 }),
      }));
      expect(arg.payload.config).not.toHaveProperty('venueAccountId');
    });

    it('forwards strategy-level exit-target keys (takeProfitPct/trailingStopPct) unchanged', async () => {
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123',
        userId: 'user-1',
        status: 'active',
        maxBots: 5,
        capital: '1000',
        toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
      });

      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      };
      const { boundary, invokeAndAwait } = makeBoundary();

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'create_and_start',
          connectionId: 'binding-1',
          config: {
            venue: 'hyperliquid',
            symbol: 'BTC-USD',
            strategy: { type: 'momentum', decisionMode: 'mechanical' },
            venueType: 'orderbook',
            risk: { maxDrawdownPct: 10, takeProfitPct: 25, trailingStopPct: 5 },
          },
        },
      }));

      expect(result.accepted).toBe(true);
      // No local risk normalization. Traderton's create_bot owns risk-schema
      // validation; herobids forwards the config as-is (ADR 011).
      const arg = invokeAndAwait.mock.calls[0]![0];
      expect(arg.toolName).toBe('create_bot');
      expect(arg.payload.config.risk).toEqual(expect.objectContaining({ maxDrawdownPct: 10, takeProfitPct: 25, trailingStopPct: 5 }));
    });

    it('routes stop to the boundary stop_bot with botId + subject only', async () => {
      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      };
      const { boundary, invokeAndAwait } = makeBoundary();

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: { action: 'stop', botId: 'bot-stop' },
      }));

      expect(result.accepted).toBe(true);
      expect(invokeAndAwait).toHaveBeenCalledTimes(1);
      const arg = invokeAndAwait.mock.calls[0]![0];
      expect(arg.toolName).toBe('stop_bot');
      expect(arg.payload).toEqual({ botId: 'bot-stop' });
      expect(arg.subject).toEqual({ ownerId: 'user-1', actor: { type: 'agent', id: 'agent-123' } });
    });

    it('routes start to the boundary start_bot then emits a running status', async () => {
      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      };
      const { boundary, invokeAndAwait } = makeBoundary();

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: { action: 'start', botId: 'bot-start' },
      }));

      expect(result.accepted).toBe(true);
      const arg = invokeAndAwait.mock.calls[0]![0];
      expect(arg.toolName).toBe('start_bot');
      expect(arg.payload).toEqual({ botId: 'bot-start' });
      expect(arg.subject).toEqual({ ownerId: 'user-1', actor: { type: 'agent', id: 'agent-123' } });
      expect((eventPublisher as any).emitInstanceStatus).toHaveBeenCalledWith(
        'agent-123',
        expect.objectContaining({ status: 'running', reason: 'bot_started' }),
      );
    });

    it('propagates a boundary failure on start as a rejected result', async () => {
      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      };
      const { boundary } = makeBoundary({
        kind: 'failure', requestId: 'r', correlationId: 'c', code: 'not_found.resource', message: 'no such bot', retryable: false,
      });

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: { action: 'start', botId: 'bot-missing' },
      }));

      expect(result.accepted).toBe(false);
      expect(result.error).toMatch(/not_found\.resource/);
      expect((eventPublisher as any).emitInstanceStatus).not.toHaveBeenCalled();
    });

    it('adjusts config over the boundary adjust_bot_config with the partial config + subject', async () => {
      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      };
      const { boundary, invokeAndAwait } = makeBoundary();

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'adjust_config',
          botId: 'bot-run',
          config: { strategy: { threshold: 5 }, execution: { mode: 'paper' } },
        },
      }));

      expect(result.accepted).toBe(true);
      // The boundary owns the base-config read/merge/validate/restart. herobids
      // forwards only the PARTIAL update (no base merge here).
      expect(invokeAndAwait).toHaveBeenCalledTimes(1);
      const arg = invokeAndAwait.mock.calls[0]![0];
      expect(arg.toolName).toBe('adjust_bot_config');
      expect(arg.payload.botId).toBe('bot-run');
      expect(arg.payload.config).toEqual(expect.objectContaining({
        strategy: { threshold: 5 },
        execution: { mode: 'paper' },
      }));
      expect(arg.subject).toEqual({ ownerId: 'user-1', actor: { type: 'agent', id: 'agent-123' } });
    });

    it('forwards adjusted risk.maxOrderNotional unchanged (no local capital clamp)', async () => {
      agentRepo.getAgent.mockResolvedValue({
        id: 'agent-123',
        userId: 'user-1',
        status: 'active',
        maxBots: 5,
        capital: '750',
        toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
      });

      const botRepo = {
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      };
      const { boundary, invokeAndAwait } = makeBoundary();

      const brokerWithBot = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        decisionHandler,
        sessionManager,
        eventPublisher,
        ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
      );

      const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
        payload: {
          action: 'adjust_config',
          botId: 'bot-run',
          config: { risk: { maxOrderNotional: 1500 } },
        },
      }));

      expect(result.accepted).toBe(true);
      // No local capital clamp (ADR 011). The partial config is forwarded
      // verbatim; Traderton owns the clamp and risk enforcement.
      const arg = invokeAndAwait.mock.calls[0]![0];
      expect(arg.toolName).toBe('adjust_bot_config');
      expect(arg.payload.config).toEqual(expect.objectContaining({
        risk: expect.objectContaining({ maxOrderNotional: 1500 }),
      }));
    });

    describe('adjust_config boundary failures', () => {
      it('rejects the adjust when the boundary returns a failure', async () => {
        const botRepo = {
          isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        };
        const { boundary, invokeAndAwait } = makeBoundary({
          kind: 'failure', requestId: 'r', correlationId: 'c', code: 'validation.invalid_payload', message: 'bad config', retryable: false,
        });

        const brokerWithBot = new AgentMessageBroker(
          {} as any,
          agentRepo as any,
          decisionHandler,
          sessionManager,
          eventPublisher,
          ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
        );

        const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
          payload: {
            action: 'adjust_config',
            botId: 'bot-run',
            config: { strategy: { threshold: 5 } },
          },
        }));

        expect(result.accepted).toBe(false);
        expect(result.error).toMatch(/validation\.invalid_payload/);
        expect(invokeAndAwait).toHaveBeenCalledTimes(1);
      });

      it('rejects the adjust when the boundary is unreachable (transport_error)', async () => {
        const botRepo = {
          isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        };
        const { boundary } = makeBoundary({
          kind: 'transport_error', requestId: 'r', retryable: true, message: 'unreachable',
        });

        const brokerWithBot = new AgentMessageBroker(
          {} as any,
          agentRepo as any,
          decisionHandler,
          sessionManager,
          eventPublisher,
          ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
        );

        const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
          payload: {
            action: 'adjust_config',
            botId: 'bot-run',
            config: { strategy: { threshold: 5 } },
          },
        }));

        expect(result.accepted).toBe(false);
        expect(result.error).toMatch(/unreachable/i);
      });

      it('forwards the partial config regardless of the target bot state (state is owned by the boundary)', async () => {
        // The broker no longer reads the bot or gates on running/stopped state.
        // It forwards the partial config; the boundary owns merge + restart.
        const botRepo = {
          isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
        };
        const { boundary, invokeAndAwait } = makeBoundary();

        const brokerWithBot = new AgentMessageBroker(
          {} as any,
          agentRepo as any,
          decisionHandler,
          sessionManager,
          eventPublisher,
          ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
        );

        const result = await brokerWithBot.processInbound(makeManageBotEnvelope({
          payload: {
            action: 'adjust_config',
            botId: 'bot-stopped',
            config: { strategy: { threshold: 5 } },
          },
        }));

        expect(result.accepted).toBe(true);
        expect(invokeAndAwait).toHaveBeenCalledTimes(1);
        expect(invokeAndAwait.mock.calls[0]![0].toolName).toBe('adjust_bot_config');
        expect(invokeAndAwait.mock.calls[0]![0].payload.botId).toBe('bot-stopped');
      });
    });

    describe('execution mode constraint', () => {
      // L3c: create routes over the boundary — only the ownership gate remains.
      const makeBotRepo = () => ({
        isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
      });

      // A shared boundary captured per-test in beforeEach so assertions can read
      // whether create_bot was invoked (allowed) or not (mode-escalation rejected).
      let execBoundary: ReturnType<typeof makeBoundary>;

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
          executionDefaults: { mode: 'paper' },
        });
        agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });
        agentRepo.getRuntimeCapabilityDescriptor.mockResolvedValue(makeTradingCapabilityDescriptor());
        execBoundary = makeBoundary();
      });

      it('forwards paper agent creating a live-mode bot to the boundary', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionDefaults: { mode: 'paper' },
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          ...(makeBoundaryBrokerArgs(botRepo, execBoundary.boundary) as [any]),
        );

        const result = await brokerWithBot.processInbound(makeLiveBotEnvelope());
        // Mode escalation is no longer gated locally (ADR 011). Traderton owns
        // the mode ceiling, so the broker forwards the request verbatim.
        expect(result.accepted).toBe(true);
        expect(execBoundary.invokeAndAwait).toHaveBeenCalledTimes(1);
        expect(execBoundary.invokeAndAwait.mock.calls[0]![0].toolName).toBe('create_bot');
      });

      it('forwards shadow agent creating a live-mode bot to the boundary', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionDefaults: { mode: 'shadow' },
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          ...(makeBoundaryBrokerArgs(botRepo, execBoundary.boundary) as [any]),
        );

        const result = await brokerWithBot.processInbound(makeLiveBotEnvelope());
        expect(result.accepted).toBe(true);
        expect(execBoundary.invokeAndAwait).toHaveBeenCalledTimes(1);
        expect(execBoundary.invokeAndAwait.mock.calls[0]![0].toolName).toBe('create_bot');
      });

      it('allows paper agent to create a paper-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionDefaults: { mode: 'paper' },
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          ...(makeBoundaryBrokerArgs(botRepo, execBoundary.boundary) as [any]),
        );

        const result = await brokerWithBot.processInbound(makePaperBotEnvelope());
        expect(result.accepted).toBe(true);
        expect(execBoundary.invokeAndAwait).toHaveBeenCalledTimes(1);
        expect(execBoundary.invokeAndAwait.mock.calls[0]![0].toolName).toBe('create_bot');
      });

      it('allows live agent to create a live-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionDefaults: { mode: 'live' },
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          ...(makeBoundaryBrokerArgs(botRepo, execBoundary.boundary) as [any]),
        );

        const result = await brokerWithBot.processInbound(makeLiveBotEnvelope());
        expect(result.accepted).toBe(true);
        expect(execBoundary.invokeAndAwait).toHaveBeenCalledTimes(1);
      });

      it('rejects live bot creation when botLiveCheck callback throws (plan gate)', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionDefaults: { mode: 'live' },
        });

        const botLiveCheck = vi.fn().mockRejectedValue(
          new Error('Live execution mode is not available on your plan.'),
        );

        const botRepo = makeBotRepo();
        // botLiveCheck sits at index 2 of makeBoundaryBrokerArgs (telegram, botRepo, botLiveCheck, ...).
        const args = makeBoundaryBrokerArgs(botRepo, execBoundary.boundary);
        args[2] = botLiveCheck; // botLiveCheck slot in makeBoundaryBrokerArgs
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          ...(args as [any]),
        );

        const result = await brokerWithBot.processInbound(makeLiveBotEnvelope());
        expect(result.accepted).toBe(false);
        expect(result.error).toMatch(/not available on your plan/);
        expect(botLiveCheck).toHaveBeenCalledWith('user-1');
        // The plan gate rejects before the boundary create_bot.
        expect(execBoundary.invokeAndAwait).not.toHaveBeenCalled();
      });

      it('allows shadow agent to create a paper-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionDefaults: { mode: 'shadow' },
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          ...(makeBoundaryBrokerArgs(botRepo, execBoundary.boundary) as [any]),
        );

        const result = await brokerWithBot.processInbound(makePaperBotEnvelope());
        expect(result.accepted).toBe(true);
        expect(execBoundary.invokeAndAwait).toHaveBeenCalledTimes(1);
      });

      it('forwards paper agent creating a shadow-mode bot to the boundary', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionDefaults: { mode: 'paper' },
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          ...(makeBoundaryBrokerArgs(botRepo, execBoundary.boundary) as [any]),
        );

        const result = await brokerWithBot.processInbound(makeShadowBotEnvelope());
        expect(result.accepted).toBe(true);
        expect(execBoundary.invokeAndAwait).toHaveBeenCalledTimes(1);
        expect(execBoundary.invokeAndAwait.mock.calls[0]![0].toolName).toBe('create_bot');
      });

      it('allows shadow agent to create a shadow-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionDefaults: { mode: 'shadow' },
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          ...(makeBoundaryBrokerArgs(botRepo, execBoundary.boundary) as [any]),
        );

        const result = await brokerWithBot.processInbound(makeShadowBotEnvelope());
        expect(result.accepted).toBe(true);
        expect(execBoundary.invokeAndAwait).toHaveBeenCalledTimes(1);
      });

      it('allows live agent to create a paper-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionDefaults: { mode: 'live' },
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          ...(makeBoundaryBrokerArgs(botRepo, execBoundary.boundary) as [any]),
        );

        const result = await brokerWithBot.processInbound(makePaperBotEnvelope());
        expect(result.accepted).toBe(true);
        expect(execBoundary.invokeAndAwait).toHaveBeenCalledTimes(1);
      });

      it('allows live agent to create a shadow-mode bot', async () => {
        agentRepo.getAgent.mockResolvedValue({
          id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
          toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
          executionDefaults: { mode: 'live' },
        });

        const botRepo = makeBotRepo();
        const brokerWithBot = new AgentMessageBroker(
          {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
          ...(makeBoundaryBrokerArgs(botRepo, execBoundary.boundary) as [any]),
        );

        const result = await brokerWithBot.processInbound(makeShadowBotEnvelope());
        expect(result.accepted).toBe(true);
        expect(execBoundary.invokeAndAwait).toHaveBeenCalledTimes(1);
      });

      describe('adjust_config mode escalation guard', () => {
        // L3c: adjust routes over the boundary. The mode gate reads the requested
        // mode from the PARTIAL config (not the bot), so no bot read is needed —
        // only the ownership gate remains on the repo.
        const makeAdjustConfigBotRepo = () => ({
          isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
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

        it('forwards shadow agent escalating a bot to live mode via adjust_config', async () => {
          agentRepo.getAgent.mockResolvedValue({
            id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
            toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
            executionDefaults: { mode: 'shadow' },
          });

          const botRepo = makeAdjustConfigBotRepo();
          const { boundary, invokeAndAwait } = makeBoundary();
          const brokerWithBot = new AgentMessageBroker(
            {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
            ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
          );

          const result = await brokerWithBot.processInbound(makeAdjustLiveEnvelope());
          // No local mode-escalation gate (ADR 011). Traderton owns the ceiling.
          expect(result.accepted).toBe(true);
          expect(invokeAndAwait).toHaveBeenCalledTimes(1);
          expect(invokeAndAwait.mock.calls[0]![0].toolName).toBe('adjust_bot_config');
        });

        it('forwards paper agent escalating a bot to live mode via adjust_config', async () => {
          agentRepo.getAgent.mockResolvedValue({
            id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
            toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
            executionDefaults: { mode: 'paper' },
          });

          const botRepo = makeAdjustConfigBotRepo();
          const { boundary, invokeAndAwait } = makeBoundary();
          const brokerWithBot = new AgentMessageBroker(
            {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
            ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
          );

          const result = await brokerWithBot.processInbound(makeAdjustLiveEnvelope());
          expect(result.accepted).toBe(true);
          expect(invokeAndAwait).toHaveBeenCalledTimes(1);
          expect(invokeAndAwait.mock.calls[0]![0].toolName).toBe('adjust_bot_config');
        });

        it('allows live agent to escalate a bot to live mode via adjust_config', async () => {
          agentRepo.getAgent.mockResolvedValue({
            id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
            toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
            executionDefaults: { mode: 'live' },
          });

          const botRepo = makeAdjustConfigBotRepo();
          const { boundary, invokeAndAwait } = makeBoundary();
          const brokerWithBot = new AgentMessageBroker(
            {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
            ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
          );

          const result = await brokerWithBot.processInbound(makeAdjustLiveEnvelope());
          expect(result.accepted).toBe(true);
          expect(invokeAndAwait).toHaveBeenCalledTimes(1);
          expect(invokeAndAwait.mock.calls[0]![0].toolName).toBe('adjust_bot_config');
        });

        it('forwards paper agent escalating a bot to shadow mode via adjust_config', async () => {
          agentRepo.getAgent.mockResolvedValue({
            id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
            toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
            executionDefaults: { mode: 'paper' },
          });

          const botRepo = makeAdjustConfigBotRepo();
          const { boundary, invokeAndAwait } = makeBoundary();
          const brokerWithBot = new AgentMessageBroker(
            {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
            ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
          );

          const result = await brokerWithBot.processInbound(makeAdjustShadowEnvelope());
          expect(result.accepted).toBe(true);
          expect(invokeAndAwait).toHaveBeenCalledTimes(1);
          expect(invokeAndAwait.mock.calls[0]![0].toolName).toBe('adjust_bot_config');
        });

        it('allows shadow agent to adjust a bot to shadow mode', async () => {
          agentRepo.getAgent.mockResolvedValue({
            id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
            toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
            executionDefaults: { mode: 'shadow' },
          });

          const botRepo = makeAdjustConfigBotRepo();
          const { boundary, invokeAndAwait } = makeBoundary();
          const brokerWithBot = new AgentMessageBroker(
            {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
            ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
          );

          const result = await brokerWithBot.processInbound(makeAdjustShadowEnvelope());
          expect(result.accepted).toBe(true);
          expect(invokeAndAwait).toHaveBeenCalledTimes(1);
        });

        it('allows paper agent to adjust a bot to paper mode', async () => {
          agentRepo.getAgent.mockResolvedValue({
            id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
            toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
            executionDefaults: { mode: 'paper' },
          });

          const botRepo = makeAdjustConfigBotRepo();
          const { boundary, invokeAndAwait } = makeBoundary();
          const brokerWithBot = new AgentMessageBroker(
            {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
            ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
          );

          const result = await brokerWithBot.processInbound(makeAdjustPaperEnvelope());
          expect(result.accepted).toBe(true);
          expect(invokeAndAwait).toHaveBeenCalledTimes(1);
        });

        it('allows live agent to adjust a bot to paper mode', async () => {
          agentRepo.getAgent.mockResolvedValue({
            id: 'agent-123', userId: 'user-1', status: 'active', maxBots: 5,
            toolPolicy: { manage_bot: MANAGE_BOT_ENABLED_GRANT },
            executionDefaults: { mode: 'live' },
          });

          const botRepo = makeAdjustConfigBotRepo();
          const { boundary, invokeAndAwait } = makeBoundary();
          const brokerWithBot = new AgentMessageBroker(
            {} as any, agentRepo as any, decisionHandler, sessionManager, eventPublisher,
            ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
          );

          const result = await brokerWithBot.processInbound(makeAdjustPaperEnvelope());
          expect(result.accepted).toBe(true);
          expect(invokeAndAwait).toHaveBeenCalledTimes(1);
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
      executionDefaults: { mode: 'paper' },
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

  // L3c: create routes over the boundary — only the ownership gate remains.
  function makeBotRepo() {
    return {
      isConnectionOwnedBy: vi.fn().mockResolvedValue(true),
    };
  }

  /** Read strategy.params from the config forwarded to the boundary create_bot. */
  function forwardedStrategyParams(invokeAndAwait: ReturnType<typeof vi.fn>): Record<string, unknown> | undefined {
    const arg = invokeAndAwait.mock.calls[0]![0] as { payload: { config: Record<string, unknown> } };
    const strategy = arg.payload.config['strategy'] as Record<string, unknown>;
    return strategy['params'] as Record<string, unknown> | undefined;
  }

  it('stamps agent modelPolicy provider/model into strategy.params for llm bots', async () => {
    const agentRepo = makeLlmAgentRepo();
    agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });
    agentRepo.getUserAiModelConfig.mockResolvedValue(null);

    const botRepo = makeBotRepo();
    const { boundary, invokeAndAwait } = makeBoundary();
    const broker = new AgentMessageBroker(
      {} as any, // redis
      agentRepo as any,
      mockDecisionHandler(),
      mockSessionManager(),
      mockEventPublisher(),
      ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
    );

    const envelope = makeLlmManageBotEnvelope();
    const result = await broker.processInbound(envelope);

    expect(result.accepted).toBe(true);
    expect(invokeAndAwait).toHaveBeenCalledTimes(1);
    expect(invokeAndAwait.mock.calls[0]![0].toolName).toBe('create_bot');

    // The LLM provider/model stamp is applied to the config forwarded to the boundary.
    const params = forwardedStrategyParams(invokeAndAwait)!;
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
    const { boundary, invokeAndAwait } = makeBoundary();
    const broker = new AgentMessageBroker(
      {} as any,
      agentRepo as any,
      mockDecisionHandler(),
      mockSessionManager(),
      mockEventPublisher(),
      ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
    );

    const envelope = makeLlmManageBotEnvelope();
    const result = await broker.processInbound(envelope);

    expect(result.accepted).toBe(true);
    const params = forwardedStrategyParams(invokeAndAwait)!;
    expect(params['provider']).toBe('openai');
    expect(params['model']).toBe('gpt-4o');
  });

  it('does NOT stamp provider/model for mechanical bots', async () => {
    const agentRepo = makeLlmAgentRepo();
    agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });

    const botRepo = makeBotRepo();
    const { boundary, invokeAndAwait } = makeBoundary();
    const broker = new AgentMessageBroker(
      {} as any,
      agentRepo as any,
      mockDecisionHandler(),
      mockSessionManager(),
      mockEventPublisher(),
      ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
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

    // params should not have provider/model stamped for mechanical
    const params = forwardedStrategyParams(invokeAndAwait);
    expect(params?.['provider']).toBeUndefined();
    expect(params?.['model']).toBeUndefined();
  });

  it('does NOT stamp provider/model for DCA bots', async () => {
    const agentRepo = makeLlmAgentRepo();
    agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });

    const botRepo = makeBotRepo();
    const { boundary, invokeAndAwait } = makeBoundary();
    const broker = new AgentMessageBroker(
      {} as any,
      agentRepo as any,
      mockDecisionHandler(),
      mockSessionManager(),
      mockEventPublisher(),
      ...(makeBoundaryBrokerArgs(botRepo, boundary) as [any]),
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

    const params = forwardedStrategyParams(invokeAndAwait);
    expect(params?.['provider']).toBeUndefined();
    expect(params?.['model']).toBeUndefined();
  });
});


// ── manage_agent_skills capability routing ───────────────────────────────────

describe('manage_agent_skills — capability routing', () => {
  function makeSkillsEnvelope(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 'v1',
      messageId: `msg-${Math.random().toString(36).slice(2)}`,
      correlationId: 'corr-001',
      initiatorType: 'agent',
      initiatorId: 'agent-123',
      agentId: 'agent-123',
      type: 'agent.manage_skills',
      createdAt: new Date().toISOString(),
      payload: {
        action: 'add',
        skillIds: ['trading'],
      },
      ...overrides,
    };
  }

  it('enforces capability policy for manage_agent_skills messages', async () => {
    const agentRepo = mockAgentRepo();
    // Provide a toolPolicy that explicitly disables manage_agent_skills
    agentRepo.getAgent.mockResolvedValue({
      id: 'agent-123',
      userId: 'user-1',
      status: 'active',
      toolPolicy: {
        manage_agent_skills: {
          capability: 'manage_agent_skills',
          tier: 'brokered',
          enabled: false,
          limits: { maxPerMinute: 10, maxConcurrent: 1, timeoutMs: 30_000 },
        },
      },
    });
    agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });

    const broker = new AgentMessageBroker(
      {} as any,
      agentRepo as any,
      mockDecisionHandler(),
      mockSessionManager(),
      mockEventPublisher(),
    );

    const envelope = makeSkillsEnvelope();
    const result = await broker.processInbound(envelope);
    expect(result.accepted).toBe(false);
    expect(result.error).toMatch(/capability_denied/);
  });

  it('passes capability gate and routes to handler (accepted even without db)', async () => {
    const agentRepo = mockAgentRepo();
    agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', status: 'active' });
    agentRepo.getActiveSession.mockResolvedValue({ id: 'sess-001', status: 'running' });

    const broker = new AgentMessageBroker(
      {} as any,
      agentRepo as any,
      mockDecisionHandler(),
      mockSessionManager(),
      mockEventPublisher(),
    );

    const envelope = makeSkillsEnvelope();
    const result = await broker.processInbound(envelope);
    // Handler is wired — accepted even if db is unavailable (handler publishes error reply internally)
    expect(result.accepted).toBe(true);
  });

  it('validates the manage_agent_skills payload schema', async () => {
    const agentRepo = mockAgentRepo();
    agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', status: 'active' });

    const broker = new AgentMessageBroker(
      {} as any,
      agentRepo as any,
      mockDecisionHandler(),
      mockSessionManager(),
      mockEventPublisher(),
    );

    const envelope = makeSkillsEnvelope({
      payload: { action: 'invalid_action', skillIds: ['trading'] },
    });
    const result = await broker.processInbound(envelope);
    expect(result.accepted).toBe(false);
    expect(result.error).toBe('invalid_payload');
  });
});

// ── handleManageAgentSkills handler logic ────────────────────────────────────

describe('handleManageAgentSkills — handler logic', () => {
  const resolveSkillAssignmentsMock = vi.mocked(resolveSkillAssignmentsForUser);
  const syncAgentSkillAssignmentsMock = vi.mocked(syncAgentSkillAssignments);

  function makeSkillsEnvelope(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 'v1',
      messageId: `msg-${Math.random().toString(36).slice(2)}`,
      correlationId: 'corr-001',
      initiatorType: 'agent',
      initiatorId: 'agent-123',
      agentId: 'agent-123',
      type: 'agent.manage_skills',
      createdAt: new Date().toISOString(),
      payload: {
        action: 'add',
        skillIds: ['trading'],
        requestMessageId: 'req-abc-123',
      },
      ...overrides,
    };
  }

  /**
   * Creates a db mock for the 'add' path with explicit control.
   * The add handler calls:
   *   1. db.select(users).from(users).where(...).limit(1) → userRow
   *   2. db.select(agentSkills).from(agentSkills).where(...) → existingSkillRows (no .limit())
   */
  function makeAddDbMock(
    userRow: Record<string, unknown> = { planId: 'plan-free', isAdmin: false },
    existingSkillRows: Array<{ skillId: string }> = [],
  ) {
    let callIndex = 0;
    const selectFn = vi.fn().mockImplementation(() => {
      const idx = callIndex++;
      if (idx === 0) {
        // users table query — has .limit()
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([userRow]),
            }),
          }),
        };
      }
      // agentSkills table query — no .limit(), returns array directly from .where()
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(existingSkillRows),
        }),
      };
    });
    return { select: selectFn, transaction: vi.fn() } as any;
  }

  /**
   * Creates a db mock for the 'remove' path.
   * The remove handler calls:
   *   1. db.select(agentSkills).from(agentSkills).where(...) → existingSkillRows
   *   2. (optionally) db.select(users).from(users).where(...).limit(1) → userRow (if remaining skills > 0)
   */
  function makeRemoveDbMock(
    existingSkillRows: Array<{ skillId: string }> = [],
    userRow: Record<string, unknown> = { planId: 'plan-free', isAdmin: false },
  ) {
    let callIndex = 0;
    const selectFn = vi.fn().mockImplementation(() => {
      const idx = callIndex++;
      if (idx === 0) {
        // agentSkills table query — no .limit()
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(existingSkillRows),
          }),
        };
      }
      // users table query — has .limit()
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([userRow]),
          }),
        }),
      };
    });
    return { select: selectFn, transaction: vi.fn() } as any;
  }

  function makeSkillsEventPublisher() {
    return {
      emitDecisionAccepted: vi.fn().mockResolvedValue(undefined),
      emitDecisionRejected: vi.fn().mockResolvedValue(undefined),
      emitInstanceStatus: vi.fn().mockResolvedValue(undefined),
      emitToolResult: vi.fn().mockResolvedValue(undefined),
      publishSkillsReply: vi.fn().mockResolvedValue(undefined),
    } as unknown as InstanceEventPublisher;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resolveSkillAssignmentsMock.mockResolvedValue({
      assignments: [{ skillId: 'trading', skillRevisionId: 'rev-1' }],
    });
    syncAgentSkillAssignmentsMock.mockResolvedValue(undefined);
  });

  // ── MANAGE_AGENT_SKILLS add ──────────────────────────────────────────────

  describe('add action', () => {
    it('persists with assignmentSource agent_self and publishes success reply', async () => {
      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();
      const db = makeAddDbMock();

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, // telegram
        undefined, // botRepo
        undefined, // botLiveCheck
        undefined, // emailClient
        undefined, // onAgentConfigUpdate
        undefined, // brandImageUrl
        db,        // db
      );

      const envelope = makeSkillsEnvelope();
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect(syncAgentSkillAssignmentsMock).toHaveBeenCalledWith(
        db,
        'agent-123',
        'user-1',
        expect.any(Array),
        'agent_self',
      );
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-abc-123',
        expect.objectContaining({
          status: 'ok',
          action: 'add',
          skillIds: expect.arrayContaining(['trading']),
        }),
      );
    });

    it('publishes error reply for non-entitled skill (resolveSkillAssignmentsForUser returns error)', async () => {
      resolveSkillAssignmentsMock.mockResolvedValue({
        error: {
          code: 'validation_error',
          message: 'Some selected skills are not selectable for this user',
        },
      });

      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();
      const db = makeAddDbMock();

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope();
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect(syncAgentSkillAssignmentsMock).not.toHaveBeenCalled();
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-abc-123',
        expect.objectContaining({
          status: 'error',
          action: 'add',
          errorCode: 'validation_error',
          error: expect.stringContaining('not selectable'),
        }),
      );
    });

    it('is idempotent for already-assigned skill (still publishes success)', async () => {
      // Skill 'trading' is already assigned
      const db = makeAddDbMock(
        { planId: 'plan-free', isAdmin: false },
        [{ skillId: 'trading' }],
      );
      resolveSkillAssignmentsMock.mockResolvedValue({
        assignments: [{ skillId: 'trading', skillRevisionId: 'rev-1' }],
      });

      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope();
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      // syncAgentSkillAssignments is still called (idempotent upsert)
      expect(syncAgentSkillAssignmentsMock).toHaveBeenCalled();
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-abc-123',
        expect.objectContaining({
          status: 'ok',
          action: 'add',
          // Already-assigned skill is filtered from the addedSkillIds
          skillIds: [],
        }),
      );
    });

    it('rejects base skill ID with base_skill_protected error code', async () => {
      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();
      const db = makeAddDbMock();

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope({
        payload: { action: 'add', skillIds: ['base'], requestMessageId: 'req-base' },
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect(syncAgentSkillAssignmentsMock).not.toHaveBeenCalled();
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-base',
        expect.objectContaining({
          status: 'error',
          errorCode: 'base_skill_protected',
          error: expect.stringContaining('base skill'),
        }),
      );
    });

    it('publishes db_unavailable error reply when db is not wired', async () => {
      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();

      // No db passed — defaults to undefined
      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
      );

      const envelope = makeSkillsEnvelope();
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-abc-123',
        expect.objectContaining({
          status: 'error',
          errorCode: 'db_unavailable',
        }),
      );
    });

    it('publishes agent_not_found error reply when agent does not exist', async () => {
      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue(null);

      const eventPublisher = makeSkillsEventPublisher();
      const db = makeAddDbMock();

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope();
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect(syncAgentSkillAssignmentsMock).not.toHaveBeenCalled();
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-abc-123',
        expect.objectContaining({
          status: 'error',
          errorCode: 'agent_not_found',
        }),
      );
    });

    it('publishes user_not_found error reply when user row is missing', async () => {
      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();
      // Users query returns empty array → user not found
      const db = makeAddDbMock({ planId: 'plan-free', isAdmin: false }, []);
      // Override: make the users table query return []
      let callIndex = 0;
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
        const idx = callIndex++;
        if (idx === 0) {
          // users query → empty
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        };
      });

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope();
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect(syncAgentSkillAssignmentsMock).not.toHaveBeenCalled();
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-abc-123',
        expect.objectContaining({
          status: 'error',
          errorCode: 'user_not_found',
        }),
      );
    });
  });

  // ── MANAGE_AGENT_SKILLS remove ───────────────────────────────────────────

  describe('remove action', () => {
    it('deletes assignment and publishes success reply', async () => {
      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();
      const db = makeRemoveDbMock([{ skillId: 'trading' }]);

      resolveSkillAssignmentsMock.mockResolvedValue({ assignments: [] });

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope({
        payload: { action: 'remove', skillIds: ['trading'], requestMessageId: 'req-remove-1' },
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect(syncAgentSkillAssignmentsMock).toHaveBeenCalledWith(
        db,
        'agent-123',
        'user-1',
        expect.any(Array),
        'agent_self',
      );
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-remove-1',
        expect.objectContaining({
          status: 'ok',
          action: 'remove',
          skillIds: ['trading'],
          warnings: [],
        }),
      );
    });

    it('publishes success reply with warnings for non-assigned skill', async () => {
      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();
      // No existing skills → the requested skill is not assigned
      const db = makeRemoveDbMock([]);

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope({
        payload: { action: 'remove', skillIds: ['nonexistent-skill'], requestMessageId: 'req-remove-2' },
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-remove-2',
        expect.objectContaining({
          status: 'ok',
          action: 'remove',
          skillIds: [],
          warnings: ['nonexistent-skill'],
        }),
      );
    });

    it('rejects base skill ID with base_skill_protected error code', async () => {
      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();
      const db = makeRemoveDbMock([{ skillId: 'base' }]);

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope({
        payload: { action: 'remove', skillIds: ['base'], requestMessageId: 'req-remove-base' },
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect(syncAgentSkillAssignmentsMock).not.toHaveBeenCalled();
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-remove-base',
        expect.objectContaining({
          status: 'error',
          errorCode: 'base_skill_protected',
        }),
      );
    });

    it('removes one of two skills and re-resolves remaining assignments', async () => {
      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();
      // Agent has both 'trading' and 'analytics' — we remove 'trading', leaving 'analytics'
      const db = makeRemoveDbMock(
        [{ skillId: 'trading' }, { skillId: 'analytics' }],
        { planId: 'plan-free', isAdmin: false },
      );

      resolveSkillAssignmentsMock.mockResolvedValue({
        assignments: [{ skillId: 'analytics', skillRevisionId: 'rev-2' }],
      });

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope({
        payload: { action: 'remove', skillIds: ['trading'], requestMessageId: 'req-remove-partial' },
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      // resolveSkillAssignmentsForUser called with remaining skill only
      expect(resolveSkillAssignmentsMock).toHaveBeenCalledWith(
        db,
        'user-1',
        ['analytics'],
        expect.any(Set),
        expect.any(Boolean),
      );
      expect(syncAgentSkillAssignmentsMock).toHaveBeenCalledWith(
        db,
        'agent-123',
        'user-1',
        [{ skillId: 'analytics', skillRevisionId: 'rev-2' }],
        'agent_self',
      );
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-remove-partial',
        expect.objectContaining({
          status: 'ok',
          action: 'remove',
          skillIds: ['trading'],
          warnings: [],
        }),
      );
    });
  });

  // ── General ──────────────────────────────────────────────────────────────

  describe('general', () => {
    it('uses requestMessageId from the envelope payload for reply routing', async () => {
      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();
      const db = makeAddDbMock();

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const customRequestId = 'custom-req-id-xyz';
      const envelope = makeSkillsEnvelope({
        payload: { action: 'add', skillIds: ['trading'], requestMessageId: customRequestId },
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        customRequestId,
        expect.any(Object),
      );
    });

    it('does not publish reply when requestMessageId is absent', async () => {
      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();

      // No db → triggers db_unavailable path (which calls publishReply internally)
      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
      );

      const envelope = makeSkillsEnvelope({
        payload: { action: 'add', skillIds: ['trading'] }, // no requestMessageId
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      // publishSkillsReply should not be called when requestMessageId is absent
      expect((eventPublisher as any).publishSkillsReply).not.toHaveBeenCalled();
    });

    it('publishes broker.internal_error reply when an unexpected exception occurs', async () => {
      syncAgentSkillAssignmentsMock.mockRejectedValue(new Error('DB connection lost'));

      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();
      const db = makeAddDbMock();

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope();
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-abc-123',
        expect.objectContaining({
          status: 'error',
          errorCode: 'broker.internal_error',
          error: expect.stringContaining('DB connection lost'),
        }),
      );
    });
  });
});

// ── plansConfig constructor parameter ────────────────────────────────────────

describe('AgentMessageBroker — plansConfig constructor parameter', () => {
  it('accepts plansConfig as a readonly constructor parameter', () => {
    const agentRepo = mockAgentRepo();
    const plansConfig = { someSetting: true } as any;

    const broker = new AgentMessageBroker(
      {} as any,
      agentRepo as any,
      mockDecisionHandler(),
      mockSessionManager(),
      mockEventPublisher(),
      undefined, // telegram
      undefined, // botRepo
      undefined, // botLiveCheck
      undefined, // emailClient
      undefined, // onAgentConfigUpdate
      undefined, // brandImageUrl
      undefined, // db
      undefined, // operatorModelDefaults
      plansConfig,
    );

    // plansConfig is readonly (not private readonly), so it's accessible
    expect(broker.plansConfig).toBe(plansConfig);
  });

  it('defaults plansConfig to undefined when not provided', () => {
    const broker = new AgentMessageBroker(
      {} as any,
      mockAgentRepo() as any,
      mockDecisionHandler(),
      mockSessionManager(),
      mockEventPublisher(),
    );

    expect(broker.plansConfig).toBeUndefined();
  });
});


// ── lookupSlugsForIds enrichment tests ───────────────────────────────────────

describe('handleManageAgentSkills — slug enrichment', () => {
  const resolveSkillAssignmentsMock = vi.mocked(resolveSkillAssignmentsForUser);
  const syncAgentSkillAssignmentsMock = vi.mocked(syncAgentSkillAssignments);

  function makeSkillsEnvelope(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 'v1',
      messageId: `msg-${Math.random().toString(36).slice(2)}`,
      correlationId: 'corr-001',
      initiatorType: 'agent',
      initiatorId: 'agent-123',
      agentId: 'agent-123',
      type: 'agent.manage_skills',
      createdAt: new Date().toISOString(),
      payload: {
        action: 'add',
        skillIds: ['trading'],
        requestMessageId: 'req-slug-test',
      },
      ...overrides,
    };
  }

  function makeSkillsEventPublisher() {
    return {
      emitDecisionAccepted: vi.fn().mockResolvedValue(undefined),
      emitDecisionRejected: vi.fn().mockResolvedValue(undefined),
      emitInstanceStatus: vi.fn().mockResolvedValue(undefined),
      emitToolResult: vi.fn().mockResolvedValue(undefined),
      publishSkillsReply: vi.fn().mockResolvedValue(undefined),
    } as unknown as InstanceEventPublisher;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resolveSkillAssignmentsMock.mockResolvedValue({
      assignments: [{ skillId: 'trading', skillRevisionId: 'rev-1' }],
    });
    syncAgentSkillAssignmentsMock.mockResolvedValue(undefined);
  });

  // ── Helpers for extended DB mocks that support the skills table lookup ──

  /**
   * Extended add DB mock supporting 3 select calls:
   *   1. users query (.limit(1))
   *   2. agentSkills query (no .limit())
   *   3. skills slug lookup (no .limit()) → returns skillSlugRows
   */
  function makeAddDbMockWithSlugs(
    userRow: Record<string, unknown> = { planId: 'plan-free', isAdmin: false },
    existingSkillRows: Array<{ skillId: string }> = [],
    skillSlugRows: Array<{ id: string; slug: string }> = [],
  ) {
    let callIndex = 0;
    const selectFn = vi.fn().mockImplementation(() => {
      const idx = callIndex++;
      if (idx === 0) {
        // users table query — has .limit()
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([userRow]),
            }),
          }),
        };
      }
      if (idx === 1) {
        // agentSkills table query — no .limit()
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(existingSkillRows),
          }),
        };
      }
      // skills slug lookup — no .limit()
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(skillSlugRows),
        }),
      };
    });
    return { select: selectFn, transaction: vi.fn() } as any;
  }

  /**
   * Extended remove DB mock supporting up to 4 select calls:
   *   1. agentSkills query (no .limit())
   *   2. skills slug lookup for warnings (no .limit()) — only if warningIds.length > 0
   *   3. users query (.limit(1)) — only if remaining skills > 0
   *   4. skills slug lookup for error enrichment (no .limit()) — only if resolution error with details
   *
   * When there are no warnings, the order shifts:
   *   1. agentSkills query
   *   2. users query (.limit(1))
   *   3. skills slug lookup for error enrichment
   *
   * Callers define the exact call sequence via the `callSequence` array.
   */
  function makeRemoveDbMockWithSlugs(
    callSequence: Array<{ type: 'agentSkills'; data: Array<{ skillId: string }> }
      | { type: 'slugLookup'; data: Array<{ id: string; slug: string }> }
      | { type: 'users'; data: Array<Record<string, unknown>> }>,
  ) {
    let callIndex = 0;
    const selectFn = vi.fn().mockImplementation(() => {
      const call = callSequence[callIndex++];
      if (!call) {
        // Fallback — return empty
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        };
      }
      if (call.type === 'users') {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(call.data),
            }),
          }),
        };
      }
      // Both agentSkills and slugLookup don't use .limit()
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(call.data),
        }),
      };
    });
    return { select: selectFn, transaction: vi.fn() } as any;
  }

  // ── handleSkillAdd error enrichment ──────────────────────────────────────

  describe('add action — error enrichment with slugs', () => {
    it('enriches error message with slugs when resolution returns error with details', async () => {
      // resolveSkillAssignmentsForUser returns an error containing the raw skill ID in its details
      resolveSkillAssignmentsMock.mockResolvedValue({
        error: {
          code: 'validation_error',
          message: 'Some selected skills do not exist',
          details: [{ message: 'Unknown skillIds: skill-id-abc' }],
        },
      });

      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();
      // DB mock returns slug mapping for the requested skill ID
      const db = makeAddDbMockWithSlugs(
        { planId: 'plan-free', isAdmin: false },
        [],
        [{ id: 'skill-id-abc', slug: 'system/trading' }],
      );

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope({
        payload: { action: 'add', skillIds: ['skill-id-abc'], requestMessageId: 'req-slug-add' },
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect(syncAgentSkillAssignmentsMock).not.toHaveBeenCalled();
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-slug-add',
        expect.objectContaining({
          status: 'error',
          action: 'add',
          errorCode: 'validation_error',
          // The enriched error should contain the slug replacing the ID
          error: expect.stringContaining('system/trading'),
        }),
      );
      // The enriched message should include the original message followed by a dash and the detail
      const call = (eventPublisher as any).publishSkillsReply.mock.calls[0];
      expect(call[1].error).toMatch(/Some selected skills do not exist — Unknown skillIds: system\/trading/);
    });

    it('falls back to raw IDs when slug lookup fails (lookupSlugsForIds degrades gracefully)', async () => {
      resolveSkillAssignmentsMock.mockResolvedValue({
        error: {
          code: 'validation_error',
          message: 'Some selected skills do not exist',
          details: [{ message: 'Unknown skillIds: skill-id-abc' }],
        },
      });

      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();
      // DB mock that throws on the 3rd call (slug lookup), simulating a DB error
      let callIndex = 0;
      const db = {
        select: vi.fn().mockImplementation(() => {
          const idx = callIndex++;
          if (idx === 0) {
            return {
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{ planId: 'plan-free', isAdmin: false }]),
                }),
              }),
            };
          }
          if (idx === 1) {
            return {
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([]),
              }),
            };
          }
          // 3rd call — slug lookup throws
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockRejectedValue(new Error('skills table unavailable')),
            }),
          };
        }),
        transaction: vi.fn(),
      } as any;

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope({
        payload: { action: 'add', skillIds: ['skill-id-abc'], requestMessageId: 'req-slug-fallback' },
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      // Should still produce the error reply, but with raw IDs since slug lookup failed
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-slug-fallback',
        expect.objectContaining({
          status: 'error',
          // The message still contains the raw ID since slug map is empty
          error: expect.stringContaining('skill-id-abc'),
        }),
      );
    });

    it('enriches multiple skill IDs with their respective slugs', async () => {
      resolveSkillAssignmentsMock.mockResolvedValue({
        error: {
          code: 'validation_error',
          message: 'Some selected skills do not exist',
          details: [{ message: 'Unknown skillIds: skill-id-1, skill-id-2' }],
        },
      });

      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();
      const db = makeAddDbMockWithSlugs(
        { planId: 'plan-free', isAdmin: false },
        [],
        [
          { id: 'skill-id-1', slug: 'system/trading' },
          { id: 'skill-id-2', slug: 'community/analytics' },
        ],
      );

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope({
        payload: { action: 'add', skillIds: ['skill-id-1', 'skill-id-2'], requestMessageId: 'req-multi-slug' },
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      const call = (eventPublisher as any).publishSkillsReply.mock.calls[0];
      expect(call[1].error).toContain('system/trading');
      expect(call[1].error).toContain('community/analytics');
      expect(call[1].error).not.toContain('skill-id-1');
      expect(call[1].error).not.toContain('skill-id-2');
    });

    it('does not enrich when resolution error has no details array', async () => {
      resolveSkillAssignmentsMock.mockResolvedValue({
        error: {
          code: 'validation_error',
          message: 'Some selected skills are not selectable for this user',
          // No details array
        },
      });

      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();
      const db = makeAddDbMockWithSlugs(
        { planId: 'plan-free', isAdmin: false },
        [],
        [{ id: 'skill-id-abc', slug: 'system/trading' }],
      );

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope({
        payload: { action: 'add', skillIds: ['skill-id-abc'], requestMessageId: 'req-no-details' },
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      const call = (eventPublisher as any).publishSkillsReply.mock.calls[0];
      // Error message is the original, not enriched (no " — " separator)
      expect(call[1].error).toBe('Some selected skills are not selectable for this user');
    });
  });

  // ── handleSkillRemove warning enrichment ─────────────────────────────────

  describe('remove action — warning enrichment with slugs', () => {
    it('maps warning IDs to slugs when skill is not assigned', async () => {
      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();

      // Remove path: skill-id-xyz is NOT in existing skills → becomes a warning
      // Call sequence:
      //   1. agentSkills query → empty (no existing skills)
      //   2. slug lookup for warnings → returns slug
      const db = makeRemoveDbMockWithSlugs(
        [
          { type: 'agentSkills', data: [] },
          { type: 'slugLookup', data: [{ id: 'skill-id-xyz', slug: 'community/research' }] },
        ],
      );

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope({
        payload: { action: 'remove', skillIds: ['skill-id-xyz'], requestMessageId: 'req-warn-slug' },
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-warn-slug',
        expect.objectContaining({
          status: 'ok',
          action: 'remove',
          skillIds: [],
          warnings: ['community/research'],
        }),
      );
    });

    it('falls back to raw IDs in warnings when slug lookup fails', async () => {
      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();

      // The existing makeRemoveDbMock doesn't support the skills query,
      // so lookupSlugsForIds will throw and degrade to an empty map
      let callIndex = 0;
      const db = {
        select: vi.fn().mockImplementation(() => {
          const idx = callIndex++;
          if (idx === 0) {
            // agentSkills query → empty
            return {
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([]),
              }),
            };
          }
          // slug lookup → throws
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockRejectedValue(new Error('skills table unavailable')),
            }),
          };
        }),
        transaction: vi.fn(),
      } as any;

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope({
        payload: { action: 'remove', skillIds: ['nonexistent-skill'], requestMessageId: 'req-warn-raw' },
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect((eventPublisher as any).publishSkillsReply).toHaveBeenCalledWith(
        'req-warn-raw',
        expect.objectContaining({
          status: 'ok',
          action: 'remove',
          skillIds: [],
          // Falls back to raw ID since slug lookup failed
          warnings: ['nonexistent-skill'],
        }),
      );
    });
  });

  // ── handleSkillRemove error enrichment ───────────────────────────────────

  describe('remove action — error enrichment with slugs', () => {
    it('enriches resolution error message with slugs during remove', async () => {
      // Agent has 'trading' and 'analytics' — we remove 'trading', leaving 'analytics'
      // resolveSkillAssignmentsForUser returns an error for the remaining skills
      resolveSkillAssignmentsMock.mockResolvedValue({
        error: {
          code: 'validation_error',
          message: 'Some selected skills do not exist',
          details: [{ message: 'Unknown skillIds: skill-id-analytics' }],
        },
      });

      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();

      // Remove path with remaining skills:
      //   1. agentSkills query → existing skills
      //   2. users query (.limit(1)) — remaining > 0
      //   3. slug lookup for error enrichment → returns slug
      const db = makeRemoveDbMockWithSlugs(
        [
          { type: 'agentSkills', data: [{ skillId: 'skill-id-trading' }, { skillId: 'skill-id-analytics' }] },
          { type: 'users', data: [{ planId: 'plan-free', isAdmin: false }] },
          { type: 'slugLookup', data: [
            { id: 'skill-id-analytics', slug: 'system/analytics' },
            { id: 'skill-id-trading', slug: 'system/trading' },
          ]},
        ],
      );

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope({
        payload: { action: 'remove', skillIds: ['skill-id-trading'], requestMessageId: 'req-remove-enrich' },
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      expect(syncAgentSkillAssignmentsMock).not.toHaveBeenCalled();
      const call = (eventPublisher as any).publishSkillsReply.mock.calls[0];
      expect(call[1].status).toBe('error');
      expect(call[1].action).toBe('remove');
      expect(call[1].errorCode).toBe('validation_error');
      // The enriched error should contain the slug replacing the ID
      expect(call[1].error).toMatch(/Some selected skills do not exist — Unknown skillIds: system\/analytics/);
    });

    it('degrades gracefully when slug lookup fails during remove error enrichment', async () => {
      resolveSkillAssignmentsMock.mockResolvedValue({
        error: {
          code: 'validation_error',
          message: 'Some selected skills do not exist',
          details: [{ message: 'Unknown skillIds: skill-id-analytics' }],
        },
      });

      const agentRepo = mockAgentRepo();
      agentRepo.getAgent.mockResolvedValue({ id: 'agent-123', userId: 'user-1', status: 'active' });

      const eventPublisher = makeSkillsEventPublisher();

      // Remove path where slug lookup fails:
      //   1. agentSkills query → existing skills
      //   2. users query
      //   3. slug lookup → throws
      let callIndex = 0;
      const db = {
        select: vi.fn().mockImplementation(() => {
          const idx = callIndex++;
          if (idx === 0) {
            // agentSkills query
            return {
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([{ skillId: 'skill-id-trading' }, { skillId: 'skill-id-analytics' }]),
              }),
            };
          }
          if (idx === 1) {
            // users query
            return {
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([{ planId: 'plan-free', isAdmin: false }]),
                }),
              }),
            };
          }
          // slug lookup → throws
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockRejectedValue(new Error('skills table unavailable')),
            }),
          };
        }),
        transaction: vi.fn(),
      } as any;

      const broker = new AgentMessageBroker(
        {} as any,
        agentRepo as any,
        mockDecisionHandler(),
        mockSessionManager(),
        eventPublisher,
        undefined, undefined, undefined, undefined, undefined, undefined,
        db,
      );

      const envelope = makeSkillsEnvelope({
        payload: { action: 'remove', skillIds: ['skill-id-trading'], requestMessageId: 'req-remove-degrade' },
      });
      const result = await broker.processInbound(envelope);

      expect(result.accepted).toBe(true);
      const call = (eventPublisher as any).publishSkillsReply.mock.calls[0];
      expect(call[1].status).toBe('error');
      // Error still contains the raw ID since slug map is empty
      expect(call[1].error).toContain('skill-id-analytics');
    });
  });
});
