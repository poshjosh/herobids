export type AgentExecutionMode = 'paper' | 'shadow' | 'live';
export type AgentVenueType = 'orderbook' | 'swap';

export interface AgentGrantFallbackState {
  sessionId: string;
  allowed: boolean;
}

/**
 * Grant-based intake fallback is only safe for paper orderbook agents.
 * Shadow/live agents depend on the long-lived execution actor for venue wiring,
 * private-stream state, and execution safety, so missing actors must fail closed.
 * Swap agents also require authoritative asset metadata that the fallback resolver
 * does not provide, so they must fail closed even in paper mode.
 */
export function shouldUseAgentGrantFallback(
  executionMode: AgentExecutionMode | undefined,
  venueType: AgentVenueType | undefined,
): boolean {
  return executionMode === 'paper' && venueType === 'orderbook';
}

export function startAgentGrantFallbackSession(sessionId: string): AgentGrantFallbackState {
  return { sessionId, allowed: false };
}

export function isCurrentAgentGrantFallbackSession(
  state: AgentGrantFallbackState | undefined,
  sessionId: string,
): boolean {
  return state?.sessionId === sessionId;
}

export function setAgentGrantFallbackAllowed(sessionId: string, allowed: boolean): AgentGrantFallbackState {
  return { sessionId, allowed };
}

export function canUseAgentGrantFallback(state: AgentGrantFallbackState | undefined): boolean {
  return state?.allowed === true;
}