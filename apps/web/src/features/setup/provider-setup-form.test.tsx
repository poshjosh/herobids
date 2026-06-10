/**
 * Tests for the shared ProviderSetupForm component.
 *
 * ProviderSetupForm is the guided setup path for completing trading setup —
 * credential + connection + binding — in a single transactional API call.
 * It is rendered in exactly two surfaces: Mission Control and Create Agent.
 *
 * These tests cover:
 *   - Initial render: all expected form labels and controls are present
 *   - Submit button disable predicate (pure logic)
 *   - Secrets payload construction: empty entries filtered, whitespace trimmed (pure logic)
 *   - hasCompleteSecret predicate (pure logic)
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { ProviderSetupForm, canAutoApplyProviderTemplate } from './ProviderSetupForm.js';

function renderForm(): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" messages={messages}>
        <ProviderSetupForm onClose={() => undefined} onSuccess={() => undefined} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('ProviderSetupForm rendering', () => {
  it('renders the form title from the i18n catalog', () => {
    const html = renderForm();
    expect(html).toContain(messages['setup.form.title']);
  });

  it('renders Provider field label', () => {
    const html = renderForm();
    expect(html).toContain(messages['setup.form.provider']);
  });

  it('renders Label field label', () => {
    const html = renderForm();
    expect(html).toContain(messages['setup.form.label']);
  });

  it('renders Secrets section label', () => {
    const html = renderForm();
    expect(html).toContain(messages['setup.form.secrets']);
  });

  it('renders the submit button with the correct label', () => {
    const html = renderForm();
    expect(html).toContain(messages['setup.form.submit']);
  });

  it('renders the Cancel button', () => {
    const html = renderForm();
    expect(html).toContain(messages['common.cancel']);
  });

  it('renders the Add secret button', () => {
    const html = renderForm();
    expect(html).toContain(messages['setup.form.addSecret']);
  });

  it('renders datalist options for all trading-capable providers', () => {
    const html = renderForm();
    for (const provider of ['hyperliquid', 'bybit', 'jupiter', '1inch']) {
      expect(html).toContain(`value="${provider}"`);
    }
  });

  it('submit button is disabled on initial render because provider and label are empty', () => {
    const html = renderForm();
    // React serialises disabled={true} as the presence of the disabled attribute.
    // The submit button must carry it since provider/label/secrets are all blank.
    expect(html).toContain('disabled');
  });
});

// ---------------------------------------------------------------------------
// Submit button disable predicate (pure logic)
// ---------------------------------------------------------------------------

describe('ProviderSetupForm — submit button disable predicate', () => {
  /**
   * Mirrors the disable expression on the submit <Button> in ProviderSetupForm:
   *   disabled={mutation.isPending || !provider.trim() || !label.trim() || !hasCompleteSecret}
   */
  function isSubmitDisabled(opts: {
    isPending: boolean;
    provider: string;
    label: string;
    hasCompleteSecret: boolean;
  }): boolean {
    return opts.isPending || !opts.provider.trim() || !opts.label.trim() || !opts.hasCompleteSecret;
  }

  it('is disabled when provider is empty', () => {
    expect(
      isSubmitDisabled({ isPending: false, provider: '', label: 'My Account', hasCompleteSecret: true }),
    ).toBe(true);
  });

  it('is disabled when label is empty', () => {
    expect(
      isSubmitDisabled({ isPending: false, provider: 'hyperliquid', label: '', hasCompleteSecret: true }),
    ).toBe(true);
  });

  it('is disabled when no complete secret entry exists', () => {
    expect(
      isSubmitDisabled({ isPending: false, provider: 'hyperliquid', label: 'My Account', hasCompleteSecret: false }),
    ).toBe(true);
  });

  it('is disabled while the mutation is pending', () => {
    expect(
      isSubmitDisabled({ isPending: true, provider: 'hyperliquid', label: 'My Account', hasCompleteSecret: true }),
    ).toBe(true);
  });

  it('is enabled when provider, label, and at least one complete secret are present', () => {
    expect(
      isSubmitDisabled({ isPending: false, provider: 'hyperliquid', label: 'My Account', hasCompleteSecret: true }),
    ).toBe(false);
  });

  it('is disabled when provider contains only whitespace', () => {
    expect(
      isSubmitDisabled({ isPending: false, provider: '   ', label: 'My Account', hasCompleteSecret: true }),
    ).toBe(true);
  });

  it('is disabled when label contains only whitespace', () => {
    expect(
      isSubmitDisabled({ isPending: false, provider: 'hyperliquid', label: '   ', hasCompleteSecret: true }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Secrets payload construction (pure logic)
// ---------------------------------------------------------------------------

describe('ProviderSetupForm — secrets payload construction', () => {
  /**
   * Mirrors the secrets object built inside the mutationFn:
   *   Object.fromEntries(
   *     secretEntries
   *       .map(({ key, value }) => [key.trim(), value.trim()] as const)
   *       .filter(([key, value]) => key.length > 0 && value.length > 0),
   *   )
   */
  function buildSecrets(entries: Array<{ key: string; value: string }>): Record<string, string> {
    return Object.fromEntries(
      entries
        .map(({ key, value }) => [key.trim(), value.trim()] as const)
        .filter(([key, value]) => key.length > 0 && value.length > 0),
    );
  }

  it('includes entries where both key and value are non-empty', () => {
    expect(buildSecrets([{ key: 'apiKey', value: 'abc123' }])).toEqual({ apiKey: 'abc123' });
  });

  it('excludes entries with empty key', () => {
    expect(buildSecrets([{ key: '', value: 'abc123' }])).toEqual({});
  });

  it('excludes entries with empty value', () => {
    expect(buildSecrets([{ key: 'apiKey', value: '' }])).toEqual({});
  });

  it('trims whitespace from both key and value', () => {
    expect(buildSecrets([{ key: '  apiKey  ', value: '  mySecret  ' }])).toEqual({ apiKey: 'mySecret' });
  });

  it('excludes entries that become empty after trimming', () => {
    expect(buildSecrets([{ key: '   ', value: '   ' }])).toEqual({});
  });

  it('keeps only complete entries from a mixed list', () => {
    expect(
      buildSecrets([
        { key: 'apiKey', value: 'key123' },
        { key: '', value: '' },
        { key: 'secret', value: 'mySecret' },
        { key: 'walletAddress', value: '' },
      ]),
    ).toEqual({ apiKey: 'key123', secret: 'mySecret' });
  });
});

// ---------------------------------------------------------------------------
// hasCompleteSecret predicate (pure logic)
// ---------------------------------------------------------------------------

describe('ProviderSetupForm — hasCompleteSecret predicate', () => {
  /**
   * Mirrors the hasCompleteSecret computed value from ProviderSetupForm:
   *   secretEntries.some((e) => e.key.trim() && e.value.trim())
   */
  function hasCompleteSecret(entries: Array<{ key: string; value: string }>): boolean {
    return entries.some((e) => e.key.trim().length > 0 && e.value.trim().length > 0);
  }

  it('returns false when the only entry has empty key and value (initial blank state)', () => {
    expect(hasCompleteSecret([{ key: '', value: '' }])).toBe(false);
  });

  it('returns false when key is filled but value is empty', () => {
    expect(hasCompleteSecret([{ key: 'apiKey', value: '' }])).toBe(false);
  });

  it('returns false when value is filled but key is empty', () => {
    expect(hasCompleteSecret([{ key: '', value: 'abc123' }])).toBe(false);
  });

  it('returns true when at least one entry has both key and value', () => {
    expect(
      hasCompleteSecret([
        { key: '', value: '' },
        { key: 'apiKey', value: 'abc123' },
      ]),
    ).toBe(true);
  });

  it('returns false for whitespace-only entries', () => {
    expect(hasCompleteSecret([{ key: '   ', value: '   ' }])).toBe(false);
  });

  it('returns true for a template-populated entry once value is filled', () => {
    expect(hasCompleteSecret([{ key: 'privateKey', value: 'some-key-value' }])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Template auto-apply predicate
// ---------------------------------------------------------------------------

describe('ProviderSetupForm — template auto-apply predicate', () => {
  it('allows auto-apply for the initial blank row', () => {
    expect(canAutoApplyProviderTemplate([{ key: '', value: '' }])).toBe(true);
  });

  it('allows auto-apply when the current rows match a known blank template', () => {
    expect(
      canAutoApplyProviderTemplate([
        { key: 'apiKey', value: '' },
        { key: 'secret', value: '' },
        { key: 'walletAddress', value: '' },
      ]),
    ).toBe(true);
  });

  it('blocks auto-apply when a user has entered a value', () => {
    expect(
      canAutoApplyProviderTemplate([
        { key: 'apiKey', value: 'abc123' },
        { key: 'secret', value: '' },
      ]),
    ).toBe(false);
  });

  it('blocks auto-apply when a user edited blank keys into a custom shape', () => {
    expect(
      canAutoApplyProviderTemplate([
        { key: 'customKey', value: '' },
        { key: '', value: '' },
      ]),
    ).toBe(false);
  });

  it('blocks auto-apply when the blank rows do not match a known template', () => {
    expect(
      canAutoApplyProviderTemplate([
        { key: 'apiKey', value: '' },
        { key: 'customSecret', value: '' },
      ]),
    ).toBe(false);
  });
});
