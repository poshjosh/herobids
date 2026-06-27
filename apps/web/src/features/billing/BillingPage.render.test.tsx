import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { BillingPage } from './BillingPage.js';

function renderPage(): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  queryClient.setQueryData(['billing', 'summary'], {
    planId: 'free',
    planLabel: 'Free',
    billingInterval: null,
    planLimits: null,
    hasPaymentCustomer: false,
    provider: 'mock',
    subscription: null,
    availablePlans: [],
  });
  queryClient.setQueryData(['billing', 'usage-summary'], {
    account: null,
    currentPeriod: null,
    warnings: [],
    topUpPacks: [],
    byMeter: {},
  });
  queryClient.setQueryData(['billing', 'usage-breakdown', undefined, undefined, undefined], {
    byAgent: [],
    byMeter: [],
    bySkill: [],
  });
  queryClient.setQueryData(['billing', 'usage-events', 0, {
    meterKey: undefined,
    agentId: undefined,
    sessionId: undefined,
    periodId: undefined,
    from: undefined,
    to: undefined,
  }], {
    records: [],
    total: 0,
    limit: 50,
    offset: 0,
  });
  queryClient.setQueryData(['billing', 'periods'], { periods: [] });
  queryClient.setQueryData(['agents', 'list'], []);

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <BillingPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('BillingPage rendering', () => {
  it('renders usage sections and empty states even when no usage account exists', () => {
    const html = renderPage();

    expect(html).toContain('Provider: mock');
    expect(html).toContain('AI Usage — Current Period');
    expect(html).toContain(messages['billing.usage.emptyAccount']);
    expect(html).toContain('Usage by Meter');
    expect(html).toContain(messages['billing.usage.emptyBreakdown']);
    expect(html).toContain('Usage by Agent');
    expect(html).toContain('Usage Events');
    expect(html).toContain('No usage events recorded yet.');
    expect(html).toContain('Billing Periods');
    expect(html).toContain(messages['billing.usage.emptyPeriods']);
  });
});