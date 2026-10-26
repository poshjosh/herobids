import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { MeResponse } from '../../lib/api-client.js';
import { ConnectTelegram, ConnectTelegramView, type ConnectTelegramViewProps } from './ConnectTelegram.js';

// Static markup only. The state transitions and the URL, poll, and focus rules are tested in telegram-connect.test.ts.

function renderView(props: Partial<ConnectTelegramViewProps> = {}): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} defaultLocale="en">
      <ConnectTelegramView
        status="idle"
        linkUrl={null}
        errorMessage={null}
        onConnect={vi.fn()}
        {...props}
      />
    </IntlProvider>,
  );
}

function renderContainer(me: MeResponse | undefined): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (me) {
    queryClient.setQueryData(['me'], me);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} defaultLocale="en">
        <ConnectTelegram />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function meWithChatAddresses(chatAddresses: MeResponse['chatAddresses']): MeResponse {
  return { chatAddresses } as MeResponse;
}

describe('ConnectTelegramView', () => {
  it('always mounts the live region, so announcements work from the first state change', () => {
    for (const status of ['idle', 'connecting', 'fallback', 'connected', 'expired', 'error'] as const) {
      expect(renderView({ status, linkUrl: 'https://t.me/OpenAIdomBot?start=link_abc' })).toContain('role="status"');
    }
  });

  it('idle: offers the connect button', () => {
    const html = renderView({ status: 'idle' });
    expect(html).toContain('<button');
    expect(html).toContain(messages['settings.telegram.connect']);
    expect(html).not.toContain(messages['settings.telegram.connected']);
  });

  it('connecting: says to tap Start, hides the button, and links to Telegram when given a url', () => {
    const html = renderView({ status: 'connecting', linkUrl: 'https://t.me/OpenAIdomBot?start=link_abc' });
    expect(html).toContain(messages['settings.telegram.connecting']);
    expect(html).not.toContain('<button');
    expect(html).toContain('href="https://t.me/OpenAIdomBot?start=link_abc"');
    expect(html).toContain(messages['settings.telegram.openTelegram']);
  });

  it('fallback: explains the blocked tab and shows the link to open manually', () => {
    const html = renderView({ status: 'fallback', linkUrl: 'https://t.me/OpenAIdomBot?start=link_abc' });
    expect(html).toContain(messages['settings.telegram.popupBlocked']);
    expect(html).toContain('href="https://t.me/OpenAIdomBot?start=link_abc"');
    expect(html).not.toContain('<button');
  });

  it('connected: shows the confirmation without a connect button', () => {
    const html = renderView({ status: 'connected' });
    expect(html).toContain(messages['settings.telegram.connected']);
    expect(html).not.toContain('<button');
  });

  it('expired: explains the timeout and offers to connect again', () => {
    const html = renderView({ status: 'expired' });
    expect(html).toContain(messages['settings.telegram.expired']);
    expect(html).toContain(messages['settings.telegram.connect']);
  });

  it('error: shows the given error message and offers to connect again', () => {
    const html = renderView({ status: 'error', errorMessage: 'Telegram connect is not configured' });
    expect(html).toContain('Telegram connect is not configured');
    expect(html).toContain(messages['settings.telegram.connect']);
  });

  it('error: falls back to the generic message when none is given', () => {
    const html = renderView({ status: 'error', errorMessage: null });
    expect(html).toContain(messages['settings.telegram.error']);
  });
});

describe('ConnectTelegram', () => {
  it('shows the connect button when no telegram address is linked', () => {
    const html = renderContainer(meWithChatAddresses([]));
    expect(html).toContain(messages['settings.telegram.connect']);
    expect(html).not.toContain(messages['settings.telegram.connected']);
  });

  it('shows the connected state when a telegram address is linked', () => {
    const html = renderContainer(meWithChatAddresses([{ provider: 'telegram', address: '123456789', scope: 'user', status: 'active' }]));
    expect(html).toContain(messages['settings.telegram.connected']);
    expect(html).not.toContain(messages['settings.telegram.connect']);
  });

  it('ignores a revoked telegram address', () => {
    const html = renderContainer(meWithChatAddresses([{ provider: 'telegram', address: '123456789', scope: 'user', status: 'revoked' }]));
    expect(html).toContain(messages['settings.telegram.connect']);
  });
});
