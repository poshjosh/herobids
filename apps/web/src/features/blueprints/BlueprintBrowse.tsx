import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useQuery } from '@tanstack/react-query';
import {
  PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState,
  Button, KV, ErrorBanner,
} from '../../lib/ui.js';
import { blueprints, auth, type BlueprintSummary } from '../../lib/api-client.js';
import type { BlueprintBrowseParams } from '../../lib/blueprint-types.js';
import { useBlueprintLike } from './hooks/useBlueprintLike.js';

interface BlueprintBrowseProps {
  /** Default kind filter. If not passed, shows "All". */
  defaultKind?: 'agent' | 'bot';
  /** Called when user clicks "Use this agent" on an agent blueprint. */
  onUseBlueprint?: (blueprint: BlueprintSummary) => void;
  /** If true, renders as a standalone page (with PageShell/PageHeader). */
  standalone?: boolean;
  /** If true, hides the All/Agents/Bots kind filter tabs. */
  hideKindFilter?: boolean;
}

const SORT_OPTIONS: Array<{ value: BlueprintBrowseParams['sort']; label: string }> = [
  { value: 'popular', label: 'Popular' },
  { value: 'trending', label: 'Trending' },
  { value: 'newest', label: 'Newest' },
  { value: 'ranking', label: 'Ranking' },
];

const KIND_TABS: Array<{ value: BlueprintBrowseParams['kind']; label: string }> = [
  { value: undefined, label: 'All' },
  { value: 'agent', label: 'Agents' },
  { value: 'bot', label: 'Bots' },
];

const pillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 8px',
  borderRadius: '12px',
  background: 'var(--color-surface-2)',
  fontSize: '11px',
  color: 'var(--color-text-secondary)',
  fontWeight: '500',
};

export function BlueprintBrowse({
  defaultKind,
  onUseBlueprint,
  standalone = false,
  hideKindFilter = false,
}: BlueprintBrowseProps) {
  const [kind, setKind] = useState<BlueprintBrowseParams['kind']>(defaultKind);
  const [sort, setSort] = useState<BlueprintBrowseParams['sort']>('popular');
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const currentCursor = cursorStack[cursorStack.length - 1] ?? null;

  // Show "Ranking" sort only when kind is 'agent' or when browsing All (which may include agents).
  // Per Step 6a: Phase 1 proxy for trading context gating.
  const visibleSortOptions = SORT_OPTIONS.filter(
    (opt) => opt.value !== 'ranking' || kind === 'agent' || kind === undefined
  );

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => auth.me(),
    staleTime: 5 * 60 * 1000,
  });
  const canViewMarketplace = meQuery.data?.planEntitlements?.blueprints?.canViewMarketplaceBlueprints ?? true;
  const canLikeByPlan = meQuery.data?.planEntitlements?.blueprints?.canLikeMarketplaceBlueprints ?? true;
  const currentUserId = meQuery.data?.id ?? '';
  const meLoading = meQuery.isLoading;

  // If entitlements loaded and user lacks marketplace view, show a clean message
  if (!meQuery.isLoading && meQuery.data && canViewMarketplace === false) {
    const message = 'Your plan does not include marketplace access. Upgrade your plan to browse blueprints.';
    return standalone ? (
      <PageShell><PageHeader title="Blueprint Marketplace" subtitle="Access restricted" /><ErrorState message={message} /></PageShell>
    ) : (
      <ErrorState message={message} />
    );
  }

  const query = useQuery({
    queryKey: ['blueprints', 'browse', { kind, sort, cursor: currentCursor }],
    queryFn: () => blueprints.browse({ kind, sort, cursor: currentCursor ?? undefined, limit: 20 }),
    enabled: canViewMarketplace !== false,
  });

  const items = query.data?.items ?? [];
  const nextCursor = query.data?.nextCursor ?? null;
  const hasMore = nextCursor !== null;
  const canGoBack = cursorStack.length > 1;

  const handleLoadMore = () => {
    if (nextCursor) {
      setCursorStack((prev) => [...prev, nextCursor]);
    }
  };

  const handleGoBack = () => {
    setCursorStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  };

  const handleKindChange = (newKind: BlueprintBrowseParams['kind']) => {
    setKind(newKind);
    // Reset sort if switching away from a trading-relevant context while ranking
    if (sort === 'ranking' && newKind !== 'agent' && newKind !== undefined) {
      setSort('popular');
    }
    setCursorStack([null]);
  };

  const handleSortChange = (newSort: BlueprintBrowseParams['sort']) => {
    setSort(newSort);
    setCursorStack([null]);
  };

  const content = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Filters row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', justifyContent: 'space-between' }}>
        {!hideKindFilter && (
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {KIND_TABS.map((tab) => (
              <Button
                key={tab.label}
                variant={kind === tab.value ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => handleKindChange(tab.value)}
              >
                {tab.label}
              </Button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {visibleSortOptions.map((opt) => (
            <Button
              key={opt.value}
              variant={sort === opt.value ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => handleSortChange(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Content */}
      {query.isLoading && <LoadingRows count={4} />}
      {query.isError && (
        <ErrorState
          message={(query.error as Error).message}
          onRetry={() => void query.refetch()}
        />
      )}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title="No blueprints found"
          message="No published blueprints match your current filters. Try adjusting them or check back later."
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: '12px',
            alignItems: 'start',
          }}
        >
          {items.map((bp, idx) => (
            <BlueprintCard
              key={bp.id}
              blueprint={bp}
              rank={(cursorStack.length - 1) * 20 + idx + 1}
              onUse={onUseBlueprint}
              canLikeByPlan={canLikeByPlan}
              currentUserId={currentUserId}
              meLoading={meLoading}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {(hasMore || canGoBack) && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px' }}>
          {canGoBack && (
            <Button variant="secondary" size="sm" onClick={handleGoBack}>
              ← Previous
            </Button>
          )}
          {hasMore && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleLoadMore}
              disabled={query.isLoading}
            >
              Load more
            </Button>
          )}
        </div>
      )}
    </div>
  );

  if (standalone) {
    return (
      <PageShell>
        <PageHeader
          title="Blueprint Marketplace"
          subtitle="Discover and deploy AI agents and trading bots from the community"
        />
        {content}
      </PageShell>
    );
  }

  return content;
}

// ── Blueprint Card ──────────────────────────────────────────────────────

function BlueprintCard({
  blueprint,
  rank,
  onUse,
  canLikeByPlan,
  currentUserId,
  meLoading,
}: {
  blueprint: BlueprintSummary;
  rank?: number;
  onUse?: (blueprint: BlueprintSummary) => void;
  canLikeByPlan: boolean;
  currentUserId: string;
  meLoading: boolean;
}) {
  const intl = useIntl();
  const isAgent = blueprint.kind === 'agent';

  const isOwner = currentUserId === blueprint.authorId;
  const canLike = canLikeByPlan && !isOwner && !meLoading;

  const likeToggle = useBlueprintLike(blueprint.id, blueprint.isLikedByViewer);

  const likeLabel = blueprint.isLikedByViewer
    ? intl.formatMessage({ id: 'skills.actions.unlike', defaultMessage: 'Unlike' })
    : intl.formatMessage({ id: 'skills.actions.like', defaultMessage: 'Like' });

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '15px', fontWeight: '600', color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {blueprint.name}
            </span>
            {/* Rank badge — only for trading agents with a score */}
            {isAgent && blueprint.strategyType && blueprint.performanceScore > 0 && rank !== undefined && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '1px 6px',
                borderRadius: '10px',
                background: 'var(--color-accent-subtle)',
                fontSize: '11px',
                fontWeight: '700',
                color: 'var(--color-accent)',
              }}>
                #{rank}
              </span>
            )}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '2px' }}>
            {blueprint.kind === 'agent' ? '🤖 Agent' : '📈 Bot'}
            {blueprint.strategyType && ` · ${blueprint.strategyType}`}
            {blueprint.venueType && ` · ${blueprint.venueType}`}
          </div>
        </div>
        {blueprint.style && (
          <span style={pillStyle}>{blueprint.style}</span>
        )}
      </div>

      {/* Description */}
      <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {blueprint.description || 'No description'}
      </div>

      {/* Tags */}
      {blueprint.tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {blueprint.tags.slice(0, 4).map((tag) => (
            <span key={tag} style={pillStyle}>{tag}</span>
          ))}
          {blueprint.tags.length > 4 && (
            <span style={pillStyle}>+{blueprint.tags.length - 4}</span>
          )}
        </div>
      )}

      {/* Stats */}
      <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: 'var(--color-text-muted)', alignItems: 'center' }}>
        {canLike ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => likeToggle.toggle()}
            disabled={likeToggle.isPending}
            aria-label={likeLabel}
            title={likeLabel}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill={blueprint.isLikedByViewer ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M7 10v12" />
              <path d="M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z" />
            </svg>
            <span style={{ marginLeft: '4px' }}>{blueprint.likeCount}</span>
          </Button>
        ) : (
          <KV label="Likes" value={String(blueprint.likeCount)} />
        )}
        <KV label="Copies" value={String(blueprint.forkCount)} />
      </div>

      {/* Like error feedback */}
      {likeToggle.error && (
        <ErrorBanner message={(likeToggle.error as Error).message} />
      )}

      {/* Action */}
      {isAgent && onUse && (
        <Button
          size="sm"
          variant="secondary"
          style={{ marginTop: '4px', alignSelf: 'flex-start' }}
          aria-label={intl.formatMessage({ id: 'agents.marketplace.useAgent', defaultMessage: 'Use this agent' })}
          title={intl.formatMessage({ id: 'agents.marketplace.useAgent', defaultMessage: 'Use this agent' })}
          onClick={() => onUse(blueprint)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </Button>
      )}
    </Card>
  );
}
