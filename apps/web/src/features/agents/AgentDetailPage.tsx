import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { ApiError, agents as agentsApi, skills as skillsApi, type AgentOutboundMessage, type AgentArtifact, type CapabilityReadiness, type AgentActivityEntry } from '../../lib/api-client.js';
import { PageShell, PageHeader, Card, LoadingRows, ErrorState, ErrorBanner, Button, StatusBadge, RelativeTime, KV, SectionLabel } from '../../lib/ui.js';
import { EditAgentModal } from './EditAgentModal.js';
import { useEventStream, type UserEvent } from '../../lib/useEventStream.js';
import { extractAgentObjective, formatCapabilityFamily, formatCapabilityState, formatExecutionMode, formatSkillSelection, hasCapabilityFamily, resolveSelectedSkills } from './agent-display.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { AgentActivityTimeline } from './AgentActivityTimeline.js';
import { AgentTradesTable } from './AgentTradesTable.js';

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const intl = useIntl();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);
  const [activePromptTab, setActivePromptTab] = useState<'judgeSystem' | 'scoutSystem' | 'userContext' | 'judgeUserContext'>('judgeSystem');

  const handleEvent = useCallback((event: UserEvent) => {
    if (event.type === 'agent.status' && event.agentId === id) {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'capability-readiness', 'trading'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'prompt'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'activity-feed'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'messages'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'artifacts'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'sessions'] });
    } else if ((event.type === 'decision.accepted' || event.type === 'decision.rejected') && event.agentId === id) {
      void qc.invalidateQueries({ queryKey: ['agents', id, 'activity-feed'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'messages'] });
      void qc.invalidateQueries({ queryKey: ['agents', id, 'artifacts'] });
    }
  }, [id, qc]);
  useEventStream(handleEvent);

  const query = useQuery({
    queryKey: ['agents', id],
    queryFn: () => agentsApi.get(id!),
    enabled: !!id,
    refetchInterval: 30_000,
  });

  const shouldPollRuntimePanels = Boolean(query.data?.activeSession)
    || ['active', 'starting', 'paused', 'unhealthy'].includes(query.data?.status ?? '');

  const agent = query.data;

  const getMessageDisplayStatus = (message: AgentOutboundMessage): 'pending' | 'sent' | 'failed' => {
    if (message.deliveryStatus === 'sent' || message.emailDeliveryStatus === 'email_sent') {
      return 'sent';
    }
    if (message.deliveryStatus === 'pending') {
      return 'pending';
    }
    return 'failed';
  };

  const getMessageDeliveryDetail = (message: AgentOutboundMessage): string | null => {
    const viaTelegram = message.deliveryStatus === 'sent';
    const viaEmail = message.emailDeliveryStatus === 'email_sent';

    if (viaTelegram && viaEmail) {
      return intl.formatMessage({
        id: 'agents.detail.messageDelivery.both',
        defaultMessage: 'Delivered via Telegram and email',
      });
    }
    if (viaTelegram) {
      return intl.formatMessage({
        id: 'agents.detail.messageDelivery.telegram',
        defaultMessage: 'Delivered via Telegram',
      });
    }
    if (viaEmail) {
      return intl.formatMessage({
        id: 'agents.detail.messageDelivery.email',
        defaultMessage: 'Delivered via email',
      });
    }
    if (message.deliveryStatus === 'failed' && message.emailDeliveryStatus === 'email_failed_provider') {
      return intl.formatMessage({
        id: 'agents.detail.messageDelivery.failedBoth',
        defaultMessage: 'Telegram and email delivery failed',
      });
    }
    if (message.deliveryStatus === 'failed') {
      return intl.formatMessage({
        id: 'agents.detail.messageDelivery.telegramFailed',
        defaultMessage: 'Telegram delivery failed',
      });
    }
    return null;
  };

  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list({ scope: 'selectable' }),
  });

  const selectedSkills = resolveSelectedSkills(agent?.skillIds ?? [], skillsQuery.data?.skills ?? []);

  const hasTradingCapability = hasCapabilityFamily(selectedSkills, 'trading');

  const capabilityQuery = useQuery({
    queryKey: ['agents', id, 'capability-readiness', 'trading'],
    queryFn: async () => agentsApi.capabilityReadiness(id!, 'trading') as Promise<CapabilityReadiness>,
    enabled: !!id && hasTradingCapability,
  });
  const tradingCapability = capabilityQuery.data;

  const startMutation = useMutation({
    mutationFn: () => agentsApi.start(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: () => agentsApi.pause(id!, 'User paused from UI'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: () => agentsApi.resume(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => agentsApi.stop(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents', id] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => agentsApi.delete(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      navigate('/agents');
    },
  });

  const activityFeedQuery = useQuery({
    queryKey: ['agents', id, 'activity-feed'],
    queryFn: () => agentsApi.activityFeed(id!, { limit: 30 }),
    enabled: !!id,
    refetchInterval: shouldPollRuntimePanels ? 15_000 : false,
  });

  const promptQuery = useQuery({
    queryKey: ['agents', id, 'prompt'],
    queryFn: async () => {
      try {
        return await agentsApi.prompt(id!);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'prompt_not_available') {
          return null;
        }

        throw error;
      }
    },
    enabled: !!id,
    refetchInterval: shouldPollRuntimePanels ? 15_000 : false,
  });

  const messagesQuery = useQuery({
    queryKey: ['agents', id, 'messages'],
    queryFn: () => agentsApi.messages(id!, 20),
    enabled: !!id,
    refetchInterval: shouldPollRuntimePanels ? 15_000 : false,
  });

  const artifactsQuery = useQuery({
    queryKey: ['agents', id, 'artifacts'],
    queryFn: () => agentsApi.artifacts(id!, 10),
    enabled: !!id,
    refetchInterval: shouldPollRuntimePanels ? 15_000 : false,
  });

  const sessionsQuery = useQuery({
    queryKey: ['agents', id, 'sessions'],
    queryFn: () => agentsApi.sessions(id!),
    enabled: !!id,
    refetchInterval: shouldPollRuntimePanels ? 15_000 : false,
  });

  const decisionsQuery = useQuery({
    queryKey: ['agents', id, 'decisions'],
    queryFn: () => agentsApi.decisions(id!, 20),
    enabled: !!id,
    refetchInterval: shouldPollRuntimePanels ? 15_000 : false,
  });

  if (query.isLoading) return <PageShell><LoadingRows count={5} /></PageShell>;
  if (query.isError) return <PageShell><ErrorState message={localizeApiError(intl, query.error, 'common.errorTitle')} onRetry={() => void query.refetch()} /></PageShell>;

  if (!agent) return <PageShell><ErrorState message={intl.formatMessage({ id: 'agents.detail.notFound' })} /></PageShell>;

  const objective = extractAgentObjective(agent.prompt);
  const operatorContextItems: string[] = [
    selectedSkills.length > 0 ? `Skills: ${formatSkillSelection(selectedSkills, intl)}` : null,
    hasTradingCapability && agent.executionMode ? `Execution mode: ${formatExecutionMode(agent.executionMode, intl)}` : null,
  ].filter((item): item is string => item !== null);
  const lifecycleError = startMutation.error ?? pauseMutation.error ?? resumeMutation.error ?? stopMutation.error ?? deleteMutation.error;
  const canStop = ['active', 'starting', 'paused', 'unhealthy'].includes(agent.status);
  const runtimeAlert = agent.status === 'crashed'
    ? intl.formatMessage({ id: 'agents.detail.runtimeAlert.crashed' })
    : (agent.activeSession?.status === 'unhealthy' && agent.status !== 'stopped')
      ? intl.formatMessage({ id: 'agents.detail.runtimeAlert.unhealthy' })
      : null;

  return (
    <PageShell>
      <PageHeader
        title={agent.name}
        subtitle={objective}
        action={
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {(agent.status === 'stopped' || agent.status === 'crashed') && (
              <Button variant="secondary" onClick={() => setIsEditing(true)}>
                {intl.formatMessage({ id: 'agents.detail.editConfig' })}
              </Button>
            )}
            {agent.status === 'stopped' && (
              <Button variant="primary" onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
                {startMutation.isPending ? intl.formatMessage({ id: 'agents.detail.starting' }) : intl.formatMessage({ id: 'agents.detail.start' })}
              </Button>
            )}
            {agent.status === 'active' && (
              <Button variant="secondary" onClick={() => pauseMutation.mutate()} disabled={pauseMutation.isPending}>
                {intl.formatMessage({ id: 'agents.detail.pause' })}
              </Button>
            )}
            {agent.status === 'paused' && (
              <Button variant="primary" onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending}>
                {intl.formatMessage({ id: 'agents.detail.resume' })}
              </Button>
            )}
            {canStop && (
              <Button variant="danger" onClick={() => stopMutation.mutate()} disabled={stopMutation.isPending}>
                {stopMutation.isPending ? intl.formatMessage({ id: 'agents.detail.stopping' }) : intl.formatMessage({ id: 'agents.detail.stop' })}
              </Button>
            )}
            {(agent.status === 'stopped' || agent.status === 'crashed') && (
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm(intl.formatMessage({ id: 'agents.detail.deleteConfirm' }))) {
                    deleteMutation.mutate();
                  }
                }}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? intl.formatMessage({ id: 'agents.detail.deleting' }) : intl.formatMessage({ id: 'common.delete' })}
              </Button>
            )}
          </div>
        }
      />

      {isEditing && (
        <EditAgentModal
          agentId={id!}
          onClose={() => setIsEditing(false)}
          initialData={agent}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {runtimeAlert && <ErrorBanner message={runtimeAlert} />}
        {lifecycleError && <ErrorBanner message={localizeApiError(intl, lifecycleError, 'common.errorTitle')} />}

        <Card>
          <SectionLabel>{intl.formatMessage({ id: 'agents.detail.agentStatus' })}</SectionLabel>
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
            <KV label={intl.formatMessage({ id: 'common.status' })} value={<StatusBadge status={agent.status} />} />
            {hasTradingCapability && <KV label={intl.formatMessage({ id: 'agents.executionMode.label' })} value={formatExecutionMode(agent.executionMode, intl)} />}
            <KV label={intl.formatMessage({ id: 'common.created' })} value={<RelativeTime timestamp={agent.createdAt} />} />
            <KV label={intl.formatMessage({ id: 'common.updated' })} value={<RelativeTime timestamp={agent.updatedAt} />} />
          </div>
        </Card>

        <Card>
          <SectionLabel>{intl.formatMessage({ id: 'agents.detail.objective' })}</SectionLabel>
          <p style={{ margin: '0 0 12px', fontSize: '13px', lineHeight: '1.5' }}>{objective}</p>
          {operatorContextItems.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
              {operatorContextItems.map((item) => (
                <span
                  key={item}
                  style={{
                    padding: '3px 8px',
                    borderRadius: '20px',
                    background: 'var(--color-surface-2)',
                    fontSize: '12px',
                    color: 'var(--color-text-secondary)',
                  }}
                >
                  {item}
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
            {agent.activeSession?.startedAt && (
              <KV label={intl.formatMessage({ id: 'agents.detail.activeSince' })} value={<RelativeTime timestamp={agent.activeSession.startedAt} />} />
            )}
            {sessionsQuery.isSuccess && (
              <KV label={intl.formatMessage({ id: 'agents.detail.sessionsRun' })} value={String((sessionsQuery.data as unknown[]).length)} />
            )}
          </div>
        </Card>

        <Card>
          <SectionLabel>{intl.formatMessage({ id: 'agents.detail.promptSurfaces' })}</SectionLabel>
          {promptQuery.isLoading && <LoadingRows count={1} />}
          {promptQuery.isError && (
            <ErrorState
              message={localizeApiError(intl, promptQuery.error, 'common.errorTitle')}
              onRetry={() => void promptQuery.refetch()}
            />
          )}
          {promptQuery.isSuccess && promptQuery.data === null && (
            <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.5', color: 'var(--color-text-muted)' }}>
              {intl.formatMessage({ id: 'agents.detail.promptUnavailable' })}
            </p>
          )}
          {promptQuery.isSuccess && promptQuery.data !== null && (() => {
            const data = promptQuery.data;
            const tabs: Array<{ key: typeof activePromptTab; label: string }> = [
              { key: 'judgeSystem', label: intl.formatMessage({ id: 'agents.detail.promptTab.judgeSystem' }) },
              { key: 'scoutSystem', label: intl.formatMessage({ id: 'agents.detail.promptTab.scoutSystem' }) },
              { key: 'userContext', label: intl.formatMessage({ id: 'agents.detail.promptTab.userContext' }) },
              { key: 'judgeUserContext', label: intl.formatMessage({ id: 'agents.detail.promptTab.judgeUserContext' }) },
            ];
            const activeContent = data[activePromptTab];
            return (
              <div>
                <div
                  role="tablist"
                  aria-label={intl.formatMessage({ id: 'agents.detail.promptSurfaces' })}
                  style={{ display: 'flex', gap: '4px', marginBottom: '10px', flexWrap: 'wrap' }}
                >
                  {tabs.map((tab) => (
                    <button
                      key={tab.key}
                      id={`agent-prompt-tab-${tab.key}`}
                      type="button"
                      role="tab"
                      aria-selected={activePromptTab === tab.key}
                      aria-controls={`agent-prompt-panel-${tab.key}`}
                      onClick={() => setActivePromptTab(tab.key)}
                      style={{
                        padding: '4px 10px',
                        fontSize: '12px',
                        borderRadius: '6px',
                        border: '1px solid var(--color-border)',
                        background: activePromptTab === tab.key ? 'var(--color-surface-3)' : 'transparent',
                        color: activePromptTab === tab.key ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
                        cursor: 'pointer',
                        fontWeight: activePromptTab === tab.key ? 600 : 400,
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div
                  id={`agent-prompt-panel-${activePromptTab}`}
                  role="tabpanel"
                  aria-labelledby={`agent-prompt-tab-${activePromptTab}`}
                >
                  {activeContent == null ? (
                    <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.5', color: 'var(--color-text-muted)' }}>
                      {intl.formatMessage({ id: 'agents.detail.promptSurfaceUnavailable' })}
                    </p>
                  ) : (
                    <pre
                      style={{
                        margin: 0,
                        padding: '12px 14px',
                        background: 'var(--color-surface-2)',
                        borderRadius: '8px',
                        border: '1px solid var(--color-border)',
                        fontSize: '12px',
                        lineHeight: '1.5',
                        color: 'var(--color-text-secondary)',
                        fontFamily: 'monospace',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        overflow: 'auto',
                        maxHeight: '360px',
                      }}
                    >
                      {activeContent}
                    </pre>
                  )}
                </div>
              </div>
            );
          })()}
        </Card>

        <section aria-label={intl.formatMessage({ id: 'agents.detail.capabilities' })}>
          <Card>
            <SectionLabel>{intl.formatMessage({ id: 'agents.detail.capabilities' })}</SectionLabel>
            {skillsQuery.isLoading && <LoadingRows count={2} />}
            {skillsQuery.isError && <ErrorState message={localizeApiError(intl, skillsQuery.error, 'common.errorTitle')} />}
            {!skillsQuery.isLoading && !skillsQuery.isError && capabilityQuery.isLoading && <LoadingRows count={2} />}
            {capabilityQuery.isError && <ErrorState message={localizeApiError(intl, capabilityQuery.error, 'common.errorTitle')} />}
            {!skillsQuery.isLoading && !skillsQuery.isError && !hasTradingCapability && (
              <div style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>{intl.formatMessage({ id: 'agents.summary.noCapabilitySetup' })}</div>
            )}
            {!skillsQuery.isLoading && !skillsQuery.isError && hasTradingCapability && tradingCapability && (
              <section
                aria-label={intl.formatMessage({ id: 'agents.summary.capabilityReadinessAria' }, { capability: formatCapabilityFamily(tradingCapability.family, intl) })}
                style={{ padding: '14px 16px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'var(--color-surface-1)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: '600' }}>{formatCapabilityFamily(tradingCapability.family, intl)}</div>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{formatCapabilityState(tradingCapability.state, intl)}</div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => navigate(`/agents/${agent.id}/capabilities/${tradingCapability.family}`)}
                  >
                    {tradingCapability.effectiveReady
                      ? intl.formatMessage({ id: 'agents.summary.openCapability' }, { capability: formatCapabilityFamily(tradingCapability.family, intl) })
                      : intl.formatMessage({ id: 'agents.summary.configureCapability' }, { capability: formatCapabilityFamily(tradingCapability.family, intl) })}
                  </Button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                  <div>{intl.formatMessage({ id: 'agents.detail.bindingReadiness' })}: {formatCapabilityState(tradingCapability.bindingReadiness, intl)}</div>
                  <div>{intl.formatMessage({ id: 'agents.detail.agentEligibility' })}: {intl.formatMessage({ id: `agents.eligibility.${tradingCapability.agentEligibility}` })}</div>
                  <div>{intl.formatMessage({ id: 'agents.detail.effectiveReady' })}: {tradingCapability.effectiveReady ? intl.formatMessage({ id: 'common.yes' }) : intl.formatMessage({ id: 'common.no' })}</div>
                  <div>{intl.formatMessage({ id: 'common.binding' })}: {tradingCapability.bindingId ?? intl.formatMessage({ id: 'agents.detail.notAssigned' })}</div>
                  {tradingCapability.reasons.length > 0 && (
                    <div>{intl.formatMessage({ id: 'agents.detail.reasons' })}: {tradingCapability.reasons.join('; ')}</div>
                  )}
                </div>
              </section>
            )}
          </Card>
        </section>

        {hasTradingCapability && (
          <Card>
            <SectionLabel>{intl.formatMessage({ id: 'agents.detail.tradesHistory' })}</SectionLabel>
            <AgentTradesTable agentId={id!} executionMode={agent.executionMode ?? null} isActive={shouldPollRuntimePanels} />
          </Card>
        )}

        {agent.activeSession && (
          <Card>
            <SectionLabel>{intl.formatMessage({ id: 'agents.detail.runtimeHealth' })}</SectionLabel>
            <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
              <KV label={intl.formatMessage({ id: 'agents.detail.session' })} value={agent.activeSession.id.slice(0, 8)} />
              <KV label={intl.formatMessage({ id: 'common.status' })} value={<StatusBadge status={agent.activeSession.status} />} />
              <KV label={intl.formatMessage({ id: 'agents.detail.lastHeartbeat' })} value={<RelativeTime timestamp={agent.activeSession.lastHeartbeatAt} />} />
            </div>
          </Card>
        )}

        <Card>
          <SectionLabel>{intl.formatMessage({ id: 'agents.detail.messagesToUser' })}</SectionLabel>
          {messagesQuery.isLoading && <LoadingRows count={3} />}
          {messagesQuery.isSuccess && messagesQuery.data.length === 0 && (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>{intl.formatMessage({ id: 'agents.detail.noMessages' })}</p>
          )}
          {messagesQuery.isSuccess && messagesQuery.data.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {messagesQuery.data.map((msg: AgentOutboundMessage) => {
                const displayStatus = getMessageDisplayStatus(msg);
                const deliveryDetail = getMessageDeliveryDetail(msg);

                return <div key={msg.id} style={{ padding: '10px 12px', borderRadius: '6px', background: 'var(--color-surface-raised)', fontSize: '13px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: msg.subject ? '4px' : '0' }}>
                    <span style={{ fontWeight: '500', color: msg.authoredBy === 'platform' ? 'var(--color-warning)' : 'var(--color-text)' }}>
                      {msg.authoredBy === 'platform' ? intl.formatMessage({ id: 'agents.detail.messageAuthor.platform' }) : intl.formatMessage({ id: 'agents.detail.messageAuthor.agent' })}
                    </span>
                    <span style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <StatusBadge status={displayStatus} />
                      <RelativeTime timestamp={msg.createdAt} />
                    </span>
                  </div>
                  {msg.subject && <div style={{ fontWeight: '600', marginBottom: '2px' }}>{msg.subject}</div>}
                  <div style={{ color: 'var(--color-text-muted)' }}>{msg.body}</div>
                  {deliveryDetail && <div style={{ color: 'var(--color-text-muted)', fontSize: '12px', marginTop: '4px' }}>{deliveryDetail}</div>}
                </div>
              })}
            </div>
          )}
        </Card>

        <Card>
          <SectionLabel>{intl.formatMessage({ id: 'agents.detail.recentDecisions' })}</SectionLabel>
          {decisionsQuery.isLoading && <LoadingRows count={3} />}
          {decisionsQuery.isSuccess && (decisionsQuery.data as unknown[]).length === 0 && (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>{intl.formatMessage({ id: 'agents.detail.noDecisions' })}</p>
          )}
          {decisionsQuery.isSuccess && (decisionsQuery.data as unknown[]).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
              {(decisionsQuery.data as Array<{ id: string; intent: string; createdAt: string }>).map((d) => (
                <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <span>{d.intent}</span>
                  <RelativeTime timestamp={d.createdAt} />
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <SectionLabel>{intl.formatMessage({ id: 'agents.detail.activityTimeline', defaultMessage: 'Activity Timeline' })}</SectionLabel>
          {activityFeedQuery.isError
            ? (
              <ErrorState
                message={localizeApiError(intl, activityFeedQuery.error, 'common.errorTitle')}
                onRetry={() => void activityFeedQuery.refetch()}
              />
            )
            : (
              <AgentActivityTimeline
                entries={(activityFeedQuery.data?.entries ?? []) as AgentActivityEntry[]}
                isLoading={activityFeedQuery.isLoading}
                isEmpty={activityFeedQuery.isSuccess && (activityFeedQuery.data?.entries.length ?? 0) === 0}
              />
            )}
        </Card>

        <Card>
          <SectionLabel>{intl.formatMessage({ id: 'agents.detail.artifacts' })}</SectionLabel>
          {artifactsQuery.isLoading && <LoadingRows count={3} />}
          {artifactsQuery.isSuccess && artifactsQuery.data.length === 0 && (
            <p style={{ color: 'var(--color-text-muted)', fontSize: '13px' }}>{intl.formatMessage({ id: 'agents.detail.noArtifacts' })}</p>
          )}
          {artifactsQuery.isSuccess && artifactsQuery.data.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
              {artifactsQuery.data.map((a: AgentArtifact) => (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <span>
                    <span style={{ fontWeight: '500' }}>{a.artifactType}</span>
                    {' · '}
                    <span style={{ color: 'var(--color-text-muted)' }}>{a.contentType}</span>
                    {a.summary && <span style={{ marginLeft: '8px', color: 'var(--color-text-muted)' }}>{a.summary}</span>}
                  </span>
                  <RelativeTime timestamp={a.createdAt} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </PageShell>
  );
}