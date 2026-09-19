/**
 * Agent Risk Contract — typed model for per-field source, mutability, and ceiling.
 *
 * This model establishes the two-path runtime contract:
 * 1. Creator-configured limits are immutable at runtime.
 * 2. Operator defaults are the initial fallback and ceiling for agent adjustment.
 * 3. Agent runtime overrides persist separately and survive restart.
 */

import { z } from 'zod';

/** Source of a resolved agent risk field value. */
export type AgentRiskFieldSource = 'user' | 'default' | 'agent_override' | 'derived' | 'disabled';

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
export const AgentRiskOverridesSchema = z.object({
  maxOpenPositions: z.number().min(1).optional(),
  maxPositionSizePct: z.number().min(0).max(100).optional(),
  stopLossPct: z.number().min(0).max(100).optional(),
  stopLossCooldownMs: z.number().min(0).optional(),
  maxDrawdownPct: z.number().min(0).max(100).optional(),
}).strict();
export type AgentRiskOverrides = z.infer<typeof AgentRiskOverridesSchema>;

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

// ─── ResolvedAgentRiskProfile (9-field read model) ───────────────────────────

import type { RiskPosture } from './config/schema.js';

/** Extended ceilings that include dailyMaxLossPct (not in the base 5-field contract). */
export interface AgentRiskCeilingsExtended extends AgentRiskCeilings {
  dailyMaxLossPct: number;
}

/** A single resolved risk profile field with full provenance metadata. */
export interface AgentRiskProfileField {
  /** The raw input value before resolution (creator value, override value, or null). */
  rawValue: number | null;
  /** The value currently in effect for enforcement (null when disabled). */
  effectiveValue: number | null;
  /** Where the effective value came from. */
  source: AgentRiskFieldSource;
  /** Whether the agent may adjust this field at runtime. */
  mutable: boolean;
  /** The operator-defined ceiling — null for fields without a general ceiling. */
  operatorCeiling: number | null;
  /** Whether the engine will actively enforce this limit. */
  enforced: boolean;
  /** The creator-configured value when present (source = 'user'). */
  creatorValue?: number;
  /** The agent's runtime override when present (source = 'agent_override'). */
  overrideValue?: number;
}

/** Full 9-field read model of an agent's resolved risk profile. */
export interface ResolvedAgentRiskProfile {
  maxOpenPositions: AgentRiskProfileField;
  maxPositionSizePct: AgentRiskProfileField;
  stopLossPct: AgentRiskProfileField;
  stopLossCooldownMs: AgentRiskProfileField;
  maxDrawdownPct: AgentRiskProfileField;
  dailyMaxLossPct: AgentRiskProfileField;
  maxNewPositionsPerDay: AgentRiskProfileField;
  avoidParabolicMovePct: AgentRiskProfileField;
  maxOrderNotional: AgentRiskProfileField;
}

/** Adapt an AgentRiskField<number> to the read-model AgentRiskProfileField. */
function toProfileField(field: AgentRiskField<number>): AgentRiskProfileField {
  const rawValue =
    field.source === 'agent_override'
      ? (field.overrideValue ?? null)
      : field.source === 'user'
        ? (field.creatorValue ?? null)
        : null;

  return {
    rawValue,
    effectiveValue: field.effectiveValue,
    source: field.source,
    mutable: field.mutable,
    operatorCeiling: field.operatorCeiling,
    enforced: field.enforced ?? true,
    creatorValue: field.creatorValue,
    overrideValue: field.overrideValue,
  };
}

/**
 * Resolve the full 9-field agent risk profile from all sources.
 *
 * The 5 mutable fields follow the existing two-path contract (creator → default → override).
 * The 4 new fields are immutable (creator-only or derived), with no agent override path.
 *
 * @param riskPosture - Agent's risk posture from the database (nullable fields).
 * @param ceilings - Operator ceiling values for the 5 mutable fields.
 * @param dailyMaxLossPctDefault - Operator default for dailyMaxLossPct (from AgentRiskDefaultsConfig).
 * @param overrides - Persisted agent runtime overrides for the 5 mutable fields.
 * @param options.hasCapital - When false, maxPositionSizePct from defaults is not enforced.
 * @param options.capital - Capital base for deriving maxOrderNotional.
 * @param options.maxOrderNotionalMultiplier - Multiplier applied to capital for derived maxOrderNotional (default 1).
 */
export function resolveAgentRiskProfile(
  riskPosture: RiskPosture | null,
  ceilings: AgentRiskCeilings,
  dailyMaxLossPctDefault: number,
  overrides: AgentRiskOverrides,
  options?: { hasCapital?: boolean; capital?: number; maxOrderNotionalMultiplier?: number },
): ResolvedAgentRiskProfile {
  // ── 5 mutable fields: existing two-path contract ──────────────────────

  const maxOpenPositionsField = resolveRiskField(
    riskPosture?.maxOpenPositions ?? null,
    ceilings.maxOpenPositions,
    overrides.maxOpenPositions,
  );
  const maxPositionSizePctField = resolveRiskField(
    riskPosture?.maxPositionSizePct ?? null,
    ceilings.maxPositionSizePct,
    overrides.maxPositionSizePct,
  );
  const stopLossPctField = resolveRiskField(
    riskPosture?.stopLossPct ?? null,
    ceilings.stopLossPct,
    overrides.stopLossPct,
  );
  const stopLossCooldownMsField = resolveRiskField(
    riskPosture?.stopLossCooldownMs ?? null,
    ceilings.stopLossCooldownMs,
    overrides.stopLossCooldownMs,
  );
  const maxDrawdownPctField = resolveRiskField(
    riskPosture?.maxDrawdownPct ?? null,
    ceilings.maxDrawdownPct,
    overrides.maxDrawdownPct,
  );

  const hasCapital = options?.hasCapital ?? true;

  // maxPositionSizePct: not enforced when capital absent and value is from defaults
  if (!hasCapital && maxPositionSizePctField.source === 'default') {
    maxPositionSizePctField.enforced = false;
  }

  // ── 4 immutable fields: creator-only or derived ───────────────────────

  // dailyMaxLossPct: creator-configured → immutable; absent → operator default (also immutable)
  const dailyMaxLossPctRaw = riskPosture?.dailyMaxLossPct ?? null;
  const dailyMaxLossPctField: AgentRiskProfileField =
    dailyMaxLossPctRaw != null
      ? {
          rawValue: dailyMaxLossPctRaw,
          effectiveValue: dailyMaxLossPctRaw,
          source: 'user',
          mutable: false,
          operatorCeiling: dailyMaxLossPctDefault,
          enforced: true,
          creatorValue: dailyMaxLossPctRaw,
        }
      : {
          rawValue: null,
          effectiveValue: dailyMaxLossPctDefault,
          source: 'default',
          mutable: false,
          operatorCeiling: dailyMaxLossPctDefault,
          enforced: true,
        };

  // maxNewPositionsPerDay: creator-configured → immutable; absent → disabled
  const maxNewPositionsPerDayRaw = riskPosture?.maxNewPositionsPerDay ?? null;
  const maxNewPositionsPerDayField: AgentRiskProfileField =
    maxNewPositionsPerDayRaw != null
      ? {
          rawValue: maxNewPositionsPerDayRaw,
          effectiveValue: maxNewPositionsPerDayRaw,
          source: 'user',
          mutable: false,
          operatorCeiling: null,
          enforced: true,
          creatorValue: maxNewPositionsPerDayRaw,
        }
      : {
          rawValue: null,
          effectiveValue: null,
          source: 'disabled',
          mutable: false,
          operatorCeiling: null,
          enforced: false,
        };

  // avoidParabolicMovePct: same resolution as maxNewPositionsPerDay
  const avoidParabolicMovePctRaw = riskPosture?.avoidParabolicMovePct ?? null;
  const avoidParabolicMovePctField: AgentRiskProfileField =
    avoidParabolicMovePctRaw != null
      ? {
          rawValue: avoidParabolicMovePctRaw,
          effectiveValue: avoidParabolicMovePctRaw,
          source: 'user',
          mutable: false,
          operatorCeiling: null,
          enforced: true,
          creatorValue: avoidParabolicMovePctRaw,
        }
      : {
          rawValue: null,
          effectiveValue: null,
          source: 'disabled',
          mutable: false,
          operatorCeiling: null,
          enforced: false,
        };

  // maxOrderNotional: creator-configured → immutable; absent → derived from capital, or disabled
  const maxOrderNotionalRaw = riskPosture?.maxOrderNotional ?? null;
  const capital = options?.capital;
  const maxOrderNotionalMultiplier = options?.maxOrderNotionalMultiplier ?? 1;
  const maxOrderNotionalField: AgentRiskProfileField =
    maxOrderNotionalRaw != null
      ? {
          rawValue: maxOrderNotionalRaw,
          effectiveValue: maxOrderNotionalRaw,
          source: 'user',
          mutable: false,
          operatorCeiling: null,
          enforced: true,
          creatorValue: maxOrderNotionalRaw,
        }
      : capital != null
        ? {
            rawValue: null,
            effectiveValue: capital * maxOrderNotionalMultiplier,
            source: 'derived',
            mutable: false,
            operatorCeiling: null,
            enforced: true,
          }
        : {
            rawValue: null,
            effectiveValue: null,
            source: 'disabled',
            mutable: false,
            operatorCeiling: null,
            enforced: false,
          };

  return {
    maxOpenPositions: toProfileField(maxOpenPositionsField),
    maxPositionSizePct: toProfileField(maxPositionSizePctField),
    stopLossPct: toProfileField(stopLossPctField),
    stopLossCooldownMs: toProfileField(stopLossCooldownMsField),
    maxDrawdownPct: toProfileField(maxDrawdownPctField),
    dailyMaxLossPct: dailyMaxLossPctField,
    maxNewPositionsPerDay: maxNewPositionsPerDayField,
    avoidParabolicMovePct: avoidParabolicMovePctField,
    maxOrderNotional: maxOrderNotionalField,
  };
}
