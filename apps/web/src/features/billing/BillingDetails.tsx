import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import type {
  UsageBillingAccount,
  UsageBreakdownResponse,
  UsageEventsResponse,
  LedgerEntriesResponse,
  UsagePeriodsResponse,
  Agent,
} from '../../lib/api-client.js';
import { Card, LoadingRows, ErrorState, ErrorBanner, Button, inputStyle } from '../../lib/ui.js';
import { formatShortDate } from '../../lib/formatting.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

export function formatMicrousd(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(4)}`;
}

const LEDGER_ENTRY_TYPE_LABELS: Record<string, string> = {
  included_credit: 'Included credits',
  top_up_credit: 'Credit top-up',
  usage_charge: 'Usage charge',
  manual_adjustment: 'Manual adjustment',
  reversal: 'Reversal',
  reservation: 'Reservation',
  reservation_release: 'Reservation release',
  invoice_settlement: 'Invoice settlement',
};

const METER_LABELS: Record<string, string> = {
  'llm.input_tokens': 'llm input tokens',
  'llm.cached_input_tokens': 'llm cached input tokens',
  'llm.output_tokens': 'llm output tokens',
  'llm.reasoning_tokens': 'llm reasoning tokens',
  'agent.runtime_ms': 'agent runtime (milliseconds)',
  'assessment.request': 'strategy assessment',
};

function formatMeterLabel(meterKey: string): string {
  return METER_LABELS[meterKey] ?? meterKey;
}

interface BillingDetailsProps {
  // Spend Controls
  softCapInput: string;
  setSoftCapInput: (v: string) => void;
  hardCapInput: string;
  setHardCapInput: (v: string) => void;
  spendCapsError: string | null;
  setSpendCapsError: (v: string | null) => void;
  spendCapsMutation: UseMutationResult<
    { success: boolean; status: string },
    Error,
    { softCapCents?: number | null; hardCapCents?: number | null }
  >;
  usageAccount: UsageBillingAccount | null;

  // Usage Filters
  meterFilter: string;
  setMeterFilter: (v: string) => void;
  agentFilter: string;
  setAgentFilter: (v: string) => void;
  sessionFilter: string;
  setSessionFilter: (v: string) => void;
  periodFilter: string;
  setPeriodFilter: (v: string) => void;
  fromDate: string;
  setFromDate: (v: string) => void;
  toDate: string;
  setToDate: (v: string) => void;

  // Queries
  agentsQuery: UseQueryResult<Agent[]>;
  usageBreakdownQuery: UseQueryResult<UsageBreakdownResponse>;
  usageEventsQuery: UseQueryResult<UsageEventsResponse>;
  ledgerQuery: UseQueryResult<LedgerEntriesResponse>;
  periodsQuery: UseQueryResult<UsagePeriodsResponse>;

  // Ledger pagination + filter
  ledgerOffset: number;
  setLedgerOffset: (v: number) => void;
  ledgerDirectionFilter: string;
  setLedgerDirectionFilter: (v: string) => void;

  // Usage Events pagination
  usageEventOffset: number;
  setUsageEventOffset: (v: number) => void;

  // Pagination sizes
  usageEventsPageSize: number;
  ledgerPageSize: number;

  // i18n
  intl: ReturnType<typeof useIntl>;
  /** Only admins see ledger + usage events */
  isAdmin?: boolean;
}

export function BillingDetails({
  softCapInput,
  setSoftCapInput,
  hardCapInput,
  setHardCapInput,
  spendCapsError,
  setSpendCapsError,
  spendCapsMutation,
  usageAccount,
  meterFilter,
  setMeterFilter,
  agentFilter,
  setAgentFilter,
  sessionFilter,
  setSessionFilter,
  periodFilter,
  setPeriodFilter,
  fromDate,
  setFromDate,
  toDate,
  setToDate,
  agentsQuery,
  usageBreakdownQuery,
  usageEventsQuery,
  ledgerQuery,
  periodsQuery,
  ledgerOffset,
  setLedgerOffset,
  ledgerDirectionFilter,
  setLedgerDirectionFilter,
  usageEventOffset,
  setUsageEventOffset,
  usageEventsPageSize,
  ledgerPageSize,
  intl,
  isAdmin,
}: BillingDetailsProps) {
  const usageBreakdown = usageBreakdownQuery.data;
  const usageEvents = usageEventsQuery.data;
  const ledgerEntries = ledgerQuery.data;

  return (
    <>
      {/* Spend Controls — operator-only. See ADR-006: docs/tech/architecture/adrs/2026/08/006-spend-caps-operator-only.md */}
      {isAdmin && (
        <>
          <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '24px', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Spend Controls (Admin)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px', marginBottom: '10px' }}>
            <input
              value={softCapInput}
              onChange={(e) => setSoftCapInput(e.target.value)}
              placeholder="Soft cap (cents)"
              style={{ ...inputStyle, padding: '8px 10px', borderRadius: '6px' }}
            />
            <input
              value={hardCapInput}
              onChange={(e) => setHardCapInput(e.target.value)}
              placeholder="Hard cap (cents)"
              style={{ ...inputStyle, padding: '8px 10px', borderRadius: '6px' }}
            />
            <Button
              variant="secondary"
              disabled={spendCapsMutation.isPending || !usageAccount}
              onClick={() => {
                const soft = softCapInput.trim() === '' ? null : Number.parseInt(softCapInput, 10);
                const hard = hardCapInput.trim() === '' ? null : Number.parseInt(hardCapInput, 10);
                if ((soft != null && Number.isNaN(soft)) || (hard != null && Number.isNaN(hard))) return;
                spendCapsMutation.mutate({ softCapCents: soft, hardCapCents: hard });
              }}
            >
              {spendCapsMutation.isPending ? 'Saving...' : 'Update Spend Caps'}
            </Button>
          </div>
          {spendCapsError && (
            <ErrorBanner message={spendCapsError} onDismiss={() => setSpendCapsError(null)} />
          )}
        </>
      )}

      {/* Usage Filters */}
      <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: '16px' }}>
        Usage Filters
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
        <select
          value={meterFilter}
          onChange={(e) => { setMeterFilter(e.target.value); setUsageEventOffset(0); }}
          style={{ ...inputStyle, padding: '8px 10px', borderRadius: '6px', cursor: 'pointer' }}
        >
          <option value="">All meters</option>
          {Object.entries(METER_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>

        <select
          value={agentFilter}
          onChange={(e) => { setAgentFilter(e.target.value); setUsageEventOffset(0); }}
          style={{ ...inputStyle, padding: '8px 10px', borderRadius: '6px', cursor: 'pointer' }}
        >
          <option value="">All agents</option>
          {(agentsQuery.data ?? []).map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name}</option>
          ))}
        </select>

        <select
          value={periodFilter}
          onChange={(e) => { setPeriodFilter(e.target.value); setUsageEventOffset(0); }}
          style={{ ...inputStyle, padding: '8px 10px', borderRadius: '6px', cursor: 'pointer' }}
        >
          <option value="">All periods</option>
          {(periodsQuery.data?.periods ?? []).map((period) => (
            <option key={period.id} value={period.id}>
              {formatShortDate(intl, period.periodStart)} - {formatShortDate(intl, period.periodEnd)}
            </option>
          ))}
        </select>

        <input
          value={sessionFilter}
          onChange={(e) => { setSessionFilter(e.target.value); setUsageEventOffset(0); }}
          placeholder="Session ID"
          style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', color: 'var(--color-text-primary)' }}
        />

        <input
          type="date"
          value={fromDate}
          onChange={(e) => { setFromDate(e.target.value); setUsageEventOffset(0); }}
          style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', color: 'var(--color-text-primary)' }}
        />
        <input
          type="date"
          value={toDate}
          onChange={(e) => { setToDate(e.target.value); setUsageEventOffset(0); }}
          style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', color: 'var(--color-text-primary)' }}
        />
      </div>

      {/* By-meter breakdown */}
      <Card style={{ padding: '20px' }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Usage by Meter
        </div>
        {usageBreakdownQuery.isLoading && <LoadingRows count={3} />}
        {usageBreakdownQuery.isError && (
          <ErrorState
            message={localizeApiError(intl, usageBreakdownQuery.error, 'common.errorTitle')}
            onRetry={() => void usageBreakdownQuery.refetch()}
          />
        )}
        {usageBreakdown && usageBreakdown.byMeter.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '0.8125rem', padding: '24px 0' }}>
            {intl.formatMessage({ id: 'billing.usage.emptyBreakdown' })}
          </div>
        )}
        {usageBreakdown && usageBreakdown.byMeter.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Meter</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Quantity</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Charge</th>
              </tr>
            </thead>
            <tbody>
              {usageBreakdown.byMeter.map((row) => (
                <tr key={row.meterKey} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '8px' }}>{formatMeterLabel(row.meterKey)}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{row.quantity.toLocaleString()}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{formatMicrousd(row.chargeMicrousd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* By-agent breakdown */}
      <Card style={{ padding: '20px' }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Usage by Agent
        </div>
        {usageBreakdownQuery.isLoading && <LoadingRows count={3} />}
        {usageBreakdownQuery.isError && (
          <ErrorState
            message={localizeApiError(intl, usageBreakdownQuery.error, 'common.errorTitle')}
            onRetry={() => void usageBreakdownQuery.refetch()}
          />
        )}
        {usageBreakdown && usageBreakdown.byAgent.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '0.8125rem', padding: '24px 0' }}>
            {intl.formatMessage({ id: 'billing.usage.emptyBreakdown' })}
          </div>
        )}
        {usageBreakdown && usageBreakdown.byAgent.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Agent</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Quantity</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Charge</th>
              </tr>
            </thead>
            <tbody>
              {usageBreakdown.byAgent.map((row) => (
                <tr key={row.agentId} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '8px' }}>{row.agentName}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{row.quantity.toLocaleString()}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{formatMicrousd(row.chargeMicrousd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Billing Ledger */}
      {isAdmin && (
      <Card style={{ padding: '20px' }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Billing Ledger
        </div>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <select
            value={ledgerDirectionFilter}
            onChange={(e) => { setLedgerDirectionFilter(e.target.value); setLedgerOffset(0); }}
            style={{ ...inputStyle, padding: '6px 10px', borderRadius: '6px', fontSize: '0.8125rem', cursor: 'pointer' }}
          >
            <option value="">All Entries</option>
            <option value="credit">Credits Only</option>
            <option value="debit">Debits Only</option>
          </select>
        </div>
        {ledgerQuery.isLoading && <LoadingRows count={5} />}
        {ledgerQuery.isError && (
          <ErrorState
            message={localizeApiError(intl, ledgerQuery.error, 'common.errorTitle')}
            onRetry={() => void ledgerQuery.refetch()}
          />
        )}
        {ledgerEntries && ledgerEntries.records.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '0.8125rem', padding: '24px 0' }}>
            No billing ledger entries recorded yet.
          </div>
        )}
        {ledgerEntries && ledgerEntries.records.length > 0 && (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>Date</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Type</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerEntries.records.map((entry) => (
                    <tr key={entry.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '8px', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                        {new Date(entry.createdAt).toLocaleString()}
                      </td>
                      <td style={{ padding: '8px' }}>
                        <div>{LEDGER_ENTRY_TYPE_LABELS[entry.entryType] ?? entry.entryType}</div>
                        {entry.description && (
                          <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '2px' }}>{entry.description}</div>
                        )}
                      </td>
                      <td style={{
                        padding: '8px',
                        textAlign: 'right',
                        fontWeight: '500',
                        color: entry.direction === 'credit' ? 'var(--color-success-text, #276749)' : 'var(--color-danger, #e53e3e)',
                      }}>
                        {entry.direction === 'credit' ? '+' : '−'}{formatMicrousd(entry.amountMicrousd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '12px', justifyContent: 'flex-end' }}>
              <Button
                variant="secondary"
                disabled={ledgerOffset === 0}
                onClick={() => setLedgerOffset(Math.max(0, ledgerOffset - ledgerPageSize))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={(ledgerEntries.offset + ledgerEntries.records.length) >= ledgerEntries.total}
                onClick={() => setLedgerOffset(ledgerOffset + ledgerPageSize)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </Card>
      )}

      {/* Usage event ledger */}
      {isAdmin && (
      <Card style={{ padding: '20px' }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Usage Events
        </div>
        {usageEventsQuery.isLoading && <LoadingRows count={5} />}
        {usageEventsQuery.isError && (
          <ErrorState
            message={localizeApiError(intl, usageEventsQuery.error, 'common.errorTitle')}
            onRetry={() => void usageEventsQuery.refetch()}
          />
        )}
        {usageEvents && usageEvents.records.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '0.8125rem', padding: '24px 0' }}>
            No usage events recorded yet.
          </div>
        )}
        {usageEvents && usageEvents.records.length > 0 && (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Time</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Meter</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Quantity</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Agent</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Session</th>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Provider/Model</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Charge</th>
                  </tr>
                </thead>
                <tbody>
                  {usageEvents.records.map((ev) => (
                    <tr key={ev.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '8px', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                        {new Date(ev.occurredAt).toLocaleString()}
                      </td>
                      <td style={{ padding: '8px' }}>{formatMeterLabel(ev.meterKey)}</td>
                      <td style={{ padding: '8px', textAlign: 'right' }}>{ev.quantity.toLocaleString()} {ev.unit}</td>
                      <td style={{ padding: '8px' }}>{ev.agent?.name ?? '—'}</td>
                      <td style={{ padding: '8px' }}>
                        {ev.session?.id ? (
                          <a href={`/sessions/${ev.session.id}`} style={{ color: 'var(--color-brand)' }}>
                            {ev.session.id.slice(0, 12)}...
                          </a>
                        ) : '—'}
                      </td>
                      <td style={{ padding: '8px', color: 'var(--color-text-muted)' }}>
                        {[ev.provider, ev.model].filter(Boolean).join(' / ') || '—'}
                      </td>
                      <td style={{ padding: '8px', textAlign: 'right' }}>{formatMicrousd(ev.chargeMicrousd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '12px', justifyContent: 'flex-end' }}>
              <Button
                variant="secondary"
                disabled={usageEventOffset === 0}
                onClick={() => setUsageEventOffset(Math.max(0, usageEventOffset - usageEventsPageSize))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={(usageEvents.offset + usageEvents.records.length) >= usageEvents.total}
                onClick={() => setUsageEventOffset(usageEventOffset + usageEventsPageSize)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </Card>
      )}

      {/* Historical periods */}
      <Card style={{ padding: '20px' }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Billing Periods
        </div>
        {periodsQuery.isLoading && <LoadingRows count={3} />}
        {periodsQuery.isError && (
          <ErrorState
            message={localizeApiError(intl, periodsQuery.error, 'common.errorTitle')}
            onRetry={() => void periodsQuery.refetch()}
          />
        )}
        {periodsQuery.data && periodsQuery.data.periods.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '0.8125rem', padding: '24px 0' }}>
            {intl.formatMessage({ id: 'billing.usage.emptyPeriods' })}
          </div>
        )}
        {periodsQuery.data && periodsQuery.data.periods.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Period</th>
                <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Status</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Usage Charges</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: '500', color: 'var(--color-text-muted)' }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {periodsQuery.data.periods.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>
                    {formatShortDate(intl, p.periodStart)} - {formatShortDate(intl, p.periodEnd)}
                  </td>
                  <td style={{ padding: '8px' }}>{p.status}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{formatMicrousd(p.usageChargeMicrousd)}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{formatMicrousd(p.balanceMicrousd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
