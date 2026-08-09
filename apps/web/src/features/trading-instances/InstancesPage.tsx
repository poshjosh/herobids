import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { bots as botsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, StatusBadge, RelativeTime, KV } from '../../lib/ui.js';

export function InstancesPage() {
  const navigate = useNavigate();

  const query = useQuery({
    queryKey: ['bots'],
    queryFn: () => botsApi.list(),
  });

  const items = query.data?.bots ?? [];

  return (
    <PageShell>
      <PageHeader
        title="Bots"
        subtitle="Advanced trading records kept for compatibility and history"
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={(query.error as Error).message} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="No bots yet"
          message="This view is read-only. Create and manage agents from the Agents area."
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {items.map((bot) => {
            const cfg = bot.config as Record<string, unknown> | null;
            const strategyType = (cfg?.['strategy'] as Record<string, unknown> | undefined)?.['type'] as string | undefined;
            return (
              <Card key={bot.id}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
                  <div
                    style={{ flex: 1, cursor: 'pointer' }}
                    onClick={() => navigate(`/instances/${bot.id}`)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                      <span style={{ fontWeight: '600', fontSize: '0.9375rem' }}>{strategyType ?? 'Bot'}</span>
                      <StatusBadge status={bot.status} />
                    </div>
                    <div style={{ display: 'flex', gap: '24px' }}>
                      <KV label="Created" value={<RelativeTime timestamp={bot.createdAt} />} />
                      {bot.startedAt && <KV label="Started" value={<RelativeTime timestamp={bot.startedAt} />} />}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

    </PageShell>
  );
}



