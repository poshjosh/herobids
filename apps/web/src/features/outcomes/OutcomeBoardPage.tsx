import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, skills as skillsApi, type Agent, type AgentArtifact, type AgentOutboundMessage } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, SectionLabel, Button, StatusBadge, RelativeTime, KV } from '../../lib/ui.js';
import { formatExecutionMode, hasCapabilityFamily, resolveSelectedSkills } from '../agents/agent-display.js';

export function OutcomeBoardPage() {
  const navigate = useNavigate();
  const intl = useIntl();
  const query = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
  });
  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list({ scope: 'selectable' }),
  });

  const agents = query.data ?? [];
  const counts = {
    total: agents.length,
    active: agents.filter((agent) => agent.status === 'active' || agent.status === 'starting').length,
    attention: agents.filter((agent) => agent.status === 'crashed' || agent.status === 'unhealthy').length,
    updatedToday: agents.filter((agent) => Date.now() - new Date(agent.updatedAt).getTime() < 24 * 60 * 60 * 1000).length,
  };

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'outcomes.title' })}
        subtitle={intl.formatMessage({ id: 'outcomes.subtitle' })}
      />

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && (
        <ErrorState
          message={(query.error as Error).message}
          onRetry={() => void query.refetch()}
        />
      )}

      {query.isSuccess && agents.length === 0 && (
        <EmptyState
          title={intl.formatMessage({ id: 'outcomes.noAgents.title' })}
          message={intl.formatMessage({ id: 'outcomes.noAgents.message' })}
        />
      )}

      {query.isSuccess && agents.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: '12px',
            }}
          >
            <ScoreCard label={intl.formatMessage({ id: 'outcomes.metric.total' })} value={counts.total} />
            <ScoreCard label={intl.formatMessage({ id: 'outcomes.metric.active' })} value={counts.active} highlight />
            <ScoreCard label={intl.formatMessage({ id: 'outcomes.metric.attention' })} value={counts.attention} />
            <ScoreCard label={intl.formatMessage({ id: 'outcomes.metric.updatedToday' })} value={counts.updatedToday} />
          </div>

          <SectionLabel>{intl.formatMessage({ id: 'outcomes.recentOutcomes' })}</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {agents.map((agent) => (
              <OutcomeAgentCard
                key={agent.id}
                agent={agent}
                showExecutionMode={hasCapabilityFamily(resolveSelectedSkills(agent.skillIds, skillsQuery.data?.skills ?? []), 'trading')}
                onOpen={() => navigate(`/agents/${agent.id}`)}
              />
            ))}
          </div>
        </div>
      )}
    </PageShell>
  );
}

function ScoreCard({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <Card style={{ padding: '16px 20px' }}>
      <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
        {label}
      </div>
      <div
        style={{
          fontSize: '1.75rem',
          fontWeight: '700',
          color: highlight ? 'var(--color-brand)' : 'var(--color-text-primary)',
        }}
      >
        {value}
      </div>
    </Card>
  );
}

function OutcomeAgentCard({ agent, onOpen, showExecutionMode }: { agent: Agent; onOpen: () => void; showExecutionMode: boolean }) {
  const intl = useIntl();
  const artifactsQuery = useQuery({
    queryKey: ['agents', agent.id, 'artifacts', 'outcome-board'],
    queryFn: () => agentsApi.artifacts(agent.id, 1),
  });

  const messagesQuery = useQuery({
    queryKey: ['agents', agent.id, 'messages', 'outcome-board'],
    queryFn: () => agentsApi.messages(agent.id, 1, 'agent'),
  });

  const latestArtifact = artifactsQuery.data?.[0] ?? null;
  const latestMessage = messagesQuery.data?.[0] ?? null;

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
            <span style={{ fontSize: '0.9375rem', fontWeight: '600' }}>{agent.name}</span>
            <StatusBadge status={agent.status} />
            {showExecutionMode && (
              <span style={{ padding: '3px 8px', borderRadius: '20px', background: 'var(--color-surface-2)', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                {intl.formatMessage({ id: 'agents.modeBadge' }, { mode: formatExecutionMode(agent.executionMode, intl) })}
              </span>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '16px' }}>
            <OutcomeBlock
              label={intl.formatMessage({ id: 'outcomes.latestArtifact' })}
              loading={artifactsQuery.isLoading}
              emptyMessage={intl.formatMessage({ id: 'outcomes.noArtifact' })}
              timestamp={latestArtifact?.createdAt ?? null}
              content={latestArtifact ? formatArtifactSummary(latestArtifact) : null}
            />
            <OutcomeBlock
              label={intl.formatMessage({ id: 'outcomes.latestUserSummary' })}
              loading={messagesQuery.isLoading}
              emptyMessage={intl.formatMessage({ id: 'outcomes.noSummary' })}
              timestamp={latestMessage?.createdAt ?? null}
              content={latestMessage ? formatMessageSummary(latestMessage) : null}
            />
          </div>

          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', marginTop: '16px' }}>
            <KV label={intl.formatMessage({ id: 'common.updated' })} value={<RelativeTime timestamp={agent.updatedAt} />} />
            {agent.activeSession?.startedAt && <KV label={intl.formatMessage({ id: 'agents.detail.activeSince' })} value={<RelativeTime timestamp={agent.activeSession.startedAt} />} />}
          </div>
        </div>

        <Button variant="secondary" onClick={() => onOpen()}>{intl.formatMessage({ id: 'agents.summary.openAgent' })}</Button>
      </div>
    </Card>
  );
}

function OutcomeBlock({
  label,
  loading,
  emptyMessage,
  content,
  timestamp,
}: {
  label: string;
  loading: boolean;
  emptyMessage: string;
  content: string | null;
  timestamp: string | null;
}) {
  return (
    <div>
      <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
        {label}
      </div>
      {loading && <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>Loading…</div>}
      {!loading && !content && <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>{emptyMessage}</div>}
      {!loading && content && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-primary)', lineHeight: '1.5' }}>{content}</div>
          {timestamp && <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}><RelativeTime timestamp={timestamp} /></div>}
        </div>
      )}
    </div>
  );
}

function formatArtifactSummary(artifact: AgentArtifact): string {
  const summary = artifact.summary.trim();
  if (summary.length > 0) {
    return summary;
  }

  return `${artifact.artifactType} · ${artifact.contentType}`;
}

function formatMessageSummary(message: AgentOutboundMessage): string {
  const subject = message.subject?.trim();
  const body = message.body.trim();
  if (subject && body.length > 0) {
    return `${subject}: ${truncate(body, 140)}`;
  }
  if (body.length > 0) {
    return truncate(body, 160);
  }
  return 'Empty message body';
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}