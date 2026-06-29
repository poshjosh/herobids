/** Maps provider IDs to their venue type for the technical scanner. */
export const VENUE_TYPE_MAP: Record<string, '' | 'orderbook' | 'swap'> = {
  hyperliquid: 'orderbook',
  jupiter: 'swap',
  bybit: 'orderbook',
  '1inch': 'swap',
};
