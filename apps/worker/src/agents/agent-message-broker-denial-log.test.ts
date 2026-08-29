import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { AgentRepository } from '@herobids/db';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';

// ── Logger mock ─────────────────────────────────────────────────────────────
const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  }),
}));

import { AgentMessageBroker } from './agent-message-broker.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRedis(): Redis {
  return {
    lpush: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
  } as unknown as Redis;
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

describe('AgentMessageBroker — capability denial log structured fields', () => {
  let agentRepo: AgentRepository;
  let broker: AgentMessageBroker;

  beforeEach(() => {
    mockLoggerWarn.mockClear();
    agentRepo = makeAgentRepo();
    broker = new AgentMessageBroker(
      makeRedis(),
      agentRepo,
      makeDecisionHandler(),
      makeSessionManager(),
      makeEventPublisher(),
    );
  });

  it('logs structured fields with limit, used, retryAfterMs for rate_limit_exceeded denial', async () => {
    // Set up a rate-limited policy — maxPerMinute: 1
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

    // First call: passes gate, increments rate counter.
    await broker.processInbound(makeSendMessageEnvelope({ messageId: 'msg-first' }));
    mockLoggerWarn.mockClear();

    // Second call: hits rate limit.
    await broker.processInbound(makeSendMessageEnvelope({ messageId: 'msg-second' }));

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();

    const fields = denialCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      agentId: 'agent-1',
      capability: 'send_message',
      reason: 'rate_limit_exceeded',
    });
    expect(fields.limit).toEqual(expect.any(Number));
    expect(fields.used).toEqual(expect.any(Number));
    expect(fields.retryAfterMs).toEqual(expect.any(Number));
  });

  it('logs structured fields with undefined limit/used/retryAfterMs for permanent denial (disabled)', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        send_message: { capability: 'send_message', tier: 'brokered', enabled: false },
      },
    } as never);

    await broker.processInbound(makeSendMessageEnvelope());

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();

    const fields = denialCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      agentId: 'agent-1',
      capability: 'send_message',
      reason: 'capability_disabled',
    });
    // Permanent denials: these fields are undefined (pino omits them).
    expect(fields.limit).toBeUndefined();
    expect(fields.used).toBeUndefined();
    expect(fields.retryAfterMs).toBeUndefined();
  });

  it('uses standardized message "Capability policy denied"', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        send_message: { capability: 'send_message', tier: 'brokered', enabled: false },
      },
    } as never);

    await broker.processInbound(makeSendMessageEnvelope());

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();
    expect(denialCall![1]).toBe('Capability policy denied');
  });

  it('logs capability field matching the brokered tool name', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        submit_decision: { capability: 'submit_decision', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeEnvelope('agent.decision.submit', {
      decisionId: 'dec-log',
      instrumentId: 'BTC',
      intent: 'go_long',
      targetSize: '1.0',
      rationaleSummary: 'test trade',
    });
    await broker.processInbound(envelope);

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();

    const fields = denialCall![0] as Record<string, unknown>;
    expect(fields.capability).toBe('submit_decision');
  });

  it('does not emit denial log when capability check passes', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        send_message: { capability: 'send_message', tier: 'brokered', enabled: true },
      },
    } as never);

    await broker.processInbound(makeSendMessageEnvelope());

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeUndefined();
  });

  it('logs denial with correct capability field for manage_bot', async () => {
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: {
        manage_bot: { capability: 'manage_bot', tier: 'brokered', enabled: false },
      },
    } as never);

    const envelope = makeEnvelope('agent.manage_bot', { action: 'create_and_start' });
    await broker.processInbound(envelope);

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();

    const fields = denialCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      agentId: 'agent-1',
      capability: 'manage_bot',
      reason: 'capability_disabled',
    });
  });
});
