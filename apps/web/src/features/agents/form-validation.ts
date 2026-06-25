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
  executionMode: string;
  requiresTradingSetup: boolean;
}

export function validateCreateAgentForm(
  intent: CreateAgentFormIntent,
  constraints: ValidationConstraints,
): ValidationResult {
  const errors: Record<string, string> = {};
  const showIntelligence = intent.capabilityMode === 'intelligence' || intent.capabilityMode === 'both';
  const showTechnical = intent.capabilityMode === 'technical' || intent.capabilityMode === 'both';

  // name: required
  if (!intent.name.trim()) {
    errors.name = 'Name is required.';
  }

  // goal: required if intelligence mode
  if (showIntelligence && !intent.goal.trim()) {
    errors.goal = 'Goal is required.';
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

  // tickIntervalMins: if provided, ≥ 1 minute, whole number
  if (intent.tickIntervalMins.trim()) {
    const tickNum = Number(intent.tickIntervalMins);
    if (!Number.isFinite(tickNum) || tickNum < 1 || !Number.isInteger(tickNum)) {
      errors.tickIntervalMins = 'Tick interval must be at least 1 minute.';
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

  // venue: required only for live/shadow execution modes (not paper)
  const isLiveOrShadow = intent.executionMode === 'live' || intent.executionMode === 'shadow';
  if (isLiveOrShadow && !intent.venue.trim()) {
    errors.venue = 'Venue is required for live or shadow trading.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
