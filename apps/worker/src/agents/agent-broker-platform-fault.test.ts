/**
 * Unit tests for AgentMessageBroker forwarding of platform-owned tool errors
 * (agent.tool.result with errorOwner "platform" → operator notifier).
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentMessageBroker } from './agent-message-broker.js';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import type { OperatorNotifier } from '../alerting/operator-notifier.js';

function makeToolResultEnvelope(payloadOverrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'v1',
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    correlationId: 'corr-001',
    initiatorType: 'agent',
    initiatorId: 'agent-123',
    agentId: 'agent-123',
    type: 'agent.tool.result',
    createdAt: '2026-06-01T00:00:00.000Z',
    payload: {
      tickId: 'tick-001',
      phase: 'judge',
      toolName: 'execute_shell',
      status: 'error',
      correlationId: 'call-001',
      summary: 'Sandbox infrastructure error',
      errorCode: 'execute_shell.sandbox_infrastructure_error',
      errorOwner: 'platform',
      ...payloadOverrides,
    },
  };
}

function makeBroker(notifier: Pick<OperatorNotifier, 'reportPlatformFault'> | undefined) {
  const agentRepo = {
    isMessageDuplicate: vi.fn().mockResolvedValue(false),
    isActiveSession: vi.fn().mockResolvedValue(true),
    insertMessage: vi.fn().mockResolvedValue(undefined),
    markMessageProcessed: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockResolvedValue({ id: 'agent-123', name: 'Test Agent', status: 'active', skillIds: [], toolPolicy: null }),
    getActiveSession: vi.fn().mockResolvedValue({ id: 'sess-001', status: 'running' }),
  };
  const broker = new AgentMessageBroker(
    { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') } as any,
    agentRepo as any,
    { handleDecisionSubmit: vi.fn() } as unknown as AgentDecisionHandler,
    { handleHeartbeat: vi.fn(), handlePauseRequest: vi.fn(), handleStopRequest: vi.fn(), handleRuntimeSessionEnd: vi.fn() } as unknown as AgentSessionManager,
    {} as unknown as InstanceEventPublisher,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    notifier as OperatorNotifier | undefined,
  );
  return broker;
}

describe('AgentMessageBroker platform fault reporting', () => {
  it('reports a platform-owned tool error to the operator with the agent name', async () => {
    const reportPlatformFault = vi.fn().mockResolvedValue(undefined);
    const broker = makeBroker({ reportPlatformFault });

    await broker.processInbound(makeToolResultEnvelope());

    expect(reportPlatformFault).toHaveBeenCalledWith({
      agentId: 'agent-123',
      agentName: 'Test Agent',
      toolName: 'execute_shell',
      errorCode: 'execute_shell.sandbox_infrastructure_error',
      summary: 'Sandbox infrastructure error',
    });
  });

  it.each([
    ['a user-owned error', { errorOwner: 'user' }],
    ['an agent-owned error', { errorOwner: 'agent' }],
    ['an error with no owner', { errorOwner: undefined }],
    ['a successful result', { status: 'ok', errorOwner: undefined }],
  ])('does not report %s', async (_name, overrides) => {
    const reportPlatformFault = vi.fn().mockResolvedValue(undefined);
    const broker = makeBroker({ reportPlatformFault });

    await broker.processInbound(makeToolResultEnvelope(overrides));

    expect(reportPlatformFault).not.toHaveBeenCalled();
  });

  it('keeps processing when the operator notifier throws', async () => {
    const broker = makeBroker({ reportPlatformFault: vi.fn().mockRejectedValue(new Error('telegram down')) });

    await expect(broker.processInbound(makeToolResultEnvelope())).resolves.not.toThrow();
  });

  it('ignores platform faults when no operator notifier is configured', async () => {
    const broker = makeBroker(undefined);

    await expect(broker.processInbound(makeToolResultEnvelope())).resolves.not.toThrow();
  });
});
