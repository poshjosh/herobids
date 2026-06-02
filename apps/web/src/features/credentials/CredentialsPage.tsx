import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { credentials as credentialsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button } from '../../lib/ui.js';
import { Modal, FieldLabel, ErrorBanner, inputStyle } from '../portfolios/PortfoliosPage.js';

const SUPPORTED_VENUES = ['hyperliquid', 'bybit', '1inch'];

const VENUE_SECRET_FIELDS: Record<string, string[]> = {
  hyperliquid: ['apiKey', 'secret', 'walletAddress'],
  bybit: ['apiKey', 'secret'],
  '1inch': ['privateKey', 'apiKey'],
};

export function CredentialsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['credentials'],
    queryFn: () => credentialsApi.list(),
  });

  const items = query.data?.credentials ?? [];

  return (
    <PageShell>
      <PageHeader
        title="Credentials"
        subtitle="Venue API keys and wallet secrets"
        action={
          <Button variant="primary" onClick={() => setShowCreate(true)}>
            Add credentials
          </Button>
        }
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="No credentials yet"
          message="Add your venue API keys or wallet credentials to enable trading."
          action={<Button variant="primary" onClick={() => setShowCreate(true)}>Add credentials</Button>}
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {items.map((c) => (
            <Card key={c.id} style={{ padding: '14px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontWeight: '500', marginBottom: '2px' }}>{c.label}</div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{c.venue}</div>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                  Added {new Date(c.createdAt).toLocaleDateString()}
                </div>
              </div>
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
  const [venue, setVenue] = useState(SUPPORTED_VENUES[0]!);
  const [label, setLabel] = useState('');
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: () => credentialsApi.create({ venue, label, secrets }),
    onSuccess,
  });

  const secretFields = VENUE_SECRET_FIELDS[venue] ?? [];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  return (
    <Modal title="Add credentials" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Venue</FieldLabel>
          <select
            value={venue}
            onChange={(e) => { setVenue(e.target.value); setSecrets({}); }}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {SUPPORTED_VENUES.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Label</FieldLabel>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. My Hyperliquid account"
            style={inputStyle}
          />
        </div>

        {secretFields.map((field) => (
          <div key={field} style={{ marginBottom: '16px' }}>
            <FieldLabel>{field}</FieldLabel>
            <input
              type="password"
              value={secrets[field] ?? ''}
              onChange={(e) => setSecrets((prev) => ({ ...prev, [field]: e.target.value }))}
              placeholder={`Enter ${field}`}
              style={inputStyle}
              autoComplete="new-password"
            />
          </div>
        ))}

        {mutation.isError && <ErrorBanner message={(mutation.error as Error).message} />}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={mutation.isPending || !label.trim() || secretFields.some((f) => !secrets[f]?.trim())}
          >
            {mutation.isPending ? 'Saving…' : 'Save credentials'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
