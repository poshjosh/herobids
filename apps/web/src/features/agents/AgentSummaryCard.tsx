import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { agents as agentsApi, skills as skillsApi, type Agent, type CapabilityReadiness } from '../../lib/api-client.js';
import { Card, Button, StatusBadge, RelativeTime, KV } from '../../lib/ui.js';
import { extractAgentObjective, formatExecutionMode, formatCapabilityFamily, formatCapabilityState, hasCapabilityFamily, resolveSelectedSkills } from './agent-display.js';

interface AgentSummaryCardProps {
  agent: Agent;
  onOpen?: () => void;
  onOpenCapability?: (family: string) => void;
}

export function AgentSummaryCard({ agent, onOpen, onOpenCapability }: AgentSummaryCardProps) {
  const navigate = useNavigate();
  const objective = extractAgentObjective(agent.prompt);
  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list(),
  });
  const selectedSkills = resolveSelectedSkills(agent.skillIds, skillsQuery.data?.skills ?? []);
  const hasTradingCapability = hasCapabilityFamily(selectedSkills, 'trading');
  const readinessQuery = useQuery({
    queryKey: ['agents', agent.id, 'capability-readiness', 'trading'],
    queryFn: async () => agentsApi.capabilityReadiness(agent.id, 'trading') as Promise<CapabilityReadiness>,
    enabled: hasTradingCapability,
  });

  const primaryCapability = readinessQuery.data;
  const openAgent = onOpen ?? (() => navigate(`/agents/${agent.id}`));
  const openCapability = (family: string) => {
    if (onOpenCapability) {
      onOpenCapability(family);
      return;
    }

    navigate(`/agents/${agent.id}/capabilities/${family}`);
  };

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
            <span style={{ fontWeight: '600', fontSize: '15px', color: 'var(--color-text-primary)' }}>{agent.name}</span>
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
          <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
            {objective}
          </div>
        </div>

        {primaryCapability && (
          <section aria-label={`${formatCapabilityFamily(primaryCapability.family)} capability readiness`} style={{ minWidth: '180px', textAlign: 'right' }}>
            <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
              Capability readiness
            </div>
            <div style={{ fontSize: '14px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
              {formatCapabilityFamily(primaryCapability.family)}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
              {formatCapabilityState(primaryCapability.state)}
            </div>
          </section>
        )}
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {skillsQuery.isLoading && (
          <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Loading skills...</span>
        )}
        {skillsQuery.isError && (
          <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Capability information unavailable</span>
        )}
        {!skillsQuery.isLoading && !skillsQuery.isError && readinessQuery.isLoading && (
          <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Checking capability readiness...</span>
        )}
        {!skillsQuery.isLoading && !skillsQuery.isError && !readinessQuery.isLoading && !hasTradingCapability && (
          <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>No capability setup required</span>
        )}
        {!skillsQuery.isLoading && !skillsQuery.isError && !readinessQuery.isLoading && primaryCapability && (
          <span
            style={{
              padding: '3px 8px',
              borderRadius: '20px',
              background: primaryCapability.effectiveReady ? 'var(--color-success-subtle)' : 'var(--color-warning-subtle)',
              color: primaryCapability.effectiveReady ? 'var(--color-success)' : 'var(--color-warning)',
              fontSize: '12px',
            }}
          >
            {formatCapabilityFamily(primaryCapability.family)}: {formatCapabilityState(primaryCapability.state)}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
        <KV label="Created" value={<RelativeTime timestamp={agent.createdAt} />} />
        <KV label="Updated" value={<RelativeTime timestamp={agent.updatedAt} />} />
        <KV label="Execution mode" value={formatExecutionMode(agent.executionMode)} />
      </div>

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <Button variant="secondary" onClick={openAgent}>Open agent</Button>
        {primaryCapability && (
          <Button
            variant={primaryCapability.effectiveReady ? 'secondary' : 'primary'}
            onClick={() => openCapability(primaryCapability.family)}
          >
            {primaryCapability.effectiveReady
              ? `Open ${formatCapabilityFamily(primaryCapability.family).toLowerCase()} capability`
              : `Configure ${formatCapabilityFamily(primaryCapability.family).toLowerCase()} capability`}
          </Button>
        )}
      </div>
    </Card>
  );
}