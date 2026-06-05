import { useQuery } from '@tanstack/react-query';
import Decimal from 'decimal.js';
import { dashboard, bots as botsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, KV, StatusBadge, SectionLabel } from '../../lib/ui.js';

export function OutcomeBoardPage() {
  const overviewQuery = useQuery({
    queryKey: ['dashboard', 'overview'],
    queryFn: () => dashboard.overview(),
  });

  const overview = overviewQuery.data;

  return (
    <PageShell>
      <PageHeader
        title="Outcome Board"
        subtitle="Whether your agents are succeeding"
      />

      {overviewQuery.isLoading && <LoadingRows count={3} />}
      {overviewQuery.isError && (
        <ErrorState
          message={(overviewQuery.error as Error).message}
          onRetry={() => void overviewQuery.refetch()}
        />
      )}

      {overview && overview.bots.length === 0 && (
        <EmptyState
          title="No agents yet"
          message="Create a trading agent to see outcome metrics here."
        />
      )}

      {overview && overview.bots.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Summary scorecard */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: '12px',
            }}
          >
            <ScoreCard label="Total agents" value={overview.summary.totalBots} />
            <ScoreCard label="Running" value={overview.summary.runningBots} highlight />
            <ScoreCard label="Open positions" value={overview.summary.totalOpenPositions} />
            <ScoreCard label="Plan" value={overview.user.planId} />
          </div>

          {/* Per-agent outcomes */}
          <SectionLabel>Per-agent results</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {overview.bots.map((inst) => (
              <AgentOutcomeRow key={inst.id} instance={inst} />
            ))}
          </div>
        </div>
      )}
    </PageShell>
  );
}

function ScoreCard({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <Card style={{ padding: '16px 20px' }}>
      <div style={{ fontSize: '11px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
        {label}
      </div>
      <div
        style={{
          fontSize: '28px',
          fontWeight: '700',
          color: highlight ? 'var(--color-brand)' : 'var(--color-text-primary)',
        }}
      >
        {value}
      </div>
    </Card>
  );
}

function AgentOutcomeRow({ instance }: { instance: { id: string; status: string; venue: string; symbol: string; openPositionsCount: number; startedAt: string | null } }) {
  const positionsQuery = useQuery({
    queryKey: ['bots', instance.id, 'positions', 'open'],
    queryFn: () => botsApi.openPositions(instance.id),
    // Fetch for all statuses — stopped/crashed agents may still hold open positions
    enabled: instance.openPositionsCount > 0,
  });

  const positions = positionsQuery.data?.positions ?? [];
  // Use Decimal to avoid IEEE-754 accumulation errors when summing P&L across positions
  const totalRealizedPnl = positions.reduce((sum, p) => sum.plus(p.realizedPnl || '0'), new Decimal(0));
  const pnlSign = totalRealizedPnl.gte(0);
  const pnlDisplay = totalRealizedPnl.toFixed(2);

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <span style={{ fontSize: '15px', fontWeight: '600' }}>
              {instance.venue} · {instance.symbol || '—'}
            </span>
            <StatusBadge status={instance.status} />
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{instance.venueLabel || instance.venue}</div>
        </div>

        <div style={{ display: 'flex', gap: '28px' }}>
          <KV label="Open positions" value={instance.openPositionsCount} />
          {positionsQuery.isSuccess && positions.length > 0 && (
            <KV
              label="Realized P&L"
              value={
                <span style={{ color: pnlSign ? 'var(--color-success)' : 'var(--color-danger)' }}>
                  {pnlSign ? '+' : ''}
                  {pnlDisplay}
                </span>
              }
            />
          )}
          {instance.startedAt && (
            <KV
              label="Running since"
              value={new Date(instance.startedAt).toLocaleDateString()}
            />
          )}
        </div>
      </div>
    </Card>
  );
}
