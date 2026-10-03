import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import {
  capabilities as capabilitiesApi,
  connections as connectionsApi,
  providerCatalog as providerCatalogApi,
} from '../../lib/api-client.js';
import { Button, FieldLabel, inputStyle } from '../../lib/ui.js';
import { VENUE_TYPE_MAP, buildVenueTypeMap } from './venue-mapping.js';
import { ProviderSetupForm } from '../setup/ProviderSetupForm.js';

interface PickerConnection {
  connectionId: string;
  provider: string;
  label: string;
  status: string;
  profile?: Record<string, unknown> | null;
}

interface AgentConnectionFieldProps {
  /** Current connection selection (parent-controlled). */
  connectionIds: string[];
  /** Called with the next selection whenever the user changes it. */
  onChange: (connectionIds: string[]) => void;
  /**
   * Optional relative path to return to after an OAuth-only provider finishes
   * auth. Forwarded straight to {@link ProviderSetupForm}.
   */
  oauthReturnTo?: string;
  /**
   * Called immediately before redirecting into an OAuth-only provider flow.
   * Forwarded straight to {@link ProviderSetupForm}. Callers that need to
   * serialize caller-specific state before the redirect do it here.
   */
  onBeforeOAuthRedirect?: () => void;
}

/**
 * Reusable connection picker: a merged trading + generic connection select
 * (deduped), selected-connection chips with remove, and an "Add connection"
 * button that opens {@link ProviderSetupForm}. Owns its own connection queries
 * and the add-connection dialog state; selection state is parent-controlled.
 */
export function AgentConnectionField({
  connectionIds,
  onChange,
  oauthReturnTo,
  onBeforeOAuthRedirect,
}: AgentConnectionFieldProps) {
  const intl = useIntl();
  const qc = useQueryClient();
  const [showAddConnection, setShowAddConnection] = useState(false);

  const availableConnectionsQuery = useQuery({
    queryKey: ['capabilities', 'trading', 'connections'],
    queryFn: () => capabilitiesApi.tradingConnections(),
  });
  const allConnectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: () => connectionsApi.list(),
  });
  const providerCatalogQuery = useQuery({
    queryKey: ['providerCatalog'],
    queryFn: () => providerCatalogApi.get(),
    staleTime: 60 * 60 * 1000,
  });

  const venueTypeMap = providerCatalogQuery.data?.providers
    ? buildVenueTypeMap(providerCatalogQuery.data.providers)
    : VENUE_TYPE_MAP;

  const availableConnections = (availableConnectionsQuery.data?.connections ?? []).filter(
    (connection) => connection.status === 'active',
  );
  // Generic connections (all providers including Gmail) for the picker display
  const genericConnections = (allConnectionsQuery.data?.connections ?? []).filter(
    (c) => c.status === 'active',
  );
  // Build a merged view for the connection picker
  const allPickerConnections = useMemo(() => {
    const seen = new Set<string>();
    const merged: PickerConnection[] = [];
    for (const c of availableConnections) {
      if (!seen.has(c.connectionId)) {
        seen.add(c.connectionId);
        merged.push({ connectionId: c.connectionId, provider: c.provider, label: c.label, status: c.connectionStatus, profile: c.profile });
      }
    }
    for (const c of genericConnections) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        merged.push({ connectionId: c.id, provider: c.provider, label: c.label, status: c.status, profile: c.profile });
      }
    }
    return merged;
  }, [availableConnections, genericConnections]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <FieldLabel>{intl.formatMessage({ id: 'agents.create.connections' })}</FieldLabel>
      {(availableConnectionsQuery.isLoading || allConnectionsQuery.isLoading) ? (
        <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.create.loadingConnections' })}</div>
      ) : allPickerConnections.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
            {intl.formatMessage({ id: 'agents.create.noConnections' })}
          </div>
          <div>
            <Button variant="secondary" size="sm" onClick={() => setShowAddConnection(true)}>
              {intl.formatMessage({ id: 'agents.create.addConnection' })}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <select
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              if (connectionIds.includes(id)) return;
              onChange([...connectionIds, id]);
            }}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            <option value="">{intl.formatMessage({ id: 'agents.create.chooseConnection' })}</option>
            {/* Trading connections group */}
            {allPickerConnections.some((c) => venueTypeMap[c.provider] !== undefined) && (
              <optgroup label={intl.formatMessage({ id: 'agents.create.connections.trading' })}>
                {allPickerConnections
                  .filter((c) => venueTypeMap[c.provider] !== undefined)
                  .map((connection) => (
                    <option key={connection.connectionId} value={connection.connectionId}>
                      {connection.label} ({connection.provider})
                    </option>
                  ))}
              </optgroup>
            )}
            {/* Non-trading connections group */}
            {allPickerConnections.some((c) => venueTypeMap[c.provider] === undefined) && (
              <optgroup label={intl.formatMessage({ id: 'agents.create.connections.other' })}>
                {allPickerConnections
                  .filter((c) => venueTypeMap[c.provider] === undefined)
                  .map((connection) => (
                    <option key={connection.connectionId} value={connection.connectionId}>
                      {connection.label} ({connection.provider})
                    </option>
                  ))}
              </optgroup>
            )}
          </select>
          {connectionIds.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {connectionIds.map((id) => {
                const conn = allPickerConnections.find((c) => c.connectionId === id);
                return (
                  <span
                    key={id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '2px 8px',
                      borderRadius: '12px',
                      background: 'var(--color-surface-2)',
                      fontSize: '0.75rem',
                      cursor: 'default',
                    }}
                  >
                    {conn?.label ?? id}
                    <button
                      type="button"
                      onClick={() => onChange(connectionIds.filter((cid) => cid !== id))}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '0 2px',
                        fontSize: '0.875rem',
                        lineHeight: '1',
                        color: 'var(--color-text-muted)',
                      }}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowAddConnection(true)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '4px 0',
              fontSize: '0.75rem',
              color: 'var(--color-brand)',
              textAlign: 'left',
            }}
          >
            {intl.formatMessage({ id: 'agents.create.addConnection' })}
          </button>
        </>
      )}

      {showAddConnection && (
        <ProviderSetupForm
          onClose={() => setShowAddConnection(false)}
          onSuccess={(result) => {
            void qc.invalidateQueries({ queryKey: ['connections'] });
            void qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'connections'] });
            if (result.connection?.id) {
              onChange(Array.from(new Set([...connectionIds, result.connection.id])));
            }
            setShowAddConnection(false);
          }}
          oauthReturnTo={oauthReturnTo}
          onBeforeOAuthRedirect={onBeforeOAuthRedirect}
        />
      )}
    </div>
  );
}
