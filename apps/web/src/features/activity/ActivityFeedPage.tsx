import { useInfiniteQuery } from '@tanstack/react-query';
import { dashboard } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, EmptyState, ErrorState, LoadingRows, Button } from '../../lib/ui.js';
import { ActivityItem } from './ActivityItem.js';

export function ActivityFeedPage() {
  const query = useInfiniteQuery({
    queryKey: ['dashboard', 'activity'],
    queryFn: ({ pageParam }) =>
      dashboard.activity({ limit: 50, before: pageParam?.timestamp, beforeId: pageParam?.id }),
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore) return undefined;
      const lastEvent = lastPage.events[lastPage.events.length - 1];
      if (!lastEvent) return undefined;
      return { timestamp: lastEvent.timestamp, id: lastEvent.id };
    },
    initialPageParam: undefined as { timestamp: string; id: string } | undefined,
  });

  const allEvents = query.data?.pages.flatMap((p) => p.events) ?? [];
  const hasMore = query.hasNextPage ?? false;

  return (
    <PageShell>
      <PageHeader
        title="Activity"
        subtitle="What your agents have been doing"
      />

      {query.isLoading && <LoadingRows count={6} />}
      {query.isError && (
        <ErrorState
          message={(query.error as Error).message}
          onRetry={() => void query.refetch()}
        />
      )}

      {query.isSuccess && allEvents.length === 0 && (
        <EmptyState
          title="No activity yet"
          message="Events will appear here as your agents make decisions, place orders, and manage positions."
        />
      )}

      {query.isSuccess && allEvents.length > 0 && (
        <Card style={{ padding: 0 }}>
          {allEvents.map((event, i) => (
            <ActivityItem key={event.id} event={event} isLast={i === allEvents.length - 1 && !hasMore} />
          ))}

          {hasMore && (
            <div style={{ padding: '16px', borderTop: '1px solid var(--color-border-subtle)', textAlign: 'center' }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? 'Loading…' : 'Load older events'}
              </Button>
            </div>
          )}
        </Card>
      )}
    </PageShell>
  );
}
