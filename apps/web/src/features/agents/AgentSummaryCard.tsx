import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, skills as skillsApi, type Agent, type AgentPerformance, type CapabilityReadiness } from '../../lib/api-client.js';
import { Card, StatusBadge, RelativeTime, KV } from '../../lib/ui.js';
import { formatPnl, pnlColor } from '../../lib/formatting.js';
import { extractAgentObjective, formatExecutionMode, formatCapabilityFamily, formatCapabilityState, formatObjectivePreview, hasCapabilityFamily, resolveSelectedSkills } from './agent-display.js';

interface AgentSummaryCardProps {
  agent: Agent;
  performance?: AgentPerformance;
  onOpen?: () => void;
}

export function AgentSummaryCard({ agent, performance, onOpen }: AgentSummaryCardProps) {
  const navigate = useNavigate();
  const intl = useIntl();
  const objective = extractAgentObjective(agent.prompt);
  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list({ scope: 'selectable' }),
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

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: '14px' }} onClick={openAgent}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
            <span style={{ fontWeight: '600', fontSize: '15px', color: 'var(--color-text-primary)' }}>{agent.name}</span>
            <StatusBadge status={agent.status} />
            {hasTradingCapability && (
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
            )}
          </div>
          <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
            {formatObjectivePreview(objective)}
          </div>
        </div>

        {primaryCapability && (
          <section
            aria-label={intl.formatMessage({ id: 'agents.summary.capabilityReadinessAria' }, { capability: formatCapabilityFamily(primaryCapability.family, intl) })}
            style={{ minWidth: '180px', textAlign: 'right' }}
          >
            <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
              {intl.formatMessage({ id: 'agents.summary.capabilityReadiness' })}
            </div>
            <div style={{ fontSize: '14px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
              {formatCapabilityFamily(primaryCapability.family, intl)}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
              {formatCapabilityState(primaryCapability.state, intl)}
            </div>
          </section>
        )}
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {skillsQuery.isLoading && (
          <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.summary.loadingSkills' })}</span>
        )}
        {skillsQuery.isError && (
          <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.summary.capabilityUnavailable' })}</span>
        )}
        {!skillsQuery.isLoading && !skillsQuery.isError && readinessQuery.isLoading && (
          <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.summary.checkingCapability' })}</span>
        )}
        {!skillsQuery.isLoading && !skillsQuery.isError && !readinessQuery.isLoading && !hasTradingCapability && (
          <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.summary.noCapabilitySetup' })}</span>
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
            {formatCapabilityFamily(primaryCapability.family, intl)}: {formatCapabilityState(primaryCapability.state, intl)}
          </span>
        )}
      </div>

      {performance && (
        <div style={{ display: 'flex', gap: '16px', fontSize: '13px', color: 'var(--color-text-secondary)' }}>
          <span>
            P&L:{' '}
            <span style={{ color: pnlColor(performance.totalRealizedPnl), fontWeight: '500' }}>
              {formatPnl(performance.totalRealizedPnl)}
            </span>
          </span>
          <span>{performance.closedPositionCount} trades</span>
          {performance.closedPositionCount > 0 && (
            <span>Win: {((performance.winningClosedCount / performance.closedPositionCount) * 100).toFixed(0)}%</span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
        <KV label={intl.formatMessage({ id: 'common.created' })} value={<RelativeTime timestamp={agent.createdAt} />} />
        <KV label={intl.formatMessage({ id: 'common.updated' })} value={<RelativeTime timestamp={agent.updatedAt} />} />
        {hasTradingCapability && <KV label={intl.formatMessage({ id: 'agents.executionMode.label' })} value={formatExecutionMode(agent.executionMode, intl)} />}
      </div>

    </Card>
  );
}