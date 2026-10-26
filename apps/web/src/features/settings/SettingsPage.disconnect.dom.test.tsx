// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { ai, auth, type MeResponse } from '../../lib/api-client.js';
import { SettingsPage } from './SettingsPage.js';

vi.mock('../../app/i18n/I18nProvider.js', () => ({
  useLocale: () => ({ locale: 'en', setLocale: () => {}, supportedLocales: ['en', 'ar', 'hi'] }),
}));

// Push opt-in depends on service worker and Notification APIs that jsdom does not provide.
vi.mock('../notifications/PushOptIn.js', () => ({ PushOptIn: () => null }));

vi.mock('../../lib/push/push-browser.js', () => ({ readBrowserPushEnvironment: vi.fn(async () => ({ subscribed: false })) }));

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return {
    ...actual,
    auth: { ...actual.auth, me: vi.fn(), updateMe: vi.fn(), linkTelegram: vi.fn() },
    ai: { ...actual.ai, settings: vi.fn(), availableModels: vi.fn(), updateSettings: vi.fn() },
  };
});

const LINKED = {
  chatAddresses: [{ provider: 'telegram', address: '123456789', scope: 'user', status: 'active' }],
} as unknown as MeResponse;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.me).mockResolvedValue(LINKED);
  vi.mocked(auth.updateMe).mockResolvedValue({ chatAddresses: [] } as unknown as MeResponse);
  vi.mocked(ai.settings).mockResolvedValue({ aiModelConfig: null } as never);
  vi.mocked(ai.availableModels).mockResolvedValue({ providers: [] } as never);
});

afterEach(() => {
  cleanup();
});

describe('SettingsPage Telegram Disconnect (DOM)', () => {
  it('sends a clear-telegram body and shows the not-linked state', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} defaultLocale="en">
          <SettingsPage />
        </IntlProvider>
      </QueryClientProvider>,
    );

    const disconnectLabel = messages['settings.telegram.disconnect'] ?? '';
    fireEvent.click(await screen.findByRole('button', { name: disconnectLabel }));

    await act(async () => {});
    expect(auth.updateMe).toHaveBeenCalledTimes(1);
    expect(vi.mocked(auth.updateMe).mock.calls[0]).toEqual([
      { chatAddresses: [{ provider: 'telegram', address: null }] },
    ]);
    expect(await screen.findByRole('button', { name: messages['settings.telegram.connect'] ?? '' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: disconnectLabel })).toBeNull();
  });
});
