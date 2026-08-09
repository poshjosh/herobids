import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { blueprints, auth as authApi } from '../../lib/api-client.js';
import {
  PageShell, PageHeader, Card, LoadingRows, ErrorState,
  Button, SectionLabel, KV, ErrorBanner,
} from '../../lib/ui.js';
import { BlueprintEditModal } from './BlueprintEditModal.js';
import { useBlueprintLike } from './hooks/useBlueprintLike.js';

interface BlueprintDetailPageProps {
  blueprintId: string;
}

const pillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 8px',
  borderRadius: '12px',
  background: 'var(--color-surface-2)',
  fontSize: '0.6875rem',
  color: 'var(--color-text-secondary)',
  fontWeight: '500',
};

export function BlueprintDetailPage({ blueprintId }: BlueprintDetailPageProps) {
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);

  // Current user for ownership check
  const intl = useIntl();
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me(),
    staleTime: 5 * 60 * 1000,
  });

  const canViewMarketplace = meQuery.data?.planEntitlements?.blueprints?.canViewMarketplaceBlueprints ?? true;

  // If entitlements loaded and user lacks marketplace view, show a clean message
  if (!meQuery.isLoading && meQuery.data && canViewMarketplace === false) {
    return (
      <PageShell>
        <PageHeader title="Blueprint" subtitle="Access restricted" />
        <ErrorState message="Your plan does not include marketplace access. Upgrade your plan to view blueprint details." />
      </PageShell>
    );
  }

  const detailQuery = useQuery({
    queryKey: ['blueprints', blueprintId],
    queryFn: () => blueprints.get(blueprintId),
    enabled: canViewMarketplace !== false,
  });

  // Lifecycle mutations
  const lifecycleMutation = useMutation({
    mutationFn: async (action: string) => {
      const bpId = blueprintId;
      switch (action) {
        case 'publish':
          return blueprints.publish(bpId, { expectedCurrentRevisionId: detailQuery.data?.currentRevisionId! });
        case 'delist':
          return blueprints.delist(bpId);
        case 'archive':
          return blueprints.archive(bpId);
        case 'draft':
          return blueprints.draft(bpId);
        case 'private':
          return blueprints.private(bpId);
        default:
          throw new Error(`Unknown lifecycle action: ${action}`);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['blueprints', blueprintId] });
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: () => blueprints.delete(blueprintId),
    onSuccess: () => {
      window.history.back();
    },
  });

  // Must be called BEFORE any early returns — Rules of Hooks
  const likeToggle = useBlueprintLike(blueprintId, detailQuery.data?.isLikedByViewer ?? false);

  if (detailQuery.isLoading || meQuery.isLoading) {
    return (
      <PageShell>
        <PageHeader title="Blueprint" subtitle="Loading..." />
        <LoadingRows count={6} />
      </PageShell>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <PageShell>
        <PageHeader title="Blueprint" subtitle="Not found" />
        <ErrorState
          message={(detailQuery.error as Error)?.message ?? 'The requested blueprint could not be found.'}
        />
      </PageShell>
    );
  }

  const bp = detailQuery.data;
  const rev = bp.revision;
  const isOwner = meQuery.data?.id === bp.authorId;
  const isAdmin = meQuery.data?.isAdmin ?? false;
  const canEdit = isOwner || isAdmin;
  const isDraft = bp.publicationStatus === 'draft';
  const isPublished = bp.publicationStatus === 'published';
  const isPrivate = bp.publicationStatus === 'private';
  const isDelisted = bp.publicationStatus === 'delisted';
  const hasStagedEdits = bp.currentRevisionId !== bp.publishedRevisionId && isPublished;

  const canLikeByPlan = meQuery.data?.planEntitlements?.blueprints.canLikeMarketplaceBlueprints ?? true;
  const canLike = canLikeByPlan && !isOwner && !meQuery.isLoading;

  const handleLifecycle = (action: string) => {
    if (action === 'delete') {
      if (window.confirm('Permanently delete this draft blueprint? This cannot be undone.')) {
        deleteMutation.mutate();
      }
      return;
    }
    lifecycleMutation.mutate(action);
  };

  const canDelete = isDraft && bp.publishedAt === null && isOwner;

  return (
    <PageShell>
      <PageHeader
        title={bp.name}
        subtitle={
          `${bp.publicationStatus}${hasStagedEdits ? ' · Staged edits' : ''}`
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {/* Owner actions */}
        {canEdit && (
          <Card>
            <SectionLabel>Owner Actions</SectionLabel>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
              <Button variant="primary" size="sm" onClick={() => setEditOpen(true)}>
                Edit
              </Button>

              {/* Lifecycle actions based on current status */}
              {isDraft && (
                <>
                  <Button variant="secondary" size="sm" onClick={() => handleLifecycle('private')}>
                    Make Private
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => handleLifecycle('publish')}>
                    Publish
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => handleLifecycle('archive')}>
                    Archive
                  </Button>
                </>
              )}
              {isPrivate && (
                <>
                  <Button variant="secondary" size="sm" onClick={() => handleLifecycle('draft')}>
                    Move to Draft
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => handleLifecycle('publish')}>
                    Publish
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => handleLifecycle('archive')}>
                    Archive
                  </Button>
                </>
              )}
              {isPublished && (
                <>
                  <Button variant="secondary" size="sm" onClick={() => handleLifecycle('publish')}>
                    Publish Current
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => handleLifecycle('delist')}>
                    Delist
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => handleLifecycle('archive')}>
                    Archive
                  </Button>
                </>
              )}
              {isDelisted && (
                <>
                  <Button variant="secondary" size="sm" onClick={() => handleLifecycle('publish')}>
                    Republish
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => handleLifecycle('archive')}>
                    Archive
                  </Button>
                </>
              )}

              {canDelete && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleLifecycle('delete')}
                  disabled={deleteMutation.isPending}
                  style={{ color: 'var(--color-danger, #dc3545)' }}
                >
                  {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
                </Button>
              )}
            </div>

            {(lifecycleMutation.isError) && (
              <ErrorBanner message={(lifecycleMutation.error as Error).message} />
            )}
          </Card>
        )}

        {/* Detail info */}
        <Card>
          <SectionLabel>Details</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '8px' }}>
            <KV label="Kind" value={bp.kind} />
            <KV label="Author ID" value={bp.authorId} />
            <KV label="Strategy Type" value={bp.strategyType ?? '—'} />
            <KV label="Style" value={bp.style ?? '—'} />
            <KV label="Venue Type" value={bp.venueType ?? '—'} />
            <KV label="Tags" value={bp.tags.length > 0 ? bp.tags.join(', ') : '—'} />
            {canLike ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginRight: '4px' }}>Likes</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => likeToggle.toggle()}
                    disabled={likeToggle.isPending}
                    aria-label={bp.isLikedByViewer
                      ? intl.formatMessage({ id: 'skills.actions.unlike', defaultMessage: 'Unlike' })
                      : intl.formatMessage({ id: 'skills.actions.like', defaultMessage: 'Like' })}
                    title={bp.isLikedByViewer
                      ? intl.formatMessage({ id: 'skills.actions.unlike', defaultMessage: 'Unlike' })
                      : intl.formatMessage({ id: 'skills.actions.like', defaultMessage: 'Like' })}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill={bp.isLikedByViewer ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d="M7 10v12" />
                      <path d="M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z" />
                    </svg>
                    <span style={{ marginLeft: '4px' }}>{bp.likeCount}</span>
                  </Button>
                </div>
                {likeToggle.error && (
                  <ErrorBanner message={(likeToggle.error as Error).message} />
                )}
              </div>
            ) : (
              <KV label="Likes" value={String(bp.likeCount)} />
            )}
            <KV label="Forks" value={String(bp.forkCount)} />
            <KV label="Published" value={bp.publishedAt ?? '—'} />
            <KV label="Created" value={new Date(bp.createdAt).toLocaleString()} />
            <KV label="Updated" value={new Date(bp.updatedAt).toLocaleString()} />
          </div>
        </Card>

        {/* Description */}
        {rev.description && (
          <Card>
            <SectionLabel>Description</SectionLabel>
            <div style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', lineHeight: '1.6', marginTop: '8px' }}>
              {rev.description}
            </div>
          </Card>
        )}

        {/* Revisions info */}
        <Card>
          <SectionLabel>Revisions</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
            {/* Published revision badge */}
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <span style={{
                ...pillStyle,
                background: 'var(--color-success-bg, #e6f4ea)',
                color: 'var(--color-success, #1e7e34)',
              }}>
                Published revision
              </span>
              <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                {bp.publishedRevisionId ? `v${rev.version}` : 'Not published'}
              </span>
              {bp.publishedRevisionId && (
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', fontFamily: 'monospace' }}>
                  {bp.publishedRevisionId}
                </span>
              )}
            </div>

            {/* Current (editing) revision badge */}
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <span style={{
                ...pillStyle,
                background: hasStagedEdits ? 'var(--color-warning-bg, #fff3cd)' : 'var(--color-surface-2)',
                color: hasStagedEdits ? 'var(--color-warning, #856404)' : 'var(--color-text-secondary)',
              }}>
                Current (editing) revision
              </span>
              <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                v{rev.version}
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', fontFamily: 'monospace' }}>
                {bp.currentRevisionId}
              </span>
            </div>
          </div>
        </Card>

        {/* Skills (agent only) */}
        {bp.kind === 'agent' && rev.skills.length > 0 && (
          <Card>
            <SectionLabel>Skills ({rev.skills.length})</SectionLabel>
            <div style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--color-text-muted)', marginTop: '8px' }}>
              {rev.skills.map((s, i) => (
                <div key={i}>
                  skillId: {s.skillId} | revisionId: {s.skillRevisionId}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* Edit modal */}
      {editOpen && (
        <BlueprintEditModal
          blueprint={bp}
          onClose={() => setEditOpen(false)}
          onEdited={(_updated) => {
            setEditOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['blueprints', blueprintId] });
          }}
        />
      )}
    </PageShell>
  );
}
