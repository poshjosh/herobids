import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { skills as skillsApi, type Skill, type SkillMetrics } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, SectionLabel, Button, ErrorBanner } from '../../lib/ui.js';

export function SkillsPage() {
  const queryClient = useQueryClient();

  const selectableQuery = useQuery({
    queryKey: ['skills', 'selectable'],
    queryFn: () => skillsApi.list({ scope: 'selectable' }),
  });

  const mineQuery = useQuery({
    queryKey: ['skills', 'mine'],
    queryFn: () => skillsApi.list({ scope: 'mine', sort: 'newest' }),
  });

  const marketplaceQuery = useQuery({
    queryKey: ['skills', 'marketplace'],
    queryFn: () => skillsApi.list({ scope: 'marketplace', sort: 'popular' }),
  });

  const adminQuery = useQuery({
    queryKey: ['skills', 'admin'],
    queryFn: () => skillsApi.listAdminIfAllowed(),
  });

  const refreshSkills = () => {
    void queryClient.invalidateQueries({ queryKey: ['skills'] });
  };

  const builtIn = (selectableQuery.data?.skills ?? []).filter((skill) => skill.sourceKind === 'system');
  const mySkills = mineQuery.data?.skills ?? [];
  const marketplaceSkills = (marketplaceQuery.data?.skills ?? []).filter((skill) => skill.sourceKind === 'user');
  const adminSkills = adminQuery.data?.skills ?? [];
  const adminAccessDenied = adminQuery.data === null;
  const hasAnySkills = builtIn.length > 0 || mySkills.length > 0 || marketplaceSkills.length > 0 || adminSkills.length > 0;
  const isLoading = selectableQuery.isLoading || mineQuery.isLoading || marketplaceQuery.isLoading;
  const queryError = selectableQuery.error ?? mineQuery.error ?? marketplaceQuery.error;

  return (
    <PageShell>
      <PageHeader
        title="Skills"
        subtitle="Capability bundles that tell AI agents what they can do"
      />

      {isLoading && <LoadingRows count={3} />}
      {queryError && (
        <ErrorState
          message={(queryError as Error).message}
          onRetry={() => {
            void selectableQuery.refetch();
            void mineQuery.refetch();
            void marketplaceQuery.refetch();
          }}
        />
      )}

      {!isLoading && !queryError && !hasAnySkills && (
        <EmptyState
          title="No skills yet"
          message="Skills will appear here once built-in or user-authored capability bundles are available."
        />
      )}

      {builtIn.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
          <SectionLabel>Built-in skills</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
            {builtIn.map((skill) => (
              <SkillCard key={skill.id} skill={skill} mode="built-in" onChanged={refreshSkills} />
            ))}
          </div>
        </section>
      )}

      {mySkills.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
          <SectionLabel>Your skills</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
            {mySkills.map((skill) => (
              <SkillCard key={skill.id} skill={skill} mode="mine" onChanged={refreshSkills} />
            ))}
          </div>
        </section>
      )}

      {marketplaceSkills.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <SectionLabel>Marketplace</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
            {marketplaceSkills.map((skill) => (
              <SkillCard key={skill.id} skill={skill} mode="marketplace" onChanged={refreshSkills} />
            ))}
          </div>
        </section>
      )}

      {!isLoading && !queryError && adminSkills.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '24px' }}>
          <SectionLabel>Admin skill catalog</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
            {adminSkills.map((skill) => (
              <SkillCard key={skill.id} skill={skill} mode="admin" onChanged={refreshSkills} />
            ))}
          </div>
        </section>
      )}

      {!isLoading && !queryError && adminAccessDenied && (
        <div style={{ marginTop: '12px', color: 'var(--color-text-muted)', fontSize: '12px' }}>
          Admin scope unavailable for this account.
        </div>
      )}

      {!isLoading && !queryError && adminQuery.isError && (
        <div style={{ marginTop: '12px' }}>
          <ErrorBanner message={(adminQuery.error as Error).message} />
        </div>
      )}
    </PageShell>
  );
}

function SkillCard({
  skill,
  mode,
  onChanged,
}: {
  skill: Skill;
  mode: 'built-in' | 'mine' | 'marketplace' | 'admin';
  onChanged: () => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [showMetrics, setShowMetrics] = useState(false);

  const publishMutation = useMutation({
    mutationFn: () => skillsApi.publish(skill.id, { priceCents: skill.priceCents }),
    onSuccess: () => {
      setActionError(null);
      onChanged();
    },
    onError: (error: Error) => setActionError(error.message),
  });

  const delistMutation = useMutation({
    mutationFn: () => skillsApi.delist(skill.id),
    onSuccess: () => {
      setActionError(null);
      onChanged();
    },
    onError: (error: Error) => setActionError(error.message),
  });

  const likeMutation = useMutation({
    mutationFn: () => (skill.isLikedByViewer ? skillsApi.unlike(skill.id) : skillsApi.like(skill.id)),
    onSuccess: () => {
      setActionError(null);
      onChanged();
    },
    onError: (error: Error) => setActionError(error.message),
  });

  const metricsQuery = useQuery({
    queryKey: ['skills', 'metrics', skill.id],
    queryFn: () => skillsApi.metrics(skill.id),
    enabled: showMetrics,
  });

  const statusLabel = skill.sourceKind === 'system' ? 'system' : skill.publicationStatus;
  const priceLabel = skill.priceCents === 0 ? 'free' : `$${(skill.priceCents / 100).toFixed(2)}`;
  const canManage = mode === 'mine' && skill.sourceKind === 'user';
  const canLike = mode === 'marketplace' && skill.sourceKind === 'user';
  const canPublish = canManage && skill.publicationStatus !== 'published' && skill.publicationStatus !== 'archived';
  const canDelist = canManage && skill.publicationStatus === 'published';
  const isActionPending = publishMutation.isPending || delistMutation.isPending || likeMutation.isPending;
  const metrics = metricsQuery.data as SkillMetrics | undefined;

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '15px', fontWeight: '600', color: 'var(--color-text-primary)' }}>{skill.name}</div>
          <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)' }}>
            {statusLabel}
          </span>
          <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)' }}>
            {priceLabel}
          </span>
        </div>
        <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>{skill.description}</div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {skill.capabilityFamilies.length > 0 ? skill.capabilityFamilies.map((family) => (
          <span key={family} style={pillStyle}>{family}</span>
        )) : <span style={pillStyle}>base</span>}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        {canPublish && (
          <Button size="sm" variant="primary" onClick={() => publishMutation.mutate()} disabled={isActionPending}>
            Publish
          </Button>
        )}
        {canDelist && (
          <Button size="sm" variant="secondary" onClick={() => delistMutation.mutate()} disabled={isActionPending}>
            Delist
          </Button>
        )}
        {canLike && (
          <Button size="sm" variant="secondary" onClick={() => likeMutation.mutate()} disabled={isActionPending}>
            {skill.isLikedByViewer ? 'Unlike' : 'Like'} ({skill.likeCount})
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setShowMetrics((previous) => !previous)}>
          {showMetrics ? 'Hide metrics' : 'Show metrics'}
        </Button>
      </div>

      {showMetrics && (
        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {metricsQuery.isLoading && <div>Loading metrics...</div>}
          {metricsQuery.isError && <div>Unable to load metrics: {(metricsQuery.error as Error).message}</div>}
          {metrics && (
            <>
              <div>30d usage: {metrics.usage30d} · 30d likes: {metrics.likes30d} · 30d forks: {metrics.forks30d}</div>
              <div>90d usage: {metrics.usage90d} · 90d likes: {metrics.likes90d} · 90d forks: {metrics.forks90d}</div>
              <div>Popularity: {metrics.popularityScore.toFixed(3)} · Trending: {metrics.trendingScore.toFixed(3)}</div>
            </>
          )}
        </div>
      )}

      {actionError && <ErrorBanner message={actionError} />}
    </Card>
  );
}

const pillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '3px 8px',
  borderRadius: '20px',
  background: 'var(--color-surface-2)',
  color: 'var(--color-text-secondary)',
  fontSize: '12px',
};