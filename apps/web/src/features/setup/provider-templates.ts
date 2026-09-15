/**
 * @deprecated Use provider catalog API (GET /providers/catalog → credentials.fields) instead.
 * Kept for backward compatibility with tests and quick field-key lookups.
 */
export const PROVIDER_TEMPLATES: Record<string, string[]> = {
  hyperliquid: ['apiKey', 'secret', 'walletAddress'],
  jupiter: ['privateKey'],
  bybit: ['apiKey', 'apiSecret'],
  '1inch': ['privateKey'],
};
