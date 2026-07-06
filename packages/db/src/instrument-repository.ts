import { like, or, and, eq } from 'drizzle-orm';
import type { Database } from './index.js';
import { instruments } from './schema/index.js';

export interface UpsertInstrumentRow {
  id: string;
  symbol: string;
  venue: string;
  type: string;
  base: string;
  quote: string;
  tickSize: string;
  lotSize: string;
}

export interface InstrumentSearchParams {
  query: string;
  venue?: string;
  limit?: number;
}

export interface InstrumentRow {
  id: string;
  symbol: string;
  base: string;
  quote: string;
  type: string;
  venue: string;
  tickSize: string;
  lotSize: string;
}

/**
 * Lightweight instrument lookup repository.
 * Used by the find_instrument agent tool.
 *
 * PERFORMANCE NOTE: The LIKE `%term%` pattern cannot use standard B-tree indexes
 * efficiently and may cause full table scans on large instrument tables.
 * If the instruments table grows beyond ~10k rows, add a GIN trigram index
 * (via pg_trgm) on (symbol, base, id) for prefix/substring matching.
 */
export class InstrumentRepository {
  constructor(private db: Database) {}

  /**
   * Insert or silently skip instruments by their venue+symbol unique constraint.
   * Uses PostgreSQL ON CONFLICT DO NOTHING — no error on duplicates.
   */
  async upsertInstruments(rows: UpsertInstrumentRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(instruments).values(rows).onConflictDoNothing();
  }

  async search(params: InstrumentSearchParams): Promise<InstrumentRow[]> {
    const { query, venue, limit = 5 } = params;
    const searchTerm = `%${query}%`;

    const conditions = [
      or(
        like(instruments.symbol, searchTerm),
        like(instruments.base, searchTerm),
        like(instruments.id, searchTerm),
      ),
    ];

    if (venue) {
      conditions.push(eq(instruments.venue, venue));
    }

    // Network filtering is not supported: instruments have no network column. The venue
    // column encodes the network context implicitly (e.g. "jupiter" ≡ Solana). Use the
    // venue filter to constrain results to a specific chain's instruments.

    const rows = await this.db
      .select({
        id: instruments.id,
        symbol: instruments.symbol,
        base: instruments.base,
        quote: instruments.quote,
        type: instruments.type,
        venue: instruments.venue,
        tickSize: instruments.tickSize,
        lotSize: instruments.lotSize,
      })
      .from(instruments)
      .where(and(...conditions))
      .limit(limit);

    return rows.map((r) => ({
      ...r,
      tickSize: r.tickSize.toString(),
      lotSize: r.lotSize.toString(),
    }));
  }
}
