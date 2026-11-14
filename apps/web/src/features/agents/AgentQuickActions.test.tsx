import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AgentQuickActions, PAUSE_TOOLTIP, STOP_TOOLTIP } from './AgentQuickActions.js';

function renderActions(status: string): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AgentQuickActions agentId="agent-1" status={status} />
      </MemoryRouter>
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

    expect(html).toContain(`title="${PAUSE_TOOLTIP}"`);
    expect(html).toContain(`title="${STOP_TOOLTIP}"`);
  });

  it('offers Resume through the Start button for a paused agent', () => {
    const html = renderActions('paused');

    expect(html).toContain('title="Start"');
    expect(html).not.toContain('aria-label="Pause"');
  });
});
