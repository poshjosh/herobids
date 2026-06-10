import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { messages as hiMessages } from '../../app/i18n/locales/hi.js';
import { ActivityItem } from './ActivityItem.js';
import type { ActivityEvent } from '../../lib/api-client.js';

function renderActivity(event: ActivityEvent, locale = 'en', messages: Record<string, string> = {}): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={messages}>
      <ActivityItem event={event} />
    </IntlProvider>,
  );
}

describe('ActivityItem', () => {
  it('renders a localized event message with params in a second locale', () => {
    const html = renderActivity(
      {
        id: 'event-1',
        botId: null,
        instanceLabel: null,
        type: 'order.filled',
        category: 'execution',
        severity: 'info',
        messageKey: 'activity.order.filled',
        timestamp: '2026-06-10T10:00:00.000Z',
        detail: { side: 'BUY', quantity: 2, symbol: 'SOL', price: '151.24' },
      },
      'hi',
      hiMessages,
    );

    expect(html).toContain('ऑर्डर भरा गया');
    expect(html).toContain('BUY');
    expect(html).toContain('SOL');
  });

  it('falls back to the raw event type when the message key is unknown', () => {
    const html = renderActivity({
      id: 'event-2',
      botId: null,
      instanceLabel: null,
      type: 'custom.runtime.event',
      category: 'system',
      severity: 'warn',
      messageKey: 'activity.unknown.key',
      timestamp: '2026-06-10T10:00:00.000Z',
      detail: {},
    });

    expect(html).toContain('custom.runtime.event');
  });

  it('filters non-primitive params before interpolation', () => {
    const html = renderActivity(
      {
        id: 'event-3',
        botId: null,
        instanceLabel: null,
        type: 'order.filled',
        category: 'execution',
        severity: 'info',
        messageKey: 'activity.order.filled',
        timestamp: '2026-06-10T10:00:00.000Z',
        detail: {
          side: 'SELL',
          quantity: 1,
          symbol: 'ETH',
          price: '4000',
          nested: { unsafe: true },
        },
      },
      'en',
      {
        'activity.order.filled': 'Order filled: {side} {quantity} {symbol} @ {price}',
      },
    );

    expect(html).not.toContain('[object Object]');
    expect(html).toContain('Order filled: SELL 1 ETH @ 4000');
  });
});