import { useNavigate, useParams } from 'react-router';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, capabilities as capabilitiesApi, type CapabilityReadiness } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button, StatusBadge, KV } from '../../lib/ui.js';
import { formatCapabilityFamily, formatCapabilityState } from './agent-display.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { ProviderSetupForm } from '../setup/ProviderSetupForm.js';
import { TradingCapabilityPresentation } from './TradingCapabilityPresentation.js';

export function AgentCapabilityPage() {
  const { agentId, family } = useParams<{ agentId: string; family: string }>();
  const intl = useIntl();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showAddConnection, setShowAddConnection] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);

  const agentQuery = useQuery({
    queryKey: ['agents', agentId],
    queryFn: () => agentsApi.get(agentId!),
    enabled: Boolean(agentId),
  });

  const readinessQuery = useQuery({
    queryKey: ['agents', agentId, 'capabilities', family],
    queryFn: async () => agentsApi.capabilityReadiness(agentId!, family!) as Promise<CapabilityReadiness>,
    enabled: Boolean(agentId && family),
  });

  const availableConnectionsQuery = useQuery({
    queryKey: ['capabilities', 'trading', 'connections'],
    queryFn: () => capabilitiesApi.tradingConnections(),
    enabled: family === 'trading',
  });

  const agentConnectionsQuery = useQuery({
    queryKey: ['agents', agentId, 'capabilities', 'trading', 'connections'],
    queryFn: () => agentsApi.tradingConnections(agentId!),
    enabled: Boolean(agentId) && family === 'trading',
  });

  const boundConnectionIds = useMemo(() => {
    return new Set(
      (agentConnectionsQuery.data?.connections ?? [])
        .filter((connection) => connection.grantStatus === 'active')
        .map((connection) => connection.connectionId),
    );
  }, [agentConnectionsQuery.data?.connections]);

  const updateConnectionsMutation = useMutation({
    mutationFn: (connectionIds: string[]) =>
      agentsApi.update(agentId!, { connectionIds }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['agents', agentId, 'capabilities', family] }),
        qc.invalidateQueries({ queryKey: ['agents', agentId, 'capabilities', 'trading', 'connections'] }),
        qc.invalidateQueries({ queryKey: ['agents', agentId] }),
        qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'connections'] }),
        qc.invalidateQueries({ queryKey: ['connections'] }),
      ]);
    },
  });

  if (!family) {
    return (
      <PageShell>
        <EmptyState title={intl.formatMessage({ id: 'agents.capabilityPage.notFound.title' })} message={intl.formatMessage({ id: 'agents.capabilityPage.notFound.routeMessage' })} />
      </PageShell>
    );
  }

  if (agentQuery.isLoading || readinessQuery.isLoading) {
    return <PageShell><LoadingRows count={4} /></PageShell>;
  }

  if (agentQuery.isError) {
    return <PageShell><ErrorState message={localizeApiError(intl, agentQuery.error, 'common.errorTitle')} onRetry={() => void agentQuery.refetch()} /></PageShell>;
  }

  if (readinessQuery.isError) {
    return <PageShell><ErrorState message={localizeApiError(intl, readinessQuery.error, 'common.errorTitle')} onRetry={() => void readinessQuery.refetch()} /></PageShell>;
  }

  const agent = agentQuery.data;
  const readiness = readinessQuery.data;

  if (!agent || !readiness) {
    return <PageShell><EmptyState title={intl.formatMessage({ id: 'agents.capabilityPage.notFound.title' })} message={intl.formatMessage({ id: 'agents.capabilityPage.notFound.message' })} /></PageShell>;
  }

  const capabilityFamilyLabel = formatCapabilityFamily(readiness.family ?? family, intl);
  const nextSteps = getCapabilityNextSteps(intl, readiness.family ?? family);

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'agents.capabilityPage.title' }, { capability: capabilityFamilyLabel })}
        subtitle={intl.formatMessage({ id: 'agents.capabilityPage.subtitle' }, { agent: agent.name })}
        action={<Button variant="ghost" onClick={() => navigate(`/agents/${agent.id}`)}>{intl.formatMessage({ id: 'agents.capabilityPage.backToAgent' })}</Button>}
      />

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '24px' }}>
        <StatusBadge status={agent.status} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
        <section aria-label={intl.formatMessage({ id: 'agents.summary.capabilityReadiness' })}>
          <Card>
            <div style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '12px' }}>{intl.formatMessage({ id: 'agents.capabilityPage.readiness' })}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <KV label={intl.formatMessage({ id: 'common.state' })} value={formatCapabilityState(readiness.state, intl)} />
              {readiness.state === 'unconfigured' && (
                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: '-8px', lineHeight: '1.4' }}>
                  {intl.formatMessage({ id: 'agents.capabilityState.unconfigured.tradingNote' })}
                </div>
              )}
              <KV label={intl.formatMessage({ id: 'agents.detail.connectionReadiness' })} value={formatCapabilityState(readiness.connectionReadiness, intl)} />
              <KV label={intl.formatMessage({ id: 'agents.detail.agentEligibility' })} value={intl.formatMessage({ id: `agents.eligibility.${readiness.agentEligibility}` })} />
              <KV label={intl.formatMessage({ id: 'agents.detail.effectiveReady' })} value={readiness.effectiveReady ? intl.formatMessage({ id: 'common.yes' }) : intl.formatMessage({ id: 'common.no' })} />
              <KV label={intl.formatMessage({ id: 'common.connection' })} value={readiness.connectionId ?? intl.formatMessage({ id: 'agents.detail.notAssigned' })} />
            </div>
          </Card>
        </section>

        <Card>
          <div style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '12px' }}>{intl.formatMessage({ id: 'agents.capabilityPage.whyThisState' })}</div>
          {readiness.reasons.length === 0 ? (
            <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>{intl.formatMessage({ id: 'agents.capabilityPage.readyForUse' })}</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: '18px', color: 'var(--color-text-secondary)', fontSize: '0.8125rem', lineHeight: '1.6' }}>
              {readiness.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          )}
        </Card>

        <Card>
          <div style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '12px' }}>{intl.formatMessage({ id: 'agents.capabilityPage.nextSteps' })}</div>
          {nextSteps.length === 0 ? (
            <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
              {intl.formatMessage({ id: 'agents.capabilityPage.noGuidedSetup' })}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {nextSteps.map((step) => (
                <Button key={step.label} variant={step.variant} onClick={() => navigate(step.path)}>{step.label}</Button>
              ))}
            </div>
          )}
        </Card>

        {family === 'trading' && (
          <Card>
            {bindError && (
              <div style={{ padding: '8px 12px', background: 'var(--color-surface-error, rgba(239,68,68,0.08))', borderRadius: '6px', fontSize: '0.8125rem', color: 'var(--color-text-error, #ef4444)', marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{bindError}</span>
                <button type="button" onClick={() => setBindError(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: '1rem', lineHeight: 1, padding: '0 4px' }}>×</button>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={{ fontSize: '0.875rem', fontWeight: '600' }}>{intl.formatMessage({ id: 'agents.capabilityPage.availableConnections' })}</div>
              <button
                type="button"
                onClick={() => { setShowAddConnection(true); setBindError(null); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--color-brand)', padding: '2px 4px' }}
              >
                {intl.formatMessage({ id: 'agents.capabilityPage.addConnection' })}
              </button>
            </div>
            {availableConnectionsQuery.isLoading || agentConnectionsQuery.isLoading ? (
              <LoadingRows count={2} />
            ) : availableConnectionsQuery.isError || agentConnectionsQuery.isError ? (
              <ErrorState
                message={String((availableConnectionsQuery.error as Error | undefined)?.message ?? (agentConnectionsQuery.error as Error | undefined)?.message ?? intl.formatMessage({ id: 'agents.capabilityPage.failedConnections' }))}
                onRetry={() => {
                  void availableConnectionsQuery.refetch();
                  void agentConnectionsQuery.refetch();
                }}
              />
            ) : (availableConnectionsQuery.data?.connections.length ?? 0) === 0 ? (
              <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                {intl.formatMessage({ id: 'agents.capabilityPage.noConnections' })}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {(availableConnectionsQuery.data?.connections ?? []).map((connection) => {
                  const isBound = boundConnectionIds.has(connection.connectionId);
                  const notReady = connection.status !== 'active';

                  return (
                    <div key={connection.connectionId} style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ fontSize: '0.875rem', fontWeight: '600' }}>{connection.label}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: '4px', lineHeight: '1.5' }}>
                            {intl.formatMessage({ id: 'agents.capabilityPage.connectionMeta' }, { provider: connection.provider, connectionStatus: connection.status, grantStatus: isBound ? connection.grantStatus ?? 'active' : '—' })}
                          </div>
                          {connection.providerRef && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '6px' }}>{intl.formatMessage({ id: 'agents.capabilityPage.reference' }, { reference: connection.providerRef })}</div>
                          )}
                        </div>
                        <Button
                          variant={isBound ? 'secondary' : 'primary'}
                          size="sm"
                          disabled={updateConnectionsMutation.isPending || (!isBound && notReady)}
                          onClick={() => {
                            const currentIds = [...boundConnectionIds];
                            const newIds = isBound
                              ? currentIds.filter((id) => id !== connection.connectionId)
                              : [...currentIds, connection.connectionId];
                            updateConnectionsMutation.mutate(newIds);
                          }}
                        >
                          {isBound ? intl.formatMessage({ id: 'agents.capabilityPage.unbind' }) : intl.formatMessage({ id: 'agents.capabilityPage.bind' })}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        )}
      </div>

      {family === 'trading' && readiness.effectiveReady && (
        <TradingCapabilityPresentation
          agentId={agent.id}
          agent={agent}
          connectionLabel={(agentConnectionsQuery.data?.connections ?? []).find((connection) => connection.connectionId === readiness.connectionId)?.label ?? null}
          connectionProvider={(agentConnectionsQuery.data?.connections ?? []).find((connection) => connection.connectionId === readiness.connectionId)?.provider ?? null}
          isActive={['active', 'starting', 'paused', 'unhealthy'].includes(agent.status)}
        />
      )}

      {family === 'trading' && !readiness.effectiveReady && (
        <Card>
          <EmptyState
            title={intl.formatMessage({ id: 'agents.summary.capabilityUnavailable' })}
            message={intl.formatMessage({ id: 'agents.capabilityPage.tradingUnavailable' })}
          />
        </Card>
      )}

      {showAddConnection && (
        <ProviderSetupForm
          defaultCapability="trading"
          onClose={() => setShowAddConnection(false)}
          onSuccess={(result) => {
            setShowAddConnection(false);
            void Promise.all([
              qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'connections'] }),
              qc.invalidateQueries({ queryKey: ['agents', agentId, 'capabilities', 'trading', 'connections'] }),
              qc.invalidateQueries({ queryKey: ['connections'] }),
            ]).then(async () => {
              // Auto-assign the new connection to this agent
              const currentIds = [...boundConnectionIds];
              if (!currentIds.includes(result.connection.id)) {
                try {
                  await agentsApi.update(agentId!, { connectionIds: [...currentIds, result.connection.id] });
                } catch (err) {
                  setBindError(intl.formatMessage({ id: 'agents.capabilityPage.bindFailed' }, { label: result.connection.label, error: (err as Error).message ?? 'Unknown error' }));
                }
                await Promise.all([
                  qc.invalidateQueries({ queryKey: ['agents', agentId, 'capabilities', family] }),
                  qc.invalidateQueries({ queryKey: ['agents', agentId, 'capabilities', 'trading', 'connections'] }),
                  qc.invalidateQueries({ queryKey: ['agents', agentId] }),
                  qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'connections'] }),
                  qc.invalidateQueries({ queryKey: ['connections'] }),
                ]);
              }
            });
          }}
        />
      )}
    </PageShell>
  );
}

function getCapabilityNextSteps(
  intl: ReturnType<typeof useIntl>,
  family: string,
): Array<{ label: string; path: string; variant: 'primary' | 'secondary' }> {
  if (family === 'trading') {
    return [
      { label: intl.formatMessage({ id: 'agents.capabilityPage.setupOnAgents' }), path: '/agents', variant: 'primary' },
    ];
  }

  return [
    { label: intl.formatMessage({ id: 'agents.capabilityPage.manageConnections' }), path: '/connections', variant: 'secondary' },
  ];
}