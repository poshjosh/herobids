export type OrderSide = 'buy' | 'sell';

export type OrderType = 'market' | 'limit' | 'stop_market' | 'stop_limit' | 'swap';

export type OrderStatus =
  | 'pending'      // submitted, not yet acknowledged by venue
  | 'open'         // acknowledged, resting on book
  | 'partial'      // partially filled
  | 'filled'       // fully filled
  | 'cancelled'    // cancelled by user or system
  | 'expired'      // timed out or venue-expired
  | 'replaced'     // replaced by a newer order (cancel-and-replace or amend)
  | 'rejected';    // rejected by venue or risk gate

export type ExecutionMode = 'paper' | 'shadow' | 'live';

export type { PermissionLevel } from './config/schema.js';

export const DEFAULT_PERMISSION_LEVEL = 'standard' as const;

export type VenueType = 'orderbook' | 'swap';

export type DecisionIntent =
  | 'go_long'
  | 'go_short'
  | 'go_flat'
  | 'increase'
  | 'decrease';
