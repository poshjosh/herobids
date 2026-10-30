import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, skills as skillsApi, type Agent } from '../../lib/api-client.js';
import { getRuntimeFamiliesForProvider } from '@herobids/domain';
import { Card, StatusBadge, RelativeTime, KV } from '../../lib/ui.js';
import { extractAgentObjective, formatCapabilityFamily, formatObjectivePreview, resolveCapabilityFamilies, resolveSelectedSkills } from './agent-display.js';
import type { CreatorLabel } from './agent-tree.js';
import { AgentQuickActions } from './AgentQuickActions.js';

/** Tree-only details. Omitted for the flat list, which renders exactly as before. */
export interface AgentHierarchyMeta {
  /** Shown as "Depth N" when set. */
  depth: number | null;
  creatorLabel: CreatorLabel | null;
  /** Pre-formatted allowance text, e.g. "2 of 5 children used". */
  allowanceLabel: string | null;
  /** Direct child count shown on parent rows, e.g. "2 children". */
  childCountLabel: string | null;
}

interface AgentSummaryCardProps {
  agent: Agent;
  onOpen?: () => void;
  hierarchy?: AgentHierarchyMeta;
}

export function AgentSummaryCard({ agent, onOpen, hierarchy }: AgentSummaryCardProps) {
  const navigate = useNavigate();
  const intl = useIntl();
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

  return (
    <Card
      className="agent-summary-card"
      style={{ display: 'flex', flexDirection: 'column', gap: '14px', position: 'relative' }}
      onClick={openAgent}
    >
      {/* ── Hover-reveal action icons (always shown on touch devices, see styles.css) ── */}
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
        <AgentQuickActions agentId={agent.id} status={agent.status} />
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
            <span style={{ fontWeight: '600', fontSize: '0.9375rem', color: 'var(--color-text-primary)' }}>{agent.name}</span>
            <StatusBadge status={agent.status} />
            {hierarchy?.depth != null && (
              <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                {intl.formatMessage({ id: 'agents.tree.depth' }, { depth: hierarchy.depth })}
              </span>
            )}
            {hierarchy?.childCountLabel && (
              <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                {hierarchy.childCountLabel}
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
            {formatObjectivePreview(objective, 40)}
          </div>
        </div>
      </div>

      {hierarchy?.creatorLabel && (
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
          {hierarchy.creatorLabel.kind === 'agent'
            ? intl.formatMessage({ id: 'agents.tree.createdBy' }, { name: hierarchy.creatorLabel.name })
            : intl.formatMessage({ id: 'agents.tree.createdByDeleted' })}
        </div>
      )}

      {hierarchy?.allowanceLabel && (
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
          {hierarchy.allowanceLabel}
        </div>
      )}

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