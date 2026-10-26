import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { MeResponse } from '../../lib/api-client.js';
import { NotificationsBlock } from './NotificationsBlock.js';

const LINKED = { chatAddresses: [{ provider: 'telegram', address: '123456789', scope: 'user', status: 'active' }] } as unknown as MeResponse;
const UNLINKED = { chatAddresses: [] } as unknown as MeResponse;

function render(variant: 'settings' | 'page', me: MeResponse | undefined): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (me !== undefined) queryClient.setQueryData(['me'], me);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <IntlProvider locale="en" messages={messages} defaultLocale="en">
          <NotificationsBlock variant={variant} />
        </IntlProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NotificationsBlock', () => {
  it('shows the block with the cancel button on other pages until Telegram is linked', () => {
    const html = render('page', UNLINKED);
    expect(html).toContain(messages['notifications.block.title']);
    expect(html).toContain(`aria-label="${messages['common.cancel']}"`);
  });

  it('hides the block on other pages once Telegram is linked', () => {
    expect(render('page', LINKED)).toBe('');
  });

  it('always shows the block in settings, with Disconnect when linked and no cancel button', () => {
    const html = render('settings', LINKED);
    expect(html).toContain(messages['notifications.block.title']);
    expect(html).toContain(messages['settings.telegram.disconnect']);
    expect(html).not.toContain(`aria-label="${messages['common.cancel']}"`);
  });
});
