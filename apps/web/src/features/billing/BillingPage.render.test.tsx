import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { BillingPage } from './BillingPage.js';
import type { billing } from '../../lib/api-client.js';

type Summary = Awaited<ReturnType<typeof billing.summary>>;

function renderPage(summaryOverrides: Partial<Summary> = {}): string {
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
    ...summaryOverrides,
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

  it('renders Subscribe buttons for new users with the plan display label', () => {
    const html = renderPage({
      subscription: null,
      availablePlans: [
        {
          planId: 'pro',
          prices: [
            { id: 'mock_pro_monthly', interval: 'month', displayLabel: 'Pro Monthly', amountCents: 2900 },
            { id: 'mock_pro_yearly', interval: 'year', displayLabel: 'Pro Yearly', amountCents: 29000 },
          ],
        },
      ],
    });

    expect(html).toContain('Subscribe to Pro Monthly');
    expect(html).toContain('Subscribe to Pro Yearly');
    // Must NOT duplicate the interval inside the label
    expect(html).not.toContain('Subscribe to Pro Monthly (month)');
    expect(html).not.toContain('Subscribe to Pro Yearly (year)');
  });

  it('renders Switch buttons for subscribers with the plan display label', () => {
    const html = renderPage({
      subscription: { status: 'active', currentPeriodEnd: '2027-01-01T00:00:00.000Z', cancelAtPeriodEnd: false, canceledAt: null, trialEnd: null },
      availablePlans: [
        {
          planId: 'pro',
          prices: [
            { id: 'mock_pro_monthly', interval: 'month', displayLabel: 'Pro Monthly', amountCents: 2900 },
          ],
        },
      ],
    });

    expect(html).toContain('Switch to Pro Monthly');
    expect(html).not.toContain('Switch to Pro Monthly (month)');
  });
});