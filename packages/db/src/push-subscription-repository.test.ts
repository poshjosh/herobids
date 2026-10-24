import { describe, expect, it } from 'vitest';
import { toPushSubscriptionRecord } from './push-subscription-repository.js';
import type { pushSubscriptions } from './schema/index.js';

type Row = typeof pushSubscriptions.$inferSelect;

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'ps-1',
    userId: 'user-1',
    endpoint: 'https://push.example.test/send/abc',
    p256dh: 'p256dh-key',
    auth: 'auth-secret',
    userAgent: 'Mozilla/5.0',
    createdAt: new Date('2026-10-24T10:00:00.000Z'),
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('toPushSubscriptionRecord', () => {
  it('maps every stored field to the record shape', () => {
    const record = toPushSubscriptionRecord(makeRow({
      lastSuccessAt: new Date('2026-10-24T11:00:00.000Z'),
      lastFailureAt: new Date('2026-10-24T12:00:00.000Z'),
      lastFailureCode: 'notification.provider_failed',
      revokedAt: new Date('2026-10-24T13:00:00.000Z'),
    }));

    expect(record).toEqual({
      id: 'ps-1',
      userId: 'user-1',
      endpoint: 'https://push.example.test/send/abc',
      p256dh: 'p256dh-key',
      auth: 'auth-secret',
      userAgent: 'Mozilla/5.0',
      createdAt: new Date('2026-10-24T10:00:00.000Z'),
      lastSuccessAt: new Date('2026-10-24T11:00:00.000Z'),
      lastFailureAt: new Date('2026-10-24T12:00:00.000Z'),
      lastFailureCode: 'notification.provider_failed',
      revokedAt: new Date('2026-10-24T13:00:00.000Z'),
    });
  });

  it('keeps nullable columns as null for a fresh, never-used subscription', () => {
    const record = toPushSubscriptionRecord(makeRow({ userAgent: null }));

    expect(record.userAgent).toBeNull();
    expect(record.lastSuccessAt).toBeNull();
    expect(record.lastFailureAt).toBeNull();
    expect(record.lastFailureCode).toBeNull();
    expect(record.revokedAt).toBeNull();
  });
});
