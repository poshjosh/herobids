import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, skills as skillsApi, type Agent, type AgentOutcomes, type CapabilityReadiness } from '../../lib/api-client.js';
import { Card, StatusBadge, RelativeTime, KV } from '../../lib/ui.js';
import { formatPnl, pnlColor } from '../../lib/formatting.js';
import { extractAgentObjective, formatExecutionMode, formatAuthorizationMode, formatCapabilityFamily, formatCapabilityState, formatObjectivePreview, hasCapabilityFamily, resolveSelectedSkills } from './agent-display.js';

interface AgentSummaryCardProps {
  agent: Agent;
  outcomes?: AgentOutcomes['outcomes'];
  onOpen?: () => void;
}

export function AgentSummaryCard({ agent, outcomes, onOpen }: AgentSummaryCardProps) {
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
            <span style={{ fontWeight: '600', fontSize: '0.9375rem', color: 'var(--color-text-primary)' }}>{agent.name}</span>
            <StatusBadge status={agent.status} />
            {hasTradingCapability && (
              <span
                style={{
                  padding: '3px 8px',
                  borderRadius: '20px',
                  background: 'var(--color-surface-2)',
                  fontSize: '0.75rem',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {intl.formatMessage({ id: 'agents.modeBadge' }, { mode: formatExecutionMode(agent.executionMode, intl) })}
              </span>
            )}
            {hasTradingCapability && agent.authorizationMode === 'approval_required' && (
              <span
                style={{
                  padding: '3px 8px',
                  borderRadius: '20px',
                  background: 'var(--color-warning-subtle)',
                  fontSize: '0.75rem',
                  color: 'var(--color-warning)',
                }}
              >
                {formatAuthorizationMode(agent.authorizationMode, intl)}
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
            {formatObjectivePreview(objective, 40)}
          </div>
        </div>

        {primaryCapability && (
          <section
            aria-label={intl.formatMessage({ id: 'agents.summary.capabilityReadinessAria' }, { capability: formatCapabilityFamily(primaryCapability.family, intl) })}
            style={{ minWidth: '180px', textAlign: 'right' }}
          >
            <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
              {intl.formatMessage({ id: 'agents.summary.capabilityReadiness' })}
            </div>
            <div style={{ fontSize: '0.875rem', fontWeight: '600', color: 'var(--color-text-primary)' }}>
              {formatCapabilityFamily(primaryCapability.family, intl)}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '2px' }}>
              {formatCapabilityState(primaryCapability.state, intl)}
            </div>
          </section>
        )}
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {skillsQuery.isLoading && (
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.summary.loadingSkills' })}</span>
        )}
        {skillsQuery.isError && (
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.summary.capabilityUnavailable' })}</span>
        )}
        {!skillsQuery.isLoading && !skillsQuery.isError && readinessQuery.isLoading && (
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.summary.checkingCapability' })}</span>
        )}
        {!skillsQuery.isLoading && !skillsQuery.isError && !readinessQuery.isLoading && !hasTradingCapability && (
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.summary.noCapabilitySetup' })}</span>
        )}
        {!skillsQuery.isLoading && !skillsQuery.isError && !readinessQuery.isLoading && primaryCapability && (
          <span
            style={{
              padding: '3px 8px',
              borderRadius: '20px',
              background: primaryCapability.effectiveReady ? 'var(--color-success-subtle)' : 'var(--color-warning-subtle)',
              color: primaryCapability.effectiveReady ? 'var(--color-success)' : 'var(--color-warning)',
              fontSize: '0.75rem',
            }}
          >
            {formatCapabilityFamily(primaryCapability.family, intl)}: {formatCapabilityState(primaryCapability.state, intl)}
          </span>
        )}
      </div>

      {outcomes?.trading && hasTradingCapability && (
        <div style={{ display: 'flex', gap: '16px', fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
          <span>
            {intl.formatMessage({ id: 'agents.summary.pnl' })}:{' '}
            <span style={{ color: pnlColor(outcomes.trading.totalRealizedPnl), fontWeight: '500' }}>
              {formatPnl(outcomes.trading.totalRealizedPnl)}
            </span>
          </span>
          <span>{intl.formatMessage({ id: 'agents.summary.tradeCount' }, { count: outcomes.trading.closedPositionCount })}</span>
          {outcomes.trading.closedPositionCount > 0 && (
            <span>{intl.formatMessage({ id: 'agents.summary.winRate' }, { rate: Math.round((outcomes.trading.winningClosedCount / outcomes.trading.closedPositionCount) * 100) })}</span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
        <KV label={intl.formatMessage({ id: 'common.created' })} value={<RelativeTime timestamp={agent.createdAt} />} />
        <KV label={intl.formatMessage({ id: 'common.updated' })} value={<RelativeTime timestamp={agent.updatedAt} />} />
        {hasTradingCapability && <KV label={intl.formatMessage({ id: 'agents.executionMode.label' })} value={formatExecutionMode(agent.executionMode, intl)} />}
        {hasTradingCapability && <KV label={intl.formatMessage({ id: 'agents.authorizationMode.label' })} value={formatAuthorizationMode(agent.authorizationMode, intl)} />}
      </div>

    </Card>
  );
}