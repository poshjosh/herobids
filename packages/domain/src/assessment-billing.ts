// ── Assessment Billing Outcomes ─────────────────────────────────────────────

/**
 * Distinct outcome of an assessment billing attempt.
 *
 * Every assessment request that passes the initial gates (identity resolution,
 * opt-in validation, cooldown) must produce exactly one of these outcomes.
 * Cache hits are billable — the outcome distinguishes only *why* a charge did
 * or did not settle.
 */
export type AssessmentBillingOutcome =
  | 'billing_blocked'
  | 'cooldown_blocked'
  | 'identity_unresolved'
  | 'provider_failed'
  | 'cache_hit'
  | 'assessment_completed';

// ── Assessment Settlement Policy ────────────────────────────────────────────

/**
 * Contract that every billed assessment request must follow.
 *
 * This is a **policy interface** — the on-demand request service (worker)
 * implements it, but the domain defines the invariants so that billing,
 * retries, and credit release behave consistently across all callers.
 *
 * The policy answers three questions for every billable assessment attempt:
 */
export interface AssessmentSettlementPolicy {
  /**
   * Does a charge **settle** because provider work was attempted?
   *
   * When `true`, the reserved/debited amount is finalised (captured).
   * When `false`, the reservation is released and the agent is not charged.
   *
   * Rules of thumb (exact logic lives in the request service):
   *   - `cache_hit`         → settle (the artifact was produced by a prior
   *                            billed run; reuse is billable per D6).
   *   - `assessment_completed` → settle (a fresh provider run completed).
   *   - `provider_failed`   → release (provider error after reservation;
   *                            agent should not pay for a failed run).
   *   - `billing_blocked`   → N/A (reservation never succeeded).
   *   - `cooldown_blocked`  → N/A (no reservation attempted).
   *   - `identity_unresolved` → N/A (no reservation attempted).
   */
  settleCharge(outcome: AssessmentBillingOutcome): boolean;

  /**
   * Is unused reserved credit **released** back to the agent?
   *
   * A reservation is a hold on funds before the provider work begins.
   * If the work never starts (billing blocked, cooldown, identity failure)
   * or the provider fails, the hold must be released so the agent can use
   * those funds elsewhere.
   *
   * When `true`, the reservation is cancelled and the agent's available
   * credit is restored.  When `false`, the reservation remains captured.
   */
  releaseReservedCredit(outcome: AssessmentBillingOutcome): boolean;

  /**
   * Does a **retry** of the same idempotency key reuse the existing request
   * or start a **newly billed** request?
   *
   *   - `cache_hit`         → reuse (the cached artifact is returned; no
   *                            second charge for the same key+identity).
   *   - `assessment_completed` → reuse (the completed run's artifact is
   *                            returned; no second charge).
   *   - `provider_failed`   → new request (the previous attempt failed;
   *                            a retry is a fresh billable attempt).
   *   - `billing_blocked`   → new request (the previous attempt never
   *                            started provider work).
   *   - `cooldown_blocked`  → new request (cooldown may have elapsed).
   *   - `identity_unresolved` → new request (caller may have corrected
   *                            the symbol).
   *
   * Idempotency is scoped to (agent, canonical identity, idempotency key).
   */
  retryCreatesNewRequest(outcome: AssessmentBillingOutcome): boolean;
}

// ── Settlement Policy Validation ────────────────────────────────────────────

const ALL_OUTCOMES: readonly AssessmentBillingOutcome[] = [
  'billing_blocked',
  'cooldown_blocked',
  'identity_unresolved',
  'provider_failed',
  'cache_hit',
  'assessment_completed',
] as const;

/**
 * Validate that a settlement policy implementation handles all six
 * `AssessmentBillingOutcome` variants without throwing.
 *
 * Every concrete implementation of `AssessmentSettlementPolicy` must be
 * tested against this function to guarantee exhaustive outcome handling.
 *
 * Returns an array of outcomes that caused the policy to throw (empty = valid).
 */
export function validateSettlementPolicy(policy: AssessmentSettlementPolicy): AssessmentBillingOutcome[] {
  const failures: AssessmentBillingOutcome[] = [];
  for (const outcome of ALL_OUTCOMES) {
    try {
      policy.settleCharge(outcome);
      policy.releaseReservedCredit(outcome);
      policy.retryCreatesNewRequest(outcome);
    } catch {
      failures.push(outcome);
    }
  }
  return failures;
}
