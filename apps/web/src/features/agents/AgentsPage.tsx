import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useIntl } from 'react-intl';
import { agents as agentsApi, capabilities as capabilitiesApi, skills as skillsApi, auth as authApi, ai as aiApi, type Skill, type TradingBindingSummary } from '../../lib/api-client.js';
import { PageShell, PageHeader, LoadingRows, ErrorState, EmptyState, Button, Modal, FieldLabel, ErrorBanner, inputStyle } from '../../lib/ui.js';
import { formatExecutionMode, formatCapabilityFamily, formatSkillSelection, hasCapabilityFamily, listSelectableSkills, resolveSkillPresetSkillIds, type SkillPresetId } from './agent-display.js';
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

type RiskToleranceValue = 'conservative' | 'moderate' | 'aggressive';
type CreateStep = 'intent' | 'review';

function deriveCapabilityMode(skillIds: string[], goal: string): CapabilityMode {
  const hasTradingSkill = skillIds.includes('trading') || skillIds.includes('bot-management');
  const hasIntelligence = goal.trim().length > 0;
  if (hasTradingSkill && hasIntelligence) return 'both';
  if (hasIntelligence) return 'intelligence';
  return 'technical';
}

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
  const [intent, setIntent] = useState<IntentState>({
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
    riskTolerance: 'moderate',
    style: 'balanced',
    costPreset: '',
    dailySpendBudgetUsd: '',
    tickIntervalMins: '',
    capital: '',
    dailyLossLimit: '',
    maxSlippageBps: '',
    maxOpenPositions: '',
    maxPositionSizePct: '',
    stopLossPct: '',
    stopLossCooldownSecs: '',
  });
  const [modelTouched, setModelTouched] = useState(false);
  const [telegramTouched, setTelegramTouched] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [nameIsAutoGenerated, setNameIsAutoGenerated] = useState(true);
  const nameCounterRef = useRef(0);
  const dailyLossLimitAutoRef = useRef(false);

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
      const derived = deriveCapabilityMode(state.skillIds, state.goal);
      if (derived !== state.capabilityMode) {
        return { ...state, capabilityMode: derived };
      }
      return state;
    });
  }, [intent.skillIds, intent.goal]);

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
        const lossLimit = (capitalNum * 0.05).toFixed(2);
        if (lossLimit !== intent.dailyLossLimit) {
          setIntent((state) => ({ ...state, dailyLossLimit: lossLimit }));
          dailyLossLimitAutoRef.current = true;
        }
      }
    }
  }, [intent.capital]);

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
  const tradingBindingsQuery = useQuery({
    queryKey: ['capabilities', 'trading', 'bindings'],
    queryFn: () => capabilitiesApi.tradingBindings(),
  });
  const availableTradingBindings = (tradingBindingsQuery.data?.bindings ?? []).filter(
    (binding) => binding.status === 'active' && binding.connectionStatus === 'active',
  );
  const riskDefaultsQuery = useQuery({
    queryKey: ['agents', 'risk-defaults'],
    queryFn: () => agentsApi.riskDefaults(),
  });
  const selectedTradingBinding = availableTradingBindings.find((binding) => binding.bindingId === intent.tradingBindingId) ?? null;

  const mutation = useMutation({
    mutationFn: async () => {
      const technicalPayload = (intent.capabilityMode === 'technical' || intent.capabilityMode === 'both')
        ? technicalFormStateToPayload(intent.technicalConfig)
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
      venue: intent.technicalConfig.filters.venue,
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
  }

  const createDisabled = mutation.isPending
    || !intent.name.trim()
    || (showIntelligence && !intent.goal.trim())
    || (showTechnical && !intent.technicalConfig.filters.venue.trim())
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

    const detailsStyle: React.CSSProperties = {
      border: '1px solid var(--color-border)',
      borderRadius: '8px',
      background: 'var(--color-surface-1)',
    };
    const summaryStyle: React.CSSProperties = {
      padding: '12px 16px',
      cursor: 'pointer',
      fontSize: '14px',
      fontWeight: '600',
      color: 'var(--color-text-secondary)',
      userSelect: 'none',
    };

    return (
      <Modal title={intl.formatMessage({ id: 'agents.create.title' })} onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* 1. Goal — always visible, first */}
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

          {/* 2. Skill Preset */}
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
            <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
              {intl.formatMessage({ id: 'agents.create.skillPreset.help' })}
            </div>
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
              }));
            }}
          />

          {/* 4. Skills display (read-only) */}
          <div>
            <FieldLabel>{intl.formatMessage({ id: 'agents.create.skills' })}</FieldLabel>
            <div style={{ ...inputStyle, minHeight: '44px', display: 'flex', alignItems: 'center', color: 'var(--color-text-secondary)' }}>
              {formatSkillSelection(selectedSkills, intl)}
            </div>
            <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
              {intent.skillPreset === 'custom'
                ? intl.formatMessage({ id: 'agents.create.skillsHelp' })
                : intl.formatMessage({ id: 'agents.create.skillPreset.includes' }, { skills: formatSkillSelection(selectedSkills, intl) })}
            </div>
          </div>

          {/* 5. Capital + Exchange (only when trading skills are selected) */}
          {requiresTradingSetup && (
            <>
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

              <div>
                <FieldLabel>{intl.formatMessage({ id: 'agents.create.tradingBinding' })}</FieldLabel>
                {tradingBindingsQuery.isLoading ? (
                  <div style={{ fontSize: '13px', color: 'var(--color-text-muted)' }}>{intl.formatMessage({ id: 'agents.create.loadingBindings' })}</div>
                ) : availableTradingBindings.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', lineHeight: '1.5' }}>
                      {intl.formatMessage({ id: 'agents.create.noBindings' })}
                    </div>
                    <div>
                      <Button variant="secondary" size="sm" onClick={() => setShowSetup(true)}>
                        {intl.formatMessage({ id: 'agents.create.setupTradingNow' })}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <select
                    value={intent.tradingBindingId}
                    onChange={(e) => setIntent((state) => ({ ...state, tradingBindingId: e.target.value }))}
                    style={{ ...inputStyle, cursor: 'pointer' }}
                  >
                    <option value="">{intl.formatMessage({ id: 'agents.create.chooseBinding' })}</option>
                    {availableTradingBindings.map((binding) => (
                      <option key={binding.bindingId} value={binding.bindingId}>
                        {binding.label} ({binding.provider})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </>
          )}

          {/* 6. Telegram chat ID */}
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

          {/* 7. Name — last main field before Advanced Settings */}
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

          {/* 8. Advanced Settings (collapsed) */}
          <details style={detailsStyle}>
            <summary style={summaryStyle}>
              {intl.formatMessage({ id: 'agents.create.advancedSettings' })}
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '0 16px 16px 16px' }}>

              {/* 1. AI Configuration: model selection + cost/budget/tick */}
              {showIntelligence && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', border: '1px solid var(--color-border)', borderRadius: '8px', background: 'var(--color-surface-1)' }}>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '4px' }}>
                    {intl.formatMessage({ id: 'agents.create.models.title' })}
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
                    {intl.formatMessage({ id: 'agents.create.models.description' })}
                  </div>
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
              )}

              {/* 2. Skills — custom SkillPicker */}
              {intent.skillPreset === 'custom' && (
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
              )}

              {/* 3. Trading Setup: execution mode, risk tolerance, guardrails */}
              {requiresTradingSetup && (
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
                      }}
                      defaults={riskDefaultsQuery.data ?? null}
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
                </>
              )}

              {/* 4. Strategy: technical config */}
              {showTechnical && (
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
              )}
            </div>
          </details>

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
                  venue: intent.technicalConfig.filters.venue,
                  requiresTradingSetup,
                }, {
                  maxOpenPositions: riskDefaultsQuery.data?.maxOpenPositions ?? 10,
                  maxPositionSizePct: riskDefaultsQuery.data?.maxPositionSizePct ?? 100,
                  stopLossMaxUnrealizedLossPct: riskDefaultsQuery.data?.stopLossPct ?? 100,
                } satisfies ValidationConstraints);

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
            {showTechnical && <ReviewRow label={intl.formatMessage({ id: 'agents.technical.filters.venue' })} value={intent.technicalConfig.filters.venue} />}
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


