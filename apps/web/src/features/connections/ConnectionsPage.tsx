import { useState, useEffect } from 'react';
import { useIntl } from 'react-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { connections as connectionsApi, providerCatalog as providerCatalogApi, type ProviderSetupResult, ApiError } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button } from '../../lib/ui.js';
import { ProviderSetupForm } from '../setup/ProviderSetupForm.js';
import { AgentAssignmentStep } from '../setup/AgentAssignmentStep.js';
import { WalletCreatedStep } from '../setup/WalletCreatedStep.js';
import { ErrorBanner } from '../portfolios/PortfoliosPage.js';

type SetupState =
  | { step: 'idle' }
  | { step: 'setup' }
  | { step: 'wallet'; result: ProviderSetupResult }
  | { step: 'assign'; result: ProviderSetupResult };

export function ConnectionsPage() {
  const intl = useIntl();
  const [setupState, setSetupState] = useState<SetupState>({ step: 'idle' });
  const [assignmentSuccess, setAssignmentSuccess] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [oauthNotification, setOauthNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const qc = useQueryClient();

  // Handle OAuth callback query params (e.g. ?setup=gmail&status=ok)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const setupProvider = params.get('setup');
    const status = params.get('status');
    const errorMsg = params.get('error');

    if (setupProvider && status) {
      if (status === 'ok') {
        setOauthNotification({
          type: 'success',
          message: intl.formatMessage({ id: 'connections.oauth.success' }, { provider: setupProvider }),
        });
        void qc.invalidateQueries({ queryKey: ['connections'] });
      } else if (status === 'error') {
        setOauthNotification({
          type: 'error',
          message: errorMsg
            ? intl.formatMessage({ id: 'connections.oauth.errorMessage' }, { message: errorMsg })
            : intl.formatMessage({ id: 'connections.oauth.error' }, { provider: setupProvider }),
        });
      }

      // Clear query params from URL without page reload
      const url = new URL(window.location.href);
      url.searchParams.delete('setup');
      url.searchParams.delete('status');
      url.searchParams.delete('error');
      window.history.replaceState({}, '', url.toString());
    }
  }, [intl, qc]);

  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: () => connectionsApi.list(),
  });

  const providerCatalogQuery = useQuery({
    queryKey: ['providerCatalog'],
    queryFn: () => providerCatalogApi.get(),
    staleTime: 60 * 60 * 1000,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => connectionsApi.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => connectionsApi.delete(id),
    onSuccess: () => {
      setDeleteError(null);
      void qc.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (error: ApiError) => {
      if (error.code === 'connection.in_use') {
        if (error.params?.blockingBotIds) {
          setDeleteError(intl.formatMessage({ id: 'connections.deleteBlockedByBots' }, {
            blockingBotIds: (error.params.blockingBotIds as string[]).join(', '),
          }));
        } else {
          setDeleteError(intl.formatMessage({ id: 'connections.deleteBlocked' }));
        }
      } else {
        setDeleteError(intl.formatMessage({ id: 'connections.deleteFailed' }));
      }
    },
  });

  const items = connectionsQuery.data?.connections ?? [];

  const handleSetupSuccess = (result: ProviderSetupResult) => {
    void qc.invalidateQueries({ queryKey: ['connections'] });
    void qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'connections'] });
    setSetupState(result.wallet ? { step: 'wallet', result } : { step: 'assign', result });
  };

  const handleAssignmentDone = () => {
    setSetupState({ step: 'idle' });
    setAssignmentSuccess(true);
  };

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'nav.connections' })}
        subtitle={intl.formatMessage({ id: 'connections.subtitle' })}
        action={
          <Button onClick={() => setSetupState({ step: 'setup' })}>
            {intl.formatMessage({ id: 'connections.addConnection' })}
          </Button>
        }
      />

      {deleteError && <ErrorBanner message={deleteError} onDismiss={() => setDeleteError(null)} />}

      {oauthNotification && (
        <div style={{
          padding: '10px 16px',
          marginBottom: '16px',
          background: oauthNotification.type === 'success'
            ? 'var(--color-surface-success, rgba(34,197,94,0.08))'
            : 'var(--color-surface-danger, rgba(239,68,68,0.08))',
          borderRadius: '8px',
          fontSize: '13px',
          color: 'var(--color-text-secondary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>{oauthNotification.message}</span>
          <button
            type="button"
            onClick={() => setOauthNotification(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: '16px', lineHeight: 1, padding: '0 4px' }}
          >
            ×
          </button>
        </div>
      )}

      {assignmentSuccess && (
        <div style={{ padding: '10px 16px', marginBottom: '16px', background: 'var(--color-surface-success, rgba(34,197,94,0.08))', borderRadius: '8px', fontSize: '13px', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{intl.formatMessage({ id: 'connections.assignmentSuccess' })}</span>
          <button
            type="button"
            onClick={() => setAssignmentSuccess(false)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: '16px', lineHeight: 1, padding: '0 4px' }}
          >
            ×
          </button>
        </div>
      )}

      {connectionsQuery.isLoading && <LoadingRows />}
      {connectionsQuery.isError && <ErrorState message="Failed to load connections" />}
      {!connectionsQuery.isLoading && items.length === 0 && (
        <EmptyState
          title={intl.formatMessage({ id: 'nav.connections' })}
          message={intl.formatMessage({ id: 'connections.empty.message' })}
          action={
            <Button variant="primary" onClick={() => setSetupState({ step: 'setup' })}>
              {intl.formatMessage({ id: 'connections.connectPlatform' })}
            </Button>
          }
        />
      )}

      {items.map((conn) => {
        const providerInfo = providerCatalogQuery.data?.providers.find((p) => p.id === conn.provider);
        const displayName = providerInfo?.displayName ?? conn.provider;
        const isOAuthProvider = providerInfo?.connections?.allowsCredential === false;
        const emailFromProfile = (conn.profile as { email?: string } | null)?.email ?? (conn.meta as { email?: string } | null)?.email;
        const displayLabel = emailFromProfile ?? conn.label;

        return (
        <Card key={conn.id} style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{
                width: '36px',
                height: '36px',
                borderRadius: '8px',
                background: 'var(--color-surface-2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
                flexShrink: 0,
              }}>
                {displayName.charAt(0).toUpperCase()}
              </div>
              <div>
                <div style={{ fontWeight: 600 }}>{displayLabel}</div>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>{displayName}</span>
                  <span style={{
                    display: 'inline-block',
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: conn.status === 'active' ? 'var(--color-success, #22c55e)' : 'var(--color-danger, #ef4444)',
                  }} />
                  <span>{conn.status}</span>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {conn.status !== 'active' && isOAuthProvider && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    window.location.href = `/connections/oauth/${conn.provider}/authorize`;
                  }}
                >
                  {intl.formatMessage({ id: 'connections.reconnect' })}
                </Button>
              )}
              {conn.status === 'active' && (
                <Button
                  variant="danger"
                  onClick={() => {
                    if (window.confirm(intl.formatMessage({ id: 'connections.revokeConfirm' }))) {
                      revoke.mutate(conn.id);
                    }
                  }}
                  disabled={revoke.isPending}
                >
                  {intl.formatMessage({ id: 'connections.revoke' })}
                </Button>
              )}
              {conn.assignedAgentCount === 0 && conn.referencingBotCount === 0 && (
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm(intl.formatMessage({ id: 'connections.deleteConfirm' }, { label: conn.label }))) {
                    deleteMutation.mutate(conn.id);
                  }
                }}
                disabled={deleteMutation.isPending}
              >
                {intl.formatMessage({ id: 'connections.delete' })}
              </Button>
              )}
            </div>
          </div>
        </Card>
        );
      })}

      {setupState.step === 'setup' && (
        <ProviderSetupForm
          onClose={() => setSetupState({ step: 'idle' })}
          onSuccess={handleSetupSuccess}
        />
      )}

      {setupState.step === 'assign' && (
        <AgentAssignmentStep
          connectionId={setupState.result.connection.id}
          connectionLabel={setupState.result.connection.label}
          connectionProvider={setupState.result.connection.provider}
          onDone={handleAssignmentDone}
        />
      )}

      {setupState.step === 'wallet' && setupState.result.wallet && (
        <WalletCreatedStep
          wallet={setupState.result.wallet}
          onContinue={() => setSetupState({ step: 'assign', result: setupState.result })}
        />
      )}
    </PageShell>
  );
}
