import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { agents as agentsApi, type Agent, type AgentArtifact, type AgentOutboundMessage } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, SectionLabel, Button, StatusBadge, RelativeTime, KV } from '../../lib/ui.js';
import { formatExecutionMode } from '../agents/agent-display.js';

export function OutcomeBoardPage() {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
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
        title="Outcome Board"
        subtitle="How each agent is progressing"
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
          title="No agents yet"
          message="Create an agent to start tracking published outputs, user-facing summaries, and recent progress."
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
            <ScoreCard label="Total agents" value={counts.total} />
            <ScoreCard label="Active now" value={counts.active} highlight />
            <ScoreCard label="Need attention" value={counts.attention} />
            <ScoreCard label="Updated today" value={counts.updatedToday} />
          </div>

          <SectionLabel>Recent published outcomes</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {agents.map((agent) => (
              <OutcomeAgentCard key={agent.id} agent={agent} onOpen={() => navigate(`/agents/${agent.id}`)} />
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
      <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
        {label}
      </div>
      <div
        style={{
          fontSize: '28px',
          fontWeight: '700',
          color: highlight ? 'var(--color-brand)' : 'var(--color-text-primary)',
        }}
      >
        {value}
      </div>
    </Card>
  );
}

function OutcomeAgentCard({ agent, onOpen }: { agent: Agent; onOpen: () => void }) {
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
            <span style={{ fontSize: '15px', fontWeight: '600' }}>{agent.name}</span>
            <StatusBadge status={agent.status} />
            <span style={{ padding: '3px 8px', borderRadius: '20px', background: 'var(--color-surface-2)', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
              {formatExecutionMode(agent.executionMode)} mode
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '16px' }}>
            <OutcomeBlock
              label="Latest artifact"
              loading={artifactsQuery.isLoading}
              emptyMessage="No published artifact yet."
              timestamp={latestArtifact?.createdAt ?? null}
              content={latestArtifact ? formatArtifactSummary(latestArtifact) : null}
            />
            <OutcomeBlock
              label="Latest user summary"
              loading={messagesQuery.isLoading}
              emptyMessage="No agent-authored summary yet."
              timestamp={latestMessage?.createdAt ?? null}
              content={latestMessage ? formatMessageSummary(latestMessage) : null}
            />
          </div>

          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', marginTop: '16px' }}>
            <KV label="Updated" value={<RelativeTime timestamp={agent.updatedAt} />} />
            {agent.activeSession?.startedAt && <KV label="Active since" value={<RelativeTime timestamp={agent.activeSession.startedAt} />} />}
          </div>
        </div>

        <Button variant="secondary" onClick={() => onOpen()}>Open agent</Button>
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
      <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
        {label}
      </div>
      {loading && <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>Loading…</div>}
      {!loading && !content && <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{emptyMessage}</div>}
      {!loading && content && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ fontSize: '13px', color: 'var(--color-text-primary)', lineHeight: '1.5' }}>{content}</div>
          {timestamp && <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}><RelativeTime timestamp={timestamp} /></div>}
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