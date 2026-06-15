import { useIntl } from 'react-intl';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { billing, agents as agentsApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, Button } from '../../lib/ui.js';
import { formatCurrencyFromCents, formatShortDate } from '../../lib/formatting.js';
import { localizeApiError } from '../../lib/localize-api-error.js';

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

function usageAccountStatusLabel(status: string): { text: string; color: string } {
  switch (status) {
    case 'active': return { text: 'Active', color: 'var(--color-success)' };
    case 'soft_limited': return { text: 'Approaching Limit', color: 'var(--color-warning)' };
    case 'hard_limited': return { text: 'Usage Limit Reached', color: 'var(--color-danger, #e53e3e)' };
    case 'suspended': return { text: 'Suspended', color: 'var(--color-text-muted)' };
    default: return { text: status, color: 'var(--color-text-muted)' };
  }
}

function formatMicrousd(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(4)}`;
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
  const USAGE_EVENTS_PAGE_SIZE = 50;

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
  });

  const usageEventsQuery = useQuery({
    queryKey: ['billing', 'usage-events', usageEventOffset, usageFilters],
    queryFn: () => billing.usageEvents({ limit: USAGE_EVENTS_PAGE_SIZE, offset: usageEventOffset, ...usageFilters }),
  });

  const periodsQuery = useQuery({
    queryKey: ['billing', 'periods'],
    queryFn: () => billing.periods(),
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
      void queryClient.invalidateQueries({ queryKey: ['billing', 'usage-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['billing', 'periods'] });
    },
  });

  const topUpMutation = useMutation({
    mutationFn: (packId: string) => billing.createTopUpCheckoutSession(packId),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const agentsQuery = useQuery({
    queryKey: ['agents', 'list'],
    queryFn: () => agentsApi.list(),
  });

  const summary = summaryQuery.data;
  const usageSummary = usageSummaryQuery.data;
  const usageBreakdown = usageBreakdownQuery.data;
  const usageEvents = usageEventsQuery.data;
  const usageAccount = usageSummary?.account ?? null;

  useEffect(() => {
    if (!usageSummary?.currentPeriod) return;
    setSoftCapInput(usageSummary.currentPeriod.softCapMicrousd != null ? String(Math.floor(usageSummary.currentPeriod.softCapMicrousd / 10_000)) : '');
    setHardCapInput(usageSummary.currentPeriod.hardCapMicrousd != null ? String(Math.floor(usageSummary.currentPeriod.hardCapMicrousd / 10_000)) : '');
  }, [usageSummary?.currentPeriod?.id]);

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
                <div style={{ fontSize: '13px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                  {intl.formatMessage({ id: 'billing.providerLabel' }, { provider: summary.provider })}
                </div>
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
                              : intl.formatMessage({ id: 'billing.switchAction' }, { interval: intl.formatMessage({ id: `billing.interval.${price.interval}` }) })}
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
                              : intl.formatMessage({ id: 'billing.subscribeAction' }, { interval: intl.formatMessage({ id: `billing.interval.${price.interval}` }) })}
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
              ? 'Usage limit reached — AI agent actions are paused until your limit is adjusted or the billing period resets.'
              : 'Approaching usage limit — agents may be paused if spending continues.'}
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
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '16px' }}>
                <div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Account Status</div>
                  <div style={{ fontWeight: '500', color: usageAccountStatusLabel(usageAccount.status).color }}>
                    {usageAccountStatusLabel(usageAccount.status).text}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Usage Charges</div>
                  <div style={{ fontWeight: '500' }}>{formatMicrousd(usageSummary.currentPeriod.usageChargeMicrousd)}</div>
                </div>
                <div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Credits Applied</div>
                  <div style={{ fontWeight: '500' }}>{formatMicrousd(usageSummary.currentPeriod.creditAppliedMicrousd)}</div>
                </div>
                <div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Balance</div>
                  <div style={{ fontWeight: '500' }}>{formatMicrousd(usageSummary.currentPeriod.balanceMicrousd)}</div>
                </div>
                {usageSummary.currentPeriod.hardCapMicrousd != null && (
                  <div>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Hard Cap</div>
                    <div style={{ fontWeight: '500' }}>{formatMicrousd(usageSummary.currentPeriod.hardCapMicrousd)}</div>
                  </div>
                )}
              </div>

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
        </Card>

          <Card style={{ padding: '20px' }}>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Spend Controls
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px', marginBottom: '10px' }}>
              <input
                value={softCapInput}
                onChange={(e) => setSoftCapInput(e.target.value)}
                placeholder="Soft cap (cents)"
                style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', color: 'var(--color-text-primary)' }}
              />
              <input
                value={hardCapInput}
                onChange={(e) => setHardCapInput(e.target.value)}
                placeholder="Hard cap (cents)"
                style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', color: 'var(--color-text-primary)' }}
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px' }}>
              <select
                value={selectedTopUpPackId}
                onChange={(e) => setSelectedTopUpPackId(e.target.value)}
                disabled={!usageSummary?.topUpsEnabled || (usageSummary.topUpPacks?.length ?? 0) === 0}
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
                disabled={topUpMutation.isPending || !usageSummary?.topUpsEnabled || selectedTopUpPackId.length === 0}
                onClick={() => topUpMutation.mutate(selectedTopUpPackId)}
              >
                {topUpMutation.isPending ? 'Opening...' : 'Buy Top-up'}
              </Button>
            </div>
            {!usageSummary?.topUpsEnabled && (
              <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
                {usageAccount
                  ? 'Top-ups are not enabled for this plan.'
                  : intl.formatMessage({ id: 'billing.usage.noAccountControls' })}
              </div>
            )}
          </Card>

          <Card style={{ padding: '20px' }}>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Usage Filters
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
              <select
                value={meterFilter}
                onChange={(e) => { setMeterFilter(e.target.value); setUsageEventOffset(0); }}
                style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', color: 'var(--color-text-primary)' }}
              >
                <option value="">All meters</option>
                <option value="llm.input_tokens">llm.input_tokens</option>
                <option value="llm.output_tokens">llm.output_tokens</option>
                <option value="llm.reasoning_tokens">llm.reasoning_tokens</option>
                <option value="agent.runtime_ms">agent.runtime_ms</option>
              </select>

              <select
                value={agentFilter}
                onChange={(e) => { setAgentFilter(e.target.value); setUsageEventOffset(0); }}
                style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', color: 'var(--color-text-primary)' }}
              >
                <option value="">All agents</option>
                {(agentsQuery.data ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>

              <select
                value={periodFilter}
                onChange={(e) => { setPeriodFilter(e.target.value); setUsageEventOffset(0); }}
                style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', color: 'var(--color-text-primary)' }}
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
          </Card>

          {/* By-meter breakdown */}
          <Card style={{ padding: '20px' }}>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
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
              <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '13px', padding: '24px 0' }}>
                {intl.formatMessage({ id: 'billing.usage.emptyBreakdown' })}
              </div>
            )}
            {usageBreakdown && usageBreakdown.byMeter.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
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
                      <td style={{ padding: '8px', fontFamily: 'monospace' }}>{row.meterKey}</td>
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
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
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
              <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '13px', padding: '24px 0' }}>
                {intl.formatMessage({ id: 'billing.usage.emptyBreakdown' })}
              </div>
            )}
            {usageBreakdown && usageBreakdown.byAgent.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
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

          {/* Usage event ledger */}
          <Card style={{ padding: '20px' }}>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
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
              <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '13px', padding: '24px 0' }}>
                No usage events recorded yet.
              </div>
            )}
            {usageEvents && usageEvents.records.length > 0 && (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
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
                          <td style={{ padding: '8px', fontFamily: 'monospace' }}>{ev.meterKey}</td>
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
                    onClick={() => setUsageEventOffset(Math.max(0, usageEventOffset - USAGE_EVENTS_PAGE_SIZE))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={(usageEvents.offset + usageEvents.records.length) >= usageEvents.total}
                    onClick={() => setUsageEventOffset(usageEventOffset + USAGE_EVENTS_PAGE_SIZE)}
                  >
                    Next
                  </Button>
                </div>
              </>
            )}
          </Card>

          {/* Historical periods */}
          <Card style={{ padding: '20px' }}>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
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
              <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '13px', padding: '24px 0' }}>
                {intl.formatMessage({ id: 'billing.usage.emptyPeriods' })}
              </div>
            )}
            {periodsQuery.data && periodsQuery.data.periods.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
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
      </div>
    </PageShell>
  );
}
