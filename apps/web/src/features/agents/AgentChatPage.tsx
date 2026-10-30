import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, LoadingRows, ErrorState, Button } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { useEventStream, type UserEvent } from '../../lib/useEventStream.js';
import { AgentConversation } from './AgentConversation.js';

/** The agent's chat. Details, configuration and runtime panels live on the details page. */
export function AgentChatPage() {
  const { id } = useParams<{ id: string }>();
  const intl = useIntl();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();

  // Set when returning from an approved connection request; read once so stripping the param does not reset the conversation.
  const [connectionRequestId] = useState(() => new URLSearchParams(location.search).get('connected'));
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has('connected')) return;
    params.delete('connected');
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true });
  }, [location.pathname, location.search, navigate]);

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
        title={agent.name}
        action={
          <Button variant="secondary" onClick={() => navigate(`/agents/${agent.id}/details`)}>
            {intl.formatMessage({ id: 'agentDetail.chat.details' })}
          </Button>
        }
      />
      <AgentConversation key={id} agentId={id ?? ''} agentName={agent.name} status={agent.status} connectionRequestId={connectionRequestId} />
    </PageShell>
  );
}
