import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, capabilities as capabilitiesApi, skills as skillsApi, auth as authApi, ai as aiApi, type Skill } from '../../lib/api-client.js';
import { PageShell, PageHeader, LoadingRows, ErrorState, EmptyState, Button, Modal, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { formatExecutionMode, formatSkillSelection, hasCapabilityFamily, listSelectableSkills, resolveSkillPresetSkillIds, type SkillPresetId } from './agent-display.js';
import { AgentSummaryCard } from './AgentSummaryCard.js';
import { SkillPicker } from './SkillPicker.js';
import { localizeApiError } from '../../lib/localize-api-error.js';
import { ProviderSetupForm } from '../setup/ProviderSetupForm.js';
import { ModelSelectionFields, resolveDefaultModelSelection } from '../settings/ModelSelectionFields.js';
import { resolveCreateAgentModelPayload } from './create-agent-models.js';
import { buildCreateAgentPayload, resolveCreateAgentBindingId } from './agent-payloads.js';
import { AgentControlsSection, TradingGuardrailsFields } from './AgentControlsSection.js';
import { getTickIntervalValidationMessageId } from './tick-interval.js';
import { type CapabilityMode } from './CapabilitySelector.js';
import { StyleSelector } from './StyleSelector.js';
import { type AgentStyleValue, resolveStyleDefaults } from './style-mapping.js';
import { generateAgentName } from './agent-name.js';
import { TechnicalConfigSection } from './TechnicalConfigSection.js';
import { defaultTechnicalConfigFormState, technicalFormStateToPayload, type TechnicalConfigFormState } from './technical-config-helpers.js';
import { validateCreateAgentForm, type ValidationConstraints } from './form-validation.js';
import { deriveCapabilityMode } from './derive-capability-mode.js';
import { AdvancedSettingsSection } from './AdvancedSettingsSection.js';

/**
 * Maps validated field names to the Advanced Settings tab index that contains them.
 * Update this whenever a field moves between tabs or a new validated field is added.
 *   0 = AI Configuration
 *   1 = Skills
 *   2 = Trading Setup
 *   3 = Strategy
 */
const ADVANCED_FIELD_TAB: Record<string, number> = {
  // AI Configuration
  tickIntervalMins: 0,
  dailySpendBudgetUsd: 0,
  // Trading Setup
  dailyLossLimit: 2,
  maxSlippageBps: 2,
  maxOpenPositions: 2,
  maxPositionSizePct: 2,
  stopLossPct: 2,
  stopLossCooldownSecs: 2,
  openPositionEscalationToJudgePolicy: 2,
  // Strategy
};

/** Maps provider IDs to their venue type for the technical scanner. */
const VENUE_TYPE_MAP: Record<string, '' | 'orderbook' | 'swap'> = {
  hyperliquid: 'orderbook',
  jupiter: 'swap',
  bybit: 'orderbook',
  '1inch': 'swap',
};

type RiskToleranceValue = 'conservative' | 'moderate' | 'aggressive';
type CreateStep = 'intent' | 'review';

interface IntentState {
  name: string;
  goal: string;
  capabilityMode: CapabilityMode;
  technicalConfig: TechnicalConfigFormState;
  skillPreset: SkillPresetId;
  skillIds: string[];
  executionMode: 'paper' | 'shadow' | 'live';
  provider: string;
  lightModel: string;
  heavyModel: string;
  telegramChatId: string;
  tradingBindingId: string;
  /** Derived from selected trading binding's provider, or user-picked for paper mode. */
  venue: string;
  /** Derived from venue: hyperliquid→orderbook, jupiter→swap, etc. */
  venueType: '' | 'orderbook' | 'swap';
  riskTolerance: RiskToleranceValue;
  style: AgentStyleValue;
  // Configurable controls
  costPreset: '' | 'minimal' | 'standard' | 'premium' | 'custom';
  dailySpendBudgetUsd: string;
  tickIntervalMins: string;
  capital: string;
  dailyLossLimit: string;
  maxSlippageBps: string;
  maxOpenPositions: string;
  maxPositionSizePct: string;
  stopLossPct: string;
  stopLossCooldownSecs: string;
  openPositionEscalationToJudgePolicy: 'never' | 'uncovered_or_triggered' | 'always';
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

  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => skillsApi.list({ scope: 'selectable' }),
  });

  const items = query.data ?? [];
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

      {query.isLoading && <LoadingRows count={3} />}
      {query.isError && <ErrorState message={localizeApiError(intl, query.error, 'common.errorTitle')} onRetry={() => void query.refetch()} />}

      {query.isSuccess && items.length === 0 && (
        <EmptyState
          title={intl.formatMessage({ id: 'agents.empty.title' })}
          message={intl.formatMessage({ id: 'agents.empty.message' })}
          action={<Button variant="primary" onClick={openCreate}>{intl.formatMessage({ id: 'agents.createAgent' })}</Button>}
        />
      )}

      {query.isSuccess && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {items.map((agent) => (
            <AgentSummaryCard key={agent.id} agent={agent} onOpen={() => navigate(`/agents/${agent.id}`)} />
          ))}
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
    capabilityMode: 'technical',
    technicalConfig: defaultTechnicalConfigFormState(),
    skillPreset: 'trading',
    skillIds: resolveSkillPresetSkillIds('trading'),
    executionMode: 'paper',
    provider: '',
    lightModel: '',
    heavyModel: '',
    telegramChatId: '',
    tradingBindingId: '',
    venue: '',
    venueType: '',
    riskTolerance: styleDefaults.riskTolerance,
    style: 'balanced',
    costPreset: styleDefaults.costPreset,
    dailySpendBudgetUsd: styleDefaults.dailySpendBudgetUsd,
    tickIntervalMins: styleDefaults.tickIntervalMins,
    capital: '',
    dailyLossLimit: '',
    maxSlippageBps: '',
    maxOpenPositions: '',
    maxPositionSizePct: '',
    stopLossPct: '',
    stopLossCooldownSecs: '',
    openPositionEscalationToJudgePolicy: styleDefaults.openPositionEscalationToJudgePolicy,
    };
  });
  const [modelTouched, setModelTouched] = useState(false);
  const [telegramTouched, setTelegramTouched] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [nameIsAutoGenerated, setNameIsAutoGenerated] = useState(true);
  const [advancedExpandSeq, setAdvancedExpandSeq] = useState(0);
  const [advancedErrorTabIdx, setAdvancedErrorTabIdx] = useState(2);
  const nameCounterRef = useRef(0);
  const dailyLossLimitAutoRef = useRef(false);
  // Phase 7 policy dropdown onChange will set this to true.
  const policyManuallySetRef = useRef(false);

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
  const tradingBindingsQuery = useQuery({
    queryKey: ['capabilities', 'trading', 'bindings'],
    queryFn: () => capabilitiesApi.tradingBindings(),
  });
  const riskDefaultsQuery = useQuery({
    queryKey: ['agents', 'risk-defaults'],
    queryFn: () => agentsApi.riskDefaults(),
  });

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
    const defaultSelection = resolveDefaultModelSelection(availableModelsQuery.data?.providers ?? []);
    if (!defaultSelection) {
      return;
    }
    setIntent((state) => ({ ...state, ...defaultSelection }));
  }, [availableModelsQuery.data?.providers, aiSettingsQuery.isSuccess, aiSettingsQuery.data?.aiModelConfig, intent.provider, modelTouched]);

  useEffect(() => {
    if (telegramTouched) {
      return;
    }
    const chatId = meQuery.data?.telegramChatId;
    if (chatId !== undefined) {
      setIntent((state) => ({ ...state, telegramChatId: chatId ?? '' }));
    }
  }, [meQuery.data?.telegramChatId, telegramTouched]);

  // Derive capabilityMode from skill selection + goal text
  useEffect(() => {
    setIntent((state) => {
      const resolvedSkills = skills.filter((s) => state.skillIds.includes(s.id));
      // Synchronous shortcut: the 'trading' preset always maps to skills with
      // capabilityFamilies: ['trading'], so treat it as trading even before the
      // skills query resolves — prevents a flicker on the Strategy tab.
      const syntheticTradingSkill = state.skillPreset === 'trading'
        ? [{ capabilityFamilies: ['trading'] }]
        : [];
      const effectiveSkills = resolvedSkills.length > 0 ? resolvedSkills : syntheticTradingSkill;
      const derived = deriveCapabilityMode(effectiveSkills, state.goal);
      if (derived !== state.capabilityMode) {
        return { ...state, capabilityMode: derived };
      }
      return state;
    });
  }, [intent.skillIds, intent.goal, skills]);

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
  const showIntelligence = intent.capabilityMode === 'intelligence' || intent.capabilityMode === 'both';
  const showTechnical = intent.capabilityMode === 'technical' || intent.capabilityMode === 'both';
  const requiresTradingSetup = intent.skillPreset === 'trading' || hasCapabilityFamily(selectedSkills, 'trading');
  const availableTradingBindings = (tradingBindingsQuery.data?.bindings ?? []).filter(
    (binding) => binding.status === 'active' && binding.connectionStatus === 'active',
  );
  const selectedTradingBinding = availableTradingBindings.find((binding) => binding.bindingId === intent.tradingBindingId) ?? null;

  // Derive venue + venueType from selected trading binding's provider
  useEffect(() => {
    if (selectedTradingBinding?.provider) {
      const derivedVenueType = VENUE_TYPE_MAP[selectedTradingBinding.provider] ?? '';
      setIntent((state) => {
        if (state.venue !== selectedTradingBinding.provider || state.venueType !== derivedVenueType) {
          return { ...state, venue: selectedTradingBinding.provider, venueType: derivedVenueType };
        }
        return state;
      });
    }
  }, [selectedTradingBinding?.provider]);

  const mutation = useMutation({
    mutationFn: async () => {
      const technicalPayload = (intent.capabilityMode === 'technical' || intent.capabilityMode === 'both')
        ? technicalFormStateToPayload(intent.technicalConfig, intent.venue, intent.venueType as 'orderbook' | 'swap')
        : null;
      const agent = await agentsApi.create(buildCreateAgentPayload({
        name: intent.name,
        goal: intent.goal,
        capabilityMode: intent.capabilityMode,
        technical: technicalPayload,
        skillIds: intent.skillIds,
        hasBotManagementSkill,
        requiresTradingSetup,
        executionMode: intent.executionMode,
        modelPayload,
        costPreset: intent.costPreset,
        dailySpendBudgetUsd: intent.dailySpendBudgetUsd,
        telegramChatId: intent.telegramChatId,
        tickIntervalMins: intent.tickIntervalMins,
        capital: intent.capital,
        dailyLossLimit: intent.dailyLossLimit,
        maxSlippageBps: intent.maxSlippageBps,
        maxOpenPositions: intent.maxOpenPositions,
        maxPositionSizePct: intent.maxPositionSizePct,
        stopLossPct: intent.stopLossPct,
        stopLossCooldownSecs: intent.stopLossCooldownSecs,
        style: intent.style,
        openPositionEscalationToJudgePolicy: intent.openPositionEscalationToJudgePolicy,
      }));

      if (requiresTradingSetup && intent.tradingBindingId) {
        await agentsApi.tradingAction(agent.id, 'bind', { bindingId: intent.tradingBindingId });
      }

      return agent;
    },
    onSuccess: (agent) => onCreated(agent.id),
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

  function bumpAdvancedExpand(errorKeys: string[]) {
    const advancedKey = errorKeys.find(k => k in ADVANCED_FIELD_TAB);
    if (advancedKey !== undefined) {
      setAdvancedErrorTabIdx(ADVANCED_FIELD_TAB[advancedKey]!);
      setAdvancedExpandSeq(s => s + 1);
    }
  }

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
      executionMode: intent.executionMode,
      requiresTradingSetup,
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

    if (result.errors[fieldName] && fieldName in ADVANCED_FIELD_TAB) {
      bumpAdvancedExpand([fieldName]);
    }
  }

  const createDisabled = mutation.isPending
    || !intent.name.trim()
    || (showIntelligence && !intent.goal.trim())
    || ((intent.executionMode === 'live' || intent.executionMode === 'shadow') && (!intent.venue || !intent.venueType))
    || tickIntervalError != null;

  if (showSetup) {
    return (
      <ProviderSetupForm
        defaultCapability="trading"
        onClose={() => setShowSetup(false)}
        onSuccess={(result) => {
          setShowSetup(false);
          void qc.invalidateQueries({ queryKey: ['capabilities', 'trading', 'bindings'] });
          const tradingBindingId = resolveCreateAgentBindingId(result.tradingBinding ?? null);
          if (tradingBindingId) {
            setIntent((state) => ({ ...state, tradingBindingId }));
          }
        }}
      />
    );
  }

  if (step === 'intent') {
    const riskOptions = [
      {
        value: 'conservative',
        label: intl.formatMessage({ id: 'agents.risk.conservative.label' }),
        description: intl.formatMessage({ id: 'agents.risk.conservative.description' }),
      },
      {
        value: 'moderate',
        label: intl.formatMessage({ id: 'agents.risk.moderate.label' }),
        description: intl.formatMessage({ id: 'agents.risk.moderate.description' }),
      },
      {
        value: 'aggressive',
        label: intl.formatMessage({ id: 'agents.risk.aggressive.label' }),
        description: intl.formatMessage({ id: 'agents.risk.aggressive.description' }),
      },
    ] as const;

    return (
      <Modal title={intl.formatMessage({ id: 'agents.create.title' })} onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* 1. Skill Preset — first, sets context for everything else */}
          <div>
            <FieldLabel>{intl.formatMessage({ id: 'agents.create.skillPreset' })}</FieldLabel>
            <select
              value={intent.skillPreset}
              onChange={(e) => {
                const skillPreset = e.target.value as SkillPresetId;
                setIntent((state) => ({
                  ...state,
                  skillPreset,
                  skillIds: resolveSkillPresetSkillIds(skillPreset, state.skillIds),
                }));
              }}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="trading">{intl.formatMessage({ id: 'agents.create.skillPreset.trading' })}</option>
              <option value="personal-assistant">{intl.formatMessage({ id: 'agents.create.skillPreset.personalAssistant' })}</option>
              <option value="custom">{intl.formatMessage({ id: 'agents.create.skillPreset.custom' })}</option>
            </select>
            {intl.formatMessage({ id: 'agents.create.skillPreset.help' }) ? (
              <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                {intl.formatMessage({ id: 'agents.create.skillPreset.help' })}
              </div>
            ) : null}
          </div>

          {/* 2. Goal */}
          <div data-field="goal">
            <FieldLabel>{intl.formatMessage({ id: intent.capabilityMode === 'both' ? 'agents.create.goalBoth' : 'agents.create.goal' })}</FieldLabel>
            <textarea
              style={{ ...inputStyle, minHeight: '72px', resize: 'vertical' }}
              value={intent.goal}
              onChange={(e) => {
                clearFieldError('goal');
                setIntent((state) => ({ ...state, goal: e.target.value }));
              }}
              placeholder={intl.formatMessage({ id: 'agents.create.goalPlaceholder' })}
              required
            />
            {formErrors.goal && <div style={{ color: 'var(--color-danger)', fontSize: '12px', marginTop: '4px' }}>{formErrors.goal}</div>}
          </div>

          {/* 3. Style Selector */}
          <StyleSelector
            value={intent.style}
            onChange={(style) => {
              const defaults = resolveStyleDefaults(style);
              setIntent((state) => ({
                ...state,
                style,
                costPreset: defaults.costPreset,
                tickIntervalMins: defaults.tickIntervalMins,
                dailySpendBudgetUsd: defaults.dailySpendBudgetUsd,
                riskTolerance: defaults.riskTolerance,
                ...(policyManuallySetRef.current ? {} : { openPositionEscalationToJudgePolicy: defaults.openPositionEscalationToJudgePolicy }),
              }));
            }}
          />

          {/* 4. Capital (only when trading skills are selected) */}
          {requiresTradingSetup && (
            <div data-field="capital">
              <FieldLabel>{intl.formatMessage({ id: 'agents.controls.capital' })}</FieldLabel>
              <input
                style={inputStyle}
                value={intent.capital}
                onBlur={() => validateFieldOnBlur('capital')}
                onChange={(e) => {
                  clearFieldError('capital');
                  setIntent((state) => ({ ...state, capital: e.target.value }));
                }}
                placeholder={intl.formatMessage({ id: 'common.unlimited' })}
              />
              {formErrors.capital && <div style={{ color: 'var(--color-danger)', fontSize: '12px', marginTop: '4px' }}>{formErrors.capital}</div>}
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                {intl.formatMessage({ id: 'agents.controls.capital.help' })}
              </div>
            </div>
          )}

          {/* 5. Telegram chat ID */}
          <div>
            <FieldLabel>{intl.formatMessage({ id: 'agents.create.telegramChatId' })}</FieldLabel>
            <input
              style={inputStyle}
              value={intent.telegramChatId}
              onChange={(e) => {
                setTelegramTouched(true);
                setIntent((state) => ({ ...state, telegramChatId: e.target.value }));
              }}
              placeholder={intl.formatMessage({ id: 'agents.create.telegramChatId.placeholder' })}
            />
            <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
              {intl.formatMessage({ id: 'agents.create.telegramChatId.help' })}
            </div>
          </div>

          {/* 6. Name — last main field before Advanced Settings */}

          <div data-field="name">
            <FieldLabel>{intl.formatMessage({ id: 'agents.create.name' })}</FieldLabel>
            <input
              style={inputStyle}
              type="text"
              value={intent.name}
              onChange={(e) => {
                clearFieldError('name');
                setNameIsAutoGenerated(false);
                setIntent((state) => ({ ...state, name: e.target.value }));
              }}
              placeholder={intl.formatMessage({ id: 'agents.create.namePlaceholder' })}
              maxLength={100}
              required
            />
            {formErrors.name && <div style={{ color: 'var(--color-danger)', fontSize: '12px', marginTop: '4px' }}>{formErrors.name}</div>}
            {nameIsAutoGenerated && (
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                {intl.formatMessage({ id: 'agents.create.name.autoGeneratedHint' })}
              </div>
            )}
          </div>

          {/* 7. Advanced Settings (tabs) */}
          <AdvancedSettingsSection
            expandSeq={advancedExpandSeq}
            errorTabIdx={advancedErrorTabIdx}
            aiConfig={
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {showIntelligence && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'var(--color-surface-1)' }}>
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
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '16px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'var(--color-surface-1)' }}>
                    <FieldLabel>{intl.formatMessage({ id: 'agents.create.whereToTrade' })}</FieldLabel>
                    <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                      {intl.formatMessage({ id: 'agents.create.capabilitySetupMessage' })}
                    </div>
                    {tradingBindingsQuery.isLoading ? (
                      <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.create.loadingConnections' })}</div>
                    ) : availableTradingBindings.length === 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                          {intl.formatMessage({ id: 'agents.create.noConnections' })}
                        </div>
                        <div>
                          <Button variant="secondary" size="sm" onClick={() => setShowSetup(true)}>
                            {intl.formatMessage({ id: 'agents.create.setupTradingNow' })}
                          </Button>
                        </div>
                        {/* Venue picker for paper mode when no connections exist */}
                        {intent.executionMode === 'paper' && (
                          <div data-field="venue">
                            <FieldLabel>{intl.formatMessage({ id: 'agents.technical.filters.venue' })}</FieldLabel>
                            <select
                              value={intent.venue}
                              onChange={(e) => {
                                const v = e.target.value;
                                const vt = VENUE_TYPE_MAP[v] ?? '';
                                clearFieldError('venue');
                                setIntent((state) => ({ ...state, venue: v, venueType: vt }));
                              }}
                              style={{ ...inputStyle, cursor: 'pointer' }}
                            >
                              <option value="">{intl.formatMessage({ id: 'agents.technical.filters.venue.placeholder' })}</option>
                              <option value="hyperliquid">{intl.formatMessage({ id: 'agents.technical.filters.venue.hyperliquid' })}</option>
                              <option value="jupiter">{intl.formatMessage({ id: 'agents.technical.filters.venue.jupiter' })}</option>
                            </select>
                            {formErrors.venue && <div style={{ color: 'var(--color-danger)', fontSize: '12px', marginTop: '4px' }}>{formErrors.venue}</div>}
                          </div>
                        )}
                      </div>
                    ) : (
                      <>
                        <select
                          value={intent.tradingBindingId}
                          onChange={(e) => setIntent((state) => ({ ...state, tradingBindingId: e.target.value }))}
                          style={{ ...inputStyle, cursor: 'pointer' }}
                        >
                          <option value="">{intl.formatMessage({ id: 'agents.create.chooseConnection' })}</option>
                          {availableTradingBindings.map((binding) => (
                            <option key={binding.bindingId} value={binding.bindingId}>
                              {binding.label} ({binding.provider})
                            </option>
                          ))}
                        </select>
                        {/* Venue derived from connection — read-only display */}
                        {intent.venue && intent.venueType && (
                          <div style={{ display: 'flex', gap: '8px', fontSize: '12px', color: 'var(--color-text-muted)' }}>
                            <span>Venue: <strong>{intent.venue}</strong></span>
                            <span>Type: <strong>{intent.venueType}</strong></span>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  <AgentControlsSection
                    value={{
                      costPreset: intent.costPreset,
                      dailySpendBudgetUsd: intent.dailySpendBudgetUsd,
                      tickIntervalMins: intent.tickIntervalMins,
                      dailyLossLimit: intent.dailyLossLimit,
                      maxSlippageBps: intent.maxSlippageBps,
                      maxOpenPositions: intent.maxOpenPositions,
                      maxPositionSizePct: intent.maxPositionSizePct,
                      stopLossPct: intent.stopLossPct,
                      stopLossCooldownSecs: intent.stopLossCooldownSecs,
                    }}
                    showBotControls={hasBotManagementSkill}
                    tickIntervalError={tickIntervalError}
                    fieldErrors={formErrors}
                    onClearFieldError={clearFieldError}
                    onBlurField={validateFieldOnBlur}
                    onChange={(patch) => {
                      if ('dailyLossLimit' in patch) {
                        dailyLossLimitAutoRef.current = false;
                      }
                      setIntent((state) => ({ ...state, ...patch }));
                    }}
                  />
                </div>
            }
            skills={
              intent.skillPreset === 'custom' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'var(--color-surface-1)' }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '4px' }}>
                      {intl.formatMessage({ id: 'agents.create.skills' })}
                    </div>
                    <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                      {intl.formatMessage({ id: 'agents.create.skillsHelp' })}
                    </div>
                  </div>
                  <SkillPicker
                    skills={skills}
                    selectedSkillIds={intent.skillIds}
                    onChange={(skillIds) => setIntent((state) => ({ ...state, skillPreset: 'custom', skillIds }))}
                    loading={skillsLoading}
                    errorMessage={skillsError}
                  />
                </div>
              ) : null
            }
            tradingSetup={
              requiresTradingSetup ? (
                <>
                  <div>
                    <FieldLabel>{intl.formatMessage({ id: 'agents.executionMode.label' })}</FieldLabel>
                    <select
                      value={intent.executionMode}
                      onChange={(e) => setIntent((state) => ({ ...state, executionMode: e.target.value as IntentState['executionMode'] }))}
                      style={{ ...inputStyle, cursor: 'pointer' }}
                    >
                      <option value="paper">{intl.formatMessage({ id: 'agents.create.executionMode.paper' })}</option>
                      {meQuery.data?.isAdmin && <option value="shadow">{intl.formatMessage({ id: 'agents.create.executionMode.shadow' })}</option>}
                      <option value="live">{intl.formatMessage({ id: 'agents.create.executionMode.live' })}</option>
                    </select>
                  </div>

                  <div>
                    <FieldLabel>{intl.formatMessage({ id: 'agents.create.riskTolerance' })}</FieldLabel>
                    <select
                      value={intent.riskTolerance}
                      onChange={(e) => setIntent((state) => ({ ...state, riskTolerance: e.target.value as RiskToleranceValue }))}
                      style={{ ...inputStyle, cursor: 'pointer' }}
                    >
                      {riskOptions.map((risk) => (
                        <option key={risk.value} value={risk.value}>
                          {risk.label} — {risk.description}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ fontSize: '14px', fontWeight: '600' }}>
                      {intl.formatMessage({ id: 'agents.create.tradingControls.title' })}
                    </div>
                    <TradingGuardrailsFields
                      value={{
                        dailyLossLimit: intent.dailyLossLimit,
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
            strategy={
              showTechnical ? (
                <div style={{ padding: '12px', border: '1px solid var(--color-border)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '13px', fontWeight: '600', marginBottom: '12px' }}>
                    {intl.formatMessage({ id: 'agents.technical.title' })}
                  </div>
                  <TechnicalConfigSection
                    value={intent.technicalConfig}
                    onChange={(technicalConfig) => setIntent((state) => ({ ...state, technicalConfig }))}
                    showErrors={Object.keys(formErrors).length > 0}
                    onClearFieldError={clearFieldError}
                  />
                </div>
              ) : null
            }
          />

          {/* Cancel + Review buttons */}
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
                  executionMode: intent.executionMode,
                  requiresTradingSetup,
                }, validationConstraints);

                if (!result.valid) {
                  setFormErrors(result.errors);
                  bumpAdvancedExpand(Object.keys(result.errors));
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
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={intl.formatMessage({ id: 'agents.review.title' })} onClose={onClose}>
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
              value={intl.formatMessage({ id: `agents.capability.${intent.capabilityMode}.label` })}
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
            {showIntelligence && <ReviewRow label={intl.formatMessage({ id: 'agents.create.skills' })} value={formatSkillSelection(selectedSkills, intl)} />}
            {requiresTradingSetup && intent.venue && <ReviewRow label={intl.formatMessage({ id: 'agents.technical.filters.venue' })} value={intent.venue} />}
            {showTechnical && (
              <ReviewRow
                label={intl.formatMessage({ id: 'agents.technical.scan.signalBias' })}
                value={intl.formatMessage({ id: `agents.technical.scan.signalBias.${intent.technicalConfig.signalBias === 'trend-following' ? 'trendFollowing' : 'meanReverting'}` })}
              />
            )}
            {showTechnical && <ReviewRow label={intl.formatMessage({ id: 'agents.technical.scan.candleInterval' })} value={`${intent.technicalConfig.candles.interval} / ${intent.technicalConfig.candles.limit}`} />}
            {showTechnical && <ReviewRow label={intl.formatMessage({ id: 'agents.technical.scan.interval' })} value={intent.technicalConfig.scanIntervalMins} />}
            <ReviewRow
              label={intl.formatMessage({ id: 'agents.review.capabilitySetup' })}
              value={requiresTradingSetup
                ? (selectedTradingBinding
                  ? intl.formatMessage({ id: 'agents.review.capabilitySetup.bound' })
                  : intl.formatMessage({ id: 'agents.review.capabilitySetup.defer' }))
                : intl.formatMessage({ id: 'agents.review.capabilitySetup.none' })}
            />
            {requiresTradingSetup && selectedTradingBinding && (
              <ReviewRow label={intl.formatMessage({ id: 'agents.create.tradingBinding' })} value={`${selectedTradingBinding.label} (${selectedTradingBinding.provider})`} />
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
          <Button variant="ghost" onClick={() => { setStep('intent'); setFormErrors({}); }} type="button">{intl.formatMessage({ id: 'common.back' })}</Button>
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


