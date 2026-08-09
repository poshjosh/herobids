import { useIntl } from 'react-intl';
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { venueAccounts as venueAccountsApi, credentials as credentialsApi, ApiError } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button } from '../../lib/ui.js';
import { Modal, FieldLabel, ErrorBanner, inputStyle } from '../portfolios/PortfoliosPage.js';
import { useTradingVenues } from '../agents/useTradingVenues.js';

export function VenueAccountsPage() {
  const intl = useIntl();
  const [showCreate, setShowCreate] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const qc = useQueryClient();
  const { venueTypeMap } = useTradingVenues();

  const query = useQuery({
    queryKey: ['venue-accounts'],
    queryFn: () => venueAccountsApi.list(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => venueAccountsApi.delete(id),
    onSuccess: () => {
      setDeleteError(null);
      void qc.invalidateQueries({ queryKey: ['venue-accounts'] });
    },
    onError: (error: ApiError) => {
      if (error.code === 'venue_account_in_use') {
        setDeleteError(
          intl.formatMessage({ id: 'venueAccounts.deleteBlocked' }, {
            blockingBotIds: (error.params?.blockingBotIds as string[])?.join(', ') ?? 'none',
          })
        );
      } else {
        setDeleteError(intl.formatMessage({ id: 'venueAccounts.deleteFailed' }));
      }
    },
  });

  const items = query.data?.venueAccounts ?? [];

  return (
    <PageShell>
      <PageHeader
        title="Trading setup"
        subtitle="Advanced venue accounts and wallets used by trading capability bindings"
        action={<Button variant="primary" onClick={() => setShowCreate(true)}>Add trading account</Button>}
      />

      {deleteError && <ErrorBanner message={deleteError} onDismiss={() => setDeleteError(null)} />}

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
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                    {va.venue}{venueTypeMap[va.venue] === 'swap' && va.venueAccountRef ? ` · ${va.venueAccountRef}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                    {va.credentialId ? 'Credentials linked' : 'No credentials'}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        if (confirm(`Delete venue account "${va.label}"?`)) {
                          deleteMutation.mutate(va.id);
                        }
                      }}
                      disabled={deleteMutation.isPending}
                    >
                      Delete
                    </Button>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)', maxWidth: '240px', textAlign: 'right' }}>
                      {intl.formatMessage({ id: 'venueAccounts.guidedLinkNote' })}
                    </div>
                  </div>
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
  const { tradingVenues, tradingProviders } = useTradingVenues();
  const [venue, setVenue] = useState(tradingVenues[0] ?? '');
  const [label, setLabel] = useState('');
  const [venueAccountRef, setVenueAccountRef] = useState('');
  const [credentialId, setCredentialId] = useState('');

  const selectedProvider = useMemo(
    () => tradingProviders.find((p) => p.id === venue) ?? null,
    [tradingProviders, venue],
  );
  // Show wallet address for swap venues that don't require a credential (resolved via on-chain account)
  const needsWalletAddress = selectedProvider?.venueType === 'swap' && !selectedProvider?.connections?.requiresCredential;
  // Credential is required when the provider's connection schema mandates it
  const credentialRequired = selectedProvider?.connections?.requiresCredential === true;
  const credentialLabel = credentialRequired ? ' (required)' : ' (optional)';

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

  // Sync initial venue when tradingVenues loads
  if (tradingVenues.length > 0 && !tradingVenues.includes(venue)) {
    setVenue(tradingVenues[0]!);
  }

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
            {tradingVenues.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <FieldLabel>Label</FieldLabel>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Main BTC account" style={inputStyle} />
        </div>

        {needsWalletAddress && (
          <div style={{ marginBottom: '16px' }}>
            <FieldLabel>Wallet address (required)</FieldLabel>
            <input value={venueAccountRef} onChange={(e) => setVenueAccountRef(e.target.value)} placeholder="e.g. 7EcDhSYGxX…" style={inputStyle} />
          </div>
        )}

        <div style={{ marginBottom: '20px' }}>
          <FieldLabel>Credentials{credentialLabel}</FieldLabel>
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
            || (needsWalletAddress && !venueAccountRef.trim())
            || (credentialRequired && !credentialId)
          }>
            {mutation.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
