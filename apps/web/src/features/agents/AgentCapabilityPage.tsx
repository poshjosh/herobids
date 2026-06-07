import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { agents as agentsApi, type CapabilityReadiness } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button, StatusBadge, KV } from '../../lib/ui.js';
import { formatCapabilityFamily, formatCapabilityState, formatExecutionMode } from './agent-display.js';

export function AgentCapabilityPage() {
  const { agentId, family } = useParams<{ agentId: string; family: string }>();
  const navigate = useNavigate();

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

  if (!family) {
    return (
      <PageShell>
        <EmptyState title="Capability not found" message="No capability family was provided in the route." />
      </PageShell>
    );
  }

  if (agentQuery.isLoading || readinessQuery.isLoading) {
    return <PageShell><LoadingRows count={4} /></PageShell>;
  }

  if (agentQuery.isError) {
    return <PageShell><ErrorState message={(agentQuery.error as Error).message} onRetry={() => void agentQuery.refetch()} /></PageShell>;
  }

  if (readinessQuery.isError) {
    return <PageShell><ErrorState message={(readinessQuery.error as Error).message} onRetry={() => void readinessQuery.refetch()} /></PageShell>;
  }

  const agent = agentQuery.data;
  const readiness = readinessQuery.data;

  if (!agent || !readiness) {
    return <PageShell><EmptyState title="Capability not found" message="The selected agent or capability could not be loaded." /></PageShell>;
  }

  const capabilityFamilyLabel = formatCapabilityFamily(readiness.family ?? family);
  const nextSteps = getCapabilityNextSteps(readiness.family ?? family);

  return (
    <PageShell>
      <PageHeader
        title={`${capabilityFamilyLabel} capability`}
        subtitle={`Agent: ${agent.name}`}
        action={<Button variant="ghost" onClick={() => navigate(`/agents/${agent.id}`)}>Back to agent</Button>}
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
          {formatExecutionMode(agent.executionMode)} mode
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
        <Card>
          <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>Readiness</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <KV label="State" value={formatCapabilityState(readiness.state)} />
            <KV label="Binding readiness" value={formatCapabilityState(readiness.bindingReadiness)} />
            <KV label="Agent eligibility" value={readiness.agentEligibility} />
            <KV label="Effective ready" value={readiness.effectiveReady ? 'Yes' : 'No'} />
            <KV label="Binding" value={readiness.bindingId ?? 'Not assigned'} />
          </div>
        </Card>

        <Card>
          <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>Why this state</div>
          {readiness.reasons.length === 0 ? (
            <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>The capability is ready for use.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: '18px', color: 'var(--color-text-secondary)', fontSize: '13px', lineHeight: '1.6' }}>
              {readiness.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          )}
        </Card>

        <Card>
          <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>Next steps</div>
          {nextSteps.length === 0 ? (
            <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
              No guided setup actions are defined for this capability family yet. Use the readiness reasons and agent detail page to decide the next operator step.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {nextSteps.map((step) => (
                <Button key={step.label} variant={step.variant} onClick={() => navigate(step.path)}>{step.label}</Button>
              ))}
            </div>
          )}
        </Card>
      </div>
    </PageShell>
  );
}

function getCapabilityNextSteps(family: string): Array<{ label: string; path: string; variant: 'primary' | 'secondary' }> {
  if (family === 'trading') {
    return [
      { label: 'Manage connections', path: '/connections', variant: 'secondary' },
      { label: 'Manage credentials', path: '/credentials', variant: 'secondary' },
      { label: 'Open trading setup', path: '/venue-accounts', variant: 'primary' },
    ];
  }

  return [
    { label: 'Manage connections', path: '/connections', variant: 'secondary' },
    { label: 'Manage credentials', path: '/credentials', variant: 'secondary' },
  ];
}