import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, LoadingRows, ErrorState, Button, MetricCard } from '../../lib/ui.js';
import { BlueprintBrowse } from '../blueprints/BlueprintBrowse.js';
import { BlueprintInstantiateFlow } from '../blueprints/BlueprintInstantiateFlow.js';
import type { BlueprintSummary } from '../../lib/api-client.js';
import { AgentSummaryCard } from './AgentSummaryCard.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { useEventStream, type UserEvent } from '../../lib/useEventStream.js';

export function AgentsPage() {
  const [agentTab, setAgentTab] = useState<'my-agents' | 'marketplace'>('my-agents');
  const [selectedBlueprint, setSelectedBlueprint] = useState<BlueprintSummary | null>(null);
  const intl = useIntl();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
  });

  // ── Dashboard data (from Mission Control) ──────────────────────
  const handleEvent = useCallback((event: UserEvent) => {
    if (event.type === 'agent.status') {
      void qc.invalidateQueries({ queryKey: ['agents'] });
    }
  }, [qc]);
  useEventStream(handleEvent);

  const items = query.data ?? [];

  // New users (0 agents) are sent straight to the create form so they
  // can build their first agent without an empty list in the way.
  useEffect(() => {
    if (query.isSuccess && items.length === 0) {
      navigate('/agents/new', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.isSuccess, items.length]);

  const statusCounts = {
    active: items.filter((agent) => agent.status === 'active' || agent.status === 'starting').length,
    paused: items.filter((agent) => agent.status === 'paused').length,
    unhealthy: items.filter((agent) => agent.status === 'crashed' || agent.status === 'unhealthy').length,
    stopped: items.filter((agent) => agent.status === 'stopped').length,
  };

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'agents.title' })}
        action={
          <Button variant="primary" size="sm" onClick={() => navigate('/agents/new')}>
            {intl.formatMessage({ id: 'agents.create.title' })}
          </Button>
        }
      />

      {/* ── Tab bar ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '20px' }}>
        <Button
          variant={agentTab === 'my-agents' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setAgentTab('my-agents')}
        >
          My Agents
        </Button>
        <Button
          variant={agentTab === 'marketplace' ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setAgentTab('marketplace')}
        >
          Marketplace
        </Button>
      </div>

      {/* ── My Agents tab ───────────────────────────────────────── */}
      {agentTab === 'my-agents' && (
        <>
          {query.isLoading && <LoadingRows count={3} />}
          {query.isError && <ErrorState message={localizeApiError(intl, query.error, 'common.errorTitle')} onRetry={() => void query.refetch()} />}

          {/* ── Summary metrics ─────────────────────────────────────── */}
          {query.isSuccess && items.length > 0 && (
            <div className="metrics-summary-row">
              <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.active' })} value={statusCounts.active} total={items.length} />
              <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.paused' })} value={statusCounts.paused} />
              <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.unhealthy' })} value={statusCounts.unhealthy} />
              <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.stopped' })} value={statusCounts.stopped} />
            </div>
          )}

          {query.isSuccess && items.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {items.map((agent) => (
                <AgentSummaryCard key={agent.id} agent={agent} />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Marketplace tab ──────────────────────────────────────── */}
      {agentTab === 'marketplace' && (
        <BlueprintBrowse
          defaultKind="agent"
          hideKindFilter
          onUseBlueprint={setSelectedBlueprint}
        />
      )}

      {/* ── Blueprint instantiate flow ────────────────────────────── */}
      {selectedBlueprint && (
        <BlueprintInstantiateFlow
          blueprint={selectedBlueprint}
          onClose={() => setSelectedBlueprint(null)}
          onCreated={(actorId) => {
            setSelectedBlueprint(null);
            setAgentTab('my-agents');
            void qc.invalidateQueries({ queryKey: ['agents'] });
            navigate(`/agents/${actorId}`);
          }}
        />
      )}

    </PageShell>
  );
}
