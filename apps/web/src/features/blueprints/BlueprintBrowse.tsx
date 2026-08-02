import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useQuery } from '@tanstack/react-query';
import {
  PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState,
  Button, KV,
} from '../../lib/ui.js';
import { blueprints, type BlueprintSummary } from '../../lib/api-client.js';
import type { BlueprintBrowseParams } from '../../lib/blueprint-types.js';

interface BlueprintBrowseProps {
  /** Default kind filter. If not passed, shows "All". */
  defaultKind?: 'agent' | 'bot';
  /** Called when user clicks "Use this agent" on an agent blueprint. */
  onUseBlueprint?: (blueprint: BlueprintSummary) => void;
  /** If true, renders as a standalone page (with PageShell/PageHeader). */
  standalone?: boolean;
}

const SORT_OPTIONS: Array<{ value: BlueprintBrowseParams['sort']; label: string }> = [
  { value: 'popular', label: 'Popular' },
  { value: 'trending', label: 'Trending' },
  { value: 'newest', label: 'Newest' },
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

function formatScore(score: number): string {
  if (score >= 1000) return `${(score / 1000).toFixed(1)}k`;
  return String(score);
}

export function BlueprintBrowse({
  defaultKind,
  onUseBlueprint,
  standalone = false,
}: BlueprintBrowseProps) {
  const [kind, setKind] = useState<BlueprintBrowseParams['kind']>(defaultKind);
  const [sort, setSort] = useState<BlueprintBrowseParams['sort']>('popular');
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const currentCursor = cursorStack[cursorStack.length - 1] ?? null;

  const query = useQuery({
    queryKey: ['blueprints', 'browse', { kind, sort, cursor: currentCursor }],
    queryFn: () => blueprints.browse({ kind, sort, cursor: currentCursor ?? undefined, limit: 20 }),
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
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {SORT_OPTIONS.map((opt) => (
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
          {items.map((bp) => (
            <BlueprintCard
              key={bp.id}
              blueprint={bp}
              onUse={onUseBlueprint}
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
  onUse,
}: {
  blueprint: BlueprintSummary;
  onUse?: (blueprint: BlueprintSummary) => void;
}) {
  const intl = useIntl();
  const isAgent = blueprint.kind === 'agent';

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '15px', fontWeight: '600', color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {blueprint.name}
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
      <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
        <KV label="Likes" value={String(blueprint.likeCount)} />
        <KV label="Copies" value={String(blueprint.forkCount)} />
        <KV label="Score" value={formatScore(blueprint.popularityScore)} />
      </div>

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
