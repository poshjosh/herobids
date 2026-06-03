import { useParams } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { agents as agentsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, Button, StatusBadge, RelativeTime, KV } from '../../lib/ui.js';

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['agents', id],
    queryFn: () => agentsApi.get(id!),
    enabled: !!id,
  });

  const startMutation = useMutation({
    mutationFn: () => agentsApi.start(id!),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['agents', id] }),
  });

  const pauseMutation = useMutation({
    mutationFn: () => agentsApi.pause(id!, 'User paused from UI'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['agents', id] }),
  });

  const resumeMutation = useMutation({
    mutationFn: () => agentsApi.resume(id!),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['agents', id] }),
  });

  const activityQuery = useQuery({
    queryKey: ['agents', id, 'activity'],
    queryFn: () => agentsApi.activity(id!, 20),
    enabled: !!id,
  });

  if (query.isLoading) return <PageShell><LoadingRows count={5} /></PageShell>;
  if (query.isError) return <PageShell><ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} /></PageShell>;

  const agent = query.data;
  if (!agent) return <PageShell><ErrorState message="Agent not found" /></PageShell>;

  return (
    <PageShell>
      <PageHeader
        title={agent.name}
        subtitle={agent.goal}
        action={
          <div style={{ display: 'flex', gap: '8px' }}>
            {agent.status === 'stopped' && (
              <Button variant="primary" onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
                Start
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
          </div>
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>Status</h3>
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
            <KV label="Status" value={<StatusBadge status={agent.status} />} />
            <KV label="Created" value={<RelativeTime timestamp={agent.createdAt} />} />
            <KV label="Updated" value={<RelativeTime timestamp={agent.updatedAt} />} />
          </div>
        </Card>

        {agent.activeLink && (
          <Card>
            <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>Linked Instance</h3>
            <KV label="Instance" value={agent.activeLink.tradingInstanceId} />
          </Card>
        )}

        {agent.activeSession && (
          <Card>
            <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>Active Session</h3>
            <div style={{ display: 'flex', gap: '24px' }}>
              <KV label="Session" value={agent.activeSession.id.slice(0, 8)} />
              <KV label="Status" value={<StatusBadge status={agent.activeSession.status} />} />
              <KV label="Last heartbeat" value={<RelativeTime timestamp={agent.activeSession.lastHeartbeatAt} />} />
            </div>
          </Card>
        )}

        <Card>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: '600' }}>Sent Messages</h3>
          {activityQuery.isLoading && <LoadingRows count={3} />}
          {activityQuery.isSuccess && (activityQuery.data as unknown[]).length === 0 && (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>No messages sent yet.</p>
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
      </div>
    </PageShell>
  );
}
