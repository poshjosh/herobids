import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProviderDefinition } from '@herobids/domain';
import { connections as connectionsApi, credentials as credentialsApi, providerCatalog as providerCatalogApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button } from '../../lib/ui.js';
import { Modal, FieldLabel, ErrorBanner, inputStyle } from '../portfolios/PortfoliosPage.js';

const CUSTOM_PROVIDER_OPTION = '__custom__';

function findProviderDisplayName(providers: readonly ProviderDefinition[] | undefined, providerId: string): string {
  return providers?.find((provider) => provider.id === providerId)?.displayName ?? providerId;
}

export function ConnectionsPage() {
  const intl = useIntl();
  const [showCreate, setShowCreate] = useState(false);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['connections'],
    queryFn: () => connectionsApi.list(),
  });

  const catalogQuery = useQuery({
    queryKey: ['providerCatalog'],
    queryFn: () => providerCatalogApi.get(),
  });

  const items = query.data?.connections ?? [];

  const revoke = useMutation({
    mutationFn: (id: string) => connectionsApi.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });

  return (
    <PageShell>
      <PageHeader
        title="Connections"
        subtitle={intl.formatMessage({ id: 'connections.subtitle' })}
        action={<Button onClick={() => setShowCreate(true)}>New connection</Button>}
      />
      {query.isLoading && <LoadingRows />}
      {query.isError && <ErrorState message="Failed to load connections" />}
      {!query.isLoading && items.length === 0 && (
        <EmptyState
          title="No connections yet"
          message={intl.formatMessage({ id: 'connections.empty.message' })}
        />
      )}
      {items.map((conn) => (
        <Card key={conn.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 600 }}>{conn.label}</div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                Provider: {findProviderDisplayName(catalogQuery.data?.providers, conn.provider)} · {conn.status}
              </div>
            </div>
            {conn.status === 'active' && (
              <Button
                variant="danger"
                onClick={() => revoke.mutate(conn.id)}
                disabled={revoke.isPending}
              >
                Revoke
              </Button>
            )}
          </div>
        </Card>
      ))}
      {showCreate && (
        <CreateConnectionModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ['connections'] });
            setShowCreate(false);
          }}
        />
      )}
    </PageShell>
  );
}

function CreateConnectionModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [providerChoice, setProviderChoice] = useState(CUSTOM_PROVIDER_OPTION);
  const [customProviderId, setCustomProviderId] = useState('');
  const [label, setLabel] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const catalogQuery = useQuery({
    queryKey: ['providerCatalog'],
    queryFn: () => providerCatalogApi.get(),
  });

  const credQuery = useQuery({
    queryKey: ['credentials'],
    queryFn: () => credentialsApi.list(),
  });

  const selectableProviders = (catalogQuery.data?.providers ?? []).filter(
    (provider) => provider.status !== 'deprecated' && provider.connections,
  );
  const selectedProvider = selectableProviders.find((provider) => provider.id === providerChoice);
  const effectiveProvider = providerChoice === CUSTOM_PROVIDER_OPTION ? customProviderId.trim() : providerChoice.trim();
  const filteredCredentials = (credQuery.data?.credentials ?? []).filter((credential) => {
    if (providerChoice === CUSTOM_PROVIDER_OPTION) {
      return customProviderId.trim().length === 0 || credential.provider === customProviderId.trim();
    }

    const compatibleProviders = selectedProvider?.connections?.credentialProviderIds ?? [];
    return compatibleProviders.length === 0 || compatibleProviders.includes(credential.provider);
  });

  const create = useMutation({
    mutationFn: () =>
      connectionsApi.create({
        provider: effectiveProvider,
        label: label.trim(),
        ...(credentialId ? { credentialId } : {}),
      }),
    onSuccess: onCreated,
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal title="New connection" onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <FieldLabel>Provider</FieldLabel>
      <select style={inputStyle} value={providerChoice} onChange={(e) => setProviderChoice(e.target.value)}>
        <option value={CUSTOM_PROVIDER_OPTION}>Custom</option>
        {selectableProviders.map((provider) => (
          <option key={provider.id} value={provider.id}>{provider.displayName}</option>
        ))}
      </select>
      {providerChoice === CUSTOM_PROVIDER_OPTION ? (
        <input
          style={{ ...inputStyle, marginTop: '8px' }}
          placeholder="e.g. telegram"
          value={customProviderId}
          onChange={(e) => setCustomProviderId(e.target.value)}
        />
      ) : null}
      <FieldLabel>Label</FieldLabel>
      <input
        style={inputStyle}
        placeholder="Human-readable name"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <FieldLabel>Provider credential (optional)</FieldLabel>
      <select
        style={inputStyle}
        value={credentialId}
        onChange={(e) => setCredentialId(e.target.value)}
      >
        <option value="">— none —</option>
        {filteredCredentials.map((c) => (
          <option key={c.id} value={c.id}>{c.provider ? `${c.label} (${c.provider})` : c.label}</option>
        ))}
      </select>
      {selectedProvider?.connections ? (
        <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
          {selectedProvider.connections.autoCreatesTradingConnection ? 'This provider auto-creates a connection for trading.' : 'This provider does not auto-create a connection for trading.'}
        </div>
      ) : null}
      <div style={{ marginTop: '16px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button
          onClick={() => create.mutate()}
          disabled={create.isPending || !effectiveProvider || !label.trim()}
        >
          Create
        </Button>
      </div>
    </Modal>
  );
}
