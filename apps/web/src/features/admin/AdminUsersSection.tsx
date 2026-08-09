import { useState } from 'react';
import type { AdminUserRow } from '../../lib/api-client.js';
import { Card, Button, EmptyState, inputStyle } from '../../lib/ui.js';

interface Props {
  users: AdminUserRow[];
  onPromote: (id: string) => void;
  onRevoke: (id: string) => void;
  mutationPending: boolean;
}

export function AdminUsersSection({ users, onPromote, onRevoke, mutationPending }: Props) {
  const PAGE_SIZE = 50;
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);

  const visible = filter
    ? users.filter(
        (u) =>
          u.email.toLowerCase().includes(filter.toLowerCase()) ||
          (u.displayName ?? '').toLowerCase().includes(filter.toLowerCase()),
      )
    : users;

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const paged = visible.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  function handleFilterChange(value: string) {
    setFilter(value);
    setPage(0);
  }

  return (
    <Card style={{ padding: 0 }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-subtle)', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <input
          type="text"
          placeholder="Filter by email or name…"
          value={filter}
          onChange={(e) => handleFilterChange(e.target.value)}
          style={{ ...inputStyle, flex: 1, padding: '6px 10px', borderRadius: '6px', fontSize: '0.8125rem' }}
        />
        <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>{visible.length} users</span>
      </div>

      {paged.length === 0 ? (
        <EmptyState title="No users" message="No users match your filter." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
            <thead>
              <tr style={{ background: 'var(--color-surface-2)' }}>
                <Th>Email</Th>
                <Th>Display Name</Th>
                <Th>Plan</Th>
                <Th>Admin</Th>
                <Th>Agents</Th>
                <Th>Bots</Th>
                <Th>Created</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {paged.map((user) => (
                <tr key={user.id} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                  <Td>{user.email}</Td>
                  <Td>{user.displayName ?? '—'}</Td>
                  <Td><PlanBadge planId={user.planId} /></Td>
                  <Td>
                    {user.isAdmin ? (
                      <span style={{ color: 'var(--color-brand)', fontWeight: '500' }}>admin</span>
                    ) : (
                      <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                    )}
                  </Td>
                  <Td>{user.agentCount}</Td>
                  <Td>{user.botCount}</Td>
                  <Td>
                    <span style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
                      {new Date(user.createdAt).toLocaleString()}
                    </span>
                  </Td>
                  <Td>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {!user.isAdmin ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={mutationPending}
                          onClick={() => onPromote(user.id)}
                        >
                          Promote
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={mutationPending}
                          onClick={() => onRevoke(user.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--color-border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Button size="sm" variant="secondary" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>
            Prev
          </Button>
          <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
            Page {clampedPage + 1} of {totalPages}
          </span>
          <Button size="sm" variant="secondary" disabled={clampedPage >= totalPages - 1} onClick={() => setPage(clampedPage + 1)}>
            Next
          </Button>
        </div>
      )}
    </Card>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: '600', color: 'var(--color-text-secondary)', fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
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

function PlanBadge({ planId }: { planId: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 7px',
        borderRadius: '4px',
        fontSize: '0.6875rem',
        fontWeight: '500',
        background: 'var(--color-surface-3)',
        color: 'var(--color-text-secondary)',
      }}
    >
      {planId}
    </span>
  );
}
