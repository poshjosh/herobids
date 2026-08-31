import type { AdminServersResponse, ServerHealthSnapshot } from '../../lib/api-client.js';
import { Card, KV } from '../../lib/ui.js';

// ---------------------------------------------------------------------------
// Shared helpers (local to this module — same as former AdminResourcesSection)
// ---------------------------------------------------------------------------

function fmtBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function UsageBar({ used, total, label }: { used: number; total: number; label?: string }) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  const color = pct > 85 ? 'var(--color-danger)' : pct > 65 ? 'var(--color-warning)' : 'var(--color-success)';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6875rem', color: 'var(--color-text-muted)', marginBottom: '3px' }}>
        {label && <span>{label}</span>}
        <span>{pct}%</span>
      </div>
      <div style={{ height: '4px', background: 'var(--color-surface-3)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '2px' }} />
      </div>
    </div>
  );
}

function fmtUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ---------------------------------------------------------------------------
// Server type display config
// ---------------------------------------------------------------------------

const SERVER_TYPE_LABELS: Record<string, string> = {
  'control-plane': 'Control Plane',
  'agent-server': 'Agent Servers',
  'browser-pool': 'Browser Pool',
  'trading': 'Trading',
};

const ORDERED_TYPES = ['control-plane', 'agent-server', 'browser-pool', 'trading'];

// ---------------------------------------------------------------------------
// Type-specific metadata rendering
// ---------------------------------------------------------------------------

function renderMetadata(serverType: string, metadata: Record<string, unknown>): React.ReactNode {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return null;

  const labelMap: Record<string, Record<string, string>> = {
    'control-plane': {
      runningAgentSessions: 'Active Sessions',
      postgresStatus: 'Postgres',
      redisStatus: 'Redis',
    },
    'agent-server': {
      nomadAllocations: 'Allocations',
      availableMemoryMb: 'Free Memory',
    },
    'browser-pool': {
      queuedRequests: 'Queued',
      recentlyRejected: 'Rejected',
      isAvailable: 'Available',
    },
  };

  const typeLabels = labelMap[serverType] ?? {};

  // browser-pool special: merge activeSessions / maxConcurrentSessions
  const kvPairs: { label: string; value: string }[] = [];

  if (serverType === 'browser-pool') {
    const active = metadata['activeSessions'];
    const max = metadata['maxConcurrentSessions'];
    if (active != null || max != null) {
      kvPairs.push({ label: 'Sessions', value: `${active ?? '?'}/${max ?? '?'}` });
    }
  }

  for (const [key, value] of entries) {
    // Skip already-handled browser-pool session fields
    if (serverType === 'browser-pool' && (key === 'activeSessions' || key === 'maxConcurrentSessions')) continue;

    const label = typeLabels[key] ?? key;
    const display = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value ?? '—');
    kvPairs.push({ label, value: display });
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px' }}>
      {kvPairs.map((kv) => (
        <KV key={kv.label} label={kv.label} value={kv.value} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Server card
// ---------------------------------------------------------------------------

function ServerCard({ server }: { server: ServerHealthSnapshot }) {
  const memPct = server.memory.totalBytes > 0
    ? Math.round((server.memory.usedBytes / server.memory.totalBytes) * 100)
    : 0;

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Header: ID + hostname + version + uptime */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.8125rem', fontWeight: '600' }}>
            {server.serverId}
          </span>
          {server.hostname !== server.serverId && (
            <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginLeft: '8px' }}>
              {server.hostname}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '12px', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
          <span>v{server.version}</span>
          <span>Up {fmtUptime(server.uptimeSeconds)}</span>
        </div>
      </div>

      {/* Resource bars */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}>
        {/* CPU */}
        <div>
          {server.cpuPct != null ? (
            <UsageBar used={server.cpuPct} total={100} label="CPU" />
          ) : (
            <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>CPU —</div>
          )}
          <div style={{ fontSize: '0.625rem', color: 'var(--color-text-muted)', marginTop: '2px' }}>
            Load: {server.loadAvg.map((v) => v.toFixed(2)).join(' / ')}
          </div>
        </div>

        {/* Memory */}
        <div>
          <UsageBar used={server.memory.usedBytes} total={server.memory.totalBytes} label="Memory" />
          <div style={{ fontSize: '0.625rem', color: 'var(--color-text-muted)', marginTop: '2px' }}>
            {fmtBytes(server.memory.usedBytes)} / {fmtBytes(server.memory.totalBytes)} ({memPct}%)
          </div>
        </div>

        {/* Disk */}
        <div>
          {server.disk != null ? (
            <>
              <UsageBar used={server.disk.usedBytes} total={server.disk.totalBytes} label="Disk" />
              <div style={{ fontSize: '0.625rem', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                {fmtBytes(server.disk.usedBytes)} / {fmtBytes(server.disk.totalBytes)}
              </div>
            </>
          ) : (
            <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>Disk unavailable</div>
          )}
        </div>
      </div>

      {/* Type-specific metadata */}
      {renderMetadata(server.serverType, server.metadata)}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main section component
// ---------------------------------------------------------------------------

export function AdminServersSection({ data }: { data: AdminServersResponse }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {ORDERED_TYPES.map((type) => {
        const servers = data.servers[type] ?? [];
        const label = SERVER_TYPE_LABELS[type] ?? type;

        return (
          <div key={type}>
            {/* Group heading with count badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <span style={{ fontSize: '0.875rem', fontWeight: '600', color: 'var(--color-text-primary)' }}>
                {label}
              </span>
              <span
                style={{
                  fontSize: '0.6875rem',
                  fontWeight: '500',
                  background: 'var(--color-surface-3)',
                  color: 'var(--color-text-muted)',
                  padding: '1px 8px',
                  borderRadius: '10px',
                }}
              >
                {servers.length}
              </span>
            </div>

            {servers.length === 0 ? (
              <Card>
                <div style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem', padding: '8px 0' }}>
                  No servers reporting.
                </div>
              </Card>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {servers.map((server) => (
                  <ServerCard key={server.serverId} server={server} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
