import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OUTBOUND_READ_BLOCK_MS, readOutboundMessages } from './outbound-message-reader.js';

describe('readOutboundMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses a finite block timeout and acknowledges parsed messages', async () => {
    const xgroup = vi.fn().mockResolvedValue(undefined);
    const xreadgroup = vi.fn().mockResolvedValue([
      ['agent:outbound:agent-1', [
        ['msg-1', ['envelope', JSON.stringify({ messageId: 'm-1', type: 'instance.status' })]],
      ]],
    ]);
    const xack = vi.fn().mockResolvedValue(1);
    const redis = { xgroup, xreadgroup, xack } as any;

    const messages = await readOutboundMessages(redis, {
      outboundStream: 'agent:outbound:agent-1',
      consumerGroup: 'agent-runtime',
      consumerName: 'agent-1-123',
      blockMs: OUTBOUND_READ_BLOCK_MS,
      count: 10,
    });

    expect(xreadgroup).toHaveBeenCalledWith(
      'GROUP', 'agent-runtime', 'agent-1-123',
      'COUNT', 10,
      'BLOCK', OUTBOUND_READ_BLOCK_MS,
      'STREAMS', 'agent:outbound:agent-1', '>',
    );
    expect(xack).toHaveBeenCalledWith('agent:outbound:agent-1', 'agent-runtime', 'msg-1');
    expect(messages).toEqual([{ messageId: 'm-1', type: 'instance.status' }]);
  });

  it('returns an empty list when Redis yields no entries', async () => {
    const redis = {
      xgroup: vi.fn().mockResolvedValue(undefined),
      xreadgroup: vi.fn().mockResolvedValue(null),
      xack: vi.fn().mockResolvedValue(1),
    } as any;

    await expect(readOutboundMessages(redis, {
      outboundStream: 'agent:outbound:agent-1',
      consumerGroup: 'agent-runtime',
      consumerName: 'agent-1-123',
      blockMs: OUTBOUND_READ_BLOCK_MS,
      count: 10,
    })).resolves.toEqual([]);
  });
});