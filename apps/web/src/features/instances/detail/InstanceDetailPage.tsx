import { useCallback, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import Decimal from 'decimal.js';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { bots as botsApi, journal, type ActivityEvent, ApiError } from '../../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, ErrorBanner, EmptyState, Button, StatusBadge, KV, SectionLabel, Modal } from '../../../lib/ui.js';
import { TimelineEvent } from '../../timeline/TimelineEvent.js';
import { useEventStream, type UserEvent } from '../../../lib/useEventStream.js';

export function InstanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Invalidate bot data when a real-time status event arrives for this bot
  const handleEvent = useCallback((event: UserEvent) => {
    if (event.type === 'bot.status' && event.botId === id) {
      void qc.invalidateQueries({ queryKey: ['bots', id] });
      void qc.invalidateQueries({ queryKey: ['bots'] });
      void qc.invalidateQueries({ queryKey: ['dashboard', 'overview'] });
    } else if (event.type === 'order.filled' && event.botId === id) {
      void qc.invalidateQueries({ queryKey: ['bots', id, 'positions', 'open'] });
      void qc.invalidateQueries({ queryKey: ['journal', id] });
    }
  }, [id, qc]);
  useEventStream(handleEvent);

  const instanceQuery = useQuery({
    queryKey: ['bots', id],
    queryFn: () => botsApi.get(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status as string | undefined;
      // Keep a slow fallback poll for running/starting bots; WebSocket handles real-time updates
      return status === 'running' || status === 'starting' ? 30_000 : false;
    },
  });

  const positionsQuery = useQuery({
    queryKey: ['bots', id, 'positions', 'open'],
    queryFn: () => botsApi.openPositions(id!),
    // Fetch regardless of status — a stopped or crashed agent may still hold open positions
    enabled: Boolean(id),
  });

  const journalQuery = useQuery({
    queryKey: ['journal', id, { limit: 30 }],
    queryFn: () => journal.query({ actorId: id!, limit: 30 }),
    enabled: Boolean(id),
  });

  const inst = instanceQuery.data;

  // ── Lifecycle mutation hooks ───────────────────────────────────────
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const stopMutation = useMutation({
    mutationFn: () => botsApi.stop(id!),
    onSuccess: () => {
      setLifecycleError(null);
      void qc.invalidateQueries({ queryKey: ['bots', id] });
      void qc.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: (err: Error) => setLifecycleError(err.message),
  });

  const startMutation = useMutation({
    mutationFn: () => botsApi.start(id!),
    onSuccess: () => {
      setLifecycleError(null);
      void qc.invalidateQueries({ queryKey: ['bots', id] });
      void qc.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: (err: Error) => setLifecycleError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => botsApi.delete(id!),
    onSuccess: () => {
      setLifecycleError(null);
      void qc.invalidateQueries({ queryKey: ['bots'] });
      navigate('/bots');
    },
    onError: (err: Error) => setLifecycleError(err.message),
  });

  if (instanceQuery.isLoading) {
    return <PageShell><LoadingRows count={4} /></PageShell>;
  }

  if (instanceQuery.isError) {
    const err = instanceQuery.error;
    if (err instanceof ApiError && err.code === 'not_found') {
      return (
        <PageShell>
          <EmptyState
            title="Bot not found"
            message="This bot does not exist or you don't have access."
            action={<Button variant="ghost" size="sm" onClick={() => navigate('/bots')}>← Back to bots</Button>}
          />
        </PageShell>
      );
    }
    return (
      <PageShell>
        <ErrorState message={(err as Error).message} onRetry={() => void instanceQuery.refetch()} />
      </PageShell>
    );
  }

  if (!inst) {
    return (
      <PageShell>
        <EmptyState
          title="Bot not found"
          message="This bot does not exist or you don't have access."
          action={<Button variant="ghost" size="sm" onClick={() => navigate('/bots')}>← Back to bots</Button>}
        />
      </PageShell>
    );
  }

  const config = inst.config as Record<string, unknown>;
  const execConfig = config['execution'] as Record<string, unknown> | undefined;
  const execMode = (execConfig?.['mode'] as string | undefined) ?? 'paper';
  const symbol = (config['symbol'] as string | undefined) ?? '';
  const strategyType = ((config['strategy'] as Record<string, unknown> | undefined)?.['type'] as string | undefined) ?? '';

  // Map journal events to activity event shape for timeline display
  const timelineEvents: ActivityEvent[] = (journalQuery.data?.events ?? []).map((ev) => ({
    id: ev.id,
    botId: ev.actorId,
    instanceLabel: null,
    type: ev.type,
    category: inferCategory(ev.type),
    severity: inferSeverity(ev.type),
    messageKey: `activity.${ev.type}`,
    timestamp: ev.createdAt,
    detail: ev.payload,
  }));

  return (
    <PageShell>
      <PageHeader
        title={`${symbol || strategyType || 'Bot'}`}
        subtitle={strategyType}
        action={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {(inst.status === 'running' || inst.status === 'starting') && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => setShowStopConfirm(true)}
                disabled={stopMutation.isPending}
              >
                {stopMutation.isPending ? 'Stopping…' : 'Stop'}
              </Button>
            )}
            {(inst.status === 'stopped' || inst.status === 'crashed') && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => startMutation.mutate()}
                disabled={startMutation.isPending}
              >
                {startMutation.isPending ? 'Starting…' : 'Start'}
              </Button>
            )}
            {(inst.status === 'stopped' || inst.status === 'crashed') && !startMutation.isPending && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => navigate('/bots')}>← Back</Button>
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

      {lifecycleError && (
        <div style={{ marginBottom: '16px' }}>
          <ErrorBanner message={lifecycleError} />
        </div>
      )}

      {inst.status === 'crashed' && (
        <div style={{ marginBottom: '16px' }}>
          <ErrorBanner message="This instance crashed during startup. Check the latest journal events and verify the linked venue account and credential before retrying." />
        </div>
      )}

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
              <KV label="Strategy" value={strategyType || '—'} />
              <KV label="Symbol" value={symbol || '—'} />
              <KV label="Execution mode" value={execMode} />
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
        </div>
      </div>
      {/* ── Confirmation Modals ──────────────────────────────────── */}
      {showStopConfirm && (
        <Modal title="Stop bot?" onClose={() => setShowStopConfirm(false)}>
          <p style={{ margin: '0 0 8px', color: 'var(--color-text-secondary)', fontSize: '14px' }}>
            The bot will stop scanning but any open positions will remain in your portfolio.
            You can restart it later.
          </p>
          {positionsQuery.data && (positionsQuery.data.positions.length ?? 0) > 0 && (
            <p style={{ margin: '0 0 16px', color: 'var(--color-warning)', fontSize: '13px' }}>
              ⚠ You have {positionsQuery.data.positions.length} open position{positionsQuery.data.positions.length !== 1 ? 's' : ''}.
            </p>
          )}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
            <Button variant="ghost" size="sm" onClick={() => setShowStopConfirm(false)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={() => { setShowStopConfirm(false); stopMutation.mutate(); }}>
              Stop bot
            </Button>
          </div>
        </Modal>
      )}

      {showDeleteConfirm && (
        <Modal title="Delete bot?" onClose={() => setShowDeleteConfirm(false)}>
          <p style={{ margin: '0 0 8px', color: 'var(--color-text-secondary)', fontSize: '14px' }}>
            This action is irreversible. The bot will be permanently deleted. Its trade records and
            event history will be preserved in the database but will no longer be linked to a bot.
          </p>
          {positionsQuery.data && (positionsQuery.data.positions.length ?? 0) > 0 && (
            <p style={{ margin: '0 0 16px', color: 'var(--color-warning)', fontSize: '13px' }}>
              ⚠ You have {positionsQuery.data.positions.length} open position{positionsQuery.data.positions.length !== 1 ? 's' : ''}.
              These positions will remain in the exchange but will no longer be tracked by this bot.
            </p>
          )}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
            <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={() => { setShowDeleteConfirm(false); deleteMutation.mutate(); }}>
              Delete permanently
            </Button>
          </div>
        </Modal>
      )}
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
