import { useState, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { skills as skillsApi, agentTools, type CreateSkillRequest, type Skill, type SkillMetrics } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, EmptyState, SectionLabel, Button, ErrorBanner, ToolTagPicker } from '../../lib/ui.js';
import { useSession } from '../../app/providers/SessionProvider.js';

type SkillCategoryTab = 'all' | 'mine' | 'built-in' | 'marketplace';

function filterSkillsBySearch(skills: Skill[], term: string): Skill[] {
  const t = term.trim().toLowerCase();
  if (!t) return skills;
  return skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(t) ||
      skill.description.toLowerCase().includes(t),
  );
}

export function SkillsPage() {
  const intl = useIntl();
  const { user } = useSession();
  const queryClient = useQueryClient();
  const marketplaceUnavailableMessage = intl.formatMessage({
    id: 'skills.marketplaceUnavailable',
    defaultMessage: 'Marketplace access is not available on your current plan.',
  });
  const skillsEntitlements = user?.planEntitlements?.skills ?? null;
  const canViewMarketplace = skillsEntitlements?.canViewMarketplaceSkills ?? true;
  const privateSkillsDisabled = Boolean(skillsEntitlements && !skillsEntitlements.canCreatePrivateSkills);
  const autoPublishesNonDraftSkills = skillsEntitlements?.autoPublishNonDraftSkills ?? false;
  const canPublishToMarketplace = skillsEntitlements?.canPublishToMarketplace ?? true;
  const canCreatePrivateSkills = skillsEntitlements?.canCreatePrivateSkills ?? true;

  const [activeCategory, setActiveCategory] = useState<SkillCategoryTab>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [showCreateComposer, setShowCreateComposer] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateSkillRequest>({
    name: '',
    description: '',
    instructions: '',
    requiredTools: [],
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

  const toolsQuery = useQuery({
    queryKey: ['agent-tools'],
    queryFn: () => agentTools.list(),
    staleTime: 5 * 60 * 1000,
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

  const rawBuiltIn = (selectableQuery.data?.skills ?? []).filter((skill) => skill.sourceKind === 'system');
  const rawMySkills = mineQuery.data?.skills ?? [];
  const rawMarketplaceSkills = canViewMarketplace
    ? (marketplaceQuery.data?.skills ?? []).filter((skill) => skill.sourceKind === 'user')
    : [];
  const builtIn = filterSkillsBySearch(rawBuiltIn, searchTerm);
  const mySkills = filterSkillsBySearch(rawMySkills, searchTerm);
  const marketplaceSkills = filterSkillsBySearch(rawMarketplaceSkills, searchTerm);
  const hasAnySkills = builtIn.length > 0 || mySkills.length > 0 || marketplaceSkills.length > 0;
  const isLoading = selectableQuery.isLoading || mineQuery.isLoading || (canViewMarketplace && marketplaceQuery.isLoading);
  const queryError = selectableQuery.error ?? mineQuery.error ?? (canViewMarketplace ? marketplaceQuery.error : null);

  const allSkills = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ skill: Skill; mode: 'built-in' | 'mine' | 'marketplace' }> = [];
    for (const skill of mySkills) {
      if (!seen.has(skill.id)) { seen.add(skill.id); result.push({ skill, mode: 'mine' as const }); }
    }
    for (const skill of builtIn) {
      if (!seen.has(skill.id)) { seen.add(skill.id); result.push({ skill, mode: 'built-in' as const }); }
    }
    if (canViewMarketplace) {
      for (const skill of marketplaceSkills) {
        if (!seen.has(skill.id)) { seen.add(skill.id); result.push({ skill, mode: 'marketplace' as const }); }
      }
    }
    return result;
  }, [mySkills, builtIn, marketplaceSkills, canViewMarketplace]);

  const skillTabs: Array<{ key: SkillCategoryTab; label: string }> = [
    { key: 'all', label: intl.formatMessage({ id: 'skills.tab.all', defaultMessage: 'All skills' }) },
    { key: 'mine', label: intl.formatMessage({ id: 'skills.tab.mine', defaultMessage: 'Your skills' }) },
    { key: 'built-in', label: intl.formatMessage({ id: 'skills.tab.builtIn', defaultMessage: 'Built-in' }) },
    { key: 'marketplace', label: intl.formatMessage({ id: 'skills.tab.marketplace', defaultMessage: 'Marketplace' }) },
  ];

  const renderSkillGrid = (skills: Skill[], mode: 'built-in' | 'mine' | 'marketplace') => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px', alignItems: 'start' }}>
      {skills.map((skill) => (
        <SkillCard key={skill.id} skill={skill} mode={mode} onChanged={refreshSkills} skillsEntitlements={skillsEntitlements} tools={toolsQuery.data?.tools ?? []} categories={toolsQuery.data?.categories ?? []} toolsLoading={toolsQuery.isLoading} toolsError={toolsQuery.error} />
      ))}
    </div>
  );

  const renderCategorySection = (
    title: string,
    skills: Skill[],
    mode: 'built-in' | 'mine' | 'marketplace',
    emptyTitle: string,
    emptyMessage: string,
  ) => (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <SectionLabel>{title}</SectionLabel>
      {skills.length > 0 ? renderSkillGrid(skills, mode) : <EmptyState title={emptyTitle} message={emptyMessage} />}
    </section>
  );

  const renderAllSkills = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {allSkills.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px', alignItems: 'start' }}>
          {allSkills.map(({ skill, mode }) => (
            <SkillCard key={skill.id} skill={skill} mode={mode} onChanged={refreshSkills} skillsEntitlements={skillsEntitlements} tools={toolsQuery.data?.tools ?? []} categories={toolsQuery.data?.categories ?? []} toolsLoading={toolsQuery.isLoading} toolsError={toolsQuery.error} />
          ))}
        </div>
      ) : (
        <EmptyState
          title={intl.formatMessage({ id: 'skills.empty.all.title', defaultMessage: 'No skills yet' })}
          message={intl.formatMessage({
            id: 'skills.empty.all.message',
            defaultMessage: 'Skills will appear here once built-in or user-authored capability bundles are available.',
          })}
        />
      )}
      {!canViewMarketplace && (
        <div style={{ color: 'var(--color-text-muted)', fontSize: '13px', lineHeight: '1.5' }}>
          {marketplaceUnavailableMessage}
        </div>
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
            {marketplaceUnavailableMessage}
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

    // All tab keys are exhausted above — fallback to all skills
    return renderAllSkills();
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
            {showCreateComposer
              ? intl.formatMessage({ id: 'common.cancel', defaultMessage: 'Cancel' })
              : intl.formatMessage({ id: 'skills.actions.create', defaultMessage: 'Create skill' })}
          </Button>
        )}
      />

      {showCreateComposer && (
        <Card style={{ marginBottom: '24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontSize: '15px', fontWeight: '600', color: 'var(--color-text-primary)' }}>
            {intl.formatMessage({ id: 'skills.form.createTitle', defaultMessage: 'Create skill' })}
          </div>
          <label style={fieldLabelStyle}>
            {intl.formatMessage({ id: 'skills.form.name', defaultMessage: 'Name' })}
            <input
              value={createDraft.name ?? ''}
              onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))}
              style={inputStyle}
              placeholder={intl.formatMessage({ id: 'skills.form.namePlaceholder', defaultMessage: 'Momentum screener' })}
            />
          </label>
          <label style={fieldLabelStyle}>
            {intl.formatMessage({ id: 'skills.form.description', defaultMessage: 'Description' })}
            <textarea
              value={createDraft.description ?? ''}
              onChange={(event) => setCreateDraft((current) => ({ ...current, description: event.target.value }))}
              style={textareaStyle}
              rows={3}
              placeholder={intl.formatMessage({
                id: 'skills.form.descriptionPlaceholder',
                defaultMessage: 'Short summary of what this skill does',
              })}
            />
          </label>
          <label style={fieldLabelStyle}>
            {intl.formatMessage({ id: 'skills.form.instructions', defaultMessage: 'Instructions' })}
            <textarea
              value={createDraft.instructions ?? ''}
              onChange={(event) => setCreateDraft((current) => ({ ...current, instructions: event.target.value }))}
              style={textareaStyle}
              rows={6}
              placeholder={intl.formatMessage({
                id: 'skills.form.instructionsPlaceholder',
                defaultMessage: 'Detailed instructions used by the agent',
              })}
            />
          </label>
          <label style={fieldLabelStyle}>
            {intl.formatMessage({ id: 'skills.form.promptHint', defaultMessage: 'Prompt hint (optional)' })}
            <textarea
              value={createDraft.promptHint ?? ''}
              onChange={(event) => setCreateDraft((current) => ({ ...current, promptHint: event.target.value || undefined }))}
              style={textareaStyle}
              rows={2}
              placeholder={intl.formatMessage({
                id: 'skills.form.promptHintPlaceholder',
                defaultMessage: 'Shown to creators near the goal field — describes what kind of goal works well with this skill',
              })}
            />
          </label>
          <label style={fieldLabelStyle}>
            {intl.formatMessage({ id: 'skills.form.promptTemplate', defaultMessage: 'Prompt template (optional)' })}
            <textarea
              value={createDraft.promptTemplate ?? ''}
              onChange={(event) => setCreateDraft((current) => ({ ...current, promptTemplate: event.target.value || undefined }))}
              style={textareaStyle}
              rows={4}
              placeholder={intl.formatMessage({
                id: 'skills.form.promptTemplatePlaceholder',
                defaultMessage: 'Pre-populated starter text for the agent goal field — gives creators a concrete starting point',
              })}
            />
          </label>
          <label style={fieldLabelStyle}>
            {intl.formatMessage({ id: 'skills.form.tools', defaultMessage: 'Tools' })}
            <ToolTagPicker
              tools={toolsQuery.data?.tools ?? []}
              categories={toolsQuery.data?.categories ?? []}
              value={createDraft.requiredTools ?? []}
              onChange={(tools) => setCreateDraft((current) => ({ ...current, requiredTools: tools }))}
              loading={toolsQuery.isLoading}
            />
            {toolsQuery.isError && (
              <div style={{ fontSize: '12px', color: 'var(--color-danger)', marginTop: '4px' }}>
                {(toolsQuery.error as Error).message}
              </div>
            )}
          </label>
          <label style={fieldLabelStyle}>
            {intl.formatMessage({ id: 'skills.form.visibility', defaultMessage: 'Visibility' })}
            <select
              value={createDraft.publicationStatus ?? 'draft'}
              onChange={(event) => {
                const publicationStatus = event.target.value as 'draft' | 'private' | 'published';
                setCreateDraft((current) => ({ ...current, publicationStatus }));
              }}
              style={inputStyle}
            >
              <option value="draft">{intl.formatMessage({ id: 'skills.visibility.draft', defaultMessage: 'Draft' })}</option>
              <option value="private" disabled={!canCreatePrivateSkills}>
                {intl.formatMessage({ id: 'skills.visibility.private', defaultMessage: 'Private' })}
              </option>
              <option value="published" disabled={!canPublishToMarketplace}>
                {intl.formatMessage({ id: 'skills.visibility.marketplacePublic', defaultMessage: 'Marketplace (public)' })}
              </option>
            </select>
          </label>
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
            {autoPublishesNonDraftSkills
              ? intl.formatMessage({
                  id: 'skills.visibility.autoPublishHint',
                  defaultMessage: 'Your current plan auto-publishes any non-draft skill.',
                })
              : intl.formatMessage({
                  id: 'skills.visibility.planHint',
                  defaultMessage: 'Choose private or marketplace visibility according to your plan entitlements.',
                })}
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
              {createMutation.isPending
                ? intl.formatMessage({ id: 'skills.actions.creating', defaultMessage: 'Creating...' })
                : intl.formatMessage({ id: 'skills.actions.create', defaultMessage: 'Create skill' })}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setShowCreateComposer(false);
                setCreateError(null);
              }}
              disabled={createMutation.isPending}
            >
              {intl.formatMessage({ id: 'skills.actions.close', defaultMessage: 'Close' })}
            </Button>
          </div>
          {createError && <ErrorBanner message={createError} />}
        </Card>
      )}

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
            title={intl.formatMessage({ id: 'skills.empty.all.title', defaultMessage: 'No skills yet' })}
            message={intl.formatMessage({
              id: 'skills.empty.all.message',
              defaultMessage: 'Skills will appear here once built-in or user-authored capability bundles are available.',
            })}
          />
        </div>
      )}

      {!isLoading && !queryError && hasAnySkills && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
          <input
            type="text"
            placeholder={intl.formatMessage({ id: 'skills.searchPlaceholder', defaultMessage: 'Search skills…' })}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ ...inputStyle, padding: '8px 12px', fontSize: '14px', maxWidth: '360px' }}
          />
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
            ? intl.formatMessage({
                id: 'skills.privatePlanUnavailableWithAutoPublish',
                defaultMessage: 'Your current plan auto-publishes non-draft skills and does not allow private skills.',
              })
            : intl.formatMessage({
                id: 'skills.privatePlanUnavailable',
                defaultMessage: 'Your current plan does not allow private skills.',
              })}
        </div>
      )}
    </PageShell>
  );
}

function SkillCard({
  skill,
  mode,
  onChanged,
  skillsEntitlements,
  tools = [],
  categories = [],
  toolsLoading = false,
  toolsError = null,
}: {
  skill: Skill;
  mode: 'built-in' | 'mine' | 'marketplace';
  onChanged: () => void;
  skillsEntitlements: {
    canCreatePrivateSkills: boolean;
    canViewMarketplaceSkills: boolean;
    canPublishToMarketplace: boolean;
    autoPublishNonDraftSkills: boolean;
    canPriceSkills: boolean;
    canLikeMarketplaceSkills: boolean;
  } | null;
  tools?: { name: string; category: string; description: string }[];
  categories?: { name: string; label: string; count: number }[];
  toolsLoading?: boolean;
  toolsError?: Error | null;
}) {
  const intl = useIntl();
  const [actionError, setActionError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [stagedRevisionId, setStagedRevisionId] = useState<string | null>(null);
  const [editedName, setEditedName] = useState(skill.name);
  const [editedDescription, setEditedDescription] = useState(skill.description);
  const [editedInstructions, setEditedInstructions] = useState(skill.instructions);
  const [editedPromptHint, setEditedPromptHint] = useState(skill.promptHint ?? '');
  const [editedPromptTemplate, setEditedPromptTemplate] = useState(skill.promptTemplate ?? '');
  const [editedRequiredTools, setEditedRequiredTools] = useState<string[]>(skill.requiredTools ?? []);
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
      promptHint: editedPromptHint.trim() || null,
      promptTemplate: editedPromptTemplate.trim() || null,
      requiredTools: editedRequiredTools,
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
  });

  const statusLabel = formatSkillStatusLabel(intl, skill.sourceKind, skill.publicationStatus);
  const priceLabel = skill.priceCents === 0
    ? intl.formatMessage({ id: 'skills.price.free', defaultMessage: 'Free' })
    : intl.formatNumber(skill.priceCents / 100, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
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
    <Card style={{ display: 'flex', flexDirection: 'column', gap: '12px', ...(isEditing ? { gridColumn: '1 / -1' } : {}) }}>
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
        )) : <span style={pillStyle}>{intl.formatMessage({ id: 'skills.capability.base', defaultMessage: 'Base' })}</span>}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        {canPublish && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => publishMutation.mutate()}
            disabled={isActionPending}
            aria-label={hasUnpublishedRevision
              ? intl.formatMessage({ id: 'skills.actions.publishUpdate', defaultMessage: 'Publish update' })
              : intl.formatMessage({ id: 'skills.actions.publish', defaultMessage: 'Publish' })}
            title={hasUnpublishedRevision
              ? intl.formatMessage({ id: 'skills.actions.publishUpdate', defaultMessage: 'Publish update' })
              : intl.formatMessage({ id: 'skills.actions.publish', defaultMessage: 'Publish' })}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </Button>
        )}
        {canDelist && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => delistMutation.mutate()}
            disabled={isActionPending}
            aria-label={intl.formatMessage({ id: 'skills.actions.delist', defaultMessage: 'Delist' })}
            title={intl.formatMessage({ id: 'skills.actions.delist', defaultMessage: 'Delist' })}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
              <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
              <path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
              <line x1="2" y1="2" x2="22" y2="22" />
            </svg>
          </Button>
        )}
        {canLike && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => likeMutation.mutate()}
            disabled={isActionPending}
            aria-label={skill.isLikedByViewer
              ? intl.formatMessage({ id: 'skills.actions.unlike', defaultMessage: 'Unlike' })
              : intl.formatMessage({ id: 'skills.actions.like', defaultMessage: 'Like' })}
            title={skill.isLikedByViewer
              ? intl.formatMessage({ id: 'skills.actions.unlike', defaultMessage: 'Unlike' })
              : intl.formatMessage({ id: 'skills.actions.like', defaultMessage: 'Like' })}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill={skill.isLikedByViewer ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M7 10v12" />
              <path d="M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z" />
            </svg>
            <span style={{ marginLeft: '4px' }}>{skill.likeCount}</span>
          </Button>
        )}
        {canFork && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => forkMutation.mutate()}
            disabled={isActionPending}
            aria-label={intl.formatMessage({ id: 'skills.actions.copy', defaultMessage: 'Copy' })}
            title={intl.formatMessage({ id: 'skills.actions.copy', defaultMessage: 'Copy' })}
          >
            {forkMutation.isPending
              ? intl.formatMessage({ id: 'skills.actions.copying', defaultMessage: 'Copying...' })
              : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
          </Button>
        )}
        {canManage && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setActionError(null);
              setEditedPromptHint(skill.promptHint ?? '');
              setEditedPromptTemplate(skill.promptTemplate ?? '');
              setEditedRequiredTools(skill.requiredTools ?? []);
              setIsEditing((current) => !current);
            }}
            disabled={isActionPending}
            aria-label={isEditing
              ? intl.formatMessage({ id: 'skills.actions.closeEditor', defaultMessage: 'Close editor' })
              : intl.formatMessage({ id: 'skills.actions.edit', defaultMessage: 'Edit' })}
            title={isEditing
              ? intl.formatMessage({ id: 'skills.actions.closeEditor', defaultMessage: 'Close editor' })
              : intl.formatMessage({ id: 'skills.actions.edit', defaultMessage: 'Edit' })}
          >
            {isEditing ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
            )}
          </Button>
        )}

      </div>

      {isEditing && canManage && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid var(--color-border)', paddingTop: '12px' }}>
          <label style={fieldLabelStyle}>
            {intl.formatMessage({ id: 'skills.form.name', defaultMessage: 'Name' })}
            <input
              value={editedName}
              onChange={(event) => setEditedName(event.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={fieldLabelStyle}>
            {intl.formatMessage({ id: 'skills.form.description', defaultMessage: 'Description' })}
            <textarea
              value={editedDescription}
              onChange={(event) => setEditedDescription(event.target.value)}
              rows={3}
              style={textareaStyle}
            />
          </label>
          <label style={fieldLabelStyle}>
            {intl.formatMessage({ id: 'skills.form.instructions', defaultMessage: 'Instructions' })}
            <textarea
              value={editedInstructions}
              onChange={(event) => setEditedInstructions(event.target.value)}
              rows={5}
              style={textareaStyle}
            />
          </label>
          <label style={fieldLabelStyle}>
            {intl.formatMessage({ id: 'skills.form.promptHint', defaultMessage: 'Prompt hint (optional)' })}
            <textarea
              value={editedPromptHint}
              onChange={(event) => setEditedPromptHint(event.target.value)}
              rows={2}
              style={textareaStyle}
              placeholder={intl.formatMessage({
                id: 'skills.form.promptHintPlaceholder',
                defaultMessage: 'Shown to creators near the goal field — describes what kind of goal works well with this skill',
              })}
            />
          </label>
          <label style={fieldLabelStyle}>
            {intl.formatMessage({ id: 'skills.form.promptTemplate', defaultMessage: 'Prompt template (optional)' })}
            <textarea
              value={editedPromptTemplate}
              onChange={(event) => setEditedPromptTemplate(event.target.value)}
              rows={4}
              style={textareaStyle}
              placeholder={intl.formatMessage({
                id: 'skills.form.promptTemplatePlaceholder',
                defaultMessage: 'Pre-populated starter text for the agent goal field — gives creators a concrete starting point',
              })}
            />
          </label>
          <label style={fieldLabelStyle}>
            {intl.formatMessage({ id: 'skills.form.tools', defaultMessage: 'Tools' })}
            <ToolTagPicker
              tools={tools}
              categories={categories}
              value={editedRequiredTools}
              onChange={setEditedRequiredTools}
              loading={toolsLoading}
            />
            {toolsError && (
              <div style={{ fontSize: '12px', color: 'var(--color-danger)', marginTop: '4px' }}>
                {(toolsError as Error).message}
              </div>
            )}
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
              {updateMutation.isPending
                ? intl.formatMessage({ id: 'skills.actions.saving', defaultMessage: 'Saving...' })
                : intl.formatMessage({ id: 'skills.actions.saveUpdate', defaultMessage: 'Save update' })}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditedName(skill.name);
                setEditedDescription(skill.description);
                setEditedInstructions(skill.instructions);
                setEditedPromptHint(skill.promptHint ?? '');
                setEditedPromptTemplate(skill.promptTemplate ?? '');
                setEditedRequiredTools(skill.requiredTools ?? []);
                setIsEditing(false);
              }}
              disabled={updateMutation.isPending}
            >
              {intl.formatMessage({ id: 'common.cancel', defaultMessage: 'Cancel' })}
            </Button>
          </div>
        </div>
      )}

      {canManage && !canPublishByPlan && (
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          {intl.formatMessage({
            id: 'skills.marketplacePublishingUnavailable',
            defaultMessage: 'Your plan does not allow marketplace publishing.',
          })}
        </div>
      )}

      {hasUnpublishedRevision && canManage && (
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          {intl.formatMessage({
            id: 'skills.unpublishedRevisionNotice',
            defaultMessage: 'You have an update ready to be published.',
          })}
        </div>
      )}

      {canManage && !canCreatePrivateSkills && (
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          {intl.formatMessage({
            id: 'skills.privateUnavailable',
            defaultMessage: 'Private skills are unavailable on your current plan.',
          })}
        </div>
      )}

      {mode === 'marketplace' && skill.sourceKind === 'user' && !canLikeByPlan && (
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          {intl.formatMessage({
            id: 'skills.likeUnavailable',
            defaultMessage: 'Liking marketplace skills is unavailable on your current plan.',
          })}
        </div>
      )}

      <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {metricsQuery.isLoading && (
          <div>{intl.formatMessage({ id: 'skills.metrics.loading', defaultMessage: 'Loading metrics...' })}</div>
        )}
        {metricsQuery.isError && (
          <div>
            {intl.formatMessage(
              { id: 'skills.metrics.loadError', defaultMessage: 'Unable to load metrics: {message}' },
              { message: (metricsQuery.error as Error).message },
            )}
          </div>
        )}
        {metrics && (
          <div style={{ display: 'flex', gap: '20px' }}>
            <span>usage: {intl.formatNumber(metrics.usage30d)}</span>
            <span>likes: {intl.formatNumber(metrics.likes30d)}</span>
            <span>copies: {intl.formatNumber(metrics.forks30d)}</span>
          </div>
        )}
      </div>

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
  border: '1.5px solid var(--input-border-color)',
  borderRadius: '8px',
  background: 'var(--color-surface-3)',
  color: 'var(--color-text-primary)',
  fontSize: '13px',
  padding: '8px 10px',
  transition: 'border-color 0.15s, box-shadow 0.15s',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  minHeight: '88px',
  fontFamily: 'inherit',
};

function formatSkillStatusLabel(
  intl: ReturnType<typeof useIntl>,
  sourceKind: Skill['sourceKind'],
  publicationStatus: Skill['publicationStatus'],
): string {
  if (sourceKind === 'system') {
    return intl.formatMessage({ id: 'skills.status.system', defaultMessage: 'System' });
  }

  switch (publicationStatus) {
    case 'draft':
      return intl.formatMessage({ id: 'skills.status.draft', defaultMessage: 'Draft' });
    case 'private':
      return intl.formatMessage({ id: 'skills.status.private', defaultMessage: 'Private' });
    case 'published':
      return intl.formatMessage({ id: 'skills.status.published', defaultMessage: 'Published' });
    case 'archived':
      return intl.formatMessage({ id: 'skills.status.archived', defaultMessage: 'Archived' });
    default:
      return publicationStatus;
  }
}