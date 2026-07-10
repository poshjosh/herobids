/**
 * Unit tests for the Agent Email Delivery settings card logic.
 *
 * Covers:
 * - save-button enable/disable predicate
 * - initial toggle state resolution from stored notificationPreferences
 * - request payload construction
 */
import { describe, it, expect } from 'vitest';
import type { UserNotificationPreferences } from '../../lib/api-client.js';

/**
 * Mirrors the save-button disabled condition in SettingsPage.
 * Returns true (disabled) when the local toggle matches the saved value or when
 * the mutation is in flight.
 */
function isEmailDeliverySaveDisabled(
  localEnabled: boolean,
  savedEnabled: boolean,
  isPending: boolean,
): boolean {
  return isPending || localEnabled === savedEnabled;
}

/**
 * Mirrors the savedEmailEnabled derivation in SettingsPage.
 * System default is enabled (true) when no explicit preference is stored.
 */
function resolveInitialEmailEnabled(
  notificationPreferences: UserNotificationPreferences | null | undefined,
): boolean {
  return notificationPreferences?.sendMessage?.email?.enabled ?? true;
}

/**
 * Mirrors the mutationFn argument passed to authApi.updateMe.
 */
function buildEmailDeliveryPayload(enabled: boolean): {
  notificationPreferences: { sendMessage: { email: { enabled: boolean } } };
} {
  return { notificationPreferences: { sendMessage: { email: { enabled } } } };
}

describe('Settings page — Email Delivery save button disable predicate', () => {
  it('is disabled when local value matches the saved value (both true)', () => {
    expect(isEmailDeliverySaveDisabled(true, true, false)).toBe(true);
  });

  it('is disabled when local value matches the saved value (both false)', () => {
    expect(isEmailDeliverySaveDisabled(false, false, false)).toBe(true);
  });

  it('is disabled when the mutation is pending regardless of value', () => {
    expect(isEmailDeliverySaveDisabled(true, false, true)).toBe(true);
    expect(isEmailDeliverySaveDisabled(false, true, true)).toBe(true);
  });

  it('is enabled when toggling ON from a saved-off state', () => {
    expect(isEmailDeliverySaveDisabled(true, false, false)).toBe(false);
  });

  it('is enabled when toggling OFF from a saved-on state', () => {
    expect(isEmailDeliverySaveDisabled(false, true, false)).toBe(false);
  });
});

describe('Settings page — Email Delivery initial toggle state', () => {
  it('defaults to true (enabled) when notificationPreferences is null', () => {
    expect(resolveInitialEmailEnabled(null)).toBe(true);
  });

  it('defaults to true (enabled) when notificationPreferences is undefined', () => {
    expect(resolveInitialEmailEnabled(undefined)).toBe(true);
  });

  it('defaults to true (enabled) when sendMessage is absent', () => {
    expect(resolveInitialEmailEnabled({})).toBe(true);
  });

  it('defaults to true (enabled) when email key is absent inside sendMessage', () => {
    expect(resolveInitialEmailEnabled({ sendMessage: {} })).toBe(true);
  });

  it('returns the explicitly saved enabled value (true)', () => {
    expect(
      resolveInitialEmailEnabled({
        sendMessage: { email: { enabled: true, source: 'explicit_update' } },
      }),
    ).toBe(true);
  });

  it('returns the explicitly saved enabled value (false)', () => {
    expect(
      resolveInitialEmailEnabled({
        sendMessage: { email: { enabled: false, source: 'explicit_update' } },
      }),
    ).toBe(false);
  });
});

describe('Settings page — Email Delivery request payload', () => {
  it('sends enabled: true when the user enables email delivery', () => {
    expect(buildEmailDeliveryPayload(true)).toEqual({
      notificationPreferences: { sendMessage: { email: { enabled: true } } },
    });
  });

  it('sends enabled: false when the user disables email delivery', () => {
    expect(buildEmailDeliveryPayload(false)).toEqual({
      notificationPreferences: { sendMessage: { email: { enabled: false } } },
    });
  });
});
