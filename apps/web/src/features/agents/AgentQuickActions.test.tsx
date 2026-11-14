import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { messages as arMessages } from '../../app/i18n/locales/ar.js';
import { AgentQuickActions } from './AgentQuickActions.js';

function renderActions(status: string): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages}>
        <MemoryRouter>
          <AgentQuickActions agentId="agent-1" status={status} />
        </MemoryRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('AgentQuickActions', () => {
  it('offers Start but not Pause or Stop for a stopped agent', () => {
    const html = renderActions('stopped');

    expect(html).toContain('title="Edit"');
    expect(html).toContain('title="Start"');
    expect(html).not.toContain('aria-label="Pause"');
    expect(html).not.toContain('aria-label="Stop"');
  });

  it('offers Pause and Stop but not Start for an active agent', () => {
    const html = renderActions('active');

    expect(html).toContain('aria-label="Pause"');
    expect(html).toContain('aria-label="Stop"');
    expect(html).not.toContain('title="Start"');
  });

  it('explains the cost and restart effect of Pause and Stop in their tooltips', () => {
    const html = renderActions('active');

    expect(html).toContain(`title="${messages['agents.detail.pauseTooltip']}"`);
    expect(html).toContain(`title="${messages['agents.detail.stopTooltip']}"`);
  });

  it('offers a Settings button for every agent status', () => {
    for (const status of ['stopped', 'active', 'paused']) {
      expect(renderActions(status)).toContain(`aria-label="${messages['agents.quickActions.settings']}"`);
    }
  });

  it('translates the Settings, Edit and Start labels', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="ar" messages={arMessages}>
          <MemoryRouter>
            <AgentQuickActions agentId="agent-1" status="stopped" />
          </MemoryRouter>
        </IntlProvider>
      </QueryClientProvider>,
    );
    for (const id of ['agents.quickActions.settings', 'agents.detail.editConfig', 'agents.detail.start']) {
      expect(html).toContain(`title="${arMessages[id]}"`);
      expect(html).toContain(`aria-label="${arMessages[id]}"`);
    }
    expect(html).not.toContain('title="Edit"');
    expect(html).not.toContain('title="Start"');
  });

  it('offers Resume through the Start button for a paused agent', () => {
    const html = renderActions('paused');

    expect(html).toContain('title="Start"');
    expect(html).not.toContain('aria-label="Pause"');
  });
});
