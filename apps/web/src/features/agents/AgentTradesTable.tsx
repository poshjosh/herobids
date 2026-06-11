import { useQuery } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, type AgentPosition } from '../../lib/api-client.js';
import { LoadingRows, ErrorState, RelativeTime } from '../../lib/ui.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { formatExecutionMode } from './agent-display.js';

function formatHoldMs(holdMs: number | null): string {
  if (holdMs === null) return '—';
  const totalMinutes = Math.floor(holdMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

interface Props {
  agentId: string;
  executionMode: string | null;
  isActive?: boolean;
}

export function AgentTradesTable({ agentId, executionMode, isActive }: Props) {
  const intl = useIntl();

  const query = useQuery({
    queryKey: ['agents', agentId, 'trading-positions'],
    queryFn: () => agentsApi.tradingPositions(agentId, { limit: 50 }),
    refetchInterval: isActive ? 30_000 : false,
  });

  const colToken = intl.formatMessage({ id: 'agents.trades.col.token' });
  const colVenue = intl.formatMessage({ id: 'agents.trades.col.venue' });
  const colStatus = intl.formatMessage({ id: 'agents.trades.col.status' });
  const colEntry = intl.formatMessage({ id: 'agents.trades.col.entry' });
  const colExit = intl.formatMessage({ id: 'agents.trades.col.exit' });
  const colSize = intl.formatMessage({ id: 'agents.trades.col.size' });
  const colPnl = intl.formatMessage({ id: 'agents.trades.col.pnl' });
  const colHold = intl.formatMessage({ id: 'agents.trades.col.hold' });
  const colMode = intl.formatMessage({ id: 'agents.trades.col.mode' });
  const colTime = intl.formatMessage({ id: 'agents.trades.col.time' });

  if (query.isLoading) return <LoadingRows count={5} />;

  if (query.isError) {
    return (
      <ErrorState
        message={localizeApiError(intl, query.error, 'common.errorTitle')}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const items = query.data?.items ?? [];

  if (items.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: '13px', color: 'var(--color-text-muted)' }}>
        {intl.formatMessage({ id: 'agents.trades.empty' })}
      </p>
    );
  }

  const modeLabel = formatExecutionMode(executionMode, intl);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--color-border)', textAlign: 'left' }}>
            {[colToken, colVenue, colStatus, colEntry, colExit, colSize, colPnl, colHold, colMode, colTime].map((col) => (
              <th
                key={col}
                style={{ padding: '6px 10px', fontWeight: '600', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((row: AgentPosition) => {
            const pnlNum = parseFloat(row.realizedPnl);
            const pnlColor = pnlNum > 0 ? 'var(--color-success)' : pnlNum < 0 ? 'var(--color-error)' : 'var(--color-text)';
            const statusLabel = row.status === 'open'
              ? intl.formatMessage({ id: 'agents.trades.statusOpen' })
              : intl.formatMessage({ id: 'agents.trades.statusClosed' });

            return (
              <tr key={row.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>{row.symbol}</td>
                <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>{row.venue}</td>
                <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                  <span
                    style={{
                      padding: '2px 7px',
                      borderRadius: '12px',
                      fontSize: '11px',
                      fontWeight: '600',
                      background: row.status === 'open' ? 'var(--color-success-subtle)' : 'var(--color-surface-2)',
                      color: row.status === 'open' ? 'var(--color-success)' : 'var(--color-text-muted)',
                    }}
                  >
                    {statusLabel}
                  </span>
                </td>
                <td style={{ padding: '7px 10px', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>{row.entryPrice}</td>
                <td style={{ padding: '7px 10px', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>{row.exitPrice ?? '—'}</td>
                <td style={{ padding: '7px 10px', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>{row.size}</td>
                <td style={{ padding: '7px 10px', whiteSpace: 'nowrap', fontFamily: 'monospace', color: pnlColor }}>{row.realizedPnl}</td>
                <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>{formatHoldMs(row.holdMs)}</td>
                <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>{modeLabel}</td>
                <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}><RelativeTime timestamp={row.openedAt} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
