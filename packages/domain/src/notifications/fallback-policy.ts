import { z } from 'zod';

/** Reasons the policy picks a route. Each one is a dot-string that is safe to store and log. */
export type FallbackReason =
  | 'notification.push_succeeded'
  | 'notification.push_not_attempted'
  | 'notification.class_not_emailed'
  | 'notification.opted_out'
  | 'notification.rate_limited'
  | 'notification.no_subscription'
  | 'notification.push_all_failed';

/** Exactly one route per event, so push and email can never both be chosen (082 E2). */
export type FallbackDecision =
  | { route: 'none'; reason: FallbackReason }
  | { route: 'email'; reason: 'notification.no_subscription' | 'notification.push_all_failed' };

export interface FallbackInput {
  /** The user has at least one active push subscription. */
  hasActiveSubscriptions: boolean;
  /** A push was sent to at least one subscription for this event. */
  pushAttempted: boolean;
  /** At least one push for this event succeeded. */
  pushSucceeded: boolean;
  /** The event class is on the email list and email is enabled. */
  emailClassEnabled: boolean;
  userOptedOut: boolean;
  /** Fallback emails already counted for this user in the rolling window. */
  dailyEmailCount: number;
  maxPerUserPerDay: number;
}

/**
 * Pure fallback rule (082 E-D1). Email is chosen only when push cannot reach the user:
 * the user has no active subscription, or every push attempt for this event failed.
 * A successful push always wins, so one event never produces both push and email.
 */
export function decideFallback(input: FallbackInput): FallbackDecision {
  if (input.pushSucceeded) return { route: 'none', reason: 'notification.push_succeeded' };
  if (!input.emailClassEnabled) return { route: 'none', reason: 'notification.class_not_emailed' };
  if (input.userOptedOut) return { route: 'none', reason: 'notification.opted_out' };

  const trigger = fallbackTrigger(input);
  if (trigger === null) return { route: 'none', reason: 'notification.push_not_attempted' };
  if (input.dailyEmailCount >= input.maxPerUserPerDay) return { route: 'none', reason: 'notification.rate_limited' };

  return { route: 'email', reason: trigger };
}

function fallbackTrigger(input: FallbackInput): 'notification.no_subscription' | 'notification.push_all_failed' | null {
  if (!input.hasActiveSubscriptions) return 'notification.no_subscription';
  if (input.pushAttempted) return 'notification.push_all_failed';
  return null;
}

/** Stored shape of users.notificationPreferences, read only for the email fallback key. Unknown keys are ignored. */
const StoredEmailFallbackPreferencesSchema = z.object({
  notifications: z.object({
    emailFallback: z.object({ enabled: z.boolean() }).optional(),
  }).optional(),
});

/**
 * Resolves the per-user email fallback choice from the stored JSON (082 E-D4, E7).
 * An explicit user choice wins. Otherwise the operator default applies. Unreadable JSON uses the default.
 */
export function isEmailFallbackAllowed(storedPreferences: unknown, userDefaultEnabled: boolean): boolean {
  const parsed = StoredEmailFallbackPreferencesSchema.safeParse(storedPreferences);
  if (!parsed.success) return userDefaultEnabled;
  return parsed.data.notifications?.emailFallback?.enabled ?? userDefaultEnabled;
}
