import { useIntl } from 'react-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { billing } from '../../lib/api-client.js';
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

export function BillingPage() {
  const intl = useIntl();
  const queryClient = useQueryClient();

  const summaryQuery = useQuery({
    queryKey: ['billing', 'summary'],
    queryFn: () => billing.summary(),
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

  const summary = summaryQuery.data;

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

          {/* Subscription Status */}
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

          {/* Available Plans */}
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
    </PageShell>
  );
}
