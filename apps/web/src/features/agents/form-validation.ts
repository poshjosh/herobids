import type { CapabilityMode } from './CapabilitySelector.js';

export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

export interface ValidationConstraints {
  maxOpenPositions: number;
  maxPositionSizePct: number;
  stopLossMaxUnrealizedLossPct: number;
}

export interface CreateAgentFormIntent {
  name: string;
  goal: string;
  capabilityMode: CapabilityMode;
  capital: string;
  tickIntervalMins: string;
  maxOpenPositions: string;
  maxPositionSizePct: string;
  stopLossPct: string;
  venue: string;
  venueType: string;
  executionMode: string;
  requiresTradingSetup: boolean;
  /** Whether at least one connection is granted for the selected venue. */
  hasConnection?: boolean;
  style?: string;
  runtimePolicyOverrides?: { maxHoldDurationMs?: number | null } | null;
}

export function validateCreateAgentForm(
  intent: CreateAgentFormIntent,
  constraints: ValidationConstraints,
): ValidationResult {
  const errors: Record<string, string> = {};
  const showIntelligence = intent.capabilityMode === 'intelligence' || intent.capabilityMode === 'hybrid';

  // name: required
  if (!intent.name.trim()) {
    errors.name = 'Name is required.';
  }

  // goal: required if intelligence mode
  if (showIntelligence && !intent.goal.trim()) {
    errors.goal = 'Objective / prompt is required.';
  }

  // capital: required if trading, must be positive number
  if (intent.requiresTradingSetup) {
    if (!intent.capital.trim()) {
      errors.capital = 'Capital is required.';
    } else {
      const capitalNum = parseFloat(intent.capital);
      if (isNaN(capitalNum) || capitalNum <= 0) {
        errors.capital = 'Capital must be a positive number.';
      }
    }
  }

  // tickIntervalMins: if provided, ≥ 1 minute, whole number; and maxHoldDurationMs must be ≥ tickIntervalMs
  if (intent.tickIntervalMins.trim()) {
    const tickNum = Number(intent.tickIntervalMins);
    if (!Number.isFinite(tickNum) || tickNum < 1 || !Number.isInteger(tickNum)) {
      errors.tickIntervalMins = 'Tick interval must be at least 1 minute.';
    } else {
      const tickIntervalMs = tickNum * 60_000;
      const maxHoldMs = intent.runtimePolicyOverrides?.maxHoldDurationMs;
      if (maxHoldMs != null && maxHoldMs !== 0 && maxHoldMs < tickIntervalMs) {
        const maxHoldMins = Math.round(maxHoldMs / 60_000);
        errors.tickIntervalMins = `Tick interval (${tickNum} min) exceeds max hold duration (${maxHoldMins} min). Reduce tick interval or increase Max Hold Duration in Advanced Settings.`;
      }
    }
  }

  // maxOpenPositions: if provided, must be a valid positive integer, ≤ constraints.maxOpenPositions
  if (intent.maxOpenPositions.trim()) {
    const maxOpen = Number(intent.maxOpenPositions);
    if (!Number.isFinite(maxOpen) || maxOpen < 1 || !Number.isInteger(maxOpen)) {
      errors.maxOpenPositions = 'Max open positions must be a whole number ≥ 1.';
    } else if (maxOpen > constraints.maxOpenPositions) {
      errors.maxOpenPositions = `Max open positions cannot exceed ${constraints.maxOpenPositions}.`;
    }
  }

  // maxPositionSizePct: if provided, 0-100 AND ≤ constraints.maxPositionSizePct
  if (intent.maxPositionSizePct.trim()) {
    const pct = Number(intent.maxPositionSizePct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      errors.maxPositionSizePct = 'Max position size must be between 0 and 100.';
    } else if (pct > constraints.maxPositionSizePct) {
      errors.maxPositionSizePct = `Max position size cannot exceed ${constraints.maxPositionSizePct}%.`;
    }
  }

  // stopLossPct: if provided, 0-100 AND ≤ constraints.stopLossMaxUnrealizedLossPct
  if (intent.stopLossPct.trim()) {
    const sl = Number(intent.stopLossPct);
    if (!Number.isFinite(sl) || sl < 0 || sl > 100) {
      errors.stopLossPct = 'Stop loss must be between 0 and 100.';
    } else if (sl > constraints.stopLossMaxUnrealizedLossPct) {
      errors.stopLossPct = `Stop loss cannot exceed the platform limit of ${constraints.stopLossMaxUnrealizedLossPct}%.`;
    }
  }

  // venue: required only for live execution mode (test uses simulated execution —
  // the backend resolves it to paper or shadow based on venue/connection presence)
  const requiresVenue = intent.executionMode === 'live';
  if (requiresVenue && !intent.venue.trim()) {
    errors.venue = 'Venue is required for live trading.';
  }

  // A selected venue (live mode, or test mode opted into venue-backed shadow
  // execution) always resolves to live or shadow, both of which require a
  // granted connection so the runtime has an execution context to resolve.
  if (intent.requiresTradingSetup && intent.venue.trim() && !intent.hasConnection) {
    errors.connectionIds = 'Select a connection for the chosen venue.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Check whether an agent edit form can be saved given the connection state.
 * Returns an error string for the `connectionIds` field, or null if OK.
 *
 * Rules:
 * - Live mode always requires ≥1 connection.
 * - Removing the last connection from a live or shadow agent is blocked
 *   unless the user has explicitly touched the execution mode dropdown
 *   (signalling intent to downgrade to pure paper/test).
 */
export function validateEditAgentConnections(params: {
  storedExecutionMode: string | null;
  formExecutionMode: string;
  connectionIds: string[];
  hasExistingActiveConnections: boolean;
  executionModeWasTouched: boolean;
}): string | null {
  // Live without connections is always invalid
  if (params.formExecutionMode === 'live' && params.connectionIds.length === 0) {
    return 'Live trading requires at least one connection. Switch to Test mode or add a connection.';
  }

  const storedModeNeedsConnection =
    params.storedExecutionMode === 'live' || params.storedExecutionMode === 'shadow';

  const isRemovingAllConnections =
    params.hasExistingActiveConnections && params.connectionIds.length === 0;

  // User removed all connections without explicitly touching the mode dropdown —
  // they haven't signalled intent to downgrade.
  if (isRemovingAllConnections && storedModeNeedsConnection && !params.executionModeWasTouched) {
    return 'Removing the final connection requires either selecting another connection or switching execution mode to Test.';
  }

  return null;
}
