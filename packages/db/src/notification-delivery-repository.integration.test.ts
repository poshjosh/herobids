import crypto from 'node:crypto';
import type postgres from 'postgres';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NotificationDeliveryRepository } from './notification-delivery-repository.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';
import { agents, notificationDeliveries, users } from './schema/index.js';

const SKIP = !process.env['DATABASE_URL'];

describe.skipIf(SKIP)('NotificationDeliveryRepository (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: NotificationDeliveryRepository;

  const userId = `user_${crypto.randomUUID().slice(0, 8)}`;
  const agentId = `agent_${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    repo = new NotificationDeliveryRepository(db);

    await truncate(client, 'notification_deliveries', 'agents', 'users');
    await db.insert(users).values({
      id: userId,
      displayName: 'Ledger User',
      username: `ledger_${userId}`,
      email: `${userId}@example.com`,
      planId: 'free',
    });
    await db.insert(agents).values({
      id: agentId,
      userId,
      name: 'Ledger Agent',
      prompt: 'test',
      status: 'stopped',
    } as typeof agents.$inferInsert);
  });

  afterAll(async () => {
    await truncate(client, 'notification_deliveries', 'agents', 'users');
    await client.end();
  });

  const record = (eventKey: string, channel: 'email' | 'web_push' = 'email') =>
    repo.recordIfAbsent({ userId, agentId, eventKey, channel, reason: 'notification.no_subscription' });

  it('records an event once per channel and returns null for a repeat', async () => {
    const first = await record('agent-1:msg-1');
    const repeat = await record('agent-1:msg-1');

    expect(first).toEqual(expect.any(String));
    expect(repeat).toBeNull();
    const rows = await db.select().from(notificationDeliveries);
    expect(rows.filter((row) => row.eventKey === 'agent-1:msg-1')).toHaveLength(1);
  });

  it('keeps the same event key independent across channels', async () => {
    const email = await record('agent-1:msg-2', 'email');
    const push = await record('agent-1:msg-2', 'web_push');

    expect(email).not.toBeNull();
    expect(push).not.toBeNull();
  });

  it('counts only pending and sent email rows since the window start', async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const pending = await record('agent-1:msg-count-pending');
    const sent = await record('agent-1:msg-count-sent');
    const failed = await record('agent-1:msg-count-failed');
    const push = await record('agent-1:msg-count-push', 'web_push');
    if (sent) await repo.updateStatus(sent, 'sent', 'notification.no_subscription');
    if (failed) await repo.updateStatus(failed, 'failed', 'email.timeout');
    if (push) await repo.updateStatus(push, 'sent', null);
    expect(pending).not.toBeNull();

    const count = await repo.countEmailSince(userId, since);
    const futureCount = await repo.countEmailSince(userId, new Date(Date.now() + 60_000));

    // Email rows: msg-1 (pending), msg-2 (pending), count-pending (pending), count-sent (sent), count-failed (failed).
    // The failed row and the web_push row are excluded.
    expect(count).toBe(4);
    expect(futureCount).toBe(0);
  });

  describe('reserveEmailIfUnderCap', () => {
    const since = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

    async function seedOwner(label: string): Promise<{ userId: string; agentId: string }> {
      const id = `user_${label}_${crypto.randomUUID().slice(0, 8)}`;
      const agent = `agent_${label}_${crypto.randomUUID().slice(0, 8)}`;
      await db.insert(users).values({
        id,
        displayName: 'Reserve User',
        username: `reserve_${id}`,
        email: `${id}@example.com`,
        planId: 'free',
      });
      await db.insert(agents).values({
        id: agent,
        userId: id,
        name: 'Reserve Agent',
        prompt: 'test',
        status: 'stopped',
      } as typeof agents.$inferInsert);
      return { userId: id, agentId: agent };
    }

    const reserve = (
      target: RepoTarget,
      eventKey: string,
      maxPerUserPerDay: number,
    ) => target.repo.reserveEmailIfUnderCap({
      userId: target.owner.userId,
      agentId: target.owner.agentId,
      eventKey,
      channel: 'email',
      reason: 'notification.no_subscription',
      since: since(),
      maxPerUserPerDay,
    });

    it('reserves an event once and reports a repeat as duplicate', async () => {
      const owner = await seedOwner('dup');
      const target = { repo, owner };

      const first = await reserve(target, `${owner.agentId}:msg-1`, 10);
      const repeat = await reserve(target, `${owner.agentId}:msg-1`, 10);

      expect(first).toEqual({ outcome: 'reserved', id: expect.any(String) });
      expect(repeat).toEqual({ outcome: 'duplicate' });
    });

    it('refuses a reservation once the daily cap is reached', async () => {
      const owner = await seedOwner('cap');
      const target = { repo, owner };

      const first = await reserve(target, `${owner.agentId}:cap-1`, 1);
      const second = await reserve(target, `${owner.agentId}:cap-2`, 1);

      expect(first.outcome).toBe('reserved');
      expect(second).toEqual({ outcome: 'rate_limited' });
    });

    it('lets only one of two concurrent reservations take the last slot for each user', async () => {
      // A pool of 5 lets the calls really overlap. The single-connection test client would serialise them.
      const pool = openTestDb({ max: 5 });
      try {
        const concurrentRepo = new NotificationDeliveryRepository(pool.db);
        const owners: Array<{ userId: string; agentId: string }> = [];
        for (let i = 0; i < 5; i++) owners.push(await seedOwner(`race${i}`));

        const attempts = owners.flatMap((owner) => [0, 1].map(async (attempt) => ({
          userId: owner.userId,
          result: await reserve({ repo: concurrentRepo, owner }, `${owner.agentId}:race-${attempt}`, 1),
        })));
        const results = await Promise.all(attempts);

        for (const owner of owners) {
          const outcomes = results
            .filter((entry) => entry.userId === owner.userId)
            .map((entry) => entry.result.outcome)
            .sort();
          expect(outcomes).toEqual(['rate_limited', 'reserved']);
        }
      } finally {
        await pool.client.end();
      }
    });
  });
});

interface RepoTarget {
  repo: NotificationDeliveryRepository;
  owner: { userId: string; agentId: string };
}
