import { useState } from 'react';
import type { AdminWebhookRow } from '../../lib/api-client.js';
import { Card, Button, EmptyState } from '../../lib/ui.js';

interface Props {
  webhooks: AdminWebhookRow[];
}

export function AdminBillingSection({ webhooks }: Props) {
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);

  const totalPages = Math.max(1, Math.ceil(webhooks.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const paged = webhooks.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  return (
    <Card style={{ padding: 0 }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border-subtle)', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '14px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
          Failed Webhook Events
        </span>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: '20px',
            fontSize: '11px',
            fontWeight: '600',
            background: webhooks.length > 0 ? 'var(--color-warning-subtle)' : 'var(--color-surface-3)',
            color: webhooks.length > 0 ? 'var(--color-warning)' : 'var(--color-text-muted)',
          }}
        >
          {webhooks.length}
        </span>
      </div>

      {paged.length === 0 ? (
        <EmptyState title="No failed webhooks" message="All billing webhook events processed successfully." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: 'var(--color-surface-2)' }}>
                <Th>Event ID</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Error</Th>
                <Th>Processed At</Th>
              </tr>
            </thead>
            <tbody>
              {paged.map((wh) => (
                <tr key={wh.id} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                  <Td>
                    <span style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--color-text-muted)' }}>
                      {wh.id.slice(0, 20)}…
                    </span>
                  </Td>
                  <Td>{wh.eventType}</Td>
                  <Td>
                    <span style={{ color: 'var(--color-danger)', fontWeight: '500' }}>{wh.status}</span>
                  </Td>
                  <Td>
                    <span style={{ color: 'var(--color-text-secondary)', fontSize: '12px', maxWidth: '300px', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {wh.error ?? '—'}
                    </span>
                  </Td>
                  <Td>
                    <span style={{ color: 'var(--color-text-muted)', fontSize: '12px' }}>
                      {new Date(wh.processedAt).toLocaleString()}
                    </span>
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
          <span style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>
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
