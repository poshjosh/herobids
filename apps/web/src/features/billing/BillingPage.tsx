import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { billing } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, Button } from '../../lib/ui.js';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function statusLabel(status: string): { text: string; color: string } {
  switch (status) {
    case 'active': return { text: 'Active', color: 'var(--color-success)' };
    case 'trialing': return { text: 'Trial', color: 'var(--color-brand)' };
    case 'past_due': return { text: 'Past due', color: 'var(--color-warning)' };
    case 'canceled': return { text: 'Canceled', color: 'var(--color-text-muted)' };
    case 'incomplete': return { text: 'Incomplete', color: 'var(--color-warning)' };
    default: return { text: status, color: 'var(--color-text-muted)' };
  }
}

export function BillingPage() {
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
        title="Billing"
        subtitle="Manage your subscription and plan"
      />

      {summaryQuery.isLoading && <LoadingRows count={3} />}
      {summaryQuery.isError && (
        <ErrorState
          message={(summaryQuery.error as Error).message}
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
                  Current plan
                </div>
                <div style={{ fontSize: '18px', fontWeight: '600' }}>{summary.planLabel}</div>
                {summary.billingInterval && (
                  <div style={{ fontSize: '13px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                    Billed {summary.billingInterval}ly
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
                    {portalMutation.isPending ? 'Opening…' : 'Manage billing'}
                  </Button>
                )}
                {summary.subscription && summary.subscription.status !== 'canceled' && !summary.subscription.cancelAtPeriodEnd && (
                  <Button
                    variant="secondary"
                    onClick={() => cancelMutation.mutate()}
                    disabled={cancelMutation.isPending}
                  >
                    {cancelMutation.isPending ? 'Canceling…' : 'Cancel subscription'}
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {/* Subscription Status */}
          {summary.subscription && (
            <Card style={{ padding: '20px' }}>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Subscription
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px' }}>
                <div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Status</div>
                  <div style={{ fontWeight: '500', color: statusLabel(summary.subscription.status).color }}>
                    {statusLabel(summary.subscription.status).text}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Renews</div>
                  <div style={{ fontWeight: '500' }}>
                    {summary.subscription.cancelAtPeriodEnd
                      ? 'Cancels ' + formatDate(summary.subscription.currentPeriodEnd)
                      : formatDate(summary.subscription.currentPeriodEnd)}
                  </div>
                </div>
                {summary.subscription.trialEnd && (
                  <div>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>Trial ends</div>
                    <div style={{ fontWeight: '500' }}>{formatDate(summary.subscription.trialEnd)}</div>
                  </div>
                )}
              </div>
              {summary.subscription.cancelAtPeriodEnd && (
                <div style={{ marginTop: '12px', padding: '10px 14px', background: 'var(--color-surface-2)', borderRadius: '6px', fontSize: '13px', color: 'var(--color-warning)' }}>
                  Your subscription will be canceled at the end of the current billing period. You can reactivate from the billing portal.
                </div>
              )}
              {(summary.subscription.status === 'past_due' || summary.subscription.status === 'incomplete') && (
                <div style={{ marginTop: '12px', padding: '10px 14px', background: 'var(--color-surface-2)', borderRadius: '6px', fontSize: '13px', color: 'var(--color-warning)' }}>
                  There is a payment issue with your subscription. Please update your payment method to avoid service interruption.
                </div>
              )}
            </Card>
          )}

          {/* Available Plans */}
          {summary.availablePlans.length > 0 && (
            <Card style={{ padding: '20px' }}>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {summary.subscription ? 'Change plan' : 'Upgrade'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {summary.availablePlans.map((plan) => (
                  <div key={plan.planId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', border: '1px solid var(--color-border)', borderRadius: '8px' }}>
                    <div>
                      <div style={{ fontWeight: '500' }}>{plan.prices[0]?.displayLabel ?? plan.planId}</div>
                      {plan.prices[0]?.amountCents != null && (
                        <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>
                          ${(plan.prices[0].amountCents / 100).toFixed(2)}/{plan.prices[0].interval}
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
                            {upgradeMutation.isPending ? 'Switching…' : `Switch ${price.interval}ly`}
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
                            {checkoutMutation.isPending ? 'Loading…' : `Subscribe ${price.interval}ly`}
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
