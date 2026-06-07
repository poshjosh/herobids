import { useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { agents as agentsApi, type AgentOutboundMessage, type AgentArtifact } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, ErrorBanner, Button, StatusBadge, RelativeTime, KV } from '../../lib/ui.js';
import { EditAgentModal } from './EditAgentModal.js';
import { useEventStream, type UserEvent } from '../../lib/useEventStream.js';

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);

  // Invalidate agent data when a real-time status event arrives for this agent
  const handleEvent = useCallback((event: UserEvent) => {
    if (event.type === 'agent.status' && event.agentId === id) {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    } else if (event.type === 'bot.status' && event.botId === id) {
      // A bot under this agent changed status — refresh activity
      void qc.invalidateQueries({ queryKey: ['agents', id, 'activity'] });
    }
  }, [id, qc]);
  useEventStream(handleEvent);

  const query = useQuery({
    queryKey: ['agents', id],
    queryFn: () => agentsApi.get(id!),
    enabled: !!id,
    refetchInterval: 30_000, // reduced from 5 s — WebSocket handles real-time updates
  });

  const startMutation = useMutation({
    mutationFn: () => agentsApi.start(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: () => agentsApi.pause(id!, 'User paused from UI'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: () => agentsApi.resume(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => agentsApi.stop(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => agentsApi.delete(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      navigate('/agents');
    },
  });

  const activityQuery = useQuery({
    queryKey: ['agents', id, 'activity'],
    queryFn: () => agentsApi.activity(id!, 20),
    enabled: !!id,
  });

  const messagesQuery = useQuery({
    queryKey: ['agents', id, 'messages'],
    queryFn: () => agentsApi.messages(id!, 20),
    enabled: !!id,
  });

  const artifactsQuery = useQuery({
    queryKey: ['agents', id, 'artifacts'],
    queryFn: () => agentsApi.artifacts(id!, 10),
    enabled: !!id,
  });

  const sessionsQuery = useQuery({
    queryKey: ['agents', id, 'sessions'],
    queryFn: () => agentsApi.sessions(id!),
    enabled: !!id,
  });

  if (query.isLoading) return <PageShell><LoadingRows count={5} /></PageShell>;
  if (query.isError) return <PageShell><ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} /></PageShell>;

  const agent = query.data;
  if (!agent) return <PageShell><ErrorState message="Agent not found" /></PageShell>;

  const lifecycleError = startMutation.error ?? pauseMutation.error ?? resumeMutation.error ?? stopMutation.error ?? deleteMutation.error;
  const canStop = ['active', 'starting', 'paused', 'unhealthy'].includes(agent.status);
  const runtimeAlert = agent.status === 'crashed'
    ? 'Agent crashed. The runtime stopped unexpectedly. Review recent activity and messages below.'
    : agent.activeSession?.status === 'unhealthy'
      ? 'Agent runtime is unhealthy. Heartbeats are missing and the worker is recovering.'
      : null;

  return (
    <PageShell>
      <PageHeader
        title={agent.name}
        subtitle={agent.prompt}
        action={
          <div style={{ display: 'flex', gap: '8px' }}>
            {(agent.status === 'stopped' || agent.status === 'crashed') && (
              <Button variant="secondary" onClick={() => setIsEditing(true)}>
                Edit config
              </Button>
            )}
            {agent.status === 'stopped' && (
              <Button variant="primary" onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
                {startMutation.isPending ? 'Starting...' : 'Start'}
              </Button>
            )}
            {agent.status === 'active' && (
              <Button variant="secondary" onClick={() => pauseMutation.mutate()} disabled={pauseMutation.isPending}>
                Pause
              </Button>
            )}
            {agent.status === 'paused' && (
              <Button variant="primary" onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending}>
                Resume
              </Button>
            )}
            {canStop && (
              <Button variant="danger" onClick={() => stopMutation.mutate()} disabled={stopMutation.isPending}>
                {stopMutation.isPending ? 'Stopping...' : 'Stop'}
              </Button>
            )}
            {(agent.status === 'stopped' || agent.status === 'crashed') && (
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm('Delete this agent? This cannot be undone. Any running session will be stopped.')) {
                    deleteMutation.mutate();
                  }
                }}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
              </Button>
            )}
          </div>
        }
      />

      {isEditing && (
        <EditAgentModal
          agentId={id!}
          onClose={() => setIsEditing(false)}
          initialData={agent}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {runtimeAlert && <ErrorBanner message={runtimeAlert} />}
        {lifecycleError && <ErrorBanner message={(lifecycleError as Error).message} />}

        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>Status</h3>
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
            <KV label="Status" value={<StatusBadge status={agent.status} />} />
            <KV label="Created" value={<RelativeTime timestamp={agent.createdAt} />} />
            <KV label="Updated" value={<RelativeTime timestamp={agent.updatedAt} />} />
          </div>
        </Card>

        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>Objective</h3>
          <p style={{ margin: '0 0 12px', fontSize: '13px', lineHeight: '1.5' }}>{agent.prompt}</p>
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
            {agent.activeSession?.startedAt && (
              <KV label="Active since" value={<RelativeTime timestamp={agent.activeSession.startedAt} />} />
            )}
            {sessionsQuery.isSuccess && (
              <KV
                label="Sessions run"
                value={String((sessionsQuery.data as unknown[]).length)}
              />
            )}
          </div>
        </Card>

        {agent.activeSession && (
          <Card>
            <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>Runtime Health</h3>
            <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
              <KV label="Session" value={agent.activeSession.id.slice(0, 8)} />
              <KV label="Status" value={<StatusBadge status={agent.activeSession.status} />} />
              <KV label="Last heartbeat" value={<RelativeTime timestamp={agent.activeSession.lastHeartbeatAt} />} />
            </div>
          </Card>
        )}
        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>Messages to User</h3>
          {messagesQuery.isLoading && <LoadingRows count={3} />}
          {messagesQuery.isSuccess && messagesQuery.data.length === 0 && (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>No messages sent yet.</p>
          )}
          {messagesQuery.isSuccess && messagesQuery.data.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {messagesQuery.data.map((msg: AgentOutboundMessage) => (
                <div key={msg.id} style={{ padding: '10px 12px', borderRadius: '6px', background: 'var(--color-surface-raised)', fontSize: '13px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: msg.subject ? '4px' : '0' }}>
                    <span style={{ fontWeight: '500', color: msg.authoredBy === 'platform' ? 'var(--color-warning)' : 'var(--color-text)' }}>
                      {msg.authoredBy === 'platform' ? '🔔 Safety Alert' : '💬 Agent'}
                    </span>
                    <span style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <StatusBadge status={msg.deliveryStatus} />
                      <RelativeTime timestamp={msg.createdAt} />
                    </span>
                  </div>
                  {msg.subject && <div style={{ fontWeight: '600', marginBottom: '2px' }}>{msg.subject}</div>}
                  <div style={{ color: 'var(--color-text-muted)' }}>{msg.body}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>Protocol Activity</h3>
          {activityQuery.isLoading && <LoadingRows count={3} />}
          {activityQuery.isSuccess && (activityQuery.data as unknown[]).length === 0 && (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>No protocol messages yet.</p>
          )}
          {activityQuery.isSuccess && (activityQuery.data as unknown[]).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
              {(activityQuery.data as Array<{ id: string; type: string; createdAt: string }>).map((msg) => (
                <div key={msg.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <span>{msg.type}</span>
                  <RelativeTime timestamp={msg.createdAt} />
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>Artifacts</h3>
          {artifactsQuery.isLoading && <LoadingRows count={3} />}
          {artifactsQuery.isSuccess && artifactsQuery.data.length === 0 && (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>No artifacts published yet.</p>
          )}
          {artifactsQuery.isSuccess && artifactsQuery.data.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              {artifactsQuery.data.map((a: AgentArtifact) => (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <span>
                    <span style={{ fontWeight: '500' }}>{a.artifactType}</span>
                    {' · '}
                    <span style={{ color: 'var(--color-text-muted)' }}>{a.contentType}</span>
                    {a.summary && <span style={{ marginLeft: '8px', color: 'var(--color-text-muted)' }}>{a.summary}</span>}
                  </span>
                  <RelativeTime timestamp={a.createdAt} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </PageShell>
  );
}
