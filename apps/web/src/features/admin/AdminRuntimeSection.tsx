import type { AdminContainer, AdminSession } from '../../lib/api-client.js';
import { Card, EmptyState } from '../../lib/ui.js';

interface Props {
  containers: AdminContainer[] | null;
  sessions: AdminSession[];
  dockerError?: string;
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
            message="The Docker socket is not accessible. Container data is unavailable in this environment."
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
            Running Agent Sessions
          </span>
          <span style={{ padding: '2px 8px', borderRadius: '20px', fontSize: '11px', fontWeight: '600', background: 'var(--color-surface-3)', color: 'var(--color-text-muted)' }}>
            {sessions.length}
          </span>
        </div>

        {sessions.length === 0 ? (
          <EmptyState title="No active sessions" message="No agent runtime sessions are currently running." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--color-surface-2)' }}>
                  <Th>Session ID</Th>
                  <Th>Agent ID</Th>
                  <Th>Status</Th>
                  <Th>CPU %</Th>
                  <Th>Memory (MB)</Th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                    <Td>
                      <span style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--color-text-muted)' }}>
                        {s.id.slice(0, 8)}…
                      </span>
                    </Td>
                    <Td>
                      <span style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--color-text-muted)' }}>
                        {s.agentId.slice(0, 8)}…
                      </span>
                    </Td>
                    <Td>
                      <span style={{ color: 'var(--color-success)', fontWeight: '500' }}>{s.status}</span>
                    </Td>
                    <Td>{s.cpuPct != null ? `${s.cpuPct.toFixed(1)}%` : '—'}</Td>
                    <Td>
                      {s.memoryBytes != null
                        ? `${(s.memoryBytes / 1_048_576).toFixed(1)} MB`
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
