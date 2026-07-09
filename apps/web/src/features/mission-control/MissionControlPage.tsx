import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import type { ProviderSetupResult } from '../../lib/api-client.js';
import { agents as agentsApi, dashboard } from '../../lib/api-client.js';
import { formatPnl, pnlColor } from '../../lib/formatting.js';
import { PageShell, PageHeader, EmptyState, ErrorState, LoadingRows, Button, Card, SectionLabel, MetricCard } from '../../lib/ui.js';
import { AgentSummaryCard } from '../agents/AgentSummaryCard.js';
import { ActivityItem } from '../activity/ActivityItem.js';
import { AgentActivityItem } from '../activity/AgentActivityItem.js';
import { mergeActivityFeedItems } from '../activity/activity-feed-items.js';
import { ProviderSetupForm } from '../setup/ProviderSetupForm.js';
import { AgentAssignmentStep } from '../setup/AgentAssignmentStep.js';
import { useEventStream, type UserEvent } from '../../lib/useEventStream.js';

type SetupStep = 'form' | 'assign';

export function MissionControlSetupForm({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (result: ProviderSetupResult) => void;
}) {
  return (
    <ProviderSetupForm
      defaultCapability="trading"
      onClose={onClose}
      onSuccess={onSuccess}
    />
  );
}

export function MissionControlPage() {
  const navigate = useNavigate();
  const intl = useIntl();
  const qc = useQueryClient();
  const [showSetup, setShowSetup] = useState(false);
  const [setupStep, setSetupStep] = useState<SetupStep>('form');
  const [setupResult, setSetupResult] = useState<ProviderSetupResult | null>(null);
  const [setupSuccess, setSetupSuccess] = useState<{ label: string; provider: string } | null>(null);

  const handleEvent = useCallback((event: UserEvent) => {
    if (event.type === 'agent.status') {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['dashboard', 'agent-activity'] });
    } else if (event.type === 'decision.accepted' || event.type === 'decision.rejected') {
      void qc.invalidateQueries({ queryKey: ['dashboard', 'agent-activity'] });
      void qc.invalidateQueries({ queryKey: ['dashboard', 'activity'] });
    } else if (event.type === 'risk.guardrail') {
      void qc.invalidateQueries({ queryKey: ['dashboard', 'activity'] });
    }
  }, [qc]);
  useEventStream(handleEvent);

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
  });

  const activityQuery = useQuery({
    queryKey: ['dashboard', 'activity', { limit: 8 }],
    queryFn: () => dashboard.activity({ limit: 8 }),
  });

  const agentActivityQuery = useQuery({
    queryKey: ['dashboard', 'agent-activity', { limit: 8 }],
    queryFn: () => dashboard.agentActivity({ limit: 8 }),
    refetchInterval: 30_000,
  });

  const overviewQuery = useQuery({
    queryKey: ['dashboard', 'overview'],
    queryFn: () => dashboard.overview(),
  });

  const agents = agentsQuery.data ?? [];
  const mergedRecentActivity = mergeActivityFeedItems(agentActivityQuery.data?.entries ?? [], activityQuery.data?.events ?? []);
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
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: '12px',
            marginBottom: '32px',
          }}
        >
          <MetricCard label={intl.formatMessage({ id: 'missionControl.metric.active' })} value={counts.active} total={agents.length} />
          <MetricCard label={intl.formatMessage({ id: 'missionControl.metric.paused' })} value={counts.paused} />
          <MetricCard label={intl.formatMessage({ id: 'missionControl.metric.unhealthy' })} value={counts.unhealthy} />
          <MetricCard label={intl.formatMessage({ id: 'missionControl.metric.stopped' })} value={counts.stopped} />
          <MetricCard
            label={intl.formatMessage({ id: 'missionControl.metric.totalPnl' })}
            value={formatPnl(overviewQuery.data?.summary.outcomes.trading?.totalRealizedPnl)}
            color={pnlColor(overviewQuery.data?.summary.outcomes.trading?.totalRealizedPnl)}
          />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: '24px', alignItems: 'start' }}>
        <section aria-label={intl.formatMessage({ id: 'missionControl.section.agents' })}>
          <SectionLabel>{intl.formatMessage({ id: 'missionControl.section.agents' })}</SectionLabel>

          {/* Quick trading setup card */}
          {setupSuccess ? (
            <Card style={{ padding: '12px 16px', marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'var(--color-surface-success, rgba(34,197,94,0.08))', border: '1px solid var(--color-border-subtle)' }}>
              <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                {intl.formatMessage({ id: 'missionControl.setup.successMessage' }, { label: setupSuccess.label, provider: setupSuccess.provider })}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setSetupSuccess(null)}>
                {intl.formatMessage({ id: 'missionControl.setup.successDismiss' })}
              </Button>
            </Card>
          ) : (
            <Card style={{ padding: '12px 16px', marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', border: '1px solid var(--color-border-subtle)' }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: '600', marginBottom: '2px' }}>
                  {intl.formatMessage({ id: 'missionControl.setup.title' })}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                  {intl.formatMessage({ id: 'missionControl.setup.message' })}
                </div>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setShowSetup(true)}>
                {intl.formatMessage({ id: 'missionControl.setup.cta' })}
              </Button>
            </Card>
          )}

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
            {(activityQuery.isLoading || agentActivityQuery.isLoading) && (
              <div style={{ padding: '20px' }}>
                <LoadingRows count={4} />
              </div>
            )}
            {(activityQuery.isError || agentActivityQuery.isError) && (
              <ErrorState
                message={intl.formatMessage({ id: 'common.errorTitle', defaultMessage: 'Something went wrong' })}
                onRetry={() => {
                  void activityQuery.refetch();
                  void agentActivityQuery.refetch();
                }}
              />
            )}
            {activityQuery.isSuccess && agentActivityQuery.isSuccess && (activityQuery.data?.events.length ?? 0) === 0 && (agentActivityQuery.data?.entries.length ?? 0) === 0 && (
              <EmptyState
                title={intl.formatMessage({ id: 'missionControl.noActivityYet.title' })}
                message={intl.formatMessage({ id: 'missionControl.noActivityYet.message' })}
              />
            )}
            {activityQuery.isSuccess && agentActivityQuery.isSuccess && ((activityQuery.data?.events.length ?? 0) > 0 || (agentActivityQuery.data?.entries.length ?? 0) > 0) && (
              <div>
                {mergedRecentActivity.map((item, index) => (
                  item.kind === 'agent'
                    ? <AgentActivityItem key={`agent-${item.id}`} entry={item.entry} isLast={index === mergedRecentActivity.length - 1} />
                    : <ActivityItem key={`bot-${item.id}`} event={item.event} isLast={index === mergedRecentActivity.length - 1} />
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

      {showSetup && setupStep === 'form' && (
        <MissionControlSetupForm
          onClose={() => {
            setShowSetup(false);
            setSetupStep('form');
          }}
          onSuccess={(result) => {
            void qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'bindings'] });
            void qc.invalidateQueries({ queryKey: ['connections'] });
            setSetupResult(result);
            setSetupStep('assign');
          }}
        />
      )}

      {showSetup && setupStep === 'assign' && setupResult && (
        <AgentAssignmentStep
          connectionId={setupResult.connection.id}
          connectionLabel={setupResult.connection.label}
          connectionProvider={setupResult.connection.provider}
          onDone={() => {
            setShowSetup(false);
            setSetupStep('form');
            setSetupResult(null);
            setSetupSuccess({ label: setupResult.connection.label, provider: setupResult.connection.provider });
          }}
        />
      )}
    </PageShell>
  );
}

