import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { dashboard } from '../../lib/api-client.js';
import { PageShell, PageHeader, EmptyState, ErrorState, LoadingRows, Button, Card, SectionLabel } from '../../lib/ui.js';
import { AgentOverviewCard } from './AgentOverviewCard.js';
import { ActivityItem } from '../activity/ActivityItem.js';
import { HealthStrip } from '../health/HealthStrip.js';

export function MissionControlPage() {
  const navigate = useNavigate();

  const overviewQuery = useQuery({
    queryKey: ['dashboard', 'overview'],
    queryFn: () => dashboard.overview(),
  });

  const activityQuery = useQuery({
    queryKey: ['dashboard', 'activity', { limit: 8 }],
    queryFn: () => dashboard.activity({ limit: 8 }),
  });

  const overview = overviewQuery.data;
  const hasInstances = (overview?.bots.length ?? 0) > 0;

  return (
    <PageShell>
      <PageHeader
        title="Mission Control"
        subtitle={
          overview
            ? `${overview.summary.runningBots} of ${overview.summary.totalBots} agent${overview.summary.totalBots !== 1 ? 's' : ''} running`
            : undefined
        }
        action={
          <Button variant="primary" onClick={() => navigate('/instances')}>
            Manage agents
          </Button>
        }
      />

      {/* Health strip */}
      {overview && <HealthStrip instances={overview.bots} />}

      {/* Summary metrics */}
      {overview && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '12px',
            marginBottom: '32px',
          }}
        >
          <MetricCard label="Active agents" value={overview.summary.runningBots} total={overview.summary.totalBots} />
          <MetricCard label="Open positions" value={overview.summary.totalOpenPositions} />
          <MetricCard label="Plan" value={overview.user.planId} />
        </div>
      )}

      {/* Two-column layout: agents on left, activity on right */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: '24px', alignItems: 'start' }}>
        {/* Agent overview cards */}
        <div>
          <SectionLabel>Your agents</SectionLabel>

          {overviewQuery.isLoading && <LoadingRows count={3} />}
          {overviewQuery.isError && (
            <ErrorState
              message={(overviewQuery.error as Error).message}
              onRetry={() => void overviewQuery.refetch()}
            />
          )}
          {overviewQuery.isSuccess && !hasInstances && (
            <EmptyState
              title="No agents yet"
              message="Create your first trading agent to get started."
              action={
                <Button variant="primary" onClick={() => navigate('/instances')}>
                  Create agent
                </Button>
              }
            />
          )}
          {overviewQuery.isSuccess && hasInstances && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {overview!.bots.map((inst) => (
                <AgentOverviewCard key={inst.id} instance={inst} />
              ))}
            </div>
          )}
        </div>

        {/* Recent activity */}
        <div>
          <SectionLabel>Recent activity</SectionLabel>

          <Card style={{ padding: '0' }}>
            {activityQuery.isLoading && (
              <div style={{ padding: '20px' }}>
                <LoadingRows count={4} />
              </div>
            )}
            {activityQuery.isSuccess && (activityQuery.data?.events.length ?? 0) === 0 && (
              <EmptyState title="No activity yet" message="Events will appear here once your agents start trading." />
            )}
            {activityQuery.isSuccess && (activityQuery.data?.events.length ?? 0) > 0 && (
              <div>
                {activityQuery.data!.events.map((event, i) => (
                  <ActivityItem
                    key={event.id}
                    event={event}
                    isLast={i === activityQuery.data!.events.length - 1}
                  />
                ))}
                <div style={{ padding: '12px 20px', borderTop: '1px solid var(--color-border-subtle)' }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate('/activity')}
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    View all activity →
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </PageShell>
  );
}

function MetricCard({ label, value, total }: { label: string; value: string | number; total?: number }) {
  return (
    <Card style={{ padding: '16px 20px' }}>
      <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
        {label}
      </div>
      <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
        {value}
        {total !== undefined && (
          <span style={{ fontSize: '14px', fontWeight: '400', color: 'var(--color-text-muted)', marginLeft: '4px' }}>
            / {total}
          </span>
        )}
      </div>
    </Card>
  );
}
