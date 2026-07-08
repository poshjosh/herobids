import { useIntl } from 'react-intl';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { billing, agents as agentsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, ErrorBanner, Button } from '../../lib/ui.js';
import { formatCurrencyFromCents, formatShortDate } from '../../lib/formatting.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { BillingDetails, formatMicrousd } from './BillingDetails.js';

function statusLabel(intl: ReturnType<typeof useIntl>, status: string): { text: string; color: string } {
  switch (status) {
    case 'active': return { text: intl.formatMessage({ id: 'billing.status.active' }), color: 'var(--color-success)' };
    case 'trialing': return { text: intl.formatMessage({ id: 'billing.status.trialing' }), color: 'var(--color-brand)' };
    case 'past_due': return { text: intl.formatMessage({ id: 'billing.status.past_due' }), color: 'var(--color-warning)' };
    case 'canceled': return { text: intl.formatMessage({ id: 'billing.status.canceled' }), color: 'var(--color-text-muted)' };
    case 'incomplete': return { text: intl.formatMessage({ id: 'billing.status.incomplete' }), color: 'var(--color-warning)' };
    default: return { text: status, color: 'var(--color-text-muted)' };
  }
}

function usageAccountStatusLabel(intl: ReturnType<typeof useIntl>, status: string): { text: string; color: string } {
  switch (status) {
    case 'active': return { text: intl.formatMessage({ id: 'billing.usage.status.active' }), color: 'var(--color-success)' };
    case 'soft_limited': return { text: intl.formatMessage({ id: 'billing.usage.status.softLimited' }), color: 'var(--color-warning)' };
    case 'hard_limited': return { text: intl.formatMessage({ id: 'billing.usage.status.hardLimited' }), color: 'var(--color-danger, #e53e3e)' };
    case 'suspended': return { text: intl.formatMessage({ id: 'billing.usage.status.suspended' }), color: 'var(--color-text-muted)' };
    default: return { text: status, color: 'var(--color-text-muted)' };
  }
}

function formatMicrousd(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(4)}`;
}

interface CreditGaugeProps {
  balanceMicrousd: number;
  totalCreditMicrousd: number;
  usageChargeMicrousd: number;
  includedCreditMicrousd: number;
  status: string;
  planLabel?: string;
  intl: ReturnType<typeof useIntl>;
}

function CreditGauge({
  balanceMicrousd,
  totalCreditMicrousd,
  usageChargeMicrousd,
  includedCreditMicrousd,
  status,
  planLabel,
  intl,
}: CreditGaugeProps) {
  const remainingPct = totalCreditMicrousd > 0 ? balanceMicrousd / totalCreditMicrousd : 0;
  const topUpMicrousd = Math.max(0, totalCreditMicrousd - includedCreditMicrousd);
  const planName = planLabel || intl.formatMessage({ id: 'billing.usage.yourPlan' });
  const statusInfo = usageAccountStatusLabel(intl, status);

  let barColor = 'var(--color-success)';
  if (remainingPct < 0.2) {
    barColor = 'var(--color-danger, #e53e3e)';
  } else if (remainingPct < 0.5) {
    barColor = 'var(--color-warning)';
  }

  const isOverLimit = balanceMicrousd <= 0;
  const barFillPct = Math.max(0, Math.min(100, remainingPct * 100));

  return (
    <div>
      {/* Main amount + status badge */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '10px' }}>
        <div>
          {isOverLimit ? (
            <span style={{ fontSize: '24px', fontWeight: '600', color: 'var(--color-danger, #e53e3e)' }}>
              {formatMicrousd(Math.abs(balanceMicrousd))} {intl.formatMessage({ id: 'billing.usage.overLimit' })}
            </span>
          ) : (
            <span style={{ fontSize: '24px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
              {formatMicrousd(balanceMicrousd)} {intl.formatMessage({ id: 'billing.usage.creditLeft' })}
            </span>
          )}
        </div>
        <span style={{
          padding: '2px 10px',
          borderRadius: '12px',
          fontSize: '12px',
          fontWeight: '500',
          background: `${statusInfo.color}1a`,
          color: statusInfo.color,
        }}>
          {statusInfo.text}
        </span>
      </div>

      {/* Progress bar */}
      <div style={{
        width: '100%',
        height: '8px',
        borderRadius: '4px',
        background: 'var(--color-surface-2)',
        marginBottom: '10px',
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${barFillPct}%`,
          height: '100%',
          borderRadius: '4px',
          background: barColor,
          transition: 'width 0.3s ease',
        }} />
      </div>

      {/* Used this month */}
      <div style={{ fontSize: '13px', color: 'var(--color-text-muted)', marginBottom: '4px' }}>
        {formatMicrousd(usageChargeMicrousd)} {intl.formatMessage({ id: 'billing.usage.usedThisMonth' })}
      </div>

      {/* Plan breakdown */}
      <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
        {formatMicrousd(includedCreditMicrousd)} {intl.formatMessage({ id: 'billing.usage.includedWithPlan' }, { planName })}
        {topUpMicrousd > 0 && <> + {formatMicrousd(topUpMicrousd)} {intl.formatMessage({ id: 'billing.usage.topUps' })}</>}
      </div>
    </div>
  );
}

export function BillingPage() {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [usageEventOffset, setUsageEventOffset] = useState(0);
  const [meterFilter, setMeterFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [sessionFilter, setSessionFilter] = useState('');
  const [periodFilter, setPeriodFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [softCapInput, setSoftCapInput] = useState('');
  const [hardCapInput, setHardCapInput] = useState('');
  const [selectedTopUpPackId, setSelectedTopUpPackId] = useState('');
  const [spendCapsError, setSpendCapsError] = useState<string | null>(null);
  const [topUpError, setTopUpError] = useState<string | null>(null);
  const [checkoutBanner, setCheckoutBanner] = useState<'success' | 'cancelled' | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [ledgerOffset, setLedgerOffset] = useState(0);
  const [ledgerDirectionFilter, setLedgerDirectionFilter] = useState('');
  const USAGE_EVENTS_PAGE_SIZE = 50;
  const LEDGER_PAGE_SIZE = 50;

  const usageFilters = useMemo(() => ({
    meterKey: meterFilter || undefined,
    agentId: agentFilter || undefined,
    sessionId: sessionFilter || undefined,
    periodId: periodFilter || undefined,
    from: fromDate ? new Date(`${fromDate}T00:00:00.000Z`).toISOString() : undefined,
    to: toDate ? new Date(`${toDate}T23:59:59.999Z`).toISOString() : undefined,
  }), [meterFilter, agentFilter, sessionFilter, periodFilter, fromDate, toDate]);

  const summaryQuery = useQuery({
    queryKey: ['billing', 'summary'],
    queryFn: () => billing.summary(),
  });

  const usageSummaryQuery = useQuery({
    queryKey: ['billing', 'usage-summary'],
    queryFn: () => billing.usageSummary(),
  });

  const usageBreakdownQuery = useQuery({
    queryKey: ['billing', 'usage-breakdown', usageFilters.periodId, usageFilters.from, usageFilters.to],
    queryFn: () => billing.usageBreakdown({ periodId: usageFilters.periodId, from: usageFilters.from, to: usageFilters.to }),
    enabled: showDetails,
  });

  const usageEventsQuery = useQuery({
    queryKey: ['billing', 'usage-events', usageEventOffset, usageFilters],
    queryFn: () => billing.usageEvents({ limit: USAGE_EVENTS_PAGE_SIZE, offset: usageEventOffset, ...usageFilters }),
    enabled: showDetails,
  });

  const ledgerQuery = useQuery({
    queryKey: ['billing', 'ledger-entries', ledgerOffset, usageFilters.periodId, ledgerDirectionFilter],
    queryFn: () => billing.ledgerEntries({
      limit: LEDGER_PAGE_SIZE,
      offset: ledgerOffset,
      periodId: usageFilters.periodId || undefined,
      direction: (ledgerDirectionFilter as 'credit' | 'debit') || undefined,
    }),
    enabled: showDetails,
  });

  const periodsQuery = useQuery({
    queryKey: ['billing', 'periods'],
    queryFn: () => billing.periods(),
    enabled: showDetails,
  });

  const checkoutMutation = useMutation({
    mutationFn: ({ planId, priceId }: { planId: string; priceId?: string }) =>
      billing.createCheckoutSession(planId, priceId),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const portalMutation = useMutation({
    mutationFn: () => billing.createPortalSession(),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => billing.cancelSubscription(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['billing', 'summary'] });
    },
  });

  const upgradeMutation = useMutation({
    mutationFn: ({ planId, priceId }: { planId: string; priceId?: string }) =>
      billing.upgradeSubscription(planId, priceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['billing', 'summary'] });
    },
  });

  const spendCapsMutation = useMutation({
    mutationFn: (caps: { softCapCents?: number | null; hardCapCents?: number | null }) => billing.updateSpendCaps(caps),
    onSuccess: () => {
      setSpendCapsError(null);
      void queryClient.invalidateQueries({ queryKey: ['billing', 'usage-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['billing', 'periods'] });
    },
    onError: (err: unknown) => {
      setSpendCapsError(localizeApiError(intl, err, 'common.errorTitle'));
    },
  });

  const topUpMutation = useMutation({
    mutationFn: (packId: string) => billing.createTopUpCheckoutSession(packId),
    onSuccess: (data) => {
      setTopUpError(null);
      window.location.href = data.url;
    },
    onError: (err: unknown) => {
      setTopUpError(localizeApiError(intl, err, 'common.errorTitle'));
    },
  });

  const agentsQuery = useQuery({
    queryKey: ['agents', 'list'],
    queryFn: () => agentsApi.list(),
    enabled: showDetails,
  });

  const summary = summaryQuery.data;
  const usageSummary = usageSummaryQuery.data;
  const usageAccount = usageSummary?.account ?? null;

  useEffect(() => {
    if (!usageSummary?.currentPeriod) return;
    setSoftCapInput(usageSummary.currentPeriod.softCapMicrousd != null ? String(Math.floor(usageSummary.currentPeriod.softCapMicrousd / 10_000)) : '');
    setHardCapInput(usageSummary.currentPeriod.hardCapMicrousd != null ? String(Math.floor(usageSummary.currentPeriod.hardCapMicrousd / 10_000)) : '');
  }, [usageSummary?.currentPeriod?.id]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const session = params.get('session');
    if (session === 'success') {
      setCheckoutBanner('success');
      void queryClient.invalidateQueries({ queryKey: ['billing', 'summary'] });
      void queryClient.invalidateQueries({ queryKey: ['billing', 'usage-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['billing', 'periods'] });
    } else if (session === 'cancelled') {
      setCheckoutBanner('cancelled');
    }
    if (session) {
      window.history.replaceState({}, '', '/billing');
    }
  }, []);

  useEffect(() => {
    const packs = usageSummary?.topUpPacks ?? [];
    if (packs.length === 0) {
      setSelectedTopUpPackId('');
      return;
    }
    if (!selectedTopUpPackId || !packs.some((pack) => pack.packId === selectedTopUpPackId)) {
      setSelectedTopUpPackId(packs[0]!.packId);
    }
  }, [usageSummary?.topUpPacks, selectedTopUpPackId]);

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'billing.title' })}
        subtitle={intl.formatMessage({ id: 'billing.subtitle' })}
      />

      {checkoutBanner && (
        <div
          style={{
            padding: '12px 16px',
            marginBottom: '16px',
            borderRadius: '8px',
            fontSize: '13px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            border: `1px solid ${checkoutBanner === 'success' ? 'var(--color-success)' : 'var(--color-warning)'}`,
            background: checkoutBanner === 'success' ? 'var(--color-success-bg, #f0fff4)' : 'var(--color-warning-bg, #fffbeb)',
            color: checkoutBanner === 'success' ? 'var(--color-success-text, #276749)' : 'var(--color-warning-text, #92400e)',
          }}
        >
          <span>
            {checkoutBanner === 'success'
              ? intl.formatMessage({ id: 'billing.checkout.success' })
              : intl.formatMessage({ id: 'billing.checkout.cancelled' })}
          </span>
          <button
            onClick={() => setCheckoutBanner(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', lineHeight: 1, padding: '0 0 0 12px', color: 'inherit' }}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {summaryQuery.isLoading && <LoadingRows count={3} />}
      {summaryQuery.isError && (
        <ErrorState
          message={localizeApiError(intl, summaryQuery.error, 'common.errorTitle')}
          onRetry={() => void summaryQuery.refetch()}
        />
      )}

      {summary && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Current Plan */}
          <Card style={{ padding: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {intl.formatMessage({ id: 'billing.currentPlan' })}
                </div>
                <div style={{ fontSize: '18px', fontWeight: '600' }}>{summary.planLabel}</div>
                {summary.billingInterval && (
                  <div style={{ fontSize: '13px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                    {intl.formatMessage({ id: 'billing.billedInterval' }, { interval: intl.formatMessage({ id: `billing.interval.${summary.billingInterval}` }) })}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                {summary.hasPaymentCustomer && !!summary.subscription && (
                  <Button
                    variant="secondary"
                    onClick={() => portalMutation.mutate()}
                    disabled={portalMutation.isPending}
                  >
                    {portalMutation.isPending ? intl.formatMessage({ id: 'billing.opening' }) : intl.formatMessage({ id: 'billing.manageBilling' })}
                  </Button>
                )}
                {summary.subscription && summary.subscription.status !== 'canceled' && !summary.subscription.cancelAtPeriodEnd && (
                  <Button
                    variant="secondary"
                    onClick={() => cancelMutation.mutate()}
                    disabled={cancelMutation.isPending}
                  >
                    {cancelMutation.isPending ? intl.formatMessage({ id: 'billing.canceling' }) : intl.formatMessage({ id: 'billing.cancelSubscription' })}
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {summary.subscription && (
            <Card style={{ padding: '20px' }}>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {intl.formatMessage({ id: 'billing.subscription' })}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px' }}>
                <div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'common.status' })}</div>
                  <div style={{ fontWeight: '500', color: statusLabel(intl, summary.subscription.status).color }}>
                    {statusLabel(intl, summary.subscription.status).text}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'billing.renews' })}</div>
                  <div style={{ fontWeight: '500' }}>
                    {summary.subscription.cancelAtPeriodEnd
                      ? intl.formatMessage({ id: 'billing.cancelsOn' }, { date: formatShortDate(intl, summary.subscription.currentPeriodEnd) })
                      : formatShortDate(intl, summary.subscription.currentPeriodEnd)}
                  </div>
                </div>
                {summary.subscription.trialEnd && (
                  <div>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'billing.trialEnds' })}</div>
                    <div style={{ fontWeight: '500' }}>{formatShortDate(intl, summary.subscription.trialEnd)}</div>
                  </div>
                )}
              </div>
              {summary.subscription.cancelAtPeriodEnd && (
                <div style={{ marginTop: '12px', padding: '10px 14px', background: 'var(--color-surface-2)', borderRadius: '6px', fontSize: '13px', color: 'var(--color-warning)' }}>
                  {intl.formatMessage({ id: 'billing.cancelNotice' })}
                </div>
              )}
              {(summary.subscription.status === 'past_due' || summary.subscription.status === 'incomplete') && (
                <div style={{ marginTop: '12px', padding: '10px 14px', background: 'var(--color-surface-2)', borderRadius: '6px', fontSize: '13px', color: 'var(--color-warning)' }}>
                  {intl.formatMessage({ id: 'billing.paymentIssueNotice' })}
                </div>
              )}
            </Card>
          )}

          {summary.availablePlans.length > 0 && (
            <Card style={{ padding: '20px' }}>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {summary.subscription ? intl.formatMessage({ id: 'billing.changePlan' }) : intl.formatMessage({ id: 'billing.upgrade' })}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {summary.availablePlans.map((plan) => (
                  <div key={plan.planId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', border: '1px solid var(--color-border)', borderRadius: '8px' }}>
                    <div>
                      <div style={{ fontWeight: '500' }}>{plan.prices[0]?.displayLabel ?? plan.planId}</div>
                      {plan.prices[0]?.amountCents != null && (
                        <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>
                          {formatCurrencyFromCents(intl, plan.prices[0].amountCents)}/{intl.formatMessage({ id: `billing.interval.${plan.prices[0].interval}` })}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {summary.subscription ? (
                        plan.prices.map((price) => (
                          <Button
                            key={price.id}
                            variant="primary"
                            onClick={() => upgradeMutation.mutate({ planId: plan.planId, priceId: price.id })}
                            disabled={upgradeMutation.isPending}
                          >
                            {upgradeMutation.isPending
                              ? intl.formatMessage({ id: 'billing.switching' })
                              : intl.formatMessage({ id: 'billing.switchAction' }, { label: price.displayLabel })}
                          </Button>
                        ))
                      ) : (
                        plan.prices.map((price) => (
                          <Button
                            key={price.id}
                            variant="primary"
                            onClick={() => checkoutMutation.mutate({ planId: plan.planId, priceId: price.id })}
                            disabled={checkoutMutation.isPending}
                          >
                            {checkoutMutation.isPending
                              ? intl.formatMessage({ id: 'billing.loadingCheckout' })
                              : intl.formatMessage({ id: 'billing.subscribeAction' }, { label: price.displayLabel })}
                          </Button>
                        ))
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* --------------- Usage Billing Section --------------- */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: summary ? '24px' : undefined }}>
        {/* Spend-state warning banner */}
        {usageAccount && (usageAccount.status === 'soft_limited' || usageAccount.status === 'hard_limited') && (
          <div style={{
            padding: '12px 16px',
            background: usageAccount.status === 'hard_limited' ? 'var(--color-danger-bg, #fff5f5)' : 'var(--color-warning-bg, #fffbeb)',
            border: `1px solid ${usageAccount.status === 'hard_limited' ? 'var(--color-danger, #e53e3e)' : 'var(--color-warning)'}`,
            borderRadius: '8px',
            color: usageAccount.status === 'hard_limited' ? 'var(--color-danger, #e53e3e)' : 'var(--color-warning-text, #92400e)',
            fontSize: '13px',
          }}>
            {usageAccount.status === 'hard_limited'
              ? intl.formatMessage({ id: 'billing.usage.warning.hardLimited' })
              : intl.formatMessage({ id: 'billing.usage.warning.softLimited' })}
          </div>
        )}
        <Card style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              AI Usage — Current Period
            </div>
            {usageSummary?.currentPeriod && (
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                {formatShortDate(intl, usageSummary.currentPeriod.periodStart)} - {formatShortDate(intl, usageSummary.currentPeriod.periodEnd)}
              </div>
            )}
          </div>
          {usageSummaryQuery.isLoading && <LoadingRows count={1} />}
          {usageSummaryQuery.isError && (
            <ErrorState
              message={localizeApiError(intl, usageSummaryQuery.error, 'common.errorTitle')}
              onRetry={() => void usageSummaryQuery.refetch()}
            />
          )}
          {!usageSummaryQuery.isLoading && !usageSummaryQuery.isError && !usageAccount && (
            <div style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>
              {intl.formatMessage({ id: 'billing.usage.emptyAccount' })}
            </div>
          )}
          {!usageSummaryQuery.isLoading && !usageSummaryQuery.isError && usageAccount && !usageSummary?.currentPeriod && (
            <div style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>
              {intl.formatMessage({ id: 'billing.usage.emptyPeriod' })}
            </div>
          )}
          {usageAccount && usageSummary?.currentPeriod && (
            <>
              <CreditGauge
                balanceMicrousd={usageSummary.currentPeriod.balanceMicrousd}
                totalCreditMicrousd={usageSummary.currentPeriod.balanceMicrousd + usageSummary.currentPeriod.usageChargeMicrousd}
                usageChargeMicrousd={usageSummary.currentPeriod.usageChargeMicrousd}
                includedCreditMicrousd={usageSummary.currentPeriod.includedCreditMicrousd}
                status={usageAccount.status}
                planLabel={summary?.planLabel}
                intl={intl}
              />

              {usageSummary.warnings.some((w) => w.reached) && (
                <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {usageSummary.warnings.filter((w) => w.reached).map((w) => (
                    <span
                      key={w.thresholdPct}
                      style={{ padding: '2px 8px', background: 'var(--color-surface-2)', borderRadius: '4px', fontSize: '12px', color: 'var(--color-warning-text, #92400e)' }}
                    >
                      {w.thresholdPct}% threshold reached
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
          {/* Top-up row */}
          {usageAccount && (
            <>
              <div style={{ marginTop: '16px', borderTop: '1px solid var(--color-border)', paddingTop: '12px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px' }}>
                  <select
                    value={selectedTopUpPackId}
                    onChange={(e) => setSelectedTopUpPackId(e.target.value)}
                    disabled={(usageSummary?.topUpPacks?.length ?? 0) === 0}
                    style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', color: 'var(--color-text-primary)' }}
                  >
                    {(usageSummary?.topUpPacks?.length ?? 0) === 0 && <option value="">No packs available</option>}
                    {(usageSummary?.topUpPacks ?? []).map((pack) => (
                      <option key={`${pack.provider}_${pack.packId}`} value={pack.packId}>
                        {pack.packId} · {formatCurrencyFromCents(intl, pack.cents)} · {pack.provider}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="primary"
                    disabled={topUpMutation.isPending || (usageSummary?.topUpPacks?.length ?? 0) === 0 || selectedTopUpPackId.length === 0}
                    onClick={() => topUpMutation.mutate(selectedTopUpPackId)}
                  >
                    {topUpMutation.isPending ? 'Opening...' : 'Buy Top-up'}
                  </Button>
                </div>
                {topUpError && (
                  <ErrorBanner message={topUpError} onDismiss={() => setTopUpError(null)} />
                )}
                {(usageSummary?.topUpPacks?.length ?? 0) === 0 && (
                  <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
                    Top-ups are not enabled for this plan.
                  </div>
                )}
              </div>
            </>
          )}
        </Card>

        {/* Details toggle */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            variant="secondary"
            onClick={() => setShowDetails(!showDetails)}
          >
            {showDetails ? intl.formatMessage({ id: 'billing.usage.hideDetails' }) : intl.formatMessage({ id: 'billing.usage.viewDetails' })}
          </Button>
        </div>

        {showDetails && (
          <BillingDetails
            softCapInput={softCapInput}
            setSoftCapInput={setSoftCapInput}
            hardCapInput={hardCapInput}
            setHardCapInput={setHardCapInput}
            spendCapsError={spendCapsError}
            setSpendCapsError={setSpendCapsError}
            spendCapsMutation={spendCapsMutation}
            usageAccount={usageAccount}
            meterFilter={meterFilter}
            setMeterFilter={setMeterFilter}
            agentFilter={agentFilter}
            setAgentFilter={setAgentFilter}
            sessionFilter={sessionFilter}
            setSessionFilter={setSessionFilter}
            periodFilter={periodFilter}
            setPeriodFilter={setPeriodFilter}
            fromDate={fromDate}
            setFromDate={setFromDate}
            toDate={toDate}
            setToDate={setToDate}
            agentsQuery={agentsQuery}
            usageBreakdownQuery={usageBreakdownQuery}
            usageEventsQuery={usageEventsQuery}
            ledgerQuery={ledgerQuery}
            periodsQuery={periodsQuery}
            ledgerOffset={ledgerOffset}
            setLedgerOffset={setLedgerOffset}
            ledgerDirectionFilter={ledgerDirectionFilter}
            setLedgerDirectionFilter={setLedgerDirectionFilter}
            usageEventOffset={usageEventOffset}
            setUsageEventOffset={setUsageEventOffset}
            usageEventsPageSize={USAGE_EVENTS_PAGE_SIZE}
            ledgerPageSize={LEDGER_PAGE_SIZE}
            intl={intl}
          />
        )}
      </div>
    </PageShell>
  );
}
