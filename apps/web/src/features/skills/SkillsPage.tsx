import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { skills as skillsApi, type CreateSkillRequest, type Skill, type SkillMetrics } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, SectionLabel, Button, ErrorBanner } from '../../lib/ui.js';
import { useSession } from '../../app/providers/SessionProvider.js';

type SkillCategoryTab = 'all' | 'mine' | 'built-in' | 'marketplace' | 'admin';

export function SkillsPage() {
  const intl = useIntl();
  const { user } = useSession();
  const queryClient = useQueryClient();
  const skillsEntitlements = user?.planEntitlements?.skills ?? null;
  const canViewMarketplace = skillsEntitlements?.canViewMarketplaceSkills ?? true;
  const privateSkillsDisabled = Boolean(skillsEntitlements && !skillsEntitlements.canCreatePrivateSkills);
  const autoPublishesNonDraftSkills = skillsEntitlements?.autoPublishNonDraftSkills ?? false;
  const canPublishToMarketplace = skillsEntitlements?.canPublishToMarketplace ?? true;
  const canCreatePrivateSkills = skillsEntitlements?.canCreatePrivateSkills ?? true;

  const [activeCategory, setActiveCategory] = useState<SkillCategoryTab>('all');
  const [showCreateComposer, setShowCreateComposer] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateSkillRequest>({
    name: '',
    description: '',
    instructions: '',
    publicationStatus: 'draft',
  });
  const [createError, setCreateError] = useState<string | null>(null);

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
    enabled: canViewMarketplace,
  });

  const adminQuery = useQuery({
    queryKey: ['skills', 'admin'],
    queryFn: () => skillsApi.listAdminIfAllowed(),
  });

  const refreshSkills = () => {
    void queryClient.invalidateQueries({ queryKey: ['skills'] });
  };

  const createMutation = useMutation({
    mutationFn: () => skillsApi.create({
      ...createDraft,
      name: (createDraft.name ?? '').trim(),
      description: (createDraft.description ?? '').trim(),
      instructions: (createDraft.instructions ?? '').trim(),
    }),
    onSuccess: () => {
      setCreateError(null);
      setCreateDraft({
        name: '',
        description: '',
        instructions: '',
        publicationStatus: 'draft',
      });
      setShowCreateComposer(false);
      refreshSkills();
    },
    onError: (error: Error) => {
      setCreateError(error.message);
    },
  });

  const builtIn = (selectableQuery.data?.skills ?? []).filter((skill) => skill.sourceKind === 'system');
  const mySkills = mineQuery.data?.skills ?? [];
  const marketplaceSkills = canViewMarketplace
    ? (marketplaceQuery.data?.skills ?? []).filter((skill) => skill.sourceKind === 'user')
    : [];
  const adminSkills = adminQuery.data?.skills ?? [];
  const adminAccessDenied = adminQuery.data === null;
  const hasAnySkills = builtIn.length > 0 || mySkills.length > 0 || marketplaceSkills.length > 0 || adminSkills.length > 0;
  const isLoading = selectableQuery.isLoading || mineQuery.isLoading || (canViewMarketplace && marketplaceQuery.isLoading) || (adminQuery.isLoading && builtIn.length === 0 && mySkills.length === 0 && marketplaceSkills.length === 0);
  const queryError = selectableQuery.error ?? mineQuery.error ?? (canViewMarketplace ? marketplaceQuery.error : null);
  const skillTabs: Array<{ key: SkillCategoryTab; label: string }> = [
    { key: 'all', label: intl.formatMessage({ id: 'skills.tab.all', defaultMessage: 'All skills' }) },
    { key: 'mine', label: intl.formatMessage({ id: 'skills.tab.mine', defaultMessage: 'Your skills' }) },
    { key: 'built-in', label: intl.formatMessage({ id: 'skills.tab.builtIn', defaultMessage: 'Built-in' }) },
    { key: 'marketplace', label: intl.formatMessage({ id: 'skills.tab.marketplace', defaultMessage: 'Marketplace' }) },
    { key: 'admin', label: intl.formatMessage({ id: 'skills.tab.adminCatalog', defaultMessage: 'Admin catalog' }) },
  ];

  const renderSkillGrid = (skills: Skill[], mode: 'built-in' | 'mine' | 'marketplace' | 'admin') => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
      {skills.map((skill) => (
        <SkillCard key={skill.id} skill={skill} mode={mode} onChanged={refreshSkills} skillsEntitlements={skillsEntitlements} />
      ))}
    </div>
  );

  const renderCategorySection = (
    title: string,
    skills: Skill[],
    mode: 'built-in' | 'mine' | 'marketplace' | 'admin',
    emptyTitle: string,
    emptyMessage: string,
  ) => (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <SectionLabel>{title}</SectionLabel>
      {skills.length > 0 ? renderSkillGrid(skills, mode) : <EmptyState title={emptyTitle} message={emptyMessage} />}
    </section>
  );

  const renderAllSkills = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {mySkills.length > 0 && renderCategorySection(
        intl.formatMessage({ id: 'skills.tab.mine', defaultMessage: 'Your skills' }),
        mySkills,
        'mine',
        intl.formatMessage({ id: 'skills.empty.mine.title', defaultMessage: 'No skills yet' }),
        intl.formatMessage({ id: 'skills.empty.mine.message', defaultMessage: 'Create your first skill to make it available for reuse across agents.' }),
      )}
      {builtIn.length > 0 && renderCategorySection(
        intl.formatMessage({ id: 'skills.tab.builtIn', defaultMessage: 'Built-in' }),
        builtIn,
        'built-in',
        intl.formatMessage({ id: 'skills.empty.builtIn.title', defaultMessage: 'No built-in skills' }),
        intl.formatMessage({ id: 'skills.empty.builtIn.message', defaultMessage: 'Built-in skills will appear here when the system catalog is available.' }),
      )}
      {canViewMarketplace && marketplaceSkills.length > 0 && renderCategorySection(
        intl.formatMessage({ id: 'skills.tab.marketplace', defaultMessage: 'Marketplace' }),
        marketplaceSkills,
        'marketplace',
        intl.formatMessage({ id: 'skills.empty.marketplace.title', defaultMessage: 'No marketplace skills' }),
        intl.formatMessage({ id: 'skills.empty.marketplace.message', defaultMessage: 'Public skills from the marketplace will appear here when they are available for your plan.' }),
      )}
      {!canViewMarketplace && (
        <div style={{ color: 'var(--color-text-muted)', fontSize: '13px', lineHeight: '1.5' }}>
          Marketplace access is not available on your current plan.
        </div>
      )}
      {adminQuery.isLoading && <LoadingRows count={2} />}
      {adminQuery.isError && <ErrorBanner message={(adminQuery.error as Error).message} />}
      {adminAccessDenied && !adminQuery.isLoading && !adminQuery.isError && (
        <div style={{ color: 'var(--color-text-muted)', fontSize: '13px', lineHeight: '1.5' }}>
          Admin scope unavailable for this account.
        </div>
      )}
      {!adminQuery.isLoading && !adminQuery.isError && adminSkills.length > 0 && renderCategorySection(
        intl.formatMessage({ id: 'skills.tab.adminCatalog', defaultMessage: 'Admin catalog' }),
        adminSkills,
        'admin',
        intl.formatMessage({ id: 'skills.empty.admin.title', defaultMessage: 'No admin skills' }),
        intl.formatMessage({ id: 'skills.empty.admin.message', defaultMessage: 'The admin skill catalog is currently empty.' }),
      )}
    </div>
  );

  const renderActiveCategory = () => {
    if (activeCategory === 'all') {
      return renderAllSkills();
    }

    if (activeCategory === 'mine') {
      return renderCategorySection(
        intl.formatMessage({ id: 'skills.tab.mine', defaultMessage: 'Your skills' }),
        mySkills,
        'mine',
        intl.formatMessage({ id: 'skills.empty.mine.title', defaultMessage: 'No skills yet' }),
        intl.formatMessage({ id: 'skills.empty.mine.message', defaultMessage: 'Create your first skill to make it available for reuse across agents.' }),
      );
    }

    if (activeCategory === 'built-in') {
      return renderCategorySection(
        intl.formatMessage({ id: 'skills.tab.builtIn', defaultMessage: 'Built-in' }),
        builtIn,
        'built-in',
        intl.formatMessage({ id: 'skills.empty.builtIn.title', defaultMessage: 'No built-in skills' }),
        intl.formatMessage({ id: 'skills.empty.builtIn.message', defaultMessage: 'Built-in skills will appear here when the system catalog is available.' }),
      );
    }

    if (activeCategory === 'marketplace') {
      if (!canViewMarketplace) {
        return (
          <div style={{ color: 'var(--color-text-muted)', fontSize: '13px', lineHeight: '1.5' }}>
            Marketplace access is not available on your current plan.
          </div>
        );
      }

      return renderCategorySection(
        intl.formatMessage({ id: 'skills.tab.marketplace', defaultMessage: 'Marketplace' }),
        marketplaceSkills,
        'marketplace',
        intl.formatMessage({ id: 'skills.empty.marketplace.title', defaultMessage: 'No marketplace skills' }),
        intl.formatMessage({ id: 'skills.empty.marketplace.message', defaultMessage: 'Public skills from the marketplace will appear here when they are available for your plan.' }),
      );
    }

    if (adminQuery.isLoading) {
      return <LoadingRows count={2} />;
    }

    if (adminQuery.isError) {
      return <ErrorBanner message={(adminQuery.error as Error).message} />;
    }

    if (adminAccessDenied) {
      return (
        <div style={{ color: 'var(--color-text-muted)', fontSize: '13px', lineHeight: '1.5' }}>
          Admin scope unavailable for this account.
        </div>
      );
    }

    return renderCategorySection(
      intl.formatMessage({ id: 'skills.tab.adminCatalog', defaultMessage: 'Admin catalog' }),
      adminSkills,
      'admin',
      intl.formatMessage({ id: 'skills.empty.admin.title', defaultMessage: 'No admin skills' }),
      intl.formatMessage({ id: 'skills.empty.admin.message', defaultMessage: 'The admin skill catalog is currently empty.' }),
    );
  };

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'skills.title', defaultMessage: 'Skills' })}
        subtitle={intl.formatMessage({ id: 'skills.subtitle', defaultMessage: 'Skills extend what AI agents know and can do' })}
        action={(
          <Button
            variant={showCreateComposer ? 'secondary' : 'primary'}
            onClick={() => {
              setCreateError(null);
              setShowCreateComposer((current) => !current);
            }}
          >
            {showCreateComposer ? 'Cancel' : 'Create skill'}
          </Button>
        )}
      />

      {isLoading && <LoadingRows count={3} />}
      {queryError && (
        <ErrorState
          message={(queryError as Error).message}
          onRetry={() => {
            void selectableQuery.refetch();
            void mineQuery.refetch();
            if (canViewMarketplace) {
              void marketplaceQuery.refetch();
            }
          }}
        />
      )}

      {!isLoading && !queryError && !hasAnySkills && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <EmptyState
            title="No skills yet"
            message="Skills will appear here once built-in or user-authored capability bundles are available."
          />
          {adminQuery.isError ? (
            <ErrorBanner message={(adminQuery.error as Error).message} />
          ) : adminAccessDenied ? (
            <div style={{ color: 'var(--color-text-muted)', fontSize: '13px', lineHeight: '1.5' }}>
              Admin scope unavailable for this account.
            </div>
          ) : null}
        </div>
      )}

      {!isLoading && !queryError && hasAnySkills && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {skillTabs.map((tab) => (
              <Button
                key={tab.key}
                variant={activeCategory === tab.key ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setActiveCategory(tab.key)}
              >
                {tab.label}
              </Button>
            ))}
          </div>

          <div>
            {renderActiveCategory()}
          </div>
        </div>
      )}

      {!isLoading && !queryError && privateSkillsDisabled && (
        <div style={{ marginBottom: '24px', color: 'var(--color-text-muted)', fontSize: '12px' }}>
          {autoPublishesNonDraftSkills
            ? 'Your current plan auto-publishes non-draft skills and does not allow private skills.'
            : 'Your current plan does not allow private skills.'}
        </div>
      )}

      {showCreateComposer && (
        <Card style={{ marginBottom: '24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontSize: '15px', fontWeight: '600', color: 'var(--color-text-primary)' }}>Create skill</div>
          <label style={fieldLabelStyle}>
            Name
            <input
              value={createDraft.name ?? ''}
              onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))}
              style={inputStyle}
              placeholder="Momentum screener"
            />
          </label>
          <label style={fieldLabelStyle}>
            Description
            <textarea
              value={createDraft.description ?? ''}
              onChange={(event) => setCreateDraft((current) => ({ ...current, description: event.target.value }))}
              style={textareaStyle}
              rows={3}
              placeholder="Short summary of what this skill does"
            />
          </label>
          <label style={fieldLabelStyle}>
            Instructions
            <textarea
              value={createDraft.instructions ?? ''}
              onChange={(event) => setCreateDraft((current) => ({ ...current, instructions: event.target.value }))}
              style={textareaStyle}
              rows={6}
              placeholder="Detailed instructions used by the agent"
            />
          </label>
          <label style={fieldLabelStyle}>
            Visibility
            <select
              value={createDraft.publicationStatus ?? 'draft'}
              onChange={(event) => {
                const publicationStatus = event.target.value as 'draft' | 'private' | 'published';
                setCreateDraft((current) => ({ ...current, publicationStatus }));
              }}
              style={inputStyle}
            >
              <option value="draft">Draft</option>
              <option value="private" disabled={!canCreatePrivateSkills}>Private</option>
              <option value="published" disabled={!canPublishToMarketplace}>Marketplace (public)</option>
            </select>
          </label>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
            {autoPublishesNonDraftSkills
              ? 'Your current plan auto-publishes any non-draft skill.'
              : 'Choose private or marketplace visibility according to your plan entitlements.'}
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <Button
              variant="primary"
              onClick={() => createMutation.mutate()}
              disabled={
                createMutation.isPending
                || !(createDraft.name ?? '').trim()
                || !(createDraft.description ?? '').trim()
                || !(createDraft.instructions ?? '').trim()
              }
            >
              {createMutation.isPending ? 'Creating...' : 'Create skill'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setShowCreateComposer(false);
                setCreateError(null);
              }}
              disabled={createMutation.isPending}
            >
              Close
            </Button>
          </div>
          {createError && <ErrorBanner message={createError} />}
        </Card>
      )}
    </PageShell>
  );
}

function SkillCard({
  skill,
  mode,
  onChanged,
  skillsEntitlements,
}: {
  skill: Skill;
  mode: 'built-in' | 'mine' | 'marketplace' | 'admin';
  onChanged: () => void;
  skillsEntitlements: {
    canCreatePrivateSkills: boolean;
    canViewMarketplaceSkills: boolean;
    canPublishToMarketplace: boolean;
    autoPublishNonDraftSkills: boolean;
    canPriceSkills: boolean;
    canLikeMarketplaceSkills: boolean;
  } | null;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [showMetrics, setShowMetrics] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [stagedRevisionId, setStagedRevisionId] = useState<string | null>(null);
  const [editedName, setEditedName] = useState(skill.name);
  const [editedDescription, setEditedDescription] = useState(skill.description);
  const [editedInstructions, setEditedInstructions] = useState(skill.instructions);
  const hasUnpublishedRevision = stagedRevisionId !== null || skill.hasStagedRevision;

  const publishMutation = useMutation({
    mutationFn: () => skillsApi.publish(skill.id, { revisionId: stagedRevisionId ?? undefined }),
    onSuccess: () => {
      setActionError(null);
      setStagedRevisionId(null);
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

  const forkMutation = useMutation({
    mutationFn: () => skillsApi.fork(skill.id),
    onSuccess: () => {
      setActionError(null);
      onChanged();
    },
    onError: (error: Error) => setActionError(error.message),
  });

  const updateMutation = useMutation({
    mutationFn: () => skillsApi.update(skill.id, {
      name: editedName.trim(),
      description: editedDescription.trim(),
      instructions: editedInstructions.trim(),
      changeSummary: 'Updated from web editor',
    }),
    onSuccess: (updatedSkill) => {
      setActionError(null);
      setStagedRevisionId(updatedSkill.stagedRevisionId ?? null);
      setIsEditing(false);
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
  const canLikeByPlan = skillsEntitlements?.canLikeMarketplaceSkills ?? true;
  const canPublishByPlan = skillsEntitlements?.canPublishToMarketplace ?? true;
  const canCreatePrivateSkills = skillsEntitlements?.canCreatePrivateSkills ?? true;
  const canLike = mode === 'marketplace' && skill.sourceKind === 'user' && canLikeByPlan;
  const canFork = mode === 'built-in' || mode === 'marketplace';
  const canPublish = canManage
    && canPublishByPlan
    && skill.publicationStatus !== 'archived'
    && (skill.publicationStatus !== 'published' || hasUnpublishedRevision);
  const canDelist = canManage && canCreatePrivateSkills && skill.publicationStatus === 'published';
  const isActionPending = publishMutation.isPending || delistMutation.isPending || likeMutation.isPending || forkMutation.isPending || updateMutation.isPending;
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
            {hasUnpublishedRevision ? 'Publish staged revision' : 'Publish'}
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
        {canFork && (
          <Button size="sm" variant="secondary" onClick={() => forkMutation.mutate()} disabled={isActionPending}>
            {forkMutation.isPending ? 'Copying...' : 'Copy'}
          </Button>
        )}
        {canManage && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setActionError(null);
              setIsEditing((current) => !current);
            }}
            disabled={isActionPending}
          >
            {isEditing ? 'Close editor' : 'Edit'}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setShowMetrics((previous) => !previous)}>
          {showMetrics ? 'Hide metrics' : 'Show metrics'}
        </Button>
      </div>

      {isEditing && canManage && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid var(--color-border)', paddingTop: '12px' }}>
          <label style={fieldLabelStyle}>
            Name
            <input
              value={editedName}
              onChange={(event) => setEditedName(event.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={fieldLabelStyle}>
            Description
            <textarea
              value={editedDescription}
              onChange={(event) => setEditedDescription(event.target.value)}
              rows={3}
              style={textareaStyle}
            />
          </label>
          <label style={fieldLabelStyle}>
            Instructions
            <textarea
              value={editedInstructions}
              onChange={(event) => setEditedInstructions(event.target.value)}
              rows={5}
              style={textareaStyle}
            />
          </label>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <Button
              size="sm"
              variant="primary"
              onClick={() => updateMutation.mutate()}
              disabled={
                updateMutation.isPending
                || !editedName.trim()
                || !editedDescription.trim()
                || !editedInstructions.trim()
              }
            >
              {updateMutation.isPending ? 'Saving...' : 'Save update'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditedName(skill.name);
                setEditedDescription(skill.description);
                setEditedInstructions(skill.instructions);
                setIsEditing(false);
              }}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {canManage && !canPublishByPlan && (
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          Your plan does not allow marketplace publishing.
        </div>
      )}

      {hasUnpublishedRevision && canManage && (
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          You have an unpublished staged revision ready to publish.
        </div>
      )}

      {canManage && !canCreatePrivateSkills && (
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          Private skills are unavailable on your current plan.
        </div>
      )}

      {mode === 'marketplace' && skill.sourceKind === 'user' && !canLikeByPlan && (
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          Liking marketplace skills is unavailable on your current plan.
        </div>
      )}

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

const fieldLabelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  fontSize: '12px',
  color: 'var(--color-text-secondary)',
};

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: '8px',
  background: 'var(--color-surface-2)',
  color: 'var(--color-text-primary)',
  fontSize: '13px',
  padding: '8px 10px',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  minHeight: '88px',
  fontFamily: 'inherit',
};