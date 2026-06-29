import { useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, capabilities as capabilitiesApi, type CapabilityReadiness } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button, StatusBadge, KV } from '../../lib/ui.js';
import { formatCapabilityFamily, formatCapabilityState, formatExecutionMode } from './agent-display.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

export function AgentCapabilityPage() {
  const { agentId, family } = useParams<{ agentId: string; family: string }>();
  const intl = useIntl();
  const navigate = useNavigate();
  const qc = useQueryClient();

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

  const bindMutation = useMutation({
    mutationFn: ({ connectionId, action }: { connectionId: string; action: 'bind' | 'unbind' }) =>
      agentsApi.tradingAction(agentId!, action, { connectionId }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['agents', agentId, 'capabilities', family] }),
        qc.invalidateQueries({ queryKey: ['agents', agentId, 'capabilities', 'trading', 'connections'] }),
        qc.invalidateQueries({ queryKey: ['agents', agentId] }),
        qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'connections'] }),
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
  const boundConnectionIds = new Set(
    (agentConnectionsQuery.data?.connections ?? [])
      .filter((connection) => connection.grantStatus === 'active')
      .map((connection) => connection.connectionId),
  );

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'agents.capabilityPage.title' }, { capability: capabilityFamilyLabel })}
        subtitle={intl.formatMessage({ id: 'agents.capabilityPage.subtitle' }, { agent: agent.name })}
        action={<Button variant="ghost" onClick={() => navigate(`/agents/${agent.id}`)}>{intl.formatMessage({ id: 'agents.capabilityPage.backToAgent' })}</Button>}
      />

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '24px' }}>
        <StatusBadge status={agent.status} />
        <span
          style={{
            padding: '3px 8px',
            borderRadius: '20px',
            background: 'var(--color-surface-2)',
            fontSize: '12px',
            color: 'var(--color-text-secondary)',
          }}
        >
          {intl.formatMessage({ id: 'agents.modeBadge' }, { mode: formatExecutionMode(agent.executionMode, intl) })}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
        <section aria-label={intl.formatMessage({ id: 'agents.summary.capabilityReadiness' })}>
          <Card>
            <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>{intl.formatMessage({ id: 'agents.capabilityPage.readiness' })}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <KV label={intl.formatMessage({ id: 'common.state' })} value={formatCapabilityState(readiness.state, intl)} />
              <KV label={intl.formatMessage({ id: 'agents.detail.connectionReadiness' })} value={formatCapabilityState(readiness.connectionReadiness, intl)} />
              <KV label={intl.formatMessage({ id: 'agents.detail.agentEligibility' })} value={intl.formatMessage({ id: `agents.eligibility.${readiness.agentEligibility}` })} />
              <KV label={intl.formatMessage({ id: 'agents.detail.effectiveReady' })} value={readiness.effectiveReady ? intl.formatMessage({ id: 'common.yes' }) : intl.formatMessage({ id: 'common.no' })} />
              <KV label={intl.formatMessage({ id: 'common.connection' })} value={readiness.connectionId ?? intl.formatMessage({ id: 'agents.detail.notAssigned' })} />
            </div>
          </Card>
        </section>

        <Card>
          <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>{intl.formatMessage({ id: 'agents.capabilityPage.whyThisState' })}</div>
          {readiness.reasons.length === 0 ? (
            <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>{intl.formatMessage({ id: 'agents.capabilityPage.readyForUse' })}</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: '18px', color: 'var(--color-text-secondary)', fontSize: '13px', lineHeight: '1.6' }}>
              {readiness.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          )}
        </Card>

        <Card>
          <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>{intl.formatMessage({ id: 'agents.capabilityPage.nextSteps' })}</div>
          {nextSteps.length === 0 ? (
            <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
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
            <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>{intl.formatMessage({ id: 'agents.capabilityPage.availableConnections' })}</div>
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
              <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                {intl.formatMessage({ id: 'agents.capabilityPage.noConnections' })}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {(availableConnectionsQuery.data?.connections ?? []).map((connection) => {
                  const isBound = boundConnectionIds.has(connection.connectionId);
                  const notReady = connection.status !== 'active' || connection.connectionStatus !== 'active';

                  return (
                    <div key={connection.connectionId} style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ fontSize: '14px', fontWeight: '600' }}>{connection.label}</div>
                          <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginTop: '4px', lineHeight: '1.5' }}>
                            {intl.formatMessage({ id: 'agents.capabilityPage.bindingMeta' }, { provider: connection.provider, connectionStatus: connection.connectionStatus, bindingStatus: connection.status ?? 'active' })}
                          </div>
                          {connection.providerRef && (
                            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '6px' }}>{intl.formatMessage({ id: 'agents.capabilityPage.reference' }, { reference: connection.providerRef })}</div>
                          )}
                        </div>
                        <Button
                          variant={isBound ? 'secondary' : 'primary'}
                          size="sm"
                          disabled={bindMutation.isPending || (!isBound && notReady)}
                          onClick={() => bindMutation.mutate({ connectionId: connection.connectionId, action: isBound ? 'unbind' : 'bind' })}
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
    </PageShell>
  );
}

function getCapabilityNextSteps(
  intl: ReturnType<typeof useIntl>,
  family: string,
): Array<{ label: string; path: string; variant: 'primary' | 'secondary' }> {
  if (family === 'trading') {
    return [
      { label: intl.formatMessage({ id: 'agents.capabilityPage.setupOnMissionControl' }), path: '/mission-control', variant: 'primary' },
    ];
  }

  return [
    { label: intl.formatMessage({ id: 'agents.capabilityPage.manageConnections' }), path: '/connections', variant: 'secondary' },
    { label: intl.formatMessage({ id: 'agents.capabilityPage.manageCredentials' }), path: '/credentials', variant: 'secondary' },
  ];
}