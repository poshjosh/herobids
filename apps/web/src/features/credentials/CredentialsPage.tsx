import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { credentials as credentialsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button } from '../../lib/ui.js';
import { Modal, FieldLabel, ErrorBanner, inputStyle } from '../portfolios/PortfoliosPage.js';

const PROVIDER_SUGGESTIONS = ['hyperliquid', 'bybit', 'jupiter', '1inch', 'telegram', 'zapier', 'custom'];

interface SecretEntry {
  key: string;
  value: string;
}

export function CredentialsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['credentials'],
    queryFn: () => credentialsApi.list(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => credentialsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credentials'] }),
  });

  const items = query.data?.credentials ?? [];

  return (
    <PageShell>
      <PageHeader
        title="Credentials"
        subtitle="Reusable provider secrets for agents and capability bindings"
        action={<Button variant="primary" onClick={() => setShowCreate(true)}>Add provider credential</Button>}
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="No credentials yet"
          message="Add provider credentials once and reuse them across agents and capability families."
          action={<Button variant="primary" onClick={() => setShowCreate(true)}>Add provider credential</Button>}
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {items.map((credential) => (
            <Card key={credential.id} style={{ padding: '14px 20px' }}>
              {(() => {
                const provider = credential.venue;

                return (
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
                <div>
                  <div style={{ fontWeight: '500', marginBottom: '2px' }}>{credential.label}</div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>
                    Provider: {provider}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>ID: {credential.id}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                    Added {new Date(credential.createdAt).toLocaleDateString()}
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      if (confirm(`Delete credential "${credential.label}"?`)) {
                        deleteMutation.mutate(credential.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                  >
                    Delete
                  </Button>
                </div>
              </div>
                );
              })()}
            </Card>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateCredentialModal
          onClose={() => setShowCreate(false)}
          onSuccess={() => {
            void qc.invalidateQueries({ queryKey: ['credentials'] });
            setShowCreate(false);
          }}
        />
      )}
    </PageShell>
  );
}

function CreateCredentialModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [provider, setProvider] = useState('');
  const [label, setLabel] = useState('');
  const [secretEntries, setSecretEntries] = useState<SecretEntry[]>([{ key: '', value: '' }]);

  const mutation = useMutation({
    mutationFn: () => credentialsApi.create({
      provider: provider.trim(),
      label: label.trim(),
      secrets: Object.fromEntries(
        secretEntries
          .map(({ key, value }) => [key.trim(), value.trim()] as const)
          .filter(([key, value]) => key.length > 0 && value.length > 0),
      ),
    }),
    onSuccess,
  });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };

  const updateEntry = (index: number, field: keyof SecretEntry, value: string) => {
    setSecretEntries((entries) => entries.map((entry, currentIndex) => currentIndex === index ? { ...entry, [field]: value } : entry));
  };

  const addEntry = () => {
    setSecretEntries((entries) => [...entries, { key: '', value: '' }]);
  };

  const removeEntry = (index: number) => {
    setSecretEntries((entries) => entries.filter((_, currentIndex) => currentIndex !== index));
  };

  const hasCompleteSecret = secretEntries.some((entry) => entry.key.trim() && entry.value.trim());

  return (
    <Modal title="Add provider credential" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Provider</FieldLabel>
          <input
            list="provider-suggestions"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            placeholder="e.g. hyperliquid, telegram, zapier"
            style={inputStyle}
          />
          <datalist id="provider-suggestions">
            {PROVIDER_SUGGESTIONS.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Label</FieldLabel>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="e.g. Primary provider credential"
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <FieldLabel>Secrets</FieldLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {secretEntries.map((entry, index) => (
              <div key={`${entry.key}-${index}`} style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr auto', gap: '8px', alignItems: 'center' }}>
                <input
                  value={entry.key}
                  onChange={(event) => updateEntry(index, 'key', event.target.value)}
                  placeholder="Secret name"
                  style={inputStyle}
                />
                <input
                  type="password"
                  value={entry.value}
                  onChange={(event) => updateEntry(index, 'value', event.target.value)}
                  placeholder="Secret value"
                  style={inputStyle}
                  autoComplete="new-password"
                />
                <Button variant="ghost" size="sm" onClick={() => removeEntry(index)} disabled={secretEntries.length === 1}>
                  Remove
                </Button>
              </div>
            ))}
          </div>
          <div style={{ marginTop: '8px' }}>
            <Button variant="secondary" size="sm" onClick={addEntry}>Add secret</Button>
          </div>
        </div>

        {mutation.isError && <ErrorBanner message={(mutation.error as Error).message} />}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={mutation.isPending || !provider.trim() || !label.trim() || !hasCompleteSecret}
          >
            {mutation.isPending ? 'Saving…' : 'Save provider credential'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}