import { AGENT_STYLE_RUNTIME_DEFAULTS, RUNTIME_POLICY_CEILINGS, type AgentStyleValue } from './schema.js';

const MS_PER_MINUTE = 60_000;

/** Trading tick interval for a style, from the style defaults. */
export function resolveStyleTradingTickIntervalMs(style: AgentStyleValue): number {
  return Number(AGENT_STYLE_RUNTIME_DEFAULTS[style].tickIntervalMins) * MS_PER_MINUTE;
}

/** Max hold keeps the style's ratio to its tick interval (for example balanced: 3 × tick). */
export function deriveStyleMaxHoldDurationMs(style: AgentStyleValue, tickIntervalMs: number): number {
  const styleMaxHoldMs = AGENT_STYLE_RUNTIME_DEFAULTS[style].maxHoldDurationMs;
  if (styleMaxHoldMs === undefined) {
    throw new Error(`No max hold default for agent style "${style}"`);
  }
  const multiplier = styleMaxHoldMs / resolveStyleTradingTickIntervalMs(style);
  return Math.min(Math.round(tickIntervalMs * multiplier), RUNTIME_POLICY_CEILINGS.maxHoldDurationMs);
}

/**
 * Tick to use once a trading skill is added. Only a stored tick that is still the
 * non-trading default (or missing) is replaced; any other stored tick is kept.
 */
export function resolveTradingTickIntervalMs(input: {
  style: AgentStyleValue;
  currentTickIntervalMs: number | null;
  nonTradingDefaultTickIntervalMs: number;
}): number {
  if (input.currentTickIntervalMs === null || input.currentTickIntervalMs === input.nonTradingDefaultTickIntervalMs) {
    return resolveStyleTradingTickIntervalMs(input.style);
  }
  return input.currentTickIntervalMs;
}
