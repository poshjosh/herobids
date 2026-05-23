import type { DecisionId, InstrumentId, TradingInstanceId } from '../values/ids.js';
import type { Quantity, Price } from '../values/money.js';
import type { DecisionIntent } from '../enums.js';

/**
 * A Decision is the output of a Strategy.
 * It represents a desired target exposure — not a specific order.
 * The Plan/Routing layer translates this into execution commands.
 */
export interface Decision {
  id: DecisionId;
  tradingInstanceId: TradingInstanceId;
  instrumentId: InstrumentId;
  intent: DecisionIntent;
  /** Target size (absolute). For go_flat, this is 0. */
  targetSize: Quantity;
  /** Optional limit price hint (strategy's desired entry). */
  limitPrice?: Price;
  /** ISO 8601 timestamp (UTC) */
  timestamp: string;
  /** Optional context hash for audit replay */
  contextHash?: string;
  /** Freeform metadata the strategy wants to record */
  metadata?: Record<string, unknown>;
}
