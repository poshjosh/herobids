export type OrderSide = 'buy' | 'sell';

export type OrderType = 'market' | 'limit' | 'stop_market' | 'stop_limit';

export type OrderStatus =
  | 'pending'      // submitted, not yet acknowledged by venue
  | 'open'         // acknowledged, resting on book
  | 'partial'      // partially filled
  | 'filled'       // fully filled
  | 'cancelled'    // cancelled by user or system
  | 'rejected';    // rejected by venue or risk gate

export type ExecutionMode = 'paper' | 'shadow' | 'live';

export type VenueType = 'orderbook' | 'swap';

export type DecisionIntent =
  | 'go_long'
  | 'go_short'
  | 'go_flat'
  | 'increase'
  | 'decrease';
