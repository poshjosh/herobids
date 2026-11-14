import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, LoadingRows, ErrorState, Button, MetricCard, inputStyle } from '../../lib/ui.js';
import { AgentHierarchyList } from './AgentHierarchyList.js';
import { AgentConversation, isAgentConversable } from './AgentConversation.js';
import { AgentQuickActions } from './AgentQuickActions.js';
import { CHAT_AGENT_PARAM, CHAT_CONNECTED_PARAM } from './agent-chat-path.js';
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

function rememberChatAgent(id: string): void {
  try {
    localStorage.setItem(CHAT_AGENT_STORAGE_KEY, id);
  } catch {
    // Storage unavailable: the selection still applies for this visit.
  }
}

/** The single home of the agent chat: pick an agent, chat with it, and see all agents below. */
export function AgentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
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
  // Set when a link asked for a specific agent's chat. The chat scrolls into view once it renders.
  const [scrollToChat, setScrollToChat] = useState(false);
  const [connectionRequest, setConnectionRequest] = useState<{ agentId: string; requestId: string } | null>(null);
  const chatSectionRef = useRef<HTMLElement>(null);
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

  // New users (0 agents) get the guided onboarding chat. Waits for any refetch
  // so a just-created agent is not mistaken for an empty list.
  useEffect(() => {
    if (query.isSuccess && !query.isFetching && items.length === 0) {
      navigate('/onboarding', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.isSuccess, query.isFetching, items.length]);

  // `?agent=<id>` opens that agent's chat (after creating it, or from its card).
  // The choice is remembered like a dropdown pick, then the parameters are removed.
  // `&connected=<requestId>` lets that chat follow an approved connection request.
  const requestedAgentId = searchParams.get(CHAT_AGENT_PARAM);
  const requestedConnectionId = searchParams.get(CHAT_CONNECTED_PARAM);
  useEffect(() => {
    if (!requestedAgentId) return;
    setChatAgentId(requestedAgentId);
    rememberChatAgent(requestedAgentId);
    setConnectionRequest(requestedConnectionId ? { agentId: requestedAgentId, requestId: requestedConnectionId } : null);
    setScrollToChat(true);
    setSearchParams((params) => {
      params.delete(CHAT_AGENT_PARAM);
      params.delete(CHAT_CONNECTED_PARAM);
      return params;
    }, { replace: true });
  }, [requestedAgentId, requestedConnectionId, setSearchParams]);

  // Preselects the last agent chatted with, else the first running agent, else the first agent.
  const chatAgent = items.find((agent) => agent.id === chatAgentId)
    ?? items.find((agent) => isAgentConversable(agent.status))
    ?? items[0]
    ?? null;

  useEffect(() => {
    if (!scrollToChat || !chatSectionRef.current) return;
    // jsdom has no scrollIntoView.
    chatSectionRef.current.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    setScrollToChat(false);
  }, [scrollToChat, chatAgent?.id]);

  const selectChatAgent = (id: string) => {
    setChatAgentId(id);
    rememberChatAgent(id);
    // The approved request belongs to the visit the link opened; coming back to that agent later must not replay it.
    setConnectionRequest(null);
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
      {items.length > 0 && (
        <section ref={chatSectionRef} style={{ marginBottom: '24px', scrollMarginTop: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'nowrap', marginBottom: '12px' }}>
            <label htmlFor="agents-chat-select" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>{intl.formatMessage({ id: 'agents.chat.selectAgent' })}</label>
            <select
              id="agents-chat-select"
              value={chatAgent?.id ?? ''}
              onChange={(event) => selectChatAgent(event.target.value)}
              style={{ ...inputStyle, width: 'auto', flex: '1 1 0', minWidth: 0, maxWidth: '100%' }}
            >
              {items.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </div>
          {chatAgent && (
            <AgentConversation
              key={chatAgent.id}
              agentId={chatAgent.id}
              agentName={chatAgent.name}
              status={chatAgent.status}
              connectionRequestId={connectionRequest?.agentId === chatAgent.id ? connectionRequest.requestId : null}
              composerActions={<AgentQuickActions agentId={chatAgent.id} status={chatAgent.status} />}
              initialDraft={chatDrafts[chatAgent.id] ?? ''}
              onDraftChange={(value) => setChatDrafts((drafts) => ({ ...drafts, [chatAgent.id]: value }))}
            />
          )}
        </section>
      )}

      {/* ── My agents ───────────────────────────────────────────── */}
      <section>
        <h2 style={{ margin: '0 0 12px', fontSize: '1rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
          {intl.formatMessage({ id: 'agents.myAgents' })}
        </h2>

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
                  style={{ ...inputStyle, background: '#E4E7EC', color: 'var(--brand-primary)' }}
                />
              </div>
            )}
            <AgentHierarchyList agents={items} searchQuery={showSearch ? searchQuery : ''} />
          </div>
        )}
      </section>
    </PageShell>
  );
}
