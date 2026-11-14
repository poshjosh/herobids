import { useCallback } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, LoadingRows, ErrorState, Button } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { useEventStream, type UserEvent } from '../../lib/useEventStream.js';
import { AgentDetails } from './AgentDetailPage.js';
import { agentChatPath } from './agent-chat-path.js';

/** The agent's settings: configuration, capabilities and runtime panels. The chat lives on the agents page. */
export function AgentSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const intl = useIntl();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const handleEvent = useCallback((event: UserEvent) => {
    if (event.type === 'agent.status' && event.agentId === id) {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    }
  }, [id, qc]);
  useEventStream(handleEvent);

  const query = useQuery({
    queryKey: ['agents', id],
    queryFn: () => agentsApi.get(id!),
    enabled: !!id,
    refetchInterval: 30_000,
  });

  if (query.isLoading) return <PageShell><LoadingRows count={3} /></PageShell>;
  if (query.isError) return <PageShell><ErrorState message={localizeApiError(intl, query.error, 'common.errorTitle')} onRetry={() => void query.refetch()} /></PageShell>;

  const agent = query.data;
  if (!agent) return <PageShell><ErrorState message={intl.formatMessage({ id: 'agents.detail.notFound' })} /></PageShell>;

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'agents.settings.title' }, { name: agent.name })}
        action={
          <Button variant="primary" size="sm" onClick={() => navigate(agentChatPath(agent.id))}>
            {intl.formatMessage({ id: 'agents.settings.backToChat' })}
          </Button>
        }
      />
      <AgentDetails agentId={agent.id} />
    </PageShell>
  );
}

/** Keeps old `/agents/:id/details` links working by sending them to the settings page, query string included. */
export function AgentDetailsRedirect() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  return <Navigate to={{ pathname: `/agents/${id}`, search: location.search }} replace />;
}
