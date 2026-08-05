import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, dashboard } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, EmptyState, ErrorState, LoadingRows, Button, MetricCard } from '../../lib/ui.js';
import { ActivityItem } from './ActivityItem.js';
import { AgentActivityItem } from './AgentActivityItem.js';
import { mergeActivityFeedItems } from './activity-feed-items.js';
import { formatPnl, pnlColor } from '../../lib/formatting.js';

type FeedMode = 'all' | 'bots' | 'agents';

export function ActivityFeedPage() {
  const intl = useIntl();
  const [mode, setMode] = useState<FeedMode>('all');

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
  });

  const overviewQuery = useQuery({
    queryKey: ['dashboard', 'overview'],
    queryFn: () => dashboard.overview(),
  });

  const items = agentsQuery.data ?? [];
  const counts = {
    active: items.filter((agent) => agent.status === 'active' || agent.status === 'starting').length,
    paused: items.filter((agent) => agent.status === 'paused').length,
    unhealthy: items.filter((agent) => agent.status === 'crashed' || agent.status === 'unhealthy').length,
    stopped: items.filter((agent) => agent.status === 'stopped').length,
  };

  const botQuery = useInfiniteQuery({
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
    enabled: mode === 'all' || mode === 'bots',
  });

  const agentQuery = useInfiniteQuery({
    queryKey: ['dashboard', 'agent-activity'],
    queryFn: ({ pageParam }) => dashboard.agentActivity({ limit: 50, before: pageParam?.timestamp, beforeId: pageParam?.id }),
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore) return undefined;
      const lastEntry = lastPage.entries[lastPage.entries.length - 1];
      if (!lastEntry) return undefined;
      return { timestamp: lastEntry.timestamp, id: lastEntry.id };
    },
    initialPageParam: undefined as { timestamp: string; id: string } | undefined,
    enabled: mode === 'all' || mode === 'agents',
  });

  const allBotEvents = botQuery.data?.pages.flatMap((p) => p.events) ?? [];
  const agentEntries = agentQuery.data?.pages.flatMap((p) => p.entries) ?? [];
  const hasBotMore = botQuery.hasNextPage ?? false;
  const hasAgentMore = agentQuery.hasNextPage ?? false;
  const mergedItems = mergeActivityFeedItems(agentEntries, allBotEvents);

  const isLoading = (mode !== 'agents' && botQuery.isLoading) || (mode !== 'bots' && agentQuery.isLoading);
  const isError = (mode !== 'agents' && botQuery.isError) || (mode !== 'bots' && agentQuery.isError);
  const isEmpty = (mode === 'bots' ? allBotEvents.length === 0 : mode === 'agents' ? agentEntries.length === 0 : allBotEvents.length === 0 && agentEntries.length === 0);

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'activity.title' })}
        subtitle={intl.formatMessage({ id: 'activity.subtitle' })}
      />

      {/* Agent summary metrics */}
      {agentsQuery.isSuccess && items.length > 0 && (
        <div className="metrics-summary-row">
          <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.active' })} value={counts.active} total={items.length} />
          <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.paused' })} value={counts.paused} />
          <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.unhealthy' })} value={counts.unhealthy} />
          <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.stopped' })} value={counts.stopped} />
          <MetricCard
            className="metrics-summary-card"
            label={intl.formatMessage({ id: 'missionControl.metric.totalPnl' })}
            value={overviewQuery.isLoading ? '—' : formatPnl(overviewQuery.data?.summary.outcomes.trading?.totalRealizedPnl)}
            color={overviewQuery.isLoading ? undefined : pnlColor(overviewQuery.data?.summary.outcomes.trading?.totalRealizedPnl)}
          />
        </div>
      )}

      {/* Mode tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px' }}>
        {(['all', 'agents', 'bots'] as const).map((m) => (
          <Button
            key={m}
            variant={mode === m ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setMode(m)}
          >
            {m === 'all'
              ? intl.formatMessage({ id: 'activity.tab.all', defaultMessage: 'All' })
              : m === 'agents'
                ? intl.formatMessage({ id: 'activity.tab.agents', defaultMessage: 'Agents' })
                : intl.formatMessage({ id: 'activity.tab.bots', defaultMessage: 'Bots' })}
          </Button>
        ))}
      </div>

      {isLoading && <LoadingRows count={6} />}
      {isError && (
        <ErrorState
          message={intl.formatMessage({ id: 'common.errorTitle', defaultMessage: 'Something went wrong' })}
          onRetry={() => {
            if (mode !== 'agents') void botQuery.refetch();
            if (mode !== 'bots') void agentQuery.refetch();
          }}
        />
      )}

      {!isLoading && !isError && isEmpty && (
        <EmptyState
          title={intl.formatMessage({ id: 'activity.noActivity.title' })}
          message={intl.formatMessage({ id: 'activity.noActivity.message' })}
        />
      )}

      {!isLoading && !isError && !isEmpty && (
        <Card style={{ padding: 0 }}>
          {mode === 'all' && mergedItems.map((item, index) => (
            item.kind === 'agent'
              ? <AgentActivityItem key={`agent-${item.id}`} entry={item.entry} isLast={index === mergedItems.length - 1 && !hasBotMore} />
              : <ActivityItem key={`bot-${item.id}`} event={item.event} isLast={index === mergedItems.length - 1 && !hasBotMore} />
          ))}

          {mode === 'agents' && agentEntries.map((entry, index) => (
            <AgentActivityItem key={entry.id} entry={entry} isLast={index === agentEntries.length - 1} />
          ))}

          {mode === 'bots' && allBotEvents.map((event, index) => (
            <ActivityItem key={event.id} event={event} isLast={index === allBotEvents.length - 1 && !hasBotMore} />
          ))}

          {(mode === 'all' || mode === 'bots' || mode === 'agents') && (hasBotMore || hasAgentMore) && (
            <div style={{ padding: '16px', borderTop: '1px solid var(--color-border-subtle)', textAlign: 'center' }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  if (mode !== 'agents' && hasBotMore) void botQuery.fetchNextPage();
                  if (mode !== 'bots' && hasAgentMore) void agentQuery.fetchNextPage();
                }}
                disabled={botQuery.isFetchingNextPage || agentQuery.isFetchingNextPage}
              >
                {botQuery.isFetchingNextPage || agentQuery.isFetchingNextPage
                  ? intl.formatMessage({ id: 'common.loading' })
                  : intl.formatMessage({ id: 'activity.loadOlderEvents' })}
              </Button>
            </div>
          )}
        </Card>
      )}
    </PageShell>
  );
}
