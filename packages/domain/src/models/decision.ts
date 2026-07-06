import type { BotId, DecisionId, InstrumentId, VenueAccountId } from '../values/ids.js';
import type { Quantity, Price } from '../values/money.js';
import type { DecisionIntent } from '../enums.js';

/** Valid actor types for decision attribution (ADR 001). */
export type ActorType = 'agent' | 'bot' | 'user' | 'system';

/**
 * A Decision is the output of a Strategy.
 * It represents a desired target exposure — not a specific order.
 * The Plan/Routing layer translates this into execution commands.
 */
export interface Decision {
  id: DecisionId;
  /** Venue account the decision targets (execution context) */
  venueAccountId: VenueAccountId;
  instrumentId: InstrumentId;
  intent: DecisionIntent;
  /** Target size (absolute). For go_flat, this is 0. */
  targetSize: Quantity;
  /** Optional limit price hint (strategy's desired entry). */
  limitPrice?: Price;
  /** Optional stop-loss price level for this trade. */
  stopLoss?: Price;
  /** Optional take-profit price level for this trade. */
  takeProfit?: Price;
  /** ISO 8601 timestamp (UTC) */
  timestamp: string;
  /** Optional context hash for audit replay */
  contextHash?: string;
  /** Freeform metadata the strategy wants to record */
  metadata?: Record<string, unknown>;
  /** Actor type that produced this decision */
  actorType: ActorType;
  /** Stable identifier of the actor that produced this decision */
  actorId: string;
  /** Bot that executed this decision (if produced via a bot) */
  botId?: BotId;
}
