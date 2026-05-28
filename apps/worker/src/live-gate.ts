import type { LiveRolloutConfig } from '@herobids/domain';
import { price, Decimal } from '@herobids/domain';
import type { Price } from '@herobids/domain';

export interface LiveGateInput {
  executionMode: 'paper' | 'shadow' | 'live';
  venue: string;
  venueType: 'orderbook' | 'swap';
  venueAccountId: string;
  /** True if credentials were resolved from DB (not env fallback) */
  credentialsFromDb: boolean;
  /** True if resolved credentials are non-empty (apiKey + secret both present) */
  credentialsPresent: boolean;
  /** Operator reconciliation.driftAlertOnly setting */
  driftAlertOnly: boolean;
  /** Instance-level maxOrderNotional (from risk config), if set */
  instanceMaxOrderNotional?: string;
}

export interface LiveGateResult {
  /** Effective maxOrderNotional after clamping to operator cap. Undefined preserves prior behavior (no cap). */
  effectiveMaxOrderNotional: Price | undefined;
}

/**
 * Fail-closed startup gate for live execution mode.
 * Returns the effective risk limits on success, or throws with a descriptive message.
 *
 * This function is pure (no I/O) — all inputs are pre-resolved by the caller.
 */
export function assertLiveReadiness(
  liveRollout: LiveRolloutConfig,
  input: LiveGateInput,
): LiveGateResult {
  // Non-live modes pass through unconditionally — preserve the instance value as-is
  // (undefined means "no cap", matching prior behavior where the field was optional)
  if (input.executionMode !== 'live') {
    const notional = input.instanceMaxOrderNotional
      ? price(input.instanceMaxOrderNotional)
      : undefined;
    return { effectiveMaxOrderNotional: notional };
  }

  // --- Live mode gates (fail-closed) ---

  if (!liveRollout.enabled) {
    throw new LiveGateError(
      'live_rollout.disabled',
      'Live execution mode is not enabled in operator config (liveRollout.enabled = false)',
    );
  }

  if (!liveRollout.allowedVenues.includes(input.venue)) {
    throw new LiveGateError(
      'live_rollout.venue_not_allowed',
      `Venue "${input.venue}" is not in liveRollout.allowedVenues [${liveRollout.allowedVenues.join(', ')}]`,
    );
  }

  if (input.venueType !== 'orderbook') {
    throw new LiveGateError(
      'live_rollout.swap_not_supported',
      'Live execution is only supported for orderbook venues during initial rollout',
    );
  }

  if (liveRollout.requireDbCredentials && !input.credentialsFromDb) {
    throw new LiveGateError(
      'live_rollout.env_credentials',
      'Live mode requires DB-backed credentials (liveRollout.requireDbCredentials = true). '
        + `Venue account "${input.venueAccountId}" is using env-var fallback.`,
    );
  }

  if (!input.credentialsPresent) {
    throw new LiveGateError(
      'live_rollout.credentials_empty',
      `Live mode requires non-empty credentials for venue account "${input.venueAccountId}". Resolved apiKey or secret is empty.`,
    );
  }

  if (input.driftAlertOnly) {
    throw new LiveGateError(
      'live_rollout.drift_alert_only',
      'Live mode requires reconciliation to block on drift (reconciliation.driftAlertOnly must be false)',
    );
  }

  // Clamp instance maxOrderNotional to operator cap (using Decimal for precision)
  const operatorCap = new Decimal(liveRollout.maxInitialOrderNotionalUsd);
  const instanceNotional = input.instanceMaxOrderNotional
    ? new Decimal(input.instanceMaxOrderNotional)
    : operatorCap;

  const effective = instanceNotional.lt(operatorCap) ? instanceNotional : operatorCap;
  return { effectiveMaxOrderNotional: effective as Price };
}

export class LiveGateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LiveGateError';
  }
}
