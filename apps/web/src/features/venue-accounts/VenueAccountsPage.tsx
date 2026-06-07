import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { venueAccounts as venueAccountsApi, credentials as credentialsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button } from '../../lib/ui.js';
import { Modal, FieldLabel, ErrorBanner, inputStyle } from '../portfolios/PortfoliosPage.js';

const SUPPORTED_VENUES = ['hyperliquid', 'bybit', 'jupiter', '1inch'];
// Source of truth: SWAP_VENUES / ORDERBOOK_VENUES in @herobids/domain — not imported here to keep domain out of the browser bundle
const JUPITER_VENUES = ['jupiter'];  // resolved via venueAccountRef (wallet address)
const ONEINCH_VENUES = ['1inch'];    // resolved via DB credential (privateKey + apiKey)

export function VenueAccountsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['venue-accounts'],
    queryFn: () => venueAccountsApi.list(),
  });

  const items = query.data?.venueAccounts ?? [];

  return (
    <PageShell>
      <PageHeader
        title="Trading setup"
        subtitle="Advanced venue accounts and wallets used by trading capability bindings"
        action={<Button variant="primary" onClick={() => setShowCreate(true)}>Add trading account</Button>}
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="No trading accounts yet"
          message="Add one if you need a legacy venue account for an advanced trading binding."
          action={<Button variant="primary" onClick={() => setShowCreate(true)}>Add trading account</Button>}
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {items.map((va) => (
            <Card key={va.id} style={{ padding: '14px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontWeight: '500', marginBottom: '2px' }}>{va.label}</div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                    {va.venue}{JUPITER_VENUES.includes(va.venue) && va.venueAccountRef ? ` · ${va.venueAccountRef}` : ''}
                  </div>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                  {va.credentialId ? 'Credentials linked' : 'No credentials'}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateVenueAccountModal
          onClose={() => setShowCreate(false)}
          onSuccess={() => {
            void qc.invalidateQueries({ queryKey: ['venue-accounts'] });
            setShowCreate(false);
          }}
        />
      )}
    </PageShell>
  );
}

function CreateVenueAccountModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [venue, setVenue] = useState(SUPPORTED_VENUES[0]!);
  const [label, setLabel] = useState('');
  const [venueAccountRef, setVenueAccountRef] = useState('');
  const [credentialId, setCredentialId] = useState('');

  const credentialsQuery = useQuery({
    queryKey: ['credentials'],
    queryFn: () => credentialsApi.list(),
  });

  const venueCredentials = credentialsQuery.data?.credentials.filter((c) => c.venue === venue) ?? [];

  const mutation = useMutation({
    mutationFn: () =>
      venueAccountsApi.create({
        venue,
        label,
        venueAccountRef: venueAccountRef.trim() || undefined,
        credentialId: credentialId || undefined,
      }),
    onSuccess,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  return (
    <Modal title="Add trading account" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Venue</FieldLabel>
          <select
            value={venue}
            onChange={(e) => { setVenue(e.target.value); setCredentialId(''); setVenueAccountRef(''); }}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {SUPPORTED_VENUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Label</FieldLabel>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Main BTC account" style={inputStyle} />
        </div>

        {JUPITER_VENUES.includes(venue) && (
          <div style={{ marginBottom: '16px' }}>
            <FieldLabel>Solana wallet address (required)</FieldLabel>
            <input value={venueAccountRef} onChange={(e) => setVenueAccountRef(e.target.value)} placeholder="e.g. 7EcDhSYGxX…" style={inputStyle} />
          </div>
        )}

        <div style={{ marginBottom: '20px' }}>
          <FieldLabel>Credentials{ONEINCH_VENUES.includes(venue) ? ' (required)' : ' (optional)'}</FieldLabel>
          <select
            value={credentialId}
            onChange={(e) => setCredentialId(e.target.value)}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            <option value="">— None —</option>
            {venueCredentials.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>

        {mutation.isError && <ErrorBanner message={(mutation.error as Error).message} />}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
          <Button variant="primary" type="submit" disabled={
            mutation.isPending
            || !label.trim()
            || (JUPITER_VENUES.includes(venue) && !venueAccountRef.trim())
            || (ONEINCH_VENUES.includes(venue) && !credentialId)
          }>
            {mutation.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
