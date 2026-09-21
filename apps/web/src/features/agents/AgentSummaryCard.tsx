import { useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, skills as skillsApi, type Agent } from '../../lib/api-client.js';
import { getRuntimeFamiliesForProvider } from '@herobids/domain';
import { Card, StatusBadge, RelativeTime, KV } from '../../lib/ui.js';
import { extractAgentObjective, formatCapabilityFamily, formatObjectivePreview, resolveCapabilityFamilies, resolveSelectedSkills } from './agent-display.js';

// ── Shared icon button style ───────────────────────────────────────────────

const ICON_BUTTON_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '32px',
  height: '32px',
  borderRadius: '6px',
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface-1)',
  color: 'var(--color-text-secondary)',
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'background 0.15s, color 0.15s',
};


interface AgentSummaryCardProps {
  agent: Agent;
  onOpen?: () => void;
}

export function AgentSummaryCard({ agent, onOpen }: AgentSummaryCardProps) {
  const navigate = useNavigate();
  const intl = useIntl();
  const qc = useQueryClient();
  const objective = extractAgentObjective(agent.prompt);
  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list({ scope: 'selectable' }),
  });
  const selectedSkills = resolveSelectedSkills(agent.skillIds, skillsQuery.data?.skills ?? []);
  const skillFamilies = resolveCapabilityFamilies(selectedSkills);
  const connectionsQuery = useQuery({
    queryKey: ['agents', agent.id, 'connections'],
    queryFn: () => agentsApi.getConnections(agent.id),
  });
  const connectionFamilies = resolveCapabilityFamilies(
    (connectionsQuery.data?.connections ?? []).map((connection) => ({
      capabilityFamilies: getRuntimeFamiliesForProvider(connection.provider),
    })),
  );
  const openAgent = onOpen ?? (() => navigate(`/agents/${agent.id}`));

  // ── Lifecycle mutations (same as agent detail page) ────────────────────

  const invalidateAgent = () => {
    void qc.invalidateQueries({ queryKey: ['agents', agent.id] });
    void qc.invalidateQueries({ queryKey: ['agents'] });
  };

  const startMutation = useMutation({
    mutationFn: () => agentsApi.start(agent.id),
    onSuccess: invalidateAgent,
  });

  const pauseMutation = useMutation({
    mutationFn: () => agentsApi.pause(agent.id, 'User paused from dashboard'),
    onSuccess: invalidateAgent,
  });

  const resumeMutation = useMutation({
    mutationFn: () => agentsApi.resume(agent.id),
    onSuccess: invalidateAgent,
  });

  const stopMutation = useMutation({
    mutationFn: () => agentsApi.stop(agent.id),
    onSuccess: invalidateAgent,
  });

  // ── Status-derived action visibility ───────────────────────────────────

  const canStart = agent.status === 'stopped' || agent.status === 'crashed';
  const canPause = agent.status === 'active' || agent.status === 'starting';
  const canResume = agent.status === 'paused';
  const canStop = ['active', 'paused', 'unhealthy', 'crashed'].includes(agent.status);
  const anyActionPending = startMutation.isPending || pauseMutation.isPending || resumeMutation.isPending || stopMutation.isPending;

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleAction = (e: React.MouseEvent, fn: () => void) => {
    e.stopPropagation();
    fn();
  };

  return (
    <Card
      className="agent-summary-card"
      style={{ display: 'flex', flexDirection: 'column', gap: '14px', position: 'relative' }}
      onClick={openAgent}
    >
      {/* ── Hover-reveal action icons ─────────────────────────────────── */}
      <div
        className="agent-summary-actions"
        style={{
          position: 'absolute',
          top: '12px',
          right: '12px',
          display: 'flex',
          gap: '6px',
          opacity: 0,
          transition: 'opacity 0.15s',
        }}
      >
        {/* Edit */}
        <button
          type="button"
          style={ICON_BUTTON_STYLE}
          title="Edit"
          disabled={anyActionPending}
          onClick={(e) => handleAction(e, () => navigate(`/agents/${agent.id}?edit=1`))}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          </svg>
        </button>

        {/* Start / Resume */}
        {(canStart || canResume) && (
          <button
            type="button"
            style={{ ...ICON_BUTTON_STYLE, color: 'var(--color-success)', borderColor: 'var(--color-success)' }}
            title="Start"
            disabled={anyActionPending}
            onClick={(e) => handleAction(e, () => (canStart ? startMutation : resumeMutation).mutate())}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </button>
        )}

        {/* Pause */}
        {canPause && (
          <button
            type="button"
            style={ICON_BUTTON_STYLE}
            title="Pause"
            disabled={anyActionPending}
            onClick={(e) => handleAction(e, () => pauseMutation.mutate())}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          </button>
        )}

        {/* Stop */}
        {canStop && (
          <button
            type="button"
            style={{ ...ICON_BUTTON_STYLE, color: 'var(--color-danger)', borderColor: 'var(--color-danger)' }}
            title="Stop"
            disabled={anyActionPending}
            onClick={(e) => handleAction(e, () => stopMutation.mutate())}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
            <span style={{ fontWeight: '600', fontSize: '0.9375rem', color: 'var(--color-text-primary)' }}>{agent.name}</span>
            <StatusBadge status={agent.status} />
          </div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
            {formatObjectivePreview(objective, 40)}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
          {skillsQuery.isLoading
            ? intl.formatMessage({ id: 'agents.summary.loadingSkills' })
            : skillsQuery.isError
              ? intl.formatMessage({ id: 'agents.summary.capabilityUnavailable' })
              : (
                <>
                  {intl.formatMessage({ id: 'agents.summary.skills' })}:{' '}
                  {skillFamilies.length > 0
                    ? skillFamilies.map((family) => formatCapabilityFamily(family, intl)).join(', ')
                    : intl.formatMessage({ id: 'agents.summary.none' })}
                </>
              )}
        </div>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
          {connectionsQuery.isLoading
            ? intl.formatMessage({ id: 'agents.summary.loadingConnections' })
            : connectionsQuery.isError
              ? intl.formatMessage({ id: 'agents.summary.capabilityUnavailable' })
              : (
                <>
                  {intl.formatMessage({ id: 'agents.summary.connections' })}:{' '}
                  {connectionFamilies.length > 0
                    ? connectionFamilies.map((family) => formatCapabilityFamily(family, intl)).join(', ')
                    : intl.formatMessage({ id: 'agents.summary.none' })}
                </>
              )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
        <KV label={intl.formatMessage({ id: 'common.created' })} value={<RelativeTime timestamp={agent.createdAt} />} />
        <KV label={intl.formatMessage({ id: 'common.updated' })} value={<RelativeTime timestamp={agent.updatedAt} />} />
      </div>

    </Card>
  );
}