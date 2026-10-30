import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AgentQuickActions } from './AgentQuickActions.js';

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
    expect(html).not.toContain('title="Pause"');
    expect(html).not.toContain('title="Stop"');
  });

  it('offers Pause and Stop but not Start for an active agent', () => {
    const html = renderActions('active');

    expect(html).toContain('title="Pause"');
    expect(html).toContain('title="Stop"');
    expect(html).not.toContain('title="Start"');
  });

  it('offers Resume through the Start button for a paused agent', () => {
    const html = renderActions('paused');

    expect(html).toContain('title="Start"');
    expect(html).not.toContain('title="Pause"');
  });
});
