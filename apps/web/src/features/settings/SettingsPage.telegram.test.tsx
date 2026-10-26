import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { MeResponse } from '../../lib/api-client.js';
import { SettingsPage } from './SettingsPage.js';

vi.mock('../../app/i18n/I18nProvider.js', () => ({
  useLocale: () => ({ locale: 'en', setLocale: () => {}, supportedLocales: ['en', 'ar', 'hi'] }),
}));

function renderSettings(chatAddresses: MeResponse['chatAddresses']): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['me'], { chatAddresses } as MeResponse);
  queryClient.setQueryData(['ai', 'settings'], { aiModelConfig: null });
  queryClient.setQueryData(['ai', 'available-models'], { providers: [] });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} defaultLocale="en">
        <SettingsPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('SettingsPage Telegram connection', () => {
  it('offers Connect and no Disconnect when Telegram is not linked', () => {
    const html = renderSettings([]);
    expect(html).toContain(messages['settings.telegram.connect']);
    expect(html).not.toContain(messages['settings.telegram.disconnect']);
  });

  it('shows the connected state and Disconnect when Telegram is linked', () => {
    const html = renderSettings([{ provider: 'telegram', address: '123456789', scope: 'user', status: 'active' }]);
    expect(html).toContain(messages['settings.telegram.connected']);
    expect(html).toContain(messages['settings.telegram.disconnect']);
    expect(html).not.toContain(messages['settings.telegram.connect']);
  });

  it('no longer renders a manual Chat ID input', () => {
    const html = renderSettings([]);
    expect(html).not.toContain('Telegram Chat ID');
  });
});
