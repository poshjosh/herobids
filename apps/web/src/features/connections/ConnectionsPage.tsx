import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { connections as connectionsApi, credentials as credentialsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button } from '../../lib/ui.js';
import { Modal, FieldLabel, ErrorBanner, inputStyle } from '../portfolios/PortfoliosPage.js';

export function ConnectionsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['connections'],
    queryFn: () => connectionsApi.list(),
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
        subtitle="Platform connections to reusable providers"
        action={<Button onClick={() => setShowCreate(true)}>New connection</Button>}
      />
      {query.isLoading && <LoadingRows />}
      {query.isError && <ErrorState message="Failed to load connections" />}
      {!query.isLoading && items.length === 0 && (
        <EmptyState
          title="No connections yet"
          message="Create one to enable capability families for your agents."
        />
      )}
      {items.map((conn) => (
        <Card key={conn.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 600 }}>{conn.label}</div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                Provider: {conn.provider} · {conn.status}
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
  const [provider, setProvider] = useState('');
  const [label, setLabel] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const credQuery = useQuery({
    queryKey: ['credentials'],
    queryFn: () => credentialsApi.list(),
  });

  const create = useMutation({
    mutationFn: () =>
      connectionsApi.create({
        provider: provider.trim(),
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
      <input
        style={inputStyle}
        placeholder="e.g. hyperliquid, telegram"
        value={provider}
        onChange={(e) => setProvider(e.target.value)}
      />
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
        {(credQuery.data?.credentials ?? []).map((c) => (
          <option key={c.id} value={c.id}>{c.label} ({c.provider})</option>
        ))}
      </select>
      <div style={{ marginTop: '16px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button
          onClick={() => create.mutate()}
          disabled={create.isPending || !provider.trim() || !label.trim()}
        >
          Create
        </Button>
      </div>
    </Modal>
  );
}
