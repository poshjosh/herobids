import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, LoadingRows, ErrorState, Button, MetricCard, inputStyle } from '../../lib/ui.js';
import { BlueprintBrowse } from '../blueprints/BlueprintBrowse.js';
import { BlueprintInstantiateFlow } from '../blueprints/BlueprintInstantiateFlow.js';
import type { BlueprintSummary } from '../../lib/api-client.js';
import { AgentHierarchyList } from './AgentHierarchyList.js';
import { AgentConversation, isAgentConversable } from './AgentConversation.js';
import { NotificationsBlock } from '../notifications/NotificationsBlock.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { useEventStream, type UserEvent } from '../../lib/useEventStream.js';

/** The agent last chatted with from the agents page. */
const CHAT_AGENT_STORAGE_KEY = 'agents-page-chat-agent';

/** The search box appears only when there are more agents than these thresholds. */
const SEARCH_MIN_AGENTS_MOBILE = 2;
const SEARCH_MIN_AGENTS_DESKTOP = 5;
const MOBILE_QUERY = '(max-width: 640px)';

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return isMobile;
}

export function AgentsPage() {
  const [agentTab, setAgentTab] = useState<'my-agents' | 'marketplace'>('my-agents');
  const [chatAgentId, setChatAgentId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CHAT_AGENT_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  // Unsent text per agent, kept while another agent is selected.
  const [chatDrafts, setChatDrafts] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState('');
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
  const isMobile = useIsMobile();
  const showSearch = items.length > (isMobile ? SEARCH_MIN_AGENTS_MOBILE : SEARCH_MIN_AGENTS_DESKTOP);

  // New users (0 agents) are sent straight to the create form so they
  // can build their first agent without an empty list in the way.
  useEffect(() => {
    if (query.isSuccess && items.length === 0) {
      navigate('/agents/new', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.isSuccess, items.length]);

  // Falls back to the first running agent when nothing is remembered or the remembered agent no longer exists.
  const chatAgent = items.find((agent) => agent.id === chatAgentId)
    ?? items.find((agent) => isAgentConversable(agent.status))
    ?? items[0];

  const selectChatAgent = (id: string) => {
    setChatAgentId(id);
    try {
      localStorage.setItem(CHAT_AGENT_STORAGE_KEY, id);
    } catch {
      // Storage unavailable: the selection still applies for this visit.
    }
  };

  const statusCounts = {
    active: items.filter((agent) => agent.status === 'active' || agent.status === 'starting').length,
    paused: items.filter((agent) => agent.status === 'paused').length,
    unhealthy: items.filter((agent) => agent.status === 'crashed' || agent.status === 'unhealthy').length,
    stopped: items.filter((agent) => agent.status === 'stopped').length,
  };

  return (
    <PageShell>
      <NotificationsBlock variant="page" style={{ marginBottom: '20px' }} />

      <PageHeader
        title={intl.formatMessage({ id: 'agents.title' })}
        action={
          <Button variant="primary" size="sm" onClick={() => navigate('/agents/new')}>
            {intl.formatMessage({ id: 'agents.create.title' })}
          </Button>
        }
      />

      {/* ── Chat with an agent ──────────────────────────────────── */}
      {chatAgent && (
        <section style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
            <select
              id="agents-chat-select"
              aria-label={intl.formatMessage({ id: 'agents.chat.selectAgent' })}
              value={chatAgent.id}
              onChange={(event) => selectChatAgent(event.target.value)}
              style={inputStyle}
            >
              {items.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </div>
          <AgentConversation
            key={chatAgent.id}
            agentId={chatAgent.id}
            agentName={chatAgent.name}
            status={chatAgent.status}
            initialDraft={chatDrafts[chatAgent.id] ?? ''}
            onDraftChange={(value) => setChatDrafts((drafts) => ({ ...drafts, [chatAgent.id]: value }))}
          />
        </section>
      )}

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
            <details style={{ marginBottom: '16px' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, marginBottom: '12px' }}>
                {intl.formatMessage({ id: 'agents.statusOverview' })}
              </summary>
              <div className="metrics-summary-row">
                <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.active' })} value={statusCounts.active} total={items.length} />
                <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.paused' })} value={statusCounts.paused} />
                <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.unhealthy' })} value={statusCounts.unhealthy} />
                <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.stopped' })} value={statusCounts.stopped} />
              </div>
            </details>
          )}

          {query.isSuccess && items.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {showSearch && (
                <div className="search-half-row">
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder={intl.formatMessage({ id: 'agents.tree.search' })}
                    aria-label={intl.formatMessage({ id: 'agents.tree.search' })}
                    style={inputStyle}
                  />
                </div>
              )}
              <AgentHierarchyList agents={items} searchQuery={showSearch ? searchQuery : ''} />
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
