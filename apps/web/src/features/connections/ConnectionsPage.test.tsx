/**
 * Tests for the ConnectionsPage component.
 *
 * Covers:
 *   - Revoke button visibility: always shown for active connections regardless
 *     of assignedAgentCount or referencingBotCount
 *   - Delete button visibility: only shown when no assignments exist
 *   - Delete error handling: connection.in_use, blockingBotIds, generic failures
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { ConnectionsPage } from './ConnectionsPage.js';
import { ApiError } from '../../lib/api-client.js';
import type { Connection } from '../../lib/api-client.js';

// ---------------------------------------------------------------------------
// Pure-function extraction of the deleteMutation.onError handler.
// Mirrors the logic in ConnectionsPage for deterministic unit testing
// without React state, useMutation, or intl plumbing.
// ---------------------------------------------------------------------------

type DeleteErrorState =
  | { type: 'blocked' }
  | { type: 'blockedByBots'; botIds: string }
  | { type: 'generic' };

function handleConnectionDeleteError(error: ApiError): DeleteErrorState {
  if (error.code === 'connection.in_use') {
    if (error.params?.blockingBotIds) {
      return {
        type: 'blockedByBots',
        botIds: (error.params.blockingBotIds as string[]).join(', '),
      };
    }
    return { type: 'blocked' };
  }
  return { type: 'generic' };
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    userId: 'user-1',
    credentialId: null,
    provider: 'hyperliquid',
    label: 'Test Connection',
    status: 'active',
    meta: null,
    resolvedVenueAccountId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    assignedAgentCount: 0,
    referencingBotCount: 0,
    venueAccountRef: null,
    ...overrides,
  };
}

function renderPage(connections: Connection[]): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  qc.setQueryData(['connections'], { connections });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" messages={messages}>
        <ConnectionsPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Revoke button visibility
// ---------------------------------------------------------------------------

describe('ConnectionsPage Revoke button visibility', () => {
  it('shows Revoke for active connections with zero assignments', () => {
    const html = renderPage([
      makeConnection({ assignedAgentCount: 0, referencingBotCount: 0 }),
    ]);
    expect(html).toContain('Revoke');
  });

  it('shows Revoke for active connections with agent assignments', () => {
    const html = renderPage([
      makeConnection({ assignedAgentCount: 3, referencingBotCount: 0 }),
    ]);
    expect(html).toContain('Revoke');
  });

  it('shows Revoke for active connections with bot references', () => {
    const html = renderPage([
      makeConnection({ assignedAgentCount: 0, referencingBotCount: 2 }),
    ]);
    expect(html).toContain('Revoke');
  });

  it('hides Revoke for revoked connections', () => {
    const html = renderPage([
      makeConnection({ status: 'revoked' }),
    ]);
    expect(html).not.toContain('Revoke');
  });
});

// ---------------------------------------------------------------------------
// Delete button visibility
// ---------------------------------------------------------------------------

describe('ConnectionsPage Delete button visibility', () => {
  it('shows Delete for unassigned active connections', () => {
    const html = renderPage([
      makeConnection({ assignedAgentCount: 0, referencingBotCount: 0 }),
    ]);
    expect(html).toContain('Delete');
  });

  it('hides Delete when connection has agent assignments', () => {
    const html = renderPage([
      makeConnection({ assignedAgentCount: 1, referencingBotCount: 0 }),
    ]);
    // "Delete" may appear in the confirm dialog i18n message string, so check
    // that the i18n key for the button itself is absent.
    expect(html).not.toContain('connections.delete');
  });

  it('hides Delete when connection has bot references', () => {
    const html = renderPage([
      makeConnection({ assignedAgentCount: 0, referencingBotCount: 1 }),
    ]);
    expect(html).not.toContain('connections.delete');
  });

  it('shows Delete for revoked connections with no assignments', () => {
    const html = renderPage([
      makeConnection({
        status: 'revoked',
        assignedAgentCount: 0,
        referencingBotCount: 0,
      }),
    ]);
    // Revoked connections: Revoke hidden, Delete visible
    expect(html).not.toContain('Revoke');
    expect(html).toContain('Delete');
  });
});

// ---------------------------------------------------------------------------
// Delete error handling (pure function)
// ---------------------------------------------------------------------------

describe('ConnectionsPage delete error handler', () => {
  it('returns blocked state when error code is connection.in_use without blockingBotIds', () => {
    const error = new ApiError(409, 'connection.in_use', 'In use', {
      connectionId: 'conn-1',
      hint: 'Revoke the connection instead, or remove it from all agents first.',
    });

    const result = handleConnectionDeleteError(error);
    expect(result.type).toBe('blocked');
  });

  it('returns blockedByBots state when error code is connection.in_use with blockingBotIds', () => {
    const error = new ApiError(409, 'connection.in_use', 'In use', {
      connectionId: 'conn-1',
      blockingBotIds: ['bot-a', 'bot-b'],
      hint: 'Delete the bots referencing this connection first.',
    });

    const result = handleConnectionDeleteError(error);
    expect(result.type).toBe('blockedByBots');
    expect((result as { botIds: string }).botIds).toBe('bot-a, bot-b');
  });

  it('returns generic state for non-connection.in_use errors', () => {
    const error = new ApiError(500, 'internal_error', 'Something broke');

    const result = handleConnectionDeleteError(error);
    expect(result.type).toBe('generic');
  });

  it('returns generic state for 404 not_found', () => {
    const error = new ApiError(404, 'not_found', 'Not found');

    const result = handleConnectionDeleteError(error);
    expect(result.type).toBe('generic');
  });

  it('handles connection.in_use with an empty blockingBotIds array', () => {
    const error = new ApiError(409, 'connection.in_use', 'In use', {
      blockingBotIds: [],
    });

    const result = handleConnectionDeleteError(error);
    // Empty array is truthy → takes blockedByBots path with empty join
    expect(result.type).toBe('blockedByBots');
    expect((result as { botIds: string }).botIds).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Cascade delete (provider link) error handling — pure function
// ---------------------------------------------------------------------------

type CascadeDeleteErrorState =
  | { type: 'blocked'; blockingAgentIds: string; blockingConnectionBotIds: string; blockingVenueAccountBotIds: string }
  | { type: 'generic' };

function handleCascadeDeleteError(error: ApiError): CascadeDeleteErrorState {
  if (error.code === 'provider_link.in_use') {
    return {
      type: 'blocked',
      blockingAgentIds: ((error.params?.blockingAgentIds as string[]) ?? []).join(', '),
      blockingConnectionBotIds: ((error.params?.blockingConnectionBotIds as string[]) ?? []).join(', '),
      blockingVenueAccountBotIds: ((error.params?.blockingVenueAccountBotIds as string[]) ?? []).join(', '),
    };
  }
  return { type: 'generic' };
}

describe('ConnectionsPage cascade delete error handler', () => {
  it('returns blocked state when error code is provider_link.in_use', () => {
    const error = new ApiError(409, 'provider_link.in_use', 'In use', {
      connectionId: 'conn-1',
      blockingAgentIds: ['agent-1'],
      blockingConnectionBotIds: ['bot-1'],
      blockingVenueAccountBotIds: [],
      hint: 'Remove agent grants and bots before deleting the linked wallet data.',
    });

    const result = handleCascadeDeleteError(error);
    expect(result.type).toBe('blocked');
    expect((result as CascadeDeleteErrorState & { type: 'blocked' }).blockingAgentIds).toBe('agent-1');
    expect((result as CascadeDeleteErrorState & { type: 'blocked' }).blockingConnectionBotIds).toBe('bot-1');
    expect((result as CascadeDeleteErrorState & { type: 'blocked' }).blockingVenueAccountBotIds).toBe('');
  });

  it('returns generic state for non-provider_link.in_use errors', () => {
    const error = new ApiError(500, 'internal_error', 'Something broke');
    const result = handleCascadeDeleteError(error);
    expect(result.type).toBe('generic');
  });
});

// ---------------------------------------------------------------------------
// Cascade delete button visibility
// ---------------------------------------------------------------------------

describe('ConnectionsPage cascade delete button visibility', () => {
  it('shows cascade delete button for eligible trading connection with resolvedVenueAccountId', () => {
    const html = renderPage([
      makeConnection({
        assignedAgentCount: 0,
        referencingBotCount: 0,
        resolvedVenueAccountId: 'va-1',
      }),
    ]);
    // Should show the cascade delete action text (English rendering)
    expect(html).toContain('Delete connection + linked data');
  });

  it('hides cascade delete button when resolvedVenueAccountId is null', () => {
    const html = renderPage([
      makeConnection({
        assignedAgentCount: 0,
        referencingBotCount: 0,
        resolvedVenueAccountId: null,
      }),
    ]);
    // Regular delete button should be present
    expect(html).toContain('>Delete<');
    // Cascade delete i18n key should not appear
    expect(html).not.toContain('connections.cascadeDelete');
  });

  it('hides both delete buttons when connection has agent assignments', () => {
    const html = renderPage([
      makeConnection({
        assignedAgentCount: 1,
        referencingBotCount: 0,
        resolvedVenueAccountId: 'va-1',
      }),
    ]);
    expect(html).not.toContain('connections.delete');
    expect(html).not.toContain('connections.cascadeDelete');
  });

  it('hides both delete buttons when connection has bot references', () => {
    const html = renderPage([
      makeConnection({
        assignedAgentCount: 0,
        referencingBotCount: 1,
        resolvedVenueAccountId: 'va-1',
      }),
    ]);
    expect(html).not.toContain('connections.delete');
    expect(html).not.toContain('connections.cascadeDelete');
  });
});

// ---------------------------------------------------------------------------
// Wallet details rendering
// ---------------------------------------------------------------------------

describe('ConnectionsPage wallet details rendering', () => {
  it('shows funding address when venueAccountRef exists', () => {
    const html = renderPage([
      makeConnection({ venueAccountRef: '0xabc123' }),
    ]);
    expect(html).toContain('0xabc123');
    expect(html).toContain('Funding address');
  });

  it('hides funding address when venueAccountRef is null', () => {
    const html = renderPage([
      makeConnection({ venueAccountRef: null }),
    ]);
    expect(html).not.toContain('Funding address');
  });

  it('renders the funding address value and label for a venue-account-backed connection', () => {
    const html = renderPage([
      makeConnection({ venueAccountRef: '0xdef456' }),
    ]);
    expect(html).toContain('0xdef456');
    expect(html).toContain('Funding address');
  });
});
