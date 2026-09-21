import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { CapabilityAttributes, CapabilityFeeds, type CapabilityAttribute, type CapabilityFeed } from './CapabilityPresentation.js';

function renderPresentation(attributes: CapabilityAttribute[], feeds: CapabilityFeed[]): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={{}}>
      <CapabilityAttributes attributes={attributes} />
      <CapabilityFeeds feeds={feeds} />
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

  // These generic components never import trading formatters (`formatPnl`/`pnlColor`);
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