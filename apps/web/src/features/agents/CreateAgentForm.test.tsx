import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { buildCreateAgentRequest, CreateAgentForm, shouldShowChannelSection } from './CreateAgentForm.js';

function renderForm(): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <CreateAgentForm onCreated={() => undefined} onCancel={() => undefined} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('buildCreateAgentRequest', () => {
  it('sends an empty body when the name is blank so the server allocates one', () => {
    expect(buildCreateAgentRequest('')).toEqual({});
    expect(buildCreateAgentRequest('   ')).toEqual({});
  });

  it('sends the typed name without surrounding whitespace', () => {
    expect(buildCreateAgentRequest('  market-watch-01 ')).toEqual({ name: 'market-watch-01' });
  });
});

describe('shouldShowChannelSection', () => {
  it('shows the channel choice when the profile has no Telegram chat', () => {
    expect(shouldShowChannelSection(null)).toBe(true);
    expect(shouldShowChannelSection('')).toBe(true);
  });

  it('hides the channel choice when the profile already has a Telegram chat', () => {
    expect(shouldShowChannelSection('123456')).toBe(false);
  });
});

describe('CreateAgentForm', () => {
  it('renders the optional name field with the generated-name placeholder', () => {
    const html = renderForm();

    expect(html).toContain('id="create-agent-name"');
    expect(html).toContain(messages['agents.create.nameGenerated']);
  });

  it('offers only the in-app channel and never mentions trading', () => {
    const html = renderForm();

    expect(html).toContain(messages['agents.create.channel.inApp']);
    expect(html.toLowerCase()).not.toContain('trading');
    expect(html.toLowerCase()).not.toContain('skill');
  });
});
