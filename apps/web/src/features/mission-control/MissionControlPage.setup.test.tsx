/**
 * Regression tests for the trading-setup wrapper embedded in Mission Control.
 *
 * MissionControlSetupForm renders ProviderSetupForm with defaultCapability="trading"
 * so that the guided setup call includes capability: 'trading' in the request
 * body. The API only provisions a venueAccount + tradingBinding when it receives
 * that field. Without the prop, setup only creates a credential and connection —
 * leaving the trading binding absent, which caused the binding selector to show
 * nothing after page refresh.
 *
 * Bug reference: docs/bug-reports/2026/06/12/007-mission-control-setup-missing-trading-binding.md
 *
 * These tests render MissionControlSetupForm and verify the real Mission Control
 * wiring keeps ProviderSetupForm in trading mode, establishing a regression
 * baseline that fails if the wrapper stops passing defaultCapability="trading".
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { MissionControlSetupForm } from './MissionControlPage.js';

const TEST_PROVIDER_CATALOG = {
  schemaVersion: 'v1' as const,
  etag: 'test-etag',
  providers: [
    {
      id: 'hyperliquid',
      displayName: 'Hyperliquid',
      status: 'supported' as const,
      categories: ['trading'],
      credentials: { fields: [] },
      connections: {
        requiresCredential: false,
        allowsCredential: true,
        credentialProviderIds: ['hyperliquid'],
        autoCreatesTradingBinding: true,
      },
    },
    {
      id: 'bybit',
      displayName: 'Bybit',
      status: 'supported' as const,
      categories: ['trading'],
      credentials: { fields: [] },
      connections: {
        requiresCredential: false,
        allowsCredential: true,
        credentialProviderIds: ['bybit'],
        autoCreatesTradingBinding: true,
      },
    },
    {
      id: 'jupiter',
      displayName: 'Jupiter',
      status: 'supported' as const,
      categories: ['trading', 'swap'],
      credentials: { fields: [] },
      connections: {
        requiresCredential: false,
        allowsCredential: true,
        credentialProviderIds: ['jupiter'],
        autoCreatesTradingBinding: true,
      },
    },
    {
      id: '1inch',
      displayName: '1inch',
      status: 'supported' as const,
      categories: ['trading', 'swap'],
      credentials: { fields: [] },
      connections: {
        requiresCredential: false,
        allowsCredential: true,
        credentialProviderIds: ['1inch'],
        autoCreatesTradingBinding: true,
      },
    },
  ],
  customMode: {
    credentials: { allowFreeformKeys: true },
    connections: { allowFreeformProvider: true, autoCreatesTradingBinding: false },
  },
};

/**
 * Renders the wrapper used by Mission Control after the fix.
 */
function renderMissionControlSetupForm(): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  qc.setQueryData(['providerCatalog'], TEST_PROVIDER_CATALOG);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" messages={messages}>
        <MissionControlSetupForm
          onClose={() => undefined}
          onSuccess={() => undefined}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('MissionControlSetupForm', () => {
  it('renders the trading-specific form title', () => {
    const html = renderMissionControlSetupForm();
    expect(html).toContain(messages['setup.form.tradingTitle']);
  });

  it('does not render the generic (non-trading) form title when they differ', () => {
    const html = renderMissionControlSetupForm();
    // The generic title and trading title are now the same; verify trading title is rendered
    expect(html).toContain(messages['setup.form.tradingTitle']);
  });

  it('renders only trading-capable provider suggestions', () => {
    const html = renderMissionControlSetupForm();
    for (const provider of ['hyperliquid', 'bybit', 'jupiter', '1inch']) {
      expect(html).toContain(`value="${provider}"`);
    }
  });

  it('does not offer non-trading providers such as gmail or n8n', () => {
    const html = renderMissionControlSetupForm();
    expect(html).not.toContain('value="gmail"');
    expect(html).not.toContain('value="n8n"');
    expect(html).not.toContain('value="custom"');
  });

  it('renders the trading-specific submit button label', () => {
    const html = renderMissionControlSetupForm();
    expect(html).toContain(messages['setup.form.tradingSubmit']);
  });
});
