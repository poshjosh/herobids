import type { UsageSummaryResponse } from '../../lib/api-client.js';

export interface BillingGateResult {
  blocked: boolean;
  reason: 'ok' | 'hard_limited' | 'suspended' | 'no_available_credit';
  message: string;
}

/**
 * Check whether the user can use Guided Setup based on their billing status.
 *
 * The frontend gate only blocks on account-level status flags (hard_limited,
 * suspended). Balance-based enforcement is handled authoritatively by the
 * backend 402 guard (canSpendNow).
 */
export function canUseGuidedSetup(summary: UsageSummaryResponse | null): BillingGateResult {
  // No billing data at all → allow (loading state, or API not yet fetched)
  if (!summary) {
    return { blocked: false, reason: 'ok', message: '' };
  }

  // No billing account → fresh user, allow
  if (!summary.account) {
    return { blocked: false, reason: 'ok', message: '' };
  }

  // Block on hard_limited / suspended status only.
  // The backend 402 guard (canSpendNow) is the authoritative enforcement
  // for balance-based limits. The frontend only gates on status-based blocks.
  if (summary.account.status === 'hard_limited') {
    return {
      blocked: true,
      reason: 'hard_limited',
      message: "You've reached your usage limit. Add credit to continue using Guided Setup.",
    };
  }
  if (summary.account.status === 'suspended') {
    return {
      blocked: true,
      reason: 'suspended',
      message: 'Your account is suspended. Please contact support.',
    };
  }

  // Allow through — backend 402 guard is authoritative for balance enforcement
  return { blocked: false, reason: 'ok', message: '' };
}
