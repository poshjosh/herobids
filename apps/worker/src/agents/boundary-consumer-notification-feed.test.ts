import { describe, it, expect, vi } from 'vitest';
import type { ExternalBackendReadResult } from '@herobids/domain';
import type { ExternalBackendReadBoundary } from '../external-backend/read-adapter.js';
import { createBoundaryConsumerNotificationFeed, RELAY_NOTIFICATION_TYPES } from './boundary-consumer-notification-feed.js';

function makeBoundary(result: ExternalBackendReadResult) {
  const invoke = vi.fn(async () => result);
  return { boundary: { invoke } as unknown as ExternalBackendReadBoundary, invoke };
}

describe('createBoundaryConsumerNotificationFeed', () => {
  it('sends the cursor as an ISO string with the relay types', async () => {
    const { boundary, invoke } = makeBoundary({ kind: 'success', data: { ok: true, notifications: [] } });
    const feed = createBoundaryConsumerNotificationFeed(boundary);

    const cursor = { createdAt: new Date('2026-06-11T00:00:00.000Z'), seenIds: ['a', 'b'] };
    await feed.scan({ cursor, limit: 50 });

    expect(invoke).toHaveBeenCalledWith({
      toolName: 'scan_consumer_notifications',
      payload: {
        cursor: { createdAt: '2026-06-11T00:00:00.000Z', seenIds: ['a', 'b'] },
        types: [...RELAY_NOTIFICATION_TYPES],
        limit: 50,
      },
    });
  });

  it('rehydrates createdAt into a Date and preserves routing columns', async () => {
    const { boundary } = makeBoundary({
      kind: 'success',
      data: {
        ok: true,
        notifications: [
          { id: 'n1', type: 'agent_wake', ownerId: 'o1', agentId: 'a1', botId: null, payload: { wake: {} }, createdAt: '2026-06-11T00:00:00.000Z' },
        ],
      },
    });
    const feed = createBoundaryConsumerNotificationFeed(boundary);

    const rows = await feed.scan({ limit: 10 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
    expect(rows[0]!.id).toBe('n1');
    expect(rows[0]!.agentId).toBe('a1');
    expect(rows[0]!.botId).toBeNull();
  });

  it('throws on a non-success result', async () => {
    const { boundary } = makeBoundary({ kind: 'transport_error', message: 'boundary down', retryable: true });
    const feed = createBoundaryConsumerNotificationFeed(boundary);

    await expect(feed.scan({ limit: 10 })).rejects.toThrow(/transport error/);
  });
});
