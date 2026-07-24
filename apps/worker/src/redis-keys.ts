/**
 * Shared Redis key patterns for the worker process.
 *
 * Centralised here so the read side (monitor) and write side (agent) stay in
 * sync — a key format drift would silently disable scanner_gated gating.
 */

/** Key pattern: agent:scanner_gated:{agentId} — value '1' when the agent is in scanner_gated mode. */
export const SCANNER_GATED_KEY = 'agent:scanner_gated' as const;

export function scannerGatedKey(agentId: string): string {
  return `${SCANNER_GATED_KEY}:${agentId}`;
}

/** Key pattern: agent:scanner:fingerprint:{agentId} — last signal fingerprint for dedup. */
export const SCANNER_SIGNAL_FINGERPRINT_KEY = 'agent:scanner:fingerprint' as const;

export function scannerSignalFingerprintKey(agentId: string): string {
  return `${SCANNER_SIGNAL_FINGERPRINT_KEY}:${agentId}`;
}

/** Key pattern: scanner:candle-breaker:{agentId}:{providerSymbol} — cross-scan circuit breaker state. */
export const CANDLE_BREAKER_KEY = 'scanner:candle-breaker' as const;

export function candleBreakerKey(agentId: string, providerSymbol: string): string {
  return `${CANDLE_BREAKER_KEY}:${agentId}:${providerSymbol}`;
}
