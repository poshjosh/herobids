import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { MeResponse } from '../../lib/api-client.js';
import { CreateAgentFlow } from './CreateAgentFlow.js';

function renderCreateFlow(chatAddresses: MeResponse['chatAddresses'] | undefined): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (chatAddresses !== undefined) {
    queryClient.setQueryData(['me'], { chatAddresses } as MeResponse);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <IntlProvider locale="en" messages={messages} defaultLocale="en">
          <CreateAgentFlow
            skills={[]}
            skillsLoading={false}
            skillsError={null}
            onClose={vi.fn()}
            onCreated={vi.fn()}
          />
        </IntlProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CreateAgentFlow Telegram connect', () => {
  it('shows the connect control when Telegram is not linked', () => {
    const html = renderCreateFlow([]);
    expect(html).toContain(messages['agents.create.telegram.label']);
    expect(html).toContain(messages['settings.telegram.connect']);
  });

  it('hides the connect control when Telegram is already linked', () => {
    const html = renderCreateFlow([{ provider: 'telegram', address: '123456789', scope: 'user', status: 'active' }]);
    expect(html).not.toContain(messages['agents.create.telegram.label']);
    expect(html).not.toContain(messages['settings.telegram.connect']);
  });

  it('hides the connect control until the profile has loaded', () => {
    const html = renderCreateFlow(undefined);
    expect(html).not.toContain(messages['agents.create.telegram.label']);
    expect(html).toContain(messages['agents.create.title']);
  });
});
