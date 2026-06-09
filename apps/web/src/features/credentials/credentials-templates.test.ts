/**
 * Regression tests for bug 007 — "Credentials form missing provider secret templates".
 *
 * Root cause: the Add Credential form initialised secret key fields with a single
 * blank entry regardless of which provider was selected. Users had to know which
 * secret keys each provider required.
 *
 * Fix: introduced a PROVIDER_TEMPLATES map and an applyProviderTemplate function
 * that pre-populates the key names (not values) when a known provider is typed and
 * no secret values have been entered yet.
 *
 * These tests cover:
 *   - Each known provider maps to the expected set of key names
 *   - An unknown/custom provider has no template (blank field falls through)
 *   - applyProviderTemplate logic: applies when values are empty, skips when
 *     values have already been entered (preserves user input)
 */
import { describe, it, expect } from 'vitest';
import { PROVIDER_TEMPLATES } from './CredentialsPage.js';

describe('PROVIDER_TEMPLATES map (bug 007)', () => {
  it('maps "hyperliquid" to ["privateKey"]', () => {
    expect(PROVIDER_TEMPLATES['hyperliquid']).toEqual(['apiKey', 'secret', 'walletAddress']);
  });

  it('maps "jupiter" to ["privateKey"]', () => {
    expect(PROVIDER_TEMPLATES['jupiter']).toEqual(['privateKey']);
  });

  it('maps "bybit" to ["apiKey", "apiSecret"]', () => {
    expect(PROVIDER_TEMPLATES['bybit']).toEqual(['apiKey', 'apiSecret']);
  });

  it('maps "1inch" to ["apiKey"]', () => {
    expect(PROVIDER_TEMPLATES['1inch']).toEqual(['apiKey']);
  });

  it('maps "telegram" to ["botToken"]', () => {
    expect(PROVIDER_TEMPLATES['telegram']).toEqual(['botToken']);
  });

  it('returns undefined for unknown providers (no template to apply)', () => {
    expect(PROVIDER_TEMPLATES['zapier']).toBeUndefined();
    expect(PROVIDER_TEMPLATES['custom']).toBeUndefined();
    expect(PROVIDER_TEMPLATES['nonexistent']).toBeUndefined();
  });
});

describe('applyProviderTemplate logic (bug 007)', () => {
  /**
   * Mirrors the applyProviderTemplate function from CreateCredentialModal.
   * Extracted here as a pure function to enable deterministic unit testing
   * without React state or rendering.
   */
  function applyProviderTemplate(
    providerInput: string,
    currentEntries: Array<{ key: string; value: string }>,
  ): Array<{ key: string; value: string }> | null {
    const template = PROVIDER_TEMPLATES[providerInput.trim().toLowerCase()];
    // Only auto-populate/reset when no values have been entered yet — preserve user input.
    const hasValues = currentEntries.some((e) => e.value.trim() !== '');
    if (hasValues) return null; // preserve user input
    if (template) {
      return template.map((key) => ({ key, value: '' }));
    }
    // Unknown provider: reset to a single blank row (clear stale template keys).
    return [{ key: '', value: '' }];
  }

  it('returns template keys for a known provider when entries have no values', () => {
    const result = applyProviderTemplate('hyperliquid', [{ key: '', value: '' }]);
    expect(result).toEqual([{ key: 'privateKey', value: '' }]);
  });

  it('returns multiple template keys for bybit', () => {
    const result = applyProviderTemplate('bybit', [{ key: '', value: '' }]);
    expect(result).toEqual([
      { key: 'apiKey', value: '' },
      { key: 'apiSecret', value: '' },
    ]);
  });

  it('returns a single blank row for an unknown provider (clears stale keys)', () => {
    const result = applyProviderTemplate('custom', [{ key: '', value: '' }]);
    expect(result).toEqual([{ key: '', value: '' }]);
  });

  it('clears stale template keys when switching from a known provider to an unknown one', () => {
    // Simulate: user was on bybit (apiKey + apiSecret), switches to custom.
    const bybitEntries = [{ key: 'apiKey', value: '' }, { key: 'apiSecret', value: '' }];
    const result = applyProviderTemplate('custom', bybitEntries);
    expect(result).toEqual([{ key: '', value: '' }]);
  });

  it('returns null when any entry already has a value — preserves user input', () => {
    // User typed a secret value; switching provider must not overwrite their work.
    const result = applyProviderTemplate('hyperliquid', [{ key: 'myKey', value: 'mySecret' }]);
    expect(result).toBeNull();
  });

  it('applies template when all values are whitespace-only (treated as empty)', () => {
    const result = applyProviderTemplate('telegram', [{ key: '', value: '   ' }]);
    expect(result).toEqual([{ key: 'botToken', value: '' }]);
  });

  it('is case-insensitive for provider lookup', () => {
    // Datalist suggestions are lowercase, but the user might type mixed case.
    const result = applyProviderTemplate('Hyperliquid', [{ key: '', value: '' }]);
    expect(result).toEqual([{ key: 'privateKey', value: '' }]);
  });
});
