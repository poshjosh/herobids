import { describe, expect, it, vi } from 'vitest';
import { AGENT_STREAM_MAXLEN, PeerMessagePayloadSchema } from '@herobids/domain';
import { extractPeerOrigin, isEarlyTickTriggerType } from '../tick-gate-state.js';
import { RedisPeerWakePublisher } from './peer-wake-publisher.js';

describe('RedisPeerWakePublisher', () => {
  const wake = { messageId: 'msg-1', fromAgentId: 'agent-1', fromAgentName: 'Momo', toAgentId: 'agent-2', body: 'ping' };

  async function published() {
    const xadd = vi.fn(async () => '1-0');
    await new RedisPeerWakePublisher({ xadd } as never).publish(wake);
    const [stream, maxlen, approx, length, id, field, json] = xadd.mock.calls[0] as unknown as [string, string, string, number, string, string, string];
    return { stream, maxlen, approx, length, id, field, envelope: JSON.parse(json) as Record<string, unknown> };
  }

  it('publishes to the recipient\'s outbound stream, bounded like every other outbound publish', async () => {
    const out = await published();

    expect(out).toMatchObject({ stream: 'agent:outbound:agent-2', maxlen: 'MAXLEN', approx: '~', length: AGENT_STREAM_MAXLEN, id: '*', field: 'envelope' });
  });

  it('publishes an agent.user.message from the sending agent under the thread row id', async () => {
    const { envelope } = await published();

    expect(envelope).toMatchObject({
      schemaVersion: 'v1',
      messageId: 'msg-1',
      initiatorType: 'agent',
      initiatorId: 'agent-1',
      agentId: 'agent-2',
      type: 'agent.user.message',
    });
    expect(PeerMessagePayloadSchema.parse(envelope['payload'])).toEqual({ message: 'ping', peer: { fromAgentId: 'agent-1', fromAgentName: 'Momo' } });
  });

  it('is read by the receiving runtime as an early wake tagged as peer-originated', async () => {
    const { envelope } = await published();

    expect(isEarlyTickTriggerType(envelope['type'])).toBe(true);
    expect(extractPeerOrigin(envelope)).toEqual({ agentId: 'agent-1', agentName: 'Momo' });
  });

  it('lets a failed publish reach the caller so the send is marked failed', async () => {
    const xadd = vi.fn(async () => { throw new Error('redis down'); });

    await expect(new RedisPeerWakePublisher({ xadd } as never).publish(wake)).rejects.toThrow('redis down');
  });
});
