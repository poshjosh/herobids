import type { AdminContainer, AdminSession } from '../../lib/api-client.js';
import { Card, EmptyState } from '../../lib/ui.js';

interface Props {
  containers: AdminContainer[] | null;
  sessions: AdminSession[];
  dockerError?: string;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function sessionStatusColor(status: string): string {
  switch (status) {
    case 'running': return 'var(--color-success)';
    case 'starting':
    case 'launching': return 'var(--color-warning)';
    case 'unhealthy': return 'var(--color-danger)';
    default: return 'var(--color-text-muted)';
  }
}

export function AdminRuntimeSection({ containers, sessions, dockerError }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Containers table */}
      <Card style={{ padding: 0 }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border-subtle)', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '14px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
            Running Containers
          </span>
          <span style={{ padding: '2px 8px', borderRadius: '20px', fontSize: '11px', fontWeight: '600', background: 'var(--color-surface-3)', color: 'var(--color-text-muted)' }}>
            {containers == null ? '—' : containers.length}
          </span>
        </div>

        {dockerError === 'docker_unavailable' ? (
          <EmptyState
            title="Docker unavailable"
            message="The Docker socket is not accessible. Container data is unavailable in this environment. Mount /var/run/docker.sock in the API container to enable this view."
          />
        ) : containers == null || containers.length === 0 ? (
          <EmptyState title="No containers" message="No running containers found." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--color-surface-2)' }}>
                  <Th>Name</Th>
                  <Th>Image</Th>
                  <Th>State</Th>
                  <Th>Status</Th>
                  <Th>Writable Layer</Th>
                </tr>
              </thead>
              <tbody>
                {containers.map((c) => (
                  <tr key={c.Id} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                    <Td>
                      <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                        {(c.Names[0] ?? c.Id.slice(0, 12)).replace(/^\//, '')}
                      </span>
                    </Td>
                    <Td>{c.Image}</Td>
                    <Td>
                      <span
                        style={{
                          color: c.State === 'running' ? 'var(--color-success)' : 'var(--color-text-muted)',
                          fontWeight: '500',
                        }}
                      >
                        {c.State}
                      </span>
                    </Td>
                    <Td>
                      <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{c.Status}</span>
                    </Td>
                    <Td>
                      {c.SizeRw != null
                        ? <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{fmtBytes(c.SizeRw)}</span>
                        : <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>—</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Agent runtime sessions */}
      <Card style={{ padding: 0 }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border-subtle)', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '14px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
            Active Agent Sessions
          </span>
          <span style={{ padding: '2px 8px', borderRadius: '20px', fontSize: '11px', fontWeight: '600', background: 'var(--color-surface-3)', color: 'var(--color-text-muted)' }}>
            {sessions.length}
          </span>
        </div>

        {sessions.length === 0 ? (
          <EmptyState
            title="No active sessions"
            message={dockerError === 'docker_unavailable'
              ? "No agent runtime sessions found. If agents are running, check that the worker is processing heartbeats and sessions are transitioning to 'running' status."
              : "No agent runtime sessions are currently running. Sessions may be starting up — they will appear here once the agent sends its first heartbeat."}
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--color-surface-2)' }}>
                  <Th>Agent</Th>
                  <Th>Session ID</Th>
                  <Th>Status</Th>
                  <Th>CPU %</Th>
                  <Th>Memory</Th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                    <Td>
                      <span style={{ fontWeight: '500' }}>
                        {s.agentName ?? s.agentId.slice(0, 8) + '…'}
                      </span>
                    </Td>
                    <Td>
                      <span style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--color-text-muted)' }}>
                        {s.id.slice(0, 8)}…
                      </span>
                    </Td>
                    <Td>
                      <span style={{ color: sessionStatusColor(s.status), fontWeight: '500', textTransform: 'capitalize' }}>
                        {s.status}
                      </span>
                    </Td>
                    <Td>{s.cpuPct != null ? `${s.cpuPct.toFixed(1)}%` : '—'}</Td>
                    <Td>
                      {s.memoryBytes != null
                        ? fmtBytes(s.memoryBytes)
                        : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: '600', color: 'var(--color-text-secondary)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td style={{ padding: '10px 16px', color: 'var(--color-text-primary)', verticalAlign: 'middle' }}>
      {children}
    </td>
  );
}
