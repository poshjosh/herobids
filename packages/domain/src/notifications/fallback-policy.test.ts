import { describe, expect, it } from 'vitest';
import { decideFallback, isEmailFallbackAllowed, type FallbackInput } from './fallback-policy.js';

const eligible: FallbackInput = {
  hasActiveSubscriptions: true,
  pushAttempted: true,
  pushSucceeded: false,
  emailClassEnabled: true,
  userOptedOut: false,
  dailyEmailCount: 0,
  maxPerUserPerDay: 10,
};

describe('decideFallback', () => {
  it.each([
    {
      name: 'sends email when the user has no active subscription',
      input: { hasActiveSubscriptions: false, pushAttempted: false },
      expected: { route: 'email', reason: 'notification.no_subscription' },
    },
    {
      name: 'sends email when every push attempt for the event failed',
      input: { pushAttempted: true, pushSucceeded: false },
      expected: { route: 'email', reason: 'notification.push_all_failed' },
    },
    {
      name: 'sends no email when a push succeeded, even with no other subscription',
      input: { hasActiveSubscriptions: false, pushAttempted: false, pushSucceeded: true },
      expected: { route: 'none', reason: 'notification.push_succeeded' },
    },
    {
      name: 'sends no email when one of several pushes succeeded',
      input: { pushAttempted: true, pushSucceeded: true },
      expected: { route: 'none', reason: 'notification.push_succeeded' },
    },
    {
      name: 'sends no email when the event class is not on the email list',
      input: { hasActiveSubscriptions: false, emailClassEnabled: false },
      expected: { route: 'none', reason: 'notification.class_not_emailed' },
    },
    {
      name: 'sends no email when the user opted out',
      input: { hasActiveSubscriptions: false, userOptedOut: true },
      expected: { route: 'none', reason: 'notification.opted_out' },
    },
    {
      name: 'sends no email once the daily cap is reached',
      input: { hasActiveSubscriptions: false, dailyEmailCount: 10 },
      expected: { route: 'none', reason: 'notification.rate_limited' },
    },
    {
      name: 'sends email while under the daily cap',
      input: { hasActiveSubscriptions: false, dailyEmailCount: 9 },
      expected: { route: 'email', reason: 'notification.no_subscription' },
    },
    {
      name: 'sends no email when subscriptions exist but no push was attempted',
      input: { hasActiveSubscriptions: true, pushAttempted: false },
      expected: { route: 'none', reason: 'notification.push_not_attempted' },
    },
    {
      name: 'prefers the class check over the opt-out and the cap',
      input: { emailClassEnabled: false, userOptedOut: true, dailyEmailCount: 10 },
      expected: { route: 'none', reason: 'notification.class_not_emailed' },
    },
  ])('$name', ({ input, expected }) => {
    expect(decideFallback({ ...eligible, ...input })).toEqual(expected);
  });

  it('never returns an email route together with a successful push', () => {
    const scenarios: FallbackInput[] = [
      { ...eligible, pushSucceeded: true, pushAttempted: true, hasActiveSubscriptions: true },
      { ...eligible, pushSucceeded: true, pushAttempted: false, hasActiveSubscriptions: false },
    ];

    for (const scenario of scenarios) {
      expect(decideFallback(scenario).route).toBe('none');
    }
  });
});

describe('isEmailFallbackAllowed', () => {
  it('uses the operator default when the user has no stored choice', () => {
    expect(isEmailFallbackAllowed(null, false)).toBe(false);
    expect(isEmailFallbackAllowed(null, true)).toBe(true);
    expect(isEmailFallbackAllowed({ sendMessage: { email: { enabled: true, source: 'explicit_update' } } }, false)).toBe(false);
  });

  it('lets an explicit user choice override the operator default', () => {
    const optedIn = { notifications: { emailFallback: { enabled: true } } };
    const optedOut = { notifications: { emailFallback: { enabled: false } } };

    expect(isEmailFallbackAllowed(optedIn, false)).toBe(true);
    expect(isEmailFallbackAllowed(optedOut, true)).toBe(false);
  });

  it('uses the operator default when the stored JSON is malformed', () => {
    expect(isEmailFallbackAllowed({ notifications: { emailFallback: { enabled: 'no' } } }, true)).toBe(true);
    expect(isEmailFallbackAllowed('not-an-object', false)).toBe(false);
  });
});
