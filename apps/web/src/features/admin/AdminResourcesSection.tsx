import type { AdminStatsResponse } from '../../lib/api-client.js';
import { Card, Grid, KV } from '../../lib/ui.js';

function fmtBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function UsageBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  const color = pct > 85 ? 'var(--color-danger)' : pct > 65 ? 'var(--color-warning)' : 'var(--color-success)';
  return (
    <div style={{ marginTop: '6px' }}>
      <div style={{ height: '4px', background: 'var(--color-surface-3)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '2px' }} />
      </div>
      <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)', marginTop: '3px' }}>{pct}% used</div>
    </div>
  );
}

export function AdminResourcesSection({ stats }: { stats: AdminStatsResponse }) {
  const { memory, disk } = stats;

  return (
    <Grid columns={2} gap={16}>
      <Card>
        <div style={{ fontWeight: '600', marginBottom: '12px' }}>Memory</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <KV label="Total" value={fmtBytes(memory.totalBytes)} />
          <KV label="Used" value={fmtBytes(memory.usedBytes)} />
          <KV label="Free" value={fmtBytes(memory.freeBytes)} />
          <UsageBar used={memory.usedBytes} total={memory.totalBytes} />
        </div>
      </Card>

      <Card>
        <div style={{ fontWeight: '600', marginBottom: '12px' }}>Disk</div>
        {disk == null ? (
          <div style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>Disk stats unavailable</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <KV label="Total" value={fmtBytes(disk.totalBytes)} />
            <KV label="Used" value={fmtBytes(disk.usedBytes)} />
            <KV label="Free" value={fmtBytes(disk.freeBytes)} />
            <UsageBar used={disk.usedBytes} total={disk.totalBytes} />
          </div>
        )}
      </Card>
    </Grid>
  );
}
