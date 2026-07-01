import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { connections as connectionsApi, type ProviderSetupResult } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button } from '../../lib/ui.js';
import { ProviderSetupForm } from '../setup/ProviderSetupForm.js';
import { AgentAssignmentStep } from '../setup/AgentAssignmentStep.js';

type SetupState =
  | { step: 'idle' }
  | { step: 'setup' }
  | { step: 'assign'; result: ProviderSetupResult };

export function ConnectionsPage() {
  const intl = useIntl();
  const [setupState, setSetupState] = useState<SetupState>({ step: 'idle' });
  const [assignmentSuccess, setAssignmentSuccess] = useState(false);
  const qc = useQueryClient();

  const connectionsQuery = useQuery({
    queryKey: ['connections'],
    queryFn: () => connectionsApi.list(),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => connectionsApi.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
  });

  const items = connectionsQuery.data?.connections ?? [];

  const handleSetupSuccess = (result: ProviderSetupResult) => {
    void qc.invalidateQueries({ queryKey: ['connections'] });
    void qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'connections'] });
    setSetupState({ step: 'assign', result });
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

      {items.map((conn) => (
        <Card key={conn.id} style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 600 }}>{conn.label}</div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                {conn.provider} · {conn.status}
              </div>
            </div>
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
          </div>
        </Card>
      ))}

      {setupState.step === 'setup' && (
        <ProviderSetupForm
          defaultCapability="trading"
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
    </PageShell>
  );
}
