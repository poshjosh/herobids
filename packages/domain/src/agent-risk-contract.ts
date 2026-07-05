/**
 * Agent Risk Contract — typed model for per-field source, mutability, and ceiling.
 *
 * This model establishes the two-path runtime contract:
 * 1. Creator-configured limits are immutable at runtime.
 * 2. Operator defaults are the initial fallback and ceiling for agent adjustment.
 * 3. Agent runtime overrides persist separately and survive restart.
 */

/** Source of a resolved agent risk field value. */
export type AgentRiskFieldSource = 'user' | 'default' | 'agent_override';

/** A single resolved risk field with provenance and mutability metadata. */
export interface AgentRiskField<T> {
  /** The value currently in effect for enforcement. */
  effectiveValue: T;
  /** Where the effective value came from. */
  source: AgentRiskFieldSource;
  /** Whether the agent may adjust this field at runtime. */
  mutable: boolean;
  /** The operator-defined ceiling — no override may exceed this. */
  operatorCeiling: T;
  /**
   * Whether the engine will actively enforce this limit.
   * False when a precondition for enforcement is missing (e.g. maxPositionSizePct
   * without capital context). The value is still informational.
   * Defaults to true when omitted.
   */
  enforced?: boolean;
  /** The creator-configured value when present (source = 'user'). */
  creatorValue?: T;
  /** The agent's runtime override when present (source = 'agent_override'). */
  overrideValue?: T;
}

/** The set of risk fields subject to the two-path contract. */
export interface ResolvedAgentRiskContract {
  maxOpenPositions: AgentRiskField<number>;
  maxPositionSizePct: AgentRiskField<number>;
  stopLossPct: AgentRiskField<number>;
  stopLossCooldownMs: AgentRiskField<number>;
  maxDrawdownPct: AgentRiskField<number>;
}

/** Persisted runtime overrides — only fields the agent has actively changed. */
export interface AgentRiskOverrides {
  maxOpenPositions?: number;
  maxPositionSizePct?: number;
  stopLossPct?: number;
  stopLossCooldownMs?: number;
  maxDrawdownPct?: number;
}

/** Input shape for resolving the contract (raw creator-configured nullable values). */
export interface AgentRiskCreatorInput {
  maxOpenPositions: number | null;
  maxPositionSizePct: number | null;
  stopLossPct: number | null;
  stopLossCooldownMs: number | null;
  maxDrawdownPct: number | null;
}

/** Operator ceiling values derived from AgentRiskDefaultsConfig. */
export interface AgentRiskCeilings {
  maxOpenPositions: number;
  maxPositionSizePct: number;
  stopLossPct: number;
  stopLossCooldownMs: number;
  maxDrawdownPct: number;
}

/**
 * Resolve a single risk field given creator input, operator ceiling, and optional runtime override.
 *
 * Resolution rules:
 * 1. creator value present → source 'user', mutable false, effective = creator value
 * 2. creator value absent, no override → source 'default', mutable true, effective = ceiling (operator default)
 * 3. creator value absent, override present → source 'agent_override', mutable true, effective = override (capped at ceiling)
 */
export function resolveRiskField<T extends number>(
  creatorValue: T | null,
  operatorCeiling: T,
  overrideValue: T | undefined,
): AgentRiskField<T> {
  // Path 1: creator explicitly set this value — immutable
  if (creatorValue != null) {
    return {
      effectiveValue: creatorValue,
      source: 'user',
      mutable: false,
      operatorCeiling,
      creatorValue,
    };
  }

  // Path 3: agent has an active override (capped at ceiling)
  if (overrideValue != null) {
    const capped = Math.min(overrideValue, operatorCeiling) as T;
    return {
      effectiveValue: capped,
      source: 'agent_override',
      mutable: true,
      operatorCeiling,
      overrideValue: capped,
    };
  }

  // Path 2: no creator value, no override — use operator default
  return {
    effectiveValue: operatorCeiling,
    source: 'default',
    mutable: true,
    operatorCeiling,
  };
}

/**
 * Resolve the full agent risk contract from all three sources.
 *
 * @param options.hasCapital When false, maxPositionSizePct is marked `enforced: false`
 *   if its value comes from defaults (percentage sizing requires a capital base).
 */
export function resolveAgentRiskContract(
  creator: AgentRiskCreatorInput,
  ceilings: AgentRiskCeilings,
  overrides: AgentRiskOverrides,
  options?: { hasCapital?: boolean },
): ResolvedAgentRiskContract {
  const maxPositionSizePct = resolveRiskField(creator.maxPositionSizePct, ceilings.maxPositionSizePct, overrides.maxPositionSizePct);

  // maxPositionSizePct is not enforced by the engine when capital is absent and
  // the value only comes from the operator default (no user or agent intent).
  const hasCapital = options?.hasCapital ?? true;
  if (!hasCapital && maxPositionSizePct.source === 'default') {
    maxPositionSizePct.enforced = false;
  }

  return {
    maxOpenPositions: resolveRiskField(creator.maxOpenPositions, ceilings.maxOpenPositions, overrides.maxOpenPositions),
    maxPositionSizePct,
    stopLossPct: resolveRiskField(creator.stopLossPct, ceilings.stopLossPct, overrides.stopLossPct),
    stopLossCooldownMs: resolveRiskField(creator.stopLossCooldownMs, ceilings.stopLossCooldownMs, overrides.stopLossCooldownMs),
    maxDrawdownPct: resolveRiskField(creator.maxDrawdownPct, ceilings.maxDrawdownPct, overrides.maxDrawdownPct),
  };
}

/**
 * Validate a proposed override adjustment.
 * Returns an error message if invalid, undefined if valid.
 */
export function validateRiskOverride(
  field: keyof ResolvedAgentRiskContract,
  contract: ResolvedAgentRiskContract,
  proposedValue: number | null,
): string | undefined {
  const descriptor = contract[field];

  if (!descriptor.mutable) {
    return `Field '${field}' is creator-configured and cannot be adjusted at runtime`;
  }

  // null means reset to operator default
  if (proposedValue == null) {
    return undefined;
  }

  // Field-specific lower bounds: maxOpenPositions must be >= 1 (cannot disable),
  // while stopLossPct, stopLossCooldownMs, maxPositionSizePct, and maxDrawdownPct allow 0 (disabled).
  const minByField: Record<keyof ResolvedAgentRiskContract, number> = {
    maxOpenPositions: 1,
    maxPositionSizePct: 0,
    stopLossPct: 0,
    stopLossCooldownMs: 0,
    maxDrawdownPct: 0,
  };
  const min = minByField[field];
  if (proposedValue < min) {
    return `Field '${field}' must be >= ${min}`;
  }

  if (proposedValue > descriptor.operatorCeiling) {
    return `Field '${field}' cannot exceed operator ceiling of ${descriptor.operatorCeiling}`;
  }

  return undefined;
}
