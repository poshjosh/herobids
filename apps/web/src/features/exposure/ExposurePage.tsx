import { useQuery } from '@tanstack/react-query';
import Decimal from 'decimal.js';
import { dashboard, bots as botsApi } from '../../lib/api-client.js';
import { formatPnl, pnlColor } from '../../lib/formatting.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, SectionLabel, KV } from '../../lib/ui.js';

export function ExposurePage() {
  const overviewQuery = useQuery({
    queryKey: ['dashboard', 'overview'],
    queryFn: () => dashboard.overview(),
  });

  const overview = overviewQuery.data;
  // Include ALL instances that have open positions — not just running ones.
  // A crashed or manually-stopped agent can still hold open positions that represent
  // real risk and must remain visible.
  const instancesWithPositions = overview?.bots.filter((i) => i.openPositionsCount > 0) ?? [];

  return (
    <PageShell>
      <PageHeader
        title="Exposure"
        subtitle="Current positions and risk concentration"
      />

      {overviewQuery.isLoading && <LoadingRows count={3} />}
      {overviewQuery.isError && (
        <ErrorState
          message={(overviewQuery.error as Error).message}
          onRetry={() => void overviewQuery.refetch()}
        />
      )}

      {overview && instancesWithPositions.length === 0 && (
        <EmptyState
          title="No open positions"
          message="Positions will appear here once your AI agents start trading."
        />
      )}

      {overview && (
        <Card style={{ marginBottom: '24px', padding: '20px 24px' }}>
          <div style={{ display: 'flex', gap: '32px' }}>
            <KV
              label="Total Realized P&L"
              value={
                <span style={{ color: pnlColor(overview.summary.totalRealizedPnl), fontWeight: '600', fontSize: '18px' }}>
                  {formatPnl(overview.summary.totalRealizedPnl)}
                </span>
              }
            />
            <KV label="Open Positions" value={overview.summary.totalOpenPositions} />
          </div>
        </Card>
      )}

      {overview && instancesWithPositions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {instancesWithPositions.map((inst) => (
            <InstancePositions key={inst.id} instanceId={inst.id} instanceLabel={`${inst.venue} · ${inst.symbol}${inst.status !== 'running' ? ` (${inst.status})` : ''}`} />
          ))}
        </div>
      )}
    </PageShell>
  );
}

function InstancePositions({ instanceId, instanceLabel }: { instanceId: string; instanceLabel: string }) {
  const query = useQuery({
    queryKey: ['bots', instanceId, 'positions', 'open'],
    queryFn: () => botsApi.openPositions(instanceId),
  });

  const positions = query.data?.positions ?? [];

  return (
    <div>
      <SectionLabel>{instanceLabel}</SectionLabel>
      {query.isLoading && <LoadingRows count={2} />}
      {query.isError && <ErrorState message={(query.error as Error).message} />}
      {query.isSuccess && positions.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)', fontSize: '14px', padding: '12px 0' }}>No open positions</div>
      )}
      {query.isSuccess && positions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {positions.map((pos) => (
            <Card key={pos.id} style={{ padding: '14px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <span style={{ fontWeight: '600', marginRight: '8px' }}>{pos.symbol}</span>
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: '500',
                      background: pos.side === 'long' ? 'var(--color-success-subtle)' : 'var(--color-danger-subtle)',
                      color: pos.side === 'long' ? 'var(--color-success)' : 'var(--color-danger)',
                    }}
                  >
                    {pos.side.toUpperCase()}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '24px', textAlign: 'right' }}>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>Size</div>
                    <div style={{ fontSize: '14px', fontWeight: '500' }}>{new Decimal(pos.size).toFixed(4)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>Entry</div>
                    <div style={{ fontSize: '14px', fontWeight: '500' }}>${new Decimal(pos.entryPrice).toFixed(2)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>Realized P&L</div>
                    <div
                      style={{
                        fontSize: '14px',
                        fontWeight: '500',
                        color: new Decimal(pos.realizedPnl).gte(0) ? 'var(--color-success)' : 'var(--color-danger)',
                      }}
                    >
                      {new Decimal(pos.realizedPnl).gte(0) ? '+' : ''}
                      {new Decimal(pos.realizedPnl).toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
