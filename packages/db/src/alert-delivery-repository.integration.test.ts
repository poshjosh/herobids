import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import { AlertDeliveryRepository } from './alert-delivery-repository.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

// Synthetic journal event ID — alert_deliveries has no FK to journal_events,
// so we can use a plain UUID without seeding that table.
const JOURNAL_EVENT_ID = '00000000-0000-0000-0000-000000000001';

describe.skipIf(SKIP)('AlertDeliveryRepository (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: AlertDeliveryRepository;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    repo = new AlertDeliveryRepository(db as unknown as Database);
  }, 30_000);

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncate(client, 'alert_deliveries');
  });

  it('insert returns an ID for a new delivery', async () => {
    const id = await repo.insert({
      journalEventId: JOURNAL_EVENT_ID,
      channel: 'telegram',
      destination: '123',
    });

    expect(id).not.toBeNull();
    expect(typeof id).toBe('string');
  });

  it('insert returns null for a duplicate event+channel+destination (ON CONFLICT DO NOTHING)', async () => {
    const delivery = { journalEventId: JOURNAL_EVENT_ID, channel: 'telegram', destination: '123' };

    const first = await repo.insert(delivery);
    const second = await repo.insert(delivery);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('getPending claims rows and returns them', async () => {
    await repo.insert({ journalEventId: JOURNAL_EVENT_ID, channel: 'telegram', destination: '999' });

    const claimed = await repo.getPending({ maxRetries: 3, limit: 10 });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe('pending');
    // getPending sets claimedAt inside the transaction but returns the pre-update
    // snapshot rows. Verify the claim took effect by checking that an immediate
    // second call returns nothing (the row is within the 60s stale window).
    const second = await repo.getPending({ maxRetries: 3, limit: 10 });
    expect(second).toHaveLength(0);
  });

  it('getPending does not return a freshly-failed row before the 60s stale window (double-burn fix)', async () => {
    // Seed and claim a delivery
    const id = await repo.insert({ journalEventId: JOURNAL_EVENT_ID, channel: 'telegram', destination: '555' });
    expect(id).not.toBeNull();
    await repo.getPending({ maxRetries: 3, limit: 10 }); // claims the row

    // Report a failure — this should set claimedAt=now(), not null
    await repo.markAttemptFailed(id!, 'timeout', 3);

    // Immediately call getPending again — the row's claimedAt is now(), which is
    // within the 60s stale window, so it must NOT be returned.
    // With the old code (claimedAt: null), getPending would return it immediately,
    // consuming two retry attempts in one dispatch tick.
    const requeued = await repo.getPending({ maxRetries: 3, limit: 10 });
    expect(requeued).toHaveLength(0);
  });

  it('markAttemptFailed sets status to failed when maxRetries is reached', async () => {
    const id = await repo.insert({ journalEventId: JOURNAL_EVENT_ID, channel: 'telegram', destination: '777' });
    expect(id).not.toBeNull();
    await repo.getPending({ maxRetries: 1, limit: 10 }); // claim

    // maxRetries = 1 — this attempt exhausts the budget
    await repo.markAttemptFailed(id!, 'fatal error', 1);

    // Status is now 'failed'; getPending should not return it regardless of claimedAt
    const pending = await repo.getPending({ maxRetries: 1, limit: 10 });
    expect(pending).toHaveLength(0);
  });

  it('markDelivered sets status to delivered', async () => {
    const id = await repo.insert({ journalEventId: JOURNAL_EVENT_ID, channel: 'telegram', destination: '111' });
    expect(id).not.toBeNull();
    await repo.getPending({ maxRetries: 3, limit: 10 }); // claim

    await repo.markDelivered(id!);

    const delivered = await repo.wasEventDelivered(JOURNAL_EVENT_ID);
    expect(delivered).toBe(true);
  });

  it('wasEventDelivered returns false for events that have not been delivered', async () => {
    await repo.insert({ journalEventId: JOURNAL_EVENT_ID, channel: 'telegram', destination: '222' });

    const result = await repo.wasEventDelivered(JOURNAL_EVENT_ID);

    expect(result).toBe(false);
  });

  it('getRecentDeliveredAfter filters by deliveredAt cutoff', async () => {
    const id1 = await repo.insert({ journalEventId: '00000000-0000-0000-0000-000000000002', channel: 'telegram', destination: '333' });
    const id2 = await repo.insert({ journalEventId: '00000000-0000-0000-0000-000000000003', channel: 'telegram', destination: '444' });
    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();

    await repo.getPending({ maxRetries: 3, limit: 10 });
    await repo.markDelivered(id1!);

    // Small delay so the two deliveries have distinct timestamps
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = new Date();
    await new Promise((r) => setTimeout(r, 5));
    await repo.markDelivered(id2!);

    const recent = await repo.getRecentDeliveredAfter(cutoff);

    expect(recent).toHaveLength(1);
    expect(recent[0]!.id).toBe(id2);
  });
});
