import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router';
import { useSession } from '../../app/providers/SessionProvider.js';
import { admin as adminApi } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, Button } from '../../lib/ui.js';
import { AdminOverviewSection } from './AdminOverviewSection.js';
import { AdminUsersSection } from './AdminUsersSection.js';
import { AdminBillingSection } from './AdminBillingSection.js';
import { AdminRuntimeSection } from './AdminRuntimeSection.js';
import { AdminResourcesSection } from './AdminResourcesSection.js';
import { AdminMarketDataSection } from './AdminMarketDataSection.js';

export function AdminPage() {
  const { user } = useSession();

  // Redirect non-admins away from this page
  if (user && !user.isAdmin) {
    return <Navigate to="/agents" replace />;
  }
  const qc = useQueryClient();

  const statsQuery = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => adminApi.stats(),
    refetchInterval: 30_000,
  });

  const usersQuery = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => adminApi.users(),
  });

  const webhooksQuery = useQuery({
    queryKey: ['admin', 'webhooks'],
    queryFn: () => adminApi.webhooks(),
  });

  const containersQuery = useQuery({
    queryKey: ['admin', 'containers'],
    queryFn: () => adminApi.containers(),
    refetchInterval: 30_000,
  });

  const marketDataOverviewQuery = useQuery({
    queryKey: ['admin', 'market-data', 'overview'],
    queryFn: () => adminApi.marketDataOverview(),
    refetchInterval: 60_000,
  });

  const marketDataProvidersQuery = useQuery({
    queryKey: ['admin', 'market-data', 'providers'],
    queryFn: () => adminApi.marketDataProviders(),
    refetchInterval: 60_000,
  });

  const promoteMutation = useMutation({
    mutationFn: (userId: string) => adminApi.promoteUser(userId),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'users'] }); },
  });

  const revokeMutation = useMutation({
    mutationFn: (userId: string) => adminApi.revokeAdmin(userId),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'users'] }); },
  });

  return (
    <PageShell>
      <PageHeader
        title="Admin Dashboard"
        subtitle="Internal operator view — platform health, users, runtime, and market data"
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '32px', marginTop: '24px' }}>
        {/* 1. Overview */}
        <section>
          <SectionHeading>Overview</SectionHeading>
          {statsQuery.isPending ? (
            <LoadingCard />
          ) : statsQuery.isError ? (
            <ErrorCard message="Failed to load platform stats" onRetry={() => { void statsQuery.refetch(); }} />
          ) : statsQuery.data ? (
            <AdminOverviewSection stats={statsQuery.data} />
          ) : null}
        </section>

        {/* 2. Users and Accounts */}
        <section>
          <SectionHeading>Users and Accounts</SectionHeading>
          {usersQuery.isPending ? (
            <LoadingCard />
          ) : usersQuery.isError ? (
            <ErrorCard message="Failed to load users" onRetry={() => { void usersQuery.refetch(); }} />
          ) : (
            <AdminUsersSection
              users={usersQuery.data?.users ?? []}
              onPromote={(id) => { promoteMutation.mutate(id); }}
              onRevoke={(id) => { revokeMutation.mutate(id); }}
              mutationPending={promoteMutation.isPending || revokeMutation.isPending}
            />
          )}
        </section>

        {/* 3. Billing and Usage */}
        <section>
          <SectionHeading>Billing and Usage</SectionHeading>
          {webhooksQuery.isPending ? (
            <LoadingCard />
          ) : webhooksQuery.isError ? (
            <ErrorCard message="Failed to load billing webhooks" onRetry={() => { void webhooksQuery.refetch(); }} />
          ) : (
            <AdminBillingSection webhooks={webhooksQuery.data?.webhooks ?? []} />
          )}
        </section>

        {/* 4. Agents and Runtime */}
        <section>
          <SectionHeading>Agents and Runtime</SectionHeading>
          {containersQuery.isPending ? (
            <LoadingCard />
          ) : containersQuery.isError ? (
            <ErrorCard message="Failed to load runtime data" onRetry={() => { void containersQuery.refetch(); }} />
          ) : (
            <AdminRuntimeSection
              containers={containersQuery.data?.containers ?? null}
              sessions={containersQuery.data?.sessions ?? []}
              dockerError={containersQuery.data?.error}
            />
          )}
        </section>

        {/* 5. Resources */}
        <section>
          <SectionHeading>Resources</SectionHeading>
          {statsQuery.isPending ? (
            <LoadingCard />
          ) : statsQuery.data ? (
            <AdminResourcesSection stats={statsQuery.data} />
          ) : null}
        </section>

        {/* 6. Market Data Provisioning */}
        <section>
          <SectionHeading>Market Data Provisioning</SectionHeading>
          {(marketDataOverviewQuery.isPending || marketDataProvidersQuery.isPending) ? (
            <LoadingCard />
          ) : (marketDataOverviewQuery.isError || marketDataProvidersQuery.isError) ? (
            <ErrorCard message="Failed to load market data" onRetry={() => { void marketDataOverviewQuery.refetch(); void marketDataProvidersQuery.refetch(); }} />
          ) : (
            <AdminMarketDataSection
              overview={marketDataOverviewQuery.data ?? null}
              providers={marketDataProvidersQuery.data?.providers ?? []}
            />
          )}
        </section>
      </div>
    </PageShell>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        margin: '0 0 16px',
        fontSize: '1rem',
        fontWeight: '600',
        color: 'var(--color-text-primary)',
        paddingBottom: '8px',
        borderBottom: '1px solid var(--color-border-subtle)',
      }}
    >
      {children}
    </h2>
  );
}

function LoadingCard() {
  return (
    <Card>
      <div style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>Loading…</div>
    </Card>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card style={{ borderColor: 'var(--color-danger)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{message}</span>
        <Button size="sm" variant="ghost" onClick={onRetry}>Retry</Button>
      </div>
    </Card>
  );
}
