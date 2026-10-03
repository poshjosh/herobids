import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { beforeAll, describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { CapabilityPresentation } from '../../lib/api-client.js';
import { TradingCapabilityPresentation } from './TradingCapabilityPresentation.js';

// The component reads a dismissal flag from localStorage in a useState
// initializer. The node test environment has no DOM, so provide a minimal
// in-memory stub before the component mounts.
beforeAll(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
      },
    });
  }
});

const AGENT_ID = 'agent-1';

function tradesFeedFixture(): CapabilityPresentation['feeds'][number] {
  return {
    key: 'trades',
    label: 'Trades',
    labelKey: 'capability.trading.feed.trades',
    prominence: 'primary',
    columns: [
      { key: 'when', label: 'When', labelKey: 'capability.trading.col.when', align: 'start', format: 'timestamp' },
      { key: 'asset', label: 'Asset', labelKey: 'capability.trading.col.asset', align: 'start', format: 'text' },
      { key: 'status', label: 'Status', labelKey: 'capability.trading.col.status', align: 'start', format: 'text' },
      { key: 'pnl', label: 'Profit / loss', labelKey: 'capability.trading.col.pnl', align: 'end', format: 'text' },
    ],
    items: [
      {
        id: 'open-row',
        title: 'BTC',
        occurredAt: '2026-10-03T10:00:00.000Z',
        cells: {
          when: { value: '2026-10-03T10:00:00.000Z' },
          asset: { value: 'BTC' },
          status: { value: 'Open', valueKey: 'capability.trading.value.open' },
          pnl: { value: '+3.00', emphasis: 'positive' },
        },
      },
      {
        id: 'closed-row',
        title: 'ETH',
        occurredAt: '2026-10-02T10:00:00.000Z',
        cells: {
          when: { value: '2026-10-02T10:00:00.000Z' },
          asset: { value: 'ETH' },
          status: { value: 'Closed', valueKey: 'capability.trading.value.closed' },
          pnl: { value: '+12.34', emphasis: 'positive' },
        },
      },
    ],
  };
}

function presentationFixture(): CapabilityPresentation {
  return {
    family: 'trading',
    connection: { id: 'conn-1', label: 'Hyperliquid', state: 'ready' },
    attributes: [
      { key: 'total-pnl', label: 'Total profit / loss', labelKey: 'capability.trading.attr.totalPnl', value: '+15.34', emphasis: 'positive', prominence: 'primary' },
      { key: 'realized-pnl', label: 'From closed trades', labelKey: 'capability.trading.attr.realizedPnl', value: '+12.34', emphasis: 'positive', prominence: 'primary' },
      { key: 'unrealized-pnl', label: 'From open trades', labelKey: 'capability.trading.attr.unrealizedPnl', value: '+3.00', emphasis: 'positive', prominence: 'primary' },
      { key: 'winning-trades', label: 'Winning trades', labelKey: 'capability.trading.attr.winningTrades', value: '1 of 1', valueKey: 'capability.trading.value.winsOfClosed', valueParams: { wins: '1', closed: '1' }, prominence: 'primary' },
      { key: 'connection', label: 'Connection', labelKey: 'capability.trading.attr.connection', value: 'Hyperliquid', prominence: 'secondary' },
    ],
    feeds: [
      tradesFeedFixture(),
      {
        key: 'decisions',
        label: 'Decisions',
        labelKey: 'capability.trading.feed.decisions',
        prominence: 'secondary',
        items: [
          {
            id: 'decision-1',
            title: 'go long',
            titleKey: 'capability.trading.intent.go_long',
            detail: 'BTC',
            occurredAt: '2026-10-03T09:00:00.000Z',
            badge: { value: 'Done', valueKey: 'capability.trading.decisionStatus.completed', emphasis: 'neutral' },
          },
        ],
      },
      {
        key: 'fills',
        label: 'Fills',
        labelKey: 'capability.trading.feed.fills',
        prominence: 'secondary',
        columns: [
          { key: 'when', label: 'When', labelKey: 'capability.trading.col.when', align: 'start', format: 'timestamp' },
          { key: 'asset', label: 'Asset', labelKey: 'capability.trading.col.asset', align: 'start', format: 'text' },
        ],
        items: [
          { id: 'fill-1', title: 'BTC', occurredAt: '2026-10-03T10:00:00.000Z', cells: { when: { value: '2026-10-03T10:00:00.000Z' }, asset: { value: 'BTC' } } },
        ],
      },
    ],
  };
}

function renderSeeded(): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // Seed every query the component tree reads so nothing hits the network
  // during the static render: the presentation payload, the provider catalog
  // (funding banner), and the approvals list (ApprovalsPanel).
  queryClient.setQueryData(
    ['agents', AGENT_ID, 'capabilities', 'trading', 'presentation'],
    presentationFixture(),
  );
  queryClient.setQueryData(['providerCatalog'], { providers: [] });
  queryClient.setQueryData(['agents', AGENT_ID, 'approvals'], { approvals: [] });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <TradingCapabilityPresentation agentId={AGENT_ID} connectionProvider="hyperliquid" isActive={false} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('TradingCapabilityPresentation', () => {
  it('renders the four P&L summary tiles in order', () => {
    const html = renderSeeded();

    const total = html.indexOf('Total profit / loss');
    const realized = html.indexOf('From closed trades');
    const unrealized = html.indexOf('From open trades');
    const winning = html.indexOf('Winning trades');

    expect(total).toBeGreaterThanOrEqual(0);
    expect(realized).toBeGreaterThan(total);
    expect(unrealized).toBeGreaterThan(realized);
    expect(winning).toBeGreaterThan(unrealized);
    expect(html).toContain('1 of 1');
  });

  it('renders the Trades table with its open and closed rows', () => {
    const html = renderSeeded();

    expect(html).toContain('<table');
    expect(html).toContain('+12.34');
    expect(html).toContain('+3.00');
    expect(html).toContain('Open');
    expect(html).toContain('Closed');
  });

  it('renders Decisions and Fills inside collapsed Details disclosures', () => {
    const html = renderSeeded();

    // Both secondary feeds are wrapped in <details>, and none is force-opened.
    expect(html).toContain('<details');
    expect(html).not.toContain('<details open');
    // The Decisions and Fills labels appear (inside their summaries).
    expect(html).toContain('Decisions');
    expect(html).toContain('Fills');
  });
});
