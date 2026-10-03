import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { Connection } from '../../lib/api-client.js';

// AgentConnectionField owns three queries (trading connections, generic
// connections, provider catalog) and renders ProviderSetupForm when the
// Add-connection affordance is used. Mock the client boundary so the test can
// seed query caches and render statically.
vi.mock('../../lib/api-client.js', () => ({
  capabilities: { tradingConnections: vi.fn() },
  connections: { list: vi.fn() },
  providerCatalog: { get: vi.fn() },
}));

// ProviderSetupForm pulls in heavy setup wiring; the field only renders it after
// an interaction, which static markup never triggers. Stub it to keep the test
// focused on the picker.
vi.mock('../setup/ProviderSetupForm.js', () => ({
  ProviderSetupForm: () => <div>provider setup form</div>,
}));

import { AgentConnectionField } from './AgentConnectionField.js';

function makeConnection(overrides: Partial<Connection> & Pick<Connection, 'id' | 'provider' | 'label'>): Connection {
  return {
    userId: 'user-1',
    credentialId: null,
    status: 'active',
    meta: null,
    profile: null,
    resolvedVenueAccountId: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    assignedAgentCount: 0,
    referencingBotCount: 0,
    venueAccountRef: null,
    ...overrides,
  };
}

function renderField(opts: {
  connections: Connection[];
  connectionIds?: string[];
}): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  // Seed caches so the queries resolve synchronously during the static render.
  // Leave the provider catalog unseeded so the component falls back to the
  // hardcoded VENUE_TYPE_MAP (hyperliquid → orderbook → trading optgroup); an
  // empty seeded catalog would classify every provider as "other".
  queryClient.setQueryData(['capabilities', 'trading', 'connections'], { family: 'trading', connections: [] });
  queryClient.setQueryData(['connections'], { connections: opts.connections });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <MemoryRouter>
          <AgentConnectionField
            connectionIds={opts.connectionIds ?? []}
            onChange={vi.fn()}
          />
        </MemoryRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('AgentConnectionField', () => {
  it('groups a trading connection under the trading optgroup and a non-trading one under other', () => {
    const html = renderField({
      connections: [
        makeConnection({ id: 'conn-hl', provider: 'hyperliquid', label: 'Primary Hyperliquid' }),
        makeConnection({ id: 'conn-gmail', provider: 'gmail', label: 'Work Gmail' }),
      ],
    });

    expect(html).toContain(messages['agents.create.connections.trading']);
    expect(html).toContain(messages['agents.create.connections.other']);
    expect(html).toContain('Primary Hyperliquid (hyperliquid)');
    expect(html).toContain('Work Gmail (gmail)');
  });

  it('renders the Add-connection affordance so a new connection can be created in place', () => {
    const html = renderField({
      connections: [makeConnection({ id: 'conn-hl', provider: 'hyperliquid', label: 'Primary Hyperliquid' })],
    });

    expect(html).toContain(messages['agents.create.addConnection']);
  });

  it('shows a chip for each already-selected connection', () => {
    const html = renderField({
      connections: [
        makeConnection({ id: 'conn-hl', provider: 'hyperliquid', label: 'Primary Hyperliquid' }),
        makeConnection({ id: 'conn-gmail', provider: 'gmail', label: 'Work Gmail' }),
      ],
      connectionIds: ['conn-gmail'],
    });

    // Prove the chip element itself rendered, not just the option text. The chip
    // is the only place the bare label appears next to a remove (×) control, so
    // assert the label followed by the × button within the same markup.
    expect(html).toMatch(/Work Gmail<button[^>]*>×<\/button>/);
  });

  it('shows the no-connections message and the Add-connection button when the account list is empty', () => {
    const html = renderField({ connections: [] });

    expect(html).toContain(messages['agents.create.noConnections']);
    expect(html).toContain(messages['agents.create.addConnection']);
  });
});
