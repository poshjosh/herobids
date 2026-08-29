import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { AgentRepository } from '@herobids/db';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import { AgentMessageBroker } from './agent-message-broker.js';

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

  it('returns agent:preset:reply:{requestMessageId} for TOOL_ASSESS_STRATEGY_PRESET', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        assess_strategy_preset: { capability: 'assess_strategy_preset', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeEnvelope('agent.tool.assess_strategy_preset.request', {
      requestMessageId: 'req-456',
      symbols: ['BTC'],
      venueFamily: 'hyperliquid',
      agentId: 'agent-1',
      sessionId: 'session-1',
    });
    await broker.processInbound(envelope);

    expect(redis.lpush).toHaveBeenCalledWith(
      'agent:preset:reply:req-456',
      expect.any(String),
    );
  });

  it('returns agent:preset:reply:{requestMessageId} for TOOL_CHANGE_STRATEGY_PRESET', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        change_strategy_preset: { capability: 'change_strategy_preset', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeEnvelope('agent.tool.change_strategy_preset.request', {
      requestMessageId: 'req-789',
      assessmentArtifactId: 'art-1',
      targetPreset: 'momentum',
      mode: 'entries_only',
      agentId: 'agent-1',
      sessionId: 'session-1',
    });
    await broker.processInbound(envelope);

    expect(redis.lpush).toHaveBeenCalledWith(
      'agent:preset:reply:req-789',
      expect.any(String),
    );
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
