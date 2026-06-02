import { useNavigate } from 'react-router';
import type { InstanceSummary } from '../../lib/api-client.js';
import { StatusBadge, RelativeTime, Card, KV } from '../../lib/ui.js';

interface AgentOverviewCardProps {
  instance: InstanceSummary;
}

export function AgentOverviewCard({ instance }: AgentOverviewCardProps) {
  const navigate = useNavigate();

  const statusMessage = (() => {
    if (instance.status === 'running') {
      if (instance.openPositionsCount > 0) {
        return `Managing ${instance.openPositionsCount} open position${instance.openPositionsCount !== 1 ? 's' : ''}`;
      }
      return 'Watching for opportunities';
    }
    if (instance.status === 'crashed') return 'Agent crashed — needs attention';
    return 'Agent is paused';
  })();

  return (
    <Card
      onClick={() => navigate(`/instances/${instance.id}`)}
      style={{ cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '15px', fontWeight: '600', color: 'var(--color-text-primary)', marginBottom: '4px' }}>
            {instance.venue} · {instance.symbol || '—'}
          </div>
          <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
            {instance.strategyId}
          </div>
        </div>
        <StatusBadge status={instance.status} />
      </div>

      <div
        style={{
          fontSize: '13px',
          color: instance.status === 'crashed' ? 'var(--color-danger)' : 'var(--color-text-secondary)',
          marginBottom: '16px',
          minHeight: '18px',
        }}
      >
        {statusMessage}
      </div>

      <div style={{ display: 'flex', gap: '20px' }}>
        <KV label="Positions" value={instance.openPositionsCount} />
        <KV label="Last active" value={<RelativeTime timestamp={instance.lastActivityAt} />} />
        {instance.startedAt && <KV label="Started" value={<RelativeTime timestamp={instance.startedAt} />} />}
      </div>
    </Card>
  );
}
