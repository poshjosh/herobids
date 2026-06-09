/**
 * Regression tests for bug 006 — "Settings Telegram Save button always enabled".
 *
 * Root cause: the Save button's `disabled` prop only checked `isPending`.
 * Clicking Save with an unchanged or empty chat ID fired a no-op API call and
 * showed a misleading "Telegram chat ID saved." success banner.
 *
 * Fix: add a second condition:
 *   disabled={isPending || telegramChatId.trim() === (savedChatId ?? '')}
 *
 * These tests validate the boolean logic of that disable predicate.
 */
import { describe, it, expect } from 'vitest';

/**
 * Mirrors the disable predicate added to the Save button in SettingsPage.tsx.
 * Save should be disabled (returns true) when the trimmed input already matches
 * the currently-saved server value — no-op saves must not be allowed.
 */
function isSaveDisabled(currentInput: string, savedValue: string | null | undefined): boolean {
  return currentInput.trim() === (savedValue ?? '');
}

describe('Settings page — Telegram Save button disable predicate (bug 006)', () => {
  it('is disabled when input is empty and no chat ID is saved', () => {
    // This is the initial state after page load for a user with no Telegram linked.
    expect(isSaveDisabled('', null)).toBe(true);
    expect(isSaveDisabled('', undefined)).toBe(true);
    expect(isSaveDisabled('   ', null)).toBe(true); // whitespace-only trims to ''
  });

  it('is disabled when input matches the currently saved chat ID', () => {
    expect(isSaveDisabled('123456789', '123456789')).toBe(true);
    expect(isSaveDisabled('  123456789  ', '123456789')).toBe(true); // trim applied
  });

  it('is enabled when input differs from the saved chat ID', () => {
    expect(isSaveDisabled('999888777', '123456789')).toBe(false);
  });

  it('is enabled when a chat ID is entered for the first time (saved is null)', () => {
    expect(isSaveDisabled('123456789', null)).toBe(false);
  });

  it('is enabled when the saved chat ID is cleared (input empty, saved non-null)', () => {
    // User deletes their existing chat ID and saves an empty value to remove it.
    // The Remove button handles this case but the form also supports it.
    expect(isSaveDisabled('', '123456789')).toBe(false);
  });

  it('is disabled when saved is an empty string and input is also empty', () => {
    // Edge case: server returns '' (treated the same as null).
    expect(isSaveDisabled('', '')).toBe(true);
  });
});
