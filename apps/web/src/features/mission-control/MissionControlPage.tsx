import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, dashboard } from '../../lib/api-client.js';
import { PageShell, PageHeader, EmptyState, ErrorState, LoadingRows, Button, Card, SectionLabel } from '../../lib/ui.js';
import { AgentSummaryCard } from '../agents/AgentSummaryCard.js';
import { ActivityItem } from '../activity/ActivityItem.js';

export function MissionControlPage() {
  const navigate = useNavigate();
  const intl = useIntl();

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
  });

  const overviewQuery = useQuery({
    queryKey: ['dashboard', 'activity', { limit: 8 }],
    queryFn: () => dashboard.activity({ limit: 8 }),
  });

  const agents = agentsQuery.data ?? [];
  const counts = {
    active: agents.filter((agent) => agent.status === 'active' || agent.status === 'starting').length,
    paused: agents.filter((agent) => agent.status === 'paused').length,
    unhealthy: agents.filter((agent) => agent.status === 'crashed' || agent.status === 'unhealthy').length,
    stopped: agents.filter((agent) => agent.status === 'stopped').length,
  };

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'missionControl.title' })}
        subtitle={
          agentsQuery.data
            ? intl.formatMessage(
                { id: 'missionControl.subtitle' },
                { activeCount: counts.active, totalCount: agents.length },
              )
            : undefined
        }
        action={
          <Button variant="primary" onClick={() => navigate('/agents?create=1')}>
            {intl.formatMessage({ id: 'missionControl.createAgent' })}
          </Button>
        }
      />

      {/* Summary metrics */}
      {agentsQuery.data && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '12px',
            marginBottom: '32px',
          }}
        >
          <MetricCard label={intl.formatMessage({ id: 'missionControl.metric.active' })} value={counts.active} total={agents.length} />
          <MetricCard label={intl.formatMessage({ id: 'missionControl.metric.paused' })} value={counts.paused} />
          <MetricCard label={intl.formatMessage({ id: 'missionControl.metric.unhealthy' })} value={counts.unhealthy} />
          <MetricCard label={intl.formatMessage({ id: 'missionControl.metric.stopped' })} value={counts.stopped} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: '24px', alignItems: 'start' }}>
        <section aria-label={intl.formatMessage({ id: 'missionControl.section.agents' })}>
          <SectionLabel>{intl.formatMessage({ id: 'missionControl.section.agents' })}</SectionLabel>

          {agentsQuery.isLoading && <LoadingRows count={3} />}
          {agentsQuery.isError && (
            <ErrorState
              message={(agentsQuery.error as Error).message}
              onRetry={() => void agentsQuery.refetch()}
            />
          )}
          {agentsQuery.isSuccess && agents.length === 0 && (
            <EmptyState
              title={intl.formatMessage({ id: 'missionControl.noAgents.title' })}
              message={intl.formatMessage({ id: 'missionControl.noAgents.message' })}
              action={
                <Button variant="primary" onClick={() => navigate('/agents?create=1')}>
                  {intl.formatMessage({ id: 'missionControl.createAgent' })}
                </Button>
              }
            />
          )}
          {agentsQuery.isSuccess && agents.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {agents.map((agent) => (
                <AgentSummaryCard key={agent.id} agent={agent} />
              ))}
            </div>
          )}
        </section>

        <section aria-label={intl.formatMessage({ id: 'missionControl.section.recentActivity' })}>
          <SectionLabel>{intl.formatMessage({ id: 'missionControl.section.recentActivity' })}</SectionLabel>

          <Card style={{ padding: '0' }}>
            {overviewQuery.isLoading && (
              <div style={{ padding: '20px' }}>
                <LoadingRows count={4} />
              </div>
            )}
            {overviewQuery.isSuccess && (overviewQuery.data?.events.length ?? 0) === 0 && (
              <EmptyState
                title={intl.formatMessage({ id: 'missionControl.noActivityYet.title' })}
                message={intl.formatMessage({ id: 'missionControl.noActivityYet.message' })}
              />
            )}
            {overviewQuery.isSuccess && (overviewQuery.data?.events.length ?? 0) > 0 && (
              <div>
                {overviewQuery.data!.events.map((event, i) => (
                  <ActivityItem
                    key={event.id}
                    event={event}
                    isLast={i === overviewQuery.data!.events.length - 1}
                  />
                ))}
                <div style={{ padding: '12px 20px', borderTop: '1px solid var(--color-border-subtle)' }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => navigate('/activity')}
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    {intl.formatMessage({ id: 'missionControl.viewAllActivity' })}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </section>
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
