import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { getAllowedReasoningLevels, RUNTIME_POLICY_CEILINGS } from '@herobids/domain';
import { agents as agentsApi, capabilities as capabilitiesApi, skills as skillsApi, auth as authApi, ai as aiApi, providerCatalog as providerCatalogApi, dashboard, type AgentOutcomes, type ProviderSetupResult, type Skill } from '../../lib/api-client.js';
import { PageShell, PageHeader, LoadingRows, ErrorState, EmptyState, Button, Card, SectionLabel, MetricCard, Modal, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { formatExecutionMode, formatSkillSelection, hasCapabilityFamily, listSelectableSkills, resolveSkillPresetSkillIds, resolvePromptTemplate, resolveGoalPlaceholder, type SkillPresetId } from './agent-display.js';
import { AgentSummaryCard } from './AgentSummaryCard.js';
import { SkillPicker } from './SkillPicker.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { formatPnl, pnlColor } from '../../lib/formatting.js';
import { ActivityItem } from '../activity/ActivityItem.js';
import { AgentActivityItem } from '../activity/AgentActivityItem.js';
import { mergeActivityFeedItems } from '../activity/activity-feed-items.js';
import { AgentAssignmentStep } from '../setup/AgentAssignmentStep.js';
import { useEventStream, type UserEvent } from '../../lib/useEventStream.js';
import { ProviderSetupForm } from '../setup/ProviderSetupForm.js';
import { ModelSelectionFields, resolveDefaultModelSelection } from '../settings/ModelSelectionFields.js';
import { resolveCreateAgentModelPayload } from './create-agent-models.js';
import { buildCreateAgentPayload, resolveCreateAgentConnectionIds } from './agent-payloads.js';
import { TradingGuardrailsFields } from './AgentControlsSection.js';
import { getTickIntervalValidationMessageId, parseTickIntervalMinutesInput } from './tick-interval.js';
import { type CapabilityMode, type HybridMode } from './CapabilitySelector.js';
import { applyAutoMaxHoldOverride, type AgentStyleValue, resolveStyleDefaults, formatStyleSummary, resolveModelPricing, type RuntimePolicyOverrides } from './style-mapping.js';

const STYLE_LABEL_KEYS: Record<AgentStyleValue, string> = {
  careful: 'agents.style.careful.label',
  balanced: 'agents.style.balanced.label',
  bold: 'agents.style.bold.label',
};
import { generateAgentName } from './agent-name.js';
import { PromptInputBlock } from './PromptInputBlock.js';
import { AgentFormBody } from './AgentFormBody.js';
import { intentToFormState } from './agent-form-state.js';
import { defaultTechnicalConfigFormState, technicalFormStateToPayload, type TechnicalConfigFormState } from './technical-config-helpers.js';
import { validateCreateAgentForm, type ValidationConstraints } from './form-validation.js';
import { RuntimePolicySection } from './RuntimePolicySection.js';


import { VENUE_TYPE_MAP, buildVenueTypeMap } from './venue-mapping.js';

type CreateStep = 'intent' | 'review';

interface IntentState {
  name: string;
  goal: string;
  capabilityMode: CapabilityMode;
  hybridMode?: HybridMode;
  /** true = technical pre-filter scanner runs before LLM decides (ON by default for trading agents) */
  technicalPreFilterEnabled: boolean;
  technicalConfig: TechnicalConfigFormState;
  skillPreset: SkillPresetId;
  skillIds: string[];
  executionMode: 'test' | 'live';
  provider: string;
  lightModel: string;
  heavyModel: string;
  telegramChatId: string;
  connectionIds: string[];
  /** Per-agent email delivery override. */
  emailDelivery: 'inherit' | 'allow' | 'disable';
  /** Derived from selected connection's provider, or user-picked in test mode. */
  venue: string;
  /** Derived from venue: hyperliquid→orderbook, jupiter→swap, etc. */
  venueType: '' | 'orderbook' | 'swap';
  style: AgentStyleValue;
  // Configurable controls
  costPreset: '' | 'minimal' | 'standard' | 'premium' | 'custom';
  dailySpendBudgetUsd: string;
  tickIntervalMins: string;
  capital: string;
  dailyLossLimit: string;
  maxDrawdownPct: string;
  maxSlippageBps: string;
  maxOpenPositions: string;
  maxPositionSizePct: string;
  stopLossPct: string;
  stopLossCooldownSecs: string;
  openPositionEscalationToJudgePolicy: 'never' | 'uncovered_or_triggered' | 'always';
  runtimePolicyOverrides: RuntimePolicyOverrides | null;
  strategyPreset: string;
  subscribedSources: string[];
  pendingFiles: File[];
}

export function AgentsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const intl = useIntl();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();

  useEffect(() => {
    const createRequested = new URLSearchParams(location.search).get('create') === '1';
    if (createRequested) {
      setShowCreate(true);
    }
  }, [location.search]);

  const query = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
  });

  const outcomesQuery = useQuery({
    queryKey: ['agents', 'outcomes'],
    queryFn: () => agentsApi.outcomes(),
  });

  const outcomesByAgentId = useMemo(() => {
    const map = new Map<string, AgentOutcomes['outcomes']>();
    for (const entry of outcomesQuery.data?.outcomes ?? []) {
      map.set(entry.agentId, entry.outcomes);
    }
    return map;
  }, [outcomesQuery.data]);

  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list({ scope: 'selectable' }),
  });

  // ── Dashboard data (from Mission Control) ──────────────────────
  const handleEvent = useCallback((event: UserEvent) => {
    if (event.type === 'agent.status') {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['dashboard', 'agent-activity'] });
    } else if (event.type === 'decision.accepted' || event.type === 'decision.rejected') {
      void qc.invalidateQueries({ queryKey: ['dashboard', 'agent-activity'] });
      void qc.invalidateQueries({ queryKey: ['dashboard', 'activity'] });
    } else if (event.type === 'risk.guardrail') {
      void qc.invalidateQueries({ queryKey: ['dashboard', 'activity'] });
    }
  }, [qc]);
  useEventStream(handleEvent);

  const activityQuery = useQuery({
    queryKey: ['dashboard', 'activity', { limit: 8 }],
    queryFn: () => dashboard.activity({ limit: 8 }),
  });

  const agentActivityQuery = useQuery({
    queryKey: ['dashboard', 'agent-activity', { limit: 8 }],
    queryFn: () => dashboard.agentActivity({ limit: 8 }),
    refetchInterval: 30_000,
  });

  const overviewQuery = useQuery({
    queryKey: ['dashboard', 'overview'],
    queryFn: () => dashboard.overview(),
  });

  // ── Setup flow state (from Mission Control) ────────────────────
  const [showSetup, setShowSetup] = useState(false);
  const [setupStep, setSetupStep] = useState<'form' | 'assign'>('form');
  const [setupResult, setSetupResult] = useState<ProviderSetupResult | null>(null);
  const [setupSuccess, setSetupSuccess] = useState<{ label: string; provider: string } | null>(null);

  const items = query.data ?? [];
  const mergedRecentActivity = mergeActivityFeedItems(
    agentActivityQuery.data?.entries ?? [],
    activityQuery.data?.events ?? []
  );

  const counts = {
    active: items.filter((agent) => agent.status === 'active' || agent.status === 'starting').length,
    paused: items.filter((agent) => agent.status === 'paused').length,
    unhealthy: items.filter((agent) => agent.status === 'crashed' || agent.status === 'unhealthy').length,
    stopped: items.filter((agent) => agent.status === 'stopped').length,
  };
  const selectableSkills = listSelectableSkills(skillsQuery.data?.skills ?? []);

  const openCreate = () => {
    setShowCreate(true);
    navigate('/agents?create=1', { replace: true });
  };

  const closeCreate = () => {
    setShowCreate(false);
    navigate('/agents', { replace: true });
  };

  return (
    <PageShell>
      <PageHeader
        title={intl.formatMessage({ id: 'agents.title' })}
        subtitle={intl.formatMessage({ id: 'agents.subtitle' })}
        action={<Button variant="primary" onClick={openCreate}>{intl.formatMessage({ id: 'agents.newAgent' })}</Button>}
      />

      {/* ── Summary metrics ─────────────────────────────────────── */}
      {query.isSuccess && items.length > 0 && (
        <div className="metrics-summary-row">
          <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.active' })} value={counts.active} total={items.length} />
          <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.paused' })} value={counts.paused} />
          <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.unhealthy' })} value={counts.unhealthy} />
          <MetricCard className="metrics-summary-card" label={intl.formatMessage({ id: 'missionControl.metric.stopped' })} value={counts.stopped} />
          <MetricCard
            className="metrics-summary-card"
            label={intl.formatMessage({ id: 'missionControl.metric.totalPnl' })}
            value={overviewQuery.isLoading ? '—' : formatPnl(overviewQuery.data?.summary.outcomes.trading?.totalRealizedPnl)}
            color={overviewQuery.isLoading ? undefined : pnlColor(overviewQuery.data?.summary.outcomes.trading?.totalRealizedPnl)}
          />
        </div>
      )}

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={localizeApiError(intl, query.error, 'common.errorTitle')} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title={intl.formatMessage({ id: 'agents.empty.title' })}
          message={intl.formatMessage({ id: 'agents.empty.message' })}
          action={<Button variant="primary" onClick={openCreate}>{intl.formatMessage({ id: 'agents.createAgent' })}</Button>}
        />
      )}

      {/* ── Quick trading setup card ─────────────────────────────── */}
      {query.isSuccess && items.length > 0 && (
        setupSuccess ? (
          <Card style={{ padding: '12px 16px', marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', background: 'var(--color-surface-success, rgba(34,197,94,0.08))', border: '1px solid var(--color-border-subtle)' }}>
            <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
              {intl.formatMessage({ id: 'missionControl.setup.successMessage' }, { label: setupSuccess.label, provider: setupSuccess.provider })}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setSetupSuccess(null)}>
              {intl.formatMessage({ id: 'missionControl.setup.successDismiss' })}
            </Button>
          </Card>
        ) : (
          <Card style={{ padding: '12px 16px', marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', border: '1px solid var(--color-border-subtle)' }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: '600', marginBottom: '2px' }}>
                {intl.formatMessage({ id: 'missionControl.setup.title' })}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
                {intl.formatMessage({ id: 'missionControl.setup.message' })}
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setShowSetup(true)}>
              {intl.formatMessage({ id: 'missionControl.setup.cta' })}
            </Button>
          </Card>
        )
      )}

      {query.isSuccess && items.length > 0 && (
        <div className="agents-content-grid">
          {/* Left: Agent list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {items.map((agent) => (
              <AgentSummaryCard key={agent.id} agent={agent} outcomes={outcomesByAgentId.get(agent.id)} />
            ))}
          </div>

          {/* Right: Recent activity */}
          <section className="recent-activity-panel" aria-label={intl.formatMessage({ id: 'missionControl.section.recentActivity' })}>
            <SectionLabel>{intl.formatMessage({ id: 'missionControl.section.recentActivity' })}</SectionLabel>
            <Card style={{ padding: '0' }}>
              {(activityQuery.isLoading || agentActivityQuery.isLoading) && (
                <div style={{ padding: '20px' }}><LoadingRows count={4} /></div>
              )}
              {(activityQuery.isError || agentActivityQuery.isError) && (
                <ErrorState
                  message={intl.formatMessage({ id: 'common.errorTitle', defaultMessage: 'Something went wrong' })}
                  onRetry={() => { void activityQuery.refetch(); void agentActivityQuery.refetch(); }}
                />
              )}
              {activityQuery.isSuccess && agentActivityQuery.isSuccess &&
               (activityQuery.data?.events.length ?? 0) === 0 &&
               (agentActivityQuery.data?.entries.length ?? 0) === 0 && (
                <EmptyState
                  title={intl.formatMessage({ id: 'missionControl.noActivityYet.title' })}
                  message={intl.formatMessage({ id: 'missionControl.noActivityYet.message' })}
                />
              )}
              {activityQuery.isSuccess && agentActivityQuery.isSuccess &&
               ((activityQuery.data?.events.length ?? 0) > 0 || (agentActivityQuery.data?.entries.length ?? 0) > 0) && (
                <div>
                  {mergedRecentActivity.map((item, index) => (
                    item.kind === 'agent'
                      ? <AgentActivityItem key={`agent-${item.id}`} entry={item.entry} isLast={index === mergedRecentActivity.length - 1} />
                      : <ActivityItem key={`bot-${item.id}`} event={item.event} isLast={index === mergedRecentActivity.length - 1} />
                  ))}
                  <div style={{ padding: '12px 20px', borderTop: '1px solid var(--color-border-subtle)' }}>
                    <Button variant="ghost" size="sm" onClick={() => navigate('/activity')} style={{ width: '100%', justifyContent: 'center' }}>
                      {intl.formatMessage({ id: 'missionControl.viewAllActivity' })}
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          </section>
        </div>
      )}

      {showCreate && (
        <CreateAgentFlow
          skills={selectableSkills}
          skillsLoading={skillsQuery.isLoading}
          skillsError={skillsQuery.error instanceof Error ? skillsQuery.error.message : null}
          onClose={closeCreate}
          onCreated={(id) => {
            setShowCreate(false);
            void qc.invalidateQueries({ queryKey: ['agents'] });
            navigate(`/agents/${id}`);
          }}
        />
      )}

      {/* ── Setup modals ──────────────────────────────────────────── */}
      {showSetup && setupStep === 'form' && (
        <ProviderSetupForm
          defaultCapability="trading"
          onClose={() => { setShowSetup(false); setSetupStep('form'); }}
          onSuccess={(result) => {
            void qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'bindings'] });
            void qc.invalidateQueries({ queryKey: ['connections'] });
            setSetupResult(result);
            setSetupStep('assign');
          }}
        />
      )}

      {showSetup && setupStep === 'assign' && setupResult && (
        <AgentAssignmentStep
          connectionId={setupResult.connection.id}
          connectionLabel={setupResult.connection.label}
          connectionProvider={setupResult.connection.provider}
          onDone={() => {
            setShowSetup(false);
            setSetupStep('form');
            setSetupResult(null);
            setSetupSuccess({ label: setupResult.connection.label, provider: setupResult.connection.provider });
          }}
        />
      )}
    </PageShell>
  );
}

function CreateAgentFlow({
  skills,
  skillsLoading,
  skillsError,
  onClose,
  onCreated,
}: {
  skills: Skill[];
  skillsLoading: boolean;
  skillsError: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const intl = useIntl();
  const qc = useQueryClient();
  const [step, setStep] = useState<CreateStep>('intent');
  const [showSetup, setShowSetup] = useState(false);
  const [intent, setIntent] = useState<IntentState>(() => {
    const styleDefaults = resolveStyleDefaults('balanced');
    return {
    name: '',
    goal: '',
    capabilityMode: 'intelligence',
    hybridMode: undefined,
    technicalPreFilterEnabled: false,
    technicalConfig: defaultTechnicalConfigFormState(),
    skillPreset: 'trading',
    skillIds: resolveSkillPresetSkillIds('trading'),
    executionMode: 'test',
    provider: '',
    lightModel: '',
    heavyModel: '',
    telegramChatId: '',
    connectionIds: [],
    emailDelivery: 'inherit' as const,
    venue: '',
    venueType: '',
    style: 'balanced',
    costPreset: styleDefaults.costPreset,
    dailySpendBudgetUsd: styleDefaults.dailySpendBudgetUsd,
    tickIntervalMins: styleDefaults.tickIntervalMins,
    capital: '',
    dailyLossLimit: '',
    maxDrawdownPct: '',
    maxSlippageBps: '',
    maxOpenPositions: '',
    maxPositionSizePct: '',
    stopLossPct: '',
    stopLossCooldownSecs: '',
    openPositionEscalationToJudgePolicy: styleDefaults.openPositionEscalationToJudgePolicy,
    runtimePolicyOverrides: null,
    strategyPreset: '',
    subscribedSources: ['watch_threshold', 'discovery_delta', 'regime_change'],
    pendingFiles: [],
    };
  });
  const [modelTouched, setModelTouched] = useState(false);
  const [telegramTouched, setTelegramTouched] = useState(false);
  const [reasoningTouched, setReasoningTouched] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [nameIsAutoGenerated, setNameIsAutoGenerated] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const nameCounterRef = useRef(0);
  const dailyLossLimitAutoRef = useRef(false);
  const maxHoldDurationManuallySetRef = useRef(false);
  // Phase 7 policy dropdown onChange will set this to true.
  const policyManuallySetRef = useRef(false);

  function resolveTickIntervalMsFromMinutesInput(tickIntervalMins: string): number | null {
    const parsed = parseTickIntervalMinutesInput(tickIntervalMins);
    return parsed.kind === 'valid' ? parsed.tickIntervalMs : null;
  }

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => authApi.me(),
  });
  const aiSettingsQuery = useQuery({
    queryKey: ['ai', 'settings'],
    queryFn: () => aiApi.settings(),
  });
  const availableModelsQuery = useQuery({
    queryKey: ['ai', 'available-models'],
    queryFn: () => aiApi.availableModels(),
  });
  const tradingConnectionsQuery = useQuery({
    queryKey: ['capabilities', 'trading', 'connections'],
    queryFn: () => capabilitiesApi.tradingConnections(),
  });
  const riskDefaultsQuery = useQuery({
    queryKey: ['agents', 'risk-defaults'],
    queryFn: () => agentsApi.riskDefaults(),
  });
  const providerCatalogQuery = useQuery({
    queryKey: ['providerCatalog'],
    queryFn: () => providerCatalogApi.get(),
    staleTime: 60 * 60 * 1000, // 1 hour — providers rarely change
  });

  const venueTypeMap = providerCatalogQuery.data?.providers
    ? buildVenueTypeMap(providerCatalogQuery.data.providers)
    : VENUE_TYPE_MAP;

  useEffect(() => {
    if (modelTouched) {
      return;
    }
    const savedModels = aiSettingsQuery.data?.aiModelConfig;
    if (savedModels) {
      setIntent((state) => ({
        ...state,
        provider: savedModels.provider ?? '',
        lightModel: savedModels.lightModel ?? '',
        heavyModel: savedModels.heavyModel ?? '',
      }));
    }
  }, [aiSettingsQuery.data?.aiModelConfig, modelTouched]);

  useEffect(() => {
    if (modelTouched) {
      return;
    }
    if (intent.provider) {
      return;
    }
    if (!aiSettingsQuery.isSuccess || aiSettingsQuery.data?.aiModelConfig) {
      return;
    }
    const defaultSelection = resolveDefaultModelSelection(availableModelsQuery.data?.providers ?? [], availableModelsQuery.data?.defaults);
    if (!defaultSelection) {
      return;
    }
    setIntent((state) => ({ ...state, ...defaultSelection }));
  }, [availableModelsQuery.data?.providers, aiSettingsQuery.isSuccess, aiSettingsQuery.data?.aiModelConfig, intent.provider, modelTouched]);

  // Auto-fill reasoning levels from saved AI settings when first loaded
  useEffect(() => {
    if (reasoningTouched) return;
    const savedModels = aiSettingsQuery.data?.aiModelConfig;
    if (!savedModels) return;
    setIntent((state) => {
      // Only auto-fill if the user hasn't already set reasoning overrides
      const existingOverrides = state.runtimePolicyOverrides ?? {};
      if (existingOverrides.scoutReasoning != null && existingOverrides.judgeReasoning != null) return state;
      return {
        ...state,
        runtimePolicyOverrides: {
          ...state.runtimePolicyOverrides,
          ...(existingOverrides.scoutReasoning == null && savedModels.scoutReasoning ? { scoutReasoning: savedModels.scoutReasoning } : {}),
          ...(existingOverrides.judgeReasoning == null && savedModels.judgeReasoning ? { judgeReasoning: savedModels.judgeReasoning } : {}),
        },
      };
    });
  }, [aiSettingsQuery.data?.aiModelConfig, reasoningTouched]);

  useEffect(() => {
    if (telegramTouched) {
      return;
    }
    const chatId = meQuery.data?.telegramChatId;
    if (chatId !== undefined) {
      setIntent((state) => ({ ...state, telegramChatId: chatId ?? '' }));
    }
  }, [meQuery.data?.telegramChatId, telegramTouched]);

  // Sync capabilityMode from technicalPreFilterEnabled toggle + trading skill presence
  useEffect(() => {
    setIntent((state) => {
      const resolvedSkills = skills.filter((s) => state.skillIds.includes(s.id));
      const syntheticTradingSkill = state.skillPreset === 'trading'
        ? [{ capabilityFamilies: ['trading'] }]
        : [];
      const effectiveSkills = resolvedSkills.length > 0 ? resolvedSkills : syntheticTradingSkill;
      const hasTradingSkill = hasCapabilityFamily(effectiveSkills, 'trading');
      const derived: CapabilityMode = state.technicalPreFilterEnabled && hasTradingSkill ? 'hybrid' : 'intelligence';
      if (derived !== state.capabilityMode) {
        return { ...state, capabilityMode: derived };
      }
      return state;
    });
  }, [intent.skillIds, intent.technicalPreFilterEnabled, skills]);

  // Pre-fill goal from promptTemplate when skills change and goal is empty
  useEffect(() => {
    if (intent.goal.trim()) return;
    const template = resolvePromptTemplate(intent.skillIds, skills);
    if (template) {
      setIntent((state) => ({ ...state, goal: template }));
    }
  }, [intent.skillIds, skills]);

  // Auto-generate name from style when nameIsAutoGenerated is true
  useEffect(() => {
    if (nameIsAutoGenerated) {
      const newName = generateAgentName(intent.style, nameCounterRef.current);
      setIntent((state) => ({ ...state, name: newName }));
      nameCounterRef.current += 1;
    }
  }, [intent.style, nameIsAutoGenerated]);

  // Auto-fill dailyLossLimit to 5% of capital when loss limit is empty or was auto-set
  useEffect(() => {
    if (dailyLossLimitAutoRef.current || !intent.dailyLossLimit.trim()) {
      const capitalNum = parseFloat(intent.capital);
      if (!isNaN(capitalNum) && capitalNum > 0) {
        const ratio = riskDefaultsQuery.data?.dailyLossLimitDefaultRatio ?? 0.05;
        const lossLimit = (capitalNum * ratio).toFixed(2);
        if (lossLimit !== intent.dailyLossLimit) {
          setIntent((state) => ({ ...state, dailyLossLimit: lossLimit }));
          dailyLossLimitAutoRef.current = true;
        }
      }
    }
  }, [intent.capital, riskDefaultsQuery.data?.dailyLossLimitDefaultRatio]);

  const selectedSkills = skills.filter((skill) => intent.skillIds.includes(skill.id));
  const hasBotManagementSkill = intent.skillIds.includes('bot-management');
  const tickIntervalValidationMessageId = getTickIntervalValidationMessageId(intent.tickIntervalMins);
  const tickIntervalError = tickIntervalValidationMessageId
    ? intl.formatMessage({ id: tickIntervalValidationMessageId })
    : null;
  const savedModelSettings = aiSettingsQuery.data?.aiModelConfig ?? null;
  const modelPayload = resolveCreateAgentModelPayload(
    { provider: intent.provider, lightModel: intent.lightModel, heavyModel: intent.heavyModel },
    savedModelSettings,
  );
  const showIntelligence = intent.capabilityMode === 'intelligence' || intent.capabilityMode === 'hybrid';
  const requiresTradingSetup = intent.skillPreset === 'trading' || hasCapabilityFamily(selectedSkills, 'trading');
  const availableConnections = (tradingConnectionsQuery.data?.connections ?? []).filter(
    (connection) => connection.status === 'active',
  );
  // Connections matching the currently selected venue (used for auto-select logic)
  const connectionsForVenue = intent.venue
    ? availableConnections.filter((c) => c.provider === intent.venue)
    : [];
  // In test mode show all venues (the user may optionally pick one to enable
  // venue-backed shadow execution, but none is required). In live mode only
  // show venues that have at least one active connection.
  const venuesForMode = intent.executionMode === 'test'
    ? Object.keys(venueTypeMap).sort()
    : Object.keys(venueTypeMap).filter((v) => availableConnections.some((c) => c.provider === v)).sort();

  // When connections finish loading and a venue is already set with no connection chosen,
  // auto-select if exactly one connection matches the venue.
  useEffect(() => {
    if (!tradingConnectionsQuery.isSuccess) return;
    setIntent((state) => {
      if (!state.venue || state.connectionIds.length > 0) return state;
      const matching = (tradingConnectionsQuery.data?.connections ?? [])
        .filter((c) => c.status === 'active' && c.provider === state.venue);
      if (matching.length === 1) {
        return { ...state, connectionIds: [matching[0]!.connectionId] };
      }
      return state;
    });
  }, [tradingConnectionsQuery.isSuccess, tradingConnectionsQuery.data]);

  const mutation = useMutation({
    mutationFn: async () => {
      // When a strategy preset is selected, don't send raw technical config
      const hasStrategyPreset = intent.strategyPreset && intent.strategyPreset !== 'custom';
      const technicalPayload = (!hasStrategyPreset && intent.technicalPreFilterEnabled && requiresTradingSetup)
        ? technicalFormStateToPayload(intent.technicalConfig, intent.venue, intent.venueType as 'orderbook' | 'swap')
        : null;
      const agent = await agentsApi.create(buildCreateAgentPayload({
        name: intent.name,
        goal: intent.goal,
        capabilityMode: intent.capabilityMode,
        hybridMode: intent.hybridMode ?? 'scanner_gated',
        technicalPreFilterEnabled: intent.technicalPreFilterEnabled,
        technical: technicalPayload,
        skillIds: intent.skillIds,
        hasBotManagementSkill,
        requiresTradingSetup,
        executionMode: intent.executionMode,
        executionVenue: intent.venue,
        connectionIds: intent.connectionIds,
        modelPayload,
        costPreset: intent.costPreset,
        dailySpendBudgetUsd: intent.dailySpendBudgetUsd,
        telegramChatId: intent.telegramChatId,
        emailDelivery: intent.emailDelivery,
        tickIntervalMins: intent.tickIntervalMins,
        capital: intent.capital,
        dailyLossLimit: intent.dailyLossLimit,
        maxDrawdownPct: intent.maxDrawdownPct,
        maxSlippageBps: intent.maxSlippageBps,
        maxOpenPositions: intent.maxOpenPositions,
        maxPositionSizePct: intent.maxPositionSizePct,
        stopLossPct: intent.stopLossPct,
        stopLossCooldownSecs: intent.stopLossCooldownSecs,
        style: intent.style,
        strategyPreset: intent.strategyPreset || undefined,
        openPositionEscalationToJudgePolicy: intent.openPositionEscalationToJudgePolicy,
        runtimePolicyOverrides: intent.runtimePolicyOverrides ?? undefined,
        subscribedSources: intent.subscribedSources,
      }));

      // Upload any documents selected during creation
      if (intent.pendingFiles && intent.pendingFiles.length > 0) {
        for (const file of intent.pendingFiles) {
          try {
            await agentsApi.uploadDocument(agent.id, file);
          } catch (err) {
            console.warn('Document upload failed:', file.name, err);
          }
        }
      }

      return agent;
    },
    onSuccess: (agent) => onCreated(agent.id),
    onError: () => {
      setFormErrors((prev) => ({ ...prev, _form: localizeApiError(intl, mutation.error, 'common.errorTitle') }));
    },
  });

  function clearFieldError(field: string) {
    setFormErrors((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  const validationConstraints: ValidationConstraints = {
    maxOpenPositions: riskDefaultsQuery.data?.maxOpenPositions ?? 10,
    maxPositionSizePct: riskDefaultsQuery.data?.maxPositionSizePct ?? 100,
    stopLossMaxUnrealizedLossPct: riskDefaultsQuery.data?.stopLossPct ?? 100,
  };

  function validateFieldOnBlur(fieldName: string) {
    const result = validateCreateAgentForm({
      name: intent.name,
      goal: intent.goal,
      capabilityMode: intent.capabilityMode,
      capital: intent.capital,
      tickIntervalMins: intent.tickIntervalMins,
      maxOpenPositions: intent.maxOpenPositions,
      maxPositionSizePct: intent.maxPositionSizePct,
      stopLossPct: intent.stopLossPct,
      venue: intent.venue,
      venueType: intent.venueType,
      executionMode: intent.executionMode,
      requiresTradingSetup,
      hasConnection: intent.connectionIds.length > 0,
      style: intent.style,
      runtimePolicyOverrides: intent.runtimePolicyOverrides,
    }, validationConstraints);

    setFormErrors((prev) => {
      const fieldError = result.errors[fieldName];
      const hasExisting = fieldName in prev;
      if (!fieldError && !hasExisting) return prev;
      const next = { ...prev };
      if (fieldError) {
        next[fieldName] = fieldError;
      } else {
        delete next[fieldName];
      }
      return next;
    });

  }

  const maxHoldViolation = (() => {
    if (!intent.tickIntervalMins.trim() || tickIntervalError != null) return false;
    const tickNum = Number(intent.tickIntervalMins);
    if (!Number.isFinite(tickNum) || tickNum < 1 || !Number.isInteger(tickNum)) return false;
    const tickMs = tickNum * 60_000;
    const maxHoldMs = intent.runtimePolicyOverrides?.maxHoldDurationMs;
    return maxHoldMs != null && maxHoldMs !== 0 && maxHoldMs < tickMs;
  })();

  const createDisabled = mutation.isPending
    || !intent.name.trim()
    || (showIntelligence && !intent.goal.trim())
    || (intent.executionMode === 'live' && (!intent.venue || !intent.venueType))
    || (requiresTradingSetup && intent.venue.trim() !== '' && intent.connectionIds.length === 0)
    || tickIntervalError != null
    || maxHoldViolation;

  if (showSetup) {
    return (
      <ProviderSetupForm
        defaultCapability="trading"
        onClose={() => setShowSetup(false)}
        onSuccess={(result) => {
          setShowSetup(false);
          void qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'connections'] });
          const connectionIds = resolveCreateAgentConnectionIds(result.connection ?? null);
          if (connectionIds.length > 0) {
            setIntent((state) => ({ ...state, connectionIds: [...new Set([...state.connectionIds, ...connectionIds])] }));
          }
        }}
      />
    );
  }

  if (step === 'intent') {
    return (
      <Modal title={intl.formatMessage({ id: 'agents.create.title' })} onClose={onClose} closeOnBackdropClick={false}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* 1. Skill Preset — first, sets context for everything else */}
          <div style={{ marginBottom: '20px' }}>
            <FieldLabel>{intl.formatMessage({ id: 'agents.create.skillPreset' })}</FieldLabel>
            <select
              value={intent.skillPreset}
              onChange={(e) => {
                const skillPreset = e.target.value as SkillPresetId;
                setIntent((state) => {
                  const next = {
                    ...state,
                    skillPreset,
                    skillIds: resolveSkillPresetSkillIds(skillPreset, state.skillIds),
                  };
                  // Clear trading sessions when switching away from trading
                  // so the hour grid (0-23) becomes editable again.
                  if (skillPreset !== 'trading' && next.runtimePolicyOverrides?.tradingSessions) {
                    const { tradingSessions: _, ...rest } = next.runtimePolicyOverrides;
                    next.runtimePolicyOverrides = Object.keys(rest).length > 0 ? rest : null;
                  }
                  return next;
                });
              }}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="trading">{intl.formatMessage({ id: 'agents.create.skillPreset.trading' })}</option>
              <option value="personal-assistant">{intl.formatMessage({ id: 'agents.create.skillPreset.personalAssistant' })}</option>
              <option value="custom">{intl.formatMessage({ id: 'agents.create.skillPreset.custom' })}</option>
            </select>
            {intent.skillPreset !== 'custom' && selectedSkills.length > 0 && (
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.4' }}>
                {selectedSkills.map((s) => s.name).join(', ')}
              </div>
            )}
          </div>

          {/* Custom skill picker — shown inline when custom preset is selected */}
          {intent.skillPreset === 'custom' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px' }}>
              <div style={{ fontSize: '14px', fontWeight: '600' }}>
                {intl.formatMessage({ id: 'agents.create.skills' })}
              </div>
              <SkillPicker
                skills={skills}
                selectedSkillIds={intent.skillIds}
                onChange={(skillIds) => setIntent((state) => ({ ...state, skillPreset: 'custom', skillIds }))}
                loading={skillsLoading}
                errorMessage={skillsError}
              />
            </div>
          )}

          {/* 2. Prompt + files + style — unified block */}
          <div style={{ marginBottom: '8px' }}>
          <PromptInputBlock
            dataField="goal"
            goal={intent.goal}
            onGoalChange={(goal) => {
              clearFieldError('goal');
              setIntent((state) => ({ ...state, goal }));
            }}
            onGoalBlur={() => validateFieldOnBlur('goal')}
            goalPlaceholder={resolveGoalPlaceholder(intent.skillIds, skills) ?? intl.formatMessage({ id: 'agents.create.goalPlaceholder' })}
            goalLabel={intl.formatMessage({ id: intent.capabilityMode === 'hybrid' ? 'agents.create.goalBoth' : 'agents.create.goal' })}
            goalError={formErrors.goal}
            required
            pendingFiles={intent.pendingFiles}
            onPendingFilesChange={(pendingFiles) => setIntent((state) => ({ ...state, pendingFiles }))}
            style={intent.style}
            onStyleChange={(style) => {
              const defaults = resolveStyleDefaults(style);
              setIntent((state) => {
                const tradingSources = ['watch_threshold', 'discovery_delta', 'regime_change'];
                const styleSources = state.technicalPreFilterEnabled
                  ? [...tradingSources, 'scanner']
                  : tradingSources;
                const next: IntentState = {
                  ...state,
                  style,
                  costPreset: defaults.costPreset,
                  tickIntervalMins: defaults.tickIntervalMins,
                  dailySpendBudgetUsd: defaults.dailySpendBudgetUsd,
                  subscribedSources: styleSources,
                  ...(policyManuallySetRef.current ? {} : { openPositionEscalationToJudgePolicy: defaults.openPositionEscalationToJudgePolicy }),
                };
                const newTickMs = resolveTickIntervalMsFromMinutesInput(next.tickIntervalMins);
                const effectiveMaxHold = next.runtimePolicyOverrides?.maxHoldDurationMs
                  ?? resolveStyleDefaults(style).maxHoldDurationMs;
                const constraintViolated = newTickMs != null && effectiveMaxHold !== 0 && effectiveMaxHold < newTickMs;
                return maxHoldDurationManuallySetRef.current && !constraintViolated
                  ? next
                  : {
                      ...next,
                      runtimePolicyOverrides: applyAutoMaxHoldOverride(
                        style,
                        next.runtimePolicyOverrides,
                        newTickMs,
                      ),
                    };
              });
            }}
          />

          {/* Style summary */}
          <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '0' }}>
            {formatStyleSummary(intent.style, intl.formatMessage({ id: STYLE_LABEL_KEYS[intent.style] }), resolveModelPricing(
              availableModelsQuery.data?.providers ?? [],
              intent.provider,
              intent.lightModel,
              intent.heavyModel,
            ), resolveTickIntervalMsFromMinutesInput(intent.tickIntervalMins))}
          </div>

          </div>

          {/* 3. Agent Form Body */}
          <AgentFormBody
            value={intentToFormState(intent)}
            onChange={(patch) => {
              if ('name' in patch) setNameIsAutoGenerated(false);
              setIntent((state) => {
                const next: IntentState = { ...state, ...patch };
                if (patch.tickIntervalMins !== undefined) {
                  const newTickMs = resolveTickIntervalMsFromMinutesInput(next.tickIntervalMins);
                  const effectiveMaxHold = next.runtimePolicyOverrides?.maxHoldDurationMs
                    ?? resolveStyleDefaults(next.style).maxHoldDurationMs;
                  const constraintViolated = newTickMs != null && effectiveMaxHold !== 0 && effectiveMaxHold < newTickMs;
                  if (!maxHoldDurationManuallySetRef.current || constraintViolated) {
                    next.runtimePolicyOverrides = applyAutoMaxHoldOverride(
                      next.style,
                      next.runtimePolicyOverrides,
                      newTickMs,
                    );
                  }
                }
                return next;
              });
            }}
            showIntelligence={showIntelligence}
            showTradingControls={requiresTradingSetup}
            requiresTradingSetup={requiresTradingSetup}
            isAdmin={meQuery.data?.isAdmin ?? false}
            agentStyle={intent.style}
            accountEmail={meQuery.data?.email ?? null}
            selectableSkills={skills}
            skillsLoading={skillsLoading}
            skillsError={skillsError}
            formErrors={formErrors}
            onClearFieldError={clearFieldError}
            onBlurField={validateFieldOnBlur}
            validationConstraints={validationConstraints}
            tickIntervalError={tickIntervalError}
            subscribedSources={intent.subscribedSources}
            onSubscribedSourcesChange={(sources) => setIntent((state) => ({ ...state, subscribedSources: sources }))}
            computeBudgetSlot={
              <RuntimePolicySection
                style={intent.style}
                overrides={intent.runtimePolicyOverrides}
                onChange={(overrides) => {
                  const hasManualMaxHoldOverride = Object.prototype.hasOwnProperty.call(overrides ?? {}, 'maxHoldDurationMs');
                  maxHoldDurationManuallySetRef.current = hasManualMaxHoldOverride;
                  if (hasManualMaxHoldOverride) {
                    clearFieldError('tickIntervalMins');
                  }
                  setIntent((state) => ({
                    ...state,
                    runtimePolicyOverrides: hasManualMaxHoldOverride
                      ? overrides
                      : applyAutoMaxHoldOverride(
                          state.style,
                          overrides,
                          resolveTickIntervalMsFromMinutesInput(state.tickIntervalMins),
                        ),
                  }));
                }}
                alwaysExpanded
                showTradingSessionPresets={requiresTradingSetup}
              />
            }
            modelSlot={
              showIntelligence ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ fontSize: '14px', fontWeight: '600' }}>
                    {intl.formatMessage({ id: 'agents.create.models.title' })}
                  </div>
                  <ModelSelectionFields
                    value={{ provider: intent.provider, lightModel: intent.lightModel, heavyModel: intent.heavyModel }}
                    providers={availableModelsQuery.data?.providers ?? []}
                    loading={availableModelsQuery.isLoading}
                    loadingLabel={intl.formatMessage({ id: 'aiModels.loading' })}
                    emptyLabel={intl.formatMessage({ id: 'aiModels.empty' })}
                    providerLabel={intl.formatMessage({ id: 'aiModels.provider.label' })}
                    providerPlaceholder={intl.formatMessage({ id: 'aiModels.provider.placeholder' })}
                    economyLabel={intl.formatMessage({ id: 'aiModels.economy.label' })}
                    economyHelp={intl.formatMessage({ id: 'aiModels.economy.help' })}
                    premiumLabel={intl.formatMessage({ id: 'aiModels.premium.label' })}
                    premiumHelp={intl.formatMessage({ id: 'aiModels.premium.help' })}
                    onChange={(value) => {
                      setModelTouched(true);
                      setIntent((state) => ({ ...state, ...value }));
                    }}
                  />

                  {/* Reasoning level dropdowns */}
                  {(() => {
                    const savedReasoning = aiSettingsQuery.data?.aiModelConfig;
                    const overrides = intent.runtimePolicyOverrides ?? {};
                    const scoutVal = (overrides.scoutReasoning as string | null) ?? null;
                    const judgeVal = (overrides.judgeReasoning as string | null) ?? null;
                    const inheritedScout = savedReasoning?.scoutReasoning ?? 'none';
                    const inheritedJudge = savedReasoning?.judgeReasoning ?? 'medium';

                    return (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                        <div>
                          <FieldLabel>{intl.formatMessage({ id: 'agents.edit.models.reasoning.scoutLabel' })}</FieldLabel>
                          <select
                            aria-label={intl.formatMessage({ id: 'agents.edit.models.reasoning.scoutLabel' })}
                            value={scoutVal ?? ''}
                            onChange={(e) => {
                              setReasoningTouched(true);
                              const val = e.target.value;
                              setIntent((state) => {
                                const next = { ...(state.runtimePolicyOverrides ?? {}) };
                                if (val === '' || val === null) {
                                  delete next.scoutReasoning;
                                } else {
                                  next.scoutReasoning = val;
                                }
                                return {
                                  ...state,
                                  runtimePolicyOverrides: Object.keys(next).length > 0 ? next as RuntimePolicyOverrides : null,
                                };
                              });
                            }}
                            style={{ ...inputStyle, cursor: 'pointer', width: '100%' }}
                          >
                            <option value="">
                              {intl.formatMessage({ id: 'agents.edit.models.reasoning.inherit' }, { value: inheritedScout })}
                            </option>
                            {getAllowedReasoningLevels(RUNTIME_POLICY_CEILINGS.scoutReasoningMax).map((level) => (
                              <option key={level} value={level}>{intl.formatMessage({ id: `aiModels.reasoning.${level}` })}</option>
                            ))}
                          </select>
                          <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                            {intl.formatMessage({ id: 'agents.edit.models.reasoning.scoutHelp' })}
                          </div>
                        </div>
                        <div>
                          <FieldLabel>{intl.formatMessage({ id: 'agents.edit.models.reasoning.judgeLabel' })}</FieldLabel>
                          <select
                            aria-label={intl.formatMessage({ id: 'agents.edit.models.reasoning.judgeLabel' })}
                            value={judgeVal ?? ''}
                            onChange={(e) => {
                              setReasoningTouched(true);
                              const val = e.target.value;
                              setIntent((state) => {
                                const next = { ...(state.runtimePolicyOverrides ?? {}) };
                                if (val === '' || val === null) {
                                  delete next.judgeReasoning;
                                } else {
                                  next.judgeReasoning = val;
                                }
                                return {
                                  ...state,
                                  runtimePolicyOverrides: Object.keys(next).length > 0 ? next as RuntimePolicyOverrides : null,
                                };
                              });
                            }}
                            style={{ ...inputStyle, cursor: 'pointer', width: '100%' }}
                          >
                            <option value="">
                              {intl.formatMessage({ id: 'agents.edit.models.reasoning.inherit' }, { value: inheritedJudge })}
                            </option>
                            <option value="none">{intl.formatMessage({ id: 'aiModels.reasoning.none' })}</option>
                            <option value="low">{intl.formatMessage({ id: 'aiModels.reasoning.low' })}</option>
                            <option value="medium">{intl.formatMessage({ id: 'aiModels.reasoning.medium' })}</option>
                            <option value="high">{intl.formatMessage({ id: 'aiModels.reasoning.high' })}</option>
                          </select>
                          <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                            {intl.formatMessage({ id: 'agents.edit.models.reasoning.judgeHelp' })}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              ) : null
            }
            connectionSlot={
              <div data-field="connectionIds" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <FieldLabel>{intl.formatMessage({ id: 'agents.create.whereToTrade' })}</FieldLabel>
                {tradingConnectionsQuery.isLoading ? (
                  <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.create.loadingConnections' })}</div>
                ) : availableConnections.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                      {intl.formatMessage({ id: 'agents.create.noConnections' })}
                    </div>
                    <div>
                      <Button variant="secondary" size="sm" onClick={() => setShowSetup(true)}>
                        {intl.formatMessage({ id: 'agents.create.addConnection' })}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <select
                      value=""
                      onChange={(e) => {
                        const id = e.target.value;
                        if (!id) return;
                        const conn = availableConnections.find((c) => c.connectionId === id);
                        const derivedVenue = conn?.provider ?? '';
                        const derivedVenueType = derivedVenue ? (venueTypeMap[derivedVenue] ?? '') : '';
                        clearFieldError('venue');
                        setIntent((state) => {
                          // Keep only connections of the same provider + the new one
                          const sameProvider = derivedVenue
                            ? state.connectionIds.filter((cid) => {
                                const existing = availableConnections.find((c) => c.connectionId === cid);
                                return existing?.provider === derivedVenue;
                              })
                            : state.connectionIds;
                          const newIds = sameProvider.includes(id) ? sameProvider : [...sameProvider, id];
                          return {
                            ...state,
                            connectionIds: newIds,
                            ...(derivedVenue ? { venue: derivedVenue, venueType: derivedVenueType } : {}),
                          };
                        });
                      }}
                      style={{ ...inputStyle, cursor: 'pointer' }}
                    >
                      <option value="">{intl.formatMessage({ id: 'agents.create.chooseConnection' })}</option>
                      {availableConnections.map((connection) => (
                        <option key={connection.connectionId} value={connection.connectionId}>
                          {connection.label} ({connection.provider})
                        </option>
                      ))}
                    </select>
                    {intent.connectionIds.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {intent.connectionIds.map((id) => {
                          const conn = availableConnections.find((c) => c.connectionId === id);
                          return (
                            <span
                              key={id}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                padding: '2px 8px',
                                borderRadius: '12px',
                                background: 'var(--color-surface-2)',
                                fontSize: '12px',
                                cursor: 'default',
                              }}
                            >
                              {conn?.label ?? id}
                              <button
                                type="button"
                                onClick={() => setIntent((state) => {
                                  const newIds = state.connectionIds.filter((cid) => cid !== id);
                                  // Clear venue when the last connection is removed (trading agents)
                                  return {
                                    ...state,
                                    connectionIds: newIds,
                                    ...(newIds.length === 0 && requiresTradingSetup
                                      ? { venue: '', venueType: '' }
                                      : {}),
                                  };
                                })}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  padding: '0 2px',
                                  fontSize: '14px',
                                  lineHeight: '1',
                                  color: 'var(--color-text-muted)',
                                }}
                              >
                                ×
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
                {availableConnections.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowSetup(true)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '4px 0',
                      fontSize: '12px',
                      color: 'var(--color-brand)',
                      textAlign: 'left',
                    }}
                  >
                    {intl.formatMessage({ id: 'agents.create.addConnection' })}
                  </button>
                )}

                {formErrors.connectionIds && (
                  <div style={{ color: 'var(--color-danger)', fontSize: '12px' }}>{formErrors.connectionIds}</div>
                )}
              </div>
            }
            tradingSetupSlot={
              requiresTradingSetup ? (
                <>
                  <div data-field="executionMode">
                    <FieldLabel>{intl.formatMessage({ id: 'agents.executionMode.label' })}</FieldLabel>
                    <select
                      value={intent.executionMode}
                      onChange={(e) => {
                        const newMode = e.target.value as IntentState['executionMode'];
                        clearFieldError('executionMode');
                        setIntent((state) => {
                          // In live mode, venue must have an active connection;
                          // in test mode, keep any venue selection.
                          const venueStillValid = newMode === 'test' ||
                            !state.venue ||
                            availableConnections.some((c) => c.provider === state.venue);
                          return {
                            ...state,
                            executionMode: newMode,
                            ...(venueStillValid ? {} : { venue: '', venueType: '', connectionIds: [] }),
                          };
                        });
                      }}
                      style={{ ...inputStyle, cursor: 'pointer' }}
                    >
                      <option value="test">{intl.formatMessage({ id: 'agents.create.executionMode.test' })}</option>
                      <option value="live">{intl.formatMessage({ id: 'agents.create.executionMode.live' })}</option>
                    </select>
                    {formErrors.executionMode && (
                      <div style={{ color: 'var(--color-danger)', fontSize: '12px', marginTop: '4px' }}>
                        {formErrors.executionMode}
                      </div>
                    )}
                  </div>

                  {/* Venue — user picks market first; connection list filters to match */}
                  <div data-field="venue">
                    <FieldLabel>{intl.formatMessage({ id: 'agents.technical.filters.venue' })}</FieldLabel>
                    <select
                      value={intent.venue}
                      onChange={(e) => {
                        const v = e.target.value;
                        const vt = venueTypeMap[v] ?? '';
                        clearFieldError('venue');
                        clearFieldError('executionMode');
                        setIntent((state) => {
                          const matching = availableConnections.filter((c) => c.provider === v);
                          // Auto-select if exactly one match; keep matched existing selections
                          // if multiple; clear only when no connections match the new venue.
                          const newConnectionIds = matching.length === 1
                            ? [matching[0]!.connectionId]
                            : matching.length === 0
                              ? []
                              : state.connectionIds.filter((id) => matching.some((m) => m.connectionId === id));
                          return { ...state, venue: v, venueType: vt, connectionIds: newConnectionIds };
                        });
                      }}
                      style={{ ...inputStyle, cursor: 'pointer' }}
                    >
                      <option value="">{intl.formatMessage({ id: 'agents.technical.filters.venue.placeholder' })}</option>
                      {venuesForMode.map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                    {formErrors.venue && <div style={{ color: 'var(--color-danger)', fontSize: '12px', marginTop: '4px' }}>{formErrors.venue}</div>}
                  </div>

                  <div>
                    <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>
                      {intl.formatMessage({ id: 'agents.create.tradingControls.title' })}
                    </div>
                    <TradingGuardrailsFields
                      value={{
                        dailyLossLimit: intent.dailyLossLimit,
                        maxDrawdownPct: intent.maxDrawdownPct,
                        maxSlippageBps: intent.maxSlippageBps,
                        maxOpenPositions: intent.maxOpenPositions,
                        maxPositionSizePct: intent.maxPositionSizePct,
                        stopLossPct: intent.stopLossPct,
                        stopLossCooldownSecs: intent.stopLossCooldownSecs,
                        openPositionEscalationToJudgePolicy: intent.openPositionEscalationToJudgePolicy,
                      }}
                      defaults={riskDefaultsQuery.data ?? null}
                      fieldErrors={formErrors}
                      onClearFieldError={clearFieldError}
                      onBlurField={validateFieldOnBlur}
                      onChange={(patch) => {
                        if ('dailyLossLimit' in patch) {
                          dailyLossLimitAutoRef.current = false;
                        }
                        if ('openPositionEscalationToJudgePolicy' in patch) {
                          policyManuallySetRef.current = true;
                        }
                        setIntent((state) => ({ ...state, ...patch }));
                      }}
                    />
                  </div>
                </>
              ) : null
            }
            nameAutoHint={
              nameIsAutoGenerated ? (
                <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                  {intl.formatMessage({ id: 'agents.create.name.autoGeneratedHint' })}
                </div>
              ) : null
            }
            advancedActionsSlot={
              <>
                <Button variant="ghost" onClick={onClose} type="button">{intl.formatMessage({ id: 'common.cancel' })}</Button>
                <Button
                  variant="primary"
                  type="button"
                  onClick={() => {
                    const result = validateCreateAgentForm({
                      name: intent.name,
                      goal: intent.goal,
                      capabilityMode: intent.capabilityMode,
                      capital: intent.capital,
                      tickIntervalMins: intent.tickIntervalMins,
                      maxOpenPositions: intent.maxOpenPositions,
                      maxPositionSizePct: intent.maxPositionSizePct,
                      stopLossPct: intent.stopLossPct,
                      venue: intent.venue,
                      venueType: intent.venueType,
                      executionMode: intent.executionMode,
                      requiresTradingSetup,
                      hasConnection: intent.connectionIds.length > 0,
                    }, validationConstraints);

                    if (!result.valid) {
                      setFormErrors(result.errors);
                      const firstErrorField = Object.keys(result.errors)[0];
                      if (firstErrorField) {
                        const el = document.querySelector(`[data-field="${firstErrorField}"]`);
                        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }
                      return;
                    }

                    setFormErrors({});
                    setStep('review');
                  }}
                >
                  {intl.formatMessage({ id: 'agents.create.review' })}
                </Button>
              </>
            }
            onAdvancedToggle={setAdvancedOpen}
          />

          {/* Cancel + Review buttons */}
          {advancedOpen && (
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={onClose} type="button">{intl.formatMessage({ id: 'common.cancel' })}</Button>
            <Button
              variant="primary"
              type="button"
              onClick={() => {
                const result = validateCreateAgentForm({
                  name: intent.name,
                  goal: intent.goal,
                  capabilityMode: intent.capabilityMode,
                  capital: intent.capital,
                  tickIntervalMins: intent.tickIntervalMins,
                  maxOpenPositions: intent.maxOpenPositions,
                  maxPositionSizePct: intent.maxPositionSizePct,
                  stopLossPct: intent.stopLossPct,
                  venue: intent.venue,
                  venueType: intent.venueType,
                  executionMode: intent.executionMode,
                  requiresTradingSetup,
                  hasConnection: intent.connectionIds.length > 0,
                }, validationConstraints);

                if (!result.valid) {
                  setFormErrors(result.errors);
                  const firstErrorField = Object.keys(result.errors)[0];
                  if (firstErrorField) {
                    const el = document.querySelector(`[data-field="${firstErrorField}"]`);
                    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }
                  return;
                }

                setFormErrors({});
                setStep('review');
              }}
            >
              {intl.formatMessage({ id: 'agents.create.review' })}
            </Button>
          </div>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={intl.formatMessage({ id: 'agents.review.title' })} onClose={onClose} closeOnBackdropClick={false}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <tbody>
            <ReviewRow label={intl.formatMessage({ id: 'agents.create.name' })} value={intent.name.trim()} />
            <ReviewRow
              label={intl.formatMessage({ id: 'agents.review.style' })}
              value={intl.formatMessage({ id: `agents.style.${intent.style}.label` })}
            />
            <ReviewRow
              label={intl.formatMessage({ id: 'agents.review.capabilityMode' })}
              value={intl.formatMessage({ id: intent.capabilityMode === 'hybrid'
                ? (intent.hybridMode === 'scanner_gated'
                  ? 'agents.capability.hybrid.scannerGated.label'
                  : 'agents.capability.hybrid.mixed.label')
                : `agents.capability.${intent.capabilityMode}.label` })}
            />
          </tbody>
        </table>

        {showIntelligence && (
          <div style={{ padding: '12px', background: 'var(--color-bg-subtle, rgba(0,0,0,0.04))', borderRadius: '6px', fontSize: '14px', lineHeight: '1.5' }}>
            {intent.goal}
          </div>
        )}

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <tbody>
            {requiresTradingSetup && <ReviewRow label={intl.formatMessage({ id: 'agents.executionMode.label' })} value={formatExecutionMode(intent.executionMode, intl)} />}
            {showIntelligence && (
              <ReviewRow
                label={intl.formatMessage({ id: 'agents.review.models' })}
                value={modelPayload.inherits
                  ? intl.formatMessage({ id: 'agents.review.models.inherit' })
                  : intent.provider
                  ? intl.formatMessage(
                    { id: 'agents.review.models.value' },
                    { provider: intent.provider, lightModel: intent.lightModel || intl.formatMessage({ id: 'common.default' }), heavyModel: intent.heavyModel || intl.formatMessage({ id: 'common.default' }) },
                  )
                  : intl.formatMessage({ id: 'agents.review.models.inherit' })}
              />
            )}
            {showIntelligence && (() => {
              const overrides = intent.runtimePolicyOverrides ?? {};
              const scoutReasoning = (overrides.scoutReasoning as string | undefined) ?? (aiSettingsQuery.data?.aiModelConfig?.scoutReasoning ?? 'none');
              const judgeReasoning = (overrides.judgeReasoning as string | undefined) ?? (aiSettingsQuery.data?.aiModelConfig?.judgeReasoning ?? 'medium');
              const scoutLabel = intl.formatMessage({ id: `aiModels.reasoning.${scoutReasoning}` });
              const judgeLabel = intl.formatMessage({ id: `aiModels.reasoning.${judgeReasoning}` });
              const isOverridden = (overrides.scoutReasoning != null || overrides.judgeReasoning != null);
              return (
                <ReviewRow
                  label={intl.formatMessage({ id: 'agents.edit.models.reasoning.scoutLabel' })}
                  value={isOverridden ? `${scoutLabel} / ${judgeLabel}` : intl.formatMessage({ id: 'agents.review.models.inherit' })}
                />
              );
            })()}
            {showIntelligence && <ReviewRow label={intl.formatMessage({ id: 'agents.create.skills' })} value={formatSkillSelection(selectedSkills, intl)} />}
            {requiresTradingSetup && intent.venue && <ReviewRow label={intl.formatMessage({ id: 'agents.technical.filters.venue' })} value={intent.venue} />}
            {intent.pendingFiles.length > 0 && (
              <ReviewRow
                label="Documents"
                value={intent.pendingFiles.map((file) => `${file.name} (${(file.size / 1024).toFixed(0)} KB)`).join(', ')}
              />
            )}
            {intent.strategyPreset && intent.strategyPreset !== 'custom' && (
              <ReviewRow label="Strategy preset" value={intent.strategyPreset} />
            )}
            {!intent.strategyPreset && intent.technicalPreFilterEnabled && (
              <ReviewRow
                label={intl.formatMessage({ id: 'agents.technical.scan.signalBias' })}
                value={intl.formatMessage({ id: `agents.technical.scan.signalBias.${intent.technicalConfig.signalBias === 'trend-following' ? 'trendFollowing' : 'meanReverting'}` })}
              />
            )}
            {!intent.strategyPreset && intent.technicalPreFilterEnabled && <ReviewRow label={intl.formatMessage({ id: 'agents.technical.scan.candleInterval' })} value={`${intent.technicalConfig.candles.interval} / ${intent.technicalConfig.candles.limit}`} />}
            {!intent.strategyPreset && intent.technicalPreFilterEnabled && <ReviewRow label={intl.formatMessage({ id: 'agents.technical.scan.interval' })} value={intent.technicalConfig.scanIntervalMins} />}
            <ReviewRow
              label={intl.formatMessage({ id: 'agents.review.capabilitySetup' })}
              value={requiresTradingSetup
                ? (intent.connectionIds.length > 0
                  ? intl.formatMessage({ id: 'agents.review.capabilitySetup.bound' })
                  : intl.formatMessage({ id: 'agents.review.capabilitySetup.defer' }))
                : intl.formatMessage({ id: 'agents.review.capabilitySetup.none' })}
            />
            {requiresTradingSetup && intent.connectionIds.length > 0 && (
              <ReviewRow
                label={intl.formatMessage({ id: 'agents.create.connection' })}
                value={intent.connectionIds
                  .map((id) => {
                    const conn = availableConnections.find((c) => c.connectionId === id);
                    return conn ? `${conn.label} (${conn.provider})` : id;
                  })
                  .join(', ')}
              />
            )}
            {requiresTradingSetup && (
              <ReviewRow
                label={intl.formatMessage({ id: 'agents.review.openPositionEscalationPolicy' })}
                value={intl.formatMessage({ id: `agents.controls.openPositionEscalationPolicy.${intent.openPositionEscalationToJudgePolicy}` })}
              />
            )}
          </tbody>
        </table>

        {mutation.isError && <ErrorBanner message={localizeApiError(intl, mutation.error, 'common.errorTitle')} />}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'space-between' }}>
          <Button variant="ghost" onClick={() => { setStep('intent'); setFormErrors({}); mutation.reset(); }} type="button">{intl.formatMessage({ id: 'common.back' })}</Button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button variant="ghost" onClick={onClose} type="button">{intl.formatMessage({ id: 'common.cancel' })}</Button>
            <Button
              variant="primary"
              type="button"
              disabled={createDisabled}
              onClick={() => {
                if (createDisabled) {
                  return;
                }
                mutation.mutate();
              }}
            >
              {mutation.isPending ? intl.formatMessage({ id: 'agents.create.creating' }) : intl.formatMessage({ id: 'agents.createAgent' })}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td style={{ padding: '6px 0', color: 'var(--color-text-muted)', whiteSpace: 'nowrap', paddingRight: '16px' }}>{label}</td>
      <td style={{ padding: '6px 0', fontWeight: '500' }}>{value}</td>
    </tr>
  );
}


