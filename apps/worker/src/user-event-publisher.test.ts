import { describe, it, expect, vi } from 'vitest';
import { UserEventPublisher } from './user-event-publisher.js';

function makeRedisMock() {
  return { publish: vi.fn().mockResolvedValue(1) } as never;
}

describe('UserEventPublisher — strict vs lenient (E3-H)', () => {
  it('strict publish rejects when the pub/sub publish fails', async () => {
    const redis = makeRedisMock();
    (redis as { publish: ReturnType<typeof vi.fn> }).publish.mockRejectedValueOnce(new Error('redis down'));
    const publisher = new UserEventPublisher(redis);

    await expect(publisher.publishBotStatusStrict('user-1', 'bot-1', 'stopped')).rejects.toThrow('redis down');
  });

  it('lenient publish still only logs when the pub/sub publish fails', async () => {
    const redis = makeRedisMock();
    (redis as { publish: ReturnType<typeof vi.fn> }).publish.mockRejectedValueOnce(new Error('redis down'));
    const publisher = new UserEventPublisher(redis);

    await expect(publisher.publishBotStatus('user-1', 'bot-1', 'stopped')).resolves.toBeUndefined();
  });

  it('strict publish emits a bot.status event on the user channel', async () => {
    const redis = makeRedisMock();
    const publisher = new UserEventPublisher(redis);

    await publisher.publishBotStatusStrict('user-7', 'bot-9', 'crashed');

    const [channel, raw] = (redis as { publish: ReturnType<typeof vi.fn> }).publish.mock.calls[0] as [string, string];
    expect(channel).toBe('events:user-7');
    const envelope = JSON.parse(raw);
    expect(envelope.eventType).toBe('bot.status');
    expect(envelope.payload).toMatchObject({ botId: 'bot-9', status: 'crashed' });
  });
});
