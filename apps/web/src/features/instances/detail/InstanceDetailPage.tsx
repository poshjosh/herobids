import { useParams, useNavigate } from 'react-router';
import Decimal from 'decimal.js';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { instances as instancesApi, journal, type ActivityEvent } from '../../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, Button, StatusBadge, KV, SectionLabel } from '../../../lib/ui.js';
import { TimelineEvent } from '../../timeline/TimelineEvent.js';

export function InstanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const instanceQuery = useQuery({
    queryKey: ['instances', id],
    queryFn: () => instancesApi.get(id!),
    enabled: Boolean(id),
  });

  const positionsQuery = useQuery({
    queryKey: ['instances', id, 'positions', 'open'],
    queryFn: () => instancesApi.openPositions(id!),
    // Fetch regardless of status — a stopped or crashed agent may still hold open positions
    enabled: Boolean(id),
  });

  const liveStatusQuery = useQuery({
    queryKey: ['instances', id, 'live-status'],
    queryFn: () => instancesApi.liveStatus(id!),
    enabled: Boolean(id) && instanceQuery.data?.status === 'running',
    refetchInterval: 15_000,
  });

  const journalQuery = useQuery({
    queryKey: ['journal', id, { limit: 30 }],
    queryFn: () => journal.query({ tradingInstanceId: id!, limit: 30 }),
    enabled: Boolean(id),
  });

  const startMutation = useMutation({
    mutationFn: () => instancesApi.start(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['instances'] });
      void qc.invalidateQueries({ queryKey: ['dashboard', 'overview'] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => instancesApi.stop(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['instances'] });
      void qc.invalidateQueries({ queryKey: ['dashboard', 'overview'] });
    },
  });

  const inst = instanceQuery.data;

  if (instanceQuery.isLoading) {
    return <PageShell><LoadingRows count={4} /></PageShell>;
  }

  if (instanceQuery.isError) {
    return (
      <PageShell>
        <ErrorState message={(instanceQuery.error as Error).message} onRetry={() => void instanceQuery.refetch()} />
      </PageShell>
    );
  }

  if (!inst) {
    return (
      <PageShell>
        <EmptyState title="Agent not found" message="This agent does not exist or you don't have access." />
      </PageShell>
    );
  }

  const config = inst.config as Record<string, unknown>;
  const execConfig = config['execution'] as Record<string, unknown> | undefined;
  const execMode = (execConfig?.['mode'] as string | undefined) ?? 'paper';
  const symbol = (config['symbol'] as string | undefined) ?? '';

  // Map journal events to activity event shape for timeline display
  const timelineEvents: ActivityEvent[] = (journalQuery.data?.events ?? []).map((ev) => ({
    id: ev.id,
    tradingInstanceId: ev.tradingInstanceId,
    instanceLabel: null,
    type: ev.type,
    category: inferCategory(ev.type),
    severity: inferSeverity(ev.type),
    message: ev.type,
    timestamp: ev.createdAt,
    detail: ev.payload,
  }));

  return (
    <PageShell>
      <PageHeader
        title={`${symbol || inst.strategyId}`}
        subtitle={inst.strategyId}
        action={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Button variant="ghost" size="sm" onClick={() => navigate('/instances')}>← Back</Button>
            {inst.status === 'stopped' || inst.status === 'crashed' ? (
              <Button variant="primary" size="sm" onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
                {startMutation.isPending ? 'Starting…' : 'Start'}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => stopMutation.mutate()} disabled={stopMutation.isPending}>
                {stopMutation.isPending ? 'Stopping…' : 'Stop'}
              </Button>
            )}
          </div>
        }
      />

      {/* Status row */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '28px', flexWrap: 'wrap' }}>
        <StatusBadge status={inst.status} />
        <span
          style={{
            padding: '3px 8px',
            borderRadius: '20px',
            background: 'var(--color-surface-2)',
            fontSize: '12px',
            color: 'var(--color-text-secondary)',
          }}
        >
          {execMode} mode
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '24px', alignItems: 'start' }}>
        {/* Left: timeline */}
        <div>
          <SectionLabel>Timeline</SectionLabel>
          {journalQuery.isLoading && <LoadingRows count={4} />}
          {journalQuery.isSuccess && timelineEvents.length === 0 && (
            <EmptyState title="No events yet" message="Events will appear here once the agent starts trading." />
          )}
          {journalQuery.isSuccess && timelineEvents.length > 0 && (
            <div>
              {timelineEvents.map((ev, i) => (
                <TimelineEvent key={ev.id} event={ev} isLast={i === timelineEvents.length - 1} />
              ))}
            </div>
          )}
        </div>

        {/* Right: sidebar info */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Config summary */}
          <Card>
            <SectionLabel>Configuration</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <KV label="Strategy" value={inst.strategyId} />
              <KV label="Symbol" value={symbol || '—'} />
              <KV label="Execution mode" value={execMode} />
              <KV label="Config version" value={inst.configVersion} />
            </div>
          </Card>

            {/* Open positions — shown for all statuses; stopped/crashed agents may still hold positions */}
            <Card>
              <SectionLabel>Open positions</SectionLabel>
              {positionsQuery.isLoading && <LoadingRows count={2} />}
              {positionsQuery.isSuccess && (positionsQuery.data?.positions.length ?? 0) === 0 && (
                <div style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>No open positions</div>
              )}
              {positionsQuery.isSuccess && (positionsQuery.data?.positions.length ?? 0) > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {positionsQuery.data!.positions.map((pos) => (
                    <div key={pos.id} style={{ padding: '10px 12px', background: 'var(--color-surface-2)', borderRadius: '6px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <span style={{ fontWeight: '500', fontSize: '13px' }}>{pos.symbol}</span>
                        <span style={{ fontSize: '11px', color: pos.side === 'long' ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: '600', textTransform: 'uppercase' }}>
                          {pos.side}
                        </span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--color-text-muted)' }}>
                        <span>{new Decimal(pos.size).toFixed(4)} @ ${new Decimal(pos.entryPrice).toFixed(2)}</span>
                        <span style={{ color: new Decimal(pos.realizedPnl).gte(0) ? 'var(--color-success)' : 'var(--color-danger)' }}>
                          {new Decimal(pos.realizedPnl).gte(0) ? '+' : ''}{new Decimal(pos.realizedPnl).toFixed(2)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

          {/* Live status */}
          {inst.status === 'running' && liveStatusQuery.data && (
            <Card>
              <SectionLabel>Live status</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {liveStatusQuery.data.lastReconciliation && (
                  <KV
                    label="Last reconciliation"
                    value={
                      <span style={{ color: liveStatusQuery.data.lastReconciliation.result === 'match' ? 'var(--color-success)' : 'var(--color-warning)' }}>
                        {liveStatusQuery.data.lastReconciliation.result}
                      </span>
                    }
                  />
                )}
                <KV label="Open orders" value={liveStatusQuery.data.openOrders.length} />
              </div>
            </Card>
          )}
        </div>
      </div>
    </PageShell>
  );
}

type EventCategory = 'decision' | 'execution' | 'risk' | 'system';
type EventSeverity = 'info' | 'warn' | 'critical';

function inferCategory(type: string): EventCategory {
  const prefix = type.split('.')[0] ?? '';
  if (prefix === 'decision') return 'decision';
  if (prefix === 'risk') return 'risk';
  if (prefix === 'order' || prefix === 'fill' || prefix === 'live') return 'execution';
  return 'system';
}

function inferSeverity(type: string): EventSeverity {
  if (type.includes('crash') || type.includes('breach') || type.includes('critical')) return 'critical';
  if (type.includes('blocked') || type.includes('rejected') || type.includes('alert') || type.includes('drift')) return 'warn';
  return 'info';
}
