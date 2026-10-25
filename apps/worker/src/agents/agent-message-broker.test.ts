import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { AgentRepository } from '@herobids/db';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import { AgentMessageBroker, type AgentMessageNotifier } from './agent-message-broker.js';
import { ChatDelivery } from '../alerting/chat-delivery.js';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.js';
import type { AppConfig } from '@herobids/domain';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRedis(): Redis {
  return {} as Redis;
}

function makeAgentRepo(overrides: Partial<AgentRepository> = {}): AgentRepository {
  return {
    getAgent: vi.fn(async () => ({ id: 'agent-1', toolPolicy: null })),
    isMessageDuplicate: vi.fn(async () => false),
    isActiveSession: vi.fn(async () => true),
    getActiveSession: vi.fn(async () => ({ id: 'session-1' })),
    insertMessage: vi.fn(async () => undefined),
    markMessageProcessed: vi.fn(async () => undefined),
    getRuntimeCapabilityDescriptor: vi.fn(async () => ({ resolvedSkills: [] })),
    ...overrides,
  } as unknown as AgentRepository;
}

function makeDecisionHandler(): AgentDecisionHandler {
  return {} as AgentDecisionHandler;
}

function makeSessionManager(): AgentSessionManager {
  return {} as AgentSessionManager;
}

function makeEventPublisher(): InstanceEventPublisher {
  return {} as InstanceEventPublisher;
}

/**
 * Builds a valid agent.message.send envelope.
 * send_message is a brokered capability that goes through the policy gate.
 */
function makeSendMessageEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'v1',
    messageId: `msg-${Date.now()}`,
    correlationId: 'session-1',
    initiatorType: 'agent',
    initiatorId: 'agent-1',
    agentId: 'agent-1',
    type: 'agent.message.send',
    createdAt: new Date().toISOString(),
    payload: { body: 'Hello from agent' },
    ...overrides,
  };
}

function makeEnvelope(
  type: string,
  payload: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 'v1',
    messageId: `msg-${Date.now()}-${Math.random()}`,
    correlationId: 'session-1',
    initiatorType: 'agent',
    initiatorId: 'agent-1',
    agentId: 'agent-1',
    type,
    createdAt: new Date().toISOString(),
    payload,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AgentMessageBroker — CapabilityDenial string interpolation', () => {
  let agentRepo: AgentRepository;
  let broker: AgentMessageBroker;

  beforeEach(() => {
    agentRepo = makeAgentRepo();
    broker = new AgentMessageBroker(
      makeRedis(),
      agentRepo,
      makeDecisionHandler(),
      makeSessionManager(),
      makeEventPublisher(),
    );
  });

  it('error string contains denied.reason, not [object Object] (capability_disabled)', async () => {
    // Override getAgent to return a policy that disables send_message
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        send_message: { capability: 'send_message', tier: 'brokered', enabled: false },
      },
    } as never);

    const result = await broker.processInbound(makeSendMessageEnvelope());

    expect(result.accepted).toBe(false);
    expect(result.error).toContain('capability_denied');
    expect(result.error).toContain('capability_disabled');
    expect(result.error).not.toContain('[object Object]');
  });

  it('error string contains denied.reason for rate_limit_exceeded', async () => {
    // First call passes the policy gate (incrementing the rate counter via recordStart)
    // but fails inside handleSendMessage. Second call hits the rate limit at the gate.
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        send_message: {
          capability: 'send_message',
          tier: 'brokered',
          enabled: true,
          limits: { maxPerMinute: 1 },
        },
      },
    } as never);

    // First call: passes policy gate, recordStart increments counter.
    // It may fail at the handler level — that's OK for this test.
    const firstEnvelope = makeSendMessageEnvelope({ messageId: 'msg-first' });
    await broker.processInbound(firstEnvelope);

    // Second call: should be rate-limited at the policy gate.
    const secondEnvelope = makeSendMessageEnvelope({ messageId: 'msg-second' });
    const result = await broker.processInbound(secondEnvelope);

    expect(result.accepted).toBe(false);
    expect(result.error).toContain('capability_denied');
    expect(result.error).toContain('rate_limit_exceeded');
    expect(result.error).not.toContain('[object Object]');
  });

  it('error string format is capability_denied:<reason>', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        send_message: { capability: 'send_message', tier: 'brokered', enabled: false },
      },
    } as never);

    const result = await broker.processInbound(makeSendMessageEnvelope());

    expect(result.accepted).toBe(false);
    // The error is formatted as `capability_denied:<reason>`
    expect(result.error).toMatch(/^capability_denied:/);
    expect(result.error).not.toContain('[object Object]');
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Broker Denial Replies — extractDenialReplyKey
// ═══════════════════════════════════════════════════════════════════════════

describe('AgentMessageBroker — extractDenialReplyKey', () => {
  let agentRepo: AgentRepository;
  let redis: Redis;
  let broker: AgentMessageBroker;

  beforeEach(() => {
    agentRepo = makeAgentRepo();
    redis = {
      lpush: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
    } as unknown as Redis;
    broker = new AgentMessageBroker(
      redis,
      agentRepo,
      makeDecisionHandler(),
      makeSessionManager(),
      makeEventPublisher(),
    );
  });

  it('returns agent:decision:reply:{decisionId} for DECISION_SUBMIT', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        submit_decision: { capability: 'submit_decision', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeEnvelope('agent.decision.submit', {
      decisionId: 'dec-123',
      instrumentId: 'BTC',
      intent: 'go_long',
      targetSize: '1.0',
      rationaleSummary: 'test trade',
    });
    await broker.processInbound(envelope);

    expect(redis.lpush).toHaveBeenCalledWith(
      'agent:decision:reply:dec-123',
      expect.any(String),
    );
  });

  it('pushes a denial reply to agent:update-prompt:reply:{requestMessageId} when update_my_prompt is denied', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        update_my_prompt: { capability: 'update_my_prompt', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeEnvelope('agent.update_prompt', { prompt: 'Watch ETH.', requestMessageId: 'req-up-1' });
    const result = await broker.processInbound(envelope);

    expect(result.accepted).toBe(false);
    expect(redis.lpush).toHaveBeenCalledWith(
      'agent:update-prompt:reply:req-up-1',
      expect.stringContaining('"status":"rejected"'),
    );
  });

  it('rejects the legacy TOOL_ASSESS_STRATEGY_PRESET message type (tool now Traderton-owned)', async () => {
    // The assess_strategy_preset tool is now Traderton-owned (H1); the local
    // broker no longer routes it.
    const envelope = makeEnvelope('agent.tool.assess_strategy_preset.request', {
      requestMessageId: 'req-456',
      symbols: ['BTC'],
      venueFamily: 'hyperliquid',
      agentId: 'agent-1',
      sessionId: 'session-1',
    });
    const result = await broker.processInbound(envelope);

    expect(result.accepted).toBe(false);
    expect(result.error).toBe('unknown_message_type');
  });

  it('rejects the legacy TOOL_CHANGE_STRATEGY_PRESET message type (tool now Traderton-owned)', async () => {
    const envelope = makeEnvelope('agent.tool.change_strategy_preset.request', {
      requestMessageId: 'req-789',
      assessmentArtifactId: 'art-1',
      targetPreset: 'momentum',
      mode: 'entries_only',
      agentId: 'agent-1',
      sessionId: 'session-1',
    });
    const result = await broker.processInbound(envelope);

    expect(result.accepted).toBe(false);
    expect(result.error).toBe('unknown_message_type');
  });

  it('returns agent:skills:reply:{requestMessageId} for MANAGE_AGENT_SKILLS', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        manage_agent_skills: { capability: 'manage_agent_skills', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeEnvelope('agent.manage_skills', {
      requestMessageId: 'req-skills-1',
      action: 'add',
      skillIds: ['skill-1'],
    });
    await broker.processInbound(envelope);

    expect(redis.lpush).toHaveBeenCalledWith(
      'agent:skills:reply:req-skills-1',
      expect.any(String),
    );
  });

  it('returns undefined for SEND_MESSAGE (fire-and-forget — no lpush)', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        send_message: { capability: 'send_message', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeSendMessageEnvelope();
    await broker.processInbound(envelope);

    expect(redis.lpush).not.toHaveBeenCalled();
  });

  it('returns undefined for PUBLISH_ARTIFACT (fire-and-forget — no lpush)', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        publish_artifact: { capability: 'publish_artifact', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeEnvelope('agent.artifact.publish', {
      artifactId: 'art-1',
      artifactType: 'journal',
      contentType: 'text/plain',
      summary: 'test artifact',
    });
    await broker.processInbound(envelope);

    expect(redis.lpush).not.toHaveBeenCalled();
  });

  // NOTE: The scenario "DECISION_SUBMIT payload is missing decisionId" cannot
  // occur through processInbound because decisionId is required by
  // DecisionSubmitPayloadSchema and payload validation runs before the
  // capability gate. The test below verifies that an invalid payload is
  // rejected at the validation stage (step 2), never reaching extractDenialReplyKey.
  it('rejects DECISION_SUBMIT with missing decisionId at payload validation (before capability gate)', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        submit_decision: { capability: 'submit_decision', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeEnvelope('agent.decision.submit', {
      instrumentId: 'BTC',
      intent: 'go_long',
      targetSize: '1.0',
      rationaleSummary: 'test',
    });
    const result = await broker.processInbound(envelope);

    expect(result.accepted).toBe(false);
    expect(result.error).toBe('invalid_payload');
    expect(redis.lpush).not.toHaveBeenCalled();
  });

  it('returns undefined when preset request payload is missing requestMessageId', async () => {
    // requestMessageId is optional in the schema, so payload validation passes
    // but extractDenialReplyKey returns undefined when it's absent
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        assess_strategy_preset: { capability: 'assess_strategy_preset', tier: 'brokered', enabled: false },
      },
    } as never);

    // payload lacks requestMessageId — extractDenialReplyKey should return undefined
    const envelope = makeEnvelope('agent.tool.assess_strategy_preset.request', {
      symbols: ['BTC'],
      venueFamily: 'hyperliquid',
      agentId: 'agent-1',
      sessionId: 'session-1',
    });
    await broker.processInbound(envelope);

    expect(redis.lpush).not.toHaveBeenCalled();
  });

  it('returns undefined for MANAGE_BOT (fire-and-forget — no lpush)', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        manage_bot: { capability: 'manage_bot', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeEnvelope('agent.manage_bot', { action: 'create_and_start' });
    const result = await broker.processInbound(envelope);

    expect(result.accepted).toBe(false);
    expect(redis.lpush).not.toHaveBeenCalled();
  });

  it('returns undefined for BOT_QUERY (fire-and-forget — no lpush)', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        bot_query: { capability: 'bot_query', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeEnvelope('agent.bot.query', { action: 'list_bots' });
    const result = await broker.processInbound(envelope);

    expect(result.accepted).toBe(false);
    expect(redis.lpush).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Broker Denial Replies — processInbound denial + Redis push
// ═══════════════════════════════════════════════════════════════════════════

describe('AgentMessageBroker — processInbound denial Redis reply', () => {
  let agentRepo: AgentRepository;
  let redis: Redis;
  let broker: AgentMessageBroker;

  beforeEach(() => {
    agentRepo = makeAgentRepo();
    redis = {
      lpush: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
    } as unknown as Redis;
    broker = new AgentMessageBroker(
      redis,
      agentRepo,
      makeDecisionHandler(),
      makeSessionManager(),
      makeEventPublisher(),
    );
  });

  it('pushes structured JSON denial with correct fields to Redis on DECISION_SUBMIT denial', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        submit_decision: { capability: 'submit_decision', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeEnvelope('agent.decision.submit', {
      decisionId: 'dec-abc',
      instrumentId: 'BTC',
      intent: 'go_long',
      targetSize: '1.0',
      rationaleSummary: 'test trade',
    });
    const result = await broker.processInbound(envelope);

    expect(result.accepted).toBe(false);

    // Verify lpush called with the correct key
    expect(redis.lpush).toHaveBeenCalledOnce();
    const [key, value] = (redis.lpush as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(key).toBe('agent:decision:reply:dec-abc');

    // Verify the JSON structure of the denial reply
    const parsed = JSON.parse(value);
    expect(parsed.status).toBe('rejected');
    expect(parsed.code).toContain('capability_denied:');
    expect(parsed.message).toEqual(expect.any(String));
  });

  it('sets 60s TTL on the reply key after lpush', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        submit_decision: { capability: 'submit_decision', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeEnvelope('agent.decision.submit', {
      decisionId: 'dec-ttl',
      instrumentId: 'ETH',
      intent: 'go_short',
      targetSize: '0.5',
      rationaleSummary: 'ttl test',
    });
    await broker.processInbound(envelope);

    expect(redis.expire).toHaveBeenCalledWith('agent:decision:reply:dec-ttl', 60);
  });

  it('includes retryAfterMs in denial reply for rate-limited capabilities', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        submit_decision: {
          capability: 'submit_decision',
          tier: 'brokered',
          enabled: true,
          limits: { maxPerMinute: 1 },
        },
      },
    } as never);

    // First call passes — increments the rate counter
    const first = makeEnvelope('agent.decision.submit', {
      decisionId: 'dec-first',
      instrumentId: 'BTC',
      intent: 'go_long',
      targetSize: '1.0',
      rationaleSummary: 'first trade',
    });
    await broker.processInbound(first);

    // Second call should be rate-limited and get a denial reply
    const second = makeEnvelope('agent.decision.submit', {
      decisionId: 'dec-second',
      instrumentId: 'BTC',
      intent: 'go_long',
      targetSize: '1.0',
      rationaleSummary: 'second trade',
    });
    await broker.processInbound(second);

    // The second call should trigger lpush with a rate_limit denial
    const lpushCalls = (redis.lpush as ReturnType<typeof vi.fn>).mock.calls;
    // Find the call for dec-second
    const secondCall = lpushCalls.find(
      (call: unknown[]) => (call[0] as string) === 'agent:decision:reply:dec-second',
    );
    expect(secondCall).toBeDefined();

    const parsed = JSON.parse(secondCall![1] as string);
    expect(parsed.status).toBe('rejected');
    expect(parsed.code).toContain('rate_limit');
    // Verify rate-limit-specific fields are present in the pushed JSON
    expect(parsed.retryAfterMs).toEqual(expect.any(Number));
    expect(parsed.limit).toEqual(expect.any(Number));
    expect(parsed.used).toEqual(expect.any(Number));
  });

  it('does NOT call lpush for fire-and-forget SEND_MESSAGE denial', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        send_message: { capability: 'send_message', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeSendMessageEnvelope();
    const result = await broker.processInbound(envelope);

    expect(result.accepted).toBe(false);
    expect(result.error).toContain('capability_denied');
    expect(redis.lpush).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// request_connection broker handler
// ═══════════════════════════════════════════════════════════════════════════

describe('AgentMessageBroker — request_connection', () => {
  let agentRepo: AgentRepository;
  let redis: Redis;
  let eventPublisher: InstanceEventPublisher;
  let broker: AgentMessageBroker;

  function makeRequestEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return makeEnvelope('agent.request_connection', {
      provider: 'gmail',
      requestMessageId: 'req-conn-1',
      ...overrides,
    });
  }

  beforeEach(() => {
    agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      userId: 'user-1',
      toolPolicy: null,
    } as never);

    redis = {
      set: vi.fn(async () => 'OK'),
      zadd: vi.fn(async () => 1),
      lpush: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      del: vi.fn(async () => 1),
      sadd: vi.fn(async () => 1),
      srem: vi.fn(async () => 1),
      scard: vi.fn(async () => 0),
    } as unknown as Redis;

    eventPublisher = {
      publishConnectionRequestReply: vi.fn(async () => undefined),
    } as unknown as InstanceEventPublisher;

    broker = new AgentMessageBroker(
      redis,
      agentRepo,
      makeDecisionHandler(),
      makeSessionManager(),
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
      undefined,
      'http://localhost:3000',
      { ttlSecs: 1800, maxPendingPerAgent: 3, expiryGraceSecs: 300 },
    );
  });

  it('replies with an error listing valid ids for an unknown provider', async () => {
    const result = await broker.processInbound(makeRequestEnvelope({ provider: 'unknown-provider' }));

    expect(result.accepted).toBe(true);
    expect(eventPublisher.publishConnectionRequestReply).toHaveBeenCalledWith(
      'req-conn-1',
      expect.objectContaining({
        status: 'error',
        errorCode: 'connection.unknown_provider',
      }),
    );
    const [, reply] = (eventPublisher.publishConnectionRequestReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(reply.error).toContain('hyperliquid');
    expect(reply.error).toContain('gmail');
  });

  it('replies connection.request_pending when a request for the same agent+provider is already pending', async () => {
    vi.mocked(redis.set).mockResolvedValue(null as never); // SET NX fails — key exists

    const result = await broker.processInbound(makeRequestEnvelope());

    expect(result.accepted).toBe(true);
    expect(eventPublisher.publishConnectionRequestReply).toHaveBeenCalledWith(
      'req-conn-1',
      expect.objectContaining({
        status: 'error',
        errorCode: 'connection.request_pending',
      }),
    );
  });

  it('writes the request record, pending sorted set, and returns the link on success', async () => {
    const result = await broker.processInbound(makeRequestEnvelope());

    expect(result.accepted).toBe(true);

    // (b) one-pending-per-provider SET NX EX
    expect(redis.set).toHaveBeenCalledWith(
      'connection-request:pending:agent-1:gmail',
      '1',
      'EX',
      1800,
      'NX',
    );

    // (d) request record written with TTL
    const recordSetCall = (redis.set as ReturnType<typeof vi.fn>).mock.calls.find(
      (call: unknown[]) => (call[0] as string).startsWith('connection-request:')
        && !(call[0] as string).startsWith('connection-request:pending:'),
    );
    expect(recordSetCall).toBeDefined();
    const recordKey = recordSetCall![0] as string;
    const record = JSON.parse(recordSetCall![1] as string);
    expect(record).toMatchObject({
      agentId: 'agent-1',
      userId: 'user-1',
      provider: 'gmail',
      status: 'pending',
    });
    expect(record.requestId).toBeDefined();
    expect(record.token).toBeDefined();
    expect(record.expiresAt).toBeDefined();
    expect(recordSetCall![2]).toBe('EX');
    expect(recordSetCall![3]).toBe(2100);

    // (e) pending sorted set scored by expiresAt epoch ms
    expect(redis.zadd).toHaveBeenCalledWith(
      'connection-requests:pending',
      expect.any(Number),
      record.requestId,
    );

    // (g) reply carries requestId + link + expiresAt
    expect(eventPublisher.publishConnectionRequestReply).toHaveBeenCalledWith(
      'req-conn-1',
      expect.objectContaining({
        status: 'ok',
        requestId: record.requestId,
        expiresAt: record.expiresAt,
      }),
    );
    const [, reply] = (eventPublisher.publishConnectionRequestReply as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(reply.link).toBe(`http://localhost:3000/auth/connection-request/callback?token=${record.token}`);
  });

  it('rejects a trading-family provider when the agent lacks trading capability', async () => {
    vi.mocked(agentRepo.getRuntimeCapabilityDescriptor).mockResolvedValue({
      resolvedSkills: [{ id: 'base', capabilityFamilies: [] }],
    } as never);

    const result = await broker.processInbound(makeRequestEnvelope({ provider: 'hyperliquid' }));

    expect(result.accepted).toBe(true);
    expect(eventPublisher.publishConnectionRequestReply).toHaveBeenCalledWith(
      'req-conn-1',
      expect.objectContaining({
        status: 'error',
        errorCode: 'connection.trading_not_allowed',
      }),
    );
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('allows a trading-family provider when the agent has a trading skill', async () => {
    vi.mocked(agentRepo.getRuntimeCapabilityDescriptor).mockResolvedValue({
      resolvedSkills: [{ id: 'crypto-trading', capabilityFamilies: ['trading'] }],
    } as never);

    const result = await broker.processInbound(makeRequestEnvelope({ provider: 'hyperliquid' }));

    expect(result.accepted).toBe(true);
    expect(eventPublisher.publishConnectionRequestReply).toHaveBeenCalledWith(
      'req-conn-1',
      expect.objectContaining({ status: 'ok' }),
    );
  });

  it('rejects when the agent already has maxPendingPerAgent pending requests', async () => {
    vi.mocked(redis.scard).mockResolvedValue(3 as never); // maxPendingPerAgent = 3

    const result = await broker.processInbound(makeRequestEnvelope());

    expect(result.accepted).toBe(true);
    expect(eventPublisher.publishConnectionRequestReply).toHaveBeenCalledWith(
      'req-conn-1',
      expect.objectContaining({
        status: 'error',
        errorCode: 'connection.max_pending_reached',
      }),
    );
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('releases the pending lock and per-agent set membership when a downstream write fails', async () => {
    vi.mocked(redis.zadd).mockRejectedValue(new Error('redis down'));

    const result = await broker.processInbound(makeRequestEnvelope());

    expect(result.accepted).toBe(true);
    expect(eventPublisher.publishConnectionRequestReply).toHaveBeenCalledWith(
      'req-conn-1',
      expect.objectContaining({
        status: 'error',
        errorCode: 'broker.internal_error',
      }),
    );
    expect(redis.del).toHaveBeenCalledWith('connection-request:pending:agent-1:gmail');
    expect(redis.srem).toHaveBeenCalledWith('connection-request:pending-agent:agent-1', 'gmail');
  });
});

describe('AgentMessageBroker — update_my_prompt branches', () => {
  function makeRecordingPublisher() {
    const publishUpdatePromptReply = vi.fn(async () => undefined);
    return {
      publisher: { publishUpdatePromptReply } as unknown as InstanceEventPublisher,
      publishUpdatePromptReply,
    };
  }

  it('updates the agent prompt and replies ok with the new length', async () => {
    const agentRepo = makeAgentRepo({ updateAgent: vi.fn(async () => undefined) } as never);
    const rec = makeRecordingPublisher();
    const broker = new AgentMessageBroker(makeRedis(), agentRepo, makeDecisionHandler(), makeSessionManager(), rec.publisher);

    await broker.processInbound(makeEnvelope('agent.update_prompt', { prompt: 'Watch ETH.', requestMessageId: 'req-up-ok' }));

    expect(agentRepo.updateAgent).toHaveBeenCalledWith('agent-1', { prompt: 'Watch ETH.' });
    expect(rec.publishUpdatePromptReply).toHaveBeenCalledWith('req-up-ok', { status: 'ok', promptLength: 10 });
  });

  it('replies with agent.not_found when the agent does not exist', async () => {
    const agentRepo = makeAgentRepo({ getAgent: vi.fn(async () => null), updateAgent: vi.fn(async () => undefined) } as never);
    const rec = makeRecordingPublisher();
    const broker = new AgentMessageBroker(makeRedis(), agentRepo, makeDecisionHandler(), makeSessionManager(), rec.publisher);

    await broker.processInbound(makeEnvelope('agent.update_prompt', { prompt: 'Watch ETH.', requestMessageId: 'req-up-missing' }));

    expect(agentRepo.updateAgent).not.toHaveBeenCalled();
    expect(rec.publishUpdatePromptReply).toHaveBeenCalledWith('req-up-missing', expect.objectContaining({ status: 'error', errorCode: 'agent.not_found' }));
  });

  it('replies with a retry-safe error when the prompt write fails', async () => {
    const agentRepo = makeAgentRepo({ updateAgent: vi.fn(async () => { throw new Error('db down'); }) } as never);
    const rec = makeRecordingPublisher();
    const broker = new AgentMessageBroker(makeRedis(), agentRepo, makeDecisionHandler(), makeSessionManager(), rec.publisher);

    await broker.processInbound(makeEnvelope('agent.update_prompt', { prompt: 'Watch ETH.', requestMessageId: 'req-up-fail' }));

    expect(rec.publishUpdatePromptReply).toHaveBeenCalledWith('req-up-fail', expect.objectContaining({ status: 'error', errorCode: 'broker.internal_error' }));
  });
});

// ── send_message notifications (081 W5, 082 E6) ────────────────────────────
// The broker is tested with the real NotificationDispatcher and fake channels, so these cases check the seam.

const SENDING_AGENT = { id: 'agent-1', name: 'Research Bot', userId: 'user-1', toolPolicy: null };

function makeSubscription(id: string) {
  return {
    id,
    userId: 'user-1',
    endpoint: `https://push.example.test/send/${id}`,
    p256dh: `p256dh-${id}`,
    auth: `auth-${id}`,
    userAgent: null,
    createdAt: new Date(0),
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    revokedAt: null,
  };
}

function makeNotificationsConfig(overrides: Partial<AppConfig['messaging']['notifications']> = {}): AppConfig['messaging']['notifications'] {
  return {
    enabled: true,
    eventClasses: ['agent.reply', 'agent.question'],
    webPush: {
      enabled: true,
      vapidSubject: 'mailto:ops@example.test',
      vapidPublicKey: 'public',
      vapidPrivateKey: 'private',
      ttlSeconds: 86400,
      urgency: 'normal',
    },
    email: {
      enabled: false,
      eventClasses: ['agent.question'],
      maxPerUserPerDay: 10,
      userDefaultEnabled: false,
    },
    ...overrides,
  };
}

function makeNotifier(options: {
  config?: Partial<AppConfig['messaging']['notifications']>;
  subscriptions?: ReturnType<typeof makeSubscription>[];
  notify?: ReturnType<typeof vi.fn>;
} = {}) {
  const notify = options.notify ?? vi.fn().mockResolvedValue({ ok: true, data: { subscriptionId: 'x' } });
  const listActiveForUser = vi.fn().mockResolvedValue(options.subscriptions ?? [makeSubscription('sub-1')]);
  const dispatcher = new NotificationDispatcher({
    config: makeNotificationsConfig(options.config),
    webPush: { channel: { notify }, subscriptions: { listActiveForUser } },
    deliveries: {
      recordIfAbsent: vi.fn(async () => 'row-1'),
      countEmailSince: vi.fn(async () => 0),
      updateStatus: vi.fn(async () => undefined),
    },
    preferences: { getUserNotificationPreferences: vi.fn(async () => null) },
  });
  return { dispatcher, notify, listActiveForUser };
}

function makeSendBroker(options: { chatOk: boolean; chatErrorCode?: string; notifications?: AgentMessageNotifier; mirror?: { mirror: ReturnType<typeof vi.fn> } }) {
  const agentRepo = makeAgentRepo({
    getAgent: vi.fn().mockResolvedValue(SENDING_AGENT),
    getActiveSession: vi.fn().mockResolvedValue({ id: 'session-1', status: 'running' }),
    insertOutboundMessage: vi.fn(async () => 'out-1'),
    markOutboundMessageSent: vi.fn(async () => undefined),
    markOutboundMessageFailed: vi.fn(async () => undefined),
  });
  const delivery = new ChatDelivery(
    { getEffectiveChatAddress: vi.fn(), isChatAddressSuppressed: vi.fn() },
    { get: () => undefined },
    { set: vi.fn() },
  );
  const chatResult = options.chatOk
    ? { ok: true, data: { providerMessageId: 'tg-1', address: { provider: 'telegram', address: '123' } } }
    : { ok: false, error: { code: options.chatErrorCode ?? 'chat.no_address', message: 'no_chat_address' } };
  const chatSend = vi.spyOn(delivery, 'send').mockImplementation(vi.fn().mockResolvedValue(chatResult));
  const broker = new AgentMessageBroker(
    makeRedis(),
    agentRepo,
    makeDecisionHandler(),
    makeSessionManager(),
    makeEventPublisher(),
    delivery,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    options.notifications,
    options.mirror as never,
  );
  return { broker, agentRepo, chatSend };
}

describe('AgentMessageBroker — send_message push notifications', () => {
  it('sends one push per active subscription and keeps the Telegram send unchanged', async () => {
    const { dispatcher, notify, listActiveForUser } = makeNotifier({
      subscriptions: [makeSubscription('sub-1'), makeSubscription('sub-2')],
    });
    const { broker, agentRepo, chatSend } = makeSendBroker({ chatOk: true, notifications: dispatcher });

    const result = await broker.processInbound(makeSendMessageEnvelope());

    expect(result.accepted).toBe(true);
    expect(chatSend).toHaveBeenCalledWith('agent-1', expect.objectContaining({ replyRequested: true }));
    expect(agentRepo.markOutboundMessageSent).toHaveBeenCalledWith('out-1', 'tg-1', '123');
    expect(listActiveForUser).toHaveBeenCalledWith('user-1');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(
      1,
      { userId: 'user-1', subscriptionId: 'sub-1', endpoint: 'https://push.example.test/send/sub-1', p256dh: 'p256dh-sub-1', auth: 'auth-sub-1' },
      expect.objectContaining({ agentId: 'agent-1', agentName: 'Research Bot', eventClass: 'agent.question', body: 'You have a new message' }),
    );
  });

  it('keys each notification event by the agent and the outbound message', async () => {
    const { dispatcher } = makeNotifier();
    const dispatch = vi.spyOn(dispatcher, 'dispatch');
    const { broker } = makeSendBroker({ chatOk: true, notifications: dispatcher });

    await broker.processInbound(makeSendMessageEnvelope());

    expect(dispatch).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'agent-1',
      agentName: 'Research Bot',
      eventKey: 'agent-1:out-1',
      eventClass: 'agent.question',
    });
  });

  it('sends no push when the feature is off', async () => {
    const { dispatcher, notify, listActiveForUser } = makeNotifier({ config: { enabled: false } });
    const { broker, agentRepo } = makeSendBroker({ chatOk: true, notifications: dispatcher });

    await broker.processInbound(makeSendMessageEnvelope());

    expect(agentRepo.markOutboundMessageSent).toHaveBeenCalled();
    expect(listActiveForUser).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('sends no push when agent.question is not an enabled event class', async () => {
    const { dispatcher, notify } = makeNotifier({ config: { eventClasses: ['task.completed'] } });
    const { broker, agentRepo } = makeSendBroker({ chatOk: true, notifications: dispatcher });

    await broker.processInbound(makeSendMessageEnvelope());

    expect(agentRepo.markOutboundMessageSent).toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps the chat result when the push channel throws', async () => {
    const { dispatcher } = makeNotifier({
      notify: vi.fn().mockRejectedValue(new Error('push service unreachable')),
    });
    const { broker, agentRepo } = makeSendBroker({ chatOk: true, notifications: dispatcher });

    const result = await broker.processInbound(makeSendMessageEnvelope());

    expect(result.accepted).toBe(true);
    expect(agentRepo.markOutboundMessageSent).toHaveBeenCalledWith('out-1', 'tg-1', '123');
    expect(agentRepo.markOutboundMessageFailed).not.toHaveBeenCalled();
  });

  it('still pushes the second subscription when the first throws', async () => {
    const notify = vi.fn()
      .mockRejectedValueOnce(new Error('push service unreachable'))
      .mockResolvedValueOnce({ ok: true, data: { subscriptionId: 'sub-2' } });
    const { dispatcher } = makeNotifier({
      notify,
      subscriptions: [makeSubscription('sub-1'), makeSubscription('sub-2')],
    });
    const { broker } = makeSendBroker({ chatOk: true, notifications: dispatcher });

    const result = await broker.processInbound(makeSendMessageEnvelope());

    expect(result.accepted).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(
      2,
      { userId: 'user-1', subscriptionId: 'sub-2', endpoint: 'https://push.example.test/send/sub-2', p256dh: 'p256dh-sub-2', auth: 'auth-sub-2' },
      expect.anything(),
    );
  });

  it('keeps the chat result when a push returns a failure result', async () => {
    const { dispatcher } = makeNotifier({
      notify: vi.fn().mockResolvedValue({ ok: false, error: { code: 'notification.provider_failed', message: 'provider_failed' } }),
    });
    const { broker, agentRepo } = makeSendBroker({ chatOk: true, notifications: dispatcher });

    const result = await broker.processInbound(makeSendMessageEnvelope());

    expect(result.accepted).toBe(true);
    expect(agentRepo.markOutboundMessageSent).toHaveBeenCalledWith('out-1', 'tg-1', '123');
  });

  it('still pushes when the Telegram send fails, because push is an independent channel', async () => {
    const { dispatcher, notify } = makeNotifier();
    const { broker, agentRepo } = makeSendBroker({ chatOk: false, notifications: dispatcher });

    await broker.processInbound(makeSendMessageEnvelope());

    expect(agentRepo.markOutboundMessageFailed).toHaveBeenCalledWith('out-1', 'no_chat_address');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('keeps the chat result when the notifier throws', async () => {
    const notifier: AgentMessageNotifier = { dispatch: vi.fn().mockRejectedValue(new Error('dispatcher unavailable')) };
    const { broker, agentRepo } = makeSendBroker({ chatOk: true, notifications: notifier });

    const result = await broker.processInbound(makeSendMessageEnvelope());

    expect(result.accepted).toBe(true);
    expect(agentRepo.markOutboundMessageSent).toHaveBeenCalledWith('out-1', 'tg-1', '123');
  });

  it('leaves send_message unchanged when no notifications are wired', async () => {
    const { broker, agentRepo } = makeSendBroker({ chatOk: true });

    const result = await broker.processInbound(makeSendMessageEnvelope());

    expect(result.accepted).toBe(true);
    expect(agentRepo.markOutboundMessageSent).toHaveBeenCalledWith('out-1', 'tg-1', '123');
  });

  it('mirrors the stored message into the conversation once its delivery outcome is recorded', async () => {
    const order: string[] = [];
    const mirror = { mirror: vi.fn(async () => { order.push('mirror'); }) };
    const { broker, agentRepo } = makeSendBroker({ chatOk: true, mirror });
    agentRepo.markOutboundMessageSent.mockImplementation(async () => { order.push('marked'); });

    const result = await broker.processInbound(makeSendMessageEnvelope());

    expect(result.accepted).toBe(true);
    expect(mirror.mirror).toHaveBeenCalledWith('out-1', undefined);
    expect(order).toEqual(['marked', 'mirror']);
  });

  it('mirrors a message with no chat address as not applicable, not failed', async () => {
    const mirror = { mirror: vi.fn(async () => undefined) };
    const { broker } = makeSendBroker({ chatOk: false, chatErrorCode: 'chat.no_address', mirror });

    await broker.processInbound(makeSendMessageEnvelope());

    expect(mirror.mirror).toHaveBeenCalledWith('out-1', 'not_applicable');
  });

  it('mirrors a message with chat not configured as not applicable', async () => {
    const mirror = { mirror: vi.fn(async () => undefined) };
    const { broker } = makeSendBroker({ chatOk: false, chatErrorCode: 'chat.not_configured', mirror });

    await broker.processInbound(makeSendMessageEnvelope());

    expect(mirror.mirror).toHaveBeenCalledWith('out-1', 'not_applicable');
  });

  it('mirrors a real delivery failure without the not-applicable outcome', async () => {
    const mirror = { mirror: vi.fn(async () => undefined) };
    const { broker } = makeSendBroker({ chatOk: false, chatErrorCode: 'chat.send_failed', mirror });

    await broker.processInbound(makeSendMessageEnvelope());

    expect(mirror.mirror).toHaveBeenCalledWith('out-1', undefined);
  });

  it('does not mirror when the chat address lookup fails, so the redelivery can record the real outcome', async () => {
    const mirror = { mirror: vi.fn(async () => undefined) };
    const { broker } = makeSendBroker({ chatOk: false, chatErrorCode: 'chat.address_lookup_failed', mirror });

    await broker.processInbound(makeSendMessageEnvelope());

    expect(mirror.mirror).not.toHaveBeenCalled();
  });
});
