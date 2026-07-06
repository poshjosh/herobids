import type { Logger } from 'pino';
import crypto from 'node:crypto';
import type { InstrumentRepository, UpsertInstrumentRow } from '@herobids/db';
import type { MarketMetadata } from '@herobids/domain';

/**
 * Populate the instruments table from venue market data via venue adapters.
 *
 * Each adapter provides fetchMarketMetadata() which uses its own ccxt
 * exchange instance. Skipping Jupiter — its token list API does not
 * provide instrument metadata (base, quote, type, sizes).
 *
 * NON-BLOCKING: failures are logged but do not crash the worker.
 * Symbol validation continues via the in-memory VenueInstrumentCache.
 */
export async function populateInstrumentsFromVenues(
  instrumentRepo: InstrumentRepository,
  logger: Logger,
  adapters: Array<{
    venue: string;
    fetchMarketMetadata: () => Promise<{ ok: boolean; data?: MarketMetadata[]; error?: { message: string } }>;
  }>,
): Promise<void> {
  for (const adapter of adapters) {
    try {
      const result = await adapter.fetchMarketMetadata();
      if (!result.ok || !result.data) {
        logger.warn({ venue: adapter.venue, error: result.error }, 'instrument-population: Failed to fetch market metadata');
        continue;
      }

      const rows: UpsertInstrumentRow[] = result.data.map((m) => ({
        id: crypto.randomUUID(),
        symbol: m.symbol,
        venue: adapter.venue,
        type: m.type === 'swap' ? 'perp' : m.type,
        base: m.base,
        quote: m.quote,
        tickSize: m.tickSize,
        lotSize: m.lotSize,
      }));

      await instrumentRepo.upsertInstruments(rows);
      logger.info({ count: rows.length }, `instrument-population: ${adapter.venue} — ${rows.length} instruments upserted`);
    } catch (err) {
      logger.warn({ venue: adapter.venue, err }, 'instrument-population: Failed to populate instruments');
    }
  }
}
