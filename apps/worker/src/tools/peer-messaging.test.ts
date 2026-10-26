import { describe, it, expect, vi } from 'vitest';
import { PEER_MESSAGE_SAFETY_MAX_CHARS, type ToolContext } from '@herobids/domain';
import { messagePeerAgentTool } from './peer-messaging.js';

function makeCtx(blpopReply: [string, string] | null) {
  const publishToInbound = vi.fn(async () => undefined);
  const blpop = vi.fn(async () => blpopReply);
  const ctx = {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'judge',
    executionMode: 'paper',
    redis: { blpop } as unknown as ToolContext['redis'],
    publishToInbound,
  } as unknown as ToolContext;
  return { ctx, publishToInbound, blpop };
}

const reply = (value: unknown): [string, string] => ['key', JSON.stringify(value)];

describe('message_peer_agent tool', () => {
  it('sends agent.peer.send with the recipient and text, then waits on the matching reply key', async () => {
    const { ctx, publishToInbound, blpop } = makeCtx(reply({ status: 'ok', messageId: 'm1', recipientAgentId: 'agent-2', recipientName: 'Kofi' }));

    const result = await messagePeerAgentTool.execute({ agent: 'Kofi', message: 'hello' }, ctx);

    expect(publishToInbound).toHaveBeenCalledWith('agent.peer.send', expect.objectContaining({ agent: 'Kofi', message: 'hello', requestMessageId: expect.any(String) }));
    const requestMessageId = (publishToInbound.mock.calls[0] as unknown as [string, { requestMessageId: string }])[1].requestMessageId;
    expect(blpop).toHaveBeenCalledWith(`agent:peer-send:reply:${requestMessageId}`, expect.any(Number));
    expect(result).toMatchObject({ success: true, data: { ok: true, agentId: 'agent-2', agentName: 'Kofi' } });
  });

  it.each([
    ['an empty message', { agent: 'Kofi', message: '' }],
    ['no recipient', { agent: '  ', message: 'hello' }],
    ['a sender named in the input', { agent: 'Kofi', message: 'hello', fromAgentId: 'agent-9' }],
    ['a creator named in the input', { agent: 'Kofi', message: 'hello', userId: 'u2' }],
  ])('rejects %s without contacting the broker', async (_label, params) => {
    const { ctx, publishToInbound } = makeCtx(null);

    const result = await messagePeerAgentTool.execute(params, ctx);

    expect(result).toMatchObject({ success: false, errorCode: 'validation.invalid_payload' });
    expect(publishToInbound).not.toHaveBeenCalled();
  });

  it('accepts a message at the safety cap and rejects one above it, without contacting the broker', async () => {
    const ok = makeCtx(reply({ status: 'ok', messageId: 'm1', recipientAgentId: 'agent-2', recipientName: 'Kofi' }));
    const tooLong = makeCtx(null);

    const accepted = await messagePeerAgentTool.execute({ agent: 'Kofi', message: 'x'.repeat(PEER_MESSAGE_SAFETY_MAX_CHARS) }, ok.ctx);
    const rejected = await messagePeerAgentTool.execute({ agent: 'Kofi', message: 'x'.repeat(PEER_MESSAGE_SAFETY_MAX_CHARS + 1) }, tooLong.ctx);

    expect(accepted).toMatchObject({ success: true });
    expect(rejected).toMatchObject({ success: false, errorCode: 'validation.invalid_payload' });
    expect(tooLong.publishToInbound).not.toHaveBeenCalled();
  });

  it('tells the agent not to resend a message that is still being delivered', async () => {
    const { ctx } = makeCtx(reply({ status: 'ok', messageId: 'm1', recipientAgentId: 'agent-2', recipientName: 'Kofi', deliveryStatus: 'queued' }));

    const result = await messagePeerAgentTool.execute({ agent: 'Kofi', message: 'hello' }, ctx);

    expect(result).toMatchObject({ success: true, data: { note: expect.stringContaining('still being delivered') } });
  });

  it('tells the agent not to reply to acknowledgements or pure notifications', () => {
    expect(messagePeerAgentTool.promptGuidance).toContain('Do not reply to acknowledgements or pure notifications');
  });

  it('returns a refusal with its code and lists the other agents', async () => {
    const peers = [{ id: 'agent-2', name: 'Kofi', status: 'active' }];
    const { ctx } = makeCtx(reply({ status: 'error', error: 'The recipient is not one of your agents.', errorCode: 'peer.not_allowed', peers }));

    const result = await messagePeerAgentTool.execute({ agent: 'nobody', message: 'hello' }, ctx);

    expect(result).toEqual({
      success: false,
      error: 'The recipient is not one of your agents.',
      errorCode: 'peer.not_allowed',
      retryable: false,
      fault: false,
      data: { peers },
    });
  });

  it.each([
    ['peer.rate_limited', false],
    ['peer.delivery_failed', true],
    ['peer.unavailable', true],
    ['peer.paused', false],
    ['peer.recipient_not_running', false],
  ])('marks %s as retryable=%s', async (errorCode, retryable) => {
    const { ctx } = makeCtx(reply({ status: 'error', error: 'refused', errorCode }));

    const result = await messagePeerAgentTool.execute({ agent: 'Kofi', message: 'hello' }, ctx);

    expect(result).toMatchObject({ success: false, errorCode, retryable });
  });

  it('reports a broker timeout as retryable', async () => {
    const { ctx } = makeCtx(null);

    const result = await messagePeerAgentTool.execute({ agent: 'Kofi', message: 'hello' }, ctx);

    expect(result).toMatchObject({ success: false, errorCode: 'broker.timeout', retryable: true });
  });

  it('passes a capability denial through', async () => {
    const { ctx } = makeCtx(reply({ status: 'rejected', code: 'capability_denied:capability_disabled', message: 'disabled' }));

    const result = await messagePeerAgentTool.execute({ agent: 'Kofi', message: 'hello' }, ctx);

    expect(result).toMatchObject({ success: false, errorCode: 'capability_denied:capability_disabled' });
  });

  it('treats a malformed reply as a failure', async () => {
    const { ctx } = makeCtx(['key', 'not json']);
    const { ctx: ctx2 } = makeCtx(reply({ status: 'weird' }));

    expect(await messagePeerAgentTool.execute({ agent: 'Kofi', message: 'hello' }, ctx)).toMatchObject({ success: false, errorCode: 'broker.malformed_reply' });
    expect(await messagePeerAgentTool.execute({ agent: 'Kofi', message: 'hello' }, ctx2)).toMatchObject({ success: false, errorCode: 'broker.malformed_reply' });
  });

  it('is a write-messaging tool', () => {
    expect(messagePeerAgentTool.name).toBe('message_peer_agent');
    expect(messagePeerAgentTool.category).toBe('write-messaging');
  });
});
