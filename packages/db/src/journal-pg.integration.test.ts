import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import { PgJournal } from './journal-pg.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

describe.skipIf(SKIP)('PgJournal.scanAfter (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let journal: PgJournal;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    // TestDb and Database are structurally identical (same drizzle(client, {schema}) call);
    // the cast is safe — only needed because they originate from different call sites.
    journal = new PgJournal(db as unknown as Database);
  }, 30_000);

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncate(client, 'journal_events');
  });

  it('append then scanAfter without cursor returns the event', async () => {
    await journal.append({ type: 'test.event', payload: { n: 1 } });

    const rows = await journal.scanAfter({ limit: 10 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('test.event');
    expect(rows[0]!.payload).toEqual({ n: 1 });
  });

  it('appendBatch then scanAfter returns all events in the batch', async () => {
    await journal.appendBatch([
      { type: 'test.a', payload: {} },
      { type: 'test.b', payload: {} },
      { type: 'test.c', payload: {} },
    ]);

    const rows = await journal.scanAfter({ limit: 10 });

    expect(rows).toHaveLength(3);
    const types = rows.map((r) => r.type).sort();
    expect(types).toEqual(['test.a', 'test.b', 'test.c']);
  });

  it('cursor advancement does not re-return seen events and picks up new ones', async () => {
    await journal.appendBatch([
      { type: 'batch-a.1', payload: {} },
      { type: 'batch-a.2', payload: {} },
      { type: 'batch-a.3', payload: {} },
    ]);

    const first = await journal.scanAfter({ limit: 10 });
    expect(first).toHaveLength(3);

    const last = first[first.length - 1]!;
    const lastTs = last.createdAt.getTime();
    const seenIds = first.filter((e) => e.createdAt.getTime() === lastTs).map((e) => e.id);
    const cursor = { createdAt: last.createdAt, seenIds };

    // No new events yet — second scan returns nothing
    const empty = await journal.scanAfter({ cursor, limit: 10 });
    expect(empty).toHaveLength(0);

    // New batch arrives
    await journal.appendBatch([
      { type: 'batch-b.1', payload: {} },
      { type: 'batch-b.2', payload: {} },
    ]);

    const second = await journal.scanAfter({ cursor, limit: 10 });
    expect(second).toHaveLength(2);
    const types = second.map((r) => r.type).sort();
    expect(types).toEqual(['batch-b.1', 'batch-b.2']);
  });

  it('seenIds cursor does not lose events when a batch shares a timestamp (regression)', async () => {
    // All 5 events get the same created_at — single appendBatch = one DB transaction.
    // With the old (createdAt, id) cursor, any event whose UUID sorts below the saved
    // cursor id would be permanently skipped on the next scan.
    await journal.appendBatch([
      { type: 'stamp.1', payload: {} },
      { type: 'stamp.2', payload: {} },
      { type: 'stamp.3', payload: {} },
      { type: 'stamp.4', payload: {} },
      { type: 'stamp.5', payload: {} },
    ]);

    // First page returns 3 events (ordered asc by id)
    const page1 = await journal.scanAfter({ limit: 3 });
    expect(page1).toHaveLength(3);

    const last1 = page1[page1.length - 1]!;
    const lastTs1 = last1.createdAt.getTime();
    const seenIds1 = page1.filter((e) => e.createdAt.getTime() === lastTs1).map((e) => e.id);
    const cursor1 = { createdAt: last1.createdAt, seenIds: seenIds1 };

    // Second page must return the remaining 2, regardless of their UUID sort order.
    // The new NOT IN filter guarantees this; the old id > cursor.id filter would fail
    // for events whose UUIDs sort before any of seenIds1.
    const page2 = await journal.scanAfter({ cursor: cursor1, limit: 10 });
    expect(page2).toHaveLength(2);

    // All 5 IDs must be covered without overlap
    const allIds = new Set([...page1.map((e) => e.id), ...page2.map((e) => e.id)]);
    expect(allIds.size).toBe(5);
  });

  it('limit is respected and full cursor pagination covers all events', async () => {
    // Use individual appends so each event gets a distinct created_at.
    // appendBatch gives all events the same timestamp, which requires cumulative
    // seenIds tracking across pages — not the production use-case for this cursor.
    for (const n of [1, 2, 3, 4, 5]) {
      await journal.append({ type: `page.${n}`, payload: {} });
    }

    const buildCursor = (rows: Awaited<ReturnType<typeof journal.scanAfter>>) => {
      const last = rows[rows.length - 1]!;
      const lastTs = last.createdAt.getTime();
      return {
        createdAt: last.createdAt,
        seenIds: rows.filter((e) => e.createdAt.getTime() === lastTs).map((e) => e.id),
      };
    };

    const page1 = await journal.scanAfter({ limit: 2 });
    expect(page1).toHaveLength(2);

    const page2 = await journal.scanAfter({ cursor: buildCursor(page1), limit: 2 });
    expect(page2).toHaveLength(2);

    const page3 = await journal.scanAfter({ cursor: buildCursor(page2), limit: 2 });
    expect(page3).toHaveLength(1);

    const allIds = new Set([...page1, ...page2, ...page3].map((e) => e.id));
    expect(allIds.size).toBe(5);
  });
});
