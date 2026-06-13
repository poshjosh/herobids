import type { AdminStatsResponse } from '../../lib/api-client.js';
import { Card, Grid, KV } from '../../lib/ui.js';

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString();
}

function StatusPill({ status }: { status: 'ok' | 'timeout' | 'error' }) {
  const color = status === 'ok' ? 'var(--color-success)' : status === 'timeout' ? 'var(--color-warning)' : 'var(--color-danger)';
  const bg = status === 'ok' ? 'var(--color-success-subtle)' : status === 'timeout' ? 'var(--color-warning-subtle)' : 'var(--color-danger-subtle)';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '20px',
        fontSize: '12px',
        fontWeight: '500',
        color,
        background: bg,
      }}
    >
      {status}
    </span>
  );
}

export function AdminOverviewSection({ stats }: { stats: AdminStatsResponse }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Health row */}
      <Card>
        <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'center' }}>
          <KV label="API Version" value={stats.version} />
          <KV label="Postgres" value={<StatusPill status={stats.postgres} />} />
          <KV label="Redis" value={<StatusPill status={stats.redis} />} />
        </div>
      </Card>

      {/* Counts grid */}
      <Grid columns={4} gap={12}>
        <StatCard label="Total Users" value={fmt(stats.counts.users)} />
        <StatCard label="Total Agents" value={fmt(stats.counts.agents)} />
        <StatCard label="Total Bots" value={fmt(stats.counts.bots)} />
        <StatCard label="Running Sessions" value={fmt(stats.counts.runningSessions)} />
        <StatCard label="Running Containers" value={stats.counts.runningContainers == null ? '—' : fmt(stats.counts.runningContainers)} />
        <StatCard label="Failed Webhooks" value={fmt(stats.counts.failedWebhooks)} alert={stats.counts.failedWebhooks > 0} />
        <StatCard label="New Users (24h)" value={fmt(stats.counts.newUsersLast24h)} />
        <StatCard label="New Agents (24h)" value={fmt(stats.counts.newAgentsLast24h)} />
      </Grid>
    </div>
  );
}

function StatCard({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <Card style={alert ? { borderColor: 'var(--color-warning)' } : undefined}>
      <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)', marginBottom: '6px' }}>
        {label}
      </div>
      <div style={{ fontSize: '22px', fontWeight: '700', color: alert ? 'var(--color-warning)' : 'var(--color-text-primary)' }}>
        {value}
      </div>
    </Card>
  );
}
