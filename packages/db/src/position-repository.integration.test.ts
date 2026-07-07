import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import { PositionRepository } from './repositories.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

const BASE_POS = {
  venueAccountId: 'va-test-1',
  actorType: 'agent',
  actorId: 'agent-test-1',
  venue: 'hyperliquid',
  symbol: 'BTC/USD:USD',
  side: 'long' as const,
  size: '1',
  entryPrice: '90000',
  realizedPnl: '0',
};

describe.skipIf(SKIP)('PositionRepository (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: PositionRepository;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    repo = new PositionRepository(db as unknown as Database);
  }, 30_000);

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncate(client, 'positions');
  });

  describe('same-side UPDATE — undefined-guard for stopLoss/takeProfit', () => {
    it('preserves existing stop_loss when upsert omits stopLoss (undefined)', async () => {
      // Insert initial position with a stop-loss level
      await repo.upsert({ ...BASE_POS, stopLoss: '85000' });

      // Second upsert with same side but no stopLoss field (undefined = not provided)
      await repo.upsert({ ...BASE_POS, size: '1.5' });

      const rows = await repo.getOpenByActorAndVenueAccount(
        BASE_POS.actorType,
        BASE_POS.actorId,
        BASE_POS.venueAccountId,
      );
      expect(rows).toHaveLength(1);
      // The DB value must still be '85000' — undefined must not overwrite
      expect(rows[0]!.stopLoss).toBe('85000');
    });

    it('updates stop_loss when upsert provides an explicit new value', async () => {
      // Insert initial position with a stop-loss level
      await repo.upsert({ ...BASE_POS, stopLoss: '85000' });

      // Second upsert with same side and a new stop-loss
      await repo.upsert({ ...BASE_POS, stopLoss: '90000' });

      const rows = await repo.getOpenByActorAndVenueAccount(
        BASE_POS.actorType,
        BASE_POS.actorId,
        BASE_POS.venueAccountId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.stopLoss).toBe('90000');
    });

    it('clears stop_loss when upsert explicitly passes stopLoss: null', async () => {
      // Insert initial position with a stop-loss level
      await repo.upsert({ ...BASE_POS, stopLoss: '85000' });

      // Explicit null must wipe the column
      await repo.upsert({ ...BASE_POS, stopLoss: null });

      const rows = await repo.getOpenByActorAndVenueAccount(
        BASE_POS.actorType,
        BASE_POS.actorId,
        BASE_POS.venueAccountId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.stopLoss).toBeNull();
    });
  });

  describe('reversal INSERT — inherits stopLoss/takeProfit on new direction', () => {
    it('new short row carries stopLoss from reversal decision; old long row is closed', async () => {
      // Insert a long position with no exit levels
      await repo.upsert({ ...BASE_POS });

      // Reversal: flip to short with a stop-loss
      await repo.upsert({
        ...BASE_POS,
        side: 'short',
        size: '2',
        entryPrice: '88000',
        stopLoss: '3200',
      });

      // The new short row must be open and carry stopLoss
      const openRows = await repo.getOpenByActorAndVenueAccount(
        BASE_POS.actorType,
        BASE_POS.actorId,
        BASE_POS.venueAccountId,
      );
      expect(openRows).toHaveLength(1);
      expect(openRows[0]!.side).toBe('short');
      expect(openRows[0]!.stopLoss).toBe('3200');

      // All positions for this actor must include the now-closed long row
      const allRows = await repo.getAllByActor(BASE_POS.actorType, BASE_POS.actorId);
      expect(allRows).toHaveLength(2);
      const longRow = allRows.find((r) => r.side === 'flat' || r.closedAt !== null);
      expect(longRow).toBeDefined();
      expect(longRow!.closedAt).not.toBeNull();
    });
  });
});
