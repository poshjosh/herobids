import type { Price, Quantity } from './money.js';
import type { InstrumentId } from './ids.js';

/** A tradable instrument on a specific venue. */
export interface Instrument {
  id: InstrumentId;
  /** Canonical symbol, e.g. "BTC/USD:USD" */
  symbol: string;
  /** Venue this instrument lives on */
  venue: string;
  /** Instrument type */
  type: 'perp' | 'spot' | 'future';
  /** Base asset, e.g. "BTC" */
  base: string;
  /** Quote asset, e.g. "USD" */
  quote: string;
  /** Minimum price increment */
  tickSize: Price;
  /** Minimum quantity increment */
  lotSize: Quantity;
}
