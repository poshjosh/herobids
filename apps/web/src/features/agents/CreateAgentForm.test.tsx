import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { buildCreateAgentRequest, CreateAgentForm } from './CreateAgentForm.js';

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
  it('sends an empty body when the name and chat ID are blank', () => {
    expect(buildCreateAgentRequest('', '')).toEqual({});
    expect(buildCreateAgentRequest('   ', '   ')).toEqual({});
  });

  it('sends the typed name without surrounding whitespace', () => {
    expect(buildCreateAgentRequest('  market-watch-01 ', '')).toEqual({ name: 'market-watch-01' });
  });

  it('sends the Telegram chat ID when one is entered', () => {
    expect(buildCreateAgentRequest('', ' 123456 ')).toEqual({ telegramChatId: '123456' });
  });
});

describe('CreateAgentForm', () => {
  it('renders the optional name field with the generated-name placeholder', () => {
    const html = renderForm();

    expect(html).toContain('id="create-agent-name"');
    expect(html).toContain(messages['agents.create.nameGenerated']);
  });

  it('shows the Telegram Chat ID field with its explanation and no channel choice', () => {
    const html = renderForm();

    expect(html).toContain('id="create-agent-telegram-chat-id"');
    expect(html).toContain(messages['agents.telegramChatId.help']);
    expect(html).not.toContain('type="radio"');
    expect(html.toLowerCase()).not.toContain('trading');
    expect(html.toLowerCase()).not.toContain('skill');
  });
});
