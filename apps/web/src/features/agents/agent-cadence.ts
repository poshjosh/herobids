/**
 * Derived cadence and spend summaries for the agent create/edit forms.
 *
 * All functions are deterministic — no I/O, no external state — so they are
 * easy to unit test and safe to call during render.
 */

/** Preset-derived base tick intervals in milliseconds (mirrors cost-profile.ts). */
export const PRESET_TICK_INTERVALS: Record<string, number> = {
  minimal: 5_400_000,
  standard: 1_800_000,
  premium: 600_000,
};

const PRESET_DAILY_BUDGETS: Record<string, number> = {
  minimal: 3,
  standard: 10,
  premium: 30,
  custom: 5,
};

function parseNullableNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === '') {
    return null;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

// Cost-per-tick estimates by usage tier (from agentCostEstimates config).
// Derived from eval data (.ignore/eval/2026/06/) — includes input+output token costs.
const COST_PER_TICK = { minimal: 0.08, standard: 0.10, premium: 0.15 };

function deriveCustomTickIntervalMs(dailyBudgetUsd: number): number {
  const estimatedCostPerTick = dailyBudgetUsd <= 3 ? COST_PER_TICK.minimal : dailyBudgetUsd <= 10 ? COST_PER_TICK.standard : COST_PER_TICK.premium;
  const ticksPerDay = Math.max(1, Math.floor(dailyBudgetUsd / estimatedCostPerTick));
  return Math.max(300_000, Math.round(86_400_000 / ticksPerDay));
}

function resolvePresetTickIntervalMs(costPreset: string | null | undefined, dailyBudgetUsd: number | null): number | null {
  if (!costPreset) {
    return null;
  }

  if (costPreset === 'custom') {
    return deriveCustomTickIntervalMs(dailyBudgetUsd ?? 5);
  }

  return PRESET_TICK_INTERVALS[costPreset] ?? null;
}

/**
 * Format a tick interval in milliseconds into a human-readable cadence string.
 * Returns null when the interval is not set and no fallback is available.
 */
export function formatCadence(tickIntervalMs: number): string {
  if (tickIntervalMs < 60_000) {
    const secs = Math.round(tickIntervalMs / 1000);
    return `every ${secs}s`;
  }
  // Use minutes for sub-hour intervals and for intervals that aren't a clean
  // multiple of an hour (e.g. 90 min displays as "every 90 min", not "every 2h").
  if (tickIntervalMs < 3_600_000 || tickIntervalMs % 3_600_000 !== 0) {
    const mins = Math.round(tickIntervalMs / 60_000);
    return `every ${mins} min`;
  }
  const hours = Math.round(tickIntervalMs / 3_600_000);
  return `every ${hours}h`;
}

/**
 * Derive the expected cadence to display when the user has not explicitly set a
 * tick interval.  Returns the preset-derived cadence when a preset is known, or
 * null when neither is available.
 */
export function deriveExpectedCadence(
  tickIntervalMs: number | string | null | undefined,
  costPreset: string | null | undefined,
  dailyBudgetUsd?: number | string | null | undefined,
): string | null {
  const explicit = parseNullableNumber(tickIntervalMs);
  if (explicit != null && !Number.isNaN(explicit) && explicit > 0) {
    return formatCadence(explicit);
  }

  const derivedIntervalMs = resolvePresetTickIntervalMs(costPreset, parseNullableNumber(dailyBudgetUsd));
  if (derivedIntervalMs != null) {
    return formatCadence(derivedIntervalMs);
  }

  return null;
}

/**
 * Estimate the daily USD spend given a tick interval and a budget.
 *
 * This is a rough guide based on average per-tick LLM cost estimates.
 * Returns null when not enough data is available to compute an estimate.
 */
export function estimateDailySpend(
  tickIntervalMs: number | string | null | undefined,
  costPreset: string | null | undefined,
  dailyBudgetUsd: number | null | undefined,
): number | null {
  const explicitBudgetUsd = parseNullableNumber(dailyBudgetUsd);
  if (explicitBudgetUsd != null && explicitBudgetUsd > 0) {
    return explicitBudgetUsd;
  }

  const explicitIntervalMs = parseNullableNumber(tickIntervalMs);
  if (explicitIntervalMs != null && explicitIntervalMs > 0) {
    // from agentCostEstimates config — tiered by cadence frequency
    const costPerTickUsd = explicitIntervalMs >= 3_600_000 ? COST_PER_TICK.minimal : explicitIntervalMs >= 1_800_000 ? COST_PER_TICK.standard : COST_PER_TICK.premium;
    const ticksPerDay = 86_400_000 / explicitIntervalMs;
    return parseFloat((ticksPerDay * costPerTickUsd).toFixed(2));
  }

  if (costPreset && PRESET_DAILY_BUDGETS[costPreset] != null) {
    return PRESET_DAILY_BUDGETS[costPreset]!;
  }

  const intervalMs = explicitIntervalMs ?? resolvePresetTickIntervalMs(costPreset, explicitBudgetUsd);

  if (intervalMs == null || intervalMs <= 0) {
    return null;
  }

  // from agentCostEstimates config — tiered by cadence frequency
  const costPerTickUsd = intervalMs >= 3_600_000 ? COST_PER_TICK.minimal : intervalMs >= 1_800_000 ? COST_PER_TICK.standard : COST_PER_TICK.premium;
  const ticksPerDay = 86_400_000 / intervalMs;
  return parseFloat((ticksPerDay * costPerTickUsd).toFixed(2));
}

/**
 * Returns true when the user has explicitly set a tick interval.
 * Used to decide whether to show the slowdown caveat instead of the expected-cadence line.
 */
export function hasExplicitTickInterval(tickIntervalMs: number | string | null | undefined): boolean {
  const val = parseNullableNumber(tickIntervalMs);
  if (val == null) return false;
  return !Number.isNaN(val) && val > 0;
}
