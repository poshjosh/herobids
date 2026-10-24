import crypto from 'node:crypto';
import type postgres from 'postgres';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PushSubscriptionRepository } from './push-subscription-repository.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';
import { users } from './schema/index.js';

const SKIP = !process.env['DATABASE_URL'];

describe.skipIf(SKIP)('PushSubscriptionRepository (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: PushSubscriptionRepository;

  const userId = `user_${crypto.randomUUID().slice(0, 8)}`;
  const endpoint = `https://push.example.test/send/${crypto.randomUUID()}`;

  beforeAll(async () => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    repo = new PushSubscriptionRepository(db);

    await truncate(client, 'push_subscriptions', 'users');
    await db.insert(users).values({
      id: userId,
      displayName: 'Push User',
      username: `push_${userId}`,
      email: `${userId}@example.com`,
      planId: 'free',
    });
  });

  afterAll(async () => {
    await truncate(client, 'push_subscriptions', 'users');
    await client.end();
  });

  it('upserts one row per endpoint and refreshes the keys on re-subscribe', async () => {
    const first = await repo.upsertForUser({ userId, endpoint, p256dh: 'key-1', auth: 'auth-1', userAgent: 'UA-1' });
    const second = await repo.upsertForUser({ userId, endpoint, p256dh: 'key-2', auth: 'auth-2', userAgent: 'UA-2' });

    expect(second.id).toBe(first.id);
    expect(second.p256dh).toBe('key-2');
    expect(second.auth).toBe('auth-2');

    const active = await repo.listActiveForUser(userId);
    expect(active.filter((row) => row.endpoint === endpoint)).toHaveLength(1);
  });

  it('records success and failure without revoking', async () => {
    const row = (await repo.listActiveForUser(userId)).find((r) => r.endpoint === endpoint);
    expect(row).toBeDefined();
    if (!row) return;

    await repo.markSucceeded(row.id, new Date('2026-10-24T10:00:00.000Z'));
    await repo.markFailed(row.id, 'notification.provider_failed', new Date('2026-10-24T10:05:00.000Z'));

    const after = (await repo.listActiveForUser(userId)).find((r) => r.id === row.id);
    expect(after?.lastSuccessAt?.toISOString()).toBe('2026-10-24T10:00:00.000Z');
    expect(after?.lastFailureAt?.toISOString()).toBe('2026-10-24T10:05:00.000Z');
    expect(after?.lastFailureCode).toBe('notification.provider_failed');
    expect(after?.revokedAt).toBeNull();
  });

  it('excludes a revoked row from the active list and keeps the first revocation time', async () => {
    const row = (await repo.listActiveForUser(userId)).find((r) => r.endpoint === endpoint);
    expect(row).toBeDefined();
    if (!row) return;

    await repo.revoke(row.id, new Date('2026-10-24T11:00:00.000Z'));
    await repo.revoke(row.id, new Date('2026-10-24T12:00:00.000Z'));

    const active = await repo.listActiveForUser(userId);
    expect(active.find((r) => r.id === row.id)).toBeUndefined();
  });

  it('reactivates a revoked endpoint when the browser subscribes again', async () => {
    const resubscribed = await repo.upsertForUser({ userId, endpoint, p256dh: 'key-3', auth: 'auth-3', userAgent: 'UA-3' });

    expect(resubscribed.revokedAt).toBeNull();
    expect(resubscribed.lastFailureCode).toBeNull();
    const active = await repo.listActiveForUser(userId);
    expect(active.some((r) => r.id === resubscribed.id)).toBe(true);
  });
});
