import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { AgentRepository } from '@herobids/db';
import { err, ok, PEER_ERROR_CODES, type PeerMessagingService } from '@herobids/domain';
import type { AgentDecisionHandler } from './agent-decision-handler.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import { AgentMessageBroker } from './agent-message-broker.js';

function makeAgentRepo(): AgentRepository {
  return {
    getAgent: vi.fn(async () => ({ id: 'agent-1', toolPolicy: null })),
    isMessageDuplicate: vi.fn(async () => false),
    isActiveSession: vi.fn(async () => true),
    getActiveSession: vi.fn(async () => ({ id: 'session-1' })),
    insertMessage: vi.fn(async () => undefined),
    markMessageProcessed: vi.fn(async () => undefined),
  } as unknown as AgentRepository;
}

function peerEnvelope(payload: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'v1',
    messageId: 'env-peer-1',
    correlationId: 'session-1',
    initiatorType: 'agent',
    initiatorId: 'agent-1',
    agentId: 'agent-1',
    type: 'agent.peer.send',
    createdAt: new Date().toISOString(),
    payload: { agent: 'Kofi', message: 'hello', requestMessageId: 'req-peer-1', ...payload },
    ...overrides,
  };
}

function makeBroker(peerMessaging: (Pick<PeerMessagingService, 'send'> & Partial<Pick<PeerMessagingService, 'recordDropped'>>) | undefined) {
  const publishPeerSendReply = vi.fn(async () => undefined);
  const agentRepo = makeAgentRepo();
  const broker = new AgentMessageBroker(
    {} as Redis,
    agentRepo,
    {} as AgentDecisionHandler,
    {} as AgentSessionManager,
    { publishPeerSendReply } as unknown as InstanceEventPublisher,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    peerMessaging && { recordDropped: async () => false, ...peerMessaging },
  );
  return { broker, publishPeerSendReply, agentRepo };
}

describe('AgentMessageBroker — agent.peer.send', () => {
  it('sends as the envelope agent, under the envelope id, and replies ok', async () => {
    const send = vi.fn(async () => ok({ messageId: 'env-peer-1', recipientAgentId: 'agent-2', recipientName: 'Kofi', deliveryStatus: 'sent' as const }));
    const { broker, publishPeerSendReply } = makeBroker({ send });

    const result = await broker.processInbound(peerEnvelope());

    expect(result).toEqual({ accepted: true });
    expect(send).toHaveBeenCalledWith({ fromAgentId: 'agent-1', recipient: 'Kofi', body: 'hello', messageId: 'env-peer-1' });
    expect(publishPeerSendReply).toHaveBeenCalledWith('req-peer-1', { status: 'ok', messageId: 'env-peer-1', recipientAgentId: 'agent-2', recipientName: 'Kofi', deliveryStatus: 'sent' });
  });

  it('replies that a repeated id still being delivered is queued, not delivered', async () => {
    const send = vi.fn(async () => ok({ messageId: 'env-peer-1', recipientAgentId: 'agent-2', recipientName: 'Kofi', deliveryStatus: 'queued' as const }));
    const { broker, publishPeerSendReply } = makeBroker({ send });

    await broker.processInbound(peerEnvelope());

    expect(publishPeerSendReply).toHaveBeenCalledWith('req-peer-1', expect.objectContaining({ status: 'ok', deliveryStatus: 'queued' }));
  });

  it('cannot send as another agent: the sender is the envelope agent, whatever the payload says', async () => {
    const send = vi.fn(async () => ok({ messageId: 'env-peer-1', recipientAgentId: 'agent-2', recipientName: 'Kofi', deliveryStatus: 'sent' as const }));
    const { broker } = makeBroker({ send });

    await broker.processInbound(peerEnvelope({ fromAgentId: 'agent-9', from: 'agent-9' }));

    expect(send.mock.calls[0]?.[0].fromAgentId).toBe('agent-1');
  });

  it('replies with the refusal code, message and the sender\'s other agents', async () => {
    const peers = [{ id: 'agent-2', name: 'Kofi', status: 'active' }];
    const send = vi.fn(async () => err({ code: PEER_ERROR_CODES.notAllowed, message: 'The recipient is not one of your agents.', context: { peers } }));
    const { broker, publishPeerSendReply } = makeBroker({ send });

    const result = await broker.processInbound(peerEnvelope());

    expect(result.accepted).toBe(true);
    expect(publishPeerSendReply).toHaveBeenCalledWith('req-peer-1', {
      status: 'error',
      error: 'The recipient is not one of your agents.',
      errorCode: 'peer.not_allowed',
      peers,
    });
  });

  it('replies peer.unavailable when the service throws, so the tool does not wait for its timeout', async () => {
    const send = vi.fn(async () => { throw new Error('boom'); });
    const { broker, publishPeerSendReply } = makeBroker({ send });

    await broker.processInbound(peerEnvelope());

    expect(publishPeerSendReply).toHaveBeenCalledWith('req-peer-1', expect.objectContaining({ status: 'error', errorCode: 'peer.unavailable' }));
  });

  it('refuses (fail closed) when peer messaging is not configured', async () => {
    const { broker, publishPeerSendReply } = makeBroker(undefined);

    await broker.processInbound(peerEnvelope());

    expect(publishPeerSendReply).toHaveBeenCalledWith('req-peer-1', expect.objectContaining({ status: 'error', errorCode: 'peer.unavailable' }));
  });

  it('rejects a message from a stale session before any send', async () => {
    const send = vi.fn();
    const { broker, agentRepo } = makeBroker({ send });
    vi.mocked(agentRepo.isActiveSession).mockResolvedValue(false);

    const result = await broker.processInbound(peerEnvelope());

    expect(result).toEqual({ accepted: false, error: 'stale_session' });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a payload without a recipient or message', async () => {
    const send = vi.fn();
    const { broker } = makeBroker({ send });

    expect(await broker.processInbound(peerEnvelope({ agent: '' }))).toEqual({ accepted: false, error: 'invalid_payload' });
    expect(await broker.processInbound(peerEnvelope({ message: '' }))).toEqual({ accepted: false, error: 'invalid_payload' });
    expect(send).not.toHaveBeenCalled();
  });

  it('pushes a denial reply to agent:peer-send:reply when the capability is disabled', async () => {
    const lpush = vi.fn(async () => 1);
    const expire = vi.fn(async () => 1);
    const send = vi.fn();
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.getAgent).mockResolvedValue({
      id: 'agent-1',
      toolPolicy: { message_peer_agent: { capability: 'message_peer_agent', tier: 'brokered', enabled: false } },
    } as never);
    const broker = new AgentMessageBroker(
      { lpush, expire } as unknown as Redis,
      agentRepo,
      {} as AgentDecisionHandler,
      {} as AgentSessionManager,
      {} as InstanceEventPublisher,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      { send },
    );

    const result = await broker.processInbound(peerEnvelope());

    expect(result.accepted).toBe(false);
    expect(lpush).toHaveBeenCalledWith('agent:peer-send:reply:req-peer-1', expect.stringContaining('capability_disabled'));
    expect(send).not.toHaveBeenCalled();
  });
});

describe('AgentMessageBroker — agent.peer.drop (DEC-57 c)', () => {
  const dropEnvelope = (payload: Record<string, unknown> = {}) => ({
    ...peerEnvelope({}, { messageId: 'env-drop-1', type: 'agent.peer.drop' }),
    payload: { messageId: 'env-sent-1', fromAgentId: 'agent-2', reason: 'paused', ...payload },
  });

  it('records the drop for the envelope agent as the recipient, without replying', async () => {
    const recordDropped = vi.fn(async () => true);
    const { broker, publishPeerSendReply, agentRepo } = makeBroker({ send: vi.fn(), recordDropped });

    const result = await broker.processInbound(dropEnvelope());

    expect(result).toEqual({ accepted: true });
    expect(recordDropped).toHaveBeenCalledWith({ recipientAgentId: 'agent-1', fromAgentId: 'agent-2', messageId: 'env-sent-1', reason: 'paused' });
    expect(publishPeerSendReply).not.toHaveBeenCalled();
    expect(agentRepo.markMessageProcessed).toHaveBeenCalledWith('env-drop-1', 'processed');
  });

  it('cannot report as another recipient: the recipient is the envelope agent, whatever the payload says', async () => {
    const recordDropped = vi.fn(async () => true);
    const { broker } = makeBroker({ send: vi.fn(), recordDropped });

    await broker.processInbound(dropEnvelope({ recipientAgentId: 'agent-9', toAgentId: 'agent-9' }));

    expect(recordDropped.mock.calls[0]?.[0].recipientAgentId).toBe('agent-1');
  });

  it('carries paused_check_failed through', async () => {
    const recordDropped = vi.fn(async () => true);
    const { broker } = makeBroker({ send: vi.fn(), recordDropped });

    await broker.processInbound(dropEnvelope({ reason: 'paused_check_failed' }));

    expect(recordDropped).toHaveBeenCalledWith(expect.objectContaining({ reason: 'paused_check_failed' }));
  });

  it('rejects a payload with another reason or no message id, recording nothing', async () => {
    const recordDropped = vi.fn(async () => true);
    const { broker } = makeBroker({ send: vi.fn(), recordDropped });

    const badReason = await broker.processInbound(dropEnvelope({ reason: 'peer.rate_limited' }));
    const noId = await broker.processInbound(dropEnvelope({ messageId: '' }));

    expect(badReason.accepted).toBe(false);
    expect(noId.accepted).toBe(false);
    expect(recordDropped).not.toHaveBeenCalled();
  });

  it('is accepted and does nothing when peer messaging is not configured', async () => {
    const { broker } = makeBroker(undefined);

    expect(await broker.processInbound(dropEnvelope())).toEqual({ accepted: true });
  });

  it('rejects a drop report from a stale session', async () => {
    const recordDropped = vi.fn(async () => true);
    const { broker, agentRepo } = makeBroker({ send: vi.fn(), recordDropped });
    vi.mocked(agentRepo.isActiveSession).mockResolvedValue(false);

    const result = await broker.processInbound(dropEnvelope());

    expect(result.accepted).toBe(false);
    expect(recordDropped).not.toHaveBeenCalled();
  });
});
