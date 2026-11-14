import type { AdminServersResponse, ServerHealthSnapshot } from '../../lib/api-client.js';
import { Card, KV } from '../../lib/ui.js';
import {
  isBrowserNodeSaturated,
  readBrowserPoolMetrics,
  sessionUtilizationPct,
  summarizeBrowserPool,
} from './browser-pool-metrics.js';
import { USAGE_DANGER_PCT, USAGE_WARNING_PCT } from './capacity-display.js';

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
  const color = pct > USAGE_DANGER_PCT ? 'var(--color-danger)' : pct > USAGE_WARNING_PCT ? 'var(--color-warning)' : 'var(--color-success)';
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
      runningContainers: 'Containers',
      postgresStatus: 'Postgres',
      redisStatus: 'Redis',
    },
    // agent-server renders its figures via AgentServerResourceBars, not this KV map.
    'browser-pool': {
      queuedRequests: 'Queued',
      recentlyRejected: 'Rejected',
      isAvailable: 'Available',
    },
  };

  const typeLabels = labelMap[serverType] ?? {};

  const kvPairs: { label: string; value: string }[] = [];

  for (const [key, value] of entries) {
    // Sessions and memory pressure are shown on the browser-pool resource bars, not as KVs.
    if (serverType === 'browser-pool' && (key === 'activeSessions' || key === 'maxConcurrentSessions' || key === 'memoryPressure')) continue;

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
// Resource bar layouts — standard (most server types) vs browser-pool
// ---------------------------------------------------------------------------

function StandardResourceBars({ server }: { server: ServerHealthSnapshot }) {
  const memPct = server.memory.totalBytes > 0
    ? Math.round((server.memory.usedBytes / server.memory.totalBytes) * 100)
    : 0;

  return (
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
  );
}

function BrowserPoolResourceBars({ server }: { server: ServerHealthSnapshot }) {
  const metrics = readBrowserPoolMetrics(server.metadata);
  const utilPct = sessionUtilizationPct(metrics);
  const { activeSessions, maxConcurrentSessions, memoryPressure } = metrics;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}>
      {/* CPU — cpuPressure maps to cpuPct */}
      <div>
        {server.cpuPct != null ? (
          <UsageBar used={server.cpuPct} total={100} label="CPU" />
        ) : (
          <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>CPU —</div>
        )}
      </div>

      {/* Sessions — a utilization bar when capacity is known, else the raw N/M text */}
      <div>
        {utilPct != null ? (
          <>
            <UsageBar used={activeSessions ?? 0} total={maxConcurrentSessions ?? 0} label="Sessions" />
            <div style={{ fontSize: '0.625rem', color: 'var(--color-text-muted)', marginTop: '2px' }}>
              {activeSessions} / {maxConcurrentSessions} ({utilPct}%)
            </div>
          </>
        ) : (
          <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>
            Sessions: {activeSessions ?? '?'}/{maxConcurrentSessions ?? '?'}
          </div>
        )}
      </div>

      {/* Memory pressure (text, not a byte-based bar) */}
      <div>
        <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>
          Mem pressure: {memoryPressure != null ? `${memoryPressure}%` : '—'}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Server card
// ---------------------------------------------------------------------------

function AgentServerResourceBars({ server }: { server: ServerHealthSnapshot }) {
  // Nomad reports a node's total memory but not its live used-memory, so memory is shown
  // as total size (not a 0%-used bar, which would read as an idle node). CPU% is not
  // available from Nomad either.
  const allocations = server.metadata['nomadAllocations'];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}>
      <div>
        <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>CPU —</div>
      </div>
      <div>
        <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>
          Node memory: {server.memory.totalBytes > 0 ? fmtBytes(server.memory.totalBytes) : '—'}
        </div>
      </div>
      <div>
        <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-muted)' }}>
          Allocations: {typeof allocations === 'number' ? allocations : '—'}
        </div>
      </div>
    </div>
  );
}

function SaturatedBadge() {
  return (
    <span
      style={{
        fontSize: '0.625rem',
        fontWeight: '600',
        background: 'var(--color-danger)',
        color: 'var(--color-on-danger, #fff)',
        padding: '1px 8px',
        borderRadius: '10px',
        textTransform: 'uppercase',
        letterSpacing: '0.03em',
      }}
    >
      At capacity
    </span>
  );
}

function ServerCard({ server }: { server: ServerHealthSnapshot }) {
  const saturated = server.serverType === 'browser-pool'
    && isBrowserNodeSaturated(readBrowserPoolMetrics(server.metadata));

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Header: ID + hostname + version + uptime */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.8125rem', fontWeight: '600' }}>
            {server.serverId}
          </span>
          {server.hostname !== server.serverId && (
            <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
              {server.hostname}
            </span>
          )}
          {saturated && <SaturatedBadge />}
        </div>
        <div style={{ display: 'flex', gap: '12px', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
          <span>v{server.version}</span>
          {/* Nomad does not report node uptime, so agent-server uses 0 as a sentinel we hide. */}
          {!(server.serverType === 'agent-server' && server.uptimeSeconds === 0) && (
            <span>Up {fmtUptime(server.uptimeSeconds)}</span>
          )}
        </div>
      </div>

      {/* Resource bars — specialized layouts for browser-pool and agent-server */}
      {server.serverType === 'browser-pool' ? (
        <BrowserPoolResourceBars server={server} />
      ) : server.serverType === 'agent-server' ? (
        <AgentServerResourceBars server={server} />
      ) : (
        <StandardResourceBars server={server} />
      )}

      {/* Type-specific metadata — agent-server shows its figures in the bars above */}
      {server.serverType !== 'agent-server' && renderMetadata(server.serverType, server.metadata)}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main section component
// ---------------------------------------------------------------------------

function BrowserPoolSummaryLine({ servers }: { servers: ServerHealthSnapshot[] }) {
  const summary = summarizeBrowserPool(servers);
  if (summary.instanceCount === 0) return null;

  const parts: string[] = [];
  if (summary.utilizationPct != null) {
    parts.push(`${summary.totalActiveSessions}/${summary.totalMaxSessions} sessions (${summary.utilizationPct}%)`);
  } else {
    parts.push(`${summary.totalActiveSessions} sessions`);
  }
  parts.push(`${summary.totalQueued} queued`);
  parts.push(`${summary.totalRejected} rejected`);
  parts.push(`${summary.availableCount}/${summary.instanceCount} available`);

  return (
    <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
      {parts.join(' · ')}
    </span>
  );
}

export function AdminServersSection({ data }: { data: AdminServersResponse }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {ORDERED_TYPES.map((type) => {
        const servers = data.servers[type] ?? [];
        const label = SERVER_TYPE_LABELS[type] ?? type;

        return (
          <div key={type}>
            {/* Group heading with count badge, plus a pool summary for browser-pool */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
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
              {type === 'browser-pool' && <BrowserPoolSummaryLine servers={servers} />}
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
