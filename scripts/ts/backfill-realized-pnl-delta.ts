/**
 * backfill-realized-pnl-delta.ts
 *
 * Backfills the `realized_pnl_delta` column on the fills table.
 * Replays ALL fills per (actor_id, symbol) in chronological order,
 * computes realized P&L delta using the same applyFill logic as the engine,
 * and writes back only the rows that still have a NULL value.
 *
 * Safe to re-run: replays the full history (so position state is accurate)
 * but only UPDATEs rows where realized_pnl_delta IS NULL.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx ts/backfill-realized-pnl-delta.ts
 */

import { createDatabase, closeDatabase, fills } from '@herobids/db';
import { eq, isNull, asc, sql } from 'drizzle-orm';
import { Decimal } from '@herobids/domain';
import { flatPosition, applyFill } from '@herobids/engine';
import type { PositionState } from '@herobids/engine';

const BATCH_SIZE = 500;

async function main() {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('[backfill] DATABASE_URL is required.');
    process.exit(1);
  }

  const db = createDatabase(databaseUrl);

  // 1. Check if there are any NULL rows to backfill
  const nullCount = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(fills)
    .where(isNull(fills.realizedPnlDelta));
  const pendingCount = Number(nullCount[0]?.count ?? 0);
  console.log(`[backfill] ${pendingCount} fills have null realized_pnl_delta.`);
  if (pendingCount === 0) {
    await closeDatabase(db);
    return;
  }

  // 2. Fetch ALL fills ordered for replay — we need full history to compute correct deltas
  console.log('[backfill] Fetching all fills for replay...');
  const allFills = await db
    .select()
    .from(fills)
    .orderBy(asc(fills.filledAt));

  console.log(`[backfill] Total fills: ${allFills.length}. Replaying to compute deltas...`);

  // 3. Group by (actorType, actorId, venueAccountId, symbol) for position tracking
  const groups = new Map<string, typeof allFills>();
  for (const fill of allFills) {
    const key = `${fill.actorType}:${fill.actorId ?? '__none__'}:${fill.venueAccountId}:${fill.symbol}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(fill);
  }

  console.log(`[backfill] Processing ${groups.size} (actor, venueAccount, symbol) groups...`);

  // 4. Replay each group and collect updates for NULL-only rows
  const updates: { id: string; delta: string }[] = [];

  for (const [key, groupFills] of groups) {
    const parts = key.split(':');
    const symbol = parts[3]!;
    let position: PositionState = flatPosition('backfill', symbol);

    for (const fill of groupFills) {
      const prevRealizedPnl = position.realizedPnl;
      position = applyFill(position, {
        fillId: fill.id as any,
        orderId: fill.orderId as any,
        side: fill.side as 'buy' | 'sell',
        quantity: new Decimal(fill.quantity),
        price: new Decimal(fill.price),
        timestamp: fill.filledAt.toISOString(),
        fee: fill.fee ? new Decimal(fill.fee) : undefined,
      });

      // Only queue an update for fills that still have a NULL delta
      if (fill.realizedPnlDelta == null) {
        const positionPnlDelta = position.realizedPnl.minus(prevRealizedPnl);
        const feeCost = fill.fee ? new Decimal(fill.fee) : new Decimal(0);
        const economicDelta = positionPnlDelta.minus(feeCost);
        updates.push({ id: fill.id, delta: economicDelta.toString() });
      }
    }
  }

  // 5. Write back in batches
  console.log(`[backfill] Writing ${updates.length} updates in batches of ${BATCH_SIZE}...`);
  let written = 0;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(({ id, delta }) =>
        db.update(fills).set({ realizedPnlDelta: delta }).where(eq(fills.id, id)),
      ),
    );
    written += batch.length;
    if (written % 5000 === 0 || written === updates.length) {
      console.log(`[backfill] Progress: ${written}/${updates.length}`);
    }
  }

  console.log('[backfill] Done.');
  await closeDatabase(db);
}

main().catch((err) => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});
