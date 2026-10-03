import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import {
  CapabilityAttributes,
  CapabilityFeeds,
  CapabilityOverview,
  type CapabilityAttribute,
  type CapabilityFeed,
} from './CapabilityPresentation.js';

function renderPresentation(
  attributes: CapabilityAttribute[],
  feeds: CapabilityFeed[],
  messages: Record<string, string> = {},
): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages}>
      <CapabilityAttributes attributes={attributes} />
      <CapabilityFeeds feeds={feeds} />
    </IntlProvider>,
  );
}

function renderFeeds(feeds: CapabilityFeed[], messages: Record<string, string> = {}): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages}>
      <CapabilityFeeds feeds={feeds} />
    </IntlProvider>,
  );
}

function renderOverview(attributes: CapabilityAttribute[], messages: Record<string, string> = {}): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages}>
      <CapabilityOverview attributes={attributes} />
    </IntlProvider>,
  );
}

describe('capability presentation components', () => {
  it('maps supplied emphasis to generic theme tokens without interpreting attribute values', () => {
    const html = renderPresentation(
      [{ key: 'result', label: 'Result', value: '-12.00', emphasis: 'positive' }],
      [{ key: 'events', label: 'Events', items: [{ id: 'event-1', title: 'Completed', occurredAt: '2026-09-19T12:00:00.000Z', emphasis: 'warning' }] }],
    );

    expect(html).toContain('var(--color-success)');
    expect(html).toContain('var(--color-warning)');
    expect(html).toContain('-12.00');
  });

  it('renders a second capability fixture through the same components', () => {
    const html = renderPresentation(
      [{ key: 'inbox', label: 'Inbox', value: 'Connected', emphasis: 'neutral' }],
      [{ key: 'messages', label: 'Recent messages', items: [{ id: 'message-1', title: 'New message', detail: 'A reply is ready.', occurredAt: '2026-09-19T12:00:00.000Z', emphasis: 'positive' }] }],
    );

    expect(html).toContain('Inbox');
    expect(html).toContain('Recent messages');
    expect(html).toContain('New message');
    expect(html).not.toContain('trading');
  });

  // These generic components never import trading formatters (the old
  // `formatPnl`/`pnlColor` helpers are now removed entirely);
  // they only read the `emphasis` field and map it to theme tokens. The value
  // itself is rendered verbatim and never drives the color — a negative-looking
  // value with positive emphasis still renders the success (not danger) token.
  it('maps every emphasis value to its theme token without interpreting the value', () => {
    const html = renderPresentation(
      [
        { key: 'up', label: 'Up', value: '+3.50', emphasis: 'positive' },
        { key: 'down', label: 'Down', value: '-12.00', emphasis: 'negative' },
        { key: 'flag', label: 'Flag', value: 'limit', emphasis: 'warning' },
        { key: 'flat', label: 'Flat', value: '—', emphasis: 'neutral' },
        { key: 'forced', label: 'Forced', value: '-12.00', emphasis: 'positive' },
      ],
      [],
    );

    expect(html).toContain('var(--color-success)');
    expect(html).toContain('var(--color-danger)');
    expect(html).toContain('var(--color-warning)');
    expect(html).toContain('var(--color-surface-2)');
    // The negative-looking value with positive emphasis must not drive danger;
    // there is one success token per positive-`emphasis` row and exactly one danger
    // token (from the `negative` row) — no auto-derivation from the value sign.
    expect((html.match(/var\(--color-danger\)/g) ?? []).length).toBe(1);
  });
});

describe('tabular capability feeds', () => {
  const columnsFeed: CapabilityFeed = {
    key: 'trades',
    label: 'Trades',
    labelKey: 'capability.trading.feed.trades',
    prominence: 'primary',
    columns: [
      { key: 'when', label: 'When', labelKey: 'capability.trading.col.when', align: 'start', format: 'timestamp' },
      { key: 'asset', label: 'Asset', labelKey: 'capability.trading.col.asset', align: 'start', format: 'text' },
      { key: 'pnl', label: 'Profit / loss', labelKey: 'capability.trading.col.pnl', align: 'end', format: 'text' },
    ],
    items: [
      {
        id: 'row-1',
        title: 'BTC',
        occurredAt: '2026-09-19T12:00:00.000Z',
        cells: {
          when: { value: '2026-09-19T12:00:00.000Z' },
          asset: { value: 'BTC' },
          pnl: { value: '-5.00', emphasis: 'positive' },
        },
      },
    ],
  };

  it('renders a table with localized column headers scoped to each column', () => {
    const html = renderFeeds([columnsFeed], { 'capability.trading.col.asset': 'Asset' });

    expect(html).toContain('<table');
    expect(html).toContain('<th scope="col"');
    expect(html).toContain('Asset');
    expect(html).toContain('<td');
  });

  it('right-aligns and monospaces cells declared align:end', () => {
    const html = renderFeeds([columnsFeed]);

    expect(html).toContain('text-align:right');
    expect(html).toContain('monospace');
  });

  it('renders a time element for a timestamp column', () => {
    const html = renderFeeds([columnsFeed]);

    // RelativeTime renders a <span title="<iso>"> whose textual label is
    // relative to the current wall clock ("… ago" / "in …"). Asserting on the
    // relative wording is clock-dependent, so assert on the stable ISO carried
    // by the title attribute instead — that is what makes this a timestamp cell.
    expect(html).toContain('title="2026-09-19T12:00:00.000Z"');
  });

  it('renders an em-dash for a missing cell', () => {
    const feed: CapabilityFeed = {
      ...columnsFeed,
      items: [{ id: 'row-missing', title: 'ETH', occurredAt: '2026-09-19T12:00:00.000Z', cells: { asset: { value: 'ETH' } } }],
    };
    const html = renderFeeds([feed]);

    expect(html).toContain('—');
  });

  it('colours a cell by its emphasis token regardless of the value sign', () => {
    const html = renderFeeds([columnsFeed]);

    // The pnl cell shows a negative-looking "-5.00" but carries positive
    // emphasis; the renderer must map to the success token, not danger.
    expect(html).toContain('var(--color-success)');
    expect(html).not.toContain('var(--color-danger)');
  });
});

describe('label/value localization and fallback', () => {
  it('localizes labelKey and valueKey when the key is present in messages', () => {
    const html = renderToStaticMarkup(
      <IntlProvider
        locale="en"
        messages={{
          'capability.trading.attr.realizedPnl': 'From closed trades',
          'capability.trading.value.closed': 'Closed',
        }}
      >
        <CapabilityAttributes
          attributes={[
            {
              key: 'realized',
              label: 'SERVER LABEL',
              labelKey: 'capability.trading.attr.realizedPnl',
              value: 'SERVER VALUE',
              valueKey: 'capability.trading.value.closed',
            },
          ]}
        />
      </IntlProvider>,
    );

    expect(html).toContain('From closed trades');
    expect(html).toContain('Closed');
    expect(html).not.toContain('SERVER LABEL');
    expect(html).not.toContain('SERVER VALUE');
  });

  it('falls back to the server label and value when the key is absent from messages', () => {
    const html = renderToStaticMarkup(
      <IntlProvider locale="en" messages={{}}>
        <CapabilityAttributes
          attributes={[
            {
              key: 'realized',
              label: 'From closed trades (server)',
              labelKey: 'capability.trading.attr.realizedPnl',
              value: 'Closed (server)',
              valueKey: 'capability.trading.value.closed',
            },
          ]}
        />
      </IntlProvider>,
    );

    expect(html).toContain('From closed trades (server)');
    expect(html).toContain('Closed (server)');
  });

  it('interpolates valueParams into a localized value', () => {
    const html = renderToStaticMarkup(
      <IntlProvider locale="en" messages={{ 'capability.trading.value.winsOfClosed': '{wins} of {closed}' }}>
        <CapabilityAttributes
          attributes={[
            {
              key: 'wins',
              label: 'Winning trades',
              value: '1 of 2',
              valueKey: 'capability.trading.value.winsOfClosed',
              valueParams: { wins: '1', closed: '2' },
            },
          ]}
        />
      </IntlProvider>,
    );

    expect(html).toContain('1 of 2');
  });
});

describe('CapabilityOverview', () => {
  const attributes: CapabilityAttribute[] = [
    { key: 'total-pnl', label: 'Total profit / loss', value: '+12.34', emphasis: 'positive', prominence: 'primary' },
    { key: 'connection', label: 'Connection', value: 'hyperliquid', prominence: 'secondary' },
    { key: 'execution-mode', label: 'Execution mode', value: 'Paper', prominence: 'secondary' },
  ];

  it('renders primary attributes as tiles outside any disclosure', () => {
    const html = renderOverview(attributes, { 'capability.details': 'Details' });

    const detailsIndex = html.indexOf('<details');
    const primaryIndex = html.indexOf('+12.34');
    expect(primaryIndex).toBeGreaterThanOrEqual(0);
    // The primary tile value appears before the Details disclosure.
    expect(primaryIndex).toBeLessThan(detailsIndex);
  });

  it('wraps secondary attributes inside a Details disclosure', () => {
    const html = renderOverview(attributes, { 'capability.details': 'Details' });

    expect(html).toContain('<details');
    expect(html).toContain('Details');
    // Secondary values live after the <details> opening tag.
    const detailsIndex = html.indexOf('<details');
    expect(html.indexOf('hyperliquid')).toBeGreaterThan(detailsIndex);
    expect(html.indexOf('Paper')).toBeGreaterThan(detailsIndex);
  });

  it('does not open the secondary Details disclosure by default', () => {
    const html = renderOverview(attributes);

    expect(html).not.toContain('<details open');
  });
});

describe('secondary feeds and list badges', () => {
  it('wraps a secondary feed in a collapsed Details disclosure', () => {
    const html = renderFeeds([
      {
        key: 'fills',
        label: 'Fills',
        labelKey: 'capability.trading.feed.fills',
        prominence: 'secondary',
        items: [{ id: 'fill-1', title: 'BTC', occurredAt: '2026-09-19T12:00:00.000Z' }],
      },
    ]);

    expect(html).toContain('<details');
    expect(html).not.toContain('<details open');
  });

  it('renders a localized badge and title on a list item', () => {
    const html = renderFeeds(
      [
        {
          key: 'decisions',
          label: 'Decisions',
          prominence: 'secondary',
          items: [
            {
              id: 'decision-1',
              title: 'go long',
              titleKey: 'capability.trading.intent.go_long',
              occurredAt: '2026-09-19T12:00:00.000Z',
              badge: { value: 'Failed', valueKey: 'capability.trading.decisionStatus.failed', emphasis: 'warning' },
            },
          ],
        },
      ],
      {
        'capability.trading.intent.go_long': 'Open long',
        'capability.trading.decisionStatus.failed': 'Failed',
      },
    );

    expect(html).toContain('Open long');
    expect(html).toContain('Failed');
    expect(html).toContain('var(--color-warning)');
  });

  // AG-C05 guard: a non-trading capability renders through the same generic
  // components with no trading-specific vocabulary leaking in.
  it('renders a non-trading fixture through the same components with no trading words', () => {
    const html = renderFeeds([
      {
        key: 'messages',
        label: 'Recent messages',
        prominence: 'secondary',
        items: [{ id: 'm-1', title: 'New message', detail: 'A reply is ready.', occurredAt: '2026-09-19T12:00:00.000Z' }],
      },
    ]);

    expect(html).toContain('Recent messages');
    expect(html).toContain('New message');
    expect(html).not.toContain('trading');
    expect(html).not.toContain('Profit / loss');
  });
});
