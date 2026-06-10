import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { messages as hiMessages } from '../../app/i18n/locales/hi.js';
import type { ActivityEvent } from '../../lib/api-client.js';
import { TimelineEvent } from './TimelineEvent.js';

function renderTimelineEvent(event: ActivityEvent, locale = 'en', messages: Record<string, string> = {}): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={messages}>
      <TimelineEvent event={event} />
    </IntlProvider>,
  );
}

describe('TimelineEvent', () => {
  it('localizes the detail toggle and severity label', () => {
    const html = renderTimelineEvent(
      {
        id: 'event-1',
        botId: null,
        instanceLabel: null,
        type: 'risk.guardrail_triggered',
        category: 'risk',
        severity: 'warn',
        messageKey: 'activity.risk.guardrail_triggered',
        timestamp: '2026-06-10T10:00:00.000Z',
        detail: { reason: 'size limit' },
      },
      'hi',
      hiMessages,
    );

    expect(html).toContain('विवरण दिखाएं');
    expect(html).toContain('चेतावनी');
  });

  it('filters non-primitive detail values before interpolation', () => {
    const html = renderTimelineEvent(
      {
        id: 'event-2',
        botId: null,
        instanceLabel: null,
        type: 'order.filled',
        category: 'execution',
        severity: 'info',
        messageKey: 'activity.order.filled',
        timestamp: '2026-06-10T10:00:00.000Z',
        detail: {
          side: 'BUY',
          quantity: 2,
          symbol: 'SOL',
          price: '151.24',
          nested: { unsafe: true },
        },
      },
      'en',
      {
        'activity.order.filled': 'Order filled: {side} {quantity} {symbol} @ {price}',
        'timeline.toggle.showDetail': 'Show detail',
      },
    );

    expect(html).toContain('Order filled: BUY 2 SOL @ 151.24');
    expect(html).not.toContain('[object Object]');
  });
});